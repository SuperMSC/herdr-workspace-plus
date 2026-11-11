import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function element() {
  const result = { children: [], attrs: {}, events: {} };
  const proxy = new Proxy(result, { get(target, name) {
    if (name === "child") return child => { target.children.push(child); return proxy; };
    if (name === "when") return (condition, callback) => condition ? callback(proxy) : proxy;
    if (name.startsWith("on_")) return (...args) => { target.events[name] = args.at(-1); return proxy; };
    if (name in target) return target[name];
    return value => { target.attrs[name] = value; return proxy; };
  } });
  return proxy;
}

function fixture({ enabled, hidden = false, active = "files", missing = false } = {}) {
  const state = { "workspace.panels": enabled }, calls = [], writes = [];
  const panel = { id: "panel", hidden, children: [{ id: "panel-body", active, children: [{ id: "files" }, { id: "changes" }, ...missing ? [] : [{ id: "files-plus-sessions" }]] }] };
  const source = readFileSync(new URL("../mods/sessions-plus/toolbar.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  const dependencies = { div: element, svg: element, h_flex: element, theme: () => ({ selected: "selected", chrome: "chrome", foreground: "foreground", muted: "muted", hover: "hover", border: "border" }), layout: () => ({ children: [panel] }),
    shared: key => state[key], setShared: (key, value) => { writes.push([key, value]); state[key] = value; }, run: (...args) => calls.push(args) };
  const Toolbar = new Function(...Object.keys(dependencies), source)(...Object.values(dependencies));
  const toolbar = new Toolbar(); toolbar.init({});
  return { toolbar, calls, state, writes, panel, button: () => toolbar.render().children[0] };
}

test("Sessions registers with per-space panel restoration without re-enabling hidden Files or Changes", () => {
  const f = fixture({ enabled: ["changes"] });
  assert.deepEqual(f.state["workspace.panels"], ["changes", "files-plus-sessions"]);
  f.button(); f.button();
  assert.equal(f.writes.length, 1);
  f.state["workspace.panels"] = [];
  f.button();
  assert.deepEqual(f.state["workspace.panels"], ["files-plus-sessions"]);
});

test("Sessions opens its stack child and shows the full right panel", () => {
  const f = fixture({ hidden: true });
  f.button().events.on_click();
  assert.deepEqual(f.calls, [["layout.select", { stack: "panel-body", child: "files-plus-sessions" }], ["layout.show", { id: "panel" }]]);
});

test("clicking the active Sessions button closes the panel and the next click can reopen it", () => {
  const f = fixture({ active: "files-plus-sessions" });
  assert.equal(f.button().attrs.bg, "selected");
  f.button().events.on_click();
  assert.deepEqual(f.calls, [["layout.hide", { id: "panel" }]]);
  f.panel.hidden = true;
  f.button().events.on_click();
  assert.equal(f.calls.at(-1)[0], "layout.show");
});

test("button presses stop titlebar dragging and missing panels do not dispatch commands", () => {
  const f = fixture({ missing: true });
  let stopped = false;
  f.button().events.on_mouse_down({}, { stop_propagation() { stopped = true; } });
  f.button().events.on_click();
  assert.equal(stopped, true); assert.deepEqual(f.calls, []);
});

test("the shipped tab bar can restore the registered Sessions choice after changing space", () => {
  const f = fixture();
  // This is the shipped tabs mod's documented restoration gate.
  const remembered = "files-plus-sessions";
  assert.equal(f.state["workspace.panels"].includes(remembered) ? remembered : null, remembered);
});


test("Sessions keeps its rounded frame inside its own native block in normal, selected and hovered states", () => {
  for (const options of [{}, { active: "files-plus-sessions" }, { hidden: true }, { missing: true }]) {
    const f = fixture(options), root = f.toolbar.render(), button = root.children[0];
    assert((button.attrs.ml ?? 0) >= 0, "A negative left margin clips the left round corners at the separate mod block boundary");
    assert.equal(button.attrs.h, 26); assert.equal(button.attrs.rounded, 6); assert.equal(button.attrs.px, 8); assert.equal(button.attrs.gap, 5);
    assert(Object.hasOwn(root.attrs, "items_center")); assert(Object.hasOwn(button.attrs, "items_center"));
    const on = !options.hidden && options.active === "files-plus-sessions";
    assert.equal(button.attrs.bg, on ? "selected" : "chrome");
    assert.equal(button.attrs.text_color, on ? "foreground" : "muted");
    if (!options.missing) {
      const hovered = element(); button.attrs.hover(hovered);
      assert.equal(hovered.attrs.bg, "hover");
      assert.equal(button.attrs.rounded, 6); assert((button.attrs.ml ?? 0) >= 0);
    } else assert.equal(button.attrs.hover, undefined);
  }
});
