import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as searchModel from "../mods/files-plus/search-model.js";
import * as workspaceModel from "../mods/files-plus/workspace-model.js";
import * as library from "../mods/files-plus/library-model.js";

function element() {
  const node = { childNodes: [], attrs: {}, events: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key === "child") return child => { target.childNodes.push(child); return proxy; };
    if (key === "children") return children => { target.childNodes.push(...children); return proxy; };
    if (key === "when") return (condition, callback) => condition ? callback(proxy) : proxy;
    if (key in target) return target[key];
    if (String(key).startsWith("on_")) return (...args) => { target.events[key] = args.at(-1); return proxy; };
    return value => { target.attrs[key] = value; return proxy; };
  } });
  return proxy;
}
function load(name, deps) {
  const source = readFileSync(new URL(`../mods/files-plus/${name}.js`, import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  return new Function(...Object.keys(deps), source)(...Object.values(deps));
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const remoteReply = (path, line, text) => ({ code: 0, stdout: JSON.stringify({ type: "match", data: { path: { text: `./${path}` }, line_number: line, lines: { text: `${text}\n` } } }) + "\n" });
const localReply = (path, line, text) => ({ code: 0, stdout: JSON.stringify({ matches: [{ path, line, text }] }) });
function runtime() {
  let rendering = false;
  const inputs = [], timers = [], tasks = [], state = new Map(), calls = [], reads = [], opens = [], closes = [];
  const cx = { notify() { assert(!rendering, "native changes must not publish during render"); }, stop_propagation() {}, focus_handle: () => ({ focus() {} }), spawn(callback) { const task = callback(cx); tasks.push(task); return { cancel() {} }; }, timer: {
    after(ms, callback) { const task = { ms, callback, cancelled: false, cancel() { this.cancelled = true; } }; timers.push(task); return task; },
    every(ms, callback) { const task = { ms, callback, interval: true, cancelled: false, cancel() { this.cancelled = true; } }; timers.push(task); return task; },
  } };
  const input = ({ value = "" } = {}) => {
    const events = {}, control = { value: () => value, set_value(next) { assert(!this.released); value = next; }, on(name, callback) { events[name] = callback; }, focus() { assert(!this.released); this.focuses = (this.focuses || 0) + 1; }, type(next) { assert(!this.released); value = next; events.change?.({}, cx); }, release() { this.released = true; } };
    inputs.push(control); return control;
  };
  const deps = { div: element, svg: element, h_flex: element, v_flex: element, Input: { new: element }, InputState: { new: input }, theme: () => ({}), shared: key => state.get(key), setShared(key, value) { assert(!rendering); state.set(key, value); },
    exec(program, argv, options) { const wait = deferred(); calls.push({ program, argv, options, ...wait }); return wait.promise; },
    readTextFile(path) { const wait = deferred(); reads.push({ path, ...wait }); return wait.promise; },
    appHome: () => "/fixture/herdr", openOverlay: value => opens.push(value), closeOverlay: value => closes.push(value), spaces: () => [], panes: () => [], focused: () => ({}) };
  return { cx, deps, inputs, timers, tasks, state, calls, reads, opens, closes,
    fire(ms) { for (const task of timers.splice(0)) { if (task.ms === ms && !task.cancelled) task.callback(cx); else timers.push(task); } },
    render(view) { rendering = true; try { return view.render(cx); } finally { rendering = false; } } };
}
function searchFixture(props = {}) {
  const f = runtime(); let context = { cwd: "/unrelated/focused", on: "focus-machine", space: "focus-space" };
  class Preview {
    constructor() { this.opens = []; this.clears = 0; }
    clear() { this.clears++; }
    open(root, path, on, _cx, line) { this.opens.push({ root, path, on, line }); }
    close() { this.closed = true; }
    refresh() { assert(!this.closed); }
    render() { return element(); }
  }
  const Search = load("search", { ...f.deps, ...searchModel, ...library, Preview, projectContext: () => ({ ...context }), fileIcon: element, closeButton: element });
  f.view = new Search(); f.view.init({ root: "/first", on: null, ...props }, f.cx);
  return { ...f, focus(next) { context = next; } };
}
function rootsFixture(context = { cwd: "/captured", on: null, space: "captured-space" }) {
  const f = runtime(), picks = []; let spaces = [{ id: context.space, machine: "surrounding-space-machine" }];
  const Manager = load("workspace-roots", { ...f.deps, ...workspaceModel, spaces: () => spaces, pickFolder(options) { const wait = deferred(); picks.push({ options, ...wait }); return wait.promise; } });
  f.view = new Manager(); f.view.init({ context, overlay: "folder-manager" }, f.cx);
  return { ...f, picks, liveSpaces(value) { spaces = value; } };
}

test("production workspace search uses two workers, preserves source ordering, and previews the selected root and machine", async () => {
  const f = searchFixture({ roots: [{ root: "/first", name: "First", on: null }, { root: "/second", name: "Second", on: "server" }, { root: "/third", name: "Third", on: "server-2" }] });
  f.view.query.set_value("needle"); f.view.run(f.cx); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].program, "node"); assert.equal(JSON.parse(f.calls[0].argv[1]).root, "/first");
  assert.equal(f.calls[1].options.cwd, "/second"); assert.equal(f.calls[1].options.on, "server");
  f.calls[1].resolve(remoteReply("same.js", 22, "second needle")); await flush();
  assert.equal(f.calls.length, 3); assert.equal(f.calls[2].options.cwd, "/third");
  f.calls[2].resolve(remoteReply("same.js", 33, "third needle")); f.calls[0].resolve(localReply("same.js", 11, "first needle")); await flush();
  assert.deepEqual(f.view.matches.map(match => [match.root, match.on, match.line]), [["/first", null, 11], ["/second", "server", 22], ["/third", "server-2", 33]]);
  assert.equal(searchModel.groupedMatches(f.view.matches).length, 3);
  f.focus({ cwd: "/elsewhere", on: "different", space: "new-space" }); f.view.choose(f.view.matches[1], f.cx);
  assert.deepEqual(f.view.preview.opens.at(-1), { root: "/second", path: "same.js", on: "server", line: 22 });
  assert.deepEqual(library.libraryFor(f.state.get(library.LIBRARY_KEY), "/second", "server").recent, ["same.js"]);
  assert.equal(library.libraryFor(f.state.get(library.LIBRARY_KEY), "/elsewhere", "different").recent.length, 0);
  f.render(f.view);
});

test("production stale searches cannot replace a later query or launch additional old roots", async () => {
  const roots = ["/one", "/two", "/three"].map(root => ({ root, on: "server" })), f = searchFixture({ roots });
  f.view.query.set_value("old"); f.view.run(f.cx); assert.equal(f.calls.length, 2);
  f.view.query.type("fresh"); f.view.run(f.cx); assert.equal(f.calls.length, 4);
  f.calls[0].resolve(remoteReply("old.js", 1, "old")); f.calls[1].resolve(remoteReply("old.js", 1, "old")); await flush();
  assert.equal(f.calls.length, 4); assert.equal(f.view.loading, true); assert.deepEqual(f.view.matches, []);
  f.calls[2].resolve(remoteReply("fresh.js", 2, "fresh")); await flush(); assert.equal(f.calls.length, 5);
  f.calls[3].resolve(remoteReply("fresh.js", 3, "fresh")); f.calls[4].resolve(remoteReply("fresh.js", 4, "fresh")); await flush();
  assert.equal(f.view.searched, "fresh"); assert.equal(f.view.matches.length, 3); assert(f.view.matches.every(match => match.path === "fresh.js"));
  f.fire(300); assert.equal(f.calls.length, 5);
});

test("production search close cancels its refresh timer, releases inputs and ignores delayed focus, debounce and results", async () => {
  const f = searchFixture({ roots: [{ root: "/one", on: "server" }, { root: "/two", on: "server" }, { root: "/three", on: "server" }] });
  f.view.query.type("needle"); f.view.run(f.cx); const timer = f.timers.find(timer => timer.interval);
  f.view.close(); assert.equal(timer.cancelled, true); assert(f.inputs.every(input => input.released)); assert(f.view.preview.closed);
  f.fire(0); f.fire(300); assert.equal(f.calls.length, 2);
  for (const call of f.calls) call.resolve(remoteReply("after-close.js", 1, "needle")); await flush();
  assert.equal(f.calls.length, 2); assert.deepEqual(f.view.matches, []); assert.equal(f.opens.length, 0);
});

test("production clearing a query clears the previous selected file and preview", () => {
  const f = searchFixture(); f.view.choose({ path: "old.js", line: 7 }, f.cx); const before = f.view.preview.clears;
  f.view.query.set_value(""); f.view.run(f.cx);
  assert.equal(f.view.selected, null); assert.equal(f.view.preview.clears, before + 1); assert.deepEqual(f.view.matches, []);
});

test("production a single explicit root keeps its machine when creating a preview", async () => {
  const f = searchFixture({ on: null, roots: [{ root: "/single-remote", on: "server" }] });
  f.view.query.set_value("needle"); f.view.run(f.cx); f.calls[0].resolve(remoteReply("same.js", 9, "needle")); await flush();
  f.view.choose(f.view.matches[0], f.cx);
  assert.deepEqual(f.view.preview.opens.at(-1), { root: "/single-remote", path: "same.js", on: "server", line: 9 });
});

test("production reference captures the clicked root, machine, relative path and line before an async companion check", async () => {
  const f = searchFixture(), match = { root: "/second", on: "server", path: "path with spaces/file.js", line: 71 };
  f.view.choose(match, f.cx); f.view.reference(f.cx); f.view.reference(f.cx); assert.equal(f.reads.length, 1);
  f.view.choose({ root: "/third", on: null, path: "other.js", line: 2 }, f.cx); f.focus({ cwd: "/new", on: "new-server" });
  f.reads[0].resolve("{}"); await flush();
  assert.deepEqual(f.opens[0].props.reference, { root: "/second", on: "server", relative: "path with spaces/file.js", line: 71 });
  assert.equal(f.opens[0].props.role, "reference");
  const g = searchFixture(); g.view.choose(match, g.cx); g.view.reference(g.cx); g.view.close(); g.reads[0].resolve("{}"); await flush();
  assert.equal(g.opens.length, 0);
});

test("production workspace search retains successful roots when another root fails", async () => {
  const f = searchFixture({ roots: [{ root: "/missing", name: "Missing", on: "server" }, { root: "/good", name: "Good", on: "server" }] });
  f.view.query.set_value("needle"); f.view.run(f.cx); f.calls[0].reject(new Error("offline")); f.calls[1].resolve(remoteReply("ok.js", 5, "needle")); await flush();
  assert.equal(f.view.matches.length, 1); assert.equal(f.view.matches[0].root, "/good"); assert.match(f.view.warning, /Missing: offline/); assert.equal(f.view.loading, false);
});

test("production folder picker reserves busy state and ignores a chosen path after its manager closes", async () => {
  const f = rootsFixture(); f.view.pick(f.cx); f.view.pick(f.cx); f.view.save(f.cx);
  assert.equal(f.picks.length, 1); assert.equal(f.view.busy, true); assert.equal(f.state.size, 0); assert.equal(f.closes.length, 0);
  f.view.close(); f.picks[0].resolve("/late-choice"); await flush();
  assert.equal(f.calls.length, 0); assert.equal(f.view.roots.length, 1); assert(f.inputs[0].released); assert.equal(f.state.size, 0);
});

test("production folder validation and Save stay on captured root/machine when the surrounding space differs", async () => {
  const context = { cwd: "/captured", on: "root-server", space: "captured-space" }, f = rootsFixture(context);
  context.cwd = "/changed-props"; context.on = "changed-machine";
  f.view.add("/more", f.cx); assert.equal(f.calls[0].options.on, "root-server"); assert.deepEqual(f.calls[0].argv, ["-c", 'test -d "$1"', "workspace-folder", "/more"]);
  f.view.save(f.cx); assert.equal(f.state.size, 0);
  f.liveSpaces([{ id: "captured-space", machine: "elsewhere" }, { id: "new-focus", machine: null }]);
  f.calls[0].resolve({ code: 0 }); await flush(); f.view.save(f.cx);
  const state = f.state.get(workspaceModel.WORKSPACES_KEY), captured = { cwd: "/captured", on: "root-server", space: "captured-space" };
  assert.deepEqual(workspaceModel.workspaceRoots(state, captured).map(root => root.path), ["/captured", "/more"]);
  assert.equal(workspaceModel.workspaceRecord(state, context), null); assert.deepEqual(f.closes, ["folder-manager"]);
});

test("production folder results cannot append to a closed captured workspace or a disposed manager", async () => {
  const f = rootsFixture(); f.view.add("/more", f.cx); f.liveSpaces([]); f.calls[0].resolve({ code: 0 }); await flush();
  assert.equal(f.view.roots.length, 1); assert.match(f.view.error, /workspace has closed/); f.view.save(f.cx); assert.equal(f.state.size, 0);
  const g = rootsFixture(); g.view.add("/more", g.cx); g.view.close(); g.calls[0].resolve({ code: 0 }); await flush();
  assert.equal(g.view.roots.length, 1); assert.equal(g.state.size, 0);
});

test("production picker validation completes before Save and captured-revision conflicts preserve the newer mapping", async () => {
  const f = rootsFixture(); f.view.pick(f.cx); f.picks[0].resolve("/picked"); await flush();
  assert.equal(f.calls.length, 1); assert.equal(f.view.busy, true); f.view.save(f.cx); assert.equal(f.state.size, 0);
  f.calls[0].resolve({ code: 0 }); await flush(); assert.equal(f.view.busy, false); assert.equal(f.view.roots[1].path, "/picked");
  const context = f.view.context, newer = workspaceModel.saveWorkspace(null, context, [{ path: "/newer" }]);
  f.state.set(workspaceModel.WORKSPACES_KEY, newer); f.view.save(f.cx);
  assert.match(f.view.error, /another view/); assert.equal(f.state.get(workspaceModel.WORKSPACES_KEY), newer); assert.equal(f.closes.length, 0);
});

test("production search mode and filters are captured for each worker while obsolete modes stay invisible", async () => {
  const f = searchFixture({ roots: [{ root: "/one", on: "server" }, { root: "/two", on: "server" }] });
  f.view.query.set_value("same"); f.view.include.set_value("*.js"); f.view.exclude.set_value("vendor/**"); f.view.options.hidden = true; f.view.run(f.cx);
  const old = [...f.calls]; assert(old[0].argv.includes("--json"));
  f.view.mode = "files"; f.view.schedule(f.cx); f.view.run(f.cx);
  const fresh = f.calls.slice(2); assert(fresh.every(call => call.argv.includes("--files") && call.argv.includes("--hidden")));
  assert(fresh[0].argv.includes("*.js")); assert(fresh[0].argv.includes("!vendor/**"));
  old[0].resolve(remoteReply("obsolete.js", 1, "same")); old[1].resolve(remoteReply("obsolete.js", 1, "same"));
  fresh[0].resolve({ code: 0, stdout: "same.js\0different.js\0" }); fresh[1].resolve({ code: 0, stdout: "same.js\0" }); await flush();
  assert.equal(f.view.matches.length, 2); assert(f.view.matches.every(match => match.path === "same.js" && match.line === null));
  f.view.choose(f.view.matches[1], f.cx); f.view.reference(f.cx); f.reads[0].resolve("{}"); await flush();
  assert.deepEqual(f.opens[0].props.reference, { root: "/two", on: "server", relative: "same.js", line: null });
});
