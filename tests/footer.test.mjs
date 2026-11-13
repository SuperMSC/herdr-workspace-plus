import { uiFunction } from "./helpers/ui-function.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FILTER_KEY } from "../mods/project-spaces/model.js";
import * as perf from "../mods/sessions-plus/perf-model.js";

function element() {
  const value = { children: [], attributes: {}, events: {} };
  const proxy = new Proxy(value, { get(target, name) {
    if (name === "child") return child => { target.children.push(child); return proxy; };
    if (name === "when") return (condition, callback) => condition ? callback(proxy) : proxy;
    if (name.startsWith("on_")) return (...args) => { target.events[name] = args.at(-1); return proxy; };
    if (name in target) return target[name];
    return argument => { target.attributes[name] = argument; return proxy; };
  } });
  return proxy;
}

const descendants = node => !node || typeof node !== "object" ? [] : [node, ...node.children.flatMap(descendants)];
const find = (tree, id) => descendants(tree).find(node => node.attributes.id === id);
const text = node => typeof node === "string" ? node : (node?.children ?? []).map(text).join(" ");

function fixture({ spaces = [], agents = [], bindings = [], platform = "macos", props = {}, unified = false, hidden = false, width = 268 } = {}) {
  const state = { spaces, agents, bindings, platform, values: {}, tree: { id: "sidebar", hidden, size: { px: width }, children: unified ? [{ type: "block", content: { mod: "project-spaces", props: { unified: true } } }] : [] } }, calls = [], initialized = [], instances = [], resources = [];
  let renders = 0;
  const dependencies = {
    terminals: () => [], shared: key => state.values[key], setShared: (key, value) => { state.values[key] = value; }, layout: () => state.tree,
    div: element, svg: element, h_flex: element, theme: () => ({}),
    spaces: () => state.spaces, agents: () => state.agents.map((agent, index) => ({ address: `t${index}`, ...agent })), keys: () => state.bindings,
    window: () => ({ platform: state.platform }), run: (...args) => calls.push(args),
    Resources: class {
      init(p, cx) { resources.push({ props: p, cx }); }
      render() { return element().id("fixture-resources").child("324 MB · 3"); }
    },
    StatusBar: class {
      constructor() { instances.push(this); }
      init(p, cx) { initialized.push({ instance: this, props: p, cx }); }
      render() { renders++; return element().id("fixture-statusbar").child("quota data"); }
    },
  };
  const source = readFileSync(new URL("../mods/sessions-plus/footer.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  const Footer = uiFunction(...Object.keys(dependencies), source)(...Object.values(dependencies));
  const footer = new Footer(), cx = { notify() {} };
  footer.init(props, cx);
  return { footer, state, calls, initialized, instances, resources, cx, render: () => footer.render(), renders: () => renders };
}

test("the footer retains local device and zero-agent context without an active space", () => {
  const f = fixture(), context = text(find(f.render(), "workspace-status-context"));
  assert.match(context, /This computer/);
  assert.match(context, /0 agents/);
  assert.doesNotMatch(context, /needs you|undefined|null/);
});

test("device and branch follow the active space while blocked-agent counts remain visible", () => {
  const f = fixture({
    spaces: [
      { active: false, machine: "ignored-host", branch: "ignored-branch" },
      { active: true, machine: "remote-host", branch: "feature/sessions" },
    ],
    agents: [{ status: "blocked" }, { status: "working" }, { status: "blocked" }, { status: "done" }],
  });
  let context = text(find(f.render(), "workspace-status-context"));
  assert.match(context, /remote-host/); assert.match(context, /feature\/sessions/);
  assert.match(context, /4 agents/); assert.match(context, /2 needs you/);
  assert.doesNotMatch(context, /ignored-host|ignored-branch|This computer/);
  f.state.spaces = [{ active: true, machine: null, branch: "main" }];
  f.state.agents = [{ status: "idle" }];
  context = text(find(f.render(), "workspace-status-context"));
  assert.match(context, /This computer/); assert.match(context, /main/); assert.match(context, /1 agents/);
  assert.doesNotMatch(context, /remote-host|feature\/sessions|needs you/);
});

test("command labels follow the current global binding instead of a hardcoded shortcut", () => {
  const f = fixture({ bindings: [
    { section: "mod:example", action: "app.palette", keys: "cmd-x" },
    { section: "global", action: "app.palette", keys: "cmd-shift-p" },
  ] });
  assert.equal(text(find(f.render(), "workspace-commands")), "⌘⇧P  commands");
  f.state.bindings = [{ section: "global", action: "app.palette", keys: "ctrl--" }];
  assert.equal(text(find(f.render(), "workspace-commands")), "⌃-  commands");
  f.state.platform = "linux";
  f.state.bindings = [{ section: "global", action: "app.palette", keys: "ctrl-shift-p" }];
  assert.equal(text(find(f.render(), "workspace-commands")), "Ctrl+Shift+P  commands");
  f.state.bindings = [];
  assert.equal(text(find(f.render(), "workspace-commands")), "commands");
});

test("the commands control opens the palette even when no shortcut is bound", () => {
  const f = fixture();
  find(f.render(), "workspace-commands").events.on_click();
  assert.deepEqual(f.calls, [["app.palette"]]);
});

test("the footer initializes one embedded StatusBar and forwards helper properties without mutating them", () => {
  const props = { role: "footer", node: "/fixture/node", stores: { claude: "/fixture/claude" }, embedded: false, custom: { preserve: true } };
  const before = structuredClone(props), f = fixture({ props });
  for (let count = 0; count < 3; count++) {
    const tree = f.render();
    assert(find(find(tree, "workspace-quota-inline"), "fixture-statusbar"));
    assert.match(text(tree), /quota data/);
  }
  assert.equal(f.instances.length, 1);
  assert.equal(f.initialized.length, 1);
  assert.equal(f.initialized[0].instance, f.footer.status);
  assert.equal(f.initialized[0].cx, f.cx);
  assert.deepEqual(f.initialized[0].props, { ...props, embedded: true });
  assert.deepEqual(props, before);
  assert.equal(f.renders(), 3);
});


test("the agent count expands a collapsed unified sidebar and selects Needs attention", () => {
  const f = fixture({ agents: [{ address: "t1", status: "blocked", seq: 4 }], unified: true, hidden: true, width: 76 });
  f.state.values["sidebar.width"] = 310;
  const control = find(f.render(), "workspace-agents");
  assert.equal(control.attributes.tooltip, "Show agents that need attention");
  control.events.on_click();
  assert.deepEqual(f.calls, [["layout.show", { id: "sidebar" }], ["layout.resize", { id: "sidebar", px: 310 }]]);
  assert.equal(f.state.values[FILTER_KEY], "attention");
});

test("the agent count is an explained no-op without the unified sidebar and rechecks layout at click time", () => {
  const f = fixture(); let control = find(f.render(), "workspace-agents");
  assert.match(control.attributes.tooltip, /Enable the unified sidebar/); control.events.on_click();
  assert.deepEqual(f.calls, []); assert.deepEqual(f.state.values, {});
  const g = fixture({ unified: true, width: 44 }); g.state.values["sidebar.width"] = NaN;
  find(g.render(), "workspace-agents").events.on_click(); assert.deepEqual(g.calls, [["layout.resize", { id: "sidebar", px: 268 }]]);
  g.state.tree.children = []; g.calls.length = 0; g.state.values = {};
  find(g.render(), "workspace-agents").events.on_click(); assert.deepEqual(g.calls, []); assert.deepEqual(g.state.values, {});
});

test("resource use sits before the command hint and shares the footer's props", () => {
  const f = fixture({ props: { node: "/opt/node" } }), tree = f.render();
  const ids = tree.children.map(child => child.attributes.id);
  assert.deepEqual(ids.slice(-2), ["workspace-resources", "workspace-commands"]);
  assert.match(text(find(tree, "workspace-resources")), /324 MB/);
  assert.equal(f.resources.length, 1); assert.equal(f.resources[0].props.node, "/opt/node");
});

test('footer context, agent count, commands and the real memory badge share centered 24px controls and a 16px line height',()=>{
 const f=fixture({spaces:[{active:true,machine:'server',branch:'feature/test'}],agents:[{status:'working'}]}),tree=f.render();
 for(const id of ['workspace-status-context','workspace-device','workspace-branch','workspace-agents','workspace-resources','workspace-commands']){
  const control=find(tree,id);assert(control,id);assert(Object.hasOwn(control.attributes,'items_center'),id);assert.equal(control.attributes.h,24,id);assert.equal(control.attributes.line_height,'16px',id);
 }
 for(const id of ['workspace-plus-footer','workspace-quota-inline'])assert(Object.hasOwn(find(tree,id).attributes,'items_center'),id);
 const deps={...perf,div:element,svg:element,h_flex:element},source=readFileSync(new URL('../mods/sessions-plus/resources.js',import.meta.url),'utf8').replace(/^import[\s\S]*?;\n/gm,'').replace('export default class','return class'),Resources=uiFunction(...Object.keys(deps),source)(...Object.values(deps)),resources=new Resources();resources.snapshot=null;
 const badge=resources.trigger({});assert(Object.hasOwn(badge.attributes,'items_center'));assert.equal(badge.attributes.h,24);assert.equal(badge.attributes.line_height,'16px');
});
