import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { activity, timelineEvents, imageCandidates, imageMetadata, galleryCache, cleanGalleryCache } from "../mods/sessions-plus/activity.mjs";
import { resolveSession } from "../mods/sessions-plus/history.mjs";
import { activityTarget, activityTime, ACTIVITY_LIMITS as L } from "../mods/sessions-plus/activity-model.js";
import { createActivityClient } from "../mods/sessions-plus/activity-client.js";
const id = "11111111-2222-4333-8444-555555555555", second = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const timestamp = "2026-11-11T01:02:03.000Z";
const bytes = value => Buffer.from(value);
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, value) { const payload = Buffer.concat([bytes(type), value]), head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(value.length); tail.writeUInt32BE(crc32(payload)); return Buffer.concat([head, payload, tail]); }
function png(color = 0, width = 1, height = 1) { const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6; return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0,color,0,0,255]))), chunk("IEND", Buffer.alloc(0))]); }
const claude = (message, extra = {}) => ({ type: "user", sessionId: id, cwd: "/fixture/project", timestamp, message: { content: message }, ...extra });
async function fixture(t, provider = "claude", records = [claude("Fixture prompt")], session = id) {
  const root = await fs.mkdtemp("/private/tmp/herdr-activity-fixture-"); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = path.join(root, "store"), folder = provider === "claude" ? path.join(store, "projects/p") : path.join(store, "sessions/2026/11/11"), home = path.join(root, "app");
  await fs.mkdir(folder, { recursive: true }); await fs.mkdir(home);
  const file = path.join(folder, provider === "claude" ? `${session}.jsonl` : `rollout-date-${session}.jsonl`);
  await fs.writeFile(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const target = { id: session, provider, store, key: JSON.stringify([provider, store, session]), title: "Fixture 'literal' $(never)" }, options = { stores: { [provider]: store } };
  return { root, store, file, folder, home, target, options, request: (mode, cursor = null) => ({ mode, target, options, appHome: home, cursor }) };
}

test("session identities bind provider/store/key and resolver rejects UI source paths, ambiguity and symlinks", async t => {
  const f = await fixture(t); const row = resolveSession(f.target.key, f.options); assert.equal(row.source, f.file);
  assert.deepEqual(activityTarget({ ...f.target, source: "/wrong/source" }), activityTarget(f.target));
  for (const target of [{ ...f.target, id: second }, { ...f.target, remote: true }, { ...f.target, store: "/other" }]) assert.throws(() => activityTarget(target));
  assert.throws(() => resolveSession(f.target.key, { stores: { claude: "/wrong" } }), /configuration/);
  const duplicate = path.join(f.store, "projects/other"); await fs.mkdir(duplicate); await fs.copyFile(f.file, path.join(duplicate, `${id}.jsonl`));
  assert.throws(() => resolveSession(f.target.key, f.options), /ambiguous/);
  await fs.rm(duplicate, { recursive: true }); await fs.rename(f.file, path.join(f.root, "outside.jsonl")); await fs.symlink(path.join(f.root, "outside.jsonl"), f.file);
  assert.throws(() => resolveSession(f.target.key, f.options), /no longer/);
});

test("Claude and Codex evidence retain literal arguments, recorded file targets and only explicit durations", () => {
  const records = [{ offset: 1, record: claude("Review this $(literal); file") }, { offset: 2, record: { type: "assistant", timestamp, message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/p/quoted 'file.txt", content: "hello" } }] } } }, { offset: 3, record: { type: "system", subtype: "turn_duration", durationMs: 1234, timestamp } }];
  const values = timelineEvents(records, "claude"); assert.equal(values.length, 3); assert.equal(values[1].files[0], "/p/quoted 'file.txt"); assert.equal(values[0].durationMs, null); assert.equal(values[2].durationMs, 1234);
  assert.equal(activityTime(1234), null); assert.equal(activityTime(timestamp), Date.parse(timestamp));
  const codex = timelineEvents([{ offset: 1, record: { type: "event_msg", timestamp, payload: { type: "user_message", message: "User asks" } } }, { offset: 2, record: { type: "response_item", timestamp, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "User asks" }] } } }, { offset: 3, record: { type: "response_item", timestamp, payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"printf \\\"$literal\\\""}' } } }], "codex");
  assert.equal(codex.length, 2); assert.equal(codex[0].kind, "prompt"); assert.equal(codex[1].kind, "tool"); assert(codex[1].text.includes("literal")); assert.equal(codex[1].durationMs, null);
});

test("timeline uses continuous record-boundary pages with no dropped or duplicated ordinary prompts", async t => {
  const f = await fixture(t, "claude", Array.from({ length: 85 }, (_, i) => claude(`Prompt ${i}`)));
  let cursor = null, texts = [], pages = 0;
  do { const page = await activity(f.request("timeline", cursor)); assert(page.events.length <= L.events); texts.push(...page.events.map(event => event.text)); cursor = page.next; pages++; assert(pages <= L.pages); } while (cursor);
  assert.equal(texts.length, 85); assert.equal(new Set(texts).size, 85); assert.equal(texts[0], "Prompt 84"); assert.equal(texts.at(-1), "Prompt 0");
});

test("byte pages skip oversized JSONL safely and cursors reject changed or different sessions", async t => {
  const f = await fixture(t, "claude", [claude("Older"), claude("x".repeat(L.pageBytes + 100)), claude("Latest")]);
  const page = await activity(f.request("timeline")); assert(page.events.some(event => event.text === "Latest")); assert(page.next); assert(page.warnings.length);
  const other = await fixture(t); await assert.rejects(activity(other.request("timeline", page.next)), /changed|expired/);
  await fs.appendFile(f.file, JSON.stringify(claude("Later")) + "\n"); await assert.rejects(activity(f.request("timeline", page.next)), /changed|expired/);
});

test("Codex resolver verifies session_meta, and Antigravity remains explicit without reading a database", async t => {
  const f = await fixture(t, "codex", [{ type: "session_meta", payload: { id, cwd: "/fixture/project" } }, { type: "event_msg", timestamp, payload: { type: "user_message", message: "Codex prompt" } }]);
  const page = await activity(f.request("timeline")); assert.equal(page.events[0].text, "Codex prompt");
  await fs.writeFile(f.file, JSON.stringify({ type: "session_meta", payload: { id: second, cwd: "/fixture" } }) + "\n"); await assert.rejects(activity(f.request("timeline")), /identity/);
  const target = { provider: "agy", store: path.join(f.root, "agy"), id, key: JSON.stringify(["agy", path.join(f.root, "agy"), id]) };
  const unsupported = await activity({ mode: "gallery", target, options: { stores: { agy: target.store } }, appHome: f.home }); assert.equal(unsupported.available, false); assert.match(unsupported.message, /not supported/);
});

test("gallery reads structured base64 attachments into owned cache and never fetches prompt URLs", async t => {
  const image = png(22), f = await fixture(t, "claude", [claude([{ type: "image", source: { type: "base64", media_type: "image/png", data: image.toString("base64") } }, { type: "image", source: { type: "url", url: "https://never.example/image.png" } }, { type: "text", text: "![not loaded](https://never.example/file.jpg)" }])]);
  const page = await activity(f.request("gallery")); assert.equal(page.images.length, 1); assert.deepEqual(imageMetadata(image), { ext: "png", width: 1, height: 1, bytes: image.length });
  assert(page.images[0].image.startsWith("data/session-gallery/")); assert.equal(page.images[0].cached, true); assert.deepEqual(await fs.readFile(page.images[0].path), image);
  assert.equal((await fs.readdir(path.join(f.home, "data/session-gallery"))).some(name => name.startsWith(".pending")), false);
  assert.equal(imageCandidates([{ record: claude("file:///tmp/a.png https://never.example/a.jpg"), offset: 0 }], "claude").length, 0);
});

test("gallery keeps latest image evidence and advances count-limited pages without losing older images", async t => {
  const records = Array.from({ length: 29 }, (_, i) => claude([{ type: "image", source: { type: "base64", media_type: "image/png", data: png(i).toString("base64") } }]));
  const f = await fixture(t, "claude", records); let cursor = null, ids = [], pages = 0;
  do { const page = await activity(f.request("gallery", cursor)); assert(page.images.length <= 12); ids.push(...page.images.map(image => image.id)); cursor = page.next; pages++; assert(pages < 10); } while (cursor);
  assert.equal(ids.length, 29); assert.equal(new Set(ids).size, 29);
  const candidates = imageCandidates(Array.from({ length: 150 }, (_, offset) => ({ offset, record: claude([{ type: "image", source: { type: "base64", media_type: "image/png", data: String(offset) } }]) })), "claude");
  assert.equal(candidates.length, 100); assert.equal(candidates.at(-1).base64, "149"); assert.equal(candidates[0].base64, "50"); assert(candidates.limited);
});

test("invalid base64, MIME mismatch, oversized dimensions and symlink images are omitted with explicit warnings", async t => {
  const image = png(), f = await fixture(t, "claude", [claude([{ type: "image", source: { type: "base64", media_type: "image/png", data: "bad%%" } }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.toString("base64") } }])]);
  const page = await activity(f.request("gallery")); assert.equal(page.images.length, 0); assert(page.warnings.some(value => /base64/.test(value))); assert(page.warnings.some(value => /MIME/.test(value)));
  assert.throws(() => imageMetadata(png(1, 4097, 1)), /dimensions/); assert.throws(() => imageMetadata(png(1, 4000, 4000)), /dimensions/); assert.throws(() => imageMetadata(Buffer.alloc(L.imageBytes + 1)), /2 MiB/);
  const original = path.join(f.root, "original.png"), link = path.join(f.root, "link.png"); await fs.writeFile(original, image); await fs.symlink(original, link);
  const codex = await fixture(t, "codex", [{ type: "session_meta", payload: { id, cwd: "/fixture" } }, { type: "event_msg", payload: { type: "user_message", local_images: [link] } }]);
  const omitted = await activity(codex.request("gallery")); assert.equal(omitted.images.length, 0); assert(omitted.warnings.length);
});

test("cache ownership rejects symlink directories/files and cleanup touches only recognized owned cache entries", async t => {
  const f = await fixture(t), outside = path.join(f.root, "outside"); await fs.mkdir(outside); await fs.mkdir(path.join(f.home, "data")); await fs.symlink(outside, path.join(f.home, "data/session-gallery"));
  await assert.rejects(galleryCache(f.home), /unsafe/); assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(path.join(f.home, "data/session-gallery")); const cache = await galleryCache(f.home);
  for (let i = 0; i < 100; i++) await fs.writeFile(path.join(cache, i.toString(16).padStart(64, "0") + ".png"), "fixture");
  const untouched = path.join(cache, "keep-user.txt"); await fs.writeFile(untouched, "keep"); await cleanGalleryCache(cache);
  assert.equal((await fs.readdir(cache)).filter(name => /^[a-f0-9]{64}/.test(name)).length, 96); assert.equal(await fs.readFile(untouched, "utf8"), "keep");
});

test("source changed during image publication is rejected after extraction, not delivered as current evidence", async t => {
  const f = await fixture(t, "claude", [claude([{ type: "image", source: { type: "base64", media_type: "image/png", data: png().toString("base64") } }])]);
  const link = fs.link; let changed = false;
  fs.link = async (...args) => { const result = await link(...args); if (!changed) { changed = true; await fs.appendFile(f.file, JSON.stringify(claude("Changed during cache write")) + "\n"); } return result; };
  try { await assert.rejects(activity(f.request("gallery")), /changed during/); } finally { fs.link = link; }
});

test("native client binds captured identity and rejects oversized or wrong-session responses", async () => {
  const target = { provider: "claude", store: "/fixture/store", id, key: JSON.stringify(["claude", "/fixture/store", id]) }, calls = [];
  const read = createActivityClient(async (...args) => { calls.push(args); return { code: 0, stdout: JSON.stringify({ key: target.key, mode: "timeline", available: true, events: [], images: [], warnings: [], next: null, page: 1 }) }; }, "/fixture/app");
  await read("timeline", target); const request = JSON.parse(calls[0][1][1]); assert.equal(request.target.key, target.key); assert.equal(request.options.stores.claude, target.store); assert.equal(calls[0][2].timeout, 12000);
  await assert.rejects(createActivityClient(async () => ({ code: 0, stdout: JSON.stringify({ key: "wrong" }) }), "/fixture")("gallery", target), /match/);
});


test("Claude structured tool_result image content is included only one level deep", async t => {
  const image = png(31), part = { type: "image", source: { type: "base64", media_type: "image/png", data: image.toString("base64") } };
  const f = await fixture(t, "claude", [claude([{ type: "tool_result", tool_use_id: "read1", content: [{ type: "text", text: "file:///never/read.png" }, part, { type: "tool_result", content: [part] }] }])]);
  const candidates = imageCandidates([{ record: claude([{ type: "tool_result", content: [part, { type: "tool_result", content: [part] }] }]), offset: 0 }], "claude");
  assert.equal(candidates.length, 1); const page = await activity(f.request("gallery")); assert.equal(page.images.length, 1); assert.equal(page.images[0].cached, true);
});


test("one oversized event group does not hide older records and mixed Codex schemas retain distinct messages", async t => {
 const f = await fixture(t, "claude", [claude("Older retained"), { type: "assistant", sessionId: id, cwd: "/fixture/project", timestamp, message: { content: Array.from({length: 30}, (_, i) => ({type: "tool_use", name: "Tool" + i, input: {command: "literal " + i}})) } }, claude("Latest retained")]);
 let cursor = null, texts = [], warning = false; do { const p = await activity(f.request("timeline", cursor)); texts.push(...p.events.map(e => e.text)); warning ||= p.warnings.some(v => /single record/.test(v)); cursor = p.next; } while(cursor); assert(texts.includes("Older retained")); assert(texts.includes("Latest retained")); assert(warning);
 const events = timelineEvents([{offset:1,record:{type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"Older distinct"}]}}},{offset:2,record:{type:"event_msg",payload:{type:"user_message",message:"Newer duplicate"}}},{offset:3,record:{type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"Newer duplicate"}]}}}],"codex"); assert.deepEqual(events.map(e=>e.text),["Older distinct","Newer duplicate"]);
});


test("session replacement between identity resolution and open is rejected", async t => {
 const f=await fixture(t), realpath=fs.realpath; let replaced=false; fs.realpath=async (...args)=>{const result=await realpath(...args); if(!replaced && args[0]===f.store){replaced=true;await fs.writeFile(f.file,JSON.stringify({...claude("Other session"),sessionId:second})+"\n");} return result;};
 try {await assert.rejects(activity(f.request("timeline")),/after its identity/);} finally {fs.realpath=realpath;}
});

test("cache publication leaves foreign symlink destinations untouched", async t => {
 const image=png(77),f=await fixture(t,"claude",[claude([{type:"image",source:{type:"base64",media_type:"image/png",data:image.toString("base64")}}])]);
 const cache=await galleryCache(f.home),outside=path.join(f.root,"keep-original.txt");await fs.writeFile(outside,"keep");const {createHash}=await import("node:crypto"),name=createHash("sha256").update(image).digest("hex")+".png";await fs.symlink(outside,path.join(cache,name));
 const page=await activity(f.request("gallery"));assert.equal(page.images.length,0);assert(page.warnings.some(v=>/unsafe cached/.test(v)));assert.equal(await fs.readFile(outside,"utf8"),"keep");assert((await fs.lstat(path.join(cache,name))).isSymbolicLink());assert(!(await fs.readdir(cache)).some(v=>v.startsWith(".pending")));
});

test("pixel-budget gallery pages retain older records and explicitly mark overfull single-record attachments", async t => {
 const records=Array.from({length:3},(_,i)=>claude([{type:"image",source:{type:"base64",media_type:"image/png",data:png(i,3000,2000).toString("base64")}}])),f=await fixture(t,"claude",records);
 const first=await activity(f.request("gallery"));assert.equal(first.images.length,2);assert(first.next);const older=await activity(f.request("gallery",first.next));assert.equal(older.images.length,1);assert.equal(new Set([...first.images,...older.images].map(v=>v.id)).size,3);
 const one=await fixture(t,"claude",[claude(records.flatMap(v=>v.message.content))]);const capped=await activity(one.request("gallery"));assert.equal(capped.images.length,2);assert(capped.warnings.some(v=>/one JSONL record/.test(v)));
});

test("local image byte-budget pagination does not skip older references in the same JSONL byte page", async t => {
 const f=await fixture(t,"codex",[{type:"session_meta",payload:{id,cwd:"/fixture"}}]),records=[{type:"session_meta",payload:{id,cwd:"/fixture"}}];
 for(let i=0;i<5;i++){const small=png(i),large=Buffer.concat([small.subarray(0,small.length-12),chunk("tEXt",Buffer.alloc(1800000,65+i)),small.subarray(-12)]),file=path.join(f.root,`image-${i}.png`);await fs.writeFile(file,large);records.push({type:"event_msg",timestamp,payload:{type:"user_message",local_images:[file]}});}
 await fs.writeFile(f.file,records.map(v=>JSON.stringify(v)).join("\n")+"\n");const first=await activity(f.request("gallery"));assert.equal(first.images.length,4);assert(first.next);assert(first.warnings.some(v=>/8 MiB/.test(v)));const older=await activity(f.request("gallery",first.next));assert.equal(older.images.length,1);assert.equal(new Set([...first.images,...older.images].map(v=>v.id)).size,5);
});
