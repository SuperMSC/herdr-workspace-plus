import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as live from "../mods/sessions-plus/live-model.js";
import * as model from "../mods/sessions-plus/model.js";
import { uiFunction } from "./helpers/ui-function.mjs";

const { planAutoTitles, workspaceTerminals, AUTO_TITLES_KEY, AUTO_TITLES_ENABLED } = live, NOW = 1800000000000;
const identity = { provider: "claude", store: "/store/claude", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "  The\n session\x00title  " };
const term = { address: "t1", state: "live", tab: "tab", agent: true, identity };
const tab = (extra = {}) => ({ id: "tab", name: "1", named: false, ...extra });
const space = (tabs = [tab()], extra = {}) => ({ id: "space", machine: null, tabs, ...extra });
const plan = (prior, changes = {}) => planAutoTitles(prior, { terminals: [term], spaces: [space()], ready: true, now: NOW, ...changes });

test("automatic titles follow the ownership rule table and clean nonempty names to 40 characters", () => {
  const automatic = { id: "tab", name: "The session title" };
  assert.deepEqual(plan({}), { registry: { tab: { name: automatic.name } }, actions: [automatic] });
  assert.deepEqual(plan({}, { spaces: [space([tab({ named: true, name: "A user title" })])] }), { registry: {}, actions: [] });
  const old = { tab: { name: "Earlier" } }, owned = [space([tab({ named: true, name: "Earlier" })])];
  assert.deepEqual(plan(old, { spaces: owned }).actions, [automatic]);
  assert.deepEqual(plan(old, { spaces: owned, names: { [model.sessionKey(identity)]: "  " + "文".repeat(55) } }).actions,
    [{ id: "tab", name: "文".repeat(40) }]);
  assert.deepEqual(plan(old, { spaces: owned, terminals: [{ ...term, identity: { ...identity, title: "  \n " } }] }).actions, []);
  assert.deepEqual(plan({}, { terminals: [{ ...term, identity: null }] }).actions, []);
});

test("once an owned tab is manually renamed it stays user-owned through updates and toggle changes", () => {
  const old = { tab: { name: "Earlier" } }, manuallyNamed = [space([tab({ name: "Personal", named: true })])];
  const result = plan(old, { spaces: manuallyNamed });
  assert.deepEqual(result, { registry: { tab: { name: "Earlier", user: true } }, actions: [] });
  for (const enabled of [true, false]) {
    const again = plan(result.registry, { enabled, spaces: [space([tab({ name: "Earlier", named: true })])] });
    assert.deepEqual(again, { registry: result.registry, actions: [] });
  }
});

test("screenshot mode clears only owned titles and restores them after the native tab acknowledges the reset", () => {
  const old = { tab: { name: "Earlier" } };
  const named = [space([tab({ name: "Earlier", named: true }), tab({ id: "manual", name: "Private", named: true })])];
  const renamedAt = new Map([["tab", NOW - 1]]);
  const hidden = plan(old, { spaces: named, screenshot: true, renamedAt });
  assert.deepEqual(hidden, { registry: { tab: { name: "Earlier", hidden: true } }, actions: [{ id: "tab", name: "" }] });
  assert.deepEqual(plan(hidden.registry, { spaces: named, screenshot: true, renamedAt }).actions, []);
  assert.deepEqual(plan(hidden.registry, { screenshot: true }).actions, []);
  assert.deepEqual(plan(hidden.registry, { terminals: [], renamedAt }), { registry: old, actions: [{ id: "tab", name: "Earlier" }] });
  assert.deepEqual(plan(hidden.registry, { enabled: false }), { registry: {}, actions: [] });
  const manuallyRenamed = plan(hidden.registry, { spaces: [space([tab({ name: "New name", named: true })])] });
  assert.deepEqual(manuallyRenamed, { registry: { tab: { name: "Earlier", user: true } }, actions: [] });
});

test("unavailable layouts, remote tabs and multi-agent tabs receive no rename", () => {
  const old = { tab: { name: "Earlier" } };
  const result = plan(old, { ready: false, screenshot: true });
  assert.equal(result.registry, old);
  assert.deepEqual(result.actions, []);
  const remote = [space([tab({ id: "server/tab" })], { machine: "server", id: "server/space" })];
  assert.deepEqual(plan({}, { spaces: remote, terminals: [{ ...term, tab: "server/tab", address: "server/t1" }] }).actions, []);
  assert.deepEqual(plan({}, { terminals: [term, { ...term, address: "t2", identity: null }] }).actions, []);
  assert.deepEqual(plan({}, { terminals: [term, { ...term, address: "t2", agent: false, identity: null }] }).actions, [{ id: "tab", name: "The session title" }]);
});

test("per-tab rate limiting also gates reset commands; disabling resets only still-owned names", () => {
  const old = { tab: { name: "Earlier" }, changed: { name: "Mine before" }, stopped: { name: "User owned", user: true },
    inactive: { name: "Our empty tab" } };
  const current = space([tab({ name: "Earlier", named: true }), tab({ id: "changed", name: "Mine now", named: true }),
    tab({ id: "stopped", name: "User owned", named: true }), tab({ id: "inactive", name: "Our empty tab", named: true }), tab({ id: "resumed", name: "Recovered", named: true })]);
  const held = { spaces: [current], renamedAt: new Map([["tab", NOW - 29999]]) };
  assert.deepEqual(plan(old, held).actions, []);
  assert.deepEqual(plan(old, { ...held, now: NOW + 1 }).actions, [{ id: "tab", name: "The session title" }]);
  const reset = plan(old, { ...held, enabled: false, now: NOW + 1, terminals: [] });
  assert.deepEqual(reset.actions, [{ id: "tab", name: "" }, { id: "inactive", name: "" }]);
  assert.deepEqual(reset.registry, { changed: { name: "Mine before", user: true }, stopped: old.stopped });
});

test("exact helper identity and Herdr's agent and pane links agree on agent count", () => {
  const terminals = [
    { address: "t1", created_ms: 100, pid: 11, state: "live", foreground: { pid: 12 }, keep: true, parent: null },
    { address: "t2", created_ms: 101, pid: 21, state: "live", keep: true, program: { shell: true } },
    { address: "server/t1", created_ms: 100, pid: 10, state: "live" },
  ], spaces = [space()];
  const input = { spaces, panes: [{ terminal: "t1", tab: "tab", cwd: "/work" }, { terminal: "t2", tab: "tab", cwd: "/work" }], identities: { "t1@100": identity } };
  const both = workspaceTerminals(terminals, input);
  assert.equal(both.length, 2);
  assert.equal(both[0].tab, "tab");
  assert.equal(both[1].agent, false);
  assert.equal(plan({}, { spaces, terminals: both }).actions.length, 1);
  const twoAgents = workspaceTerminals(terminals, { ...input, agents: [{ address: "t2", tab: "tab" }] });
  assert.deepEqual(plan({}, { spaces, terminals: twoAgents }).actions, []);
});

function view(file, dependencies) {
  const source = readFileSync(new URL(`../mods/sessions-plus/${file}.js`, import.meta.url), "utf8").replace(/^import[\s\S]*?;\n/gm, "").replace("export default class", "return class");
  return uiFunction(...Object.keys(dependencies), source)(...Object.values(dependencies));
}

test("the footer avoids steady-state registry writes and resets native titles on the one-second screenshot tick", async () => {
  let layout = "loading", privacy = false;
  const workspace = space(), state = new Map(), commands = [], writes = [], tasks = [];
  let tick;
  const Footer = view("footer", { ...live, ...model, spaces: () => [workspace], panes: () => [{ tab: "tab", terminal: "t1", cwd: "/project" }],
    agents: () => [], machines: () => [{ name: null, layout }], privacyEnabled: () => privacy,
    shared: key => state.get(key), setShared: (key, value) => { writes.push(key); state.set(key, value); }, run: (...args) => commands.push(args),
    ZEN_INTERVAL: 1000, reconcileZen() {}, checking: () => false, window: () => ({ active: true }), layout: () => ({}), StatusBar: class { init() {} }, Resources: class { init() {} } });
  const footer = new Footer(), cx = { spawn: task => tasks.push(task), timer: { every(ms, callback) { assert.equal(ms, 1000); tick = callback; } } };
  footer.init({ stores: {} }, cx);
  await tasks[1](cx);
  const terminal = { address: "t1", state: "live", pid: 11, created_ms: 100, cwd: "/project", keep: true, parent: null, foreground: { pid: 12, argv: ["claude"] } };
  const observed = { "t1@100": identity }, empty = new Set();
  footer.updateWorkspaces([terminal], observed, empty);
  assert.equal(state.size, 0);
  layout = "ready"; privacy = true;
  footer.updateWorkspaces([terminal], observed, empty);
  assert.equal(state.get(live.TERMINAL_SESSIONS_KEY)["t1@100"].pid, 11);
  assert.deepEqual(commands, []);
  privacy = false;
  footer.updateWorkspaces([terminal], observed, empty);
  assert.deepEqual(commands, [["tab.rename", { id: "tab", name: "The session title" }]]);
  assert.deepEqual(state.get(AUTO_TITLES_KEY), { tab: { name: "The session title" } });
  assert.equal(writes.filter(key => key === live.TERMINAL_SESSIONS_KEY).length, 1);
  workspace.tabs[0] = tab({ name: "The session title", named: true });
  privacy = true; tick(); tick();
  assert.deepEqual(commands.slice(1), [["tab.rename", { id: "tab", name: "" }]]);
  assert.deepEqual(state.get(AUTO_TITLES_KEY), { tab: { name: "The session title", hidden: true } });
  workspace.tabs[0] = tab();
  privacy = false;
  tick();
  assert.deepEqual(commands.slice(2), [["tab.rename", { id: "tab", name: "The session title" }]]);
});

test("Tools shows On before the first click and reads the current preference on each render", () => {
  const state = new Map(), writes = [], rendered = [];
  const element = () => new Proxy({}, { get: (_target, prop, self) => value => {
    if (prop === "child" && typeof value === "string" && value.startsWith("Auto tab titles")) rendered.push(value);
    return self;
  } });
  const Tool = view("tools", { AUTO_TITLES_ENABLED, theme: () => ({}), div: element, h_flex: element, v_flex: element,
    shared: key => state.get(key), setShared: (key, value) => { writes.push(key); state.set(key, value); } });
  const tool = new Tool(); tool.p = {};
  tool.render();
  tool.open("auto-titles"); tool.render(); assert.equal(state.get(AUTO_TITLES_ENABLED), false);
  tool.open("auto-titles"); tool.render(); assert.equal(state.get(AUTO_TITLES_ENABLED), true);
  assert.deepEqual(rendered, ["Auto tab titles · On", "Auto tab titles · Off", "Auto tab titles · On"]);
  assert.deepEqual(writes, [AUTO_TITLES_ENABLED, AUTO_TITLES_ENABLED]);
});
