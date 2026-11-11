import assert from "node:assert/strict";
import { constants, readFileSync, renameSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DELIVERABLE_LIMITS as LIMIT, deliverableScope, safeDeliverableUrl } from "../mods/sessions-plus/deliverables-model.js";

const source = readFileSync(new URL("../mods/sessions-plus/deliverables-store.mjs", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace(/\bexport\s+(?=(?:async\s+)?function|const|let|class)/g, "");
const deadPid = 2147483647;
const record = (pid = process.pid) => JSON.stringify({ pid, token: randomUUID() }) + "\n";
const missing = error => error.code === "ENOENT";

function load(overrides = {}) {
  const deps = {
    mkdir: fs.mkdir, writeFile: fs.writeFile, rename: fs.rename, unlink: fs.unlink, open: fs.open, lstat: fs.lstat,
    path, constants, randomUUID, LIMIT, deliverableScope, safeDeliverableUrl,
    process: { pid: process.pid, getuid: typeof process.getuid === "function" ? process.getuid.bind(process) : undefined, kill: process.kill.bind(process) },
    ...overrides,
  };
  return new Function(...Object.keys(deps), source + "\nreturn {readOwned, clearDeadLock, withLock, deliverableRequest, deliverablePaths};")(...Object.values(deps));
}

async function fixture(t) {
  const home = await fs.mkdtemp("/private/tmp/deliverables-lock-"), handles = [], paths = load().deliverablePaths(home);
  t.after(async () => { for (const handle of handles) await handle.close().catch(() => {}); await fs.rm(home, { recursive: true, force: true }); });
  await fs.mkdir(paths.folder, { recursive: true });
  return { home, paths, async hold(file) { const handle = await fs.open(file, "r"); handles.push(handle); return handle; } };
}

function processWithKill(kill) {
  return { pid: process.pid, getuid: typeof process.getuid === "function" ? process.getuid.bind(process) : undefined, kill };
}

function noSuchProcess() {
  throw Object.assign(new Error("The fixture owner no longer exists."), { code: "ESRCH" });
}

test("a lock replaced between lstat and open is retried without reporting a boundary error or removing its live successor", async t => {
  const f = await fixture(t), successor = record();
  await fs.writeFile(f.paths.lock, String(deadPid)); await f.hold(f.paths.lock);
  let replaced = false;
  const api = load({ lstat: async (...args) => {
    const info = await fs.lstat(...args);
    if (args[0] === f.paths.lock && !replaced) { replaced = true; await fs.rename(f.paths.lock, path.join(f.home, "retired-lock")); await fs.writeFile(f.paths.lock, successor, { flag: "wx" }); }
    return info;
  } });
  await api.clearDeadLock(f.paths);
  assert(replaced); assert.equal(await fs.readFile(f.paths.lock, "utf8"), successor);
});

test("dead-owner recovery never unlinks a new live lock installed after reading the old owner", async t => {
  const f = await fixture(t), successor = record(), retired = path.join(f.home, "retired-lock");
  await fs.writeFile(f.paths.lock, String(deadPid)); await f.hold(f.paths.lock);
  let replaced = false;
  const api = load({ process: processWithKill((pid, signal) => {
    assert.equal(pid, deadPid); assert.equal(signal, 0);
    renameSync(f.paths.lock, retired); writeFileSync(f.paths.lock, successor, { flag: "wx" }); replaced = true; noSuchProcess();
  }) });
  await api.clearDeadLock(f.paths);
  assert(replaced); assert.equal(await fs.readFile(f.paths.lock, "utf8"), successor); assert.equal(await fs.readFile(retired, "utf8"), String(deadPid));
});

test("an owned store opened before atomic replacement remains a complete readable snapshot after its link count becomes zero", async t => {
  const f = await fixture(t), raw = JSON.stringify({ schema: 1, revision: 7, projects: [] });
  await fs.writeFile(f.paths.file, raw);
  let unlinked = false;
  const api = load({ open: async (...args) => {
    const handle = await fs.open(...args);
    if (args[0] === f.paths.file && !unlinked) { await fs.unlink(f.paths.file); unlinked = true; assert.equal((await handle.stat()).nlink, 0); }
    return handle;
  } });
  assert.equal(await api.readOwned(f.paths.file, LIMIT.bytes), raw); assert(unlinked);
});

test("a store atomically replaced between lstat and open is retried as a coherent newer snapshot", async t => {
  const f = await fixture(t), original = JSON.stringify({ schema: 1, revision: 1, projects: [] }), successor = JSON.stringify({ schema: 1, revision: 2, projects: [] });
  await fs.writeFile(f.paths.file, original); await f.hold(f.paths.file);
  let replaced = false;
  const api = load({ lstat: async (...args) => {
    const info = await fs.lstat(...args);
    if (args[0] === f.paths.file && !replaced) { replaced = true; await fs.rename(f.paths.file, path.join(f.home, "retired-store")); await fs.writeFile(f.paths.file, successor, { flag: "wx" }); }
    return info;
  } });
  assert.equal(await api.readOwned(f.paths.file, LIMIT.bytes), successor); assert(replaced);
});

test("repeated identity changes stop after a bounded retry budget and retain the final store", async t => {
  const f = await fixture(t); await fs.writeFile(f.paths.file, "initial"); let replacements = 0;
  const api = load({ lstat: async (...args) => {
    const info = await fs.lstat(...args);
    if (args[0] === f.paths.file) { await f.hold(f.paths.file); await fs.rename(f.paths.file, path.join(f.home, "retired-" + replacements)); replacements++; await fs.writeFile(f.paths.file, "replacement-" + replacements, { flag: "wx" }); }
    return info;
  } });
  await assert.rejects(api.readOwned(f.paths.file, LIMIT.bytes), error => error.code === "storage_changed");
  assert.equal(replacements, 8); assert.equal(await fs.readFile(f.paths.file, "utf8"), "replacement-8");
});

for (const kind of ["symbolic", "hard"]) test(`a real ${kind} link introduced during an identity race remains a boundary violation`, async t => {
  const f = await fixture(t), foreign = path.join(f.home, "untouched"), original = "foreign contents";
  await fs.writeFile(f.paths.file, "original"); await fs.writeFile(foreign, original); await f.hold(f.paths.file);
  let replaced = false;
  const api = load({ lstat: async (...args) => {
    const info = await fs.lstat(...args);
    if (args[0] === f.paths.file && !replaced) {
      replaced = true; await fs.rename(f.paths.file, path.join(f.home, "retired-store"));
      if (kind === "symbolic") await fs.symlink(foreign, f.paths.file); else await fs.link(foreign, f.paths.file);
    }
    return info;
  } });
  await assert.rejects(api.readOwned(f.paths.file, LIMIT.bytes), error => error.code === "boundary");
  assert(replaced); assert.equal(await fs.readFile(foreign, "utf8"), original); assert.equal((await fs.lstat(f.paths.file)).isSymbolicLink(), kind === "symbolic");
});

test("incomplete JSON lock records are left intact and are never checked as a dead PID", async t => {
  const f = await fixture(t); let probes = 0;
  const api = load({ process: processWithKill(() => { probes++; noSuchProcess(); }) });
  for (const raw of ['{"pid":' + deadPid + ',"token":"partial', record(deadPid).trimEnd()]) {
    await fs.writeFile(f.paths.lock, raw); await api.clearDeadLock(f.paths); assert.equal(await fs.readFile(f.paths.lock, "utf8"), raw);
  }
  assert.equal(probes, 0);
});

test("complete dead JSON owners and legacy plain PID locks can still be recovered", async t => {
  const f = await fixture(t); let probes = 0;
  const api = load({ process: processWithKill((pid, signal) => { assert.equal(pid, deadPid); assert.equal(signal, 0); probes++; noSuchProcess(); }) });
  for (const raw of [record(deadPid), String(deadPid)]) {
    await fs.writeFile(f.paths.lock, raw); await api.clearDeadLock(f.paths); await assert.rejects(fs.lstat(f.paths.lock), missing);
  }
  assert.equal(probes, 2);
});

test("releasing a held lock preserves a replacement lock and new acquisitions publish a complete ownership record", async t => {
  const f = await fixture(t), successor = record(); let original;
  const result = await load().withLock(f.paths, async () => {
    original = await fs.readFile(f.paths.lock, "utf8"); assert(original.endsWith("\n")); const owner = JSON.parse(original); assert.equal(owner.pid, process.pid); assert.equal(typeof owner.token, "string"); assert(owner.token.length > 0);
    await f.hold(f.paths.lock); await fs.rename(f.paths.lock, path.join(f.home, "retired-lock")); await fs.writeFile(f.paths.lock, successor, { flag: "wx" }); return "completed";
  });
  assert.equal(result, "completed"); assert.equal(await fs.readFile(f.paths.lock, "utf8"), successor); assert.notEqual(original, successor);
});

test("a pre-open stat whose original inode was unlinked before resolution retries the complete successor snapshot", async t => {
  const f = await fixture(t), original = JSON.stringify({ schema: 1, revision: 1, projects: [] }), successor = JSON.stringify({ schema: 1, revision: 2, projects: [] });
  await fs.writeFile(f.paths.file, original); const held = await f.hold(f.paths.file); let probes = 0;
  const api = load({ lstat: async (...args) => {
    if (args[0] === f.paths.file && probes++ === 0) { await fs.unlink(f.paths.file); await fs.writeFile(f.paths.file, successor, { flag: "wx" }); const retired = await held.stat(); assert.equal(retired.nlink, 0); return retired; }
    return fs.lstat(...args);
  } });
  assert.equal(await api.readOwned(f.paths.file, LIMIT.bytes), successor); assert.equal(probes, 2); assert.equal(await fs.readFile(f.paths.file, "utf8"), successor);
});

test("recovery ignores an unlinked pre-unlink stat and leaves a newly published active lock intact", async t => {
  const f = await fixture(t), successor = record(); await fs.writeFile(f.paths.lock, String(deadPid)); const held = await f.hold(f.paths.lock); let recovering = false, replaced = false;
  const api = load({
    process: processWithKill((pid, signal) => { assert.equal(pid, deadPid); assert.equal(signal, 0); recovering = true; noSuchProcess(); }),
    lstat: async (...args) => {
      if (args[0] === f.paths.lock && recovering && !replaced) { replaced = true; await fs.unlink(f.paths.lock); await fs.writeFile(f.paths.lock, successor, { flag: "wx" }); const retired = await held.stat(); assert.equal(retired.nlink, 0); return retired; }
      return fs.lstat(...args);
    },
  });
  await api.clearDeadLock(f.paths); assert(replaced); assert.equal(await fs.readFile(f.paths.lock, "utf8"), successor);
});

test("an unlinked-looking stat with a foreign owner remains a boundary violation", { skip: typeof process.getuid !== "function" }, async t => {
  const f = await fixture(t); await fs.writeFile(f.paths.file, "owned contents"); let probes = 0;
  const api = load({ lstat: async (...args) => { const info = await fs.lstat(...args); if (args[0] !== f.paths.file) return info; probes++; const unsafe = Object.create(info); Object.defineProperties(unsafe, { nlink: { value: 0 }, uid: { value: process.getuid() + 1 } }); return unsafe; } });
  await assert.rejects(api.readOwned(f.paths.file, LIMIT.bytes), error => error.code === "boundary"); assert.equal(probes, 1); assert.equal(await fs.readFile(f.paths.file, "utf8"), "owned contents");
});

test("an unlinked-looking stat with a non-file type remains a boundary violation", async t => {
  const f = await fixture(t); await fs.writeFile(f.paths.file, "owned contents"); let probes = 0;
  const api = load({ lstat: async (...args) => { const info = await fs.lstat(...args); if (args[0] !== f.paths.file) return info; probes++; const unsafe = Object.create(info); Object.defineProperties(unsafe, { nlink: { value: 0 }, isFile: { value: () => false } }); return unsafe; } });
  await assert.rejects(api.readOwned(f.paths.file, LIMIT.bytes), error => error.code === "boundary"); assert.equal(probes, 1); assert.equal(await fs.readFile(f.paths.file, "utf8"), "owned contents");
});
