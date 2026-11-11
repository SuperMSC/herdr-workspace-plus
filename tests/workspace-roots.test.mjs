import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as model from "../mods/files-plus/workspace-model.js";
import * as search from "../mods/files-plus/search-model.js";
import * as browserModel from "../mods/files-plus/model.js";
import * as library from "../mods/files-plus/library-model.js";

function element() {
  const node = { childNodes: [], attrs: {}, events: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key === "child") return child => { target.childNodes.push(child); return proxy; };
    if (key === "children") return children => { target.childNodes.push(...children); return proxy; };
    if (key === "when") return (value, fn) => value ? fn(proxy) : proxy;
    if (key in target) return target[key];
    if (String(key).startsWith("on_")) return (...args) => { target.events[key] = args.at(-1); return proxy; };
    return value => { target.attrs[key] = value; return proxy; };
  } });
  return proxy;
}
const nodes = node => !node || typeof node !== "object" ? [] : [node, ...node.childNodes.flatMap(nodes)];
const find = (tree, id) => nodes(tree).find(node => node.attrs.id === id);
function load(name, deps) {
  const code = readFileSync(new URL(`../mods/files-plus/${name}.js`, import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  return new Function(...Object.keys(deps), code)(...Object.values(deps));
}
function input() { let value = ""; return { value: () => value, set_value(next) { value = next; }, on() {}, focus() {}, release() {} }; }

test("workspace mappings survive preview focus, separate machines and validate absolute roots", () => {
  const context = { cwd: "/main", space: "s1", on: null };
  const roots = model.addWorkspaceRoot(model.workspaceRoots(null, context), "/other/config");
  const state = model.saveWorkspace(null, context, roots, "null");
  assert.deepEqual(model.workspaceRoots(JSON.parse(JSON.stringify(state)), { ...context, cwd: "/other/config" }).map(root => root.path), ["/main", "/other/config"]);
  assert.deepEqual(model.workspaceRoots(state, { ...context, on: "server" }).map(root => root.path), ["/main"]);
  assert.equal(model.normalizeWorkspaceRoot("C:\\"), "C:/");
  assert.equal(model.normalizeWorkspaceRoot("/"), "/");
  assert.throws(() => model.addWorkspaceRoot(roots, "/main/"), /already/);
  assert.throws(() => model.normalizeWorkspaceRoot("../escape"), /absolute/);
  assert.throws(() => model.normalizeWorkspaceRoot("/root/../escape"), /parent/);
  assert.throws(() => model.normalizeWorkspaceRoot("/root\nsecret"), /absolute/);
});

test("folder changes use captured revisions, never evict configured workspaces and reset mappings only", () => {
  const context = { cwd: "/main", space: "s1" };
  let state = model.saveWorkspace(null, context, [{ path: "/main" }], "null");
  assert.throws(() => model.saveWorkspace(state, context, [{ path: "/different" }], "null"), /another view/);
  for (let index = 2; index <= model.WORKSPACE_LIMIT; index++) state = model.saveWorkspace(state, { cwd: `/p${index}`, space: `s${index}` }, [{ path: `/p${index}` }]);
  assert.throws(() => model.saveWorkspace(state, { cwd: "/overflow", space: "overflow" }, [{ path: "/overflow" }]), /limit/);
  assert.equal(model.workspaceRoots(state, context)[0].path, "/main");
  const snapshot = JSON.stringify(state.workspaces[model.workspaceKey(context)]);
  const reset = model.resetWorkspace(state, context, snapshot);
  assert.equal(model.workspaceRecord(reset, context), null);
  assert.equal(Object.keys(reset.workspaces).length, model.WORKSPACE_LIMIT - 1);
});

test("search keeps same-name files in distinct roots and reports partial failures and the global bound", () => {
  const result = search.combineWorkspaceResults([
    { source: { root: "/front", on: null, name: "Front" }, matches: [{ path: "src/main.js", line: 1, text: "front" }] },
    { source: { root: "/back", on: "server", name: "Back" }, matches: [{ path: "src/main.js", line: 9, text: "back" }] },
    { source: { root: "/missing", name: "Missing" }, error: "unavailable" },
  ]);
  const groups = search.groupedMatches(result.matches);
  assert.equal(groups.length, 2); assert.notEqual(groups[0].key, groups[1].key);
  assert.equal(groups[1].root, "/back"); assert.equal(groups[1].matches[0].on, "server");
  assert.match(result.warning, /Missing: unavailable/);
  const many = search.combineWorkspaceResults([{ source: { root: "/front" }, matches: Array.from({ length: 510 }, (_, index) => ({ path: `${index}.js` })) }]);
  assert.equal(many.matches.length, 500); assert.match(many.warning, /500/);
});

test("workspace browser retains roots while linked previews move focus and closes stale child browsers", () => {
  let current = { cwd: "/main", space: "s1", on: null }, rendering = false;
  const state = {}, timers = [], instances = [], overlays = [];
  const cx = { notify() { assert(!rendering); }, timer: { after(_ms, fn) { timers.push(fn); } } };
  class Browser {
    init(props) { this.source = props.source; this.root = props.source.cwd; this.on = props.source.on; this.mode = "tree"; this.path = ""; instances.push(this); }
    refresh() { this.root = this.source.cwd; this.refreshes = (this.refreshes || 0) + 1; }
    scheduleSync() { this.syncs = (this.syncs || 0) + 1; }
    close() { this.closed = true; }
    pause(value) { this.paused = value; }
    visibleEntries() { return [{ path: "same.txt", name: "same.txt" }]; }
    row(entry, _t, prefix) { return element().id(prefix + "-" + entry.path).on_click(() => { this.opened = this.root + "/" + entry.path; }); }
    foldState() { return { usable: true, open: false }; }
    foldAll() {}
    libraryHeader() { return element(); }
    render(context, navigation) { return navigation ? navigation({}, context) : element().id("single"); }
  }
  const deps = { ...model, Browser, projectContext: () => ({ ...current }), div: element, svg: element, v_flex: element, h_flex: element, iconButton: (id, _icon, _label, action) => element().id(id).on_click(action), fileIcon: element,
    shared: key => state[key], setShared: (key, value) => { assert(!rendering); state[key] = value; }, settings: () => ({}), theme: () => ({}), EXPAND_LIMIT: 80, openOverlay: value => overlays.push(value) };
  const Workspace = load("workspace-browser", deps), view = new Workspace();
  state[model.WORKSPACES_KEY] = model.saveWorkspace(null, current, [{ path: "/main" }, { path: "/other" }]);
  view.init({}, cx);
  const render = () => { rendering = true; try { return view.render(cx); } finally { rendering = false; } };
  let tree = render(); assert(find(tree, "workspace-0-same.txt")); assert(find(tree, "workspace-1-same.txt"));
  assert.equal(instances[0].syncs, 1); assert.equal(instances[1].syncs, 1);
  find(tree, "workspace-1-same.txt").events.on_click(); assert.equal(instances[1].opened, "/other/same.txt");
  current.cwd = "/other"; render(); assert.equal(timers.length, 0); assert.equal(view.main.root, "/main");
  find(tree, "workspace-root-1").events.on_click({}, cx); assert.equal(instances[1].paused, true);
  state[model.WORKSPACE_FOLDS_KEY] = { [model.workspaceKey(current)]: [] }; render(); timers.shift()(cx);
  assert.equal(instances[1].paused, false); assert.equal(instances[1].refreshes, undefined);
  state[model.WORKSPACE_FOLDS_KEY] = { [model.workspaceKey(current)]: { malformed: true } }; render();
  assert.equal(timers.length, 0);
  current = { cwd: "/new", space: "s2", on: null }; render(); timers.shift()(cx);
  assert(instances[0].closed); assert(instances[1].closed); assert.equal(view.main.root, "/new");
  view.close(); assert(view.main.closed);
});

test("real browser rows namespace their children and keep reference/menu targets on the owning root", () => {
  const calls = [], overlays = [];
  const deps = { ...browserModel, ...library, projectContext: () => ({}), div: element, svg: element, v_flex: element, h_flex: element, fileIcon: element, iconButton: (id, _icon, _label, action) => element().id(id).on_click(action),
    shared: () => null, setShared() {}, openFileTab: value => calls.push(value), window: () => ({ platform: "macos" }), settings: () => ({}), openOverlay: value => overlays.push(value), theme: () => ({}) };
  const Browser = load("browser", deps), view = new Browser();
  Object.assign(view, { root: "/other", on: "server", file: null, mode: "tree", folders: new Set(), marks: {}, handle: { focus() {} } });
  const cx = { notify() {}, stop_propagation() {} };
  const row = view.row({ path: "same.txt", name: "same.txt", dir: false, depth: 0 }, {}, "second-root");
  assert.equal(row.attrs.id, "second-root-same.txt"); row.events.on_click({}, cx);
  assert.deepEqual(calls, [{ root: "/other", path: "same.txt", on: "server" }]);
  row.events.on_mouse_down({}, cx); assert.equal(overlays[0].props.target.root, "/other"); assert.equal(overlays[0].props.target.on, "server");
});

globalThis.window = { viewport_size: () => ({ width: 1200, height: 900 }) };


test("paused browsers consume rename metadata once without rescheduling hidden-folder reloads, and release child tasks", () => {
  const state = {}, timers = []; let timerCancelled = 0, watcherCancelled = 0, refreshes = 0;
  const Browser = load("browser", { ...browserModel, ...library, projectContext: () => ({ cwd: "/other", on: null }), shared: key => state[key], setShared() {}, openFileTab() {}, div: element, svg: element, h_flex: element, v_flex: element, fileIcon: element, iconButton: element });
  const view = new Browser(), cx = { notify() {}, timer: { after(_ms, fn) { timers.push(fn); } } };
  Object.assign(view, { root: "/other", on: null, source: { cwd: "/other", on: null }, context: { key: JSON.stringify({ cwd: "/other", on: null }), showHidden: false }, file: "old/a.txt", folders: new Set(["old"]), browseFolder: "old", folderRequests: new Map(), pending: new Set(), entries: new Map(), refreshTimer: { cancel() { timerCancelled++; } }, watchTask: { cancel() { watcherCancelled++; } } });
  view.show = file => { view.file = file; };
  view.refresh = () => { if (!view.paused) refreshes++; };
  view.pause(true, cx); state[browserModel.SHOW_HIDDEN_KEY] = true;
  view.scheduleSync(cx); assert.equal(timers.length, 0);
  state[browserModel.CHANGE_KEY] = { revision: "renamed", action: "rename", target: { root: "/other", on: null, relative: "old", dir: true }, name: "new" };
  view.scheduleSync(cx); assert.equal(timers.length, 1); timers.shift()(cx);
  assert.equal(view.file, "new/a.txt"); assert.deepEqual([...view.folders], ["new"]); assert.equal(refreshes, 0);
  view.scheduleSync(cx); assert.equal(timers.length, 0);
  view.pause(false, cx); assert.equal(refreshes, 1);
  view.close(); assert.equal(timerCancelled, 1); assert(watcherCancelled >= 2); assert.equal(view.context, null);
});


test("replacing eight folded roots does not strand new folders behind obsolete fold entries", () => {
  const context = { cwd: "/main", on: null, space: "s" }, state = {}, roots = [{ path: "/new-a" }, { path: "/new-b" }];
  state[model.WORKSPACES_KEY] = model.saveWorkspace(null, context, roots);
  state[model.WORKSPACE_FOLDS_KEY] = { [model.workspaceKey(context)]: Array.from({ length: 8 }, (_, i) => model.rootKey(`/old-${i}`, null)) };
  const Workspace = load("workspace-browser", { ...model, shared: key => state[key], setShared: (key, value) => { state[key] = value; }, projectContext: () => context });
  const view = new Workspace(); view.p = {}; view.context = context; view.roots = roots;
  const browsers = roots.map(() => ({ pause(value) { this.paused = value; } }));
  view.children = new Map(roots.map((root, i) => [model.rootKey(root.path, null), browsers[i]]));
  view.toggle(model.rootKey(roots[0].path, null), { notify() {} });
  assert.equal(browsers[0].paused, true); assert.equal(browsers[1].paused, false);
  assert.deepEqual([...view.folded()], [model.rootKey("/new-a", null)]);
  assert.equal(state[model.WORKSPACE_FOLDS_KEY][model.workspaceKey(context)].length, 1);
});
