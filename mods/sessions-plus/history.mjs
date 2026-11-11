#!/usr/bin/env node
// Read-only local metadata reader. Run by Node, never imported by the GPUI runtime.
import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { UUID, sessionKey, cleanTitle, PROVIDERS } from "./model.js";

const MAX_FILES = 6000, MAX_ROWS = 500, MAX_READ = 256 * 1024, MAX_INDEX = 4 * 1024 * 1024;
const json = text => { try { return JSON.parse(text); } catch { return null; } };
const time = value => typeof value === "number" ? (value < 1e11 ? value * 1000 : value) : Date.parse(value) || 0;
const regular = path => { try { return lstatSync(path).isFile(); } catch { return false; } };
const stamp = path => { try { const s = statSync(path); return `${s.size}:${s.mtimeMs}:${s.ino}`; } catch { return "missing"; } };

function textFile(path, max = MAX_INDEX) {
  if (!regular(path) || statSync(path).size > max) return null;
  return readFileSync(path, "utf8");
}

function records(path, recentOnly = false) {
  if (!regular(path)) return [];
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size, result = [];
    const spans = size <= MAX_READ * 2 ? [[0, size]] : recentOnly ? [[size - MAX_READ * 2, MAX_READ * 2]] : [[0, MAX_READ], [size - MAX_READ, MAX_READ]];
    for (const [offset, length] of spans) {
      const buffer = Buffer.alloc(length), count = readSync(fd, buffer, 0, length, offset);
      let lines = buffer.subarray(0, count).toString("utf8").split("\n");
      if (offset) lines.shift();
      if (offset + length < size) lines.pop();
      result.push(...lines.map(json).filter(Boolean));
    }
    return result;
  } finally { closeSync(fd); }
}

function collect(root, accept, maxDepth, state) {
  const files = [];
  function walk(dir, depth) {
    if (state.visited >= MAX_FILES) { state.limited = true; return; }
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if (error.code !== "ENOENT") state.warnings.add("Some session folders could not be read."); return; }
    // Recent Codex date directories first. Never follow symlinks or agent artifact trees.
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      if (++state.visited > MAX_FILES) { state.limited = true; break; }
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < maxDepth && !["subagents", ".git", "node_modules"].includes(entry.name)) walk(path, depth + 1);
      else if (entry.isFile() && accept(entry.name)) {
        try { files.push({ path, updated: statSync(path).mtimeMs }); } catch { /* A writer removed it. */ }
      }
    }
  }
  walk(root, 0);
  files.sort((a, b) => b.updated - a.updated);
  if (files.length > MAX_ROWS) state.limited = true;
  return files.slice(0, MAX_ROWS);
}

function promptText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter(x => x?.type === "text" || x?.type === "input_text").map(x => x.text ?? "").join(" ");
  return "";
}

function claude(store, state) {
  return collect(join(store, "projects"), n => UUID.test(n.replace(/\.jsonl$/, "")) && n.endsWith(".jsonl"), 1, state).flatMap(file => {
    let cwd = "", title = "", first = "", auto = "", id = basename(file.path, ".jsonl"), sidechain = null;
    for (const record of records(file.path)) {
      if (typeof record.cwd === "string") cwd = record.cwd;
      if (record.isSidechain === true) sidechain = true;
      else if (record.isSidechain === false && sidechain === null) sidechain = false;
      if (record.type === "custom-title" && record.customTitle) title = record.customTitle;
      if (record.type === "ai-title" && record.aiTitle) auto = record.aiTitle;
      if (!auto && record.type === "summary") auto = record.summary;
      if (!first && record.type === "user" && !record.isMeta) first = promptText(record.message?.content);
    }
    if (!isAbsolute(cwd)) return [];
    return [{ provider: "claude", store, id, cwd, source: file.path, origin: sidechain === true ? "subagent" : sidechain === false ? "main" : "unknown", title: cleanTitle(title || auto || first) || `Claude ${id.slice(0, 8)}`, updated: file.updated }];
  });
}

export function codexOrigin(source) {
  if (["cli", "vscode", "exec", "app-server"].includes(source)) return "main";
  if (source && typeof source === "object" && Object.hasOwn(source, "subagent")) {
    const kind = source.subagent;
    if (kind === "review" || kind?.other === "guardian" || (kind && typeof kind === "object" && Object.hasOwn(kind, "review"))) return "review";
    return "subagent";
  }
  return "unknown";
}

function codex(store, state) {
  const titles = new Map();
  for (const line of (textFile(join(store, "session_index.jsonl")) ?? "").split("\n")) {
    const record = json(line);
    if (record && UUID.test(record.id) && record.thread_name) titles.set(record.id, cleanTitle(record.thread_name));
  }
  return collect(join(store, "sessions"), n => n.startsWith("rollout-") && n.endsWith(".jsonl"), 3, state).flatMap(file => {
    let id, cwd, origin = "unknown", first = "", title = "";
    for (const record of records(file.path)) {
      if (record.type === "session_meta") { id = record.payload?.id; cwd = record.payload?.cwd; origin = codexOrigin(record.payload?.source); }
      if (record.type === "event_msg" && record.payload?.type === "thread_name_updated") title = record.payload.thread_name ?? "";
      if (!first && record.type === "event_msg" && record.payload?.type === "user_message") first = record.payload.message ?? "";
    }
    if (!UUID.test(id ?? "") || typeof cwd !== "string" || !isAbsolute(cwd)) return [];
    return [{ provider: "codex", store, id, cwd, source: file.path, origin, title: cleanTitle(titles.get(id) || title || first) || `Codex ${id.slice(0, 8)}`, updated: file.updated }];
  });
}

// Copy the small summary database and its WAL to a private, disposable snapshot.
// SQLite may create sidecars in this snapshot, never beside the provider's database.
export function agySummaries(store, { temp = tmpdir(), sqlite = "/usr/bin/sqlite3" } = {}) {
  const source = join(store, "conversation_summaries.db");
  if (!regular(source)) return [];
  const scratch = mkdtempSync(join(temp, "herdr-sessions-read-"));
  try {
    const target = join(scratch, "summaries.db");
    let stable = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = [stamp(source), stamp(source + "-wal")];
      if (statSync(source).size > 32 * 1024 * 1024 || (existsSync(source + "-wal") && statSync(source + "-wal").size > 32 * 1024 * 1024)) throw new Error("Antigravity summary index exceeds the read limit.");
      copyFileSync(source, target); rmSync(target + "-wal", { force: true });
      if (regular(source + "-wal")) copyFileSync(source + "-wal", target + "-wal");
      if (before.join("|") === [stamp(source), stamp(source + "-wal")].join("|")) { stable = true; break; }
    }
    if (!stable) throw new Error("Antigravity is updating its session index. Refresh again shortly.");
    const query = "PRAGMA query_only=ON; SELECT conversation_id, title, workspace_uris, last_modified_time FROM conversation_summaries WHERE COALESCE(parent_conversation_id, '') = '' ORDER BY last_modified_time DESC LIMIT 501;";
    // A checkpointed WAL database may need fresh sidecars even for a read. The
    // disposable copy allows those; query_only rejects SQL writes to its tables.
    const result = spawnSync(sqlite, ["-json", target, query], { encoding: "utf8", timeout: 2500, maxBuffer: 4 * 1024 * 1024 });
    if (result.status !== 0) throw new Error("Could not read the Antigravity summary index (SQLite or schema unavailable).");
    const rows = json(result.stdout || "[]");
    if (!Array.isArray(rows)) throw new Error("Invalid Antigravity summary index.");
    return rows;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function agy(store, state, options) {
  const last = json(textFile(join(store, "cache", "last_conversations.json"))) ?? {};
  const paths = new Map();
  for (const [cwd, id] of Object.entries(last)) if (isAbsolute(cwd) && UUID.test(id)) paths.set(id, paths.has(id) && paths.get(id) !== cwd ? null : cwd);
  const summaries = agySummaries(store, options);
  if (summaries.length > MAX_ROWS) state.limited = true;
  return summaries.slice(0, MAX_ROWS).flatMap(row => {
    const id = row.conversation_id;
    if (!UUID.test(id ?? "") || !regular(join(store, "conversations", `${id}.db`))) return [];
    const uris = json(row.workspace_uris);
    const folders = Array.isArray(uris) ? uris.flatMap(uri => { try { return [uri.startsWith("file:") ? fileURLToPath(uri) : uri]; } catch { return []; } }).filter(p => typeof p === "string" && isAbsolute(p)) : [];
    const cwd = folders[0] || paths.get(id);
    if (!cwd) { state.warnings.add("Some Antigravity sessions have no saved working directory and were skipped."); return []; }
    return [{ provider: "agy", store, id, cwd, origin: "main", title: cleanTitle(row.title) || `${PROVIDERS.agy} ${id.slice(0, 8)}`, updated: time(row.last_modified_time) }];
  });
}

function executable(name, home) {
  for (const folder of [...(process.env.PATH ?? "").split(":"), join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) {
    if (!isAbsolute(folder)) continue;
    const file = join(folder, name);
    try { if (statSync(file).isFile()) { accessSync(file, constants.X_OK); return file; } } catch { /* Try the next PATH entry. */ }
  }
  return null;
}

export function scan(options = {}) {
  const home = options.home || homedir();
  const defaults = { claude: process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), codex: process.env.CODEX_HOME || join(home, ".codex"), agy: join(home, ".gemini", "antigravity-cli") };
  const stores = { ...defaults, ...options.stores }, warnings = new Set(), rows = [], tools = {};
  let limited = false;
  for (const [provider, reader] of Object.entries({ claude, codex, agy })) {
    const store = resolve(stores[provider]);
    const state = { warnings, visited: 0, limited: false };
    tools[provider] = executable(provider, home);
    try { rows.push(...reader(store, state, options).map(row => ({ ...row, key: sessionKey(row), defaultStore: store === resolve(defaults[provider]) }))); }
    catch { warnings.add(`${PROVIDERS[provider] ?? provider}: session history could not be read. Refresh to retry.`); }
    limited ||= state.limited;
  }
  const byKey = new Map();
  for (const row of rows) byKey.set(row.key, byKey.has(row.key) ? { ...row, ambiguous: true } : row);
  const unique = [...byKey.values()].sort((a, b) => b.updated - a.updated);
  return { rows: unique, tools, limited, warnings: [...warnings] };
}

export function validate(key, options = {}) {
  const data = scan(options), row = data.rows.find(row => row.key === key);
  if (!row) throw new Error("This session is no longer available. Refresh the list.");
  if (row.provider === "agy" && !row.defaultStore) throw new Error("Antigravity restore currently supports its default local data directory only.");
  if (!statSync(row.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error("The original working directory no longer exists.");
  const command = data.tools[row.provider];
  if (!command) throw new Error(`${PROVIDERS[row.provider] ?? row.provider} CLI is not installed or is not on PATH.`);
  return { row, command };
}

// Resolve one exact captured identity without accepting a source path or scanning other providers.
export function resolveSession(key, options = {}) {
  let identity;
  try { identity = JSON.parse(key); } catch { throw new Error("Invalid recorded session identity."); }
  if (!Array.isArray(identity) || identity.length !== 3 || !Object.hasOwn(PROVIDERS, identity[0]) || typeof identity[1] !== "string" || !isAbsolute(identity[1]) || !UUID.test(identity[2] || "")) throw new Error("An exact provider, store and session ID are required.");
  const [provider, store, id] = identity, home = options.home || homedir();
  const defaults = { claude: process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), codex: process.env.CODEX_HOME || join(home, ".codex"), agy: join(home, ".gemini", "antigravity-cli") };
  const configured = resolve(options.stores?.[provider] || defaults[provider]);
  if (resolve(store) !== store || store !== configured) throw new Error("The selected session store does not match its captured configuration.");
  if (provider === "agy") return { provider, store, id, key, title: "Antigravity", source: null };
  const state = { warnings: new Set(), visited: 0, limited: false };
  const files = collect(join(store, provider === "claude" ? "projects" : "sessions"), name => provider === "claude" ? name === id + ".jsonl" : name.startsWith("rollout-") && name.endsWith(id + ".jsonl"), provider === "claude" ? 1 : 3, state);
  if (state.limited || state.warnings.size) throw new Error("The session search reached its bounded limit or an unreadable folder. Its identity could not be verified.");
  if (files.length !== 1) throw new Error(files.length ? "This recorded session identity is ambiguous." : "This exact session is no longer available.");
  const source = files[0].path, sourceStamp = stamp(source), values = records(source);
  if (sourceStamp !== stamp(source)) throw new Error("The selected session changed while verifying its identity. Refresh before reading it.");
  const meta = provider === "codex" ? values.find(record => record.type === "session_meta")?.payload : null;
  if (provider === "codex" && meta?.id !== id || provider === "claude" && values.some(record => typeof record.sessionId === "string" && record.sessionId !== id)) throw new Error("The session file no longer matches its recorded identity.");
  const cwd = meta?.cwd || values.find(record => typeof record.cwd === "string")?.cwd;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("The session has no verified original working folder.");
  return { provider, store, id, key, source, sourceStamp, cwd, title: provider + " " + id.slice(0, 8), updated: files[0].updated };
}

// Only an explicit preview action reads message excerpts; nothing is indexed or written.
export function preview(key, options = {}) {
  const row = scan(options).rows.find(item => item.key === key);
  if (!row) throw new Error("This session is no longer available. Refresh the list.");
  if (row.ambiguous) throw new Error("This session identity is ambiguous. No message content was read.");
  const result = { row: { key: row.key, id: row.id, provider: row.provider, title: row.title, updated: row.updated }, messages: [], limited: false };
  if (row.provider === "agy") return { ...result, available: false, message: "Antigravity message preview is unavailable. Only its saved summary metadata is supported." };
  if (!regular(row.source) || !basename(row.source).endsWith(`${row.id}.jsonl`)) throw new Error("The session file no longer matches its identity.");
  const before = stamp(row.source), values = records(row.source, true), latest = {}, fallback = {};
  result.limited = statSync(row.source).size > MAX_READ * 2;
  const take = (target, role, content, record, index) => {
    if (!["user", "assistant"].includes(role)) return;
    const raw = typeof content === "string" ? content : Array.isArray(content) ? content.filter(part => ["text", "input_text", "output_text"].includes(part?.type)).map(part => part.text ?? "").join("\n") : "";
    const text = raw.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim();
    if (!text) return;
    target[role] = { role, text: text.slice(0, 6000), truncated: text.length > 6000, timestamp: time(record.timestamp) || null, index };
  };
  values.forEach((record, index) => {
    if (row.provider === "claude") {
      if (["user", "assistant"].includes(record.type) && !record.isMeta) take(latest, record.type, record.message?.content, record, index);
    } else {
      const payload = record.payload;
      if (record.type === "event_msg" && payload?.type === "user_message") take(latest, "user", payload.message, record, index);
      if (record.type === "event_msg" && payload?.type === "agent_message") take(latest, "assistant", payload.message, record, index);
      if (record.type === "response_item" && payload?.type === "message") take(fallback, payload.role, payload.content, record, index);
    }
  });
  if (before !== stamp(row.source)) throw new Error("This session changed while reading. Retry the preview.");
  result.messages = ["user", "assistant"].flatMap(role => latest[role] || fallback[role] ? [latest[role] || fallback[role]] : []).sort((a, b) => a.index - b.index).map(({ index, ...message }) => message);
  return { ...result, available: true, message: result.messages.length ? "" : "No readable user or assistant text was found in the recent history." };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = json(process.argv[3] ?? "{}") ?? {};
    const action = process.argv[2] || "scan";
    if (!["scan", "validate", "preview"].includes(action)) throw new Error("Unknown history action.");
    const result = action === "validate" ? validate(process.argv[4], options) : action === "preview" ? preview(process.argv[4], options) : scan(options);
    process.stdout.write(JSON.stringify(result));
  } catch (error) { process.stdout.write(JSON.stringify({ error: error.message })); process.exitCode = 1; }
}
