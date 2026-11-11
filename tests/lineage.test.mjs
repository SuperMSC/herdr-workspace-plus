import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as model from "../mods/sessions-plus/lineage-model.js";
const terminal = (address, parent = null, extra = {}) => ({ address, parent, state: "live", created_ms: 1, argv: ["node"], ...extra });
function element() { const state = { childNodes: [], attrs: {}, events: {} }; const proxy = new Proxy(state, { get(target, key) { if (key === "child") return value => { target.childNodes.push(value); return proxy; }; if (key === "children") return values => { target.childNodes.push(...values); return proxy; }; if (key === "when") return (value, fn) => value ? fn(proxy) : proxy; if (key in target) return target[key]; if (String(key).startsWith("on_")) return (...args) => { target.events[key] = args.at(-1); return proxy; }; return value => { target.attrs[key] = value; return proxy; }; } }); return proxy; }

test("lineage uses explicit parent links, preserves shell children, and never joins equal folders", () => {
  const records = [terminal("t1", null, { cwd: "/same" }), terminal("t2", "t1"), terminal("t3", null, { cwd: "/same" }), terminal("t4", "t2"), terminal("old", null, { state: "exited" })];
  const forest = model.lineageForest(records, [{ address: "t1", status: "working", title: "Main" }, { address: "t4", status: "blocked", title: "Child agent" }]);
  const rows = model.lineageRows(forest); assert.deepEqual(rows.map(row => [row.address, row.depth]), [["t1", 0], ["t2", 1], ["t4", 2], ["t3", 0]]);
  assert.equal(rows[1].agent, false); assert.equal(rows[2].agent, true); assert.equal(forest.nodes.has("old"), false);
  assert.deepEqual(model.lineageRows(forest, { activeOnly: true }).map(row => row.address), ["t1", "t2", "t4"]);
});
test("remote bare parents stay on their machine and missing parents remain explicit", () => {
  const forest = model.lineageForest([terminal("t1"), terminal("server/t1"), terminal("server/t2", "t1"), terminal("server/t3", "t9")]);
  assert.equal(forest.nodes.get("server/t2").parent, "server/t1"); assert.equal(forest.nodes.get("t1").children.length, 0);
  assert.equal(forest.nodes.get("server/t3").missingParent, true);
});
test("lineage cycles, long chains, folds, searches and the terminal bound are finite", () => {
  const forest = model.lineageForest([terminal("a", "b"), terminal("b", "a"), terminal("c", "b", { title: "needle" })]);
  assert.equal(model.lineageRows(forest).length, 3); assert([...forest.nodes.values()].some(row => row.cycle));
  const root = forest.roots[0]; assert.equal(model.lineageRows(forest, { folded: new Set([root.address]) }).length, 1);
  assert.equal(model.lineageRows(forest, { query: "needle", folded: new Set([root.address]) }).length, 3);
  const many = model.lineageForest(Array.from({ length: 610 }, (_, i) => terminal(`t${i}`, i ? `t${i - 1}` : null)));
  assert(many.limited); assert.equal(model.lineageRows(many).length, model.LINEAGE_LIMIT);
});
test("production lineage UI only peeks at a fresh captured identity and does not publish during render", () => {
  let records = [terminal("t1"), terminal("t2", "t1")], rendering = false; const commands = [], input = { on() {}, value: () => "", release() { this.released = true; } };
  const deps = { ...model, div: element, svg: element, h_flex: element, v_flex: element, Input: { new: element }, InputState: { new: () => input }, terminals: () => records, agents: () => [], spaces: () => [], theme: () => ({}), run: (...args) => commands.push(args), closeOverlay() {} };
  const source = readFileSync(new URL("../mods/sessions-plus/lineage.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  const Lineage = new Function(...Object.keys(deps), source)(...Object.values(deps)), view = new Lineage(), cx = { notify() { assert(!rendering); }, focus_handle: () => ({ focus() {} }) };
  view.init({}, cx); rendering = true; view.render(); rendering = false; assert.equal(commands.length, 0);
  const row = model.lineageRows(model.lineageForest(records))[1]; records = [records[0], { ...records[1], created_ms: 99 }]; view.open(row, cx); assert.equal(commands.length, 0); assert.match(view.error, /replaced/);
  view.open(model.lineageRows(model.lineageForest(records))[1], cx); assert.deepEqual(commands, [["terminal.peek", { terminal: "t2" }]]); view.close(); assert(input.released);
});


test("production lineage paginates deep trees without accumulating native rows and searches the full bounded forest", () => {
  const records = Array.from({ length: 210 }, (_, i) => terminal(`t${i}`, i ? `t${i - 1}` : null, { title: i === 150 ? "needle" : `Terminal ${i}` }));
  const input = { on() {}, value: () => "", release() {} }, deps = { ...model, div: element, svg: element, h_flex: element, v_flex: element, Input: { new: element }, InputState: { new: () => input }, terminals: () => records, agents: () => [], spaces: () => [], theme: () => ({}), run() {}, closeOverlay() {} };
  const source = readFileSync(new URL("../mods/sessions-plus/lineage.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  const Lineage = new Function(...Object.keys(deps), source)(...Object.values(deps)), view = new Lineage(), cx = { notify() {}, focus_handle: () => ({ focus() {} }) }; view.init({}, cx);
  const nodes = node => !node || typeof node !== "object" ? [] : [node, ...node.childNodes.flatMap(nodes)];
  const rows = tree => nodes(tree).filter(node => /^lineage-t\d+$/.test(node.attrs.id || ""));
  let tree = view.render(); assert.equal(rows(tree).length, 50); nodes(tree).find(node => node.attrs.id === "lineage-next").events.on_click({}, cx);
  tree = view.render(); assert.equal(rows(tree).length, 50); assert.equal(rows(tree)[0].attrs.id, "lineage-t50");
  view.query = "needle"; view.updateRows(); view.page = 3; tree = view.render(); assert(rows(tree).some(row => row.attrs.id === "lineage-t150")); assert(rows(tree).length <= 50);
});

test("production lineage defers changed core snapshots, coalesces frames and ignores scheduled work after close", () => {
  let records = [terminal("t1", null, { title: "original" })], rendering = false; const timers = [];
  const input = { on() {}, value: () => "", release() { this.released = true; } }, deps = { ...model, div: element, svg: element, h_flex: element, v_flex: element, Input: { new: element }, InputState: { new: () => input }, terminals: () => records, agents: () => [], spaces: () => [], theme: () => ({}), run() {}, closeOverlay() {} };
  const source = readFileSync(new URL("../mods/sessions-plus/lineage.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  const Lineage = new Function(...Object.keys(deps), source)(...Object.values(deps)), view = new Lineage(), cx = { notify() { assert(!rendering); }, focus_handle: () => ({ focus() {} }), timer: { after(_ms, fn) { timers.push(fn); } } };
  view.init({}, cx); const render = () => { rendering = true; try { view.render(cx); } finally { rendering = false; } };
  render(); assert.equal(timers.length, 0); records = [terminal("t1", null, { title: "updated" })]; render(); render(); assert.equal(timers.length, 1); assert.equal(view.rows[0].title, "original");
  records = [terminal("t1", null, { title: "latest" })]; timers.shift()(cx); assert.equal(view.rows[0].title, "latest"); render(); assert.equal(timers.length, 0);
  records = []; render(); view.close(); timers.shift()(cx); assert.equal(view.rows[0].title, "latest"); assert(input.released);
  assert.equal(model.lineageIdentity({ address: "unverified", argv: ["node"] }), null);
});
