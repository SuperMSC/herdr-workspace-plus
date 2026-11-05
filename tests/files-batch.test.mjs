import { readFileSync } from "node:fs";
import * as library from "../mods/files-plus/library-model.js";
import * as model from "../mods/files-plus/model.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, lstat, symlink, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { targetFor } from "../mods/files-plus/model.js";
import { batchTargets, batchDestination, runBatch } from "../mods/files-plus/batch-model.js";
import { createFilesystem } from "../mods/files-plus/filesystem.js";
const run = promisify(execFile), mac = { skip: process.platform !== "darwin" };
async function execute(command, args) {
  const r = await run(command, args, { encoding: "utf8", timeout: 15000 });
  return { code: 0, ...r };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "herdr-batch-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dest")); return { root, files: createFilesystem(execute), target: (path, dir = false) => targetFor(root, path, dir, null, "macos") };
}

test("batch selection rejects root, escape, remote, mixed roots and excessive selections before any mutation", () => {
  const t = targetFor("/project", "src/file", false, null, "macos");
  for (const targets of [[], [targetFor("/project", "", true, null, "macos")], [{ ...t, on: "remote" }], [{ ...t, relative: "../outside" }], [t, { ...t, root: "/other" }], Array(101).fill(t)]) assert.throws(() => batchTargets(targets));
  const parent = targetFor("/project", "src", true, null, "macos");
  assert.deepEqual(batchTargets([t, parent, t]), [parent]);
  for (const path of ["relative", "~/Downloads", "/tmp/../outside", "/tmp/line\nbreak"]) assert.throws(() => batchDestination(path));
  assert.equal(batchDestination("/tmp/ space /"), "/tmp/ space ");
});

test("partial batch results preserve successes, report exact failures and retry only remaining items", async () => {
  const targets = ["one", "two"].map(path => targetFor("/root", path, false, null, "macos")), calls = [];
  const fs = { async copy(path, dest) { calls.push(path); if (path.endsWith("two") && calls.length === 2) throw new Error("conflict"); return dest + "/" + path.split("/").pop(); } };
  const first = await runBatch(targets, "copy", "/dest", fs);
  assert.deepEqual(first.map(r => r.ok), [true, false]); assert.equal(first[1].error, "conflict");
  const retry = await runBatch(first.filter(r => !r.ok).map(r => r.target), "copy", "/new-dest", fs);
  assert(retry[0].ok); assert.deepEqual(calls, ["/root/one", "/root/two", "/root/two"]);
});

test("copy and move remain local and validate destination before launching native programs", async () => {
  let calls = 0;
  for (const options of [{ on: "remote" }, { platform: "linux" }]) {
    const files = createFilesystem(() => { calls++; }, options);
    await assert.rejects(() => files.copy("/source", "/dest")); await assert.rejects(() => files.move("/source", "/dest"));
  }
  const files = createFilesystem(() => { calls++; });
  await assert.rejects(() => files.copy("/", "/dest")); await assert.rejects(() => files.move("/source", "relative"));
  assert.equal(calls, 0);
});

test("native copy preserves content, literal names, directories and symlinks without modifying sources", mac, async t => {
  const { root, files, target } = await fixture(t), name = " 中文 ' $() &.txt ";
  await writeFile(join(root, name), "literal content"); await mkdir(join(root, "folder")); await writeFile(join(root, "folder/child"), "child");
  await symlink(name, join(root, "link")); await symlink("missing", join(root, "dangling"));
  const results = await runBatch([target(name), target("folder", true), target("link"), target("dangling")], "copy", join(root, "dest"), files);
  assert(results.every(r => r.ok), JSON.stringify(results));
  assert.equal(await readFile(join(root, "dest", name), "utf8"), "literal content");
  assert.equal(await readFile(join(root, "dest/folder/child"), "utf8"), "child");
  assert.equal(await readlink(join(root, "dest/link")), name); assert.equal(await readlink(join(root, "dest/dangling")), "missing");
  assert.equal(await readFile(join(root, name), "utf8"), "literal content");
});

test("native transfers never replace existing files, directories or dangling symlinks", mac, async t => {
  const { root, files } = await fixture(t);
  await writeFile(join(root, "file"), "source"); await writeFile(join(root, "dest/file"), "keep");
  await mkdir(join(root, "folder")); await mkdir(join(root, "dest/folder")); await writeFile(join(root, "dest/folder/keep"), "keep");
  await writeFile(join(root, "dangling"), "source"); await symlink("missing", join(root, "dest/dangling"));
  for (const operation of ["copy", "move"]) for (const name of ["file", "folder", "dangling"]) await assert.rejects(() => files[operation](join(root, name), join(root, "dest")));
  assert.equal(await readFile(join(root, "dest/file"), "utf8"), "keep"); assert.equal(await readlink(join(root, "dest/dangling")), "missing");
  assert.equal(await readFile(join(root, "file"), "utf8"), "source"); assert.equal(await readFile(join(root, "dest/folder/keep"), "utf8"), "keep");
});

test("native transfer rejects source directory descendants even through a symlink alias", mac, async t => {
  const { root, files } = await fixture(t);
  await mkdir(join(root, "src/inner"), { recursive: true }); await symlink(join(root, "src/inner"), join(root, "alias"));
  for (const operation of ["copy", "move"]) for (const folder of ["src", "src/inner", "alias"]) await assert.rejects(() => files[operation](join(root, "src"), join(root, folder)), /itself/);
  assert((await lstat(join(root, "src/inner"))).isDirectory());
});

test("native exclusive moves preserve losing sources under concurrent destination conflicts", mac, async t => {
  const { root, files } = await fixture(t);
  for (const folder of ["one", "two"]) { await mkdir(join(root, folder)); await writeFile(join(root, folder, "same"), folder); }
  const results = await Promise.allSettled(["one", "two"].map(folder => files.move(join(root, folder, "same"), join(root, "dest"))));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const loser = results[0].status === "fulfilled" ? "two" : "one";
  assert.equal(await readFile(join(root, loser, "same"), "utf8"), loser);
});

function batchView(files) {
  const tasks = [], state = {}, calls = [], releases = [];
  const cx = { notify() {}, focus_handle: () => ({ focus() {} }), spawn(fn) { tasks.push(fn(cx)); } };
  const deps = { ...library, ...model, batchTargets, batchDestination, runBatch, exec() {}, createFilesystem: () => files,
    shared: key => state[key], setShared: (key, value) => { state[key] = value; }, closeOverlay() {},
    InputState: { new: ({ value }) => ({ value: () => value, set_value: next => { value = next; }, focus() {}, on() {}, release() { releases.push(true); } }) },
    pickFolder: () => new Promise(resolve => calls.push(resolve)) };
  const source = readFileSync(new URL("../mods/files-plus/batch.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  const Batch = new Function(...Object.keys(deps), source)(...Object.values(deps)), view = new Batch();
  view.init({ action: "move", targets: ["one", "two"].map(path => targetFor("/source", path, false, null, "macos")), overlay: "fixture" }, cx);
  view.input.set_value("/destination");
  return { view, cx, tasks, state, calls, releases };
}

test("batch dialog prevents duplicate submits, publishes cumulative changes and retries only failed targets", async () => {
  const calls = []; let unblock;
  const first = new Promise(resolve => { unblock = resolve; });
  const f = batchView({ async move(path, destination) { calls.push([path, destination]); if (path.endsWith("one")) await first; if (path.endsWith("two") && calls.length === 2) throw new Error("conflict"); return destination + "/" + path.split("/").pop(); } });
  f.view.submit(f.cx); f.view.submit(f.cx); assert.equal(calls.length, 1); assert(f.view.busy);
  unblock(); await Promise.all(f.tasks);
  assert.equal(f.view.pending().length, 1); assert.equal(f.view.results[1].error, "conflict");
  assert.equal(f.state[model.CHANGE_KEY].results.length, 1);
  f.view.input.set_value("/retry"); f.view.submit(f.cx); await Promise.all(f.tasks);
  assert.equal(f.view.pending().length, 0); assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], ["/source/two", "/retry"]);
  assert.equal(f.state[model.CHANGE_KEY].results.length, 2);
});

test("folder picker cancellation or a late result cannot change a disposed dialog or start an operation", async () => {
  const f = batchView({ move() { throw new Error("Must not run"); } });
  f.view.choose(f.cx); f.view.submit(f.cx); assert.equal(f.tasks.length, 1);
  f.calls[0](null); await f.tasks[0]; assert.equal(f.view.input.value(), "/destination");
  f.view.choose(f.cx); f.view.close(); f.calls[1]("/late"); await f.tasks[1];
  assert.equal(f.view.input.value(), "/destination"); assert.deepEqual(f.releases, [true]);
});
