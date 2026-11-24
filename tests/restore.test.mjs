import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as live from "../mods/sessions-plus/live-model.js";
import * as model from "../mods/sessions-plus/model.js";
import * as launcher from "../mods/sessions-plus/launcher-model.js";
import { uiFunction } from "./helpers/ui-function.mjs";

const { TERMINAL_SESSIONS_KEY: KEY, TERMINAL_SESSION_AGE, updateTerminalSessions, interruptedSessions, workspaceTerminals } = live;
const NOW = 1800000000000, identity = n => ({ provider: "claude", id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`, store: "/local/claude" });
const terminal = (n, extra = {}) => ({ address: "t" + n, created_ms: 100 + n, pid: 8 + n, foreground: { pid: 18 + n },
  state: "live", keep: true, parent: null, identity: identity(n), cwd: "/project/" + n, space: "s" + n, tab: "b" + n, ...extra });
const saved = (n, extra = {}) => {
  const t = terminal(n);
  return { address: t.address, created_ms: t.created_ms, pid: t.pid, ...t.identity, cwd: t.cwd, space: t.space, tab: t.tab, lastSeen: NOW - 30000, ...extra };
};
const key = model.liveKey, previous = { "t1@101": saved(1) };
const step = (before, terminals, extra = {}) => updateTerminalSessions(before.registry, before.misses, { terminals, ready: true, now: NOW, ...extra });
const start = { registry: previous, misses: new Map() };

test("interruption is anchored to the root PID and the same live terminal creation identity", () => {
  const cases = [
    ["root PID changed", terminal(1, { pid: 90, identity: null }), true],
    ["both PIDs stayed unchanged", terminal(1), false],
    ["only foreground PID changed", terminal(1, { foreground: { pid: 70 }, identity: null }), false],
    ["root PID unknown", terminal(1, { pid: null, identity: null }), false],
    ["address was reused", terminal(1, { pid: 90, created_ms: 500, identity: null }), false],
    ["session already resumed in its original terminal", terminal(1, { pid: 90 }), false],
    ["finished with a restart reason", terminal(1, { pid: 90, state: "finished", reason: "stopped_by_restart" }), false],
  ];
  for (const [name, observation, interrupted] of cases) {
    const result = step(start, [observation]);
    assert.equal(interruptedSessions(result.registry).length, Number(interrupted), name);
    assert(result.registry["t1@101"], name);
  }
  const result = step(start, [terminal(1, { pid: 90, identity: null })]);
  assert.deepEqual(result.registry["t1@101"], { ...previous["t1@101"], interrupted: true });
  assert.equal(step(result, [terminal(1, { pid: 90, identity: null })], { now: NOW + 20000 }).registry["t1@101"].lastSeen, previous["t1@101"].lastSeen);
});

test("two consecutive ready misses drop a closed terminal or a normal foreground exit", () => {
  for (const [name, observations] of [
    ["closed", []],
    ["finished", [terminal(1, { state: "finished", reason: "killed" })]],
    ["shell", [terminal(1, { identity: null })]],
  ]) {
    const one = step(start, observations);
    assert(one.registry["t1@101"], name);
    assert.equal(interruptedSessions(one.registry).length, 0);
    assert.deepEqual(step(one, observations).registry, {}, name);
  }
  const one = step(start, []);
  const failedLayout = step(one, [], { ready: false });
  assert.equal(failedLayout.registry, one.registry);
  assert(step(failedLayout, []).registry["t1@101"]);
  assert(step(one, [terminal(1, { identity: null })]).registry["t1@101"], "different miss kinds do not add up");
  const withoutIdentity = [terminal(1, { identity: null })];
  const missed = step(start, withoutIdentity);
  const skipped = step(missed, withoutIdentity, { uncertain: new Set(["t1@101"]) });
  assert.deepEqual(skipped.misses, new Map());
  assert(step(skipped, withoutIdentity).registry["t1@101"]);
});

test("steady registry JSON survives reordered observations and lastSeen changes at the hour or on movement", () => {
  const lastSeen = NOW - 3599999, first = terminal(1), second = terminal(2);
  const registry = { [key(first)]: saved(1, { lastSeen }), [key(second)]: saved(2, { lastSeen }) };
  const before = { registry, misses: new Map() };
  assert.equal(JSON.stringify(step(before, [second, first]).registry), JSON.stringify(registry));
  const refreshed = step(before, [second, first], { now: NOW + 1 }).registry;
  assert.equal(refreshed[key(first)].lastSeen, NOW + 1);
  assert.equal(refreshed[key(second)].lastSeen, NOW + 1);
  for (const change of [{ pid: 50 }, { cwd: "/other" }, { space: "new-space" }, { tab: "new-tab" }]) {
    assert.deepEqual(step(before, [terminal(1, change), second]).registry[key(first)], saved(1, { ...change, lastSeen: NOW }));
  }
});

test("restored identity elsewhere clears the interruption even if the new terminal is not kept", () => {
  const lost = terminal(1, { pid: 99, identity: null });
  const interrupted = step(start, [lost]);
  const other = terminal(2, { keep: false, parent: "t-parent", identity: identity(1) });
  assert.deepEqual(step(interrupted, [lost, other]).registry, {});
  const remote = { ...other, address: "server/t2" };
  assert.equal(interruptedSessions(step(interrupted, [lost, remote]).registry).length, 1);
  assert.equal(interruptedSessions(step(start, [lost], { uncertain: new Set(["t2@102"]) }).registry).length, 0);
});

test("the registry expires after seven days and only stores local kept roots with exact identities", () => {
  const all = Array.from({ length: 43 }, (_, index) => terminal(index + 1));
  const noIdentity = terminal(54, { identity: null }), notKept = terminal(55, { keep: false });
  const child = terminal(56, { parent: "t1" }), remote = terminal(57, { address: "server/t57" });
  const state = step({ registry: {}, misses: new Map() }, [noIdentity, notKept, child, remote, ...all]);
  assert.equal(Object.keys(state.registry).length, 40);
  for (const item of [noIdentity, notKept, child, remote, all[42]]) assert(!state.registry[key(item)]);
  assert.deepEqual(state.registry["t1@101"], saved(1, { lastSeen: NOW }));
  const old = { registry: { "t1@101": saved(1, { lastSeen: NOW - TERMINAL_SESSION_AGE - 1, interrupted: true }) } };
  assert.equal(step(old, [], { ready: false }).registry, old.registry);
  assert.deepEqual(step(old, []).registry, {});
  assert.deepEqual(step(old, [terminal(1)]).registry, { "t1@101": saved(1, { lastSeen: NOW }) });
});

test("capture uses explicit tab ownership and retains the terminal root PID", () => {
  const raw = terminal(1, { foreground: { pid: 99, cwd: "/current" }, labels: { "herdr.space": "s1", "herdr.tab": "b1" } });
  const spaces = [{ id: "s1", machine: null, tabs: [{ id: "b1" }] }];
  const [observation] = workspaceTerminals([raw], { spaces, identities: { [key(raw)]: identity(1) } });
  assert.deepEqual([observation.space, observation.tab, observation.cwd, observation.pid, observation.agent], ["s1", "b1", "/current", raw.pid, true]);
  const [unplaced] = workspaceTerminals([{ ...raw, labels: {} }], { spaces, identities: { [key(raw)]: identity(1) } });
  assert.deepEqual([unplaced.space, unplaced.tab], [null, null]);
});

test("the footer tick still detects an interrupted shell when no agent needs probing", () => {
  const shell = terminal(1, { pid: 70, foreground: { pid: 71, argv: ["zsh"] }, identity: null });
  const source = readFileSync(new URL("../mods/sessions-plus/footer.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export default class", "class");
  const deps = { ...live, ...model, terminals: () => [shell], checking: () => false, window: () => ({ active: true }), shared: () => undefined };
  const Service = uiFunction(...Object.keys(deps), source + "\nreturn LiveSessions;")(...Object.values(deps));
  let result = start, ticks = 0;
  const service = new Service((items, identities, uncertain) => {
    ticks++;
    result = step(result, workspaceTerminals(items, { identities }), { uncertain });
  });
  service.init({}, { timer: { every(ms) { assert.equal(ms, 20000); } }, spawn() { throw new Error("A shell needs no live probe"); } });
  assert.equal(ticks, 1);
  assert.equal(interruptedSessions(result.registry).length, 1);
});

function view(file, dependencies) {
  const source = readFileSync(new URL(`../mods/sessions-plus/${file}.js`, import.meta.url), "utf8").replace(/^import[\s\S]*?;\n/gm, "").replace("export default class", "return class");
  return uiFunction(...Object.keys(dependencies), source)(...Object.values(dependencies));
}

function element() {
  const state = { attrs: {}, items: [], events: {} }, proxy = new Proxy(state, { get(target, name) {
    if (name === "child" || name === "children") return item => { target.items.push(...(name === "child" ? [item] : item)); return proxy; };
    if (name === "when") return (show, fn) => show ? fn(proxy) : proxy;
    if (typeof name === "string" && name.startsWith("on_")) return fn => { target.events[name] = fn; return proxy; };
    return name in target ? target[name] : value => { target.attrs[name] = value; return proxy; };
  } });
  return proxy;
}
const find = (node, id) => !node || typeof node !== "object" ? null : node.attrs.id === id ? node : node.items.map(item => find(item, id)).find(Boolean);
const text = node => typeof node === "string" ? node : (node?.items || []).map(text).join(" ");

function sessionView(registry) {
  const store = new Map([[KEY, registry]]), tasks = [], commands = [], checks = [], running = [], layouts = [{ name: null, layout: "ready" }];
  const spaces = [{ id: "s1", machine: null, folder: "/recorded/space" },
    { id: "server/s2", machine: "server", folder: "/project/2" }, { id: "folder-match", machine: null, folder: "/project/2" }];
  const cx = { spawn: fn => tasks.push(fn(cx)), notify() {}, timer: { after() {} } };
  const Panel = view("main", { ...model, ...live, View: class {}, div: element, h_flex: element, v_flex: element, panes: () => [],
    shared: name => store.get(name), setShared: (name, value) => store.set(name, value), machines: () => layouts,
    spaces: () => spaces, terminals: () => running, run: (...args) => commands.push(args) });
  const panel = new Panel(); panel.p = { stores: {} };
  panel.read = (action, sessionKey, stores) => new Promise((resolve, reject) => checks.push({ action, sessionKey, stores, resolve, reject }));
  const validation = n => ({ row: { ...identity(n), key: model.sessionKey(identity(n)), cwd: "/project/" + n, title: "Original " + n }, command: "/bin/claude" });
  return { panel, store, cx, tasks, commands, checks, running, layouts, validation, spaces };
}

test("the interrupted strip resumes in sequence in a new local tab and leaves focus unchanged on Resume all", async () => {
  const registry = { "t1@101": saved(1, { interrupted: true }), "t2@102": saved(2, { interrupted: true }) };
  const f = sessionView(registry), strip = f.panel.interruptedStrip(interruptedSessions(registry), {});
  f.running.push(terminal(1, { pid: 90, foreground: { pid: 91 }, argv: ["claude", "--resume", identity(1).id] }));
  assert.match(text(strip), /Interrupted · 2/);
  assert(find(strip, "sessions-interrupted-resume-t1@101"));
  find(strip, "sessions-interrupted-resume-all").events.on_click({}, f.cx);
  assert.equal(f.checks.length, 1);
  assert.deepEqual([f.checks[0].action, f.checks[0].stores, f.store.get(model.OPERATIONS)[model.sessionKey(identity(1))].action],
    ["validate", { claude: identity(1).store }, "resume"]);
  f.checks[0].resolve(f.validation(1));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.checks.length, 2);
  assert.equal(f.commands.length, 1);
  f.checks[1].resolve(f.validation(2)); await f.tasks[0];
  assert.deepEqual(f.commands.map(([command, args]) => [command, args.space, args.name, args.folder, args.focus]), [
    ["tab.new", "s1", "Original 1", "/project/1", false],
    ["tab.new", "folder-match", "Original 2", "/project/2", false],
  ]);
  assert.equal(f.store.get(KEY), registry, "keep the offer until the footer observes the restarted session");
});

test("single Resume falls back to a new space and a vanished record or active exact identity blocks an in-flight launch", async () => {
  const registry = { "t1@101": saved(1, { interrupted: true }) };
  for (const mode of ["new space", "dismissed", "already live", "validation failed"]) {
    const f = sessionView(registry), [entry] = interruptedSessions(registry);
    f.spaces.length = 0;
    f.panel.resumeInterrupted([entry], f.cx);
    if (mode === "dismissed") f.panel.dismissInterrupted([entry], f.cx);
    if (mode === "already live") f.running.push(terminal(4, { foreground: { pid: 40, argv: ["/usr/bin/env", "CLAUDE_CONFIG_DIR=/local/claude", "claude", "--resume", identity(1).id] } }));
    if (mode === "validation failed") f.checks[0].reject(new Error("This session is no longer available."));
    else f.checks[0].resolve(f.validation(1));
    await f.tasks[0];
    if (mode === "new space") assert.deepEqual(f.commands.map(([cmd, args]) => [cmd, args.tab, args.focus]), [["space.new", "Original 1", undefined]]);
    else { assert.deepEqual(f.commands, [], mode); assert(f.panel.error, mode); }
  }
});

test("Dismiss removes only currently matching captured entries", () => {
  const registry = { "t1@101": saved(1, { interrupted: true }), "t2@102": saved(2) };
  const f = sessionView(registry), [entry] = interruptedSessions(registry);
  const strip = f.panel.interruptedStrip([entry], {});
  find(strip, "sessions-interrupted-dismiss").events.on_click({}, f.cx);
  assert.deepEqual(f.store.get(KEY), { "t2@102": saved(2) });
  const changed = { ...registry["t1@101"], pid: 60 };
  f.store.set(KEY, { ...registry, "t1@101": changed });
  f.panel.dismissInterrupted([entry], f.cx);
  assert.equal(f.store.get(KEY)["t1@101"], changed);
});

test("Launcher groups interrupted sessions and passes the current captured entry to Resume", () => {
  const original = saved(1, { interrupted: true }), registry = { "t1@101": original };
  const snapshot = { terminals: [], agents: [], spaces: [], interrupted: registry, names: { [model.sessionKey(original)]: "Friendly name" } };
  const rows = launcher.launcherRows(snapshot, "interrupted"), candidate = rows.find(row => row.kind === "interrupted");
  assert.deepEqual([candidate.group, candidate.title, candidate.created], ["Interrupted sessions", "Friendly name", 101]);
  const calls = [], Launcher = view("launcher", { ...launcher, div: element, h_flex: element, v_flex: element, Input: { new: element },
    theme: () => ({}), closeOverlay: id => calls.push(["close", id]) });
  const role = new Launcher();
  Object.assign(role, { p: { overlay: "launcher" }, stage: "main", query: "", index: 0, snapshot: () => snapshot });
  role.resumeInterrupted = (entry, cx, finished) => { calls.push(["resume", entry]); finished(true, "", cx); };
  const cx = { notify() {} }, tree = role.render();
  assert.match(text(tree), /Interrupted sessions.*Friendly name.*Resume/);
  find(tree, "launcher-row-" + candidate.id).events.on_click({}, cx);
  assert.deepEqual(calls, [["resume", candidate.entry], ["close", "launcher"]]);
  registry["t1@101"] = { ...original, pid: 67 };
  role.activate(candidate, cx);
  assert.match(role.error, /changed/);
  assert.equal(calls.length, 2);
});
