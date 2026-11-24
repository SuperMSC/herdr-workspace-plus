// Read-only probe for local agent terminals. Only this helper uses Node APIs.
import { constants, lstatSync, openSync, fstatSync, readSync, closeSync, opendirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { cleanTitle, UUID } from "./model.js";
import { promptText } from "./history.mjs";
import { claudeWindow, LIVE_LIMITS } from "./live-model.js";

const HEAD = 256 * 1024, TAIL = HEAD * 2, CLAUDE_RETRY = TAIL * 4;
const CODEX_HEAD_PROBE = 16 * 1024;
const MAX_ENTRIES = 6000, MAX_PID_FILE = 16 * 1024;
const LIMIT = Symbol("live read limit");
const json = line => { try { return JSON.parse(line); } catch { return null; } };
const safeCount = value => Number.isSafeInteger(value) && value >= 0;
const time = value => typeof value === "number" ? value : Date.parse(value);
const stamp = (path, stat) => ({ path, size: stat.size, mtime: stat.mtimeMs });
const sameStamp = (a, b) => Boolean(a && b && a.path === b.path && a.size === b.size && a.mtime === b.mtime);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const codexID = values => values.find(record => record.type === "session_meta")?.payload?.id;

function safePath(path, directory = false) {
  // Check all components, including the configured store's parents.
  const root = parse(path).root, parts = path.slice(root.length).split(sep).filter(Boolean);
  let current = root, stat = lstatSync(root);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    stat = lstatSync(current);
    const isDirectory = directory || index < parts.length - 1;
    if (isDirectory ? !stat.isDirectory() : !stat.isFile()) return null;
  }
  return stat;
}

function processStart(pid, remaining) {
  const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    env: { ...process.env, TZ: "UTC", LC_ALL: "C" }, encoding: "utf8", timeout: Math.min(500, Math.ceil(remaining)), maxBuffer: 1024,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function records(buffer, { cutStart = false, cutEnd = false } = {}) {
  const lines = buffer.toString("utf8").split("\n");
  if (cutStart) lines.shift();
  if (cutEnd) lines.pop();
  return lines.map(json).filter(record => record && typeof record === "object");
}

function claudeContext(values, id) {
  for (let index = values.length - 1; index >= 0; index--) {
    const record = values[index];
    if (record.type !== "assistant" || record.isSidechain === true || record.sessionId && record.sessionId !== id) continue;
    const message = record.message, usage = message?.usage, model = cleanTitle(message?.model), asOf = time(record.timestamp);
    const cached = usage?.cache_read_input_tokens ?? 0, created = usage?.cache_creation_input_tokens ?? 0;
    if (![usage?.input_tokens, cached, created].every(safeCount) || !model || model === "<synthetic>" || !Number.isFinite(asOf)) continue;
    const used = usage.input_tokens + cached + created;
    if (safeCount(used)) return { used, window: claudeWindow(model), model, asOf };
  }
  return null;
}

function codexContext(values) {
  let model = "", context = null;
  for (const record of values) {
    const payload = record.payload;
    if (record.type === "turn_context") model = cleanTitle(payload?.model);
    if (record.type !== "event_msg" || payload?.type !== "token_count") continue;
    const usage = payload.info?.last_token_usage, window = payload.info?.model_context_window, asOf = time(record.timestamp);
    const used = usage?.total_tokens ?? (safeCount(usage?.input_tokens) && safeCount(usage?.output_tokens) ? usage.input_tokens + usage.output_tokens : null);
    if (safeCount(used) && Number.isFinite(asOf)) context = { used, window: safeCount(window) && window > 0 ? window : null, model, asOf };
  }
  return context;
}

function sessionTitle(provider, values) {
  let first = "", title = "", auto = "";
  for (const record of values) {
    if (provider === "claude") {
      if (record.isSidechain === true) continue;
      if (record.type === "custom-title" && record.customTitle) title = record.customTitle;
      if (record.type === "ai-title" && record.aiTitle) auto = record.aiTitle;
      if (!first && record.type === "user" && !record.isMeta) first = promptText(record.message?.content);
    } else if (record.type === "event_msg") {
      if (record.payload?.type === "thread_name_updated") title = record.payload.thread_name;
      if (!first && record.payload?.type === "user_message") first = promptText(record.payload.message);
    }
  }
  return cleanTitle(title || auto || first) || null;
}

export function readLive(request, { home = homedir() } = {}) {
  const deadline = performance.now() + LIVE_LIMITS.deadline;
  const results = {}, stores = new Map(), starts = new Map();
  let bytes = 0;
  const check = () => { if (performance.now() >= deadline) throw LIMIT; };
  const read = (fd, size, position) => {
    check();
    if (size > LIVE_LIMITS.bytes - bytes) throw LIMIT;
    const buffer = Buffer.alloc(size), count = readSync(fd, buffer, 0, size, position);
    bytes += count;
    check();
    if (count !== size) throw new Error("Session file changed while reading.");
    return buffer;
  };
  const file = (path, readFile, { appendOnly = false } = {}) => {
    const before = safePath(path);
    if (!before) return null;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd), current = safePath(path);
      if (!stat.isFile() || !current || !sameFile(stat, current) || !sameFile(stat, before)) return null;
      const value = readFile(fd, stat), after = safePath(path);
      if (!after || !sameFile(stat, after)) return null;
      const valid = appendOnly ? after.size >= stat.size : sameStamp(stamp(path, stat), stamp(path, after));
      return valid ? value : null;
    } finally { closeSync(fd); }
  };

  function locate(store, provider) {
    const key = JSON.stringify([store, provider]);
    if (stores.has(key)) return stores.get(key);
    const files = new Map();
    let visited = 0;
    function walk(dir, remaining) {
      check();
      if (!safePath(dir, true)) return;
      const entries = opendirSync(dir);
      try {
        for (let entry; (entry = entries.readSync());) {
          check();
          if (++visited > MAX_ENTRIES) throw LIMIT;
          const path = join(dir, entry.name);
          if (entry.isDirectory() && remaining && !["subagents", ".git", "node_modules"].includes(entry.name)) walk(path, remaining - 1);
          else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            const id = provider === "claude" ? entry.name.slice(0, -6)
              : entry.name.startsWith("rollout-") && entry.name.at(-43) === "-" ? entry.name.slice(-42, -6) : "";
            if (UUID.test(id)) files.set(id, files.has(id) ? null : path);
          }
        }
      } finally { entries.closeSync(); }
    }
    try { walk(join(store, provider === "claude" ? "projects" : "sessions"), provider === "claude" ? 1 : 3); }
    catch (error) {
      if (error === LIMIT) { stores.set(key, null); throw error; }
      if (error.code !== "ENOENT") files.clear();
    }
    stores.set(key, files);
    return files;
  }

  for (const agent of Array.isArray(request) ? request.slice(0, LIVE_LIMITS.agents) : []) {
    if (performance.now() >= deadline) break;
    const { key, provider, pid, argvId, prev } = agent ?? {};
    if (typeof key !== "string" || !/^[^/\s]{1,200}@\d+$/.test(key) || !["claude", "codex"].includes(provider) || !Number.isSafeInteger(pid) || pid <= 0) continue;
    const requested = agent.store ?? (provider === "claude" ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME) ?? join(home, "." + provider);
    if (typeof requested !== "string" || !isAbsolute(requested) || requested.length > 1024) continue;
    const store = resolve(requested);
    try { if (!safePath(store, true)) continue; } catch { continue; }
    let id = argvId, pidFile, pidStamp, name;
    if (provider === "claude") {
      pidFile = join(store, "sessions", pid + ".json");
      let session;
      try {
        session = file(pidFile, (fd, stat) => stat.size <= MAX_PID_FILE ? { data: json(read(fd, stat.size, 0)), stamp: stamp(pidFile, stat) } : null);
        check();
        if (!session?.data || session.data.pid !== pid || session.data.kind !== "interactive" || typeof session.data.sessionId !== "string" ||
          !UUID.test(session.data.sessionId) || typeof session.data.procStart !== "string") continue;
        if (!starts.has(pid)) starts.set(pid, processStart(pid, deadline - performance.now()));
      } catch { continue; }
      const started = starts.get(pid);
      if (!started || started !== session.data.procStart.trim()) continue;
      id = session.data.sessionId;
      const { name: pidName, nameSource } = session.data;
      if (typeof pidName === "string" && typeof nameSource === "string" && nameSource !== "derived") name = cleanTitle(pidName);
      pidStamp = session.stamp;
    } else if (typeof id !== "string" || !UUID.test(id)) continue;
    const value = { provider, id, store, pid, title: name || null, context: null };
    let reading;
    try {
      const paths = locate(store, provider);
      if (!paths) throw LIMIT;
      const path = paths.get(id);
      if (path) reading = file(path, (fd, stat) => {
        const info = stamp(path, stat);
        if (sameStamp(info, prev)) {
          if (provider === "codex") {
            const headID = size => codexID(records(read(fd, size, 0), { cutEnd: size < stat.size }));
            const size = Math.min(CODEX_HEAD_PROBE, stat.size);
            const found = headID(size) ?? (size < stat.size ? headID(Math.min(HEAD, stat.size)) : null);
            if (found !== id) return null;
          }
          return { stamp: info, unchanged: true };
        }
        // The transcript may still be growing. Use one verified descriptor and snapshot size.
        const tailRecords = limit => {
          const offset = Math.max(0, stat.size - limit);
          return records(read(fd, stat.size - offset, offset), { cutStart: offset > 0 });
        };
        let tailSize = TAIL, tail = tailRecords(tailSize);
        let context = provider === "claude" ? claudeContext(tail, id) : codexContext(tail);
        if (provider === "claude" && !context && stat.size > tailSize) {
          tailSize = CLAUDE_RETRY;
          tail = tailRecords(tailSize);
          context = claudeContext(tail, id);
        }
        const headSize = Math.min(HEAD, Math.max(0, stat.size - tailSize));
        const head = headSize ? records(read(fd, headSize, 0), { cutEnd: true }) : [];
        const values = [...head, ...tail];
        if (provider === "codex") {
          if (codexID(values) !== id) return null;
        } else if (values.some(record => !record.isSidechain && typeof record.sessionId === "string" && record.sessionId !== id)) return null;
        return { stamp: info, context, transcriptTitle: sessionTitle(provider, values) };
      }, { appendOnly: true });
    } catch (error) {
      if (error === LIMIT) value.deferred = true;
    }
    if (provider === "codex" && !reading) continue;
    if (pidFile) {
      try { if (!sameStamp(pidStamp, stamp(pidFile, safePath(pidFile)))) continue; } catch { continue; }
    }
    results[key] = { ...value, ...reading, title: name || reading?.transcriptTitle || null };
  }
  return results;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.stdout.write(JSON.stringify(readLive(json(process.argv[2] ?? "[]"))));
}
