import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { basename, createFilesystem, parentPath, validateName } from "../mods/files-plus/filesystem.js";

const run = promisify(execFile);
const scratch = resolve(dirname(fileURLToPath(import.meta.url)), "../.scratch");
const nativeMac = { skip: process.platform !== "darwin" };
const signals = [];
const nativeResults = [];

async function executor(command, args) {
  try {
    const { stdout, stderr } = await run(command, args, { encoding: "utf8", timeout: 15000 });
    const result = { command, code: 0, stdout, stderr };
    nativeResults.push(result);
    return result;
  } catch (error) {
    const result = { command, code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout || "", stderr: error.stderr || error.message };
    nativeResults.push(result);
    if (error.signal) {
      signals.push({ command, signal: error.signal });
      assert.fail(`${command} terminated with ${error.signal}`);
    }
    return result;
  }
}

async function fixture(t) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "filesystem-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

after(async () => {
  try { await rmdir(scratch); }
  catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; }
});

after(() => {
  // Expected rejection assertions must never hide a native process crash.
  assert.deepEqual(signals, [], "No native subprocess may terminate by signal");
  for (const result of nativeResults) {
    assert.equal(result.code, 0, result.stderr);
    if (result.command !== "/usr/bin/osascript") continue;
    const payload = JSON.parse(result.stdout);
    assert.equal(typeof payload.ok, "boolean", "Every native result must be structured JSON");
    if (!payload.ok) {
      assert.equal(typeof payload.error, "string");
      assert.ok(payload.error.length > 0);
    }
  }
});

test("validates one filename without changing spaces or Unicode", () => {
  for (const value of ["", ".", "..", "a/b", "a\\b", "a:b", "line\nbreak", "nul\0", "delete\x7f", undefined]) {
    assert.throws(() => validateName(value));
  }
  for (const value of [" space ", "中文.txt", "'\"$();&`.txt", "-option", ".hidden"]) {
    assert.equal(validateName(value), value);
  }
});

test("path helpers preserve symlinks and handle filesystem roots", () => {
  assert.equal(parentPath("/a"), "/");
  assert.equal(parentPath("/a/b/"), "/a");
  assert.equal(basename("/a/link/"), "link");
  assert.throws(() => parentPath("relative"));
  assert.throws(() => parentPath("/a/../b"));
});

test("remote spaces and unsupported platforms reject every action before exec", async () => {
  let calls = 0;
  for (const options of [{ on: "server", platform: "macos" }, { platform: "windows" }, { platform: "linux" }]) {
    const files = createFilesystem(() => { calls++; }, options);
    for (const operation of [
      () => files.createFile("/tmp", "a"), () => files.createFolder("/tmp", "a"),
      () => files.rename("/tmp/a", "b"), () => files.trash("/tmp/a"),
      () => files.open("/tmp/a"), () => files.reveal("/tmp/a"),
    ]) await assert.rejects(operation);
  }
  assert.equal(calls, 0);
});

test("open and reveal pass paths as argv without opening an application in tests", async () => {
  const calls = [];
  const files = createFilesystem(async (...args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  });
  const path = "/tmp/中文 ' $() & file.txt";
  assert.equal(await files.open(path), path);
  assert.equal(await files.reveal(path), path);
  assert.deepEqual(calls, [
    ["/usr/bin/open", ["--", path], { on: null }],
    ["/usr/bin/open", ["-R", "--", path], { on: null }],
  ]);
});

test("executor failures and malformed native responses are surfaced", async () => {
  const failing = createFilesystem(async () => ({ code: 1, stdout: "", stderr: "permission denied" }));
  await assert.rejects(() => failing.createFile("/tmp", "file"), /permission denied/);
  const invalid = createFilesystem(async () => ({ code: 0, stdout: "not JSON", stderr: "" }));
  await assert.rejects(() => invalid.createFile("/tmp", "file"), /invalid response/);
  const nativeError = createFilesystem(async () => ({ code: 0, stdout: '{"ok":false,"error":"already exists"}', stderr: "" }));
  await assert.rejects(() => nativeError.createFile("/tmp", "file"), /already exists/);
});

test("invalid names, paths, and root mutations never run a process", async () => {
  let calls = 0;
  const files = createFilesystem(() => { calls++; });
  await assert.rejects(() => files.createFile("/tmp", "../escape"));
  await assert.rejects(() => files.createFolder("relative", "folder"));
  await assert.rejects(() => files.rename("/", "root"));
  await assert.rejects(() => files.trash("///"));
  assert.equal(calls, 0);
});

test("creates and renames files and folders with literal shell metacharacters", nativeMac, async t => {
  const root = await fixture(t), files = createFilesystem(executor);
  const folder = await files.createFolder(root, " 中文 ' $() & folder ");
  const name = " ' \" $() ; & ` 中文.txt ";
  const path = await files.createFile(folder, name);
  assert.equal(path, join(folder, name));
  assert.equal((await lstat(path)).size, 0);
  await writeFile(path, "kept");
  const renamed = await files.rename(path, "-renamed 中文.txt");
  assert.equal(await readFile(renamed, "utf8"), "kept");
  const renamedFolder = await files.rename(folder, "renamed folder");
  assert.equal(await readFile(join(renamedFolder, "-renamed 中文.txt"), "utf8"), "kept");
});

test("existing files, folders and dangling symlinks cannot be overwritten", nativeMac, async t => {
  const root = await fixture(t), files = createFilesystem(executor);
  await writeFile(join(root, "existing"), "preserve me");
  await mkdir(join(root, "folder"));
  await writeFile(join(root, "folder", "child"), "preserve child");
  await symlink("missing-target", join(root, "dangling"));
  for (const name of ["existing", "folder", "dangling"]) {
    await assert.rejects(() => files.createFile(root, name), /Cannot create this file/);
    await assert.rejects(() => files.createFolder(root, name), /Cannot create this folder/);
    await writeFile(join(root, "source"), "source");
    await assert.rejects(() => files.rename(join(root, "source"), name), /Cannot rename this item/);
    assert.equal(await readFile(join(root, "source"), "utf8"), "source");
  }
  assert.equal(await readFile(join(root, "existing"), "utf8"), "preserve me");
  assert.equal(await readFile(join(root, "folder", "child"), "utf8"), "preserve child");
  assert.equal(await readlink(join(root, "dangling")), "missing-target");
});

test("missing parents and sources return structured native errors", nativeMac, async t => {
  const root = await fixture(t), files = createFilesystem(executor);
  const missing = join(root, "missing");
  await assert.rejects(() => files.createFile(missing, "file"), /Cannot create this file/);
  await assert.rejects(() => files.createFolder(missing, "folder"), /Cannot create this folder/);
  await assert.rejects(() => files.rename(missing, "renamed"), /Cannot rename this item/);
  await assert.rejects(() => files.trash(missing), /Cannot move this item to the Trash/);
});

test("exclusive creation has exactly one winner under concurrent requests", nativeMac, async t => {
  const root = await fixture(t), files = createFilesystem(executor);
  for (const action of ["createFile", "createFolder"]) {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => files[action](root, action)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1, action);
    for (const result of results.filter(result => result.status === "rejected")) {
      assert.match(result.reason.message, action === "createFile" ? /Cannot create this file/ : /Cannot create this folder/);
    }
  }
});

test("exclusive rename has exactly one winner and preserves the losing source", nativeMac, async t => {
  const root = await fixture(t), files = createFilesystem(executor);
  await writeFile(join(root, "one"), "one");
  await writeFile(join(root, "two"), "two");
  const sources = ["one", "two"];
  const results = await Promise.allSettled(sources.map(name => files.rename(join(root, name), "destination")));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match(results.find(result => result.status === "rejected").reason.message, /Cannot rename this item/);
  const winning = sources[results.findIndex(result => result.status === "fulfilled")];
  const losing = sources[results.findIndex(result => result.status === "rejected")];
  assert.equal(await readFile(join(root, "destination"), "utf8"), winning);
  assert.equal(await readFile(join(root, losing), "utf8"), losing);
});

test("rename acts on the symlink itself and leaves its target unchanged", nativeMac, async t => {
  const root = await fixture(t), files = createFilesystem(executor);
  await writeFile(join(root, "target"), "target content");
  await symlink("target", join(root, "link"));
  const renamed = await files.rename(join(root, "link"), "new link");
  assert.equal((await lstat(renamed)).isSymbolicLink(), true);
  assert.equal(await readlink(renamed), "target");
  assert.equal(await readFile(join(root, "target"), "utf8"), "target content");
});

test("native Trash moves only test fixtures and preserves symlink targets", nativeMac, async t => {
  const root = await fixture(t);
  const prefix = `files-plus-test-${randomUUID()}`;
  // These fixtures are on the home volume and have unique names, so their Trash
  // paths are known without listing or deleting anything else in the user's Trash.
  const trashed = [join(homedir(), ".Trash", `${prefix}-link`), join(homedir(), ".Trash", `${prefix}-folder`)];
  t.after(async () => {
    for (const path of trashed) await rm(path, { recursive: true, force: true });
  });
  const files = createFilesystem(executor);
  const target = join(root, "target");
  await writeFile(target, "target survives");
  const link = join(root, `${prefix}-link`);
  await symlink(target, link);
  assert.equal(await files.trash(link), link);
  await assert.rejects(() => lstat(link), { code: "ENOENT" });
  assert.equal((await lstat(trashed[0])).isSymbolicLink(), true);
  assert.equal(await readFile(target, "utf8"), "target survives");
  const folder = join(root, `${prefix}-folder`);
  await mkdir(folder);
  await writeFile(join(folder, "content"), "trash fixture");
  await files.trash(folder);
  await assert.rejects(() => lstat(folder), { code: "ENOENT" });
  assert.equal(await readFile(join(trashed[1], "content"), "utf8"), "trash fixture");
});
