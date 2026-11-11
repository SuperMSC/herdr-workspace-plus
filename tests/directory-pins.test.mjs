import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as model from "../mods/project-spaces/model.js";
import * as directoryPins from "../mods/project-spaces/directory-pins.js";
const { DIRECTORY_PINS_KEY, normalizeDirectoryPins, setDirectoryPin } = directoryPins;
const source = name => readFileSync(new URL(`../mods/project-spaces/${name}.js`, import.meta.url), "utf8").replace(/^import[\s\S]*?;\n/gm, "");
const space = (id = "s", machine = null) => ({ id, machine, name: "Bash", folder: "/work/bash", tabs: [] });
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

function menuFixture() {
  const live = [space()], storage = new Map(), commands = [];
  storage.set(model.STATE_KEY, { mode: "project", assign: {}, groups: {} });
  const deps = { ...model, ...directoryPins, div: element, svg: element, v_flex: element, h_flex: element, run: (...args) => commands.push(args), closeOverlay() {}, openOverlay() {}, theme: () => ({}), shared: key => storage.get(key), setShared: (key, value) => storage.set(key, value), spaces: () => live };
  const Menu = new Function(...Object.keys(deps), source("menus").replaceAll("export ", "") + "\nreturn Menu;")(...Object.values(deps));
  const group = model.buildGroups(live.map((w, i) => ({ w, i, place: w.folder, g: null })), {})[0];
  const spaceProps = { role: "space-menu", unified: true, space: live[0], key: group.key, auto: group.rows[0].auto, groups: [group] };
  const groupProps = { role: "group-menu", unified: true, group, members: group.rows.map(row => ({ id: row.w.id, machine: row.w.machine, autoKey: row.auto.key })), shown: [group.key], sort: "manual" };
  const menu = p => { const value = new Menu(); value.p = p; return value; };
  return { live, storage, commands, group, spaceProps, groupProps, menu };
}

test("directory pin records normalize independently and never retain damaged values", () => {
  for (const raw of [null, 3, "pins", [], true]) assert.deepEqual(normalizeDirectoryPins(raw), { spaces: [], groups: [] });
  const raw = { spaces: ["s", "s", 4, "", "bad\nkey", "box/s"], groups: ['dir:[null,"/work/bash"]', "a".repeat(4097)] }, before = structuredClone(raw);
  assert.deepEqual(normalizeDirectoryPins(raw), { spaces: ["s", "box/s"], groups: ['dir:[null,"/work/bash"]'] });
  assert.deepEqual(raw, before);
});

test("setting a directory pin is immutable, idempotent and preserves unrelated remote pins", () => {
  const raw = Object.freeze({ spaces: Object.freeze(["box/s"]), groups: Object.freeze(["project"]) });
  const next = setDirectoryPin(raw, "space", "s", true);
  assert.deepEqual(next, { spaces: ["box/s", "s"], groups: ["project"] });
  assert.deepEqual(setDirectoryPin(next, "space", "s", true), next);
  assert.deepEqual(setDirectoryPin(next, "space", "s", false), raw);
  assert.deepEqual(setDirectoryPin(raw, "group", "project", false), { spaces: ["box/s"], groups: [] });
  assert.deepEqual(setDirectoryPin(raw, "terminal", "t1", true), raw);
  assert.deepEqual(setDirectoryPin(raw, "space", "bad\0id", true), raw);
});

test("directory menus use a separate persistent key and read fresh pins for each action", () => {
  const f = menuFixture(), before = JSON.stringify(f.storage.get(model.STATE_KEY)), menu = f.menu(f.spaceProps);
  const item = menu.items().find(row => row.label === "Pin directory"); assert(item); assert.equal(item.icon, "pin");
  f.storage.set(DIRECTORY_PINS_KEY, { spaces: ["remote/s"], groups: ["other"] }); item.act();
  assert.deepEqual(f.storage.get(DIRECTORY_PINS_KEY), { spaces: ["remote/s", "s"], groups: ["other"] });
  const unpin = menu.items().find(row => row.label === "Unpin directory"); assert.equal(unpin.icon, "pin-off"); unpin.act();
  assert.deepEqual(f.storage.get(DIRECTORY_PINS_KEY), { spaces: ["remote/s"], groups: ["other"] });
  assert.equal(JSON.stringify(f.storage.get(model.STATE_KEY)), before); assert.equal(f.commands.length, 0);
  assert(!f.menu({ ...f.spaceProps, unified: false }).items().some(row => /[Pp]in directory/.test(row.label || "")));
});

test("a stale, duplicated or retargeted space menu cannot pin another directory", () => {
  for (const change of [f => f.live.splice(0), f => f.live.splice(0, 1, space("s", "box")), f => f.live.push(space())]) {
    const f = menuFixture(), action = f.menu(f.spaceProps).items().find(row => row.label === "Pin directory").act;
    change(f); action(); assert(!f.storage.has(DIRECTORY_PINS_KEY)); assert.equal(f.commands.length, 0);
  }
});

test("project menus pin their exact current group and reject vanished or reassigned members", () => {
  const f = menuFixture(), menu = f.menu(f.groupProps); menu.items().find(row => row.label === "Pin project").act();
  assert.deepEqual(f.storage.get(DIRECTORY_PINS_KEY), { spaces: [], groups: [f.group.key] });
  menu.items().find(row => row.label === "Unpin project").act(); assert.deepEqual(f.storage.get(DIRECTORY_PINS_KEY).groups, []);
  assert(!f.menu({ ...f.groupProps, unified: false }).items().some(row => /[Pp]in project/.test(row.label || "")));
  for (const change of [f => f.live.splice(0), f => f.storage.set(model.STATE_KEY, { assign: { s: "different" } }), f => f.live.splice(0, 1, space("s", "box"))]) {
    const stale = menuFixture(), action = stale.menu(stale.groupProps).items().find(row => row.label === "Pin project").act;
    change(stale); action(); assert(!stale.storage.has(DIRECTORY_PINS_KEY));
  }
  assert.equal(f.commands.length, 0);
});

test("main captures unified directory and project menu targets without changing legacy props", () => {
  const calls = [], deps = { View: class {}, normalizeState: model.normalizeState, openMenu: (...args) => calls.push(args), menuRows: () => 1 };
  const Main = new Function(...Object.keys(deps), source("main").replace("export default class", "return class"))(...Object.values(deps)), f = menuFixture(), main = new Main();
  main.state = () => model.normalizeState({}); main.lastProjects = [f.group]; main.lastGroups = [f.group];
  main.spaceMenu(f.group.rows[0]); assert.equal(calls.at(-1)[1].unified, undefined);
  main.groupMenu(f.group); assert.equal(calls.at(-1)[1].unified, undefined); assert.equal(calls.at(-1)[1].members, undefined);
  main.unifiedView = {}; main.spaceMenu(f.group.rows[0]); assert.equal(calls.at(-1)[1].unified, true);
  main.groupMenu(f.group); assert.equal(calls.at(-1)[1].unified, true); assert.deepEqual(calls.at(-1)[1].members, [{ id: "s", machine: null, autoKey: f.group.key }]);
});


test("a captured pin action preserves its labeled intent when another view has already changed that directory",()=>{
 const f=menuFixture(),menu=f.menu(f.spaceProps),pin=menu.items().find(row=>row.label==="Pin directory");f.storage.set(DIRECTORY_PINS_KEY,{spaces:["s","remote/s"],groups:["other"]});pin.act();assert.deepEqual(f.storage.get(DIRECTORY_PINS_KEY),{spaces:["s","remote/s"],groups:["other"]});const unpin=menu.items().find(row=>row.label==="Unpin directory");f.storage.set(DIRECTORY_PINS_KEY,{spaces:["remote/s"],groups:["other"]});unpin.act();assert.deepEqual(f.storage.get(DIRECTORY_PINS_KEY),{spaces:["remote/s"],groups:["other"]});
});


test("rendered pointer and keyboard menu actions retain Pin or Unpin intent across concurrent changes", () => {
  for (const kind of ["space", "group"]) for (const input of ["pointer", "keyboard"]) for (const initialPinned of [false, true]) {
    const f = menuFixture(), key = kind === "space" ? "spaces" : "groups", id = kind === "space" ? "s" : f.group.key;
    f.storage.set(DIRECTORY_PINS_KEY, { spaces: [], groups: [], [key]: initialPinned ? [id] : [] });
    const menu = f.menu(kind === "space" ? f.spaceProps : f.groupProps), title = kind === "space" ? "directory" : "project", label = (initialPinned ? "Unpin " : "Pin ") + title;
    const index = menu.items().findIndex(row => row.label === label); assert(index >= 0); menu.at = index;
    const tree = menu.render(), cx = { notify() {}, stop_propagation() {} };
    const latest = { spaces: ["remote/s"], groups: ["other"] }; if (!initialPinned) latest[key].push(id);
    f.storage.set(DIRECTORY_PINS_KEY, latest);
    if (input === "pointer") nodes(tree).find(node => node.attrs.id === "pm-" + index).events.on_click({}, cx);
    else tree.events.on_key_down({ key: "enter" }, cx);
    const expected = { spaces: ["remote/s"], groups: ["other"] }; if (!initialPinned) expected[key].push(id);
    assert.deepEqual(f.storage.get(DIRECTORY_PINS_KEY), expected, kind + " " + input + " " + label);
    assert.equal(f.commands.length, 0);
  }
});
