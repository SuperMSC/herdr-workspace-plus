import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as library from "../mods/files-plus/library-model.js";
import * as model from "../mods/files-plus/model.js";

const FILE_TABS_KEY = "files-plus.file-tabs.v1";
const source = readFileSync(new URL("../mods/files-plus/pane-header.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace("export default class PaneHeader", "class PaneHeader")
  .replaceAll("export function", "function").replace("export const", "const") + "\nreturn { PaneHeader, usesHeader, previewIn, headerShown };";
function element(tag = "div") {
  const node = { tag, childNodes: [], attrs: {}, events: {} };
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
const texts = tree => nodes(tree).flatMap(node => node.childNodes.filter(child => typeof child === "string"));

function harness({ pane = "file-pane", tree = null } = {}) {
  const row = { tab: "file-tab", pane: "file-pane", space: "s", root: "/Users/me/project", path: "src/deep/app.py", on: null, previewId: "p" };
  const state = { [FILE_TABS_KEY]: { tabs: { [row.tab]: row } } }, overlays = [], commands = [];
  const all = [
    { pane: "file-pane", tab: "file-tab", mod: "files-plus", terminal: null, title: "files-plus", focused: true, zoomed: false },
    { pane: "term-pane", tab: "term-tab", terminal: "t1", title: "zsh", cwd: "/Users/me/project", status: "working", program: { name: "Claude Code", agent: true, icon: null }, zoomed: false },
  ];
  const deps = { ...library, ...model, FILE_TABS_KEY, DIRTY_KEY: "files-plus.dirty.v1", div: () => element(), svg: path => element("svg").path?.(path) ?? element("svg"), image: () => element("image"), h_flex: () => element(),
    fileIcon: path => element("icon").id(`icon-${path}`), iconButton: (id, _icon, label, callback) => element().id(id).tooltip(label).on_click(callback),
    panes: () => all, spaces: () => [{ id: "s", tabs: [{ id: "file-tab", name: "app.py" }, { id: "term-tab", name: "Claude" }] }],
    props: () => ({ pane, terminal: null, role: "pane-header" }), run: (...args) => commands.push(args), theme: () => ({ blocked: "#f00" }), home: () => "/Users/me",
    shared: key => state[key], setShared: (key, value) => { state[key] = value; }, openOverlay: spec => overlays.push(spec),
    settings: () => ({ zoom: 1 }), window: () => ({ platform: "macos" }), layout: () => tree };
  globalThis.window = { viewport_size: () => ({ width: 1400, height: 900 }) };
  const api = new Function(...Object.keys(deps), source)(...Object.values(deps));
  const view = new api.PaneHeader(); view.init({ pane });
  return { api, view, state, overlays, commands, cx: { notify() {}, stop_propagation() {} } };
}

test("the header is detected only on tab blocks that use the Files Plus role", () => {
  const { api } = harness();
  const on = { type: "row", children: [{ type: "block", content: { tab: "active", pane: { header: { content: { mod: "files-plus", props: { role: "pane-header" } } } } } }] };
  assert.equal(api.usesHeader(on), true);
  assert.equal(api.usesHeader({ type: "block", content: { tab: "active", pane: { header: { content: { mod: "pane" } } } } }), false);
  assert.equal(api.usesHeader(null), false);
  assert.equal(harness({ tree: on }).api.headerShown(), true);
  assert.equal(api.previewIn("file-pane", { a: { pane: "file-pane", path: "x" } }).path, "x");
  assert.equal(api.previewIn("missing", {}), null);
});

test("a file preview pane shows its file, folder, pin and actions in the header", () => {
  const f = harness(), tree = f.view.render();
  assert(find(tree, "icon-src/deep/app.py"));
  assert(texts(tree).includes("app.py")); assert(texts(tree).includes("~/project/src/deep"));
  assert(!texts(tree).includes("files-plus"));
  find(tree, "ph-pin-file-pane").events.on_click({}, f.cx);
  assert.deepEqual(library.libraryFor(f.state[library.LIBRARY_KEY], "/Users/me/project", null).pinned, ["src/deep/app.py"]);
  find(tree, "ph-more-file-pane").events.on_click({}, f.cx);
  assert.equal(f.overlays[0].props.role, "menu"); assert.equal(f.overlays[0].props.target.path, "/Users/me/project/src/deep/app.py");
});

test("a terminal pane keeps Herdr's header: program name, folder and status", () => {
  const f = harness({ pane: "term-pane" }), tree = f.view.render();
  assert(texts(tree).includes("Claude Code")); assert(texts(tree).includes("~/project"));
  assert(nodes(tree).some(node => node.tag === "svg"));
  tree.events.on_click();
  assert.deepEqual(f.commands, [["pane.focus", { pane: "term-pane" }]]);
});
