// Shared by the explicit CLI and the native storage helper. No artifact scanning or network calls.
import { mkdir, writeFile, rename, unlink, open, lstat } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { DELIVERABLE_LIMITS as LIMIT, deliverableScope, safeDeliverableUrl } from "./deliverables-model.js";
const fail = (message, code = "invalid") => { const error = new Error(message); error.code = code; throw error; };
const clean = (value, max, label, empty = false) => { if (typeof value !== "string" || value.length > max || /[\x00-\x1f\x7f]/.test(value) || !empty && !value.trim()) fail(`${label} is missing, too long, or contains control characters.`); return value; };
export function fileDeliverable(scope, value) {
  clean(value, 4000, "File path"); let location = value;
  const windows = /^[a-z]:[\\/]/i.test(location) || /^[a-z]:\//i.test(scope.root);
  if (windows) location = location.replace(/\\/g, "/");
  if (windows && location.startsWith("//")) fail("Use a drive-based absolute path for a Windows file.");
  location = location.replace(/\/+/g, "/");
  if (location.split("/").some(part => part === ".." || part === ".") || location.endsWith("/")) fail("Choose a file path without parent traversal or a trailing slash.");
  const absolute = location.startsWith("/") || /^[a-z]:\//i.test(location);
  if (!absolute) return { location, file: { root: scope.root, path: location, on: scope.on } };
  if (location === scope.root) fail("Choose a file, rather than the project folder itself.");
  const prefix = scope.root.endsWith("/") ? scope.root : scope.root + "/";
  if (location.startsWith(prefix)) return { location, file: { root: scope.root, path: location.slice(prefix.length), on: scope.on } };
  const index = location.lastIndexOf("/"), folder = location.slice(0, index) || "/";
  return { location, file: { root: /^[a-z]:$/i.test(folder) ? folder + "/" : folder, path: location.slice(index + 1), on: scope.on } };
}
export function validateDeliverable(scope, value) {
  const kind = value?.kind; if (!["file", "url"].includes(kind)) fail("Choose File or URL.");
  const title = clean(value.title || "", 160, "Title", true).trim(), note = clean(value.note || "", 1000, "Note", true);
  if (kind === "url") { let url; try { url = new URL(safeDeliverableUrl(value.location)); } catch { fail("Use an absolute HTTP or HTTPS URL with a host."); } if (url.username || url.password) fail("URLs with embedded credentials are not stored. Use a link without a username or password."); if (!url.hostname || !["http:", "https:"].includes(url.protocol)) fail("Only HTTP or HTTPS links are supported."); if (url.href.length > 4000) fail("The encoded URL is too long. Use a shorter link."); return { kind, title: title || url.hostname.slice(0, 160), location: url.href, note }; }
  const file = fileDeliverable(scope, value.location); return { kind, title: title || file.file.path.split("/").pop().slice(0, 160), location: file.location, note };
}
export function decodeDeliverables(raw) {
  if (raw === null) return { schema: 1, revision: 0, projects: [] };
  if (Buffer.byteLength(raw) > LIMIT.bytes) fail("The saved list exceeds its storage limit. No records were replaced.", "capacity");
  let store; try { store = JSON.parse(raw); } catch { fail("The saved list is unreadable. It was not replaced.", "corrupt"); }
  if (store?.schema !== 1 || !Number.isSafeInteger(store.revision) || store.revision < 0 || !Array.isArray(store.projects) || store.projects.length > LIMIT.projects) fail("The saved list schema is invalid. It was not replaced.", "corrupt");
  const keys = new Set(), ids = new Set(); let total = 0;
  for (const project of store.projects) {
    const scope = deliverableScope(project.scope); if (keys.has(scope.key) || project.scope.key !== scope.key || !Array.isArray(project.items) || project.items.length > LIMIT.perProject) fail("The saved project list is invalid.", "corrupt"); keys.add(scope.key);
    for (const item of project.items) { if (typeof item.id !== "string" || ids.has(item.id) || !Number.isSafeInteger(item.revision) || item.revision < 1 || typeof item.read !== "boolean" || typeof item.archived !== "boolean" || !Number.isSafeInteger(item.created) || !Number.isSafeInteger(item.updated)) fail("A saved item is invalid.", "corrupt"); validateDeliverable(scope, item); ids.add(item.id); total++; }
  }
  if (total > LIMIT.total) fail("The saved list exceeds its item limit.", "capacity"); return store;
}
const itemFor = (store, scope, id) => store.projects.find(project => project.scope.key === scope.key)?.items.find(item => item.id === id);
export function deliverableView(store, input) {
  const scope = deliverableScope(input.scope), project = store.projects.find(project => project.scope.key === scope.key), all = project?.items || [], filter = ["all", "unread", "archived"].includes(input.filter) ? input.filter : "unread", query = clean(input.query || "", 200, "Search", true).toLowerCase();
  const matches = all.filter(item => (filter === "archived" ? item.archived : !item.archived && (filter !== "unread" || !item.read)) && (!query || [item.title, item.location, item.note].join(" ").toLowerCase().includes(query))).sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(matches.length / LIMIT.page)), page = Math.min(Math.max(0, Number.isSafeInteger(input.page) ? input.page : 0), pages - 1);
  return { scope, revision: store.revision, items: matches.slice(page * LIMIT.page, (page + 1) * LIMIT.page).map(item => ({ ...item, ...(item.kind === "file" ? { file: fileDeliverable(scope, item.location).file } : {}) })), page, pages, total: matches.length, counts: { all: all.filter(item => !item.archived).length, unread: all.filter(item => !item.archived && !item.read).length, archived: all.filter(item => item.archived).length } };
}
export function changeDeliverables(store, request, now = Date.now()) {
  const scope = deliverableScope(request.scope), action = request.action, next = structuredClone(store); let project = next.projects.find(row => row.scope.key === scope.key), result;
  if (action === "add" || action === "drop") {
    const additions = action === "add" ? [request.value] : request.values;
    if (!Array.isArray(additions) || !additions.length || additions.length > 10) fail("Add one to ten files at a time.");
    if (action === "drop" && scope.on) fail("Dropped files are from this computer. Enter a remote file path manually in this project's list.");
    const values = additions.map(value => validateDeliverable(scope, value));
    if (!project) { if (next.projects.length >= LIMIT.projects) fail("Forty project lists are saved. Remove archived items from an unused project first.", "capacity"); project = { scope, items: [] }; next.projects.push(project); }
    if (project.items.length + values.length > LIMIT.perProject || next.projects.reduce((sum, p) => sum + p.items.length, 0) + values.length > LIMIT.total) fail("The list is full. Remove unused archived records before adding more; files are never removed.", "capacity");
    result = values.map(value => ({ ...value, id: randomUUID(), revision: 1, read: false, archived: false, created: now, updated: now })); project.items.push(...result);
  } else {
    const item = project?.items.find(row => row.id === request.id); if (!item || item.revision !== request.expected) fail("This item changed or was removed in another view. Your form is retained; refresh the list.", "conflict");
    if (action === "edit") Object.assign(item, validateDeliverable(scope, request.value));
    else if (action === "read") { if (typeof request.value !== "boolean") fail("Choose read or unread."); item.read = request.value; }
    else if (action === "archive") { if (typeof request.value !== "boolean") fail("Choose archived or active."); item.archived = request.value; }
    else if (action === "remove") { if (!item.archived) fail("Archive an item before removing its record."); project.items = project.items.filter(row => row.id !== item.id); }
    else fail("Unknown delivery-list operation.");
    item.revision++; item.updated = now; result = [item];
  }
  next.projects = next.projects.filter(project => project.items.length); next.revision++;
  if (Buffer.byteLength(JSON.stringify(next)) > LIMIT.bytes) fail("Saved delivery lists are full. Existing records were retained.", "capacity");
  return { state: next, changed: result.map(item => ({ id: item.id, revision: item.revision })) };
}
export function deliverablePaths(home) { if (typeof home !== "string" || !path.isAbsolute(home) || /[\x00-\x1f\x7f]/.test(home)) fail("An absolute Herdr app home is required."); home = path.resolve(home); const data = path.join(home, "data"), folder = path.join(data, "workspace-deliverables"); return { home, data, folder, file: path.join(folder, "store.json"), lock: path.join(folder, "store.lock") }; }
function owned(info, directory) { return !info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile() && info.nlink === 1) && (typeof process.getuid !== "function" || info.uid === process.getuid()); }
async function boundary(paths, create = false) {
  for (const folder of [paths.home, paths.data, paths.folder]) {
    let info; try { info = await lstat(folder); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create || folder === paths.home) { if (folder === paths.home) fail("The Herdr app home must already exist as an owned directory.", "boundary"); return false; }
      try { await mkdir(folder, { mode: 0o700 }); } catch (made) { if (made.code !== "EEXIST") throw made; } info = await lstat(folder);
    }
    if (!owned(info, true)) fail("Delivery storage must use owned directories without symbolic links. No records were read or replaced.", "boundary");
  }
  return true;
}
async function readOwned(file, limit, missing = false) {
  let handle; try { const info = await lstat(file); if (!owned(info, false)) fail("Delivery storage must be a regular owned file without symbolic or hard links.", "boundary"); handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); const opened = await handle.stat(); if (!owned(opened, false) || info.ino !== opened.ino || info.dev !== opened.dev) fail("Delivery storage changed during the read. Retry.", "boundary"); if (opened.size > limit) fail("The saved list exceeds its storage limit.", "capacity");
    const chunks = []; let total = 0;
    while (true) { const buffer = Buffer.alloc(Math.min(65536, limit + 1 - total)), result = await handle.read(buffer, 0, buffer.length, null); if (!result.bytesRead) break; total += result.bytesRead; if (total > limit) fail("The saved list exceeds its storage limit.", "capacity"); chunks.push(buffer.subarray(0, result.bytesRead)); }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch (error) { if (missing && error.code === "ENOENT") return null; if (error.code === "ELOOP") fail("Symbolic links are not read as delivery storage.", "boundary"); throw error; } finally { await handle?.close(); }
}
async function load(paths) { if (!await boundary(paths)) return decodeDeliverables(null); return decodeDeliverables(await readOwned(paths.file, LIMIT.bytes, true)); }
async function clearDeadLock(paths) {
  // Recovery is serialized too, so two recoveries cannot unlink a new writer's lock.
  let guard; try { guard = await open(paths.lock + ".recovery", "wx", 0o600); } catch (error) { if (error.code === "EEXIST") return; throw error; }
  try { let pid; try { pid = Number(await readOwned(paths.lock, 64)); } catch (error) { if (error.code !== "ENOENT") throw error; } if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") await unlink(paths.lock).catch(() => {}); } } }
  finally { await guard.close(); await unlink(paths.lock + ".recovery").catch(() => {}); }
}
async function withLock(paths, callback) {
  await boundary(paths, true); let lock;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { lock = await open(paths.lock, "wx", 0o600); await lock.writeFile(String(process.pid)); break; }
    catch (error) { if (lock) { await lock.close(); await unlink(paths.lock).catch(() => {}); throw error; } if (error.code !== "EEXIST") throw error; await clearDeadLock(paths); await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  if (!lock) fail("The delivery list is busy. Retry after the other save completes.", "busy");
  try { return await callback(); } finally { await lock.close(); await unlink(paths.lock).catch(() => {}); }
}
export async function deliverableRequest(home, request) {
  const paths = deliverablePaths(home);
  deliverableView(decodeDeliverables(null), request); // Validate response options before any mutation can commit.
  if (request.action === "view") return deliverableView(await load(paths), request);
  if (request.action === "get") { const scope = deliverableScope(request.scope), store = await load(paths), item = itemFor(store, scope, request.id); if (!item || item.revision !== request.expected) fail("This item changed. Refresh before opening it.", "conflict"); return { item: { ...item, ...(item.kind === "file" ? { file: fileDeliverable(scope, item.location).file } : {}) }, scope }; }
  return withLock(paths, async () => { const current = await load(paths), changed = changeDeliverables(current, request), temporary = paths.file + ".tmp-" + randomUUID(); try { await writeFile(temporary, JSON.stringify(changed.state), { mode: 0o600, flag: "wx" }); await boundary(paths); const old = await lstat(paths.file).catch(error => { if (error.code !== "ENOENT") throw error; return null; }); if (old && !owned(old, false)) fail("Delivery storage changed to an unowned or linked file. No records were replaced.", "boundary"); await rename(temporary, paths.file); } finally { await unlink(temporary).catch(() => {}); } return { ...deliverableView(changed.state, request), changed: changed.changed }; });
}
