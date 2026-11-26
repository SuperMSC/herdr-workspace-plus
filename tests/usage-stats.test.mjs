import { uiFunction } from "./helpers/ui-function.mjs";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PROVIDERS, UUID, sessionKey } from "../mods/sessions-plus/model.js";
import { PRICES, priceFor, eventCost, normalizeModel } from "../mods/sessions-plus/usage-pricing.js";
import * as usageModel from "../mods/sessions-plus/usage-model.js";
import { collectUsage, collectUsageWithAccount, projectRoots } from "../mods/sessions-plus/usage-stats.mjs";
import { launcherRows } from "../mods/sessions-plus/launcher-model.js";

const { claudeRecord, codexRecord, freshState, summarize, rangeStarts, formatTokens, formatUsd, formatCount, usageResult, withAccountUsage } = usageModel;

test("plan value uses the full monthly price or the prorated seven-day price and requires complete pricing", () => {
  const { planMultiple, planPrice } = usageModel;
  const values = { cost: 42, monthlyPrice: 10, range: "month", unpricedTokens: 0 };
  const pick = result => result && { value: result.value, floor: result.floor };
  assert.deepEqual(pick(planMultiple(values)), { value: 4.2, floor: false });
  assert.deepEqual(pick(planMultiple({ ...values, range: "7d", cost: 10 * (7 / 30.4375) * 2 })), { value: 2, floor: false });
  assert.deepEqual(pick(planMultiple({ ...values, cost: 0 })), { value: 0, floor: false });
  // Partial reads and unpriced models (e.g. codex-auto-review) make the priced part a lower bound, not a reason to hide it.
  assert.deepEqual(pick(planMultiple({ ...values, partial: true })), { value: 4.2, floor: true });
  assert.deepEqual(pick(planMultiple({ ...values, unpricedTokens: 100 })), { value: 4.2, floor: true });
  assert.equal(planMultiple({ ...values, range: "7d", cost: 3 }).plan, 10 * 7 / 30.4375);
  // Light use reads as a share of the plan instead of "0.0×".
  assert.equal(usageModel.planLabel({ value: 4.2, floor: false }), "≈ 4.2× plan");
  assert.equal(usageModel.planLabel({ value: 12.34, floor: false }), "≈ 12× plan");
  assert.equal(usageModel.planLabel({ value: 2.95 / 200, floor: true }), "≥ 1.5% of plan");
  assert.equal(usageModel.planLabel({ value: 0.42, floor: false }), "≈ 42% of plan");
  assert.equal(usageModel.planLabel({ value: 0.0004, floor: true }), "≥ 0.04% of plan");
  assert.equal(planMultiple({ ...values, cost: 0, unpricedTokens: 100 }), null);
  for (const monthlyPrice of [undefined, null, "", 0, -20, 100001, Infinity, "0xff", true]) assert.equal(planMultiple({ ...values, monthlyPrice }), null);
  assert.equal(planPrice(" 100000 "), 100000);
  assert.equal(planPrice("19.95"), 19.95);
});
const NOW = new Date(2026, 10, 22, 15, 0, 0).getTime();
const at = (day, hour = 12) => new Date(2026, 10, day, hour, 0, 0).toISOString();
const claudeId = "11111111-2222-4333-8444-555555555555", codexId = "01a201b3-53ec-7ab1-8e1c-aa938f23115c";

function assistant({ id = "msg_1", request = "req_1", model = "claude-opus-5-5", day = 22, usage = {}, session = claudeId, sidechain = false } = {}) {
  return { type: "assistant", isSidechain: sidechain, sessionId: session, cwd: "/work/app", timestamp: at(day), requestId: request,
    message: { id, model, usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 }, ...usage } } };
}
const usageRecord = (response, turn, usage, day = 22) => ({ timestamp: at(day), type: "token_usage_record", payload: { response_id: response, turn_id: turn, session_id: codexId, usage } });

test("prices match the longest model prefix and price cache writes, fast mode and long prompts", () => {
  assert.equal(priceFor("claude", "claude-opus-5-5").key, "claude-opus-5-5");
  assert.equal(priceFor("claude", "claude-opus-5").key, "claude-opus-5");
  assert.equal(priceFor("claude", "claude-opus-4-5-20251101").key, "claude-opus-4-5");
  assert.equal(priceFor("claude", "claude-sonnet-4-6[1m]").key, "claude-sonnet-4-6");
  assert.equal(priceFor("codex", "gpt-6.2-astra").key, "gpt-6.2-astra");
  assert.equal(priceFor("codex", "codex-auto-review"), null);
  assert.equal(normalizeModel("anthropic.claude-haiku-4-5@20251001"), "claude-haiku-4-5");
  // Opus 5.5: 1M uncached in, 1M out, 1M cache read, 1M 5-minute and 1M 1-hour writes.
  assert.equal(eventCost("claude", { m: "claude-opus-5-5", i: 1e6, o: 1e6, r: 1e6, w5: 1e6, w1: 1e6 }), 4 + 20 + 0.2 + 5 + 8);
  assert.equal(eventCost("claude", { m: "claude-opus-5-5", o: 1e6, f: 1 }), 40);
  // Haiku 5.5 switches rate cards above a 100K-token prompt.
  assert.equal(eventCost("claude", { m: "claude-haiku-5-5", i: 1e5 }), 0.01);
  assert.equal(eventCost("claude", { m: "claude-haiku-5-5", i: 1e5 + 1e5 }), 0.1);
  // Codex: the whole request takes long-context rates above 272K input tokens.
  assert.equal(eventCost("codex", { m: "gpt-6.2-sol", i: 100000, r: 100000, o: 10000, p: 200000 }), (100000 * 2 + 100000 * 0.1 + 10000 * 10) / 1e6);
  assert.equal(eventCost("codex", { m: "gpt-6.2-sol", i: 200000, r: 100000, o: 10000, p: 300000 }), (200000 * 4 + 100000 * 0.2 + 10000 * 15) / 1e6);
  assert.equal(eventCost("codex", { m: "unknown-model", i: 5 }), null);
  for (const table of Object.values(PRICES)) for (const price of Object.values(table)) for (const field of ["input", "output", "cacheRead", "write5m", "write1h"]) assert(Number.isFinite(price[field]) && price[field] >= 0);
});

test("Claude records keep the final counts of a message, skip synthetic turns and keep no message text", () => {
  const state = freshState();
  claudeRecord({ type: "user", sessionId: claudeId, cwd: "/work/app", message: { content: "Add usage stats" } }, state);
  claudeRecord(assistant({ usage: { output_tokens: 5 } }), state);
  claudeRecord(assistant({ usage: { output_tokens: 100 } }), state);
  claudeRecord(assistant({ id: "msg_x", model: "<synthetic>" }), state);
  claudeRecord(assistant({ id: "msg_2", request: "req_2", usage: { speed: "fast", cache_creation: undefined, cache_creation_input_tokens: 50 } }), state);
  claudeRecord({ type: "ai-title", aiTitle: "Usage stats" }, state);
  assert.doesNotMatch(JSON.stringify(state), /Add usage stats|Usage stats/);
  assert.equal(state.events.length, 3);
  assert.equal(state.events[2].f, 1); assert.equal(state.events[2].w5, 50); assert.equal(state.events[2].w1, 0);
  const result = summarize([{ provider: "claude", store: "/store", events: state.events, meta: state }], { now: NOW, titles: new Map([[`claude:${claudeId}`, "Usage stats"]]) });
  const week = result.ranges["7d"].providers.claude;
  assert.equal(week.requests, 2, "content-block duplicates collapse to one request");
  assert.equal(week.tokens.output, 200, "the largest count of a duplicated message wins");
  assert.equal(week.sessions, 1);
  assert.equal(result.ranges["7d"].sessions[0].title, "Usage stats");
});

test("Codex per-request records use their turn's model and tier; cumulative readings are only a fallback", () => {
  const state = freshState();
  codexRecord({ type: "session_meta", payload: { id: codexId, cwd: "/work/api", source: "cli" } }, state);
  codexRecord({ type: "turn_context", payload: { turn_id: "t1", model: "gpt-6.2-sol", service_tier: "default" } }, state);
  codexRecord({ type: "turn_context", payload: { turn_id: "t2", model: "gpt-6.2-astra" } }, state);
  codexRecord({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "priority" } } }, state);
  codexRecord(usageRecord("resp_1", "t1", { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 }), state);
  codexRecord({ timestamp: at(22), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, total_tokens: 1050 } } } }, state);
  codexRecord(usageRecord("resp_1", "t1", { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50 }), state);
  const [first] = state.events;
  assert.deepEqual([first.m, first.i, first.r, first.o, first.p, first.f], ["gpt-6.2-sol", 400, 600, 50, 1000, 1]);
  const result = summarize([{ provider: "codex", store: "/codex", events: state.events, meta: state }], { now: NOW });
  const codex = result.ranges.month.providers.codex;
  assert.equal(result.ranges.month.sessions[0].title, `Codex ${codexId.slice(0, 8)}`, "an untitled session is named by its ID");
  assert.equal(codex.requests, 1, "replayed response IDs and cumulative readings are not counted again");
  assert.equal(codex.cost, eventCost("codex", first));

  const old = freshState();
  codexRecord({ type: "session_meta", payload: { id: codexId, cwd: "/work/api", source: { subagent: "review" } } }, old);
  codexRecord({ type: "turn_context", payload: { model: "gpt-6-sol" } }, old);
  for (const [input, output] of [[100, 10], [100, 10], [300, 30]]) codexRecord({ timestamp: at(21), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, total_tokens: input + output } } } }, old);
  const fallback = summarize([{ provider: "codex", store: "/codex", events: old.events, meta: old }], { now: NOW }).ranges["7d"].providers.codex;
  assert.equal(fallback.tokens.input, 300); assert.equal(fallback.tokens.output, 30); assert.equal(fallback.requests, 2);
  assert.equal(fallback.sessions, 0, "review sessions add tokens but are not counted as sessions");
});

test("ranges, daily buckets and projects; only Claude Code and Codex are reported", () => {
  const starts = rangeStarts(NOW);
  assert.equal(new Date(starts["7d"]).getDate(), 16); assert.equal(new Date(starts.month).getDate(), 1);
  const events = [assistant({ id: "a", day: 22 }), assistant({ id: "b", day: 15 }), assistant({ id: "c", day: 2 }), assistant({ id: "d", day: 20, session: "other", model: "mystery-model" })]
    .map(record => { const state = freshState(); claudeRecord(record, state); return state.events[0]; });
  const result = summarize([{ provider: "claude", store: "/store", events, meta: { sessionId: claudeId, cwd: "/work/app/src", title: {} } }],
    { now: NOW, projectOf: cwd => cwd.replace(/\/src$/, "") });
  assert.equal(result.days.length, 30); assert.equal(result.days.at(-1).date, "2026-11-22");
  assert.equal(result.ranges["7d"].providers.claude.requests, 2);
  assert.equal(result.ranges.month.providers.claude.requests, 4);
  assert.deepEqual(Object.keys(result.ranges["7d"].providers), ["claude", "codex"]);
  assert.deepEqual(result.unpriced, ["Claude Code · mystery-model"]);
  assert(result.ranges["7d"].providers.claude.unpricedTokens > 0);
  assert.equal(result.ranges.month.projects[0].cwd, "/work/app");
  assert.equal(result.ranges.month.projects[0].sessions, 2);
  assert.equal(result.days.find(day => day.date === "2026-11-15").providers.claude.requests, 1);
  assert.doesNotThrow(() => usageResult(result));
  assert.throws(() => usageResult({ ranges: {} }), /invalid/);
  assert.deepEqual([formatTokens(999), formatTokens(17029), formatTokens(6364000), formatTokens(2680273389)], ["999", "17K", "6.36M", "2.68B"]);
  assert.deepEqual([formatUsd(0), formatUsd(0.004), formatUsd(12.345), formatUsd(1968.5), formatCount(1234567)], ["$0", "<$0.01", "$12.35", "$1,969", "1,234,567"]);
});

test("the reader resumes appended logs from its private cache and ignores a partial last line", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-stats-test-"));
  try {
    const claudeStore = join(root, "claude"), codexStore = join(root, "codex"), appHome = join(root, "herdr");
    mkdirSync(join(claudeStore, "projects", "-work-app", claudeId, "subagents"), { recursive: true });
    mkdirSync(join(codexStore, "sessions", "2026", "11", "22"), { recursive: true }); mkdirSync(appHome);
    mkdirSync(join(root, "repo", ".git"), { recursive: true }); mkdirSync(join(root, "repo", "pkg"));
    const main = join(claudeStore, "projects", "-work-app", `${claudeId}.jsonl`), sub = join(claudeStore, "projects", "-work-app", claudeId, "subagents", "agent-1.jsonl");
    const rollout = join(codexStore, "sessions", "2026", "11", "22", `rollout-2026-11-22T10-00-00-${codexId}.jsonl`);
    const line = value => JSON.stringify(value) + "\n";
    writeFileSync(main, line({ type: "custom-title", customTitle: "Stats work" }) + line(assistant()));
    writeFileSync(sub, line(assistant({ id: "msg_sub", request: "req_sub", sidechain: true, model: "claude-haiku-5-5" })));
    writeFileSync(rollout, line({ timestamp: at(22), type: "session_meta", payload: { id: codexId, cwd: join(root, "repo", "pkg"), source: "cli" } })
      + line({ timestamp: at(22), type: "turn_context", payload: { turn_id: "t1", model: "gpt-6.2-sol" } })
      + line(usageRecord("resp_1", "t1", { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 10 })));
    writeFileSync(join(codexStore, "session_index.jsonl"), line({ id: codexId, thread_name: "Indexed title" }));
    const options = { now: NOW, appHome, home: root, stores: { claude: claudeStore, codex: codexStore, agy: join(root, "agy") } };
    const first = collectUsage(options);
    assert.equal(first.ranges["7d"].sessions.find(s => s.provider === "claude").title, "Stats work");
    assert.equal(first.ranges["7d"].providers.claude.requests, 2);
    assert.equal(first.ranges["7d"].providers.claude.sessions, 1, "subagent requests belong to their parent session");
    assert.equal(first.ranges["7d"].providers.codex.requests, 1);
    assert.equal(first.ranges["7d"].sessions.find(s => s.provider === "codex").title, "Indexed title");
    assert(first.ranges["7d"].projects.some(project => project.cwd === join(root, "repo")), "folders group under their Git checkout");
    assert.equal(first.cached, true);
    const cache = join(appHome, "data", "usage-stats", "cache-v1.json");
    assert.equal(statSync(cache).mode & 0o777, 0o600); assert.equal(statSync(join(appHome, "data", "usage-stats")).mode & 0o777, 0o700);
    assert.doesNotMatch(readFileSync(cache, "utf8"), /Stats work|Indexed title|base_instructions/);

    const partial = `{"timestamp":"${at(22)}","type":"token_usage_record","payload":{"response_id":"resp_3",`;
    appendFileSync(rollout, line(usageRecord("resp_2", "t1", { input_tokens: 2000, cached_input_tokens: 1000, output_tokens: 20 })) + partial);
    const second = collectUsage(options);
    assert.equal(second.ranges["7d"].providers.codex.requests, 2);
    const entry = JSON.parse(readFileSync(cache, "utf8")).files[rollout];
    assert.equal(entry.offset, statSync(rollout).size - partial.length, "an unfinished line is read on the next run");
    // The completed line is parsed from its start, not from the middle.
    appendFileSync(rollout, `"turn_id":"t1","usage":{"input_tokens":5,"output_tokens":5}}}\n`);
    const third = collectUsage(options);
    assert.equal(third.ranges["7d"].providers.codex.requests, 3);

    // An old file outside every range is neither read nor kept.
    const stale = join(claudeStore, "projects", "-work-app", "22222222-2222-4333-8444-555555555555.jsonl");
    writeFileSync(stale, line(assistant({ id: "old", day: 1 }))); const old = new Date(2026, 8, 1); utimesSync(stale, old, old);
    collectUsage(options);
    assert.equal(JSON.parse(readFileSync(cache, "utf8")).files[stale], undefined);
    assert.equal(collectUsage({ ...options, cache: false }).cached, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("project roots stop at the nearest Git checkout and fall back to the folder", () => {
  const root = mkdtempSync(join(tmpdir(), "usage-roots-test-"));
  try {
    mkdirSync(join(root, "a", ".git"), { recursive: true }); mkdirSync(join(root, "a", "b", "c"), { recursive: true }); mkdirSync(join(root, "plain"));
    const of = projectRoots();
    assert.equal(of(join(root, "a", "b", "c")), join(root, "a"));
    assert.equal(of(join(root, "plain")), join(root, "plain"));
    assert.equal(of(""), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
const nodes = tree => !tree || typeof tree !== "object" ? [] : [tree, ...tree.childNodes.flatMap(nodes), ...Object.values(tree.slots).flatMap(nodes)];
const find = (tree, id) => nodes(tree).find(node => node.attributes.id === id);
const text = tree => typeof tree === "string" ? tree : (tree?.childNodes ?? []).map(text).join(" ");
function view(name, dependencies) {
  const source = readFileSync(new URL(`../mods/sessions-plus/${name}.js`, import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace(/export const [A-Z_]+ = .*;\n/g, "").replace("export default class", "return class");
  return uiFunction(...Object.keys(dependencies), source)(...Object.values(dependencies));
}
function sample() {
  const state = freshState();
  claudeRecord(assistant(), state);
  const codex = freshState();
  codexRecord({ type: "session_meta", payload: { id: codexId, cwd: "/work/api", source: "cli" } }, codex);
  codexRecord({ type: "turn_context", payload: { turn_id: "t1", model: "codex-auto-review" } }, codex);
  codexRecord(usageRecord("resp_1", "t1", { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 10 }), codex);
  return { ...summarize([{ provider: "claude", store: "/store/claude", events: state.events, meta: state }, { provider: "codex", store: "/store/codex", events: codex.events, meta: codex }], { now: NOW }), pricingDate: "2026-11-22" };
}
function uiFixture(data = sample()) {
  const calls = [], overlays = [], tasks = [], state = {};
  const cx = { notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }), timer: { every() {}, after() {} }, spawn(task) { tasks.push(task(cx)); } };
  globalThis.window = { viewport_size: () => ({ width: 1200, height: 900 }) };
  const deps = { ...usageModel, div: element, svg: element, h_flex: element, v_flex: element, Popover: { new: id => element().id(id) },
    theme: () => ({ surface: "surface", selected: "selected", foreground: "white", muted: "muted", dim: "dim", accent: "accent", ansi3: "yellow", border: "border", raised: "raised", hover: "hover" }),
    window: () => ({ platform: "macos" }), appHome: () => "/fixture/herdr", settings: () => ({ zoom: 1 }),
    shared: key => state[key], setShared: (key, value) => { state[key] = value; }, USAGE_RANGE_KEY: "sessions-plus.usage-range",
    openOverlay: value => overlays.push(value), closeOverlay: value => overlays.push({ closed: value }),
    providerIcon: provider => element().id(`icon-${provider}`), PROVIDERS, UUID, sessionKey,
    exec: async (program, args, options) => { calls.push({ program, args, options }); return { code: 0, stdout: JSON.stringify(data) }; } };
  return { calls, overlays, tasks, state, cx, deps, settle: () => Promise.all(tasks) };
}

test("the quota popover gains a Stats page that reads usage once and opens the full dialog", async () => {
  const f = uiFixture(), deps = { ...f.deps };
  deps.UsageStats = view("usage-stats", deps);
  deps.Quota = class { init() { this.data = {}; this.pending = new Set(); this.started = {}; } visibleProviders() { return []; } refresh() {} render() { return element().id("quota-body"); } };
  Object.assign(deps, { durationLabel: () => "", percentage: () => "", resetLabel: () => "", quotaWarning: () => "", quotaPace: () => null, paceLabel: () => "" });
  const StatusBar = view("statusbar", deps), bar = new StatusBar(); bar.init({ node: "/fixture/node", stores: { claude: "/c" } }, f.cx);
  let tree = bar.render(f.cx);
  assert(find(tree, "quota-body")); assert(find(tree, "quota-popover-page-stats"));
  find(tree, "quota-popover-page-stats").events.on_click({}, f.cx); await f.settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args[0], "/fixture/herdr/mods/sessions-plus/usage-stats.mjs");
  assert.deepEqual(JSON.parse(f.calls[0].args[1]), { stores: { claude: "/c" }, appHome: "/fixture/herdr" });
  tree = bar.render(f.cx);
  assert(find(tree, "usage-stats-compact")); assert.equal(find(tree, "quota-body"), undefined);
  assert.match(text(find(tree, "usage-card-claude")), /Claude Code/);
  assert.match(text(find(tree, "usage-card-codex")), /without a listed price/);
  // Same edges as the Quota page: no right padding outside the scroll area, a 16px gutter inside it.
  { const root = find(tree, "usage-stats-compact"), cards = find(tree, "usage-cards");
    assert(!Object.hasOwn(root.attributes, "p") && !Object.hasOwn(root.attributes, "pr")); assert.equal(cards.attributes.pr, 16); }
  assert.equal(find(tree, "usage-card-agy"), undefined); assert(find(tree, "usage-spark-claude"));
  // Stacked popover cards keep their content height and the same rows.
  for (const id of ["usage-card-claude", "usage-card-codex"]) { const card = find(tree, id); assert(Object.hasOwn(card.attributes, "flex_none")); assert(!Object.hasOwn(card.attributes, "flex_1")); }
  assert.match(text(find(tree, "usage-priced-claude")), /All models priced/); assert(find(tree, "usage-priced-codex"));
  assert.match(text(find(tree, "usage-fresh-claude")), /excluding cache reads/); assert(find(tree, "usage-fresh-codex"));
  // Showing the page again within five minutes does not read again.
  find(tree, "quota-popover-page-quota").events.on_click({}, f.cx); find(bar.render(f.cx), "quota-popover-page-stats").events.on_click({}, f.cx); await f.settle();
  assert.equal(f.calls.length, 1);
  find(bar.render(f.cx), "usage-range-month").events.on_click({}, f.cx);
  assert.equal(f.state["sessions-plus.usage-range"], "month");
  // Details closes the popover at once: the bar must be redrawn, not only marked closed.
  let notified = 0; const clickCx = { ...f.cx, notify() { notified++; } };
  bar.open = true; find(bar.render(f.cx), "usage-details").events.on_click({}, clickCx);
  assert.equal(bar.open, false); assert(notified > 0); assert.equal(f.overlays.at(-1).props.role, "usage-stats"); assert.deepEqual(f.overlays.at(-1).props.stores, { claude: "/c" });
  find(bar.render(f.cx), "usage-refresh").events.on_click({}, f.cx); await f.settle();
  assert.equal(f.calls.length, 2);
});

test("both Stats presentations save optional provider prices, validate edits, and release native inputs", async () => {
  for (const compact of [true, false]) {
    const data = sample(), f = uiFixture(data), editors = [];
    f.deps.InputState = { new: ({ value }) => {
      const editor = { text: value, events: {}, value() { return this.text; }, on(name, callback) { this.events[name] = callback; }, focus() {}, release() { this.released = true; } };
      editors.push(editor);
      return editor;
    } };
    f.deps.Input = { new: element };
    const Stats = view("usage-stats", f.deps), stats = new Stats();
    stats.init({ compact }, f.cx); await f.settle();
    f.state["sessions-plus.usage-range"] = "month";
    stats.data.ranges.month.providers.claude.cost = 42;
    const price = () => find(stats.render(f.cx), "usage-plan-price-claude");
    assert.equal(text(price()), "Optional");
    price().events.on_click({}, f.cx);
    editors[0].text = "100001"; editors[0].events.submit({}, f.cx);
    assert.equal(f.state[usageModel.PLAN_PRICE_KEY], undefined);
    assert.match(text(stats.render(f.cx)), /Enter a positive amount/);
    editors[0].text = "10"; editors[0].events.submit({}, f.cx);
    assert.equal(editors[0].released, true);
    assert.deepEqual(f.state[usageModel.PLAN_PRICE_KEY], { claude: 10 });
    f.state[usageModel.PLAN_PRICE_KEY].codex = 20;
    assert.match(text(find(stats.render(f.cx), "usage-plan-multiple-claude")), /≈ 4\.2× plan/);
    assert.equal(find(stats.render(f.cx), "usage-plan-multiple-codex"), undefined);
    stats.data.limited = true;
    assert.match(text(find(stats.render(f.cx), "usage-plan-multiple-claude")), /≥ 4\.2× plan/);
    stats.data.limited = false;
    price().events.on_click({}, f.cx);
    editors[1].text = ""; editors[1].events.blur({}, f.cx);
    assert.deepEqual(f.state[usageModel.PLAN_PRICE_KEY], { codex: 20 });
    price().events.on_click({}, f.cx);
    stats.close();
    assert.equal(editors[2].released, true);
  }
});

test("the full dialog lists models, projects and sessions; a session opens its work timeline", async () => {
  const f = uiFixture(), Stats = view("usage-stats", f.deps), stats = new Stats();
  stats.init({ overlay: "usage-dialog", node: "/n", stores: {} }, f.cx); await f.settle();
  const tree = stats.render(f.cx);
  for (const id of ["usage-stats", "usage-card-total", "usage-days", `usage-model-claude-claude-opus-5-5`, "usage-model-codex-codex-auto-review", "usage-project-/work/app"]) assert(find(tree, id), id);
  assert.match(text(find(tree, "usage-model-codex-codex-auto-review")), /Unpriced/);
  assert.equal(find(tree, "usage-model-claude-claude-opus-5-5").childNodes.length, 8);
  find(tree, "usage-metric-tokens").events.on_click({}, f.cx); assert.equal(stats.metric, "tokens");
  find(tree, `usage-session-claude-${claudeId}`).events.on_click({}, f.cx);
  const opened = f.overlays.at(-1);
  assert.deepEqual(f.overlays.at(-2), { closed: "usage-dialog" });
  assert.equal(opened.props.role, "timeline");
  assert.equal(opened.props.target.key, sessionKey({ provider: "claude", store: "/store/claude", id: claudeId }));
  find(tree, "usage-stats").events.on_key_down({ key: "escape" }, f.cx);
  assert.deepEqual(f.overlays.at(-1), { closed: "usage-dialog" });
});

test("a failed or malformed read shows an error instead of numbers", async () => {
  const f = uiFixture({ ranges: {} }), Stats = view("usage-stats", f.deps), stats = new Stats();
  stats.init({ compact: true }, f.cx); await f.settle();
  assert.match(stats.error, /invalid/); assert.equal(find(stats.render(f.cx), "usage-card-claude"), undefined);
});

test("Launch and Tools list Usage stats and the Sessions mod dispatches its role", () => {
  const rows = launcherRows({ spaces: [], agents: [], terminals: [], commands: null, presets: null }, "usage");
  assert.equal(rows[0].action, "usage-stats");
  assert.match(readFileSync(new URL("../mods/sessions-plus/tools.js", import.meta.url), "utf8"), /\["usage-stats", "Usage stats"/);
  assert.match(readFileSync(new URL("../mods/sessions-plus/main.js", import.meta.url), "utf8"), /role === "usage-stats" \? UsageStats/);
});

test("session history titles skip slash-command and harness turns", async () => {
  const { scan } = await import("../mods/sessions-plus/history.mjs");
  const root = mkdtempSync(join(tmpdir(), "usage-titles-test-"));
  try {
    const store = join(root, "claude"); mkdirSync(join(store, "projects", "-work"), { recursive: true });
    const records = [
      { type: "user", cwd: "/work", message: { content: "<local-command-caveat>Caveat: The messages below were generated by the user</local-command-caveat>" } },
      { type: "user", cwd: "/work", message: { content: "<command-name>/clear</command-name>\n<command-message>clear</command-message>" } },
      { type: "user", cwd: "/work", message: { content: [{ type: "text", text: "Plan the usage dashboard" }] } },
    ];
    writeFileSync(join(store, "projects", "-work", `${claudeId}.jsonl`), records.map(record => JSON.stringify(record)).join("\n") + "\n");
    const rows = scan({ home: root, stores: { claude: store, codex: join(root, "codex"), agy: join(root, "agy") } }).rows;
    assert.equal(rows.find(row => row.id === claudeId).title, "Plan the usage dashboard");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Local Codex logs: 200K uncached gpt-6.2-sol input tokens ($0.40, under the long-context threshold) on each of the 21st and the 22nd (today). */
function pricedCodex() {
  const codex = freshState();
  codexRecord({ type: "session_meta", payload: { id: codexId, cwd: "/work/api", source: "cli" } }, codex);
  codexRecord({ type: "turn_context", payload: { turn_id: "t1", model: "gpt-6.2-sol" } }, codex);
  codexRecord(usageRecord("resp_1", "t1", { input_tokens: 200000, cached_input_tokens: 0, output_tokens: 0 }, 21), codex);
  codexRecord(usageRecord("resp_2", "t1", { input_tokens: 200000, cached_input_tokens: 0, output_tokens: 0 }, 22), codex);
  return { ...summarize([{ provider: "codex", store: "/store/codex", events: codex.events, meta: codex }], { now: NOW }), pricingDate: "2026-11-22" };
}
const accountDays = [{ date: "2026-11-01", tokens: 10000000 }, { date: "2026-11-20", tokens: 5000000 }, { date: "2026-11-21", tokens: 3000000 }, { date: "2026-11-22", tokens: 100000 }];

test("Codex account days replace local tokens day by day and cost scales by the local price per token", () => {
  const local = pricedCodex(), result = withAccountUsage(local, accountDays);
  const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`);
  near(local.ranges["7d"].providers.codex.cost, 0.8);
  const week = result.ranges["7d"].providers.codex, month = result.ranges.month.providers.codex;
  // 20th and 21st from the account; the 22nd keeps its larger local count; the 1st is outside the week.
  assert.equal(week.account.tokens, 8200000); assert.equal(week.account.accountDays, 2); assert.equal(week.account.localTokens, 400000);
  near(week.account.rate, 2e-6); assert.equal(week.account.through, "2026-11-22");
  near(week.cost, 16.4); near(month.cost, 36.4); assert.equal(month.account.tokens, 18200000); near(result.ranges.month.cost, 36.4);
  // Local breakdown, requests and sessions stay as read.
  assert.equal(week.requests, 2); assert.equal(week.tokens.total, 400000); assert.equal(week.sessions, 1);
  const day = date => result.days.find(row => row.date === date).providers.codex;
  assert.equal(day("2026-11-20").requests, 0); assert.equal(day("2026-11-20").tokens, 5000000); near(day("2026-11-20").cost, 10);
  assert.equal(day("2026-11-21").tokens, 3000000); assert.equal(day("2026-11-21").requests, 1);
  assert.equal(day("2026-11-22").tokens, 200000); near(day("2026-11-22").cost, 0.4);
  assert.equal(result.account.codex.through, "2026-11-22"); near(result.account.codex.rate, 2e-6);
  assert.doesNotThrow(() => usageResult(result));
  // Without local Codex logs no price can be estimated: tokens still come from the account, cost stays local.
  const empty = withAccountUsage(summarize([], { now: NOW }), accountDays);
  assert.equal(empty.ranges.month.providers.codex.account.tokens, 18100000); assert.equal(empty.ranges.month.providers.codex.account.rate, null);
  assert.equal(empty.ranges.month.providers.codex.cost, 0);
});

test("the helper adds account usage when Codex answers and warns, except for a missing CLI, when it does not", async t => {
  const root = mkdtempSync(join(tmpdir(), "usage-account-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { now: NOW, home: root, cache: false, stores: { claude: join(root, "claude"), codex: join(root, "codex") } }, stores = [];
  const ok = await collectUsageWithAccount(options, { accountUsage: async ({ store }) => { stores.push(store); return { state: "ok", days: accountDays }; } });
  assert.deepEqual(stores, [join(root, "codex")]); assert.equal(ok.ranges.month.providers.codex.account.tokens, 18100000); assert.deepEqual(ok.warnings, []);
  const failed = await collectUsageWithAccount(options, { accountUsage: async () => ({ state: "unavailable", message: "Codex usage query timed out. Try again later." }) });
  assert.equal(failed.account, undefined); assert.match(failed.warnings.join("\n"), /timed out.*local logs only/);
  const thrown = await collectUsageWithAccount(options, { accountUsage: async () => { throw new Error("boom"); } });
  assert.match(thrown.warnings.join("\n"), /could not be read/);
  const missing = await collectUsageWithAccount(options, { accountUsage: async () => ({ state: "unavailable", reason: "missing-cli", message: "Install" }) });
  assert.deepEqual(missing.warnings, []);
  const off = await collectUsageWithAccount({ ...options, account: false }, { accountUsage: () => assert.fail("account: false must not query") });
  assert.equal(off.account, undefined);
});

test("a Codex card with account usage shows account tokens, local logs and an approximate cost", async () => {
  const f = uiFixture(withAccountUsage(pricedCodex(), accountDays)), Stats = view("usage-stats", f.deps), stats = new Stats();
  stats.init({ compact: true }, f.cx); await f.settle();
  const tree = stats.render(f.cx);
  assert.match(text(find(tree, "usage-account-codex")), /8\.2M tokens · Codex account/);
  assert.match(text(find(tree, "usage-fresh-codex")), /Local logs 400K · 2 requests · 1 sessions/);
  assert.match(text(find(tree, "usage-cost-codex")), /^≈ \$16\.40$/);
  assert.match(find(tree, "usage-cost-codex").attributes.tooltip, /\$2\.000 per 1M tokens[\s\S]*Local logs alone: \$0\.80/);
  assert.match(text(tree), /local logs \+ Codex account/);
  // Claude keeps its usual rows and plain cost.
  assert.equal(find(tree, "usage-account-claude"), undefined); assert.match(text(find(tree, "usage-fresh-claude")), /excluding cache reads/);
});
