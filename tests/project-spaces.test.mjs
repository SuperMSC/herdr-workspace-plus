import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeState, autoProject, buildGroups, targetOrder, moves, assignSpace, createGroup, newGroupKey, renameGroup,
  setGroupColor, toggleFold, foldAll, ungroup, moveGroup, stepGroup, prune, activity, urgent,
} from "../mods/project-spaces/model.js";

const repo = (root, extra = {}) => ({ name: root.split("/").pop(), branch: "main", ahead: 0, behind: 0, repo: JSON.stringify([null, `${root}/.git`]), linked: false, ...extra });
const space = (id, extra = {}) => ({ id, name: id, machine: null, folder: `/w/${id}`, active: false, status: null, tabs: [], ...extra });
const row = (w, i, g = null, place = w.folder) => ({ w, i, g, place });

function fixture() {
  const api = space("api"), wt = space("api-fix", { folder: "/w/api-fix" }), bash = space("bash"), web = space("web", { status: "blocked" });
  return [
    row(api, 0, repo("/w/api")),
    row(bash, 1),
    row(web, 2, repo("/w/web")),
    row(wt, 3, repo("/w/api", { branch: "fix", linked: true })),
  ];
}

test("damaged state falls back to defaults", () => {
  assert.deepEqual(normalizeState(null), { mode: "project", sort: "manual", folded: [], order: [], assign: {}, groups: {} });
  const st = normalizeState({ mode: "bogus", sort: "recent", folded: ["a", "a", 3], assign: { x: "k", y: 5 }, groups: { k: { name: "N", junk: 1 }, e: {} } });
  assert.equal(st.mode, "project");
  assert.equal(st.sort, "recent");
  assert.deepEqual(st.folded, ["a"]);
  assert.deepEqual(st.assign, { x: "k" });
  assert.deepEqual(st.groups, { k: { name: "N" } });
});

test("a repository and its worktrees form one project; other folders their own", () => {
  const groups = buildGroups(fixture(), {});
  assert.deepEqual(groups.map(g => g.name), ["api", "bash", "web"]);
  assert.deepEqual(groups[0].rows.map(r => r.w.id), ["api", "api-fix"]);
  assert.equal(groups[0].folder, "/w/api");
  assert.equal(groups[2].status, "blocked");
  assert.deepEqual(targetOrder(groups, {}), ["api", "api-fix", "bash", "web"]);
});

test("home folders and remote machines get their own projects", () => {
  assert.equal(autoProject(space("h", { folder: "/Users/me" }), null, "/Users/me", "/Users/me").name, "Home");
  const local = autoProject(space("a"), repo("/w/api"), "/w/api");
  const remote = autoProject(space("b", { machine: "box" }), { ...repo("/w/api"), repo: JSON.stringify(["box", "/w/api/.git"]) }, "/w/api");
  assert.notEqual(local.key, remote.key);
  assert.equal(remote.machine, "box");
});

test("a manual assignment moves a space and keeps the group's name", () => {
  const rows = fixture();
  const groups = buildGroups(rows, {});
  const bash = groups.find(g => g.name === "bash").rows[0];
  const st = assignSpace({}, "bash", groups[0].key, bash.auto.key, "api");
  const next = buildGroups(rows, st);
  assert.deepEqual(next.map(g => g.name), ["api", "web"]);
  assert.deepEqual(next[0].rows.map(r => r.w.id), ["api", "bash", "api-fix"]);
  assert.equal(next[0].manual, 1);
  // Its own automatic project clears the choice.
  assert.deepEqual(assignSpace(st, "bash", bash.auto.key, bash.auto.key).assign, {});
  // Releasing returns it.
  assert.deepEqual(buildGroups(rows, ungroup(st, groups[0].key)).map(g => g.name), ["api", "bash", "web"]);
});

test("a manual project is created with a space, renamed, colored and dissolved", () => {
  const rows = fixture();
  const key = newGroupKey({}, 1000);
  const auto = buildGroups(rows, {}).find(g => g.name === "bash").key;
  let st = createGroup({}, key, "  Tools ", "bash", auto);
  st = assignSpace(st, "web", key, buildGroups(rows, {}).find(g => g.name === "web").key, "Tools");
  let groups = buildGroups(rows, st);
  const tools = groups.find(g => g.key === key);
  assert.equal(tools.name, "Tools");
  assert.equal(tools.custom, true);
  assert.deepEqual(tools.rows.map(r => r.w.id), ["bash", "web"]);
  st = setGroupColor(renameGroup(st, key, "Ops"), key, "ansi4");
  groups = buildGroups(rows, st);
  assert.equal(groups.find(g => g.key === key).name, "Ops");
  assert.equal(groups.find(g => g.key === key).color, "ansi4");
  // Renaming an automatic project to "" restores its folder name.
  const api = groups[0].key;
  assert.equal(buildGroups(rows, renameGroup(renameGroup(st, api, "Backend"), api, "")).find(g => g.key === api).name, "api");
  st = ungroup(st, key);
  assert.equal(st.groups[key], undefined);
  assert.deepEqual(buildGroups(rows, st).map(g => g.name), ["api", "bash", "web"]);
});

test("a manual project nothing points to is dropped", () => {
  const key = newGroupKey({}, 1);
  const st = createGroup({}, key, "Tools", "bash", "dir:x");
  assert.ok(st.groups[key]);
  assert.equal(prune(st, ["api"]).groups[key], undefined);
  assert.ok(prune(st, ["bash"]).groups[key]);
});

test("projects follow the manual order, then first appearance", () => {
  const rows = fixture();
  const keys = buildGroups(rows, {}).map(g => g.key);
  const st = moveGroup({}, keys, keys[2], keys[0]);
  assert.deepEqual(buildGroups(rows, st).map(g => g.name), ["web", "api", "bash"]);
  assert.deepEqual(buildGroups(rows, moveGroup({}, keys, keys[0], keys[2], true)).map(g => g.name), ["bash", "web", "api"]);
  assert.deepEqual(buildGroups(rows, stepGroup({}, keys, keys[1], -1)).map(g => g.name), ["bash", "api", "web"]);
  assert.deepEqual(stepGroup({}, keys, keys[0], -1).order, []);
});

test("Recent sorts projects and spaces by their latest activity", () => {
  const rows = fixture();
  rows[1].w.tabs = [{ changed_at: 500 }];
  rows[3].w.tabs = [{ changed_at: 100 }, { working_since: 900 }];
  const groups = buildGroups(rows, { sort: "recent" });
  assert.deepEqual(groups.map(g => g.name), ["api", "bash", "web"]);
  assert.deepEqual(groups[0].rows.map(r => r.w.id), ["api-fix", "api"]);
  assert.equal(targetOrder(groups, { sort: "recent" }), null);
  assert.equal(activity(rows[3].w), 900);
});

test("Status groups by the most urgent state; None shows one list", () => {
  const rows = fixture();
  rows[0].w.status = "working";
  const status = buildGroups(rows, { mode: "status" });
  assert.deepEqual(status.map(g => g.name), ["Needs you", "Working", "Idle"]);
  assert.deepEqual(status[2].rows.map(r => r.w.id), ["bash", "api-fix"]);
  const none = buildGroups(rows, { mode: "none" });
  assert.equal(none.length, 1);
  assert.equal(none[0].header, false);
  assert.equal(targetOrder(none, { mode: "none" }), null);
  assert.equal(urgent(["idle", "done", "working"]), "done");
});

test("folding is remembered per group", () => {
  const rows = fixture();
  const keys = buildGroups(rows, {}).map(g => g.key);
  let st = toggleFold({}, keys[0]);
  assert.equal(buildGroups(rows, st)[0].folded, true);
  st = toggleFold(st, keys[0]);
  assert.equal(buildGroups(rows, st)[0].folded, false);
  assert.deepEqual(foldAll({}, keys, true).folded, keys);
  assert.deepEqual(foldAll({ folded: keys }, keys.slice(1), false).folded, keys.slice(0, 1));
});

test("moves turn one order into another with 1-based indexes after each move", () => {
  const order = ["a", "b", "c", "d"];
  const target = ["c", "a", "d", "b"];
  const steps = moves(order, target);
  const applied = [...order];
  for (const { id, index } of steps) applied.splice(index - 1, 0, applied.splice(applied.indexOf(id), 1)[0]);
  assert.deepEqual(applied, target);
  assert.deepEqual(moves(order, order), []);
  assert.deepEqual(moves(order, ["x", "a"]), []);
});
