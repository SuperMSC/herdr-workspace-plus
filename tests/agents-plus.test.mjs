import assert from "node:assert/strict";
import test from "node:test";
import { RANK, buildGroups, groupOrder, pinModeOf, sortOf, PIN_MODES } from "../mods/agents-plus/model.js";

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
