import { uiFunction } from "./helpers/ui-function.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import * as model from "../mods/files-plus/review-model.js";
import { createGitReader } from "../mods/files-plus/git-reader.js";
import { diffRows } from "../mods/files-plus/git-model.js";

const context = { root: "/repo", on: null }, file = { path: "src/a.js", section: "unstaged" };
const rows = diffRows(["@@ -1,2 +1,3 @@", " keep", "-old", "+new", "+extra"]);
const anchor = model.anchorFor(file, "version-a", rows, { side: "after", start: 2, end: 3 });
const draft = () => model.addReviewComment({ comments: [], viewed: {} }, anchor, "Keep the old behavior.");

test("review scopes separate machines, worktrees and comparison sections", () => {
  let value = model.saveReview(null, context, draft());
  assert.equal(model.reviewState(value, context).comments.length, 1);
  assert.equal(model.reviewState(value, { ...context, on: "remote" }).comments.length, 0);
  assert.equal(model.reviewState(value, { root: "/worktree" }).comments.length, 0);
  assert.notEqual(model.reviewFileKey(file), model.reviewFileKey({ ...file, section: "staged" }));
  value = model.saveReview(value, { root: "/other" }, draft());
  assert.equal(model.reviewState(value, context).comments.length, 1);
});

test("anchors retain original line sides, ranges and exact original code", () => {
  assert.equal(anchor.snippet, "2: new\n3: extra");
  assert.equal(model.anchorFor(file, "v", rows, { side: "before", start: 2, end: 2 }).snippet, "2: old");
  assert.equal(model.anchorFor(file, "v", rows).side, "file");
  assert.throws(() => model.anchorFor(file, null, rows), /Refresh/);
  assert.throws(() => model.anchorFor(file, "v", rows, { side: "after", start: 9, end: 9 }), /no longer/);
  assert.throws(() => model.anchorFor(file, "v", rows, { side: "after", start: 3, end: 1 }), /valid/);
});

test("editing cannot resurrect a removed comment or silently overwrite a delivery", () => {
  assert.throws(() => model.addReviewComment(draft(), anchor, "edit", "missing"), /removed/);
  assert.throws(() => model.addReviewComment({ ...draft(), delivery: { status: "sending" } }, anchor, "new"), /locked/);
  assert.throws(() => model.addReviewComment(draft(), anchor, "x".repeat(model.COMMENT_LIMIT + 1)), /characters/);
  const current = draft(), updated = model.addReviewComment(current, anchor, "new note", current.comments[0].id);
  assert.equal(updated.comments.length, 1); assert.equal(updated.comments[0].text, "new note");
});

test("storage limits never evict projects that have saved feedback", () => {
  let value = null;
  for (let i = 0; i < 40; i++) value = model.saveReview(value, { root: `/repo-${i}` }, draft());
  assert.throws(() => model.saveReview(value, { root: "/overflow" }, draft()), /40 projects/);
  assert.equal(Object.keys(value.repositories).length, 40);
  const comments = Object.values(value.repositories).map(state => state.comments[0].text);
  assert.ok(comments.every(text => text === "Keep the old behavior."));
  value.repositories[model.reviewKey({ root: "/repo-0" })] = { viewed: {}, comments: [] };
  value = model.saveReview(value, { root: "/overflow" }, draft());
  assert.equal(Object.keys(value.repositories).length, 40);
});

test("viewed expires on any complete content version change", () => {
  const state = model.setViewed(draft(), file, "v1", true);
  assert.equal(model.viewedVersion(state, file, "v1"), true);
  assert.equal(model.viewedVersion(state, file, "v2"), false);
  assert.equal(model.viewedVersion(state, { ...file, section: "staged" }, "v1"), false);
  assert.throws(() => model.setViewed(state, file, null, true), /Refresh/);
  assert.equal(model.viewedVersion(model.setViewed(state, file, "v1", false), file, "v1"), false);
});

test("messages preserve outdated origin and never silently truncate feedback", () => {
  const state = draft(), key = model.reviewFileKey(file);
  const current = model.reviewMessage(state, context, { [key]: "version-a" });
  assert.ok(!current.includes("OUTDATED")); assert.match(current, /after 2–3/); assert.match(current, /2: new/);
  const outdated = model.reviewMessage(state, context, { [key]: "version-b" });
  assert.match(outdated, /OUTDATED/); assert.match(outdated, /version-a/); assert.match(outdated, /Keep the old behavior/);
  const large = { comments: Array.from({ length: 30 }, (_, index) => ({ ...state.comments[0], id: String(index), text: "x".repeat(3900) })) };
  const message = model.reviewMessage(large, context, {});
  assert.ok(message.length > model.MESSAGE_LIMIT); assert.ok(message.includes("30. src/a.js"));
});

test("recipient requires a live exact identity on the review's machine and an idle agent", () => {
  const agent = { address: "t1", app: "codex", space: "s1", tab: "tab1", status: "idle" };
  const terminal = { address: "t1", state: "live", created_ms: 1, foreground: { pid: 100, argv: ["codex"] } };
  const target = model.reviewTarget(agent, terminal);
  assert.equal(model.validateReviewTarget(target, [agent], [terminal]).address, "t1");
  assert.throws(() => model.validateReviewTarget(target, [agent], [{ ...terminal, foreground: { ...terminal.foreground, pid: 101 } }]), /changed/);
  assert.throws(() => model.validateReviewTarget(target, [{ ...agent, status: "blocked" }], [terminal]), /idle/);
  assert.throws(() => model.validateReviewTarget(target, [agent], [terminal], "remote"), /changed/);
  assert.equal(model.reviewTargets([agent], [{ ...terminal, state: "exited" }]).length, 0);
});

const run = promisify(execFile);
async function execute(command, args, { cwd } = {}) {
  try { return { code: 0, ...await run(command, args, { cwd, encoding: "utf8" }) }; }
  catch (error) { return { code: error.code, stdout: error.stdout || "", stderr: error.stderr || error.message }; }
}
async function git(root, ...args) { const result = await execute("git", args, { cwd: root }); assert.equal(result.code, 0, result.stderr); return result.stdout; }

test("real Git complete versions detect same-size edits beyond the truncated preview and index changes", async t => {
  const root = await mkdtemp(join(tmpdir(), "herdr-review-version-")); t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "--quiet");
  const path = "file.txt", target = { path, fresh: true, section: "unstaged" };
  const reader = createGitReader(execute, async path => { try { return await readFile(path, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }, { root });
  await writeFile(join(root, path), "line\n".repeat(1600) + "tail-a\n");
  const before = await reader.reviewVersion(target), previewBefore = await reader.diff(target);
  await writeFile(join(root, path), "line\n".repeat(1600) + "tail-b\n");
  assert.deepEqual((await reader.diff(target)).lines, previewBefore.lines);
  assert.notEqual(await reader.reviewVersion(target), before);
  await git(root, "add", "--", path);
  const staged = { path, section: "staged" }, stagedBefore = await reader.reviewVersion(staged);
  await writeFile(join(root, path), "changed\n"); await git(root, "add", "--", path);
  assert.notEqual(await reader.reviewVersion(staged), stagedBefore);
  await rm(join(root, path));
  assert.match(await reader.reviewVersion({ path, section: "unstaged", deleted: true }), /deleted/);
});

function element() {
  let proxy;
  const state = { children: [], attributes: {}, events: {} };
  proxy = new Proxy(state, { get(target, key) {
    if (key === "child") return value => { target.children.push(value); return proxy; };
    if (key === "children") return values => { target.children.push(...values); return proxy; };
    if (key === "when") return (value, callback) => value ? callback(proxy) : proxy;
    if (key in target) return target[key];
    if (String(key).startsWith("on_")) return callback => { target.events[key] = callback; return proxy; };
    return value => { target.attributes[key] = value; return proxy; };
  } });
  return proxy;
}
async function harness() {
  let state = model.saveReview(null, context, draft()), version = "version-a", sendResult = { code: 0, stdout: '{"turn":1}' };
  const pending = [], timers = [], calls = [], editors = [];
  let readVersion = async () => version;
  const agent = { address: "t1", app: "codex", space: "s1", space_name: "Project", tab: "tab1", status: "idle" };
  const terminal = { address: "t1", state: "live", created_ms: 1, foreground: { pid: 100, argv: ["codex"] } };
  const cx = { focus_handle: () => ({ focus() {} }), notify() {}, stop_propagation() {}, write_to_clipboard() {}, spawn(task) { pending.push(task(cx)); }, timer: { after(_ms, callback) { timers.push(callback); } } };
  const dependencies = { ...model, div: element, h_flex: element, v_flex: element, Editor: { new: element }, EditorState: { new(options) {
    let value = options.value; const events = {};
    const editor = { options, value: () => value, set_value(next) { value = next; }, on(name, callback) { events[name] = callback; }, release() { this.released = true; }, type(next) { value = next; events.change?.({}, cx); } };
    editors.push(editor); return editor;
  } }, agents: () => [agent], terminals: () => [terminal], theme: () => ({}), shared: () => state, setShared(_key, value) { state = value; }, closeOverlay() {}, openOverlay() {}, exec() {}, readTextFile() {},
  createGitReader: () => ({ reviewVersion: (...args) => readVersion(...args) }), hc: async args => { if (args[0] === "get") return { code: 0, stdout: JSON.stringify({ ...terminal, status: { state: agent.status, app: agent.app } }) }; calls.push(args); return sendResult; } };
  const source = (await readFile(new URL("../mods/files-plus/review.js", import.meta.url), "utf8")).replace(/^import .+;$/gm, "").replace("export default class Review {", "return class Review {");
  const Review = uiFunction(...Object.keys(dependencies), source)(...Object.values(dependencies));
  const create = () => { const view = new Review(); view.init({ context, versions: { [model.reviewFileKey(file)]: "version-a" } }, cx); return view; };
  const drain = async () => { while (pending.length) await pending.shift(); while (timers.length) timers.shift()(cx); while (pending.length) await pending.shift(); };
  const view = create(); await drain();
  return { view, create, cx, drain, calls, editors, agent, terminal, state: () => state, replaceState: value => { state = value; }, flushTimers() { while (timers.length) timers.shift()(cx); }, setVersionReader: callback => { readVersion = callback; }, setVersion: value => { version = value; }, setResult: value => { sendResult = value; } };
}

test("review send is explicit, single-flight across copies, and preserves the checked message", async () => {
  const f = await harness(), other = f.create(); await f.drain();
  f.view.selected = model.reviewTarget(f.agent, f.terminal); other.selected = { ...f.view.selected };
  f.view.send(f.cx); other.send(f.cx); await f.drain();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].slice(0, 2), ["send", "t1"]);
  assert.deepEqual(f.calls[0].slice(-3), ["--if", "idle", "--json"]);
  assert.equal(f.state().repositories[model.reviewKey(context)].delivery.status, "sent");
  assert.equal(f.view.editor.options.readonly, true); assert.equal(f.state().repositories[model.reviewKey(context)].comments.length, 1);
  f.view.send(f.cx); await f.drain(); assert.equal(f.calls.length, 1);
  f.view.newReview(f.cx); await f.drain();
  assert.equal(f.state().repositories[model.reviewKey(context)].comments.length, 0);
});

test("failed delivery retains comments and cannot automatically retry", async () => {
  const f = await harness(); f.setResult({ code: 1, stdout: "" }); f.view.selected = model.reviewTarget(f.agent, f.terminal);
  f.view.send(f.cx); await f.drain(); f.view.send(f.cx); await f.drain();
  assert.equal(f.calls.length, 1); assert.equal(f.state().repositories[model.reviewKey(context)].delivery.status, "uncertain");
  assert.equal(f.state().repositories[model.reviewKey(context)].comments.length, 1); assert.match(f.view.error, /not confirmed/);
});

test("fresh source change and oversized edited message prevent any delivery", async () => {
  const f = await harness(); f.view.selected = model.reviewTarget(f.agent, f.terminal); f.setVersion("version-b");
  f.view.send(f.cx); await f.drain(); assert.equal(f.calls.length, 0); assert.match(f.view.error, /Source versions changed/);
  assert.equal(f.state().repositories[model.reviewKey(context)].delivery, null);
  f.view.editor.set_value("x".repeat(model.MESSAGE_LIMIT + 1)); f.view.send(f.cx); await f.drain(); assert.equal(f.calls.length, 0); assert.match(f.view.error, /characters/);
});

test("core delivery acknowledgment must contain an exact confirmed turn", () => {
  assert.equal(model.reviewSendAcknowledged({ code: 0, stdout: '{"turn":0}' }), true);
  assert.equal(model.reviewSendAcknowledged({ code: 0, stdout: '{"turn":10,"started":true}' }), true);
  for (const stdout of ['{}', '{"ok":true}', '{"turn":-1}', '{"turn":1.2}', '{"turn":"2"}', '{"turn":9007199254740992}', '{"turn":1,"error":"failed"}', 'broken']) assert.equal(model.reviewSendAcknowledged({ code: 0, stdout }), false);
});

test("fresh core identity prevents a send after the selected process is replaced", () => {
  const agent = { address: "remote/t1", app: "codex", space: "remote/s1", tab: "remote/tab1", status: "idle" };
  const terminal = { address: "remote/t1", identity: "original", state: "live", created_ms: 1, pid: 2, foreground: { pid: 100, argv: ["codex"] } };
  const selected = model.reviewTarget(agent, terminal);
  const fresh = { ...terminal, address: "t1", status: { state: "idle", app: "codex" } };
  assert.equal(model.validateReviewCoreTarget(selected, [agent], [terminal], fresh, "remote").address, "remote/t1");
  assert.throws(() => model.validateReviewCoreTarget(selected, [agent], [terminal], { ...fresh, identity: "new" }, "remote"), /changed/);
  assert.throws(() => model.validateReviewCoreTarget(selected, [agent], [terminal], { ...fresh, status: { state: "working" } }, "remote"), /not idle/);
});

test("editing the review message survives later comment edits and removals", async () => {
  const original = { ...draft(), message: "My carefully edited introduction" };
  const updated = model.addReviewComment(original, anchor, "An extra note");
  assert.equal(updated.message, original.message); assert.equal(updated.messageStale, true);
  const f = await harness();
  f.view.editor.type("My own edited message");
  const id = f.state().repositories[model.reviewKey(context)].comments[0].id;
  f.view.remove(id, f.cx); await f.drain();
  assert.equal(f.state().repositories[model.reviewKey(context)].message, "My own edited message");
  assert.equal(f.state().repositories[model.reviewKey(context)].messageStale, true);
});

test("another review view becomes readonly after a delivery locks the shared draft", async () => {
  const f = await harness(), other = f.create(); await f.drain();
  f.view.selected = model.reviewTarget(f.agent, f.terminal); f.view.send(f.cx); await f.drain();
  other.render(f.cx); await f.drain();
  assert.equal(other.editor.options.readonly, true);
  assert.equal(other.editor.value(), f.state().repositories[model.reviewKey(context)].message);
});

test("Changes supports before/after range selection and forbids Viewed for an incomplete preview", async () => {
  const overlays = []; let stored = null;
  const dependencies = { ...model, div: element, projectContext: () => context, shared: () => stored, setShared(_key, value) { stored = value; }, openOverlay: value => overlays.push(value) };
  const source = (await readFile(new URL("../mods/files-plus/changes.js", import.meta.url), "utf8")).replace(/^import .+;$/gm, "").replace("export default class Changes {", "return class Changes {");
  const Changes = uiFunction(...Object.keys(dependencies), source)(...Object.values(dependencies));
  const view = new Changes();
  Object.assign(view, { page: "changes", files: [file], historyFiles: [], root: context.root, on: null, open: file.path, section: file.section, reviewVersion: "version-a", rawRows: rows, diffLoading: false, reviewComplete: false });
  const cx = { notify() {} };
  view.selectReviewLine(rows[3], "after", {}, cx);
  view.selectReviewLine(rows[4], "after", { modifiers: { shift: true } }, cx);
  assert.deepEqual(view.reviewSelection, { side: "after", anchor: 2, start: 2, end: 3 });
  view.addComment(cx); assert.equal(overlays[0].props.anchor.snippet, "2: new\n3: extra");
  view.selectReviewLine(rows[2], "before", { modifiers: { shift: true } }, cx);
  assert.deepEqual(view.reviewSelection, { side: "before", anchor: 2, start: 2, end: 2 });
  view.markViewed(cx); assert.equal(stored, null);
  view.reviewComplete = true; view.markViewed(cx);
  assert.equal(model.viewedVersion(model.reviewState(stored, context), file, "version-a"), true);
});

test("pending source verification reruns the newest shared comment revision instead of staying stale", async () => {
  const f = await harness(), reads = [];
  f.setVersionReader(() => new Promise(resolve => reads.push(resolve)));
  const view = f.create();
  assert.equal(view.checking, true); assert.equal(reads.length, 1);
  const previous = model.reviewState(f.state(), context);
  const changed = model.addReviewComment(previous, previous.comments[0], "Changed in another view", previous.comments[0].id);
  f.replaceState(model.saveReview(f.state(), context, changed));
  view.render(f.cx); f.flushTimers();
  assert.equal(view.verifyAgain, true);
  reads[0]("version-a"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 2); assert.equal(view.checking, true);
  reads[1]("version-a"); await f.drain();
  assert.equal(view.checking, false); assert.equal(view.verifyAgain, false);
  assert.equal(view.verification, view.commentRevision());
  f.setVersionReader(async () => "version-a");
  view.selected = model.reviewTarget(f.agent, f.terminal); view.send(f.cx); await f.drain();
  assert.equal(f.calls.length, 1);
});

test("disposed review verification never queues another read after its stale request ends", async () => {
  const f = await harness(), reads = [];
  f.setVersionReader(() => new Promise(resolve => reads.push(resolve)));
  const view = f.create(), previous = model.reviewState(f.state(), context);
  f.replaceState(model.saveReview(f.state(), context, model.addReviewComment(previous, previous.comments[0], "Changed", previous.comments[0].id)));
  view.render(f.cx); f.flushTimers(); view.close();
  reads[0]("version-a"); await f.drain();
  assert.equal(reads.length, 1); assert.equal(view.checking, false); assert.equal(view.verification, undefined);
});

test("comment insertion rejects missing or malformed source anchors before mutating the draft", () => {
  const previous = draft(), before = JSON.stringify(previous);
  for (const malformed of [undefined, null, {}, { ...anchor, file: null }, { ...anchor, file: { path: "../other", section: "unstaged" } }, { ...anchor, version: "" }, { ...anchor, side: "after", start: -1 }, { ...anchor, snippet: undefined }, { ...anchor, file: { ...file, section: "history", commit: "invalid", parents: [] } }]) {
    assert.throws(() => model.addReviewComment(previous, malformed, "Keep this text"), /valid|source|anchor/);
    assert.equal(JSON.stringify(previous), before);
  }
});

async function commentHarness(initial, props) {
  let stored = model.saveReview(null, context, initial), closed = false;
  const cx = { focus_handle: () => ({ focus() {} }), notify() {}, stop_propagation() {} };
  const dependencies = { ...model, div: element, v_flex: element, h_flex: element, Editor: { new: element }, EditorState: { new(options) {
    let value = options.value; const events = {};
    return { value: () => value, on(name, callback) { events[name] = callback; }, type(next) { value = next; events.change?.({}, cx); }, release() {} };
  } }, shared: () => stored, setShared(_key, next) { stored = next; }, theme: () => ({}), closeOverlay() { closed = true; } };
  const source = (await readFile(new URL("../mods/files-plus/review-comment.js", import.meta.url), "utf8")).replace(/^import .+;$/gm, "").replace("export default class ReviewComment {", "return class ReviewComment {");
  const Comment = uiFunction(...Object.keys(dependencies), source)(...Object.values(dependencies));
  const view = new Comment(); view.init({ ...props, context }, cx);
  return { view, cx, state: () => stored, replaceState: value => { stored = value; }, closed: () => closed };
}

test("opening an already-removed comment keeps its editing identity and cannot create an invalid new note", async () => {
  const f = await commentHarness({ comments: [], viewed: {} }, { commentId: "removed-id" });
  const before = JSON.stringify(f.state());
  assert.equal(f.view.id, "removed-id"); assert.equal(f.view.editing, true); assert.match(f.view.error, /removed/);
  f.view.editor.type("Text must not become a new comment"); f.view.render(); f.view.save(f.cx);
  assert.match(f.view.error, /removed/); assert.equal(JSON.stringify(f.state()), before); assert.equal(f.closed(), false);
});

test("a comment removed after its editor opens cannot be resurrected or mutate unrelated notes", async () => {
  const original = draft(), id = original.comments[0].id;
  const f = await commentHarness(original, { commentId: id });
  f.replaceState(model.saveReview(f.state(), context, { ...original, comments: [] }));
  const before = JSON.stringify(f.state());
  f.view.editor.type("Keep these unsaved edits visible"); f.view.save(f.cx);
  assert.match(f.view.error, /removed/); assert.equal(f.view.editor.value(), "Keep these unsaved edits visible");
  assert.equal(JSON.stringify(f.state()), before); assert.equal(f.closed(), false);
});
