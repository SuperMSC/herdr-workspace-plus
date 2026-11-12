import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as model from "../mods/project-spaces/model.js";
import * as pins from "../mods/project-spaces/directory-pins.js";

const source = name => readFileSync(new URL(`../mods/project-spaces/${name}.js`, import.meta.url), "utf8").replace(/^import[\s\S]*?;\n/gm, "");
function element() {
  const node = { attrs: {}, events: {}, childNodes: [] };
  const proxy = new Proxy(node, { get(target, key) {
    if (key === "child") return value => { target.childNodes.push(value); return proxy; };
    if (key === "children") return values => { target.childNodes.push(...values); return proxy; };
    if (key === "when") return (condition, fn) => condition ? fn(proxy) : proxy;
    if (String(key).startsWith("on_")) return (...args) => { target.events[key] = args.at(-1); return proxy; };
    if (key in target) return target[key];
    return value => { target.attrs[key] = value; return proxy; };
  } });
  return proxy;
}
const nodes = node => !node || typeof node !== "object" ? [] : [node, ...node.childNodes.flatMap(nodes)];
function fixture() {
  const storage = new Map(), overlays = [], liveMenus = new Map(), calls = [], closed = [], writes = [], cx = { focus_handle: () => ({ focus() {}, release() {} }), notify() {}, stop_propagation() {} };
  const shared = key => storage.get(key), setShared = (key, value) => { storage.set(key, value); writes.push([key, value]); };
  const helper = new Function("shared", "setShared", source("menu-tooltip").replaceAll("export ", "") + "\nreturn { MENU_TOOLTIP_KEY, menuTooltipState, beginMenuTooltip, endMenuTooltip, menuTooltipKey };")(shared, setShared);
  let openFailure = false;
  const deps = { ...model, ...pins, ...helper, View: class {}, div: element, svg: element, image: element, h_flex: element, v_flex: element, shared, setShared, run: (...args) => calls.push(args), theme: () => ({ dim: "dim", muted: "muted", border: "border", hover: "hover", selected: "selected", foreground: "foreground", background: "background" }), spaces: () => [w], closeOverlay(id) { closed.push(id); liveMenus.get(id)?.close(cx); liveMenus.delete(id); }, openOverlay(spec) { if (openFailure instanceof Error) throw openFailure; if (openFailure) return null; const id = `popup-${overlays.length}`; overlays.push({ ...spec, id }); return id; } };
  const menuModule = new Function(...Object.keys(deps), source("menus").replaceAll("export ", "") + "\nreturn { Menu, openMenu, menuRows };")(...Object.values(deps));
  Object.assign(deps, menuModule);
  const Main = new Function(...Object.keys(deps), source("main").replace("export default class", "return class"))(...Object.values(deps));
  const Unified = new Function(...Object.keys(deps), source("unified").replace("export default class", "return class"))(...Object.values(deps));
  const w = { id: "bash", name: "Bash", folder: "/work/bash", machine: null, status: "working", active: true, tabs: [] }, g = { name: "Bash", branch: "main", repo: JSON.stringify([null, "/work/bash/.git"]), ahead: 2, behind: 1 };
  const group = model.buildGroups([{ w, i: 0, g, place: w.folder }], {})[0]; group.custom = true;
  function owner() { const main = new Main(); main.home = "/Users/test"; main.lastGroups = [group]; main.lastProjects = [group]; main.state = () => model.normalizeState(shared(model.STATE_KEY)); return main; }
  const main = owner(), t = deps.theme(), state = main.state(), row = group.rows[0];
  function mount() { const spec = overlays.at(-1), menu = new menuModule.Menu(); menu.init({ ...spec.props, overlay: spec.id }, cx); liveMenus.set(spec.id, menu); return menu; }
  const draw = (tree = false) => main.row(row, group, state, t, "detailed", tree);
  return { ...helper, ...menuModule, storage, overlays, calls, closed, writes, cx, main, owner, w, row, group, state, t, Unified, draw, mount, fail(value) { openFailure = value; } };
}
function noTooltip(node) { assert(!nodes(node).some(item => Object.hasOwn(item.attrs, "tooltip")), "The source row must not register a tooltip over its menu"); }

test("directory and project popup lifecycle suppresses all source tooltips and changes only presentation keys", () => {
  for (const tree of [false, true]) for (const kind of ["space", "group"]) {
    const f = fixture(), draw = () => kind === "space" ? f.draw(tree) : f.main.groupHead(f.group, f.state, f.t, 0, "detailed", tree), before = draw(), snapshot = JSON.stringify(f.group);
    assert(before.attrs.tooltip.includes("/work/bash"));
    if (kind === "space") f.main.spaceMenu(f.row); else f.main.groupMenu(f.group);
    const menu = f.mount(), open = draw(); noTooltip(open); assert.notEqual(open.attrs.id, before.attrs.id); assert.equal(f.main.tooltipState().open, true);
    assert.equal(JSON.stringify(f.group), snapshot); assert.equal(f.calls.length, 0); menu.close(f.cx);
    const after = draw(); assert.equal(after.attrs.tooltip, before.attrs.tooltip); assert.notEqual(after.attrs.id, open.attrs.id); assert.equal(f.storage.get(f.MENU_TOOLTIP_KEY), null); assert.equal(f.main.tooltipState().open, false); assert.equal(JSON.stringify(f.group), snapshot);
  }
});

test("unified Status entity tooltips are suppressed while its captured folder menu is open", () => {
  const f = fixture(), view = new f.Unified(), row = { id: "space-row", kind: "space", title: "Bash", metadata: "/work/bash", status: "working", target: { kind: "space", space: "bash", on: null }, depth: 0 };
  const draw = () => { view.popupTooltipState = f.main.tooltipState(); return view.entityRow(row, 0, { density: "detailed" }, f.cx); };
  const before = draw(); assert(before.attrs.tooltip.includes("/work/bash")); f.main.spaceMenu(f.row); const menu = f.mount(), open = draw(); noTooltip(open); assert.notEqual(open.attrs.id, before.attrs.id); menu.close(f.cx); const after = draw(); assert.equal(after.attrs.tooltip, before.attrs.tooltip); assert.notEqual(after.attrs.id, open.attrs.id);
});

test("Escape, outside dismissal and a chosen action restore tooltips and release their scope", () => {
  for (const reason of ["escape", "outside", "action"]) {
    const f = fixture(); f.main.spaceMenu(f.row); const menu = f.mount(); noTooltip(f.draw());
    if (reason === "escape") menu.render().events.on_key_down({ key: "escape" }, f.cx);
    else if (reason === "outside") menu.close(f.cx);
    else menu.choose(menu.items().findIndex(item => item.label === "Rename"), f.cx);
    assert.equal(f.storage.get(f.MENU_TOOLTIP_KEY), null); assert(f.draw().attrs.tooltip.includes("/work/bash")); assert.equal(f.calls.length, reason === "action" ? 1 : 0);
    if (reason === "action") assert.deepEqual(f.calls[0], ["space.rename", { id: "bash" }]);
  }
});

test("keep-open display actions retain suppression until their popup closes", () => {
  const f = fixture(); f.main.viewMenu(); const menu = f.mount(); menu.choose(menu.items().findIndex(item => item.label === "Compact"), f.cx);
  assert.equal(f.storage.get(model.DENSITY_KEY), "compact"); assert.equal(f.closed.length, 0); noTooltip(f.draw()); menu.close(f.cx); assert(f.draw().attrs.tooltip.includes("/work/bash")); assert.equal(f.storage.get(f.MENU_TOOLTIP_KEY), null);
});

test("old popup and owner cleanup never releases a replacement popup token", () => {
  const f = fixture(); f.main.spaceMenu(f.row); const first = f.mount(), firstToken = f.storage.get(f.MENU_TOOLTIP_KEY).token;
  f.main.groupMenu(f.group); const second = f.mount(), replacement = f.storage.get(f.MENU_TOOLTIP_KEY); assert.notEqual(replacement.token, firstToken); first.close(f.cx); assert.deepEqual(f.storage.get(f.MENU_TOOLTIP_KEY), replacement); noTooltip(f.draw());
  const other = f.owner(); other.spaceMenu(f.row); const third = f.mount(), otherToken = f.storage.get(f.MENU_TOOLTIP_KEY); f.main.close(f.cx); second.close(f.cx); assert.deepEqual(f.storage.get(f.MENU_TOOLTIP_KEY), otherToken); third.close(f.cx); assert.equal(f.storage.get(f.MENU_TOOLTIP_KEY), null);
});

test("overlay opening, initialization and render failures cannot strand tooltip suppression", () => {
  for (const failure of [true, new Error("overlay failed")]) {
    const f = fixture(), before = f.draw().attrs.id; f.fail(failure); assert.throws(() => f.main.spaceMenu(f.row), /could not be opened|overlay failed/); assert.equal(f.storage.get(f.MENU_TOOLTIP_KEY), null); assert(f.draw().attrs.tooltip.includes("/work/bash")); assert.notEqual(f.draw().attrs.id, before);
  }
  const f = fixture(); f.main.spaceMenu(f.row); const spec = f.overlays.at(-1), invalid = new f.Menu(); assert.throws(() => invalid.init(spec.props, { focus_handle() { throw Error("cannot mount"); } }), /cannot mount/); assert.equal(f.storage.get(f.MENU_TOOLTIP_KEY), null);
  f.main.spaceMenu(f.row); const menu = f.mount(); menu.items = () => { throw Error("cannot render"); }; assert.throws(() => menu.render(), /cannot render/); assert.equal(f.storage.get(f.MENU_TOOLTIP_KEY), null); assert(f.draw().attrs.tooltip.includes("/work/bash"));
});

test("closing the owning sidebar clears its active menu record without a deadline or timer", () => {
  const f = fixture(); f.main.spaceMenu(f.row); const menu = f.mount(); assert(f.storage.get(f.MENU_TOOLTIP_KEY)); f.main.close(f.cx); assert.equal(f.storage.get(f.MENU_TOOLTIP_KEY), null); const writes = f.writes.length; menu.close(f.cx); assert.equal(f.writes.length, writes);
});
