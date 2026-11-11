import * as libraryModel from "../mods/files-plus/library-model.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as model from "../mods/files-plus/model.js";

function element() {
  const node = { childNodes: [], attrs: {} };
  const proxy = new Proxy(node, { get(target, name) {
    if (name === "child") return child => { target.childNodes.push(child); return proxy; };
    if (name === "children") return children => { target.childNodes.push(...children); return proxy; };
    if (name === "when") return (condition, callback) => condition ? callback(proxy) : proxy;
    if (name in target) return target[name];
    return value => { target.attrs[name] = value ?? true; return proxy; };
  } });
  return proxy;
}
const nodes = node => !node || typeof node !== "object" ? [] : [node, ...node.childNodes.flatMap(nodes)];
function view(name, dependencies) {
  dependencies = { ...libraryModel, fileIcon: element, iconButton: (id, icon, label, click) => element().id(id).on_click(click), ...dependencies };
  const source = readFileSync(new URL(`../mods/files-plus/${name}.js`, import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export function changed", "function changed").replace("export default class", "return class");
  return new Function(...Object.keys(dependencies), source)(...Object.values(dependencies));
}

function popup(kind, { height = 900, zoom = 1, preferences = false } = {}) {
  const overlays = [];
  globalThis.window = { viewport_size: () => ({ width: 1200, height }) };
  const dependencies = { ...model, projectContext: () => ({ cwd: "/fixture/project", on: null }), div: element, svg: element, v_flex: element, h_flex: element,
    theme: () => ({}), settings: () => ({ zoom }), window: () => ({ platform: "macos" }),
    openOverlay: props => overlays.push(props), shared: () => false };
  const cx = { stop_propagation() {}, focus_handle: () => ({ focus() {} }) };
  const Panel = view(kind, dependencies), panel = new Panel();
  panel.root = "/fixture/project"; panel.on = null;
  if (kind === "browser") panel.menu("file.txt", false, cx, preferences);
  else panel.menu({ path: "file.txt", xy: "MM", deleted: false }, cx);
  const spec = overlays[0], Menu = view("menu", dependencies), menu = new Menu();
  menu.init(spec.props, cx);
  return { spec, menu, tree: menu.render(), maximum: height / zoom * 0.85 };
}

for (const kind of ["browser", "changes"]) {
  test(`${kind} popup height follows its menu content instead of filling 85% of a tall window`, () => {
    const f = popup(kind);
    const natural = model.menuHeight(f.spec.props.target, { preferences: f.spec.props.preferences });
    assert.equal(f.spec.height, natural);
    assert.equal(f.tree.attrs.h, f.spec.height);
    assert(f.spec.height < f.maximum);
    assert.equal(f.spec.height, 52 + f.menu.items.length * 30 + f.menu.items.filter(item => item.separator).length * 7);
    assert.equal(f.tree.attrs.p, 4);
    assert.equal(f.tree.childNodes[0].attrs.h, 22);
    assert.equal(f.tree.childNodes.at(-1).attrs.h, 22);
  });

  test(`${kind} menu remains scrollable when window size and zoom cap its height`, () => {
    const f = popup(kind, { height: 360, zoom: 2, preferences: true });
    assert.equal(f.spec.height, f.maximum);
    assert.equal(f.tree.attrs.h, f.maximum);
    const list = nodes(f.tree).find(node => node.attrs.id === "files-plus-menu-items");
    assert.equal(list.attrs.min_h, 0);
    assert.equal(list.attrs.overflow_y_scrollbar, true);
    assert.equal(list.childNodes.length, f.menu.items.length);
  });
}

test("the header preference row is included in both popup and content sizing", () => {
  const plain = popup("browser"), header = popup("browser", { preferences: true });
  assert(header.spec.height > plain.spec.height);
  assert.equal(header.tree.attrs.h, header.spec.height);
  assert(header.menu.items.some(item => item.id === "toggleHidden"));
});
