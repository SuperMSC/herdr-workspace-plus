import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as model from "../mods/files-plus/graph-model.js";
import { readGraphRepository, createGraphClient } from "../mods/files-plus/graph-reader.js";
import { boundedGraphExec } from "../mods/files-plus/graph-helper.mjs";
const hash = n => n.toString(16).padStart(40, "0");
const commit = (n, parents = []) => ({ hash: hash(n), parents: parents.map(hash), author: "Fixture", time: 1700000000, subject: `Commit ${n}` });
const helper = fileURLToPath(new URL("../mods/files-plus/graph-helper.mjs", import.meta.url));
async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), "graph-fixture-")); t.after(() => fs.rm(root, { recursive: true, force: true })); const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, encoding: "utf8" }); git("init", "-q"); return { root, git }; }

test("topological merge lanes preserve both parents, boundaries and ref labels", () => {
  const rows = model.graphRows([commit(4, [2, 3]), commit(3, [1]), commit(2, [1]), commit(1, [9])], [{ name: "refs/heads/main", label: "main", hash: hash(4) }], hash(4));
  assert.equal(rows[0].edges.filter(edge => edge.kind === "out").length, 2); assert.equal(rows[0].head, true); assert.deepEqual(rows[0].refs, ["main"]);
  assert.equal(rows[3].boundary, 1); assert.equal(rows[3].edges.filter(edge => edge.kind === "out").length, 0); assert(rows.some(row => row.width === 2));
  assert.throws(() => model.graphRows([commit(1), commit(2, [1])]), /out of order/);
  assert.throws(() => model.graphRows([commit(1), commit(1)]), /invalid/);
});
test("graph formats retain Unicode and punctuation and reject invalid hashes and oversized payloads", () => {
  const text = `${hash(2)}\x00${hash(1)}\x00作者\x001700000000\x00quoted '; $(literal)\x00\n`;
  const result = model.parseGraphLog(text); assert.equal(result.commits[0].author, "作者"); assert.match(result.commits[0].subject, /literal/);
  const refs = model.parseGraphRefs(`refs/heads/feat/a\x00${hash(2)}\x00\nrefs/tags/v1\x00${hash(3)}\x00${hash(2)}\n`);
  assert.equal(refs.refs[1].hash, hash(2)); assert.equal(refs.refs[1].label, "tag: v1");
  assert.throws(() => model.parseGraphLog("x".repeat(700001)), /limit/); assert.throws(() => model.parseGraphLog("bad\x00\x00a\x001\x00s\x00"), /invalid/);
  const many = Array.from({ length: 201 }, (_, i) => `${hash(1000 - i)}\x00\x00a\x00${1700000000}\x00s\x00\n`).join("");
  assert(model.parseGraphLog(many).limited); assert.equal(model.parseGraphLog(many).commits.length, 200);
});
test("actual Git helper reads all branches, annotated tags and merge history without changing the index", async t => {
  const { root, git } = await fixture(t); await fs.writeFile(path.join(root, "base.txt"), "base\n"); git("add", "--", "base.txt"); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD").trim(), main = git("branch", "--show-current").trim();
  git("switch", "-qc", "feature/literal-$x"); await fs.writeFile(path.join(root, "feature.txt"), "feature\n"); git("add", "--", "feature.txt"); git("commit", "-qm", "feature"); const feature = git("rev-parse", "HEAD").trim();
  git("switch", "-q", main); await fs.writeFile(path.join(root, "main.txt"), "main\n"); git("add", "--", "main.txt"); git("commit", "-qm", "main"); git("merge", "--no-ff", "-qm", "merge fixture", "feature/literal-$x"); git("tag", "-a", "v1", "-m", "fixture tag"); await fs.writeFile(path.join(root, "base.txt"), "dirty\n");
  const before = await fs.readFile(path.join(root, ".git/index")); const result = JSON.parse(execFileSync(process.execPath, [helper, JSON.stringify({ context: { cwd: root, on: null }, selection: "all" })], { encoding: "utf8", env: { ...process.env, GIT_DIR: "/invalid/inherited-git-dir" } }));
  const data = model.validateGraphData(result); assert.equal(data.rows.length, 4); assert.equal(data.rows[0].parents.length, 2); assert(data.refs.some(ref => ref.label === "tag: v1")); assert(data.rows.some(row => row.hash === base));
  const filtered = model.validateGraphData(await readGraphRepository(boundedGraphExec, { cwd: root }, "refs/heads/feature/literal-$x")); assert.equal(filtered.rows.length, 2); assert.equal(filtered.rows[0].hash, feature);
  assert.deepEqual(await fs.readFile(path.join(root, ".git/index")), before); assert.equal(await fs.readFile(path.join(root, "base.txt"), "utf8"), "dirty\n");
});
test("empty repositories are explicit and stale branch selections do not fall back to another ref", async t => {
  const { root, git } = await fixture(t); const empty = await readGraphRepository(boundedGraphExec, { cwd: root }); assert.deepEqual(empty.commits, []); assert.equal(empty.head, null);
  await assert.rejects(readGraphRepository(boundedGraphExec, { cwd: root }, "refs/heads/missing"), /no longer/);
  assert.equal(git("status", "--porcelain"), "");
});
test("remote graph reads keep their captured machine and never invoke the local helper", async () => {
  const calls = [], execute = async (program, args, options) => { calls.push({ program, args, options }); if (args.includes("--show-toplevel")) return { code: 0, stdout: "/remote/root\n" }; if (args.includes("for-each-ref")) return { code: 0, stdout: `refs/heads/main\x00${hash(1)}\x00\n` }; if (args.includes("--quiet")) return { code: 0, stdout: hash(1) + "\n" }; return { code: 0, stdout: `${hash(1)}\x00\x00a\x00${1700000000}\x00remote\x00\n` }; };
  const result = await createGraphClient(execute, "/local/home")({ cwd: "/remote", on: "server" }, "all"); assert.equal(result.root, "/remote/root"); assert(calls.every(call => call.program === "git" && call.options.on === "server"));
  await assert.rejects(createGraphClient(async () => { throw new Error("offline"); }, "/local")({ cwd: "/remote", on: "server" }, "all"), /offline/);
});
test("graph process reads have hard output and time limits", async () => {
  await assert.rejects(boundedGraphExec(process.execPath, ["-e", "process.stdout.write('x'.repeat(800000))"], { cwd: os.tmpdir(), timeout: 1000 }), /limit/);
  await assert.rejects(boundedGraphExec(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: os.tmpdir(), timeout: 50 }), /timed out/);
});
