import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as library from "../mods/files-plus/library-model.js";
import * as model from "../mods/files-plus/model.js";

const FILE_TABS_KEY = "files-plus.file-tabs.v1";
const source = readFileSync(new URL("../mods/files-plus/file-preview.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace("export default class", "return class");
function element() {
  const node = { childNodes: [], attrs: {}, events: {} };
  const proxy = new Proxy(node, { get(object, key) {
    if (key === "child") return child => { node.childNodes.push(child); return proxy; };
    if (key === "children") return children => { node.childNodes.push(...children); return proxy; };
    if (key === "when") return (condition, callback) => condition ? callback(proxy) : proxy;
    if (key in object) return object[key];
    if (key.startsWith("on_")) return (...args) => { node.events[key] = args.at(-1); return proxy; };
    return value => { node.attrs[key] = value; return proxy; };
  } });
  return proxy;
}
const nodes = node => !node || typeof node !== "object" ? [] : [node, ...node.childNodes.flatMap(nodes)];
const find = (tree, id) => nodes(tree).find(node => node.attrs.id === id);
function harness({ props = {}, storedPath, tabName = "old.py", registered = true, header = false } = {}) {
  const p = { root: "/captured", path: "src/old.py", on: null, previewId: "preview-1", ...props };
  const row = { tab: "file-tab", pane: "file-pane", space: "space-1", root: p.root, path: storedPath || p.path, on: p.on, previewId: p.previewId };
  const state = { [FILE_TABS_KEY]: { tabs: registered ? { [row.tab]: row } : {}, pending: { other: "preserve" } }, [model.CHANGE_KEY]: { revision: 1 } };
  let allSpaces = [{ id: "space-1", active: true, folder: "/unrelated", tabs: [{ id: "file-tab", active: true, name: tabName }, { id: "terminal-tab", active: false, name: "Terminal" }] }];
  let allPanes = [{ pane: "file-pane", tab: "file-tab", mod: "files-plus", terminal: null }], rendering = false, notifications = 0, stopped = 0;
  const opens = [], refreshes = [], closures = [], after = [], every = [], writes = [], commands = [], overlays = [];
  const cx = { notify() { assert(!rendering, "render must never notify"); notifications++; }, stop_propagation() { stopped++; },
    timer: { after(ms, callback) { after.push({ ms, callback }); }, every(ms, callback) { every.push({ ms, callback }); } } };
  const deps = { ...library, ...model, FILE_TABS_KEY, DIRTY_KEY: "files-plus.dirty.v1", headerShown: () => header, div: element, h_flex: element, v_flex: element, fileIcon: element,
    iconButton: (id, _icon, label, callback) => element().id(id).tooltip(label).on_click(callback),
    Preview: class { open(root, path, on) { opens.push({ root, path, on }); } refresh() { refreshes.push(true); } close() { closures.push(true); } render() { return element().id("preview-body"); } },
    theme: () => ({}), settings: () => ({ zoom: 1 }), window: () => ({ platform: "macos" }),
    spaces: () => allSpaces, panes: () => allPanes, shared: key => state[key],
    setShared(key, value) { assert(!rendering, "render must never write shared state"); state[key] = value; writes.push(key); },
    run(...args) { assert(!rendering, "render must never run commands"); commands.push(args); }, openOverlay: spec => overlays.push(spec) };
  const FilePreview = new Function(...Object.keys(deps), source)(...Object.values(deps)), view = new FilePreview();
  view.init(p, cx);
  return { view, cx, p, row, state, opens, refreshes, closures, after, every, writes, commands, overlays,
    notifications: () => notifications, stopped: () => stopped,
    setSpaces(value) { allSpaces = value; }, setPanes(value) { allPanes = value; },
    change(action, target = {}, extra = {}) { state[model.CHANGE_KEY] = { revision: (state[model.CHANGE_KEY]?.revision || 0) + 1, action, ...extra, target: { ...model.targetFor(p.root, p.path, false, p.on, "macos"), ...target } }; },
    render() { rendering = true; try { return view.render(cx); } finally { rendering = false; } },
    flush() { while (after.length) after.shift().callback(cx); } };
}
globalThis.window = { viewport_size: () => ({ width: 1400, height: 900 }) };

test("center file preview captures its source and never follows another tab's folder or machine", () => {
  const f = harness({ props: { root: "/remote/project", on: "remote", path: "a.py" } });
  assert.deepEqual(f.opens, [{ root: "/remote/project", path: "a.py", on: "remote" }]);
  f.setSpaces([{ id: "other-space", active: true, folder: "/elsewhere", machine: "different", tabs: [] }]);
  f.render();
  assert.equal(f.view.root, "/remote/project"); assert.equal(f.view.on, "remote"); assert.equal(f.view.path, "a.py");
  assert.deepEqual(f.opens, [{ root: "/remote/project", path: "a.py", on: "remote" }]);
});

test("reopened preview restores a registered renamed path but ignores a replaced terminal pane", () => {
  const f = harness({ storedPath: "lib/new.py" });
  assert.equal(f.view.path, "lib/new.py"); assert.equal(f.opens[0].path, "lib/new.py");
  f.setPanes([{ pane: "file-pane", tab: "file-tab", mod: "files-plus", terminal: "t9" }]);
  assert.equal(f.view.record(), null);
  const g = harness({ registered: false }); assert.equal(g.view.path, "src/old.py");
});

test("rename is deferred out of render, coalesced, and updates only the captured tab registry and title", () => {
  const f = harness();
  f.state[FILE_TABS_KEY].tabs.other = { ...f.row, tab: "other", previewId: "other-preview", path: "keep.py" };
  f.change("rename", {}, { name: "new.py" });
  f.render(); f.render();
  assert.equal(f.after.length, 1); assert.deepEqual(f.writes, []); assert.equal(f.notifications(), 0);
  f.flush();
  assert.equal(f.view.path, "src/new.py"); assert.equal(f.state[FILE_TABS_KEY].tabs["file-tab"].path, "src/new.py");
  assert.equal(f.state[FILE_TABS_KEY].tabs.other.path, "keep.py"); assert.deepEqual(f.state[FILE_TABS_KEY].pending, { other: "preserve" });
  assert.deepEqual(f.commands, [["tab.rename", { id: "file-tab", name: "new.py" }]]);
  assert.deepEqual(f.opens.at(-1), { root: "/captured", path: "src/new.py", on: null });
  f.render(); assert.equal(f.after.length, 0);
});

test("rename preserves a custom tab title and ignores changes from another project or machine", () => {
  const f = harness({ tabName: "My review" });
  for (const target of [{ root: "/other" }, { on: "remote" }]) {
    f.change("rename", target, { name: "wrong.py" }); f.render(); f.flush();
  }
  assert.equal(f.opens.length, 1); assert.deepEqual(f.refreshes, []); assert.deepEqual(f.writes, []);
  f.change("rename", {}, { name: "new.py" }); f.render(); f.flush();
  assert.equal(f.view.path, "src/new.py"); assert.deepEqual(f.commands, []);
});

test("trash re-reads the captured path so the preview can show its missing-file state", () => {
  const f = harness(); f.change("trash"); f.render(); f.flush();
  assert.deepEqual(f.refreshes, [true]); assert.equal(f.opens.length, 1);
  assert.equal(f.view.path, "src/old.py"); assert.deepEqual(f.commands, []);
});

test("only the active preview tab polls, and closing blocks queued sync and later timer refreshes", () => {
  const f = harness(); assert.equal(f.every[0].ms, 10000);
  f.every[0].callback(f.cx); assert.equal(f.refreshes.length, 1);
  f.setSpaces([{ id: "space-1", active: true, tabs: [{ id: "file-tab", active: false }, { id: "terminal-tab", active: true }] }]);
  f.every[0].callback(f.cx); assert.equal(f.refreshes.length, 1);
  f.setSpaces([{ id: "space-1", active: false, tabs: [{ id: "file-tab", active: true }] }, { id: "other", active: true, tabs: [] }]);
  f.every[0].callback(f.cx); assert.equal(f.refreshes.length, 1);
  f.change("rename", {}, { name: "too-late.py" }); f.render();
  f.view.close(); f.flush();
  f.setSpaces([{ id: "space-1", active: true, tabs: [{ id: "file-tab", active: true }] }]);
  f.every[0].callback(f.cx); f.render();
  assert.deepEqual(f.closures, [true]); assert.equal(f.refreshes.length, 1); assert.equal(f.opens.length, 1);
  assert.deepEqual(f.commands, []); assert.deepEqual(f.writes, []); assert.equal(f.after.length, 0);
});

test("file actions and pin changes target the preview's captured root, file and machine", () => {
  const f = harness({ props: { root: "/remote/project", path: "src/a.py", on: "server" } });
  f.state[library.LIBRARY_KEY] = library.updateLibrary(null, "/other", null, "pin", "keep.py");
  const tree = f.render();
  find(tree, "file-tab-actions").events.on_click({}, f.cx);
  assert.equal(f.stopped(), 1); assert.equal(f.overlays[0].kind, "popup");
  assert.deepEqual(f.overlays[0].props.target, model.targetFor("/remote/project", "src/a.py", false, "server", "macos"));
  find(tree, "file-tab-pin").events.on_click({}, f.cx);
  assert.deepEqual(library.libraryFor(f.state[library.LIBRARY_KEY], "/remote/project", "server").pinned, ["src/a.py"]);
  assert.deepEqual(library.libraryFor(f.state[library.LIBRARY_KEY], "/other", null).pinned, ["keep.py"]);
  find(f.render(), "file-tab-pin").events.on_click({}, f.cx);
  assert.deepEqual(library.libraryFor(f.state[library.LIBRARY_KEY], "/remote/project", "server").pinned, []);
});

test("invalid file targets show an error before any preview read or file action is exposed", () => {
  for (const props of [{ root: "" }, { path: "../outside" }, { path: "/absolute" }]) {
    const f = harness({ props, registered: false }), tree = f.render();
    assert.match(f.view.error, /No valid file/); assert.deepEqual(f.opens, []); assert.deepEqual(f.every, []);
    assert(!find(tree, "file-tab-actions")); assert(!find(tree, "file-tab-pin"));
  }
});

test("with the workspace pane header, the preview drops its own toolbar", () => {
  const f = harness({ header: true }), tree = f.render();
  assert(!find(tree, "file-tab-actions")); assert(!find(tree, "file-tab-pin")); assert(find(tree, "preview-body"));
});
