import assert from "node:assert/strict";
import test from "node:test";
import { RANK, buildGroups, groupOrder, pinModeOf, sortOf, PIN_MODES, dropNested, countByTab } from "../mods/agents-plus/model.js";

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
