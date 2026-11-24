import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { RANK, buildGroups, groupOrder, pinModeOf, sortOf, PIN_MODES, dropNested, countByTab } from "../mods/agents-plus/model.js";
import * as model from "../mods/agents-plus/model.js";
import { uiFunction } from "./helpers/ui-function.mjs";

const agent = (address, space, extra = {}) => ({ address, space, space_name: space.toUpperCase(), status: "idle", pinned: false, ...extra });
const list = [
  agent("t1", "a", { pinned: true }), agent("t2", "a"), agent("t3", "b", { pinned: true, status: "blocked" }),
  agent("t4", "b"), agent("t5", "c", { pinned: true }),
];
const rankOf = a => RANK[a.status];
const shape = groups => groups.map(g => [g.id, g.label, g.pinned, g.space ?? null, g.members.map(a => a.address)]);

test("together keeps Herdr's single Pinned group above the spaces", () => {
  const groups = buildGroups(list, { byPriority: false, pins: "together", rankOf });
  assert.deepEqual(shape(groups), [
    ["pinned", "Pinned", true, null, ["t1", "t3", "t5"]],
    ["sp-a", "A", false, "a", ["t2"]], ["sp-b", "B", false, "b", ["t4"]],
  ]);
  assert.deepEqual(groupOrder(groups).map(a => a.address), ["t1", "t3", "t5", "t2", "t4"]);
  assert.deepEqual(buildGroups(list.filter(a => !a.pinned), { byPriority: false, rankOf }).map(g => g.id), ["sp-a", "sp-b"]);
});

test("split puts one pinned group per space at the top, named by the space", () => {
  const groups = buildGroups(list, { byPriority: false, pins: "split", rankOf });
  assert.deepEqual(shape(groups), [
    ["pin-sp-a", "A", true, "a", ["t1"]], ["pin-sp-b", "B", true, "b", ["t3"]], ["pin-sp-c", "C", true, "c", ["t5"]],
    ["sp-a", "A", false, "a", ["t2"]], ["sp-b", "B", false, "b", ["t4"]],
  ]);
});

test("inline keeps pinned agents at the top of their own space or priority group", () => {
  const spaces = buildGroups(list, { byPriority: false, pins: "inline", rankOf });
  assert.deepEqual(shape(spaces), [
    ["sp-a", "A", false, "a", ["t1", "t2"]], ["sp-b", "B", false, "b", ["t3", "t4"]], ["sp-c", "C", false, "c", ["t5"]],
  ]);
  const sorted = [...list].sort((x, y) => rankOf(y) - rankOf(x));
  const sections = buildGroups(sorted, { byPriority: true, pins: "inline", rankOf });
  assert.deepEqual(sections.map(g => [g.label, g.status, g.members.map(a => a.address)]), [
    ["Needs you", "blocked", ["t3"]], ["Idle", null, ["t1", "t5", "t2", "t4"]],
  ]);
});

test("a space split apart by sorting still makes one group, and settings fall back to defaults", () => {
  const scattered = [agent("x1", "a"), agent("x2", "b"), agent("x3", "a")];
  assert.deepEqual(buildGroups(scattered, { byPriority: false, rankOf }).map(g => g.members.length), [2, 1]);
  assert.equal(pinModeOf("bogus"), PIN_MODES[0]); assert.equal(pinModeOf("split").id, "split");
  assert.equal(sortOf(undefined).id, "priority"); assert.equal(sortOf("grouped").id, "grouped");
});

test("a kept sub-agent shown in its parent's tree gets no row of its own, unless pinned", () => {
  const kept = [agent("p1", "a"), agent("k1", "a"), agent("k2", "a", { pinned: true }), agent("x1", "b")];
  assert.deepEqual(dropNested(kept, new Set(["k1", "k2"])).map(a => a.address), ["p1", "k2", "x1"]);
  assert.deepEqual(dropNested(kept, new Set()).map(a => a.address), ["p1", "k1", "k2", "x1"]);
});

test("countByTab counts the listed agents in each tab", () => {
  const counts = countByTab([agent("a1", "a", { tab: "t1" }), agent("a2", "a", { tab: "t1" }), agent("b1", "b", { tab: "t2" })]);
  assert.equal(counts.get("t1"), 2); assert.equal(counts.get("t2"), 1); assert.equal(counts.get("t3"), undefined);
});

function element() {
  const fields = { name: null, childNodes: [], events: {} };
  const proxy = new Proxy(fields, { get(node, key) {
    if (key === "id") return value => { node.name = value; return proxy; };
    if (key === "child" || key === "children") return value => { node.childNodes.push(...(key === "child" ? [value] : value)); return proxy; };
    if (key === "when") return (condition, draw) => condition ? draw(proxy) : proxy;
    if (key.startsWith("on_")) return callback => { node.events[key] = callback; return proxy; };
    return key in node ? node[key] : () => proxy;
  } });
  return proxy;
}

const nodes = node => node && typeof node === "object" ? [node, ...node.childNodes.flatMap(nodes)] : [];
const words = node => typeof node === "string" ? [node] : node?.childNodes?.flatMap(words) ?? [];
const record = (state, title = "") => ({ app: "claude-code", state, title });

function recordFixture() {
  const raw = {
    address: "t1", state: "live", created_ms: 10, pid: 11, foreground: { pid: 12 },
    records: { working: record("working", "Working task"), blocked: record("error", "Reported failure"), unknown: record("waiting"), done: record("done", "Completed task") },
  };
  const core = [raw], calls = [], orders = [], panes = [{ pane: "p1", terminal: raw.address }], peers = [
    agent("t1", "a", { title: "Parent", pane: "p1", seq: 90 }),
    agent("t2", "b", { title: "Peer", pane: "p2", status: "working", seq: 1 }),
  ];
  let masked = false;
  const deps = { ...model, View: class {}, div: element, svg: element, h_flex: element, v_flex: element, props: () => ({}), theme: () => ({}),
    privacyGuard: () => masked ? "MASK" : null, layout: () => ({ id: "sidebar", size: { px: 268 } }), terminals: () => core,
    agents: () => peers, panes: () => panes, spaces: () => [], focused: () => null, shared: () => undefined,
    localStorage: { getItem: () => null, setItem() {} }, run: (...args) => calls.push(args), setAgentOrder: order => orders.push(order) };
  const source = readFileSync(new URL("../mods/agents-plus/main.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  const Agents = uiFunction(...Object.keys(deps), source)(...Object.values(deps)), view = new Agents();
  const cx = { timer: { every() {} }, notify() {}, stop_propagation() {} };
  view.init({}, cx);
  return { view, raw, core, calls, orders, cx, mask: () => { masked = true; } };
}

test("in-process rows are folded with their parent, keep rank, and focus only the verified parent", () => {
  const f = recordFixture(), tree = f.view.render(f.cx);
  const row = id => nodes(tree).find(node => node.name === 'sub-record-' + JSON.stringify(["t1", id]));
  assert.deepEqual(f.orders.at(-1), ["t2", "t1"]);
  assert.deepEqual(words(row("working")), ["Working task", "Working"]);
  assert.deepEqual(words(row("blocked")), ["Reported failure", "Needs you"]);
  assert.deepEqual(words(row("done")), ["Completed task", "Done"]);
  assert.deepEqual(words(row("unknown")), ["unknown"]);
  row("done").events.on_click();
  assert.deepEqual(f.calls, [["pane.focus", { terminal: "t1" }]]);
  f.core[0] = { ...f.raw, pid: 40 };
  row("done").events.on_click();
  assert.equal(f.calls.length, 1);
  nodes(tree).find(node => node.name === "fold-t1").events.on_click({}, f.cx);
  assert(!nodes(f.view.render(f.cx)).some(node => node.name?.startsWith("sub-record-")));
  f.mask();
  assert.equal(f.view.render(f.cx), "MASK");
});

test("Agents Plus ignores malformed records and bounds rows per live terminal", () => {
  const f = recordFixture();
  const bad = { absent: null, scalar: 7, array: [], other: { app: "codex", state: "done" }, " ": record("done") };
  for (const records of [undefined, "bad", [], bad]) assert.deepEqual(f.view.tree([{ ...f.raw, records }], "t1"), []);
  const many = Object.fromEntries(Array.from({ length: 25 }, (_, n) => [`id-${n}`, record("idle", { malformed: true })]));
  const rows = f.view.tree([{ ...f.raw, records: { ...bad, ...many } }], "t1");
  assert.equal(rows.length, 20);
  assert.deepEqual(rows[0].record, { id: "id-0", title: "id-0", status: null });
  assert.deepEqual(f.view.tree([{ ...f.raw, state: "exited" }], "t1"), []);
});

test("periodic timers start in a live window but not while herdr-app check loads the mod", () => {
  const source = readFileSync(new URL("../mods/agents-plus/main.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  for (const [checking, expected] of [[false, [30000]], [true, []]]) {
    const deps = { ...model, View: class {}, div: element, svg: element, h_flex: element, v_flex: element, props: () => ({}), theme: () => ({}),
      privacyGuard: () => null, layout: () => ({}), terminals: () => [], agents: () => [], panes: () => [], spaces: () => [], focused: () => null,
      shared: () => undefined, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, run() {}, setAgentOrder() {}, checking: () => checking };
    const Agents = uiFunction(...Object.keys(deps), source)(...Object.values(deps)), timers = [];
    new Agents().init({}, { timer: { every(ms) { timers.push(ms); } }, notify() {}, stop_propagation() {} });
    assert.deepEqual(timers, expected);
  }
});
