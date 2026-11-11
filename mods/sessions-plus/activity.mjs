// Bounded local transcript evidence and image extraction. No network or model calls.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveSession } from "./history.mjs";
import { ACTIVITY_LIMITS as L, activityTarget, activityTime } from "./activity-model.js";
const digest = value => createHash("sha256").update(value).digest("hex");
const clean = (value, max = 2400) => { const text = typeof value === "string" ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "") : ""; return text.length > max ? text.slice(0, max - 1) + "…" : text; };
const stamp = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
const safePath = value => typeof value === "string" && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
function recordText(content) { return typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => ["text", "input_text", "output_text"].includes(part?.type)).map(part => part.text || "").join("\n") : ""; }
function toolFiles(input) {
  const files = [input?.file_path, input?.path, input?.notebook_path].filter(value => typeof value === "string" && value.length < 2000);
  const patch = input?.patch || input?.input;
  if (typeof patch === "string") for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) if (files.length < 12) files.push(match[1].slice(0, 2000));
  return [...new Set(files)].slice(0, 8).map(file => file.length > 300 ? file.slice(0, 300) + "…" : file);
}
export function timelineEvents(records, provider) {
  const events = [], offsets = new Map(), eventBodies = { user: new Map(), assistant: new Map() };
  if (provider === "codex") for (const { record } of records) if (record.type === "event_msg") { const role = record.payload?.type === "user_message" ? "user" : record.payload?.type === "agent_message" ? "assistant" : null, body = record.payload?.message; if (role && typeof body === "string") eventBodies[role].set(body, (eventBodies[role].get(body) || 0) + 1); }
  const add = (offset, kind, title, text, record, files = [], duration = null) => {
    const index = offsets.get(offset) || 0; offsets.set(offset, index + 1);
    events.push({ id: `${offset}:${index}`, offset, kind, title: clean(title, 200), text: clean(text), files, timestamp: activityTime(record.timestamp), durationMs: Number.isFinite(duration) && duration >= 0 && duration <= 604800000 ? duration : null });
  };
  for (const { record, offset } of records) {
    if (provider === "claude") {
      if (record.type === "user" && !record.isMeta) { const body = recordText(record.message?.content); if (body.trim()) add(offset, "prompt", "User prompt", body, record); }
      if (record.type === "assistant") {
        const body = recordText(record.message?.content); if (body.trim()) add(offset, "response", "Assistant response", body, record);
        for (const part of Array.isArray(record.message?.content) ? record.message.content : []) if (part?.type === "tool_use") { const input = part.input || {}, files = toolFiles(input); add(offset, "tool", part.name || "Tool", typeof input.command === "string" ? input.command : JSON.stringify(input), record, files); }
      }
      if (record.type === "system" && record.subtype === "turn_duration" && Number.isFinite(record.durationMs)) add(offset, "duration", "Recorded turn duration", "Explicit durationMs field in the session log.", record, [], record.durationMs);
    } else {
      const payload = record.payload || {};
      if (record.type === "event_msg" && payload.type === "user_message") add(offset, "prompt", "User prompt", payload.message || "", record);
      if (record.type === "event_msg" && payload.type === "agent_message") add(offset, "response", "Assistant response", payload.message || "", record);
      if (record.type === "response_item" && payload.type === "message" && ["user", "assistant"].includes(payload.role)) { const body = recordText(payload.content), duplicates = eventBodies[payload.role].get(body) || 0; if (duplicates) eventBodies[payload.role].set(body, duplicates - 1); else if (body.trim()) add(offset, payload.role === "user" ? "prompt" : "response", payload.role === "user" ? "User prompt" : "Assistant response", body, record); }
      if (record.type === "response_item" && ["function_call", "custom_tool_call"].includes(payload.type)) {
        let input = {}; try { input = JSON.parse(payload.arguments || "{}"); } catch { /* The raw argument excerpt remains visible. */ }
        const files = toolFiles({ ...input, input: payload.input });
        add(offset, "tool", payload.name || "Tool", payload.arguments || payload.input || "", record, files);
      }
      if (record.type === "event_msg" && Number.isFinite(payload.duration_ms)) add(offset, "duration", "Recorded duration", `Explicit duration_ms field (${payload.type || "event"}).`, record, [], payload.duration_ms);
    }
  }
  return events;
}
export function imageCandidates(records, provider) {
  const candidates = [];
  const add = (value, offset, timestamp, label) => { candidates.push({ ...value, offset, timestamp: activityTime(timestamp), label }); if (candidates.length > 100) { candidates.shift(); candidates.limited = true; } };
  for (const { record, offset } of records) {
    const payload = provider === "claude" ? record.message : record.type === "response_item" ? record.payload : null;
    const parts = Array.isArray(payload?.content) ? payload.content : [];
    function* imageParts() { for (const part of parts) { yield part; if (provider === "claude" && part?.type === "tool_result" && Array.isArray(part.content)) for (const child of part.content) yield child; } }
    for (const part of imageParts()) {
      if (part?.type === "image" && part.source?.type === "base64") add({ base64: part.source.data, mime: part.source.media_type }, offset, record.timestamp, "Recorded image attachment");
      if (part?.type === "input_image" && typeof part.image_url === "string") {
        const match = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/.exec(part.image_url);
        if (match) add({ mime: match[1], base64: match[2] }, offset, record.timestamp, "Recorded image attachment");
      }
    }
    if (provider === "codex" && record.type === "event_msg" && record.payload?.type === "user_message") for (const file of (Array.isArray(record.payload.local_images) ? record.payload.local_images : [])) if (safePath(file)) add({ path: file }, offset, record.timestamp, "Recorded local attachment");
    if (provider === "codex" && record.type === "response_item" && record.payload?.type === "function_call" && /(?:^|__)view_image$/.test(record.payload.name || "")) {
      try { const input = JSON.parse(record.payload.arguments); if (safePath(input.path)) add({ path: input.path }, offset, record.timestamp, "Recorded image-view tool target"); } catch { /* Unsupported arguments are never executed. */ }
    }
  }
  return candidates;
}
export function imageMetadata(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > L.imageBytes) throw new Error("Images are limited to 2 MiB each.");
  let width, height, ext;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString("ascii", 12, 16) === "IHDR" && bytes.readUInt32BE(8) === 13) {
    ext = "png"; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); let offset = 8, ended = false;
    while (offset + 12 <= bytes.length) { const length = bytes.readUInt32BE(offset), kind = bytes.toString("ascii", offset + 4, offset + 8); if (length > L.imageBytes || offset + length + 12 > bytes.length || kind === "acTL") throw new Error("Incomplete or animated PNG images are not previewed."); offset += length + 12; if (kind === "IEND") { ended = offset === bytes.length; break; } }
    if (!ended) throw new Error("Incomplete PNG image.");
  } else if (bytes.length > 12 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) {
    ext = "jpg";
    for (let offset = 2; offset + 9 < bytes.length;) { if (bytes[offset] !== 255) break; const marker = bytes[offset + 1], length = bytes.readUInt16BE(offset + 2); if (length < 2 || offset + length + 2 > bytes.length) break; if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) { height = bytes.readUInt16BE(offset + 5); width = bytes.readUInt16BE(offset + 7); break; } offset += length + 2; }
  } else if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length) {
    ext = "webp"; const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X" && !(bytes[20] & 2)) { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    else if (kind === "VP8 " && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) { width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383; }
    else if (kind === "VP8L" && bytes[20] === 47) { width = 1 + (((bytes[22] & 63) << 8) | bytes[21]); height = 1 + (((bytes[24] & 15) << 10) | (bytes[23] << 2) | ((bytes[22] & 192) >> 6)); }
  }
  if (!ext || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > L.dimension || height > L.dimension || width * height > L.pixels) throw new Error("Only bounded PNG, JPEG and static WebP images with verified dimensions are previewed.");
  return { ext, width, height, bytes: bytes.length };
}
export async function galleryCache(home) {
  if (!safePath(home)) throw new Error("An absolute Herdr home is required for the owned image cache.");
  const real = await fs.realpath(home); if (real !== path.resolve(home)) throw new Error("The image cache home must not be a symbolic link.");
  let dir = home;
  for (const part of ["data", "session-gallery"]) { dir = path.join(dir, part); await fs.mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; }); const info = await fs.lstat(dir); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error("The owned image cache contains an unsafe directory."); }
  return dir;
}
export async function cleanGalleryCache(dir, now = Date.now()) {
  const files = [];
  const names = await fs.readdir(dir); if (names.length > 300) throw new Error("The image cache inventory exceeds its safe limit; no new images were cached.");
  for (const name of names) { if (/^\.pending-\d+-\d+-[a-z0-9]+$/.test(name)) { const file = path.join(dir, name), info = await fs.lstat(file).catch(() => null); if (info?.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && now - info.mtimeMs > 3600000) await fs.unlink(file); continue; } if (!/^[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(name)) continue; const file = path.join(dir, name), info = await fs.lstat(file).catch(() => null); if (info?.isFile() && !info.isSymbolicLink() && info.uid === process.getuid()) files.push({ file, size: info.size, time: info.mtimeMs }); }
  files.sort((a,b) => b.time - a.time); let total = 0, kept = 0;
  for (const file of files) { total += file.size; kept++; if (now - file.time > L.age || total > L.cacheBytes || kept > L.cacheFiles) await fs.unlink(file.file); }
}
async function cacheCandidate(candidate, cache, home) {
  let bytes;
  if (candidate.base64 !== undefined) {
    const value = candidate.base64;
    if (typeof value !== "string" || value.length > Math.ceil(L.imageBytes / 3) * 4 || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("Invalid or oversized base64 image omitted.");
    bytes = Buffer.from(value, "base64"); if (bytes.toString("base64") !== value) throw new Error("Invalid base64 image omitted.");
  } else {
    if (!safePath(candidate.path)) throw new Error("The image path is not a local absolute path.");
    const handle = await fs.open(candidate.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const info = await handle.stat(); if (!info.isFile() || info.uid !== process.getuid() || info.size > L.imageBytes) throw new Error("The recorded image is missing, not owned, or oversized."); const buffer = Buffer.alloc(Math.min(info.size, L.imageBytes) + 1), read = await handle.read(buffer, 0, buffer.length, 0); bytes = buffer.subarray(0, read.bytesRead); if (bytes.length > L.imageBytes) throw new Error("The image exceeded its byte limit while reading."); if (stamp(info) !== stamp(await handle.stat())) throw new Error("The image changed while reading."); } finally { await handle.close(); }
  }
  const metadata = imageMetadata(bytes), expected = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[candidate.mime];
  if (candidate.base64 !== undefined && expected !== metadata.ext) throw new Error("The image MIME type does not match its signature.");
  const id = digest(bytes), name = `${id}.${metadata.ext}`, file = path.join(cache, name);
  const pending = path.join(cache, ".pending-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  try {
    await fs.writeFile(pending, bytes, { flag: "wx", mode: 0o600 });
    try { await fs.link(pending, file); }
    catch (error) { if (error.code !== "EEXIST") throw error; const info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.size !== bytes.length || digest(await fs.readFile(file)) !== id) throw new Error("An unsafe cached image was left unchanged."); }
  } finally { await fs.unlink(pending).catch(() => {}); }
  return { ...metadata, id, image: `data/session-gallery/${name}`, path: candidate.path || path.join(home, "data/session-gallery", name), cached: !candidate.path, timestamp: candidate.timestamp, label: candidate.label, offset: candidate.offset };
}
export async function activity(request, { now = Date.now() } = {}) {
  const target = activityTarget(request.target), mode = request.mode;
  if (!["timeline", "gallery"].includes(mode)) throw new Error("Unsupported session activity view.");
  const row = resolveSession(target.key, request.options || {}), result = { key: target.key, mode, available: target.provider !== "agy", events: [], images: [], next: null, warnings: [], page: 1 };
  if (!result.available) return { ...result, message: "Antigravity timeline and session images are not supported. Only its saved summary metadata is available." };
  const storeReal = await fs.realpath(row.store), fileReal = await fs.realpath(row.source);
  if (!fileReal.startsWith(storeReal + path.sep)) throw new Error("The session file is outside its verified store.");
  const handle = await fs.open(row.source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat(); if (!info.isFile() || info.uid !== process.getuid()) throw new Error("Only a regular owned session file can be read.");
    if (`${info.size}:${info.mtimeMs}:${info.ino}` !== row.sourceStamp) throw new Error("The session changed after its identity was verified. Refresh before reading it.");
    const signature = stamp(info), key = digest(target.key); let end = info.size, page = 1;
    if (request.cursor) { let cursor; try { cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")); } catch { throw new Error("Invalid activity page cursor."); } if (cursor?.key !== key || cursor.stamp !== signature || !Number.isSafeInteger(cursor.end) || cursor.end < 0 || cursor.end > info.size || !Number.isSafeInteger(cursor.page) || cursor.page < 2 || cursor.page > L.pages) throw new Error("This session changed or its page expired. Refresh before reading older evidence."); end = cursor.end; page = cursor.page; }
    const start = Math.max(0, end - L.pageBytes), buffer = Buffer.alloc(end - start), read = await handle.read(buffer, 0, buffer.length, start);
    if (read.bytesRead !== buffer.length) throw new Error("The session changed or could not be completely read. Refresh before reading older evidence.");
    let partial = start > 0;
    if (partial) { const preceding = Buffer.alloc(1); const before = await handle.read(preceding, 0, 1, start - 1); partial = before.bytesRead !== 1 || preceding[0] !== 10; }
    let first = partial ? buffer.indexOf(10) + 1 : 0, last = buffer.lastIndexOf(10) + 1;
    if (partial) { result.warnings.push("A boundary-spanning JSONL record was omitted from this page; records over 4 MiB may be unavailable."); if (!first) first = buffer.length; }
    if (last < buffer.length) result.warnings.push("An incomplete trailing JSONL record was skipped.");
    const records = []; let offset = start + first;
    for (const line of buffer.subarray(first, Math.max(first, last)).toString("utf8").split("\n")) { if (!line) { offset++; continue; } try { const record = JSON.parse(line); if (record && typeof record === "object" && !Array.isArray(record)) records.push({ record, offset }); } catch { if (!result.warnings.includes("Malformed JSONL records were skipped.")) result.warnings.push("Malformed JSONL records were skipped."); } offset += Buffer.byteLength(line) + 1; }
    if (stamp(await handle.stat()) !== signature) throw new Error("The session changed while reading. Refresh to capture a new page.");
    result.page = page;
    let nextEnd = start ? start + first : 0; if (nextEnd >= end) nextEnd = start;
    if (mode === "timeline") {
      const events = timelineEvents(records, target.provider);
      if (events.length > L.events) {
        const threshold = events[events.length - L.events].offset, newer = events.filter(event => event.offset > threshold);
        const group = events.filter(event => event.offset === threshold);
        result.events = (newer.length + group.length <= L.events ? [...group, ...newer] : newer.length ? newer : events.slice(-L.events)).reverse();
        if (newer.length) nextEnd = result.events.at(-1).offset;
        else { nextEnd = threshold; result.warnings.push("A single record exceeds the 20-event page limit; only its latest events are shown."); }
      } else result.events = events.reverse();
    }
    else {
      const cache = await galleryCache(request.appHome); await cleanGalleryCache(cache, now); const candidates = imageCandidates(records, target.provider).reverse(); let used = 0, pixels = 0;
      if (candidates.limited) { result.warnings.push("Only the latest 100 structured image references in this byte page were inspected."); if (candidates.at(-1).offset > nextEnd) nextEnd = candidates.at(-1).offset; }
      for (const candidate of candidates) {
        if (result.images.length >= L.images || used >= L.pageImages) { result.warnings.push("Image count or 8 MiB page limit reached."); if (result.images.length) { nextEnd = result.images.at(-1).offset; if (nextEnd === candidate.offset) result.warnings.push("Additional attachments in one JSONL record exceed this page limit and may be omitted."); } break; }
        try { const image = await cacheCandidate(candidate, cache, request.appHome); if (used + image.bytes > L.pageImages || pixels + image.width * image.height > L.pixels) { result.warnings.push("The 8 MiB / 12M pixel image page limit was reached."); if (result.images.length) { nextEnd = result.images.at(-1).offset; if (nextEnd === candidate.offset) result.warnings.push("Additional attachments in one JSONL record exceed this page limit and may be omitted."); } break; } if (!result.images.some(item => item.id === image.id)) { result.images.push(image); used += image.bytes; pixels += image.width * image.height; } }
        catch (error) { if (result.warnings.length < 10) result.warnings.push(clean(error.message, 180)); }
      }
      await cleanGalleryCache(cache, now);
      if (!candidates.length) result.message = "No supported structured local images were found in this byte page. Remote URLs and image-like prompt text are never fetched.";
    }
    if (stamp(await handle.stat()) !== signature) throw new Error("The session changed during activity or image extraction. Refresh to capture new evidence.");
    if (nextEnd > 0 && page < L.pages) result.next = Buffer.from(JSON.stringify({ key, stamp: signature, end: nextEnd, page: page + 1 })).toString("base64url");
    if (nextEnd > 0 && page >= L.pages) result.warnings.push("The 20-page limit was reached; older evidence is not loaded.");
    result.warnings = [...new Set(result.warnings)].slice(0, 12); return result;
  } finally { await handle.close(); }
}
if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => "") === fileURLToPath(import.meta.url)) {
  try { if (!process.argv[2] || Buffer.byteLength(process.argv[2]) > 20000) throw new Error("Invalid bounded activity request."); process.stdout.write(JSON.stringify(await activity(JSON.parse(process.argv[2])))); }
  catch (error) { process.stdout.write(JSON.stringify({ error: String(error.message || error).slice(0, 500) })); process.exitCode = 1; }
}
