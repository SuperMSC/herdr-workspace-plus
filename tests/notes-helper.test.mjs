import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createNativeNotesClient } from "../mods/sessions-plus/notes-client.js";
import { setupNotesHome, prepareNotesRequest } from "../mods/sessions-plus/notes-helper.mjs";
import { projectNoteScope, globalNoteScope, encodeNotes, decodeNotes } from "../mods/sessions-plus/notes-model.js";

const execute = promisify(execFile), source = fileURLToPath(new URL("../mods/sessions-plus/", import.meta.url));
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(tmpdir(), "herdr-notes-helper-")); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const mod = path.join(home, "mods/sessions-plus"); await fs.mkdir(mod, { recursive: true });
  for (const name of ["notes-helper.mjs", "notes-model.js", "model.js", "package.json"]) await fs.copyFile(path.join(source, name), path.join(mod, name));
  const calls = [], failed = [], io = {
    read: async file => { try { return await fs.readFile(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } },
    write: async (file, raw, expected) => { if (await io.read(file) !== expected) throw new Error("stale snapshot"); await fs.writeFile(file, raw); },
    mkdir: fs.mkdir, unlink: fs.unlink,
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      try { const result = await execute(command, args, { encoding: "utf8", timeout: options.timeout, maxBuffer: 8 * 1024 * 1024 }); return { code: 0, ...result }; }
      catch (error) { failed.push(error); return { code: error.code || 1, stdout: error.stdout || "", stderr: error.stderr || "" }; }
    },
  };
  const client = createNativeNotesClient(io, home, process.execPath);
  return { home, client, io, calls, failed, jobs: path.join(home, "data/workspace-notes/jobs") };
}

test("native bridge transforms in one bounded helper and leaves plaintext requests out of argv and disk", async t => {
  const f = await fixture(t), scope = projectNoteScope({ root: "/fixture" });
  assert.deepEqual(await f.client.load(), { schema: 1, notes: [] });
  assert.deepEqual(await fs.readdir(f.jobs), []);
  const result = await f.client.save(scope, { title: "Decision", body: "private-note-fixture" }, 0);
  assert.equal(result.note.body, "private-note-fixture");
  assert.equal((await f.client.load()).notes[0].body, "private-note-fixture");
  assert(f.calls.every(call => call.options.timeout === 10000));
  assert(!JSON.stringify(f.calls).includes("private-note-fixture"));
  assert.deepEqual(await fs.readdir(f.jobs), []);
  assert.equal((await fs.stat(f.jobs)).mode & 0o777, 0o700);
  await assert.rejects(() => f.client.save(scope, { title: "Stale", body: "Must not overwrite" }, 0), error => error.code === "NOTE_CONFLICT");
  assert.deepEqual(await fs.readdir(f.jobs), []);
  assert.equal(decodeNotes(await fs.readFile(f.client.file, "utf8")).notes[0].body, "private-note-fixture");
});

test("near-capacity store transforms outside the UI and keeps old saved note bodies", async t => {
  const f = await fixture(t);
  const notes = Array.from({ length: 30 }, (_, index) => {
    const scope = projectNoteScope({ root: `/fixture/${index}` });
    return { key: scope.key, scope, title: "Capacity", body: "x".repeat(27000), revision: index + 1, created: 1, updated: 1, archived: false, versions: [] };
  });
  await setupNotesHome(f.home);
  await fs.writeFile(f.client.file, encodeNotes({ schema: 1, clock: 30, notes }));
  const result = await f.client.save(globalNoteScope(), { title: "Additional", body: "y".repeat(35000) }, 0);
  assert.equal(result.state.notes.length, 31);
  assert.equal(result.note.body.length, 35000);
  assert.equal(result.state.notes[0].body.length, 27000);
  assert.deepEqual(await fs.readdir(f.jobs), []);
});

test("request validation rejects traversal and symlink directories without touching unrelated files", async t => {
  const f = await fixture(t), outside = path.join(f.home, "outside");
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, "keep"), "preserve");
  await assert.rejects(() => prepareNotesRequest(f.home, "../outside/keep"), /Invalid/);
  await fs.mkdir(path.join(f.home, "data/workspace-notes"), { recursive: true });
  await fs.symlink(outside, f.jobs);
  await assert.rejects(() => setupNotesHome(f.home), /owned directory/);
  assert.equal(await fs.readFile(path.join(outside, "keep"), "utf8"), "preserve");
});

test("malformed request content is deleted before parsing and never changes saved notes", async t => {
  const f = await fixture(t); await setupNotesHome(f.home);
  const name = `job-${Date.now()}-1-fixture.json`, file = path.join(f.jobs, name);
  await fs.writeFile(file, "{broken");
  await assert.rejects(() => prepareNotesRequest(f.home, name));
  await assert.rejects(() => fs.stat(file), error => error.code === "ENOENT");
  assert.equal(await f.io.read(f.client.file), null);
});
