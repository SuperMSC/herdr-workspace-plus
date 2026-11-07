import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createGitReader, READ } from "../mods/files-plus/git-reader.js";
import { branchInfo, diffRows, splitRows, splitDisplay, inlineDisplay, diffCounts, treeFolders, fileTree, statusFiles, fileKey, PAGE_SIZE, lineMarks, expandTabs } from "../mods/files-plus/git-model.js";

const run = promisify(execFile);
const identity = { ...process.env, GIT_AUTHOR_NAME: "Git Preview Test", GIT_AUTHOR_EMAIL: "preview@example.invalid", GIT_COMMITTER_NAME: "Git Preview Test", GIT_COMMITTER_EMAIL: "preview@example.invalid" };
async function execute(command, args, { cwd } = {}) {
  try { return { code: 0, ...await run(command, args, { cwd, env: identity, encoding: "utf8" }) }; }
  catch (error) { return { code: error.code, stdout: error.stdout || "", stderr: error.stderr || error.message }; }
}
async function git(root, ...args) { const result = await execute("git", args, { cwd: root }); assert.equal(result.code, 0, result.stderr); return result.stdout; }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "herdr-git-preview-")); t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "--quiet", "--initial-branch=main");
  return { root, reader: createGitReader(execute, path => readFile(path, "utf8"), { root }) };
}
async function record(root, subject, parents) {
  const tree = (await git(root, "write-tree")).trim();
  if (!parents) { const head = await execute("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: root }); parents = head.code === 0 ? [head.stdout.trim()] : []; }
  const hash = (await git(root, "-c", "commit.gpgsign=false", "commit-tree", tree, ...parents.flatMap(parent => ["-p", parent]), "-m", subject)).trim();
  await git(root, "update-ref", "HEAD", hash); return hash;
}

test("partially staged file reads separate index and worktree content and counts", async t => {
  const { root, reader } = await fixture(t), path = ":(glob)*\tfile.txt";
  await writeFile(join(root, path), "baseline\n"); await git(root, "--literal-pathspecs", "add", "--", path); await record(root, "Baseline");
  await writeFile(join(root, path), "staged\n"); await git(root, "--literal-pathspecs", "add", "--", path);
  await writeFile(join(root, path), "working\nextra\n");
  const snapshot = await reader.snapshot(); assert.equal(snapshot.count, 1);
  const staged = snapshot.files.find(file => file.section === "staged"), unstaged = snapshot.files.find(file => file.section === "unstaged");
  assert.equal(staged.path, path); assert.notEqual(fileKey(staged), fileKey(unstaged));
  assert.equal(staged.add, 1); assert.equal(unstaged.add, 2);
  assert.deepEqual((await reader.diff(staged)).lines.slice(1), ["-baseline", "+staged"]);
  assert.deepEqual((await reader.diff(unstaged)).lines.slice(1), ["-staged", "+working", "+extra"]);
  assert.equal((await git(root, "show", `:${path}`)), "staged\n");
});

test("unborn staged additions come from the index and untracked files use working content", async t => {
  const { root, reader } = await fixture(t);
  await writeFile(join(root, "new"), "index version\n"); await git(root, "add", "--", "new");
  await writeFile(join(root, "new"), "working version\n"); await writeFile(join(root, "untracked"), "not staged\n");
  const snapshot = await reader.snapshot(); assert.equal(snapshot.branch.unborn, true);
  const staged = snapshot.files.find(file => file.section === "staged");
  assert.ok((await reader.diff(staged)).lines.includes("+index version"));
  assert.ok(!(await reader.diff(staged)).lines.includes("+working version"));
  assert.deepEqual((await reader.diff(snapshot.files.find(file => file.fresh))).lines, ["@@ -0,0 +1,1 @@", "+not staged"]);
  assert.deepEqual(await reader.history(), { commits: [], more: false });
});

test("history pages are bounded and root, normal and merge commits compare the right trees", async t => {
  const { root, reader } = await fixture(t);
  await writeFile(join(root, "file"), "root\n"); await git(root, "add", "--", "file");
  const initial = await record(root, "Initial commit");
  await writeFile(join(root, "file"), "second\n"); await git(root, "add", "--", "file"); const second = await record(root, "Second commit");
  const side = await record(root, "Side commit", [initial]);
  await writeFile(join(root, "file"), "merged\n"); await git(root, "add", "--", "file"); const merge = await record(root, "Merge commit", [second, side]);
  for (let i = 0; i < PAGE_SIZE; i++) await record(root, `Extra ${i}`);
  const firstPage = await reader.history(), secondPage = await reader.history(PAGE_SIZE);
  assert.equal(firstPage.commits.length, PAGE_SIZE); assert.equal(firstPage.more, true); assert.equal(secondPage.more, false);
  assert.equal(new Set([...firstPage.commits, ...secondPage.commits].map(commit => commit.hash)).size, PAGE_SIZE + 4);
  const rootFiles = await reader.files({ hash: initial, parents: [] }); assert.equal(rootFiles[0].status, "A"); assert.ok((await reader.diff(rootFiles[0])).lines.includes("+root"));
  const mergeFiles = await reader.files({ hash: merge, parents: [second, side] });
  assert.deepEqual((await reader.diff(mergeFiles[0])).lines.slice(1), ["-second", "+merged"]);
  const indexBefore = await git(root, "write-tree"); await reader.files({ hash: second, parents: [initial] }); assert.equal(await git(root, "write-tree"), indexBefore);
});

test("binary and deleted file previews remain readable without touching working files", async t => {
  const { root, reader } = await fixture(t);
  await writeFile(join(root, "binary"), Buffer.from([0, 1, 2])); await writeFile(join(root, "gone"), "old\n"); await git(root, "add", "--", "binary", "gone"); await record(root, "Before");
  await writeFile(join(root, "binary"), Buffer.from([0, 3, 2])); await rm(join(root, "gone"));
  const snapshot = await reader.snapshot();
  assert.deepEqual((await reader.diff(snapshot.files.find(file => file.path === "binary"))).lines, ["Binary file changed"]);
  assert.deepEqual((await reader.diff(snapshot.files.find(file => file.path === "gone"))).lines.slice(1), ["-old"]);
});

test("branch status parses upstream ahead/behind, detached and unborn states", () => {
  assert.deepEqual(branchInfo("# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n"), { name: "main", oid: "abc", upstream: "origin/main", ahead: 2, behind: 3, unborn: false });
  assert.equal(branchInfo("# branch.oid abcdef012345\n# branch.head (detached)\n").name, "Detached abcdef01");
  assert.equal(branchInfo("# branch.oid (initial)\n# branch.head main\n").unborn, true);
});

test("diff alignment retains both line numbers and gives blank cells for unequal edits", () => {
  const rows = diffRows(["@@ -8,3 +8,4 @@", " old", "-before", "+after", "+extra", " last"]);
  assert.deepEqual(rows[1], { kind: " ", old: 8, next: 8, text: "old" });
  const split = splitRows(rows); assert.equal(split[2].before.old, 9); assert.equal(split[2].after.next, 9);
  assert.equal(split[3].before, undefined); assert.equal(split[3].after.next, 10); assert.equal(split[4].before.old, 10); assert.equal(split[4].after.next, 11);
});

test("tree sections and collapsed directories preserve separate selections", () => {
  const { files } = statusFiles("MM src/a.js\0 M src/deep/b.js\0?? root\0");
  const staged = files.filter(file => file.section === "staged"), unstaged = files.filter(file => file.section === "unstaged");
  assert.equal(fileTree(staged)[0].key, "staged:src");
  assert.deepEqual(fileTree(unstaged, new Set(["unstaged:src"])).filter(row => !row.directory).map(row => row.path), ["root"]);
  assert.equal(fileTree(staged, new Set(["unstaged:src"])).filter(row => !row.directory).length, 1);
});

test("read-only remote commands retain host, disable external tools and validate revision/path input", async () => {
  const calls = [], reader = createGitReader(async (command, args, options) => { calls.push({ command, args, options }); return { code: 0, stdout: "", stderr: "" }; }, async () => "", { root: "/repo", on: "remote" });
  await reader.snapshot(); await reader.history(); await reader.diff({ path: "--anything", section: "staged" });
  assert.ok(calls.every(call => call.command === "git" && call.options.on === "remote" && call.args.includes("--literal-pathspecs") && READ.every(arg => call.args.includes(arg))));
  assert.ok(calls.at(-1).args.includes("--no-ext-diff")); assert.deepEqual(calls.at(-1).args.slice(-2), ["--", "--anything"]);
  const count = calls.length;
  await assert.rejects(() => reader.files({ hash: "--all", parents: [] }), /Invalid commit/);
  await assert.rejects(() => reader.diff({ path: "../outside", section: "unstaged" }), /Invalid repository/);
  await assert.rejects(() => reader.history(-1), /Invalid history/); assert.equal(calls.length, count);
});

test("missing, oversized and truncated untracked files have explicit preview outcomes", async () => {
  const file = { path: "missing", fresh: true, section: "unstaged" }, root = "/repo";
  const reader = read => createGitReader(() => { throw new Error("Untracked reads do not execute Git"); }, read, { root });
  await assert.rejects(() => reader(async () => null).diff(file), /File no longer exists/);
  await assert.rejects(() => reader(async () => { throw new Error("too large"); }).diff(file), /over 1 MiB/);
  const result = await reader(async () => "line\n".repeat(1600)).diff(file);
  assert.equal(result.additions, 1600); assert.equal(result.lines.length, 1502); assert.match(result.lines.at(-1), /truncated/);
});

function element() {
  const node = { children: [], attributes: {}, events: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key === "child") return child => { target.children.push(child); return proxy; };
    if (key === "children") return children => { target.children.push(...children); return proxy; };
    if (key === "when") return (condition, callback) => condition ? callback(proxy) : proxy;
    if (String(key).startsWith("on_")) return (...args) => { target.events[key] = args.at(-1); return proxy; };
    if (key in target) return target[key];
    return value => { target.attributes[key] = value; return proxy; };
  } });
  return proxy;
}
async function changesHarness() {
  let source = await readFile(new URL("../mods/files-plus/changes.js", import.meta.url), "utf8");
  source = source.replace(/^import .+;$/gm, "").replace("export default class Changes {", "return class Changes {");
  let active = "/fixture", change = null, notifications = 0;
  const pending = [], timers = [], overlays = [], calls = [];
  const cx = { notify() { notifications++; }, stop_propagation() {}, focus_handle: () => ({ focus() {} }), spawn(task) { pending.push(task(cx)); }, timer: { every() {}, after(_ms, task) { timers.push(task); } } };
  const dependencies = {
    projectContext: () => ({ cwd: active, on: null }), closeButton: element, v_resizable: element, resizable_panel: element, fileIcon: element, div: element, svg: element, h_flex: element, v_flex: element, fileKey, fileTree, diffRows, splitRows, splitDisplay, inlineDisplay, diffCounts, treeFolders, splitHeader: () => null, createGitReader, READ,
    diffView: () => element().id("diff-preview"), theme: () => ({}), settings: () => ({}), window: () => ({ platform: "macos" }),
    Input: { new: element }, InputState: { new: () => ({ on() {}, set_value() {}, release() {} }) }, VirtualListScrollHandle: { new: () => ({ scroll_to_item() {}, release() {} }) },
    spaces: () => [{ active: true, folder: active }], focused: () => ({}), panes: () => [], shared: () => change, setShared() {}, CHANGE_KEY: "changes", targetFor() {}, menuHeight: () => 200,
    openOverlay: spec => overlays.push(spec), watchFolder: () => new Promise(() => {}), readTextFile: async () => "",
    exec: async (_command, args, options) => { calls.push({ args, options }); return { code: 0, stdout: args.includes("--show-toplevel") ? `${options.cwd}\n` : "", stderr: "" }; },
  };
  const Changes = new Function(...Object.keys(dependencies), source)(...Object.values(dependencies));
  const view = new Changes(); view.watch = () => {};
  return { view, cx, pending, timers, overlays, calls, setActive: value => { active = value; }, setChange: value => { change = value; }, notifications: () => notifications, async drain() { while (pending.length) await pending.shift(); } };
}

test("render defers context/shared invalidation and pinned expanded previews survive focus changes", async () => {
  const f = await changesHarness(); f.view.init({ source: { cwd: "/pinned", on: null }, expanded: true }, f.cx); await f.drain();
  f.setActive("/other"); const before = f.notifications(); f.view.render(f.cx); assert.equal(f.notifications(), before); assert.equal(f.timers.length, 0);
  f.setChange({ revision: 1, target: { root: "/pinned", on: null } });
  f.view.render(f.cx); f.view.render(f.cx); assert.equal(f.notifications(), before); assert.equal(f.timers.length, 1);
  f.timers.shift()(f.cx); await f.drain(); assert.equal(f.view.root, "/pinned");
  const calls = f.calls.length; f.view.close(); f.view.refresh(f.cx); await f.drain(); assert.equal(f.calls.length, calls);
});

test("history rejects late pages and late commit files after a newer selection", async () => {
  const f = await changesHarness(); f.view.init({}, f.cx); await f.drain();
  const pages = [], files = [];
  f.view.reader = () => ({ history: () => new Promise(resolve => pages.push(resolve)), files: commit => new Promise(resolve => files.push({ commit, resolve })), diff: async () => ({ lines: ["No text diff available"] }) });
  f.view.loadHistory(f.cx, true); f.view.loadHistory(f.cx, true);
  pages[1]({ commits: [{ hash: "b".repeat(40), parents: [], subject: "New" }], more: false });
  pages[0]({ commits: [{ hash: "a".repeat(40), parents: [], subject: "Old" }], more: true }); await f.drain();
  assert.equal(f.view.commits[0].subject, "New"); assert.equal(f.view.historyMore, false);
  f.view.page = "history";
  f.view.selectCommit({ hash: "a".repeat(40), parents: [] }, f.cx); f.view.selectCommit({ hash: "b".repeat(40), parents: [] }, f.cx);
  files[1].resolve([{ path: "new", section: "history", commit: "b".repeat(40) }]); files[0].resolve([{ path: "old", section: "history", commit: "a".repeat(40) }]); await f.drain();
  assert.equal(f.view.open, "new"); assert.equal(f.view.historyFiles[0].path, "new");
});

test("expanded preview captures the selected section, source machine and commit metadata", async () => {
  const f = await changesHarness(); f.view.init({ source: { cwd: "/repo", on: "remote" } }, f.cx); await f.drain();
  f.view.files = [{ path: "file", section: "staged" }, { path: "file", section: "unstaged" }]; f.view.open = "file"; f.view.section = "staged";
  f.view.expand(); const overlay = f.overlays[0];
  assert.equal(overlay.kind, "dialog"); assert.equal(overlay.props.selection.section, "staged"); assert.deepEqual(overlay.props.source, { cwd: "/repo", on: "remote" });
  assert.equal(overlay.props.expanded, true); assert.equal(overlay.width, 1100);
});

test("no-newline markers do not separate matching before/after replacement rows", () => {
  const rows = splitRows(diffRows(["@@ -1 +1 @@", "-before", "\\ No newline at end of file", "+after", "\\ No newline at end of file"]));
  assert.equal(rows[1].before.text, "before"); assert.equal(rows[1].after.text, "after");
  assert.match(rows[2].header.text, /Before \/ After: no newline/);
});

test("split display hides each hunk's common indentation and marks the changed span", () => {
  const pad = n => " ".repeat(n);
  const rows = diffRows(["@@ -1,3 +1,3 @@ SQL", ` ${pad(16)}WHERE`, `-${pad(20)}f4 = 'a'`, `+${pad(20)}f4 = 'b'`, "@@ -9 +9 @@", "-x\tone", "+x\ttwo"]);
  const shown = splitDisplay(splitRows(rows));
  assert.equal(shown[0].header.text, "@@ -1,3 +1,3 @@ SQL");
  assert.equal(shown[1].before.text, "WHERE"); assert.equal(shown[1].before, shown[1].after);
  assert.equal(shown[2].before.text, "    f4 = 'a'"); assert.equal(shown[2].after.text, "    f4 = 'b'");
  assert.deepEqual(shown[2].before.mark, [10, 11]); assert.deepEqual(shown[2].after.mark, [10, 11]);
  assert.equal(shown[4].before.text, "x   one"); assert.equal(shown[4].indent, 0);
  // The rows the inline view draws are untouched.
  assert.equal(rows[1].text, `${pad(16)}WHERE`); assert.equal(rows[2].mark, undefined);
});

test("line marks skip identical lines and lines sharing only whitespace", () => {
  assert.equal(lineMarks("same", "same"), null);
  assert.equal(lineMarks("  one", "  two"), null);
  assert.deepEqual(lineMarks("call(1)", "call(22)"), [[5, 6], [5, 7]]);
  assert.deepEqual(lineMarks("abc", "abXc"), [[2, 2], [2, 3]]);
  assert.equal(expandTabs("a\tb", 4), "a   b");
});

test("diff counts and tree folders cover every level, folded or not", () => {
  assert.deepEqual(diffCounts(diffRows(["@@ -1 +1,2 @@", "-a", "+b", "+c", " d"])), { removed: 1, added: 2 });
  const files = [{ path: "ETL/TB/main.py", section: "unstaged" }, { path: "ETL/x.py", section: "unstaged" }, { path: "top.py", section: "unstaged" }];
  assert.deepEqual(treeFolders(files), ["unstaged:ETL", "unstaged:ETL/TB"]);
  assert.deepEqual(fileTree(files, new Set(treeFolders(files))).map(row => row.path), ["ETL", "top.py"]);
});

test("inline display pairs removed and added lines for marks and hides the hunk's common indent", () => {
  const rows = diffRows(["@@ -1,3 +1,3 @@", "         keep", "-        call(1)", "-        gone()", "+        call(22)", "@@ -9 +9 @@", "+x"]);
  const shown = inlineDisplay(rows);
  assert.deepEqual(shown.map(row => row.text), ["@@ -1,3 +1,3 @@", "keep", "call(1)", "gone()", "call(22)", "@@ -9 +9 @@", "x"]);
  assert.deepEqual(shown[2].mark, [5, 6]); assert.deepEqual(shown[4].mark, [5, 7]); assert.equal(shown[3].mark, undefined);
  assert.equal(shown[2].old, 2); assert.equal(rows[2].text, "        call(1)");
});

test("a commit's whole diff keeps file and hunk lines and drops the per-file preamble", async () => {
  const hash = "a".repeat(40), parent = "b".repeat(40), calls = [];
  const out = ["diff --git a/x.py b/x.py", "index 1..2 100644", "--- a/x.py", "+++ b/x.py", "@@ -1 +1 @@", "-a", "+b",
    "diff --git a/img.png b/img.png", "new file mode 100644", "Binary files /dev/null and b/img.png differ", ""].join("\n");
  const reader = createGitReader(async (_c, args) => { calls.push(args); return { code: 0, stdout: out, stderr: "" }; }, async () => "", { root: "/repo" });
  const { lines } = await reader.commitDiff({ hash, parents: [parent] });
  assert.deepEqual(lines, ["diff --git a/x.py b/x.py", "@@ -1 +1 @@", "-a", "+b", "diff --git a/img.png b/img.png", "Binary files /dev/null and b/img.png differ"]);
  assert.ok(calls[0].includes(parent) && calls[0].includes(hash) && !calls[0].includes("--"));
  const shown = inlineDisplay(diffRows(lines));
  assert.equal(shown[0].kind, ""); assert.equal(shown[2].kind, "-");
  await assert.rejects(() => reader.commitDiff({ hash: "nope", parents: [] }), /Invalid commit/);
});
