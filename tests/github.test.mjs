import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as model from "../mods/files-plus/github-model.js";
import * as client from "../mods/files-plus/github-client.js";
import { githubProcess, localGithub } from "../mods/files-plus/github-helper.mjs";

const context = { root: "/fixture/project '$();", on: null };
const repo = model.githubRepo({ nameWithOwner: "example/repo", url: "https://github.com/example/repo" });
const head = "a".repeat(40);
const pr = (number = 1, extra = {}) => ({ number, title: `Literal 'quotes' $(never) #${number}`, url: `${repo.url}/pull/${number}`, state: "OPEN", isDraft: false, headRefName: number === 1 ? "feature/literal'$()" : "other", baseRefName: "main", headRefOid: head, updatedAt: "2026-11-11T00:00:00Z", reviewDecision: "REVIEW_REQUIRED", ...extra });
const check = (extra = {}) => ({ __typename: "CheckRun", name: "Test 'line' $(never)", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: `${repo.url}/actions/runs/99/job/88`, ...extra });
const threadData = (extra = {}) => ({ number: 1, headRefOid: head, hasNextPage: false, threads: [{ isResolved: false, isOutdated: false, path: "src/a'b.js", line: 12, body: "Please check the quoted argument.", url: `${repo.url}/pull/1#discussion_r1`, author: "reviewer" }], ...extra });
const detail = (number = 1) => {
  const checks = model.githubChecks([check(), check({ name: "Lint", conclusion: "SUCCESS" })], repo);
  return { pr: model.githubPr(pr(number, { body: "Fixture description" }), repo), checks, counts: model.githubCounts(checks), threads: model.githubThreads(threadData({ number }), repo, pr(number)).threads, threadsLimited: false, checksLimited: false, fetched: 1000 };
};
const list = () => ({ repo, prs: [pr(), pr(2)], branch: pr().headRefName, fetched: 1000, limited: false });
const reply = value => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

function fixtureExecute({ remote = false, branch = pr().headRefName, details = false, fail = null } = {}) {
  const calls = [];
  const execute = async (program, args, options) => {
    calls.push({ program, args, options });
    if (fail) throw fail;
    if (program === "env") { assert.deepEqual(args.slice(0, 3), ["-u", "GH_REPO", "gh"]); program = "gh"; args = args.slice(3); }
    if (program === "git") return { code: 0, stdout: branch + "\n", stderr: "" };
    if (args[0] === "repo") return reply(repo);
    if (args[0] === "pr" && args[1] === "list") return reply(args.includes("--head") ? [pr()] : [pr(2), pr()]);
    if (args[0] === "pr" && args[1] === "view") return reply({ ...pr(), statusCheckRollup: [check()] });
    if (args[0] === "api") return reply(threadData());
    if (args.includes("--json") && args[0] === "run") return reply({ headSha: head });
    if (args.includes("--log-failed")) return { code: 0, stdout: "failure output\n", stderr: "" };
    throw new Error("Unexpected fixture operation");
  };
  return { execute, calls };
}

test("captured contexts and repository HTTPS hosts reject unsafe or malformed identities", () => {
  assert.deepEqual(model.githubContext(context), context);
  for (const root of ["relative", "\0bad", "https://example.com"]) assert.throws(() => model.githubContext({ root }));
  assert.throws(() => model.githubContext({ root: "/p", on: "elsewhere/t5" }));
  for (const url of ["http://github.com/example/repo", "https://user@github.com/example/repo", "https://github.com/another/repo", "javascript:alert(1)"]) assert.throws(() => model.githubRepo({ nameWithOwner: repo.nameWithOwner, url }));
  for (const url of ["https://evil.test/example/repo/pull/1", "https://github.com/other/repo/pull/1", `${repo.url}/%2e%2e/evil`, `${repo.url}/a\\evil`, `file://${repo.url}`]) assert.equal(model.githubUrl(url, repo), null);
  assert.equal(model.githubUrl(`${repo.url}/pull/1#discussion_r1`, repo), `${repo.url}/pull/1#discussion_r1`);
});

test("list prefers the exact branch PR and bounds/deduplicates the open list", () => {
  const values = Array.from({ length: 40 }, (_, index) => pr(index + 1));
  const prs = model.githubList(values, [pr(99, { state: "MERGED" })], "branch", repo);
  assert.equal(prs.length, 40); assert.equal(prs[0].number, 99); assert.equal(prs[0].state, "MERGED");
  assert.equal(model.githubList([pr()], [pr()], "branch", repo).length, 1);
  assert.throws(() => model.githubPr({ ...pr(), url: `${repo.url}/pull/2` }, repo));
  assert.throws(() => model.githubJson("{broken"), /malformed/);
  assert.throws(() => model.githubJson("x".repeat(model.GITHUB_LIMITS.json + 1)), /limit/);
});

test("check counts keep skipped, cancelled and unknown states out of passed or pending", () => {
  const values = [check(), check({ conclusion: "SUCCESS" }), check({ status: "IN_PROGRESS", conclusion: null }), check({ conclusion: "SKIPPED" }), check({ conclusion: "CANCELLED" }), check({ conclusion: "NEW_STATE" }), { __typename: "StatusContext", context: "Legacy CI", state: "ERROR", targetUrl: "https://outside.example/check" }];
  const checks = model.githubChecks(values, repo), counts = model.githubCounts(checks);
  assert.deepEqual(counts, { passed: 1, failed: 2, pending: 1, skipped: 1, cancelled: 1, unknown: 1 });
  assert.equal(checks.at(-1).url, null);
  assert.equal(model.githubChecks(null, repo).length, 0);
  assert.throws(() => model.githubChecks([{ ...check(), __typename: "Unexpected" }], repo), /unsupported/);
});

test("review threads require one head version and retain explicit partial/outdated notices", () => {
  const value = model.githubThreads(threadData({ hasNextPage: true, threads: [...threadData().threads, { isResolved: true, isOutdated: false }] }), repo, pr());
  assert.equal(value.threads.length, 1); assert.equal(value.limited, true); assert.equal(value.threads[0].path, "src/a'b.js");
  assert.throws(() => model.githubThreads(threadData({ headRefOid: "b".repeat(40) }), repo, pr()), /head changed/);
  assert.throws(() => model.githubThreads({ number: 1, headRefOid: head }, repo, pr()), /invalid review/);
});

test("local operation uses only structured read commands and keeps quotes as argv data", async () => {
  const f = fixtureExecute();
  const result = await localGithub({ action: "list", context }, { execute: f.execute });
  assert.equal(result.prs[0].number, 1); assert.equal(f.calls.length, 4);
  assert(f.calls.every(call => call.options.cwd === context.root));
  assert.deepEqual(f.calls.at(-1).args.slice(-4), ["--head", pr().headRefName, "--limit", "1"]);
  assert(f.calls.every(call => !call.args.includes("-c") && !call.args.includes("--web") && !call.args.some(arg => ["merge", "rerun", "comment", "review", "checkout", "login"].includes(arg))));
  assert.throws(() => model.githubContext({ root: "/fixture\nwrong" }));
  const changed = fixtureExecute();
  await assert.rejects(localGithub({ action: "list", context, repo: { nameWithOwner: "other/repo", url: "https://github.com/other/repo" } }, { execute: changed.execute }), /repository.*changed/);
  assert.equal(changed.calls.length, 1);
});

test("detail fetches bounded checks and parameterized review threads without loading logs", async () => {
  const f = fixtureExecute();
  const result = await localGithub({ action: "detail", context, repo, number: 1 }, { execute: f.execute });
  assert.equal(result.counts.failed, 1); assert.equal(result.threads.length, 1);
  assert.equal(f.calls.length, 2); assert(f.calls[0].args.includes(client.DETAIL_JQ));
  const args = f.calls[1].args; assert(args.includes(`query=${client.THREAD_QUERY}`)); assert(args.includes("number=1")); assert(args.includes(client.THREAD_JQ));
  assert(!args.includes("--paginate")); assert(f.calls.every(call => !call.args.includes("--log-failed")));
});

test("failed logs are opt-in, repository-scoped, head-checked and bounded", async () => {
  const f = fixtureExecute(), selected = model.githubChecks([check()], repo)[0];
  const result = await localGithub({ action: "log", context, repo, check: selected, head }, { execute: f.execute });
  assert.equal(result.text, "failure output\n"); assert.equal(f.calls.length, 2);
  assert(f.calls[1].args.includes("--job") && f.calls[1].args.includes("88"));
  const other = fixtureExecute();
  await assert.rejects(localGithub({ action: "log", context, repo, check: selected, head: "b".repeat(40) }, { execute: other.execute }), /another head/);
  assert.equal(other.calls.length, 1);
  assert.equal(model.githubLogTarget({ ...selected, url: "https://evil.test/actions/runs/99" }, repo), null);
  assert.equal(model.githubLogTarget({ ...selected, status: "cancelled" }, repo), null);
});

test("remote reads preserve on/cwd for every operation and never fall back to a local helper", async () => {
  const f = fixtureExecute(), remote = { ...context, on: "fixture-remote" };
  const api = client.createGithubClient({ execute: f.execute, home: "/fixture/herdr" });
  await api.list(remote);
  assert(f.calls.every(call => call.options.on === "fixture-remote" && call.options.cwd === context.root && call.options.timeout === 12000));
  assert(f.calls.every(call => call.program !== "node"));
  assert(f.calls.filter(call => call.program !== "git").every(call => call.program === "env" && JSON.stringify(call.args.slice(0, 3)) === JSON.stringify(["-u", "GH_REPO", "gh"])));
  const missing = fixtureExecute({ fail: new Error("remote machine unreachable") });
  await assert.rejects(client.createGithubClient({ execute: missing.execute, home: "/fixture" }).list(remote), /unreachable/);
  assert.equal(missing.calls.length, 1);
});

test("local client delegates a bounded captured request and rejects malformed helper output", async () => {
  const calls = [];
  const api = client.createGithubClient({ home: "/fixture/herdr", execute: async (...args) => { calls.push(args); return reply(list()); } });
  const result = await api.list(context); assert.equal(result.prs.length, 2);
  assert.equal(calls[0][0], "node"); assert.equal(calls[0][1][0], "/fixture/herdr/mods/files-plus/github-helper.mjs");
  assert.deepEqual(JSON.parse(calls[0][1][1]).context, context); assert.equal(calls[0][2].timeout, 28000);
  await assert.rejects(client.createGithubClient({ home: "/fixture", execute: async () => ({ code: 0, stdout: "bad" }) }).list(context), /malformed/);
});

test("missing gh/authentication errors stay actionable without installation or login", async () => {
  const absent = new Error("spawn gh ENOENT"); absent.code = "ENOENT";
  const missing = fixtureExecute({ fail: absent });
  await assert.rejects(localGithub({ action: "list", context }, { execute: missing.execute }), /unavailable.*No installation/);
  assert.equal(missing.calls.length, 1);
  const signedOut = async () => ({ code: 4, stdout: "", stderr: "To get started with GitHub CLI, run: gh auth login" });
  await assert.rejects(localGithub({ action: "list", context }, { execute: signedOut }), /not authenticated/);
});

test("real local subprocess bounds reject overflow/timeouts and return explicit truncated log text", async () => {
  const output = await githubProcess(process.execPath, ["-e", 'process.stdout.write("x".repeat(80000)); setInterval(()=>{},1000)'], { cwd: "/private/tmp", log: true, timeout: 3000 });
  assert.equal(Buffer.byteLength(output.stdout), model.GITHUB_LIMITS.log); assert.equal(output.truncated, true);
  await assert.rejects(githubProcess(process.execPath, ["-e", 'process.stdout.write("x".repeat(1400000))'], { cwd: "/private/tmp", timeout: 3000 }), /limit/);
  await assert.rejects(githubProcess(process.execPath, ["-e", 'setInterval(()=>{},1000)'], { cwd: "/private/tmp", timeout: 40 }), /timed out/);
});

function element() {
  const node = { childNodes: [], attrs: {}, events: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key === "child") return child => { target.childNodes.push(child); return proxy; };
    if (key === "children") return children => { target.childNodes.push(...children); return proxy; };
    if (key === "when") return (condition, callback) => condition ? callback(proxy) : proxy;
    if (String(key).startsWith("on_")) return (...args) => { target.events[key] = args.at(-1); return proxy; };
    if (key in target) return target[key];
    return value => { target.attrs[key] = value; return proxy; };
  } }); return proxy;
}
const nodes = node => !node || typeof node !== "object" ? [] : [node, ...node.childNodes.flatMap(nodes)];
const find = (tree, id) => nodes(tree).find(node => node.attrs.id === id);
function harness(api = {}) {
  const calls = [], tasks = [], overlays = [], opened = [], copied = []; let rendering = false;
  const cx = { focus_handle: () => ({ focus() {} }), notify() { assert(!rendering); }, stop_propagation() {}, open_url: url => opened.push(url), write_to_clipboard: text => copied.push(text),
    spawn(callback) { const task = callback(cx); tasks.push(task); return { cancel() {} }; }, timer: { every() { throw new Error("GitHub must not poll"); }, after() { throw new Error("GitHub must not schedule reads during render"); } } };
  const deps = { ...model, div: element, svg: element, h_flex: element, v_flex: element, Editor: { new: element }, EditorState: { new: options => ({ options, release() { this.released = true; } }) },
    exec() { throw new Error("No real programs in production UI tests"); }, appHome: () => "/fixture/herdr", settings: () => ({}), theme: () => ({}), openOverlay: spec => overlays.push(spec), closeOverlay() {}, readTextFile: async () => "{}",
    createGithubClient: () => ({ list: async (context, repo) => { calls.push(["list", { ...context }, repo]); return api.list ? api.list(context, repo) : list(); }, detail: async (context, repo, number) => { calls.push(["detail", { ...context }, repo, number]); return api.detail ? api.detail(context, repo, number) : detail(number); }, log: async (...args) => { calls.push(["log", ...args]); return { text: "fixture log", head, truncated: false }; } }) };
  const source = readFileSync(new URL("../mods/files-plus/github.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  const Github = new Function(...Object.keys(deps), source)(...Object.values(deps));
  const view = new Github(), props = { context: { ...context } }; view.init(props, cx);
  return { view, props, cx, calls, tasks, overlays, opened, copied, render() { rendering = true; try { return view.render(cx); } finally { rendering = false; } }, click(id) { const node = find(this.render(), id); assert(node, id); node.events.on_click({}, cx); }, async settle() { for (let i = 0; i < 8 && tasks.length; i++) await Promise.all(tasks.splice(0)); } };
}

test("production panel reads once, renders nonempty data without polling and queues only an explicit preview", async () => {
  const f = harness(); await f.settle(); f.render(); f.render(); assert.deepEqual(f.calls.map(call => call[0]), ["list", "detail"]);
  assert(find(f.render(), "github-check-0")); assert(find(f.render(), "github-thread-0"));
  f.click("github-copy-summary"); assert(f.copied[0].includes("src/a'b.js:12"));
  f.click("github-queue"); await f.settle(); assert.equal(f.overlays.length, 1); assert.equal(f.overlays[0].props.role, "reference");
  assert.equal(f.overlays[0].props.on, null); assert(f.overlays[0].props.text.includes("$(never)")); assert(f.overlays[0].props.text.length < 12000);
  assert.equal(f.calls.some(call => call[0] === "log"), false);
  f.click("github-open-pr"); assert.deepEqual(f.opened, [pr().url]);
  f.view.open("https://outside.example/", f.cx); assert.equal(f.opened.length, 1);
});

test("production refresh errors retain old snapshots as stale and never redirect a captured context", async () => {
  let bad = false;
  const f = harness({ list: async () => { if (bad) throw new Error("GitHub returned malformed JSON"); return list(); } });
  await f.settle(); const old = f.view.detail;
  f.props.context.root = "/focus-changed"; f.props.context.on = "wrong-machine"; bad = true;
  f.click("github-refresh"); await f.settle();
  assert.equal(f.view.stale, true); assert.equal(f.view.detail, old); assert.match(f.view.error, /malformed/);
  assert.deepEqual(f.calls.at(-1)[1], context); assert.equal(f.calls.at(-1)[2].spec, repo.spec);
});

test("production missing-gh state stays usable and performs no hidden retries", async () => {
  const f = harness({ list: async () => { throw new Error("GitHub CLI (gh) is unavailable on the captured machine. No installation or login was started."); } });
  await f.settle(); f.render(); f.render(); assert.match(f.view.error, /unavailable/); assert.equal(f.calls.length, 1); assert.equal(f.view.prs.length, 0);
});

test("late PR details and post-close results cannot overwrite another selected PR", async () => {
  let resolveFirst;
  const gate = new Promise(resolve => { resolveFirst = resolve; });
  const f = harness({ detail: async (_context, _repo, number) => number === 1 ? gate : detail(2) });
  await f.tasks[0];
  f.view.choose(2, f.cx); await f.tasks.at(-1);
  assert.equal(f.view.detail.pr.number, 2);
  resolveFirst(detail()); await f.settle(); assert.equal(f.view.detail.pr.number, 2);
  let resolveList;
  const g = harness({ list: async () => new Promise(resolve => { resolveList = resolve; }) });
  g.view.close(); resolveList(list()); await g.settle(); assert.equal(g.view.repo, undefined); assert.equal(g.view.prs.length, 0);
});

test("production failed logs load only on click and release their retained editor", async () => {
  const f = harness(); await f.settle(); f.click("github-check-log-0"); await f.settle();
  assert.equal(f.calls.filter(call => call[0] === "log").length, 1); const editor = f.view.logEditor; assert(editor);
  f.click("github-log-copy"); assert.equal(f.copied.at(-1), "fixture log");
  f.click("github-log-back"); assert.equal(editor.released, true); assert.equal(f.view.logEditor, null);
  f.view.close();
});

async function executableFixture(t) {
  const root = await fs.mkdtemp("/private/tmp/herdr-github-env-fixture-"); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"); await fs.mkdir(bin);
  const gh = path.join(bin, "gh"), git = path.join(bin, "git");
  await fs.writeFile(gh, `#!${process.execPath}\nconst args=process.argv.slice(2);\nif(process.env.GH_TOKEN!=="fixture-only-gh-token" || process.env.GITHUB_TOKEN!=="fixture-only-github-token") process.exit(91);\nif(args[0]==="repo" && args[1]==="view") {const name=process.env.GH_REPO || "captured/right-repo"; console.log(JSON.stringify({nameWithOwner:name,url:"https://github.com/"+name}));}\nelse if(args[0]==="pr" && args[1]==="list") console.log("[]");\nelse process.exit(92);\n`, { mode: 0o700 });
  await fs.writeFile(git, `#!${process.execPath}\nif(process.argv.includes("--show-current")) console.log("");else process.exit(93);\n`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH || "/usr/bin:/bin"}`, GH_REPO: "wrong/inherited-repo", GH_TOKEN: "fixture-only-gh-token", GITHUB_TOKEN: "fixture-only-github-token" };
  return { root, bin, gh, env };
}

test("local child removes inherited GH_REPO while preserving existing authentication variables", async t => {
  const f = await executableFixture(t);
  const result = await githubProcess(f.gh, ["repo", "view", "--json", "nameWithOwner,url"], { cwd: f.root, env: f.env });
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).nameWithOwner, "captured/right-repo");
  assert.equal(f.env.GH_REPO, "wrong/inherited-repo", "the caller environment is never mutated");
});

test("symlink helper entry executes once and discovers the cwd repository despite inherited GH_REPO", async t => {
  const f = await executableFixture(t), link = path.join(f.root, "linked-helper.mjs");
  await fs.symlink(fileURLToPath(new URL("../mods/files-plus/github-helper.mjs", import.meta.url)), link);
  const result = await promisify(execFile)(process.execPath, [link, JSON.stringify({ action: "list", context: { root: f.root, on: null } })], { env: f.env, encoding: "utf8", timeout: 5000 });
  const data = JSON.parse(result.stdout); assert.equal(data.repo.nameWithOwner, "captured/right-repo"); assert.deepEqual(data.prs, []);
});

test("remote fixed env prefix removes a real inherited repository sentinel without clearing auth or changing machine", async t => {
  const f = await executableFixture(t), calls = [];
  const execute = async (program, args, options) => {
    calls.push({ program, args, options });
    assert.equal(options.on, "fixture-posix"); assert.equal(options.cwd, f.root);
    const result = await promisify(execFile)(program, args, { cwd: options.cwd, env: f.env, encoding: "utf8", timeout: options.timeout });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  };
  const result = await client.createGithubClient({ execute, home: "/never-used-local-helper" }).list({ root: f.root, on: "fixture-posix" });
  assert.equal(result.repo.nameWithOwner, "captured/right-repo");
  assert.deepEqual(calls.map(call => call.program), ["env", "git", "env"]);
  for (const call of calls.filter(call => call.program === "env")) assert.deepEqual(call.args.slice(0, 3), ["-u", "GH_REPO", "gh"]);
});
