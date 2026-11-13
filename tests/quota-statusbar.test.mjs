import { uiFunction } from "./helpers/ui-function.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PROVIDERS } from "../mods/sessions-plus/model.js";
import { claudeWindows, codexWindows, durationLabel, percentage, resetLabel, quotaWarning } from "../mods/sessions-plus/quota-model.js";

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
  return uiFunction(...Object.keys(dependencies), source)(...Object.values(dependencies));
}

const nodes = tree => !tree || typeof tree !== "object" ? [] : [tree, ...tree.childNodes.flatMap(nodes), ...Object.values(tree.slots).flatMap(nodes)];
const find = (tree, id) => nodes(tree).find(node => node.attributes.id === id);
const text = tree => typeof tree === "string" ? tree : (tree?.childNodes ?? []).map(text).join(" ");
const row = (label, used, resetAt = 1800003600000) => ({ label, used, remaining: 100 - used, resetAt, minutes: label.endsWith("7d") ? 10080 : 300 });

function fixture(state = {}) {
  let now = 1800000000000, notifications = 0;
  const calls = [], tasks = [], timers = [], timeouts = [];
  const cx = { notify() { notifications++; }, spawn(task) { tasks.push(task(cx)); }, timer: { every(ms, task) { timers.push({ ms, task }); }, after(ms, task) { timeouts.push({ at: now + ms, task }); } } };
  const dependencies = {
    div: element, svg: element, h_flex: element, v_flex: element,
    Popover: { new: id => element().id(id) },
    theme: () => ({ chrome: "chrome", surface: "surface", selected: "selected", ansi1: "red", ansi3: "yellow", foreground: "white" }),
    window: () => ({ platform: "macos" }), appHome: () => "/fixture/herdr",
    shared: key => state[key], setShared: (key, value) => { state[key] = value; },
    providerIcon: (provider, size) => element().id(`icon-${provider}`).size(size),
    PROVIDERS, durationLabel, percentage, quotaWarning, resetLabel: value => resetLabel(value, now),
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
    tick(ms) {
      now += ms;
      for (let i = timeouts.length - 1; i >= 0; i--) if (timeouts[i].at <= now) timeouts.splice(i, 1)[0].task(cx);
      const timer = timers.find(timer => timer.ms === ms); if (timer) timer.task(cx);
    },
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
  assert.doesNotMatch(remaining.tooltip, /Bar:|lowest remaining window/);
  assert.equal(remaining.tooltip.split("\n").length, 3);
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
  assert.equal(text(find(f.render(), "quota-status-claude")).trim(), "7d 7% 1h 0m");
  assert.match(f.bar.summaries("remaining")[0].tooltip, /Stale/);
  assert.equal(f.bar.summaries("remaining").find(item => item.provider === "codex").text, "∞");
  assert.equal(find(f.render(), "quota-status-agy"), undefined);
  assert.doesNotMatch(text(find(f.render(), "quota-status-trigger")), /Unavailable|NaN/);
});


test("compact strip shows window percentages with countdowns, plus mode, refresh and visibility controls", async () => {
  const f = fixture();
  await f.finish({ claude: { windows: [row("5h", 7, 1800012120000), row("7d", 35, 1800093600000)] } });
  const group = find(f.render(), "quota-status-claude");
  assert.match(text(group), /5h 93% 3h 22m · 7d 65% 1d 2h/);
  assert(find(f.render(), "quota-status-refresh"));
  f.click("quota-status-mode");
  assert.equal(f.state["sessions-plus.quota-mode"], "used");
  assert.match(text(find(f.render(), "quota-status-claude")), /5h 7% 3h 22m · 7d 35% 1d 2h/);
  f.open(true); f.click("quota-agents"); f.click("quota-show-codex");
  assert.equal(find(f.render(), "quota-status-codex"), undefined);
  assert.deepEqual(f.state["sessions-plus.quota-hidden"], ["codex"]);
  assert.equal(f.calls.length, 3);
  f.tick(300000); await f.finish();
  assert.equal(f.calls.length, 5);
});

test("narrow widths retain countdowns and expanding restores percentages without new reads", async () => {
  const f = fixture(); await f.finish();
  // Preserve the HEAD quota-area widths after removing the 60px Privacy control and its gap.
  const resize = baselineWidth => find(f.render(), "quota-statusbar").events.on_size_change({ width: baselineWidth, height: 28 }, f.cx);
  resize(425);
  for (const provider of Object.keys(PROVIDERS)) {
    assert.equal(text(find(f.render(), `quota-status-${provider}`)).trim(), "5h 1h 0m");
  }
  resize(180);
  assert.equal(text(find(f.render(), "quota-status-trigger")).trim(), "Quota");
  assert(find(f.render(), "quota-status-refresh"));
  assert.equal(find(f.render(), "quota-status-settings-trigger"), undefined);
  assert(find(f.render(), "quota-status-popover"));
  resize(1000);
  assert.match(text(find(f.render(), "quota-status-claude")), /5h 75% 1h 0m/);
  assert.equal(f.calls.length, 3);
  const notified = f.notifications();
  resize(1000);
  assert.equal(f.notifications(), notified);
});


test("weekly countdown remains labeled when the five-hour reset is unavailable", async () => {
  const f = fixture({ "sessions-plus.quota-hidden": ["codex", "agy"] });
  await f.finish({ claude: { windows: claudeWindows({
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 35, resets_at: 1800082260000 },
  }) } });
  const group = find(f.render(), "quota-status-claude");
  assert.equal(text(group).trim(), "5h 100% 5h · 7d 65% 22h 51m");
  assert.match(group.attributes.tooltip, /5h: 100% · Reset time unavailable · Showing default 5h/);
  f.tick(60000);
  assert.equal(text(find(f.render(), "quota-status-claude")).trim(), "5h 100% 5h · 7d 65% 22h 50m");
});

test("narrowing hides bars then percentages while retaining both countdowns", async () => {
  const f = fixture({ "sessions-plus.quota-hidden": ["codex", "agy"] });
  await f.finish({ claude: { windows: [row("5h", 7, 1800012120000), row("7d", 35, 1800093600000)] } });
  // Preserve the HEAD quota-area widths after removing the 60px Privacy control and its gap.
  const resize = baselineWidth => find(f.render(), "quota-statusbar").events.on_size_change({ width: baselineWidth, height: 28 }, f.cx);
  const hasBar = () => nodes(find(f.render(), "quota-status-claude")).some(node => node.attributes.w === 32);
  assert(hasBar());
  resize(350);
  assert.equal(hasBar(), false);
  assert.equal(text(find(f.render(), "quota-status-claude")).trim(), "5h 93% 3h 22m · 7d 65% 1d 2h");
  resize(300);
  assert.equal(hasBar(), false);
  assert.equal(text(find(f.render(), "quota-status-claude")).trim(), "5h 3h 22m · 7d 1d 2h");
  resize(1000);
  assert(hasBar());
  assert.equal(f.calls.length, 1);
});


test("a passed reset keeps the reported quota and shows zero remaining time", async () => {
  const f = fixture({ "sessions-plus.quota-hidden": ["codex", "agy"] });
  await f.finish({ claude: { windows: [row("5h", 25, 1799999940000), row("7d", 80, null)] } });
  const group = find(f.render(), "quota-status-claude");
  assert.equal(text(group).trim(), "5h 75% 0m · 7d 20% —");
  assert.match(group.attributes.tooltip, /5h: 75% · Reset time passed/);
  assert.match(group.attributes.tooltip, /7d: 20% · Reset time unavailable/);
});


test("right refresh button starts a real read, spins while pending and re-enables after cooldown", async () => {
  const f = fixture({ "sessions-plus.quota-hidden": ["codex", "agy"] });
  const button = () => find(f.render(), "quota-status-refresh");
  const icon = () => find(f.render(), "quota-status-refresh-icon");
  assert.equal(button().attributes.disabled, true);
  assert.equal(icon().attributes.spin, 850);
  await f.finish();
  const firstUpdated = f.bar.quota.data.claude.updatedAt;
  assert.match(button().attributes.tooltip, /Refresh available in 60s/);
  assert.match(button().attributes.tooltip, /Claude Code: updated/);
  assert.equal(icon().attributes.spin, undefined);
  f.click("quota-status-refresh");
  assert.equal(f.calls.length, 1);
  f.tick(59999);
  assert.equal(button().attributes.disabled, true);
  const notified = f.notifications();
  f.tick(1);
  assert(f.notifications() > notified);
  assert.equal(button().attributes.disabled, false);
  f.click("quota-status-refresh");
  assert.equal(f.calls.length, 2);
  assert.equal(icon().attributes.spin, 850);
  f.click("quota-status-refresh");
  assert.equal(f.calls.length, 2);
  await f.finish();
  assert(f.bar.quota.data.claude.updatedAt > firstUpdated);
  assert.equal(f.bar.quota.data.claude.windows[0].remaining, 75);
  assert.equal(button().attributes.disabled, true);
});

test("right refresh tooltip reports a failed read instead of claiming a new snapshot", async () => {
  const f = fixture({ "sessions-plus.quota-hidden": ["codex", "agy"] });
  await f.finish();
  const firstUpdated = f.bar.quota.data.claude.updatedAt;
  f.tick(60000); f.click("quota-status-refresh");
  await f.finish({ claude: { state: "unavailable", windows: [], message: "Could not reach Claude usage." } });
  assert.equal(f.bar.quota.data.claude.updatedAt, firstUpdated);
  const tooltip = find(f.render(), "quota-status-refresh").attributes.tooltip;
  assert.match(tooltip, /Could not reach Claude usage/);
  assert.doesNotMatch(tooltip, /Claude Code: updated/);
  assert(find(f.render(), "quota-status-warning-claude"));
});


test("failed providers show warning icons beside both readings and update times, then clear on success", async () => {
  const f = fixture({ "sessions-plus.quota-hidden": ["agy"] }); await f.finish();
  const previous = f.bar.quota.data.claude.updatedAt;
  f.tick(60000); f.click("quota-status-refresh");
  await f.finish({ claude: { state: "unavailable", windows: [], message: "Temporary service failure" } });
  const tree = f.render();
  for (const id of ["quota-status-warning-claude", "quota-warning-claude"]) {
    const icon = find(tree, id); assert(icon, id); assert.equal(icon.attributes.size, 13); assert.equal(icon.attributes.text_color, "yellow");
    assert.match(icon.attributes.tooltip, /Temporary service failure/);
  }
  assert(!find(tree, "quota-status-warning-codex")); assert(!find(tree, "quota-warning-codex"));
  assert.equal(f.bar.quota.data.claude.updatedAt, previous); assert.match(text(find(tree, "quota-updated-claude")), /Stale/);
  assert(nodes(find(tree, "quota-updated-claude")).includes(find(tree, "quota-warning-claude")));
  f.tick(60000); f.click("quota-status-refresh"); await f.finish();
  assert(!find(f.render(), "quota-status-warning-claude")); assert(!find(f.render(), "quota-warning-claude"));
});

test("initial query failure remains visible without inventing quota or a successful timestamp", async () => {
  const f = fixture();
  await f.finish({ claude: { state: "unavailable", windows: [], message: "Connection failed" }, codex: { state: "unavailable", windows: [], reason: "signed-out" }, agy: { state: "unavailable", windows: [], reason: "missing-cli" } });
  const tree = f.render();
  assert(find(tree, "quota-status-warning-claude")); assert(find(tree, "quota-warning-claude"));
  assert.equal(text(find(tree, "quota-status-claude")).trim(), "—");
  assert.doesNotMatch(text(find(tree, "quota-card-claude")), /Updated|\d+%/);
  assert.equal(find(tree, "quota-status-codex"), undefined); assert.equal(find(tree, "quota-status-agy"), undefined);
});

test("warning icons have reserved width through full, brief, icon-only, and collapsed layouts", async () => {
  const f = fixture({ "sessions-plus.quota-hidden": ["agy"] });
  await f.finish({ claude: { state: "stale", message: "Claude connection failed", windows: [row("5h", 10), row("7d", 35, 1800093600000)] }, codex: { state: "stale", message: "Codex connection failed", windows: [row("7d", 35, 1800093600000)] } });
  // Preserve the HEAD quota-area widths after removing the 60px Privacy control and its gap.
  const resize = baselineWidth => find(f.render(), "quota-statusbar").events.on_size_change({ width: baselineWidth, height: 28 }, f.cx);
  resize(1000); assert.match(text(find(f.render(), "quota-status-claude")), /90%/);
  resize(450); assert.doesNotMatch(text(find(f.render(), "quota-status-claude")), /%/); assert.match(text(find(f.render(), "quota-status-claude")), /7d 1d 2h/);
  for (const width of [450, 250]) {
    resize(width);
    for (const provider of ["claude", "codex"]) assert(find(f.render(), `quota-status-warning-${provider}`));
  }
  assert.equal(text(find(f.render(), "quota-status-trigger")).trim(), "");
  resize(180); assert.equal(text(find(f.render(), "quota-status-trigger")).trim(), "Quota");
  assert.match(find(f.render(), "quota-status-warning").attributes.tooltip, /Claude connection failed\nCodex: Codex connection failed/);
  assert(find(f.render(), "quota-status-refresh"));
  resize(1000); assert.match(text(find(f.render(), "quota-status-claude")), /90%/); assert.equal(f.calls.length, 2);
});


test("quota popup refresh is an accessible icon with pending and cooldown feedback", async () => {
  const f = fixture({ "sessions-plus.quota-hidden": ["codex", "agy"] });
  assert.equal(text(find(f.render(), "quota-refresh")), "");
  assert.equal(find(f.render(), "quota-refresh-icon").attributes.spin, 850);
  assert.equal(find(f.render(), "quota-refresh").attributes.disabled, true);
  await f.finish();
  assert.equal(find(f.render(), "quota-refresh").attributes.accessibility_label, "Refresh quota");
  assert.match(find(f.render(), "quota-refresh").attributes.tooltip, /60s/);
  f.click("quota-refresh"); assert.equal(f.calls.length, 1);
  f.tick(60000); assert.equal(find(f.render(), "quota-refresh").attributes.disabled, false);
  f.click("quota-refresh"); assert.equal(f.calls.length, 2); await f.finish();
});

test("single Codex tooltip shows its window only once and keeps named quota pools", async () => {
  const f = fixture();
  const windows = codexWindows({ rateLimits: { limitId: "codex", secondary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 1800100000 } } });
  await f.finish({ codex: { windows } });
  const tooltip = f.bar.summaries("remaining").find(item => item.provider === "codex").tooltip;
  assert.equal(tooltip.split("\n").length, 2);
  assert.match(tooltip, /^Codex · Remaining\n7d: 58% · Resets in /);
  assert.equal((tooltip.match(/7d/g) || []).length, 1);
  assert.equal(codexWindows({ rateLimits: { limitName: "Review", primary: { usedPercent: 20, windowDurationMins: 300 } } })[0].label, "Review · 5h");
});


test("the strip reserves measured mode width and reclaims the removed Privacy button's space", () => {
  const f = fixture(); f.bar.width = 500; f.bar.modeWidth = 68;
  const before = f.calls.length;
  assert.equal(find(f.render(), "quota-status-trigger").attributes.max_w, 386);
  assert.equal(find(f.render(), "screenshot-mode-toggle"), undefined);
  find(f.render(), "quota-status-mode").events.on_size_change({ width: 90 }, f.cx);
  assert.equal(find(f.render(), "quota-status-trigger").attributes.max_w, 364);
  assert.equal(f.calls.length, before);
});

test("status labels retain HEAD countdown formatting in remaining and used modes", async () => {
  const f = fixture({ "sessions-plus.quota-hidden": ["agy"] }), now = 1800000000000;
  await f.finish({ claude: { windows: [row("5h", 29, now + 241 * 60000), row("7d", 6, now + 9240 * 60000)] }, codex: { windows: [row("7d", 31, now + 8820 * 60000)] } });
  let tree = f.render(), claude = find(tree, "quota-status-claude"), codex = find(tree, "quota-status-codex");
  assert.equal(text(claude).trim(), "5h 71% 4h 1m · 7d 94% 6d 10h");
  assert.equal(text(codex).trim(), "7d 69% 6d 3h");
  assert.match(claude.attributes.tooltip, /Claude Code · Remaining/); assert.match(claude.attributes.tooltip, /5h: 71%.*Resets in/); assert.match(codex.attributes.tooltip, /7d: 69%.*Resets in/);
  f.click("quota-status-mode"); tree = f.render();
  assert.equal(text(find(tree, "quota-status-claude")).trim(), "5h 29% 4h 1m · 7d 6% 6d 10h");
  assert.equal(text(find(tree, "quota-status-codex")).trim(), "7d 31% 6d 3h");
  assert.match(find(tree, "quota-status-claude").attributes.tooltip, /Claude Code · Used/);
  assert.doesNotMatch(text(find(tree, "quota-status-trigger")), /used/); assert.equal(f.calls.length, 2);
});

test("HEAD progress bars remain one 32px strip bar and one full-width detail bar per metered window", async () => {
  const f = fixture({ "sessions-plus.quota-hidden": ["codex", "agy"] });
  await f.finish({ claude: { windows: [row("5h", 10), row("7d", 80)] } });
  let tree = f.render(), bars = nodes(find(tree, "quota-status-claude")).filter(node => node.attributes.w === 32 && node.attributes.h === 5);
  assert.equal(bars.length, 1); assert.equal(bars[0].attributes.min_w, undefined); assert.equal(bars[0].childNodes[0].attributes.w, "20%");
  let details = nodes(find(tree, "quota-card-claude")).filter(node => Object.hasOwn(node.attributes, "w_full") && node.attributes.h === 5);
  assert.equal(details.length, 2); assert(details.every(node => node.attributes.min_w === undefined));
  assert.match(text(find(tree, "quota-card-claude")), /Resets in/); assert.match(text(find(tree, "sessions-quota")), /Local accounts · Refreshes every 5 min/);
  assert.equal(find(tree, "quota-refresh").attributes.tooltip, "Refresh available in 60s");
  f.click("quota-status-mode"); tree = f.render();
  bars = nodes(find(tree, "quota-status-claude")).filter(node => node.attributes.w === 32 && node.attributes.h === 5);
  assert.equal(bars[0].childNodes[0].attributes.w, "80%");
  details = nodes(find(tree, "quota-card-claude")).filter(node => Object.hasOwn(node.attributes, "w_full") && node.attributes.h === 5);
  assert.deepEqual(details.map(node => node.childNodes[0].attributes.w), ["10%", "80%"]); assert.equal(f.calls.length, 1);
});

test("full Remaining and Used labels still toggle from the strip and details without a Privacy control", async () => {
  const f = fixture(); await f.finish(); let tree = f.render(); const before = f.calls.length;
  assert.equal(text(find(tree, "quota-status-mode")), "Remaining"); assert.equal(find(tree, "quota-status-mode").attributes.h, 24);
  assert.equal(find(tree, "screenshot-mode-toggle"), undefined); assert.doesNotMatch(text(find(tree, "quota-statusbar")), /Privacy/);
  f.click("quota-status-mode"); tree = f.render(); assert.equal(text(find(tree, "quota-status-mode")), "Used"); assert.equal(f.state["sessions-plus.quota-mode"], "used");
  f.open(true); f.click("quota-remaining"); assert.equal(text(find(f.render(), "quota-status-mode")), "Remaining");
  f.click("quota-used"); assert.equal(text(find(f.render(), "quota-status-mode")), "Used"); assert.equal(f.calls.length, before);
});

test("every remaining clickable quota strip control shares centered 24px height and 16px line height", async () => {
  const f = fixture(); await f.finish(); const tree = f.render();
  for (const id of ["quota-status-trigger", "quota-status-mode", "quota-status-claude", "quota-status-codex", "quota-status-agy", "quota-status-refresh"]) {
    const control = find(tree, id); assert(control, id); assert(Object.hasOwn(control.attributes, "items_center"), id); assert.equal(control.attributes.h ?? control.attributes.size, 24, id); assert.equal(control.attributes.line_height, "16px", id);
  }
  for (const provider of Object.keys(PROVIDERS)) {
    const group = find(tree, "quota-status-" + provider), label = find(tree, "quota-status-label-" + provider), bar = nodes(group).find(node => node.attributes.w === 32 && node.attributes.h === 5);
    assert(Object.hasOwn(label.attributes, "items_center")); assert.equal(label.attributes.line_height, "16px"); assert.equal(label.attributes.h, 24); assert(bar); assert(group.childNodes.includes(find(tree, "icon-" + provider)));
  }
});
