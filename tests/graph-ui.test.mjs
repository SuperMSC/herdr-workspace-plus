import { uiFunction } from "./helpers/ui-function.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as model from "../mods/files-plus/graph-model.js";
const hash = n => n.toString(16).padStart(40, "0");
const data = (name, n = 1) => ({ root: "/captured", head: hash(n), refs: [{ name: "refs/heads/main", label: "main", hash: hash(n) }], commits: [{ hash: hash(n), parents: [], subject: name, author: "Fixture", time: 1700000000 }] });
function fixture() {
  const tasks = [], requests = [], overlays = [], lists = []; let drawing = false, rendering = false;
  function element() { const state = { children: [], attrs: {}, events: {} }; const proxy = new Proxy(state, { get(target, key) { if (key === "child") return value => { target.children.push(value); return proxy; }; if (key === "children") return values => { target.children.push(...values); return proxy; }; if (key === "when") return (value, fn) => value ? fn(proxy) : proxy; if (key in target) return target[key]; if (String(key).startsWith("on_")) return (...args) => { assert(!drawing, "virtual rows cannot install event handlers"); target.events[key] = args.at(-1); return proxy; }; return value => { target.attrs[key] = value; return proxy; }; } }); return proxy; }
  const native = { release() { this.released = true; }, on() {}, value: () => "", scroll_to_item() {} };
  const deps = { ...model, div: element, h_flex: element, v_flex: element, PathBuilder: { stroke: () => ({ move_to() { return this; }, line_to() { return this; }, cubic_bezier_to() { return this; }, build: () => ({}) }) },
    Input: { new: element }, InputState: { new: () => ({ ...native }) }, VirtualListScrollHandle: { new: () => ({ ...native }) },
    v_virtual_list(id, count, height, key, draw) { const node = element(); node.spec = { id, count, height, key, draw }; lists.push(node); return node; },
    projectContext: () => ({ cwd: "/unrelated", on: "elsewhere" }), exec() {}, appHome: () => "/fixture", createGraphClient: () => (context, selection) => new Promise((resolve, reject) => requests.push({ context, selection, resolve, reject })),
    theme: () => ({}), settings: () => ({}), openOverlay: value => overlays.push(value), closeOverlay() {} };
  const source = readFileSync(new URL("../mods/files-plus/graph.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  const Graph = uiFunction(...Object.keys(deps), source)(...Object.values(deps));
  const cx = { focus_handle: () => ({ focus() {} }), notify() { assert(!rendering); assert(!drawing); }, spawn: action => tasks.push(action(cx)) }, view = new Graph();
  globalThis.window = { paint_path: element, viewport_size: () => ({ width: 1200, height: 900 }) }; view.init({ root: "/captured", on: "server" }, cx);
  return { view, cx, requests, overlays, tasks, lists, render() { rendering = true; try { return view.render(); } finally { rendering = false; } }, draw(list) { drawing = true; try { return list.spec.draw({ start: 0, end: list.spec.count }); } finally { drawing = false; } } };
}
test("production graph ignores out-of-order responses and closed views while retaining its captured machine", async () => {
  const f = fixture(); f.view.refresh(f.cx); f.requests[1].resolve(data("new", 2)); await f.tasks[1]; f.requests[0].resolve(data("old")); await f.tasks[0]; assert.equal(f.view.rows[0].subject, "new");
  assert(f.requests.every(request => request.context.cwd === "/captured" && request.context.on === "server"));
  f.view.refresh(f.cx); f.view.close(); f.requests[2].resolve(data("closed", 3)); await f.tasks[2]; assert.equal(f.view.rows[0].subject, "new"); assert(f.view.scroll.released); assert(f.view.branchInput.released);
});
test("production graph virtual rows draw native geometry without handlers and stale keys cannot select", async () => {
  const f = fixture(); f.requests[0].resolve(data("selected")); await f.tasks[0]; f.render(); const list = f.lists.at(-1); assert.equal(f.draw(list).length, 1);
  list.events.on_item_click(list.spec.key(0), f.cx); assert.equal(f.view.selected.hash, hash(1)); f.view.diff(); assert.equal(f.overlays[0].props.source.on, "server"); assert.equal(f.overlays[0].props.source.cwd, "/captured"); assert.equal(f.overlays[0].props.selection.commit, hash(1));
  f.view.refresh(f.cx); list.events.on_item_click(list.spec.key(0), f.cx); f.requests[1].reject(new Error("offline")); await f.tasks[1]; assert(f.view.stale); f.view.diff(); assert.equal(f.overlays.length, 1); assert.match(f.view.error, /offline/);
});

test('graph keeps commit counts but moves permanent read-only and fetch guidance into tooltips',async()=>{
 const f=fixture();f.requests[0].resolve(data('selected'));await f.tasks[0];const tree=f.render(),children=node=>node&&typeof node==='object'?Object.getOwnPropertyDescriptor(node,'children')?.value||[]:[],nodes=node=>!node||typeof node!=='object'?[]:[node,...children(node).flatMap(nodes)],text=node=>typeof node==='string'?node:children(node).map(text).join(' ');
 assert.match(text(tree),/1 commits/);assert.doesNotMatch(text(tree),/Read only|last fetch/);assert.match(nodes(tree).find(node=>node.attrs.id==='graph-refresh').attrs.tooltip,/Read only.*last fetch/);
});
