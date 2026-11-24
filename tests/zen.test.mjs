import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launcherKeys, zenKeys } from "../configure-launcher.mjs";
import * as launcherModel from "../mods/sessions-plus/launcher-model.js";
import { COMMANDS_KEY } from "../mods/sessions-plus/commands-model.js";
import { PRESETS_KEY } from "../mods/sessions-plus/presets-model.js";
import { ZEN_KEY, ZEN_FOOTER, ZEN_INTERVAL, planZen, reconcileZen, zenFooter } from "../mods/sessions-plus/zen-model.js";
import { uiFunction } from "./helpers/ui-function.mjs";

const name = "Agent-Workspace";
const toolbar = "workspace-plus-toolbar";
const order = [toolbar, "panel", "sidebar"];
const toggle = { command: "layout.toggle", args: { id: "status" } };

function fixture({ zen = false, hidden = [], footer = true } = {}) {
  const block = (id, type) => ({ id, type, hidden: hidden.includes(id) });
  const status = { id: "status", type: "block", hidden: zen, content: { mod: "sessions-plus", props: { role: "footer" } } };
  return { type: "column", traffic_lights: [12, 16], children: [
    { ...block("body", "row"), children: [block("sidebar", "column"), { ...block("work", "column"), children: [block(toolbar, "row"), block("panel", "column"), block("terminal", "block")] }] },
    ...(footer ? [status] : []),
  ] };
}

function find(node, id) {
  if (node.id === id) return node;
  return node.children?.map(child => find(child, id)).find(Boolean);
}

function host(tree = fixture()) {
  const store = new Map([["layout", name]]), calls = [], writes = [], pending = [];
  let inspecting = false;
  const api = { checking: () => inspecting, layout: () => tree, shared: key => store.get(key),
    setShared(key, value) { writes.push(value); store.set(key, value); },
    run(command, { id }) { calls.push([command, id]); pending.push([command, id]); } };
  return { ...api, store, calls, writes, checkingMode(value) { inspecting = value; }, tick: now => reconcileZen(api, now),
    apply() { for (const [command, id] of pending.splice(0)) find(tree, id).hidden = command === "layout.hide"; },
    callsFor(command) { return calls.filter(([action]) => action === command).map(([, id]) => id); } };
}

test("Zen reconcile table records effective visibility and issues commands in layout order", () => {
  for (const [zen, hidden, captured] of [
    [false, [], undefined], [true, [], order], [true, ["panel"], [toolbar, "sidebar"]],
    [true, ["work"], ["sidebar"]], [true, ["body"], []], [true, order, []],
  ]) {
    const plan = planZen(fixture({ zen, hidden }), undefined, 10);
    assert.deepEqual(plan.next?.visible, captured);
    assert.deepEqual(plan.ids, captured);
    assert.equal(plan.next?.on, zen || undefined);
  }
  const stacked = fixture({ zen: true });
  stacked.children[0] = { type: "stack", active: "different-child", children: [stacked.children[0]] };
  assert.deepEqual(planZen(stacked, undefined, 10).next.visible, []);
  const missing = fixture({ zen: true, footer: false });
  const active = { on: true, visible: order };
  assert.equal(planZen(missing, active, 10).next, active);
  const native = fixture();
  find(native, "status").content.mod = "workspace-status";
  assert.equal(zenFooter(native), undefined);
});

test("two copies claim entry and exit once even when both see the same layout snapshot", () => {
  const tree = fixture({ zen: true, hidden: ["panel"] }), f = host(tree);
  f.tick(10); f.tick(11);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.store.get(ZEN_KEY)[name].visible, [toolbar, "sidebar"]);
  assert.deepEqual(f.callsFor("layout.hide"), [toolbar, "sidebar"]);
  f.apply(); f.tick(12); f.tick(13);
  assert.equal(f.writes.length, 2);
  find(tree, "status").hidden = false;
  f.tick(14); f.tick(15);
  assert.equal(f.store.get(ZEN_KEY)[name].on, false);
  assert.deepEqual(f.callsFor("layout.show"), ["sidebar", toolbar]);
  f.apply(); f.tick(16); f.tick(17);
  assert.deepEqual(f.store.get(ZEN_KEY), {});
  assert.equal(find(tree, "panel").hidden, true);
  assert.equal(f.writes.length, 4);
});

test("Zen hides a returning panel and preserves whether it was visible before entry", () => {
  for (const initiallyHidden of [false, true]) {
    const tree = fixture({ zen: true, hidden: initiallyHidden ? ["panel"] : [] }), f = host(tree);
    f.tick(10); f.apply(); f.tick(11);
    find(tree, "panel").hidden = false;
    const hides = f.calls.length;
    f.tick(12); f.tick(13);
    assert.deepEqual(f.calls.slice(hides), [["layout.hide", "panel"]]);
    f.apply(); f.tick(14);
    find(tree, "status").hidden = false;
    f.tick(15); f.apply(); f.tick(16);
    assert.equal(find(tree, "panel").hidden, initiallyHidden);
    assert.deepEqual(f.callsFor("layout.show"), initiallyHidden ? ["sidebar", toolbar] : ["sidebar", "panel", toolbar]);
  }
});

test("leaving Zen with an empty restore set clears its state without showing any surface", () => {
  const tree = fixture({ zen: true, hidden: order }), f = host(tree);
  f.tick(10);
  assert.deepEqual(f.store.get(ZEN_KEY)[name].visible, []);
  find(tree, "status").hidden = false;
  f.tick(11);
  assert.deepEqual(f.store.get(ZEN_KEY), {});
  assert.deepEqual(f.calls, []);
});

test("rapid toggles preserve the restore set across queued native visibility changes", () => {
  const tree = fixture({ zen: true, hidden: ["sidebar"] }), f = host(tree), status = find(tree, "status");
  f.tick(20);
  status.hidden = false; f.tick(21); f.tick(22);
  assert.deepEqual(f.store.get(ZEN_KEY)[name].visible, [toolbar, "panel"]);
  status.hidden = true; f.tick(23); f.tick(24);
  assert.deepEqual(f.store.get(ZEN_KEY)[name].visible, [toolbar, "panel"]);
  f.apply(); f.tick(25);
  assert(order.every(id => find(tree, id).hidden));
  status.hidden = false; f.tick(26); f.apply(); f.tick(27);
  assert.deepEqual(f.store.get(ZEN_KEY), {});
  assert.equal(find(tree, "sidebar").hidden, true);
  assert.equal(find(tree, "panel").hidden, false);
});

test("unacknowledged commands retry, layout switches isolate state, and checking never writes", () => {
  const tree = fixture({ zen: true }), f = host(tree), status = find(tree, "status");
  f.checkingMode(true); f.tick(1); assert.equal(f.calls.length, 0);
  f.checkingMode(false); f.tick(2); f.tick(2 + ZEN_INTERVAL);
  assert.deepEqual(f.callsFor("layout.hide"), [...order, ...order]);
  f.apply(); f.tick(3 + ZEN_INTERVAL);
  f.store.set("layout", "Other"); status.hidden = false; f.tick(4 + ZEN_INTERVAL);
  assert.equal(f.callsFor("layout.show").length, 0);
  assert.equal(f.store.get(ZEN_KEY)[name].on, true);
  f.store.set("layout", name);
  f.tick(5 + ZEN_INTERVAL); f.tick(5 + 2 * ZEN_INTERVAL);
  assert.deepEqual(f.callsFor("layout.show"), [...order].reverse().concat([...order].reverse()));
  f.apply(); f.tick(6 + 2 * ZEN_INTERVAL);
  assert.deepEqual(f.store.get(ZEN_KEY), {});
});

test("Zen shortcut is platform-specific and respects all four conflict scopes", () => {
  const section = `layout:${name}`, source = { global: { "cmd-p": "app.palette" }, "layout:Other": { "cmd-alt-z": "existing" } };
  for (const [platform, shortcut] of [["darwin", "cmd-alt-z"], ["linux", "ctrl-shift-z"], ["win32", "ctrl-shift-z"]]) {
    const result = zenKeys(source, name, fixture(), platform);
    assert.equal(result.shortcut, shortcut);
    assert.deepEqual(result.keys[section][shortcut], toggle);
    assert.equal(source[section], undefined);
    assert.equal(zenKeys(result.keys, name, fixture(), platform).changed, false);
    assert.equal(zenKeys({ [section]: { [shortcut]: "layout.toggle:status" } }, name, fixture(), platform).changed, false);
    for (const context of ["global", "terminal", section, "mod:sessions-plus"]) {
      const keys = { [context]: { [shortcut]: { command: "layout.toggle", args: { id: "panel" } } } };
      const conflict = zenKeys(keys, name, fixture(), platform);
      assert.deepEqual(conflict, { keys, changed: false, shortcut, conflict: context });
    }
    assert.equal(zenKeys(source, name, fixture({ footer: false }), platform).unavailable, true);
  }
});

test("configure-launcher writes only compatible fixture homes and preserves conflicting keys", t => {
  const home = mkdtempSync(join(tmpdir(), "workspace-zen-")), layouts = join(home, "layouts"), keysFile = join(home, "keys.json");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(layouts);
  const layoutFile = join(layouts, `${name}.json`), section = `layout:${name}`;
  const configure = () => execFileSync(process.execPath, [fileURLToPath(new URL("../configure-launcher.mjs", import.meta.url)), "--home", home], { encoding: "utf8" });
  const keys = () => JSON.parse(readFileSync(keysFile, "utf8"));
  const launchKey = launcherKeys({}, name).shortcut, zenKey = zenKeys({}, name, fixture()).shortcut;
  const layoutText = JSON.stringify(fixture());
  writeFileSync(layoutFile, layoutText); writeFileSync(keysFile, "{}\n");
  assert.match(configure(), /Zen mode:/);
  assert.deepEqual(keys()[section], { [launchKey]: "sessions-plus.launcher", [zenKey]: toggle });
  const bytes = readFileSync(keysFile, "utf8");
  assert.match(configure(), /Zen mode already bound/);
  assert.equal(readFileSync(keysFile, "utf8"), bytes);
  assert.equal(readFileSync(layoutFile, "utf8"), layoutText);
  writeFileSync(keysFile, JSON.stringify({ terminal: { [zenKey]: "terminal" } }));
  const conflict = configure();
  assert.match(conflict, /Zen shortcut already used in terminal/);
  assert.match(conflict, /herdr-app do layout\.show --id status/);
  assert.deepEqual(keys(), { terminal: { [zenKey]: "terminal" }, [section]: { [launchKey]: "sessions-plus.launcher" } });
  writeFileSync(keysFile, JSON.stringify({ global: { [launchKey]: "app.palette" } }));
  assert.match(configure(), /Shortcut already used in global/);
  assert.deepEqual(keys(), { global: { [launchKey]: "app.palette" }, [section]: { [zenKey]: toggle } });
  writeFileSync(layoutFile, JSON.stringify(fixture({ footer: false }))); writeFileSync(keysFile, "{}\n");
  assert.match(configure(), /requires a Sessions Plus status footer/);
  assert.deepEqual(keys()[section], { [launchKey]: "sessions-plus.launcher" });
});

function load(path, exportedClass, deps) {
  const source = readFileSync(new URL(`../mods/${path}.js`, import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace(/\bexport (?=(const|function) )/g, "").replace("export default class", "class");
  return uiFunction(...Object.keys(deps), `${source}\nreturn ${exportedClass};`)(...Object.values(deps));
}

test("a Sessions Plus role defers reconciliation, coalesces renders, and stops on close", async () => {
  const tree = fixture({ zen: true }), f = host(tree), tasks = [];
  const View = load("sessions-plus/main", "SessionsPlus", { ...f, reconcileZen, View: class {}, privacyGuard: () => null });
  const view = new View(), cx = { timer: { after(delay, callback) { assert.equal(delay, 0); tasks.push(callback); } } };
  view.role = { render: () => "role rendered" };
  assert.equal(view.render(cx), "role rendered"); view.render(cx);
  assert.equal(tasks.length, 1); assert.equal(f.calls.length, 0);
  tasks.shift()(); assert.deepEqual(f.callsFor("layout.hide"), order);
  f.apply(); find(tree, "status").hidden = false; view.render(cx); await view.close(cx); tasks.shift()();
  assert.equal(f.callsFor("layout.show").length, 0);
});

test("the hidden footer fallback reconciles separately from the live-sessions poll", async () => {
  const tree = fixture(), f = host(tree), tasks = [], timers = new Map();
  let active = true;
  const Footer = load("sessions-plus/footer", "Footer", { ...f, reconcileZen, ZEN_INTERVAL, AUTO_TITLES_KEY: "titles", privacyEnabled: () => false,
    window: () => ({ active }), StatusBar: class { init() {} }, Resources: class { init() {} } });
  const footer = new Footer(), cx = { timer: { every(ms, callback) { timers.set(ms, callback); } }, spawn(task) { tasks.push(task); } };
  footer.init({}, cx);
  // Run the fallback registration without the live-session poll or key-command loop.
  await tasks[1](cx);
  const tick = timers.get(1000);
  tick(); assert.equal(f.calls.length, 0);
  find(tree, "status").hidden = true; tick(); f.apply(); tick();
  assert.deepEqual(f.callsFor("layout.hide"), order);
  find(tree, "status").hidden = false; tick(); f.apply(); tick();
  assert.deepEqual(f.callsFor("layout.show"), [...order].reverse());
  // Becoming active again refreshes live readings at once instead of waiting for the 20 s poll.
  const ticks = [];
  footer.live.tick = cx => ticks.push(cx);
  active = false; tick(cx); assert.equal(ticks.length, 0);
  active = true; tick(cx); tick(cx); assert.deepEqual(ticks, [cx]);
  footer.close(); find(tree, "status").hidden = true; tick();
  assert.deepEqual(f.callsFor("layout.hide"), order);
});

test("Launch validates Zen against the current layout and toggles the native status node", () => {
  const calls = [], run = (...args) => calls.push(args);
  const bindings = [{ section: "layout:Other", keys: "cmd-alt-x", action: "layout.toggle:status" },
    { section: `layout:${name}`, keys: "cmd-b", action: "layout.toggle:sidebar" }];
  const Launcher = load("sessions-plus/launcher", "Launcher", { ...launcherModel, COMMANDS_KEY, PRESETS_KEY, ZEN_FOOTER,
    run, closeOverlay: id => calls.push(["close", id]), spaces: () => [], agents: () => [], terminals: () => [], shared: () => undefined,
    keys: () => bindings });
  const view = new Launcher(), cx = { notify() {} };
  view.stage = "main"; view.p = { overlay: "launch" }; view.origin = "p1"; view.query = "zen";
  assert.deepEqual(view.rows(), []);
  view.zenLayout = () => name; assert.deepEqual(view.rows(), []);
  bindings.push({ section: `layout:${name}`, keys: "cmd-alt-z", action: JSON.stringify({ args: { id: "status" }, command: "layout.toggle" }) });
  const [row] = view.rows();
  assert.equal(row.title, "Zen mode");
  assert.match(row.detail, /cmd-alt-z/);
  view.zenLayout = () => "Other"; view.activate(row, cx); assert.deepEqual(calls, []);
  assert.match(view.rows()[0].detail, /cmd-alt-x/);
  view.zenLayout = () => name; bindings.pop(); view.activate(row, cx); assert.deepEqual(calls, []);
  bindings.push({ section: `layout:${name}`, keys: "cmd-alt-z", action: "layout.toggle:status" });
  view.activate(row, cx);
  assert.deepEqual(calls, [["pane.focus", { pane: "p1" }], ["close", "launch"], ["layout.toggle", { id: "status" }]]);
});

test("pane header clears macOS traffic lights only for titlebar-none Zen in the current layout", () => {
  const f = host(), w = { platform: "macos", titlebar: "none", fullscreen: false }, config = { zoom: 2 };
  const padding = {}, element = new Proxy({}, { get(_target, key) { return value => { if (key === "pl" || key === "pr") padding[key] = value; return element; }; } });
  const Pane = load("files-plus/pane-header", "PaneHeader", { ...f, window: () => w, settings: () => config, h_flex: () => element });
  const view = new Pane(), left = () => { view.frame({}, { pane: "p1" }); assert.equal(padding.pr, 10); return padding.pl; };
  assert.equal(left(), 10);
  f.store.set(ZEN_KEY, { [name]: { on: true } }); assert.equal(left(), 38);
  f.store.set("layout", "Other"); assert.equal(left(), 10);
  f.store.set("layout", name); w.fullscreen = true; assert.equal(left(), 10);
  w.fullscreen = false; w.titlebar = "system"; assert.equal(left(), 10);
  w.titlebar = "none"; w.platform = "linux"; assert.equal(left(), 10);
});
