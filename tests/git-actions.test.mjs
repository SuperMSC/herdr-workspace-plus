import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, rmdir, symlink, readlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { fileKey, fileTree, diffRows, splitRows, splitDisplay, inlineDisplay, diffCounts, treeFolders } from "../mods/files-plus/git-model.js";
import { createGitReader, READ } from "../mods/files-plus/git-reader.js";
import { createGitActions } from "../mods/files-plus/git-actions.js";

const run = promisify(execFile);
const scratch = resolve(dirname(fileURLToPath(import.meta.url)), "../.scratch");
const identity = { ...process.env, GIT_AUTHOR_NAME: "Files Plus Test", GIT_AUTHOR_EMAIL: "files-plus-test@example.invalid", GIT_COMMITTER_NAME: "Files Plus Test", GIT_COMMITTER_EMAIL: "files-plus-test@example.invalid" };

async function execute(command, args, { cwd } = {}) {
  try {
    const { stdout, stderr } = await run(command, args, { cwd, env: identity, encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout || "", stderr: error.stderr || error.message };
  }
}

async function git(root, ...args) {
  const result = await execute("git", args, { cwd: root });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}

async function repository(t) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "git-actions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "--quiet", "--initial-branch=main");
  return { root, actions: createGitActions(execute, { root, platform: "macos" }) };
}

async function recordHead(root) {
  const tree = (await git(root, "write-tree")).trim();
  const commit = (await git(root, "-c", "commit.gpgsign=false", "commit-tree", tree, "-m", "Fixture baseline")).trim();
  await git(root, "update-ref", "HEAD", commit);
}

async function stagedPaths(root) {
  return (await git(root, "diff", "--cached", "--name-only", "-z")).split("\0").filter(Boolean).sort();
}

after(async () => {
  try { await rmdir(scratch); }
  catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; }
});

test("Git actions reject remote spaces, other platforms and escaping paths before exec", async () => {
  let calls = 0;
  const executor = () => { calls++; };
  for (const options of [{ root: "/repo", on: "remote" }, { root: "/repo", platform: "linux" }, { root: "/repo", platform: "windows" }, { root: "relative" }]) {
    const actions = createGitActions(executor, options);
    await assert.rejects(() => actions.stage("file"));
    await assert.rejects(() => actions.unstage("file"));
  }
  const local = createGitActions(executor, { root: "/repo" });
  for (const path of ["", "/etc/passwd", "..", "../other", "a/../b", "a//b", "nul\0file", "."]) {
    await assert.rejects(() => local.stage(path));
    await assert.rejects(() => local.unstage(path));
  }
  assert.equal(calls, 0);
});

test("stage/unstage preserve literal pathspec characters in an unborn repository", async t => {
  const { root, actions } = await repository(t);
  const names = ["*.txt", ":(glob)*.txt", "--all", " leading and trailing ", "中文 ' $() ;.txt", "line\nbreak.txt"];
  await writeFile(join(root, "unrelated.txt"), "never stage me");
  for (const name of names) {
    await writeFile(join(root, name), "original");
    assert.equal(await actions.stage(name), name);
    assert.deepEqual(await stagedPaths(root), [name]);
    await writeFile(join(root, name), "newer working content");
    assert.equal(await actions.unstage(name), name);
    assert.deepEqual(await stagedPaths(root), []);
    assert.equal(await readFile(join(root, name), "utf8"), "newer working content");
  }
  assert.equal(await readFile(join(root, "unrelated.txt"), "utf8"), "never stage me");
});

test("unstage against HEAD restores only the selected index entry and preserves working files", async t => {
  const { root, actions } = await repository(t);
  for (const name of ["one", "two"]) { await writeFile(join(root, name), "baseline"); await actions.stage(name); }
  await recordHead(root);
  for (const name of ["one", "two"]) { await writeFile(join(root, name), "staged"); await actions.stage(name); }
  await writeFile(join(root, "one"), "newer working content");
  await actions.unstage("one");
  assert.deepEqual(await stagedPaths(root), ["two"]);
  assert.equal(await git(root, "show", ":one"), "baseline");
  assert.equal(await readFile(join(root, "one"), "utf8"), "newer working content");
  assert.equal(await git(root, "show", ":two"), "staged");
});

test("stage and unstage a deletion without recreating or deleting working files", async t => {
  const { root, actions } = await repository(t);
  await writeFile(join(root, "gone"), "baseline");
  await actions.stage("gone");
  await recordHead(root);
  await rm(join(root, "gone"));
  await actions.stage("gone");
  assert.equal(await git(root, "diff", "--cached", "--name-status"), "D\tgone\n");
  await actions.unstage("gone");
  assert.deepEqual(await stagedPaths(root), []);
  await assert.rejects(() => readFile(join(root, "gone")), { code: "ENOENT" });
  assert.equal(await git(root, "show", ":gone"), "baseline");
});

test("unstage a new file against HEAD leaves its contents untouched", async t => {
  const { root, actions } = await repository(t);
  await recordHead(root);
  await writeFile(join(root, "new"), "new content");
  await actions.stage("new");
  await actions.unstage("new");
  assert.deepEqual(await stagedPaths(root), []);
  assert.equal(await readFile(join(root, "new"), "utf8"), "new content");
});

test("staging a symlink keeps the symlink and never stages its target", async t => {
  const { root, actions } = await repository(t);
  await writeFile(join(root, "target"), "untouched target");
  await symlink("target", join(root, "link"));
  await actions.stage("link");
  assert.match(await git(root, "ls-files", "--stage"), /^120000 /);
  assert.deepEqual(await stagedPaths(root), ["link"]);
  await actions.unstage("link");
  assert.equal(await readlink(join(root, "link")), "target");
  assert.equal(await readFile(join(root, "target"), "utf8"), "untouched target");
});

test("all actions use literal pathspecs and pass selected paths after --", async () => {
  const calls = [];
  const actions = createGitActions(async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: args.includes("rev-parse") ? 1 : 0, stdout: "", stderr: "" };
  }, { root: "/repository" });
  await actions.stage(":(glob)**");
  await actions.unstage(":(glob)**");
  assert.deepEqual(calls.map(call => call.args), [
    ["--literal-pathspecs", "add", "--", ":(glob)**"],
    ["--literal-pathspecs", "rev-parse", "--verify", "--quiet", "HEAD"],
    ["--literal-pathspecs", "rm", "--cached", "-f", "--ignore-unmatch", "--", ":(glob)**"],
  ]);
  assert.ok(calls.every(call => call.command === "git" && call.options.cwd === "/repository" && call.options.on === null));
});

test("a repository error does not fall back to unborn index removal", async () => {
  const calls = [];
  const actions = createGitActions(async (_command, args) => {
    calls.push(args);
    return { code: 128, stdout: "", stderr: "not a repository" };
  }, { root: "/not-a-repository" });
  await assert.rejects(() => actions.unstage("file"), /not a repository/);
  assert.equal(calls.length, 1);
});

async function changesClass(overrides = {}) {
  let source = await readFile(new URL("../mods/files-plus/changes.js", import.meta.url), "utf8");
  source = source.replace(/^import .+;$/gm, "").replace("export default class Changes {", "return class Changes {");
  const values = {
    projectContext: () => ({ cwd: "/fixture", on: null }), fileKey, fileTree, diffRows, splitRows, splitDisplay, inlineDisplay, diffCounts, treeFolders, splitHeader: () => null, createGitReader, READ, VirtualListScrollHandle: { new: () => ({ scroll_to_item() {}, release() {} }) },
    spaces: () => [{ active: true, folder: "/fixture", machine: null }], panes: () => [], focused: () => ({}),
    exec: async () => ({ code: 0, stdout: "", stderr: "" }), readTextFile: async () => "", watchFolder: () => new Promise(() => {}),
    window: () => ({ platform: "macos" }), theme: () => ({}), settings: () => ({}), openOverlay() {},
    shared: () => null, setShared() {}, InputState: { new: () => ({ on() {}, set_value() {}, value: () => "" }) },
    targetFor: (root, relative, dir, on, platform) => ({ root, relative, dir, on, platform }), menuHeight: () => 400, CHANGE_KEY: "files-plus.change",
    ...overrides,
  };
  return new Function(...Object.keys(values), source)(...Object.values(values));
}

function context() {
  const pending = [];
  const cx = { notify() {}, stop_propagation() {}, focus_handle: () => ({}), timer: { every() {} }, spawn(callback) { const task = callback(cx); pending.push(task); } };
  return { cx, async drain() { while (pending.length) await pending.shift(); } };
}

test("same-path diff requests cannot overwrite a newer response", async () => {
  const responses = [];
  const Changes = await changesClass({ readTextFile: () => new Promise(resolve => responses.push(resolve)) });
  const changes = new Changes();
  Object.assign(changes, { context: JSON.stringify({ cwd: "/fixture", on: null }), root: "/fixture", on: null, open: "file", files: [{ path: "file", fresh: true }], diffRequest: 0 });
  const first = changes.load("file", changes.context), second = changes.load("file", changes.context);
  responses[1]("new response\n"); await second;
  responses[0]("old response\n"); await first;
  assert.ok(changes.rows.some(row => row.text === "new response"));
  assert.ok(!changes.rows.some(row => row.text === "old response"));
});

test("an index change during refresh queues another refresh instead of losing it", async () => {
  let change = null, statusCalls = 0, holdStatus, releaseStatus;
  const Changes = await changesClass({ shared: () => change, exec: async (_command, args) => {
    if (args.includes("--show-toplevel")) return { code: 0, stdout: "/fixture\n", stderr: "" };
    if (args.includes("--porcelain=v1")) {
      statusCalls++;
      if (holdStatus) { holdStatus = false; await new Promise(resolve => { releaseStatus = resolve; }); }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args.includes("rev-parse")) return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  } });
  const changes = new Changes(), harness = context();
  changes.init({}, harness.cx); changes.watch = () => {};
  await harness.drain();
  holdStatus = true; changes.refresh(harness.cx);
  while (!releaseStatus) await new Promise(resolve => setImmediate(resolve));
  change = { target: { root: "/fixture", on: null }, revision: 1, action: "stage" };
  changes.consumeChange(harness.cx);
  assert.equal(changes.reloadAgain, true);
  releaseStatus(); await harness.drain();
  assert.equal(statusCalls, 3);
});

test("Commit Staged never invokes add and is disabled without staged changes", async () => {
  const calls = [];
  const Changes = await changesClass({ exec: async (_command, args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; } });
  const changes = new Changes(), harness = context();
  Object.assign(changes, { context: JSON.stringify({ cwd: "/fixture", on: null }), root: "/fixture", on: null, message: "Explicit message", hasStaged: false, input: { set_value() {} } });
  changes.refresh = () => {};
  changes.commit(harness.cx); await harness.drain(); assert.deepEqual(calls, []);
  changes.hasStaged = true; changes.commit(harness.cx); await harness.drain();
  assert.deepEqual(calls, [["commit", "-m", "Explicit message"]]);
});
