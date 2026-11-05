#!/usr/bin/env node
// Recoverable, local session moves. Provider indexes and conversation contents are never edited.
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { scan } from "./history.mjs";
import { UUID, PROVIDERS, sessionKey } from "./model.js";

const PREFIX = "herdr-session-", MAX_ITEMS = 20000;
// Adapted from Files Plus's filesystem.js (Apache-2.0; see LICENSE and NOTICE).
// Nil Foundation out-pointers avoid the JXA Ref wrapping crash. renamex_np with
// RENAME_EXCL refuses an existing destination atomically, including symlinks.
const NATIVE_SCRIPT = String.raw`
ObjC.import("Foundation");
function run(argv) {
  try {
    if (argv[0] === "move") {
      ObjC.bindFunction("renamex_np", ["int", ["char *", "char *", "unsigned int"]]);
      if ($.renamex_np(argv[1], argv[2], 4) !== 0) throw new Error("Exclusive move failed.");
    } else if (argv[0] === "trash") {
      if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[1]), $(), $())) throw new Error("Native Trash failed.");
    } else throw new Error("Unknown filesystem action.");
    return JSON.stringify({ok:true});
  } catch (_) { return JSON.stringify({ok:false}); }
}`;

function native(action, ...paths) {
  const result = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", NATIVE_SCRIPT, action, ...paths], { encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
  let data;
  try { data = JSON.parse(result.stdout); } catch { /* Report a stable error below. */ }
  if (result.status !== 0 || !data?.ok) throw new Error(action === "trash" ? "Could not move the recovery bundle to macOS Trash." : "Could not move a session item without overwriting another item.");
}

export const nativeTrash = path => native("trash", path);
export const exclusiveMove = (source, target) => native("move", source, target);
const stat = path => { try { return lstatSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };

function absolute(path) {
  if (typeof path !== "string" || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path) || path.split(sep).some(p => p === "." || p === "..")) throw new Error("An absolute local directory without dot components is required.");
  return resolve(path);
}

function guarded(path, { missing = false, directory = false } = {}) {
  const value = absolute(path), components = value.split(sep).filter(Boolean);
  let current = sep, found;
  for (let i = 0; i < components.length; i++) {
    current = join(current, components[i]); found = stat(current);
    if (!found) { if (missing) return null; throw new Error("A required session path no longer exists."); }
    if (found.isSymbolicLink()) throw new Error("Session Trash does not follow symbolic links.");
    if (i < components.length - 1 && !found.isDirectory()) throw new Error("A session parent is not a directory.");
  }
  if (directory && !found?.isDirectory()) throw new Error("A required session directory is unavailable.");
  return found;
}

function privateDirectory(path) {
  if (!guarded(path, { missing: true })) { mkdirSync(path, { recursive: true, mode: 0o700 }); }
  const value = guarded(path, { directory: true });
  if (value.uid !== process.getuid?.() || (value.mode & 0o077)) throw new Error("Session Trash requires a private state directory owned by your account.");
}

function setup(options) {
  if (process.platform !== "darwin") throw new Error("Session Trash currently requires local macOS.");
  const home = absolute(options.home || homedir()), stateDir = absolute(options.stateDir || join(home, ".config", "herdr-app", "session-trash"));
  if (home === stateDir || stateDir === sep) throw new Error("Choose a dedicated Session Trash state directory.");
  const device = guarded(home, { directory: true }).dev;
  privateDirectory(stateDir);
  if (guarded(stateDir, { directory: true }).dev !== device) throw new Error("Session Trash state must be on the same volume as your home folder.");
  for (const name of ["entries", "staging"]) privateDirectory(join(stateDir, name));
  guarded(join(home, ".Trash"), { missing: true, directory: true });
  const defaults = { claude: process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), codex: process.env.CODEX_HOME || join(home, ".codex"), agy: join(home, ".gemini", "antigravity-cli") };
  const stores = Object.fromEntries(Object.keys(PROVIDERS).map(provider => [provider, absolute(options.stores?.[provider] || defaults[provider])]));
  return { ...options, home, stateDir, device, stores };
}

function locked(options, task) {
  const config = setup(options), lock = join(config.stateDir, "lock");
  guarded(lock, { missing: true });
  const fd = openSync(lock, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.dev !== config.device) throw new Error("Session Trash has an invalid operation lock.");
    // flock belongs to the shared open file description: after JXA exits the
    // parent FD retains it, and closing that FD (also on SIGKILL) releases it.
    // Never unlink this permanent inode; stale-PID reclamation has a race.
    const script = 'ObjC.import("Foundation"); ObjC.bindFunction("flock", ["int", ["int", "int"]]); function run(){return JSON.stringify({result:$.flock(3,6)});}';
    const result = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf8", timeout: 10000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe", fd] });
    let data;
    try { data = JSON.parse(result.stdout); } catch { /* Fail closed below. */ }
    if (result.status !== 0 || data?.result !== 0) throw new Error("Another Session Trash operation is in progress, or its native lock is unavailable.");
    return task(config);
  } finally { closeSync(fd); }
}

function inside(root, path) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel)) throw new Error("A session item is outside its configured data directory.");
  return rel;
}

function walk(root, accept, maxDepth) {
  const matches = []; let visited = 0;
  function visit(folder, depth) {
    guarded(folder, { directory: true });
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      if (++visited > MAX_ITEMS) throw new Error("The session directory is too large to validate safely.");
      const path = join(folder, item.name);
      if (accept(item.name)) { guarded(path); if (item.isFile()) matches.push(path); }
      else if (item.isDirectory() && depth < maxDepth && item.name !== "subagents") visit(path, depth + 1);
    }
  }
  visit(root, 0);
  return matches;
}

function fingerprint(path, device) {
  const records = [];
  function visit(item, rel) {
    const value = guarded(item);
    if (value.dev !== device) throw new Error("Session Trash supports only the same volume as your home folder.");
    if (!value.isFile() && !value.isDirectory()) throw new Error("Session Trash supports only regular files and directories.");
    if (records.length >= MAX_ITEMS) throw new Error("This session has too many attachments to validate safely.");
    records.push({ path: rel, dev: value.dev, ino: value.ino, size: value.size, modified: value.mtimeMs, directory: value.isDirectory() });
    if (value.isDirectory()) for (const name of readdirSync(item).sort()) visit(join(item, name), rel ? join(rel, name) : name);
  }
  visit(path, "");
  return records;
}

function unchanged(path, saved, device) {
  if (JSON.stringify(fingerprint(path, device)) !== JSON.stringify(saved)) throw new Error("The session changed during this operation. Close its agent and retry.");
}

function missingSession() {
  return Object.assign(new Error("This session is no longer available. Refresh the list."), { code: "SESSION_MISSING" });
}

function plan(key, config) {
  let identity;
  try { identity = JSON.parse(key); } catch { throw new Error("Invalid session identity."); }
  if (!Array.isArray(identity) || identity.length !== 3 || !Object.hasOwn(PROVIDERS, identity[0]) || !UUID.test(identity[2]) || identity[1] !== config.stores[identity[0]]) throw new Error("Invalid session identity or data directory.");
  const [provider, store, id] = identity;
  const storeInfo = guarded(store, { directory: true, missing: true });
  if (!storeInfo) throw missingSession();
  if (storeInfo.dev !== config.device) throw new Error("Session Trash supports only data on the same volume as your home folder.");
  const history = join(store, provider === "claude" ? "projects" : provider === "codex" ? "sessions" : "conversations");
  if (!guarded(history, { directory: true, missing: true })) throw missingSession();
  let candidates;
  if (provider === "claude") candidates = walk(join(store, "projects"), name => name === `${id}.jsonl`, 1);
  else if (provider === "codex") candidates = walk(join(store, "sessions"), name => name.startsWith("rollout-") && name.endsWith(`-${id}.jsonl`), 3);
  else candidates = [join(store, "conversations", `${id}.db`)];
  if (!candidates.length) throw missingSession();
  if (candidates.length !== 1) throw new Error("More than one file matches this session. No files were moved.");
  const source = candidates[0];
  const sourceInfo = guarded(source, { missing: true });
  if (!sourceInfo) throw missingSession();
  if (!sourceInfo.isFile()) throw new Error("The session file is unavailable.");
  const data = scan(config), row = data.rows.find(item => item.key === key);
  if (!row) throw new Error("This session is no longer available. Refresh the list.");
  if (row.ambiguous || (provider !== "agy" && row.source !== source)) throw new Error("Session metadata does not uniquely match its file. No files were moved.");
  const paths = [source];
  const optional = provider === "claude" ? [join(dirname(source), id)] : provider === "agy" ? [source + "-wal", source + "-shm", join(store, "brain", id)] : [];
  for (const path of optional) if (guarded(path, { missing: true })) paths.push(path);
  const files = paths.map(path => inside(store, path)), snapshots = paths.map(path => fingerprint(path, config.device));
  if (files.some(file => !validFile(provider, id, file))) throw new Error("The session file layout is unsupported. No files were moved.");
  return { row, files, snapshots };
}

/** Inspect executable identity and a Node/Bun entry script, never arbitrary argument text. */
export function providerProcess(provider, command, args = "") {
  const name = basename(command).toLowerCase();
  if (name === provider || name === provider + ".exe") return true;
  if (provider === "claude" && /\/claude\/versions\/\d[^/]*$/.test(command)) return true;
  if (provider !== "agy" && new RegExp(`/${provider}\\.app/Contents/`, "i").test(command)) return true;
  if (provider === "agy" && ["antigravity", "antigravity-cli"].includes(name)) return true;
  if (!["node", "nodejs", "bun"].includes(name)) return false;
  const words = args.match(/"[^"\n]*"|'[^'\n]*'|\S+/g)?.map(value => value.replace(/^(['"])(.*)\1$/, "$2")) || [];
  if (!words.length) return false;
  if (basename(words[0]).toLowerCase() === provider) return true;
  if (!["node", "nodejs", "bun"].includes(basename(words.shift()).toLowerCase())) return false;
  while (words[0]?.startsWith("-")) {
    const option = words.shift();
    if (["-e", "--eval", "-p", "--print", "-r", "--require", "--import", "--loader"].includes(option) || /^(?:--eval|--print|--require|--import|--loader)=/.test(option)) return false;
  }
  const script = words[0] || "", entry = basename(script).toLowerCase();
  if ([provider, `${provider}.js`, `${provider}.mjs`, `${provider}.cjs`].includes(entry)) return true;
  if (provider === "claude") return /\/node_modules\/@anthropic-ai\/claude-code\/(?:cli|index)\.(?:m?js|cjs)$/.test(script);
  if (provider === "codex") return /\/node_modules\/@openai\/codex\/bin\/codex\.js$/.test(script);
  return /\/(?:antigravity-cli|@google\/antigravity)\/(?:dist\/|bin\/)?(?:index|cli|main)\.(?:m?js|cjs)$/.test(script);
}

/** Match an explicit session identity, not other conversations using the same CLI. */
export function sessionProcess(row, command, args = "", pid) {
  if (!providerProcess(row.provider, command, args) || !UUID.test(row.id ?? "")) return false;
  const words = args.match(/"[^"\n]*"|'[^'\n]*'|\S+/g)?.map(value => value.replace(/^(['"])(.*)\1$/, "$2")) || [];
  const flags = row.provider === "codex" ? ["resume"] : row.provider === "agy" ? ["--conversation"] : ["--resume", "-r", "--session-id"];
  for (let index = 0; index < words.length; index++) {
    const [flag, inline] = words[index].split("=", 2);
    if (flags.includes(flag) && (inline ?? words[index + 1]) === row.id) return true;
  }
  // Claude also publishes the session of a freshly started CLI under its PID.
  if (row.provider === "claude" && row.store && Number.isSafeInteger(pid) && pid > 0) {
    const path = join(row.store, "sessions", `${pid}.json`), info = guarded(path, { missing: true });
    if (info) {
      if (!info.isFile() || info.size > 65536) throw new Error("Could not validate the active Claude session record.");
      let current;
      try { current = JSON.parse(readFileSync(path, "utf8")); }
      catch { throw new Error("Could not read the active Claude session record. Retry shortly."); }
      if (current.sessionId === row.id) return true;
    }
  }
  return false;
}

/** Reject the selected session's process or open files, including restored payloads. */
export function checkInactive(row, paths, snapshots, { run = spawnSync } = {}) {
  const processes = run("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  const argumentsList = run("/bin/ps", ["-axo", "pid=,args="], { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  if (processes.status !== 0 || argumentsList.status !== 0) throw new Error("Could not verify that the agent is stopped. Close its CLI and desktop app, then retry.");
  const argumentsByPid = new Map(argumentsList.stdout.split("\n").flatMap(line => { const match = /^\s*(\d+)\s+(.*)$/.exec(line); return match ? [[match[1], match[2]]] : []; }));
  for (const line of processes.stdout.split("\n")) {
    const found = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (found && Number(found[1]) !== process.pid && sessionProcess(row, found[2], argumentsByPid.get(found[1]), Number(found[1]))) throw new Error("This session is still running. Close its agent before moving or restoring it.");
  }
  const all = paths.flatMap((path, index) => snapshots[index].map(item => item.path ? join(path, item.path) : path));
  for (let index = 0; index < all.length; index += 128) {
    const result = run("/usr/sbin/lsof", ["-Fpn", "--", ...all.slice(index, index + 128)], { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
    // lsof can return 1 when only some requested paths are open; matching
    // process records still prove that the session is in use.
    if (/^p\d+/m.test(result.stdout || "")) throw new Error("This session is in use. Close its agent and retry.");
    if (result.status !== 1 || result.stdout.trim() || result.stderr.trim()) throw new Error("Could not verify that the session is closed. No files were moved.");
  }
}

function journalPath(config, token) { return join(config.stateDir, "entries", `${token}.json`); }
function stagePath(config, token) { return join(config.stateDir, "staging", PREFIX + token); }
function trashPath(config, token) { return join(config.home, ".Trash", PREFIX + token); }

function save(config, entry) {
  const target = journalPath(config, entry.token), existing = guarded(target, { missing: true });
  if (existing && !existing.isFile()) throw new Error("The Session Trash journal is invalid.");
  const temporary = target + "." + randomUUID() + ".tmp", fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(entry)); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, target); } finally { if (stat(temporary)) unlinkSync(temporary); }
}

function validFile(provider, id, rel) {
  if (typeof rel !== "string" || isAbsolute(rel) || /[\x00-\x1f\x7f\\]/.test(rel) || rel.split("/").some(p => !p || p === "." || p === "..")) return false;
  if (provider === "claude") return rel.startsWith("projects/") && rel.split("/").length === 3 && [id, id + ".jsonl"].includes(basename(rel));
  if (provider === "codex") return rel.startsWith("sessions/") && rel.split("/").length <= 5 && basename(rel).startsWith("rollout-") && basename(rel).endsWith(`-${id}.jsonl`);
  return [`conversations/${id}.db`, `conversations/${id}.db-wal`, `conversations/${id}.db-shm`, `brain/${id}`].includes(rel);
}

function readEntry(config, token) {
  if (typeof token !== "string" || !UUID.test(token)) throw new Error("Invalid recovery token.");
  const path = journalPath(config, token), info = guarded(path);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error("The Session Trash journal is invalid.");
  let entry;
  try { entry = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("The Session Trash journal is invalid."); }
  if (entry?.version !== 1 || entry.token !== token || !Object.hasOwn(PROVIDERS, entry.provider) || !UUID.test(entry.id ?? "") || entry.store !== config.stores[entry.provider] || entry.key !== sessionKey(entry) || !Array.isArray(entry.files) || !entry.files.length || entry.files.length > 4 || new Set(entry.files).size !== entry.files.length || entry.files.some(path => !validFile(entry.provider, entry.id, path)) || !Array.isArray(entry.snapshots) || entry.snapshots.length !== entry.files.length) throw new Error("The Session Trash journal does not match the configured session store.");
  for (const records of entry.snapshots) {
    if (!Array.isArray(records) || !records.length || records.length > MAX_ITEMS || records[0].path !== "" || records.some(item => typeof item?.path !== "string" || (item.path && (isAbsolute(item.path) || item.path.split(sep).some(p => !p || p === "." || p === ".."))) || item.dev !== config.device || !Number.isFinite(item.ino) || !Number.isFinite(item.size) || !Number.isFinite(item.modified) || typeof item.directory !== "boolean")) throw new Error("The Session Trash journal contains invalid file identities.");
  }
  return entry;
}

function locate(config, entry) {
  const candidates = [stagePath(config, entry.token), trashPath(config, entry.token)].filter(path => guarded(path, { missing: true, directory: true }));
  if (candidates.length > 1) throw new Error("Two recovery bundles have the same identity. No files were moved.");
  const bundle = candidates[0];
  if (bundle) {
    if (guarded(bundle, { directory: true }).dev !== config.device) throw new Error("The recovery bundle is on another volume.");
    const manifest = guarded(join(bundle, "manifest.json"));
    if (!manifest.isFile() || manifest.size > 16 * 1024 * 1024) throw new Error("The recovery bundle manifest is invalid.");
    let saved;
    try { saved = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")); } catch { throw new Error("The recovery bundle manifest is invalid."); }
    if (saved.token !== entry.token || saved.key !== entry.key || JSON.stringify(saved.files) !== JSON.stringify(entry.files)) throw new Error("The recovery bundle does not match its journal.");
  }
  return bundle;
}

function parents(config, store, path) {
  if (guarded(store, { directory: true }).dev !== config.device) throw new Error("The original session store is on another volume.");
  inside(store, path);
  guarded(dirname(path), { missing: true });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (guarded(dirname(path), { directory: true }).dev !== config.device) throw new Error("The restore destination is on another volume.");
}

// Delete only our manifest and empty directories. Unexpected data is retained.
function cleanupBundle(bundle) {
  const manifest = join(bundle, "manifest.json");
  function verify(path) {
    for (const child of readdirSync(path, { withFileTypes: true })) {
      const target = join(path, child.name);
      if (target === manifest && child.isFile()) continue;
      if (!child.isDirectory() || child.isSymbolicLink()) throw new Error("The recovery bundle contains unexpected data.");
      verify(target);
    }
  }
  verify(bundle);
  function empty(path) {
    for (const child of readdirSync(path, { withFileTypes: true })) if (child.isDirectory() && !child.isSymbolicLink()) empty(join(path, child.name));
    if (path !== bundle) rmdirSync(path);
  }
  empty(bundle);
  if (stat(manifest)) unlinkSync(manifest);
  rmdirSync(bundle);
}

function rollback(config, entry, bundle, moved, toOriginal, move) {
  let complete = true;
  for (const index of [...moved].reverse()) {
    const original = join(entry.store, entry.files[index]), payload = join(bundle, "data", entry.files[index]);
    const source = toOriginal ? payload : original, target = toOriginal ? original : payload;
    try {
      if (guarded(target, { missing: true })) throw new Error("Rollback destination exists.");
      unchanged(source, entry.snapshots[index], config.device);
      if (toOriginal) parents(config, entry.store, target); else { guarded(dirname(target), { missing: true }); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); }
      move(source, target);
    } catch { complete = false; }
  }
  return complete;
}

function publicEntry(config, entry) {
  const bundle = locate(config, entry);
  const { snapshots, version, ...view } = entry;
  const message = !bundle ? "Session files are no longer in Trash or their staging directory." : entry.status === "recovery" || entry.status === "restoring" || entry.status === "staging" ? "An interrupted operation needs recovery. Restore will recover the remaining files." : "";
  return { ...view, location: !bundle ? "missing" : bundle === stagePath(config, entry.token) ? "staging" : "trash", restorable: Boolean(bundle), message };
}

export function prepare(key, options = {}, dependencies = {}) {
  return locked(options, config => {
    const result = plan(key, config);
    (dependencies.checkInactive || checkInactive)(result.row, result.files.map(file => join(result.row.store, file)), result.snapshots);
    return { row: result.row, files: result.files };
  });
}

export function trash(key, options = {}, dependencies = {}) {
  return locked(options, config => {
    const result = plan(key, config), move = dependencies.move || exclusiveMove, inactive = dependencies.checkInactive || checkInactive;
    const paths = result.files.map(file => join(result.row.store, file));
    inactive(result.row, paths, result.snapshots);
    const token = randomUUID(), bundle = stagePath(config, token);
    if (guarded(trashPath(config, token), { missing: true })) throw new Error("A recovery bundle already exists. Retry this operation.");
    const entry = { version: 1, ...result.row, token, files: result.files, snapshots: result.snapshots, status: "staging", trashedAt: Date.now() };
    mkdirSync(bundle, { mode: 0o700 });
    writeFileSync(join(bundle, "manifest.json"), JSON.stringify(entry), { flag: "wx", mode: 0o600 });
    save(config, entry);
    const moved = [];
    try {
      inactive(result.row, paths, result.snapshots);
      for (let index = 0; index < paths.length; index++) {
        unchanged(paths[index], result.snapshots[index], config.device);
        const target = join(bundle, "data", result.files[index]);
        guarded(dirname(target), { missing: true }); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        move(paths[index], target); moved.push(index);
      }
      (dependencies.nativeTrash || nativeTrash)(bundle);
      const destination = locate(config, entry);
      if (destination !== trashPath(config, token)) throw new Error("macOS did not return the expected recovery bundle in Trash.");
      for (let index = 0; index < paths.length; index++) unchanged(join(destination, "data", result.files[index]), result.snapshots[index], config.device);
      entry.status = "trashed"; save(config, entry);
      return { entry: publicEntry(config, entry) };
    } catch (error) {
      let location;
      try { location = locate(config, entry); } catch { /* Preserve the journal if identity validation fails. */ }
      if (location && rollback(config, entry, location, moved, true, move)) {
        try { cleanupBundle(location); unlinkSync(journalPath(config, token)); } catch { entry.status = "recovery"; save(config, entry); }
      } else { entry.status = "recovery"; save(config, entry); }
      throw new Error(stat(journalPath(config, token)) ? "The operation could not finish. A recovery entry was kept; close the agent and use Restore." : (error.message || "The operation failed; all session items were restored."));
    }
  });
}

export function list(options = {}) {
  return locked(options, config => {
    const entries = [];
    for (const file of readdirSync(join(config.stateDir, "entries"))) {
      if (!file.endsWith(".json")) continue;
      const token = file.slice(0, -5);
      if (!UUID.test(token)) continue;
      let entry;
      try {
        entry = readEntry(config, token);
        const view = publicEntry(config, entry);
        if (view.location === "missing" && entry.status === "trashed") {
          // Finder already removed the bundle. Only its obsolete local index is pruned.
          unlinkSync(journalPath(config, token));
          continue;
        }
        entries.push(view);
      }
      catch (error) {
        // One damaged or differently configured record must not hide intact
        // recovery entries. Keep its files and disable its Restore action.
        const fallback = entry || { token, key: `unavailable:${token}`, provider: "Unknown agent", title: "Unavailable recovery entry", trashedAt: stat(journalPath(config, token))?.mtimeMs || 0 };
        const { snapshots, version, ...view } = fallback;
        entries.push({ ...view, status: "invalid", location: "unavailable", restorable: false, message: error.message || "This recovery entry could not be validated. Its files were kept." });
      }
    }
    return { entries: entries.sort((a, b) => b.trashedAt - a.trashedAt) };
  });
}

export function restore(token, options = {}, dependencies = {}) {
  return locked(options, config => {
    const entry = readEntry(config, token), bundle = locate(config, entry), move = dependencies.move || exclusiveMove;
    if (!bundle) throw new Error("The recovery bundle is no longer available. It may have been removed from Trash.");
    const row = Object.fromEntries(["key", "provider", "store", "id", "cwd", "title", "updated", "defaultStore"].map(key => [key, entry[key]]));
    const paths = [], indexes = [];
    for (let index = 0; index < entry.files.length; index++) {
      const original = join(entry.store, entry.files[index]), payload = join(bundle, "data", entry.files[index]);
      const atOriginal = guarded(original, { missing: true }), atPayload = guarded(payload, { missing: true });
      if (atOriginal && atPayload) throw new Error("An original session path already exists. Restore never overwrites it.");
      if (!atOriginal && !atPayload) throw new Error("A session item is missing from the recovery bundle. No files were moved.");
      unchanged(atPayload ? payload : original, entry.snapshots[index], config.device);
      paths.push(atPayload ? payload : original);
      if (atPayload) indexes.push(index);
    }
    const inactive = dependencies.checkInactive || checkInactive;
    inactive(row, paths, entry.snapshots);
    entry.status = "restoring"; save(config, entry);
    const moved = [];
    try {
      for (const index of indexes) {
        const original = join(entry.store, entry.files[index]), payload = join(bundle, "data", entry.files[index]);
        unchanged(payload, entry.snapshots[index], config.device);
        parents(config, entry.store, original);
        move(payload, original); moved.push(index);
      }
    } catch (error) {
      rollback(config, entry, bundle, moved, false, move);
      entry.status = "recovery"; save(config, entry);
      throw new Error("Restore could not finish. Its recovery entry was kept; no existing session was overwritten.");
    }
    try { cleanupBundle(bundle); unlinkSync(journalPath(config, token)); }
    catch { entry.status = "recovery"; save(config, entry); throw new Error("Session files were restored, but the recovery bundle contains unexpected data. Its recovery entry was kept."); }
    return { row };
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const action = process.argv[2], options = JSON.parse(process.argv[3] || "{}"), value = process.argv[4];
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("Invalid Session Trash options.");
    const actions = { prepare: () => prepare(value, options), trash: () => trash(value, options), list: () => list(options), restore: () => restore(value, options) };
    if (!Object.hasOwn(actions, action)) throw new Error("Unknown Session Trash action.");
    process.stdout.write(JSON.stringify(actions[action]()));
  } catch (error) { process.stdout.write(JSON.stringify({ error: error.message || "Session Trash could not complete this operation.", ...(error.code === "SESSION_MISSING" ? { code: error.code } : {}) })); process.exitCode = 1; }
}
