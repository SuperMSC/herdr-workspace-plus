import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { HUNK_READ, patchHunks, hunkFileAllowed } from "../mods/files-plus/hunk-model.js";
import { readHunkSource } from "../mods/files-plus/hunk-reader.js";
import { applyHunk } from "../mods/files-plus/hunk-helper.mjs";
const exec = promisify(execFile);
const identity = { ...process.env, GIT_AUTHOR_NAME: "Hunk Fixture", GIT_AUTHOR_EMAIL: "hunk@example.invalid", GIT_COMMITTER_NAME: "Hunk Fixture", GIT_COMMITTER_EMAIL: "hunk@example.invalid" };
async function command(root, args, { env = identity, input } = {}) {
  if (input !== undefined) return new Promise((resolve, reject) => {
    const process = spawn("git", args, { cwd: root, env }); const out = [], err = [];
    process.stdout.on("data", value => out.push(value)); process.stderr.on("data", value => err.push(value)); process.on("error", reject);
    process.on("close", code => resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() })); process.stdin.end(input);
  });
  try { const result = await exec("git", args, { cwd: root, env, encoding: "utf8" }); return { code: 0, ...result }; }
  catch (error) { return { code: error.code, stdout: error.stdout || "", stderr: error.stderr || error.message }; }
}
async function git(root, args, options) { const result = await command(root, args, options); assert.equal(result.code, 0, result.stderr); return result.stdout; }
async function indexFile(root, name, env = identity) {
  const hash = (await git(root, ["hash-object", "-w", "--no-filters", "--", name])).trim();
  await git(root, ["update-index", "--add", "--cacheinfo", `100644,${hash},${name}`], { env });
}
async function fixture(t, name = "file.txt", noNewline = false) {
  const root = await fs.mkdtemp("/private/tmp/herdr-hunk-fixture-"); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ["init", "--quiet", "--initial-branch=main"]);
  const before = Array.from({ length: 45 }, (_, index) => `line ${index + 1}`).join("\n") + (noNewline ? "" : "\n");
  await fs.writeFile(path.join(root, name), before); await fs.writeFile(path.join(root, "other.txt"), "other baseline\n");
  await indexFile(root, name); await indexFile(root, "other.txt");
  const tree = (await git(root, ["write-tree"])).trim(), commit = (await git(root, ["commit-tree", tree, "-m", "Baseline"])).trim();
  await git(root, ["update-ref", "HEAD", commit]);
  const after = before.replace("line 2\n", "first change\n").replace("line 43\n", "second change\n");
  await fs.writeFile(path.join(root, name), after);
  const file = { path: name, section: "unstaged", status: "M" }, read = entry => readHunkSource((_command, args) => command(root, args), { root }, entry || file);
  const request = async (action = "stage", hunkIndex = 0) => {
    const source = await read({ ...file, section: action === "stage" ? "unstaged" : "staged" });
    return { root, on: null, action, file: source.file, version: source.version, hunk: source.hunks[hunkIndex] };
  };
  return { root, name, before, after, file, read, request };
}

test("one hunk stages and unstages without changing working content or another staged file", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "other.txt"), "other already staged\n"); await indexFile(f.root, "other.txt");
  const originalWork = await fs.readFile(path.join(f.root, f.name));
  assert.equal((await f.read()).hunks.length, 2);
  await applyHunk(await f.request());
  const index = await git(f.root, ["show", `:${f.name}`]);
  assert.match(index, /first change/); assert.doesNotMatch(index, /second change/);
  assert.equal(await git(f.root, ["show", ":other.txt"]), "other already staged\n");
  assert.deepEqual(await fs.readFile(path.join(f.root, f.name)), originalWork);
  await applyHunk(await f.request("unstage"));
  assert.equal(await git(f.root, ["show", `:${f.name}`]), f.before);
  assert.deepEqual(await fs.readFile(path.join(f.root, f.name)), originalWork);
  assert.equal(await git(f.root, ["show", ":other.txt"]), "other already staged\n");
});

test("literal Unicode, quotes, spaces, glob-like, leading-dash and newline paths work", async t => {
  for (const name of ["中文 '$() ;.txt", "--anything", ":(glob)*.txt", "line\nbreak.txt", "a,b.txt"]) {
    const f = await fixture(t, name);
    await git(f.root, ["config", "diff.noprefix", "true"]);
    await applyHunk(await f.request());
    assert.match(await git(f.root, ["show", `:${f.name}`]), /first change/);
    assert.deepEqual(await fs.readFile(path.join(f.root, name), "utf8"), f.after);
    await applyHunk(await f.request("unstage")); assert.equal(await git(f.root, ["show", `:${f.name}`]), f.before);
  }
});

test("EOF without newline survives hunk stage and reverse", async t => {
  const f = await fixture(t, "no-newline.txt", true);
  await fs.writeFile(path.join(f.root, f.name), f.after.replace(/line 45$/, "last line changed"));
  const request = await f.request("stage", 1); assert.match(request.hunk.patch, /No newline at end of file/);
  await applyHunk(request);
  const index = await git(f.root, ["show", `:${f.name}`]); assert.equal(index.endsWith("\n"), false); assert.match(index, /last line changed$/);
  await applyHunk(await f.request("unstage")); assert.equal(await git(f.root, ["show", `:${f.name}`]), f.before);
});

test("changed working source, changed index and a changed HEAD reject a captured hunk", async t => {
  for (const which of ["working", "index", "head"]) {
    const f = await fixture(t), request = await f.request(), initial = await fs.readFile(path.join(f.root, ".git/index"));
    if (which === "working") await fs.appendFile(path.join(f.root, f.name), "later work\n");
    if (which === "index") await indexFile(f.root, f.name);
    if (which === "head") {
      const tree = (await git(f.root, ["write-tree"])).trim(), parent = (await git(f.root, ["rev-parse", "HEAD"])).trim();
      const commit = (await git(f.root, ["commit-tree", tree, "-p", parent, "-m", "Later head"])).trim(); await git(f.root, ["update-ref", "HEAD", commit]);
    }
    const expected = await fs.readFile(path.join(f.root, ".git/index"));
    await assert.rejects(() => applyHunk(request), /changed|modified/i);
    assert.deepEqual(await fs.readFile(path.join(f.root, ".git/index")), expected);
    await assert.rejects(() => fs.stat(path.join(f.root, ".git/index.lock")), { code: "ENOENT" });
    if (which !== "index") assert.deepEqual(expected, initial);
  }
});

test("an existing Git lock is preserved and the index remains byte-identical", async t => {
  const f = await fixture(t), request = await f.request(), index = await fs.readFile(path.join(f.root, ".git/index"));
  await fs.writeFile(path.join(f.root, ".git/index.lock"), "someone else's lock");
  await assert.rejects(() => applyHunk(request), /holds the index lock/);
  assert.equal(await fs.readFile(path.join(f.root, ".git/index.lock"), "utf8"), "someone else's lock");
  assert.deepEqual(await fs.readFile(path.join(f.root, ".git/index")), index);
});

test("an external index replacement during apply is retained instead of overwritten", async t => {
  const f = await fixture(t), request = await f.request(), indexPath = path.join(f.root, ".git/index"), foreign = path.join(f.root, "foreign-index");
  await fs.copyFile(indexPath, foreign);
  await fs.writeFile(path.join(f.root, "other.txt"), "concurrent change\n");
  await indexFile(f.root, "other.txt", { ...identity, GIT_INDEX_FILE: foreign });
  const expected = await fs.readFile(foreign); let replaced = false;
  await assert.rejects(() => applyHunk(request, { execute: async (args, options = {}) => {
    const result = await command(f.root, [...HUNK_READ, ...args], { ...options, env: options.env || identity });
    if (args.includes("--check") && !replaced) { replaced = true; await fs.writeFile(indexPath, expected); }
    return result;
  } }), /checkout changed/i);
  assert.equal(replaced, true); assert.deepEqual(await fs.readFile(indexPath), expected);
  assert.equal(await git(f.root, ["show", ":other.txt"]), "concurrent change\n");
  assert.equal(await git(f.root, ["show", `:${f.name}`]), f.before);
  assert.equal((await fs.readdir(path.join(f.root, ".git"))).some(name => name.startsWith(".files-plus-hunk-")), false);
  await assert.rejects(() => fs.stat(indexPath + ".lock"), { code: "ENOENT" });
});

test("modified or mismatched patch payloads reject before publication", async t => {
  const f = await fixture(t), request = await f.request(), index = await fs.readFile(path.join(f.root, ".git/index"));
  for (const hunk of [{ ...request.hunk, patch: request.hunk.patch + "+poison\n" }, { ...request.hunk, header: "@@ -99 +99 @@" }, { ...request.hunk, index: 99 }]) {
    await assert.rejects(() => applyHunk({ ...request, hunk }), /changed/i);
    assert.deepEqual(await fs.readFile(path.join(f.root, ".git/index")), index);
  }
  await assert.rejects(() => applyHunk({ ...request, on: "remote" }), /local/);
});

test("binary, conflicted, added, removed, history, mode-change and incomplete patches cannot enable actions", async t => {
  for (const file of [{ section: "history", status: "M" }, { section: "unstaged", status: "A" }, { section: "unstaged", status: "M", binary: true }, { section: "staged", status: "M", xy: "UU" }, { section: "unstaged", status: "M", xy: "AM" }, { section: "staged", status: "M", xy: "MT" }, { section: "unstaged", status: "D", deleted: true }]) assert.equal(hunkFileAllowed({ path: "file", ...file }), false);
  const f = await fixture(t), source = await f.read();
  assert.throws(() => patchHunks(source.patch.replace("index ", "old mode 100644\nindex ")), /normal modified/);
  assert.throws(() => patchHunks(source.patch.slice(0, -2)), /complete|limit/i);
  await fs.writeFile(path.join(f.root, f.name), Buffer.from([0, 1, 2]));
  await assert.rejects(() => f.read(), /single-file text/);
});


test("cancellation after the isolated apply check releases only its own lock and publishes nothing", async t => {
  const f = await fixture(t), request = await f.request(), original = await fs.readFile(path.join(f.root, ".git/index")), controller = new AbortController();
  await assert.rejects(() => applyHunk(request, { signal: controller.signal, execute: async (args, options = {}) => {
    const result = await command(f.root, [...HUNK_READ, ...args], { ...options, env: options.env || identity });
    if (args.includes("--check")) controller.abort();
    return result;
  } }), /cancelled/);
  assert.deepEqual(await fs.readFile(path.join(f.root, ".git/index")), original);
  assert.equal(await fs.readFile(path.join(f.root, f.name), "utf8"), f.after);
  await assert.rejects(() => fs.stat(path.join(f.root, ".git/index.lock")), { code: "ENOENT" });
  assert.equal((await fs.readdir(path.join(f.root, ".git"))).some(name => name.startsWith(".files-plus-hunk-")), false);
});

test("simultaneous captured actions cannot overwrite or silently double-apply each other's index version", async t => {
  const f = await fixture(t), first = await f.request("stage", 0), second = await f.request("stage", 1);
  const results = await Promise.allSettled([applyHunk(first), applyHunk(second)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  const index = await git(f.root, ["show", `:${f.name}`]);
  assert.notEqual(index.includes("first change"), index.includes("second change"));
  assert.equal(await fs.readFile(path.join(f.root, f.name), "utf8"), f.after);
  await assert.rejects(() => fs.stat(path.join(f.root, ".git/index.lock")), { code: "ENOENT" });
});
