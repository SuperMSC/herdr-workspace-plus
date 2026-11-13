import { uiFunction } from "./helpers/ui-function.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as model from "../mods/project-spaces/model.js";

const space = (id, folder, extra = {}) => ({ id, name: id, folder, machine: null, status: null, active: false, tabs: [{ id: `tab-${id}` }], ...extra });
const git = (root, branch = "main", machine = null, linked = false) => ({ name: "project", repo: JSON.stringify([machine, root + "/.git"]), branch, ahead: 1, behind: 0, linked });
function rows() { return [{ w: space("main", "/Users/me/project", { status: "working" }), i: 0, place: "/Users/me/project", g: git("/Users/me/project") }, { w: space("docs", "/Users/me/docs", { status: "idle" }), i: 1, place: "/Users/me/docs", g: null }, { w: space("fix", "/Users/me/project-fix", { status: "blocked" }), i: 2, place: "/Users/me/project-fix", g: git("/Users/me/project", "fix", null, true) }, { w: space("remote", "/srv/app", { machine: "server", status: "done" }), i: 3, place: "/srv/app", g: git("/srv/app", "remote", "server") }]; }

test("density is independent of grouping; local home paths shorten without guessing a remote home", () => {
  assert.equal(model.projectDensity(null), "detailed"); assert.equal(model.projectDensity("compact"), "compact"); assert.equal(model.projectDensity("unknown"), "detailed");
  assert.equal(model.projectPath("/Users/me/project", "/Users/me").short, "~/project"); assert.equal(model.projectPath("/Users/me2/project", "/Users/me").short, "/Users/me2/project");
  const remote = model.projectPath("/Users/me/project", "/Users/me", "server"); assert.equal(remote.short, "/Users/me/project"); assert.equal(remote.tooltip, "@server\n/Users/me/project");
  assert.equal(model.projectPath(null), null);
  const groups = model.buildGroups(rows(), {}), group = groups[0]; assert(model.spacePath(group.rows[0], group, "/Users/me", true).repeat); assert(!model.spacePath(group.rows[1], group, "/Users/me", true).repeat);
  const custom = { ...group, custom: true, rows: [group.rows[0], groups[1].rows[0]] }; assert.equal(model.groupPath(custom).short, "Multiple folders");
});

test("nested folder paths are relative only to their same-machine parent root, with full paths retained in tooltips",()=>{
 const row={w:space('nested','/Users/me/project/Source/GRecon'),place:'/Users/me/project/Source/GRecon'},group={folder:'/Users/me/project/',machine:null,custom:false};
 const relative=model.spacePath(row,group,'/Users/me',true);assert.equal(relative.short,'Source/GRecon');assert.equal(relative.tooltip,row.place);assert.equal(relative.repeat,false);
 assert.equal(model.spacePath({...row,place:'/Users/me/project-other/Source'},group,'/Users/me',true).short,'~/project-other/Source');
 assert.equal(model.spacePath({...row,w:{...row.w,machine:'server'}},group,'/Users/me',true).short,row.place);
 const remote=model.spacePath({...row,w:{...row.w,machine:'server'}},{...group,machine:'server'},'/Users/me',true);assert.equal(remote.short,'Source/GRecon');assert.equal(remote.tooltip,'@server\n'+row.place);
 const mixed={...group,custom:true,rows:[row,{w:space('other','/other')}]};assert.equal(model.spacePath(row,mixed,'/Users/me',true).short,'~/project/Source/GRecon');
 assert.equal(model.spacePath(row,{...group,folder:'/'},'/Users/me',true).short,'Users/me/project/Source/GRecon');
});

test("automatic project colors are stable by name across roots and cover only the six theme ANSI hues",()=>{
 const make=folder=>model.buildGroups([{w:space('P',folder,{name:'Project'}),i:0,place:folder,g:null}],{})[0],a=make('/one/Project'),b=make('/two/Project');assert.equal(a.color,b.color);assert(model.PALETTE.includes(a.color));assert.deepEqual(model.PALETTE,['ansi1','ansi2','ansi3','ansi4','ansi5','ansi6']);
 const t=Object.fromEntries(model.PALETTE.map((color,index)=>[color,'#'+String(index+1).repeat(6)]));
 assert.equal(model.projectMark(t,'Project').foreground,t[a.color]);assert.equal(model.projectMark(t,'Project').background,t[a.color]+'33');assert.deepEqual(model.projectMark({ansi4:'#abc'},'Project','ansi4'),{foreground:'#abc',background:'#aabbcc33'});
});

test("status filters use only reported statuses; search expands temporarily and retains full source membership", () => {
  const source = rows(), grouped = model.buildGroups(source, {}), key = grouped[0].key, state = { folded: [key] }, groups = model.buildGroups(source, state), before = JSON.stringify(groups);
  assert.deepEqual(model.filterProjectGroups(groups, { filter: "active" }).flatMap(g => g.rows).map(r => r.w.id), ["main", "fix", "remote"]);
  assert.deepEqual(model.filterProjectGroups(groups, { filter: "attention" }).flatMap(g => g.rows).map(r => r.w.id), ["fix", "remote"]);
  const match = model.filterProjectGroups(groups, { query: "fix" })[0]; assert.equal(match.folded, false); assert.equal(match.fullCount, 2); assert.equal(match.sourceRows.length, 2); assert.equal(match.rows.length, 1);
  assert.equal(model.filterProjectGroups(groups, { query: "project" })[0].rows.length, 2); assert.equal(model.filterProjectGroups(groups, { query: "project fix" })[0].rows[0].w.id, "fix"); assert.equal(model.filterProjectGroups(groups, { query: "/srv/app" })[0].rows[0].w.id, "remote"); assert.equal(JSON.stringify(groups), before);
});
function element() { const node = { attrs: {}, events: {}, childNodes: [] }; const proxy = new Proxy(node, { get(target, key) { if (key === "child") return value => { target.childNodes.push(value); return proxy; }; if (key === "children") return values => { target.childNodes.push(...values); return proxy; }; if (key === "when") return (condition, fn) => condition ? fn(proxy) : proxy; if (key in target) return target[key]; if (String(key).startsWith("on_")) return (...args) => { target.events[key] = args.at(-1); return proxy; }; return value => { target.attrs[key] = value; return proxy; }; } }); return proxy; }
const nodes = node => !node || typeof node !== "object" ? [] : [node, ...node.childNodes.flatMap(nodes)];
const find = (node, id) => nodes(node).find(row => row.attrs.id === id);
const strings = node => !node || typeof node !== "object" ? typeof node === "string" ? [node] : [] : node.childNodes.flatMap(strings);
const code = name => readFileSync(new URL(`../mods/project-spaces/${name}.js`, import.meta.url), "utf8").replace(/^import[\s\S]*?;\n/gm, "");
function fixture({ density, folded = false, rail = false } = {}) {
  const source = rows(), shared = new Map(), commands = [], overlays = [], inputs = [], timers = []; let masked = false, rendering = false;
  const groupKey = model.buildGroups(source, {})[0].key; shared.set(model.STATE_KEY, { folded: folded ? [groupKey] : [] }); if (density) shared.set(model.DENSITY_KEY, density);
  const cx = { notify() { assert(!rendering); }, focus_handle: () => ({ focus() {} }), stop_propagation() {}, timer: { every(ms, fn) { timers.push({ ms, fn }); } } };
  const input = () => { let value = ""; const events = {}, control = { value: () => value, on(name, fn) { events[name] = fn; }, type(next) { value = next; events.change?.({}, cx); }, release() { this.released = true; } }; inputs.push(control); return control; };
  const deps = { ...model, View: class {}, div: element, svg: element, v_flex: element, h_flex: element, Input: { new: element }, InputState: { new: input }, privacyGuard: () => masked ? "MASK" : null, Menu: class {}, Prompt: class {}, openMenu: (...args) => overlays.push(args), menuRows: () => 1,
    props: () => null, spaces: () => source.map(row => row.w), panes: () => source.map(row => ({ tab: `tab-${row.w.id}`, cwd: row.place })), machines: () => [{ name: null, layout: "ready" }, { name: "server", layout: "ready" }], theme: () => ({}), home: () => "/Users/me", layout: () => ({ id: "sidebar", size: { px: rail ? 100 : 300 } }), window: () => ({ active: true }), shared: key => shared.get(key), setShared: (key, value) => { assert(!rendering); shared.set(key, value); }, run: (...args) => commands.push(args), exec: () => { throw Error("No automatic commands during UI test"); }, watchFolder: () => new Promise(() => {}) };
  const Role = uiFunction(...Object.keys(deps), code("main").replace("export default class", "return class"))(...Object.values(deps)), view = new Role(); view.init({}, cx); for (const row of source) view.git[JSON.stringify([row.w.machine ?? null, row.place])] = row.g;
  return { view, cx, source, shared, commands, inputs, groupKey, mask: value => { masked = value; }, render() { rendering = true; try { return view.render(cx); } finally { rendering = false; } } };
}

test("production Detailed paths do not duplicate the project root and Compact keeps complete tooltips and drag handlers", () => {
  const f = fixture(); let tree = f.render(); assert.equal(find(tree, "group-0").attrs.h, 46); assert(strings(find(tree, "group-0")).includes("~/project"));
  assert.equal(find(tree, "space-main").attrs.h, 28); assert.equal(find(tree, "space-fix").attrs.h, 46); assert(strings(find(tree, "space-fix")).includes("~/project-fix"));
  assert.equal(find(tree, "space-remote").attrs.tooltip, "@server\n/srv/app"); assert(strings(find(tree, "space-remote")).includes("@server"));
  for (const event of ["on_mouse_down", "on_mouse_move", "on_mouse_up"]) assert.equal(typeof find(tree, "space-main").events[event], "function");
  const before = JSON.stringify(f.shared.get(model.STATE_KEY)); f.shared.set(model.DENSITY_KEY, "compact"); tree = f.render(); assert.equal(find(tree, "group-0").attrs.h, 30); assert.equal(find(tree, "space-fix").attrs.h, 28); assert.equal(find(tree, "space-fix").attrs.tooltip, "/Users/me/project-fix"); assert.equal(JSON.stringify(f.shared.get(model.STATE_KEY)), before); assert.equal(f.commands.length, 0);
  const rail = fixture({ rail: true }); const railTree = rail.render(); assert.equal(find(railTree, "space-remote").attrs.h, 26); assert.equal(find(railTree, "space-remote").attrs.tooltip, "@server\n/srv/app");
});

test("production search filters only the drawing and drag-to-group still uses full membership", () => {
  const f = fixture({ folded: true }); f.render(); assert.equal(f.view.lastRows.length, 4); f.inputs[0].type("main"); const tree = f.render(); assert(find(tree, "space-main")); assert(!find(tree, "space-fix")); assert(find(tree, "group-0")); assert.equal(f.view.lastRows.length, 4); assert.equal(f.view.lastProjects.length, 3); assert.deepEqual(f.shared.get(model.STATE_KEY).folded, [f.groupKey]);
  f.view.drag = { kind: "space", id: "docs" }; const display = model.filterProjectGroups(f.view.lastGroups, { query: "main" })[0]; f.view.dropOnGroup(display, f.cx); assert(f.commands.some(([name, args]) => name === "space.move" && args.id === "docs" && args.index === 3));
});

test("production view-menu toggles only the density key and privacy masks all new controls and paths", () => {
  const f = fixture(), modelBefore = JSON.stringify(f.shared.get(model.STATE_KEY));
  const deps = { ...model, div: element, svg: element, v_flex: element, h_flex: element, run() {}, closeOverlay() {}, openOverlay() {}, theme: () => ({}), shared: key => f.shared.get(key), setShared: (key, value) => f.shared.set(key, value) };
  const Menu = uiFunction(...Object.keys(deps), code("menus").replaceAll("export ", "") + "\nreturn Menu;")(...Object.values(deps)), menu = new Menu(); menu.init({ role: "view-menu", keys: [f.groupKey] }, f.cx);
  assert(menu.items().find(row => row.label === "Detailed").checked); menu.items().find(row => row.label === "Compact").act(); assert.equal(f.shared.get(model.DENSITY_KEY), "compact"); assert(menu.items().find(row => row.label === "Compact").checked); assert.equal(JSON.stringify(f.shared.get(model.STATE_KEY)), modelBefore);
  f.mask(true); assert.equal(f.render(), "MASK"); f.view.close(f.cx); assert(f.inputs[0].released);
});
