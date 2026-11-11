import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import test from "node:test";
import * as model from "../mods/sessions-plus/deliverables-model.js";
import * as storage from "../mods/sessions-plus/deliverables-store.mjs";
import { createDeliverablesClient } from "../mods/sessions-plus/deliverables-client.js";
const scope = model.deliverableScope({ root: "/fixture/project", on: null });
const value = { kind: "file", location: "reports/a b.md", title: "Result", note: "Review the findings" };
const empty = () => storage.decodeDeliverables(null);
const add = (state = empty(), request = {}) => storage.changeDeliverables(state, { action: "add", scope, value, ...request }).state;
const item = state => state.projects[0].items[0];

test("captured file paths preserve machine identity and literal punctuation; only HTTP(S) URLs are accepted", () => {
  const remote = model.deliverableScope({ root: "/remote/repo", on: "server" });
  assert.deepEqual(storage.fileDeliverable(remote, "reports/a '$`b.md").file, { root: "/remote/repo", path: "reports/a '$`b.md", on: "server" });
  assert.deepEqual(storage.fileDeliverable(remote, "/elsewhere/out.md").file, { root: "/elsewhere", path: "out.md", on: "server" });
  assert.equal(storage.fileDeliverable(scope, "/fixture/project//reports/out.md").file.path, "reports/out.md");
  assert.deepEqual(storage.fileDeliverable(model.deliverableScope({ root: "C:\\Repo", on: "win" }), "C:\\Other\\file.md").file, { root: "C:/Other", path: "file.md", on: "win" });
  for (const path of ["../escape.md", "a/../b", "./x", "/folder/", "/fixture/project"]) assert.throws(() => storage.fileDeliverable(scope, path));
  for (const location of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "https://", "https://safe.test\n.evil", "https:\\evil"]) assert.throws(() => storage.validateDeliverable(scope, { kind: "url", location }));
  assert.equal(storage.validateDeliverable(scope, { kind: "url", location: "https://example.test/report?a=1#x" }).title, "example.test");
});

test("item revisions protect edits/status/archive/removal and conflict recovery preserves both versions", () => {
  let state = add(), original = item(state);
  state = storage.changeDeliverables(state, { action: "edit", scope, id: original.id, expected: 1, value: { ...value, title: "New saved title" } }).state;
  for (const action of ["edit", "read", "archive", "remove"]) assert.throws(() => storage.changeDeliverables(state, { action, scope, id: original.id, expected: 1, value: action === "edit" ? value : true }), error => error.code === "conflict");
  state = add(state, { value: { ...value, title: "Retained separate copy" } }); assert.equal(state.projects[0].items.length, 2);
  const before = JSON.stringify(state); assert.throws(() => storage.changeDeliverables(state, { action: "remove", scope, id: original.id, expected: 2 }), /Archive/); assert.equal(JSON.stringify(state), before);
  state = storage.changeDeliverables(state, { action: "archive", scope, id: original.id, expected: 2, value: true }).state;
  assert.equal(storage.deliverableView(state, { scope, filter: "archived" }).total, 1);
  state = storage.changeDeliverables(state, { action: "remove", scope, id: original.id, expected: 3 }).state; assert.equal(state.projects[0].items.length, 1);
});

test("maximum saved lists stay bounded and pagination emits at most 20 items without evicting records", () => {
  const projects = Array.from({ length: 4 }, (_, p) => ({ scope: model.deliverableScope({ root: `/p${p}`, on: p === 1 ? "server" : null }), items: Array.from({ length: 500 }, (_, i) => ({ ...value, id: `${p}-${i}`, revision: 1, title: `Result ${i}`, note: "x".repeat(1000), read: i % 2 === 0, archived: i % 3 === 0, created: i, updated: i })) }));
  const raw = JSON.stringify({ schema: 1, revision: 1, projects }), state = storage.decodeDeliverables(raw), view = storage.deliverableView(state, { scope: projects[1].scope, filter: "all", page: 999 });
  assert.equal(state.projects.reduce((n, p) => n + p.items.length, 0), 2000); assert(view.items.length <= 20); assert.equal(view.page, view.pages - 1); assert.equal(view.scope.on, "server");
  assert.equal(storage.deliverableView(state, { scope: projects[0].scope, filter: "unread" }).items.length, 20);
  assert.throws(() => storage.changeDeliverables(state, { action: "add", scope: projects[0].scope, value }), error => error.code === "capacity"); assert.equal(JSON.stringify(state), raw);
  assert.throws(() => storage.decodeDeliverables("x".repeat(model.DELIVERABLE_LIMITS.bytes + 1)), /limit/); assert.throws(() => storage.decodeDeliverables("broken"), /unreadable/);
});

test("drop is bounded, atomic and rejects local dropped files in a remote project's list", () => {
  assert.throws(() => storage.changeDeliverables(empty(), { action: "drop", scope: { root: "/remote", on: "server" }, values: [value] }), /from this computer/);
  assert.throws(() => storage.changeDeliverables(empty(), { action: "drop", scope, values: Array(11).fill(value) }), /one to ten/);
  const state = add(), before = JSON.stringify(state); assert.throws(() => storage.changeDeliverables(state, { action: "drop", scope, values: [value, { ...value, location: "../escape" }] })); assert.equal(JSON.stringify(state), before);
});

test("the real file store serializes concurrent writers and stale revisions; corrupt files are never overwritten", async t => {
  const home = await fs.mkdtemp("/private/tmp/deliverables-test-"); t.after(() => fs.rm(home, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 12 }, (_, i) => storage.deliverableRequest(home, { action: "add", scope, value: { ...value, title: `Writer ${i}` } })));
  const result = await storage.deliverableRequest(home, { action: "view", scope, filter: "all" }); assert.equal(result.total, 12);
  const original = result.items[0], settled = await Promise.allSettled([true, false].map(read => storage.deliverableRequest(home, { action: "read", scope, id: original.id, expected: original.revision, value: read })));
  assert.equal(settled.filter(row => row.status === "fulfilled").length, 1); assert.equal(settled.filter(row => row.status === "rejected" && row.reason.code === "conflict").length, 1);
  const paths = storage.deliverablePaths(home); await fs.writeFile(paths.file, "broken"); await assert.rejects(storage.deliverableRequest(home, { action: "add", scope, value }), /unreadable/); assert.equal(await fs.readFile(paths.file, "utf8"), "broken");
});

test("explicit CLI add records metadata without reading a file or invoking its contents", async t => {
  const home = await fs.mkdtemp("/private/tmp/deliverables-cli-"); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const helper = new URL("../mods/sessions-plus/deliverables-helper.mjs", import.meta.url).pathname;
  const result = await new Promise((resolve, reject) => { const child = spawn(process.execPath, [helper, "add", "--home", home, "--root", "/nonexistent/project", "--on", "remote", "--file", "result $(literal).md", "--title", "CLI result"], { stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = ""; child.stdout.on("data", chunk => { out += chunk; }); child.stderr.on("data", chunk => { err += chunk; }); child.on("error", reject); child.on("close", code => code ? reject(new Error(err + out)) : resolve(JSON.parse(out))); });
  assert.equal(result.items[0].location, "result $(literal).md"); assert.equal(result.items[0].file.on, "remote"); assert.equal(result.items[0].read, false);
});

function element() { const node = { attrs: {}, events: {}, children: [] }; const proxy = new Proxy(node, { get(target, key) { if (key === "child") return child => { target.children.push(child); return proxy; }; if (key === "children") return children => { target.children.push(...children); return proxy; }; if (key === "when") return (condition, fn) => condition ? fn(proxy) : proxy; if (key in target) return target[key]; if (String(key).startsWith("on_")) return (...args) => { target.events[key] = args.at(-1); return proxy; }; return value => { target.attrs[key] = value; return proxy; }; } }); return proxy; }
const allNodes = node => !node || typeof node !== "object" ? [] : [node, ...node.children.flatMap(allNodes)];
function harness({ data = add(), captured = scope, local = new Map(), defer = false } = {}) {
  const map = new Map(), tasks = [], timers = [], calls = [], opens = [], urls = [], inputs = [], queued = []; let state = data, rendering = false;
  const cx = { notify() { assert(!rendering); }, stop_propagation() {}, open_url: url => urls.push(url), focus_handle: () => ({ focus() {} }), spawn(callback) { tasks.push(callback(cx)); }, timer: { after(ms, callback) { const task = { ms, callback, cancel() { this.cancelled = true; } }; timers.push(task); return task; } } };
  const input = () => { let value = ""; const events = {}, row = { value: () => value, set_value(next) { value = next; }, on(name, fn) { events[name] = fn; }, focus() {}, type(next) { value = next; events.change?.({}, cx); }, release() { this.released = true; } }; inputs.push(row); return row; };
  const client = async request => { calls.push(request); if (defer && request.action !== "view" && request.action !== "get") await new Promise(resolve => queued.push(resolve));
    if (request.action === "view") return storage.deliverableView(state, request); if (request.action === "get") { const found = state.projects.find(p => p.scope.key === request.scope.key)?.items.find(i => i.id === request.id); if (!found || found.revision !== request.expected) { const error = new Error("changed"); error.code = "conflict"; throw error; } return { scope: request.scope, item: { ...found, ...(found.kind === "file" ? { file: storage.fileDeliverable(request.scope, found.location).file } : {}) } }; }
    const result = storage.changeDeliverables(state, request); state = result.state; return { ...storage.deliverableView(state, request), changed: result.changed };
  };
  const deps = { ...model, div: element, h_flex: element, v_flex: element, Input: { new: element }, Textarea: { new: element }, InputState: { new: input }, TextareaState: { new: input }, appHome: () => "/fixture/herdr", exec: () => { throw new Error("No CLI during native class test"); }, createDeliverablesClient: () => client, projectContext: () => captured, theme: () => ({}), shared: key => map.get(key), setShared: (key, value) => map.set(key, value), readTextFile: async () => "{}", openOverlay: value => opens.push(value), closeOverlay() {}, localStorage: { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) } };
  const source = readFileSync(new URL("../mods/sessions-plus/deliverables.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class"), Role = new Function(...Object.keys(deps), source)(...Object.values(deps)), view = new Role(); view.init({ root: captured.root, on: captured.on }, cx);
  return { view, cx, calls, opens, urls, inputs, local, queued, state: () => state, setState: value => { state = value; }, async settle() { for (let i = 0; i < 12 && tasks.length; i++) await Promise.all(tasks.splice(0)); }, render() { rendering = true; try { return view.render(cx); } finally { rendering = false; } }, click(id) { const row = allNodes(this.render()).find(row => row.attrs.id === id); assert(row, id); row.events.on_click({}, cx); } };
}

test("production native UI never opens items automatically; file and URL clicks preserve captured machine/identity", async () => {
  const remote = model.deliverableScope({ root: "/remote", on: "server" }), data = add(empty(), { scope: remote }), f = harness({ data, captured: remote }); await f.settle(); f.render(); assert.equal(f.opens.length + f.urls.length, 0);
  const row = f.view.data.items[0]; f.view.open(row, f.cx); await f.settle(); assert.deepEqual(f.opens[0].props, { role: "file-preview", root: "/remote", path: value.location, on: "server" });
  f.view.drop(["/local/file.md"], f.cx); assert.match(f.view.error, /from this computer/); assert.equal(f.state().projects[0].items.length, 1);
  const urls = add(empty(), { value: { kind: "url", location: "https://example.test/report" } }), g = harness({ data: urls }); await g.settle(); g.view.open(g.view.data.items[0], g.cx); await g.settle(); assert.deepEqual(g.urls, ["https://example.test/report"]);
  f.view.close(); assert(f.inputs.every(input => input.released));
});

test("production form CAS conflicts preserve input and explicit separate-item recovery retains both records", async () => {
  const f = harness(); await f.settle(); const original = f.view.data.items[0]; f.view.openForm(original, f.cx); f.inputs[0].type("My edit");
  f.setState(storage.changeDeliverables(f.state(), { action: "edit", scope, id: original.id, expected: 1, value: { ...value, title: "Other writer" } }).state);
  f.view.save(f.cx); await f.settle(); assert(f.view.conflict); assert.equal(f.inputs[0].value(), "My edit"); assert.equal(f.view.drafts()[0].title, "My edit");
  f.view.save(f.cx, true); await f.settle(); assert.equal(f.state().projects[0].items.length, 2); assert(f.state().projects[0].items.some(item => item.title === "Other writer")); assert(f.state().projects[0].items.some(item => item.title === "My edit"));
});

test("production pending Save retains typing made while storage completes and advances the saved revision", async () => {
  const f = harness({ defer: true }); await f.settle(); f.view.openForm(f.view.data.items[0], f.cx); f.inputs[0].type("First edit"); f.view.save(f.cx); f.inputs[0].type("New typing during save"); f.queued.shift()(); await f.settle();
  assert(f.view.form); assert.equal(f.inputs[0].value(), "New typing during save"); assert.equal(f.view.form.baseRevision, 2); assert.equal(f.view.drafts()[0].title, "New typing during save"); f.view.close(); assert.equal(f.view.drafts()[0].title, "New typing during save");
});

test("production saved forms restore as independent branches and stale close cannot overwrite or revive a discarded branch", async () => {
  const a = harness(); await a.settle(); a.view.openForm(null, a.cx); a.inputs[0].type("Original form"); a.view.back(a.cx); const original = a.view.drafts()[0], b = harness({ local: a.local }); await b.settle(); a.view.openForm(null, a.cx, original); b.view.openForm(null, b.cx, original);
  a.inputs[0].type("Writer A"); const aId = a.view.form.id; b.view.close(); assert.equal(a.view.drafts().find(row => row.id === aId).title, "Writer A"); assert.equal(a.view.drafts().find(row => row.id === original.id).title, "Original form");
  const own = a.view.drafts().find(row => row.id === aId); b.view.discard(own, b.cx); a.inputs[0].type("After discard"); assert.match(a.view.error, /discarded/); a.view.close(); assert.equal(a.view.drafts().some(row => row.id === aId), false);
});

test("native storage adapter uses a short-lived fixed helper invocation and surfaces typed conflicts", async () => {
  const calls = [], client = createDeliverablesClient(async (...args) => { calls.push(args); return { code: 0, stdout: '{"items":[]}' }; }, "/fixture/Herdr home"); await client({ action: "view", scope });
  assert.equal(calls[0][0], "node"); assert.equal(calls[0][1][0], "/fixture/Herdr home/mods/sessions-plus/deliverables-helper.mjs"); assert.equal(calls[0][1][1], "request");
  const failed = createDeliverablesClient(async () => ({ code: 1, stdout: '{"error":"stale","code":"conflict"}' }), "/fixture"); await assert.rejects(failed({}), error => error.code === "conflict");
});

test("owned storage refuses symlinked home/data/folder/store/lock without reading or overwriting the foreign target", async t => {
  const base = await fs.mkdtemp("/private/tmp/deliverables-boundary-"); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const foreign = base + "/foreign"; await fs.mkdir(foreign); const sentinel = foreign + "/sentinel.json", original = JSON.stringify(empty()); await fs.writeFile(sentinel, original);
  for (const part of ["home", "data", "folder", "store", "lock"]) {
    let home = base + "/" + part; if (part === "home") { await fs.symlink(foreign, home); }
    else { await fs.mkdir(home); const paths = storage.deliverablePaths(home); if (part === "data") await fs.symlink(foreign, paths.data);
      else { await fs.mkdir(paths.data); if (part === "folder") await fs.symlink(foreign, paths.folder); else { await fs.mkdir(paths.folder); await fs.symlink(sentinel, part === "store" ? paths.file : paths.lock); } }
    }
    if (part !== "lock") await assert.rejects(storage.deliverableRequest(home, { action: "view", scope }), error => error.code === "boundary");
    await assert.rejects(storage.deliverableRequest(home, { action: "add", scope, value }), error => error.code === "boundary"); assert.equal(await fs.readFile(sentinel, "utf8"), original);
    assert.deepEqual((await fs.readdir(foreign)).sort(), ["sentinel.json"]);
  }
});

test("bounded owned reads reject oversized files before allocation and URLs cannot embed credentials", async t => {
  const home = await fs.mkdtemp("/private/tmp/deliverables-bounded-"); t.after(() => fs.rm(home, { recursive: true, force: true })); const paths = storage.deliverablePaths(home); await fs.mkdir(paths.folder, { recursive: true }); await fs.writeFile(paths.file, ""); await fs.truncate(paths.file, model.DELIVERABLE_LIMITS.bytes + 1);
  await assert.rejects(storage.deliverableRequest(home, { action: "view", scope }), error => error.code === "capacity"); assert.equal((await fs.stat(paths.file)).size, model.DELIVERABLE_LIMITS.bytes + 1);
  for (const location of ["https://user:password@example.test/a", "http://user@example.test/"]) { assert.throws(() => model.safeDeliverableUrl(location)); assert.throws(() => storage.validateDeliverable(scope, { kind: "url", location })); }
});

test("canonical item limits and response validation cannot poison a saved store or report a committed add as failed", async t => {
  const longName = "x".repeat(3900) + ".md", saved = add(empty(), { value: { kind: "file", location: longName } }); assert.equal(item(saved).title.length, 160); assert.equal(storage.decodeDeliverables(JSON.stringify(saved)).projects[0].items.length, 1);
  assert.throws(() => storage.validateDeliverable(scope, { kind: "url", location: "https://example.test/" + "中".repeat(1000) }), /encoded URL/);
  const home = await fs.mkdtemp("/private/tmp/deliverables-atomic-"); t.after(() => fs.rm(home, { recursive: true, force: true }));
  await assert.rejects(storage.deliverableRequest(home, { action: "add", scope, value, query: "x".repeat(201) }), /Search/);
  assert.equal((await storage.deliverableRequest(home, { action: "view", scope })).total, 0); await assert.rejects(fs.stat(storage.deliverablePaths(home).file), error => error.code === "ENOENT");
});
