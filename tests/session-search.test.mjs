import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { search } from "../mods/sessions-plus/history.mjs";
import * as model from "../mods/sessions-plus/model.js";
import { uiFunction } from "./helpers/ui-function.mjs";

const id = n => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const append = (file, ...records) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
};

function fixture(t) {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "session-search-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stores = { claude: join(home, ".claude"), codex: join(home, ".codex") };
  const key = (provider, n) => model.sessionKey({ provider, store: stores[provider], id: id(n) });
  const claude = n => join(stores.claude, "projects", "project", id(n) + ".jsonl");
  const codex = n => join(stores.codex, "sessions", "2026", "11", "25", `rollout-2026-11-25T00-00-00-${id(n)}.jsonl`);
  return { home, stores, key, claude, codex, options: { home, stores }, noRg: { rg: join(home, "missing-rg") } };
}

test("the search CLI returns keys for JSON-escaped quotes, backslashes, Unicode and option-like terms", t => {
  const f = fixture(t), first = f.key("claude", 1), second = f.key("codex", 2), keys = [first, second];
  const query = 'héllo "A\\B" 世界';
  append(f.claude(1), { type: "user", message: { content: 'HÉLLO "a\\b" 世界' } });
  append(f.codex(2), { type: "session_meta", payload: { id: id(2) } }, { type: "user_message", message: "Literal -e text" });
  const script = fileURLToPath(new URL("../mods/sessions-plus/history.mjs", import.meta.url));
  const read = query => JSON.parse(execFileSync(process.execPath, [script, "search", JSON.stringify(f.options), JSON.stringify({ keys, query })], { encoding: "utf8" }));
  assert.deepEqual(read(query), { hits: [first], partial: false });
  assert.deepEqual(read("-e"), { hits: [second], partial: false });
  assert.deepEqual(search(keys, query, f.options, f.noRg), { hits: [first], partial: false });
  assert.deepEqual(search(keys, "-e", f.options, f.noRg), { hits: [second], partial: false });
});

test("search skips symlink files and ancestors, ambiguous IDs, mismatched Codex metadata and raw paths", t => {
  const f = fixture(t), source = f.claude(1);
  append(source, { message: "needle" });
  symlinkSync(source, f.claude(2));
  const otherDir = join(f.home, "elsewhere");
  append(join(otherDir, id(3) + ".jsonl"), { message: "needle" });
  symlinkSync(otherDir, join(f.stores.claude, "projects", "outside"));
  append(f.claude(4), { message: "needle" });
  append(join(f.stores.claude, "projects", "duplicated", id(4) + ".jsonl"), { message: "needle" });
  append(f.codex(5), { type: "session_meta", payload: { id: id(6) } }, { message: "needle" });
  const alias = join(f.home, "alias");
  symlinkSync(f.stores.claude, alias);
  const keys = [f.key("claude", 1), f.key("claude", 2), f.key("claude", 3), f.key("claude", 4), f.key("codex", 5), source];
  assert.deepEqual(search(keys, "needle", f.options), { hits: [f.key("claude", 1)], partial: false });
  const aliasKey = model.sessionKey({ provider: "claude", id: id(1), store: alias });
  assert.deepEqual(search([aliasKey], "needle", { ...f.options, stores: { ...f.stores, claude: alias } }), { hits: [], partial: false });
});

test("search caps hit count and resolves newest transcripts first regardless of key order", t => {
  const f = fixture(t), keys = [];
  for (let n = 1; n <= 55; n++) {
    append(f.claude(n), { text: "needle" });
    utimesSync(f.claude(n), n, n);
    keys.push(f.key("claude", n));
  }
  assert.deepEqual(search(keys, "needle", f.options), { hits: keys.slice(5).reverse(), partial: true });
});

test("an exact live key can include an alternate local store without changing the configured store", t => {
  const f = fixture(t), primary = f.key("claude", 1), store = join(f.home, "other-config");
  const alternate = model.sessionKey({ provider: "claude", store, id: id(1) });
  append(f.claude(1), { text: "Only the primary transcript" });
  append(join(store, "projects", "project", id(1) + ".jsonl"), { text: "Needle in the other store" });
  const keys = [primary, alternate];
  assert.deepEqual(search(keys, "needle", f.options), { hits: [], partial: false });
  assert.deepEqual(search(keys, "needle", { ...f.options, liveKeys: [alternate] }), { hits: [alternate], partial: false });
});

test("search browses at most the 300 newest in-scope files and reports that it stopped early", t => {
  const f = fixture(t), keys = [];
  for (let n = 1; n <= 301; n++) {
    append(f.claude(n), { text: n === 1 ? "needle" : "plain" });
    utimesSync(f.claude(n), n, n);
    keys.push(f.key("claude", n));
  }
  assert.deepEqual(search(keys, "needle", f.options, f.noRg), { hits: [], partial: true });
});

test("search respects the deadline and reports partial if rg outlasts the remaining budget", t => {
  const f = fixture(t), keys = [f.key("claude", 1)];
  append(f.claude(1), { text: "needle" });
  assert.deepEqual(search(keys, "needle", f.options, { budget: 0 }), { hits: [], partial: true });
  const slow = join(f.home, "slow-rg");
  writeFileSync(slow, "#!/bin/sh\nexec /bin/sleep 8\n", { mode: 0o700 });
  const before = performance.now();
  assert.deepEqual(search(keys, "needle", f.options, { rg: slow, budget: 100 }), { hits: [], partial: true });
  assert(performance.now() - before < 4000);
});

test("the Node fallback matches across UTF-8 chunk boundaries and caps total bytes", t => {
  const f = fixture(t), key = f.key("claude", 1);
  append(f.claude(1), { text: "x".repeat(65526) + "世界 [A]+" });
  assert.deepEqual(search([key], "世界 [a]+", f.options, f.noRg), { hits: [key], partial: false });
  truncateSync(f.claude(1), 64 * 1024 * 1024 + 1);
  assert.deepEqual(search([key], "no such text", f.options, f.noRg), { hits: [], partial: true });
});

function panel(dependencies) {
  const source = readFileSync(new URL("../mods/sessions-plus/main.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  const deps = { ...model, View: class {}, window: () => ({ platform: "macos" }), ...dependencies };
  const Panel = uiFunction(...Object.keys(deps), source)(...Object.values(deps));
  return Object.assign(new Panel(), { query: "needle", all: false, provider: "all", source: "all", page: "sessions" });
}

const row = (n, extra = {}) => {
  const value = { provider: "claude", store: "/fixture/claude", id: id(n), cwd: "/fixture/project", title: "Title", ...extra };
  return { ...value, key: model.sessionKey(value) };
};

test("the view waits for unchanged input, coalesces in-flight work, and rejects an earlier query or scope", async () => {
  const view = panel(), context = { cwd: "/fixture/project", on: null }, first = row(1), second = row(2);
  const timers = [], tasks = [], calls = [], answers = [];
  let notifications = 0;
  const cx = { timer: { after: (delay, run) => timers.push({ delay, run }) }, spawn: run => tasks.push(run(cx)), notify() { notifications++; } };
  view.read = (action, payload) => { calls.push([action, JSON.parse(payload)]); return new Promise(resolve => answers.push(resolve)); };
  assert.equal(view.transcriptSearch([first], context, cx), null);
  view.query = "haystack";
  assert.equal(view.transcriptSearch([first], context, cx), null);
  assert.deepEqual(timers.map(item => item.delay), [600, 600]);
  timers.shift().run(cx);
  assert.equal(calls.length, 0);
  timers.shift().run(cx);
  assert.deepEqual(calls[0], ["search", { query: "haystack", keys: [first.key] }]);
  view.all = true;
  view.transcriptSearch([second], context, cx);
  timers.shift().run(cx);
  assert.equal(calls.length, 1);
  answers.shift()({ hits: [first.key], partial: true }); await tasks[0];
  assert.equal(notifications, 0);
  assert.deepEqual(calls[1], ["search", { query: "haystack", keys: [second.key] }]);
  answers.shift()({ hits: [first.key, second.key], partial: false }); await tasks[1];
  assert.equal(notifications, 1);
  assert.deepEqual(view.transcriptSearch([second], context, cx), { hits: new Set([second.key]), partial: false });
  view.query = "-e";
  assert.equal(view.transcriptSearch([second], context, cx), null);
  assert.equal(timers.length, 0);
});

test("transcript search reuses the result across row order, duplicates and live status changes", async () => {
  const view = panel(), context = { cwd: "/fixture/project" }, first = row(1, { live: true }), second = row(2);
  const timers = [], calls = [];
  let task;
  const cx = { timer: { after: (_delay, run) => timers.push(run) }, spawn: run => { task = run(cx); }, notify() {} };
  view.read = async (_action, payload) => { calls.push(JSON.parse(payload)); return { hits: [first.key] }; };
  view.transcriptSearch([first, second], context, cx);
  timers.shift()(cx); await task;
  view.query = " needle ";
  assert.deepEqual(view.transcriptSearch([second, { ...first, live: false }, second], context, cx), { hits: new Set([first.key]), partial: false });
  assert.equal(timers.length, 0);
  view.transcriptSearch([second], context, cx);
  timers.shift()(cx); await task;
  assert.deepEqual(calls.map(call => call.keys), [[first.key, second.key], [second.key]]);
});

test("the session list marks only rows matched by transcript within the current folder and provider filters", () => {
  const element = () => {
    const node = { items: [], attrs: {} }, proxy = new Proxy(node, { get(target, name) {
      if (name === "child" || name === "children") return child => { target.items.push(...(name === "child" ? [child] : child)); return proxy; };
      if (name === "when") return (condition, fn) => condition ? fn(proxy) : proxy;
      if (name === "id") return id => { target.attrs.id = id; return proxy; };
      if (name === "on_click") return click => { target.attrs.click = click; return proxy; };
      return name in target ? target[name] : () => proxy;
    } });
    return proxy;
  };
  const matched = row(1, { title: "needle title" }), transcript = row(2), outside = row(3, { cwd: "/outside" }), codex = row(4, { provider: "codex" });
  const view = panel({ theme: () => ({}), projectContext: () => ({ cwd: matched.cwd }), shared: () => undefined,
    div: element, h_flex: element, v_flex: element, svg: element, Input: { new: element }, providerIcon: element });
  Object.assign(view, { provider: "claude", visible: 10, history: [], busy: new Set(), error: "", warnings: [],
    filterDropdown: element, toolbarPopover: element, toolsMenu: element, rows: () => [matched, transcript, outside, codex] });
  view.transcriptSearch = scoped => {
    assert.deepEqual(scoped, [matched, transcript]);
    return { hits: new Set([matched.key, transcript.key, outside.key]), partial: true };
  };
  const words = node => typeof node === "string" ? [node] : node?.items?.flatMap(words) ?? [];
  const nodes = node => !node || typeof node !== "object" ? [] : [node, ...node.items.flatMap(nodes)];
  const ui = view.renderSessions({});
  assert(!nodes(ui).some(node => node.attrs.id === "session-" + outside.key));
  assert(!words(nodes(ui).find(node => node.attrs.id === "session-" + matched.key)).includes("in transcript"));
  assert(words(nodes(ui).find(node => node.attrs.id === "session-" + transcript.key)).includes("in transcript"));
  assert(words(ui).includes("Transcript search was partial."));
  let refreshes = 0;
  view.transcriptRequest = { signature: "cached" }; view.refresh = () => { refreshes++; };
  nodes(ui).find(node => node.attrs.id === "sessions-refresh").attrs.click({}, { stop_propagation() {} });
  assert.equal(view.transcriptRequest, null);
  assert.equal(refreshes, 1);
});
