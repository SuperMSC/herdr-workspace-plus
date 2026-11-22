#!/usr/bin/env node
// Read-only usage reader for local Claude Code and Codex logs. Run by Node, never imported by the GPUI runtime.
// Appended log files are read from where the previous run stopped; the private cache under
// <Herdr home>/data/usage-stats keeps only token counts, model names, times, session IDs and folders.
// Session titles are read fresh from the history reader and never cached.
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PROVIDERS } from "./model.js";
import { claudeRecord, codexRecord, freshState, retentionStart, summarize } from "./usage-model.js";
import { PRICING_DATE } from "./usage-pricing.js";
import { scan } from "./history.mjs";

const VERSION = 1, MAX_ENTRIES = 40000, CHUNK = 8 * 1024 * 1024, BUDGET = 40000, MAX_CACHE = 64 * 1024 * 1024;
const json = text => { try { return JSON.parse(text); } catch { return null; } };
// Only these records are parsed; every other line is skipped unread.
const NEEDLES = {
  claude: ['"type":"assistant"'],
  codex: ['"type":"session_meta"', '"type":"turn_context"', '"type":"token_usage_record"', '"type":"token_count"', '"type":"thread_settings_applied"'],
};

/** Log files that may hold events at or after `since`, newest first. Never follows symbolic links. */
export function discover(provider, store, since, state) {
  const root = join(store, provider === "claude" ? "projects" : "sessions"), files = [];
  const accept = name => provider === "claude" ? name.endsWith(".jsonl") : name.startsWith("rollout-") && name.endsWith(".jsonl");
  const cutoff = new Date(since);
  const tooOld = (depth, name) => {
    // Codex dates its folders: skip years, months and days before the retention start.
    if (provider !== "codex" || !/^\d+$/.test(name)) return false;
    const n = Number(name);
    if (depth === 0) return n < cutoff.getFullYear();
    return false;
  };
  function walk(dir, depth, parts) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if (error.code !== "ENOENT") state.warnings.add(`${PROVIDERS[provider]}: some log folders could not be read.`); return; }
    for (const entry of entries) {
      if (++state.visited > MAX_ENTRIES) { state.limited = true; return; }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth >= 3 || [".git", "node_modules"].includes(entry.name) || tooOld(depth, entry.name)) continue;
        if (provider === "codex" && depth === 1 && /^\d+$/.test(entry.name) && /^\d+$/.test(parts[0] ?? "")) {
          const month = new Date(Number(parts[0]), Number(entry.name), 1); if (+month <= since) continue;
        }
        walk(path, depth + 1, [...parts, entry.name]);
      } else if (entry.isFile() && accept(entry.name)) {
        try { const info = lstatSync(path); if (info.mtimeMs >= since) files.push({ path, provider, store, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino }); } catch { /* A writer removed it. */ }
      }
    }
  }
  walk(root, 0, []);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Read whole lines from `offset`; returns the offset after the last complete line. */
export function readFrom(file, entry, deadline) {
  const fd = openSync(file.path, "r");
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.ino !== file.ino) throw new Error("changed");
    let offset = entry.offset, leftover = "";
    const state = entry.state, needles = NEEDLES[file.provider], reader = file.provider === "claude" ? claudeRecord : codexRecord;
    const buffer = Buffer.alloc(Math.min(CHUNK, Math.max(1, info.size - offset)));
    let position = offset;
    while (position < info.size) {
      if (Date.now() > deadline) return { offset, complete: false };
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, info.size - position), position);
      if (!count) break;
      position += count;
      const lines = (leftover + buffer.subarray(0, count).toString("utf8")).split("\n");
      leftover = lines.pop();
      const keys = needles;
      for (const line of lines) {
        offset += Buffer.byteLength(line, "utf8") + 1;
        if (!line || !keys.some(key => line.includes(key))) continue;
        const record = json(line);
        if (record) reader(record, state);
      }
    }
    return { offset, complete: true };
  } finally { closeSync(fd); }
}

function cacheDir(appHome) {
  if (typeof appHome !== "string" || !isAbsolute(appHome)) return null;
  let dir = resolve(appHome);
  for (const part of ["data", "usage-stats"]) {
    dir = join(dir, part);
    try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") return null; }
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) return null;
  }
  return dir;
}
function loadCache(dir) {
  if (!dir) return {};
  try {
    const path = join(dir, `cache-v${VERSION}.json`), info = lstatSync(path);
    if (!info.isFile() || info.size > MAX_CACHE) return {};
    const data = json(readFileSync(path, "utf8"));
    return data?.version === VERSION && data.files && typeof data.files === "object" ? data.files : {};
  } catch { return {}; }
}
function saveCache(dir, files) {
  if (!dir) return;
  const target = join(dir, `cache-v${VERSION}.json`), pending = join(dir, `.cache-${process.pid}-${Date.now()}.tmp`);
  try { writeFileSync(pending, JSON.stringify({ version: VERSION, files }), { mode: 0o600, flag: "wx" }); renameSync(pending, target); }
  catch { rmSync(pending, { force: true }); }
}

/** The nearest enclosing folder with a .git entry, else the folder itself. Read-only lstat calls. */
export function projectRoots() {
  const known = new Map();
  return cwd => {
    if (!cwd || !isAbsolute(cwd)) return cwd;
    if (known.has(cwd)) return known.get(cwd);
    let dir = cwd, root = cwd;
    for (let depth = 0; depth < 12 && dir !== "/"; depth++) {
      try { lstatSync(join(dir, ".git")); root = dir; break; } catch { /* Keep looking upward. */ }
      dir = dirname(dir);
    }
    known.set(cwd, root); return root;
  };
}

export function collectUsage(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now(), home = options.home || homedir();
  const defaults = { claude: process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), codex: process.env.CODEX_HOME || join(home, ".codex"), agy: join(home, ".gemini", "antigravity-cli") };
  const stores = { ...defaults, ...(options.stores ?? {}) }, since = retentionStart(now), deadline = Date.now() + (options.budget ?? BUDGET);
  const state = { warnings: new Set(), visited: 0, limited: false };
  const dir = options.cache === false ? null : cacheDir(options.appHome);
  const cached = loadCache(dir), next = {}, files = [];
  for (const provider of ["claude", "codex"]) {
    const store = resolve(stores[provider]);
    for (const file of discover(provider, store, since, state)) {
      const prior = cached[file.path];
      let entry = prior && prior.provider === provider && prior.ino === file.ino && prior.offset <= file.size ? prior : { provider, store, ino: file.ino, offset: 0, state: freshState() };
      if (!(entry.size === file.size && entry.mtimeMs === file.mtimeMs)) {
        if (Date.now() > deadline) state.limited = true;
        else {
          try {
            const result = readFrom(file, entry, deadline);
            entry = { ...entry, offset: result.offset, size: result.complete ? file.size : -1, mtimeMs: file.mtimeMs };
            if (!result.complete) state.limited = true;
          } catch { state.warnings.add(`${PROVIDERS[provider]}: a log changed while it was read. Refresh to retry.`); entry = null; }
        }
      }
      if (!entry) continue;
      entry.state.events = entry.state.events.filter(event => event.t >= since);
      next[file.path] = entry;
      files.push({ provider, store, events: entry.state.events, meta: { sessionId: entry.state.sessionId, cwd: entry.state.cwd, origin: entry.state.origin } });
    }
  }
  saveCache(dir, next);
  const titles = new Map();
  try { for (const row of scan({ home, stores }).rows) titles.set(`${row.provider}:${row.id}`, row.title); }
  catch { state.warnings.add("Session titles could not be read; sessions are shown by ID."); }
  if (state.limited) state.warnings.add("Partial read: the time or file limit was reached. Refresh to continue from where it stopped.");
  return { ...summarize(files, { now, limited: state.limited, warnings: [...state.warnings], projectOf: projectRoots(), titles }), pricingDate: PRICING_DATE, cached: Boolean(dir) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(JSON.stringify(collectUsage(json(process.argv[2] || "{}") ?? {}))); }
  catch (error) { process.stdout.write(JSON.stringify({ error: String(error.message || error) })); process.exitCode = 1; }
}
