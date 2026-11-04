import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PROVIDERS } from "../mods/sessions-plus/model.js";
import { percentage, resetLabel } from "../mods/sessions-plus/quota-model.js";

function element() {
  const node = { childNodes: [], attributes: {}, events: {}, slots: {} };
  const proxy = new Proxy(node, { get(target, name) {
    if (name === "child") return child => { target.childNodes.push(child); return proxy; };
    if (name === "children") return children => { target.childNodes.push(...children); return proxy; };
    if (name === "trigger" || name === "content") return child => { target.slots[name] = child; return proxy; };
    if (name === "when") return (condition, callback) => condition ? callback(proxy) : proxy;
    if (name.startsWith("on_")) return callback => { target.events[name] = callback; return proxy; };
    if (name in target) return target[name];
    return value => { target.attributes[name] = value; return proxy; };
  } });
  return proxy;
}

function view(name, dependencies) {
  const source = readFileSync(new URL(`../mods/sessions-plus/${name}.js`, import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  return new Function(...Object.keys(dependencies), source)(...Object.values(dependencies));
}

const nodes = tree => !tree || typeof tree !== "object" ? [] : [tree, ...tree.childNodes.flatMap(nodes), ...Object.values(tree.slots).flatMap(nodes)];
const find = (tree, id) => nodes(tree).find(node => node.attributes.id === id);
const text = tree => typeof tree === "string" ? tree : (tree?.childNodes ?? []).map(text).join(" ");
const row = (label, used, resetAt = 1800003600000) => ({ label, used, remaining: 100 - used, resetAt });

function fixture(state = {}) {
  let now = 1800000000000, notifications = 0;
  const calls = [], tasks = [], timers = [];
  const cx = { notify() { notifications++; }, spawn(task) { tasks.push(task(cx)); }, timer: { every(ms, task) { timers.push({ ms, task }); } } };
  const dependencies = {
    div: element, svg: element, h_flex: element, v_flex: element,
    Popover: { new: id => element().id(id) },
    theme: () => ({ chrome: "chrome", surface: "surface", selected: "selected", ansi1: "red", ansi3: "yellow", foreground: "white" }),
    window: () => ({ platform: "macos" }), appHome: () => "/fixture/herdr",
    shared: key => state[key], setShared: (key, value) => { state[key] = value; },
    providerIcon: (provider, size) => element().id(`icon-${provider}`).size(size),
    PROVIDERS, percentage, resetLabel,
    Date: class extends Date { static now() { return now; } },
    exec: (program, args) => new Promise(resolve => calls.push({ program, args, provider: args[1], resolve })),
  };
  dependencies.Quota = view("quota", dependencies);
  const StatusBar = view("statusbar", dependencies);
  const bar = new StatusBar(); bar.init({ node: "/fixture/node", stores: { claude: "/fixture/claude" } }, cx);
  return {
    bar, calls, state, timers, cx, render: () => bar.render(cx), notifications: () => notifications,
    click(id) { const control = find(bar.render(cx), id); assert(control, id); control.events.on_click({}, cx); },
    open(value) { find(bar.render(cx), "quota-status-popover").events.on_open_change(value, cx); },
    tick(ms) { now += ms; const timer = timers.find(timer => timer.ms === ms); if (timer) timer.task(cx); },
    async finish(overrides = {}) {
      for (const call of calls) call.resolve({ code: 0, stdout: JSON.stringify({ provider: call.provider, state: "ok", updatedAt: now,
        windows: [row(`${call.provider} 5h`, 25)], ...overrides[call.provider] }) });
      await Promise.all(tasks);
    },
  };
}

test("status bar shows only available unhidden accounts and keeps an empty Status control accessible", async () => {
  const f = fixture({ "sessions-plus.quota-hidden": ["codex"] });
  assert.deepEqual(f.calls.map(call => call.provider), ["claude", "agy"]);
  assert.equal(find(f.render(), "quota-status-claude"), undefined);
  assert.equal(find(f.render(), "quota-status-settings-trigger"), undefined);
  assert(find(f.render(), "quota-status-popover"));
  await f.finish({ agy: { state: "unavailable", windows: [], reason: "missing-cli" } });
  assert(find(f.render(), "quota-status-claude"));
  assert.equal(find(f.render(), "quota-status-codex"), undefined);
  assert.equal(find(f.render(), "quota-status-agy"), undefined);
  assert.doesNotMatch(text(find(f.render(), "quota-status-trigger")), /Unavailable/);
  f.click("quota-agents"); f.click("quota-show-claude");
  assert.deepEqual(f.bar.summaries("remaining"), []);
  assert.equal(text(find(f.render(), "quota-status-trigger")).trim(), "Quota");
  assert.equal(find(f.render(), "quota-status-settings-trigger"), undefined);
  assert(find(f.render(), "quota-status-popover"));
  f.open(true);
  assert.match(text(find(f.render(), "quota-cards")), /No account quota/);
  f.click("quota-show-agy");
  assert.match(text(find(f.render(), "quota-cards")), /All agents are hidden/);
  assert(find(f.render(), "quota-show-claude"));
});

test("multi-window summary selects the lowest remaining window and the mode changes that same reading", async () => {
  const f = fixture();
  const windows = [row("5h", 10), row("7d", 80)];
  await f.finish({ claude: { windows } });
  const remaining = f.bar.summaries("remaining").find(item => item.provider === "claude");
  assert.equal(remaining.text, "20%"); assert.equal(remaining.row.label, "7d");
  assert.match(remaining.tooltip, /lowest remaining window \(7d\)/);
  assert.match(remaining.tooltip, /5h: 90%.*Resets/);
  assert.match(remaining.tooltip, /7d: 20%.*Resets/);
  f.click("quota-used");
  assert.equal(f.bar.summaries("used").find(item => item.provider === "claude").text, "80%");
  assert.equal(text(find(f.render(), "quota-status-mode")), "Used");
  assert.deepEqual(f.bar.quota.data.claude.windows, windows);
});

test("opening and rerendering the Popover reuse the existing in-memory reader and controls", async () => {
  const f = fixture(); await f.finish();
  const quota = f.bar.quota;
  f.open(true); f.render(); f.open(false); f.open(true); f.render();
  assert.equal(f.bar.quota, quota);
  assert.equal(f.calls.length, 3);
  const popover = find(f.render(), "quota-status-popover");
  assert.equal(popover.attributes.anchor, "bottom_right");
  assert.equal(popover.attributes.open, true);
  assert.equal(find(f.render(), "quota-statusbar").attributes.min_w, 0);
  assert.equal(typeof popover.slots.content, "object");
  f.click("quota-agents"); f.click("quota-show-codex");
  assert.equal(find(f.render(), "quota-status-codex"), undefined);
  assert.deepEqual(f.state["sessions-plus.quota-hidden"], ["codex"]);
  assert.deepEqual(Object.keys(f.state), ["sessions-plus.quota-hidden"]);
});

test("short timer only redraws, automatic quota polling respects hidden agents and cooldown", async () => {
  const f = fixture(); await f.finish();
  assert.deepEqual(f.timers.map(timer => timer.ms).sort((a, b) => a - b), [30000, 300000]);
  const before = f.notifications();
  f.tick(30000);
  assert.equal(f.calls.length, 3); assert(f.notifications() > before);
  f.click("quota-agents"); f.click("quota-show-agy");
  f.tick(300000); await f.finish();
  assert.deepEqual(f.calls.map(call => call.provider), ["claude", "codex", "agy", "claude", "codex"]);
  f.click("quota-refresh");
  assert.equal(f.calls.length, 5);
  assert.match(text(find(f.render(), "sessions-quota")), /Refreshes every 5 min/);
  assert.doesNotMatch(text(find(f.render(), "sessions-quota")), /while Status is shown/);
});

test("stale, unmetered and malformed readings remain distinct without inventing percentages", async () => {
  const f = fixture();
  await f.finish({ claude: { state: "stale", windows: [row("7d", 93)] },
    codex: { windows: [{ label: "Unlimited", unlimited: true, used: null, remaining: null }] },
    agy: { windows: [{ label: "Unknown", used: null, remaining: null }] } });
  assert.equal(text(find(f.render(), "quota-status-claude")).trim(), "7% 1h 0m *");
  assert.match(f.bar.summaries("remaining")[0].tooltip, /Stale reading/);
  assert.equal(f.bar.summaries("remaining").find(item => item.provider === "codex").text, "∞");
  assert.equal(find(f.render(), "quota-status-agy"), undefined);
  assert.doesNotMatch(text(find(f.render(), "quota-status-trigger")), /Unavailable|NaN/);
});


test("compact strip shows window percentages with countdowns, plus mode, refresh and visibility controls", async () => {
  const f = fixture();
  await f.finish({ claude: { windows: [row("5h", 7, 1800012120000), row("7d", 35, 1800093600000)] } });
  const group = find(f.render(), "quota-status-claude");
  assert.match(text(group), /93% 3h 22m · 65% 1d 2h/);
  assert(find(f.render(), "quota-status-refresh"));
  f.click("quota-status-mode");
  assert.equal(f.state["sessions-plus.quota-mode"], "used");
  assert.match(text(find(f.render(), "quota-status-claude")), /7% 3h 22m · 35% 1d 2h/);
  f.open(true); f.click("quota-agents"); f.click("quota-show-codex");
  assert.equal(find(f.render(), "quota-status-codex"), undefined);
  assert.deepEqual(f.state["sessions-plus.quota-hidden"], ["codex"]);
  assert.equal(f.calls.length, 3);
  f.tick(300000); await f.finish();
  assert.equal(f.calls.length, 5);
});

test("narrow widths retain whole percentages and expanding restores countdowns without new reads", async () => {
  const f = fixture(); await f.finish();
  const resize = width => find(f.render(), "quota-statusbar").events.on_size_change({ width, height: 28 }, f.cx);
  resize(360);
  for (const provider of Object.keys(PROVIDERS)) {
    assert.equal(text(find(f.render(), `quota-status-${provider}`)).trim(), "75%");
  }
  resize(180);
  assert.equal(text(find(f.render(), "quota-status-trigger")).trim(), "Quota");
  assert(find(f.render(), "quota-status-refresh"));
  assert.equal(find(f.render(), "quota-status-settings-trigger"), undefined);
  assert(find(f.render(), "quota-status-popover"));
  resize(1000);
  assert.match(text(find(f.render(), "quota-status-claude")), /75% 1h 0m/);
  assert.equal(f.calls.length, 3);
  const notified = f.notifications();
  resize(1000);
  assert.equal(f.notifications(), notified);
});
