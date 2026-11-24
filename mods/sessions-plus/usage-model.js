// Per-agent usage statistics from local session logs. Pure: no Node or Herdr imports.
// Only token counts, model names, timestamps, session identities and working folders are
// kept; no message text is read into the state. Titles come from the session history reader.
import { PROVIDERS, codexOrigin } from "./model.js";
import { eventCost, priceFor } from "./usage-pricing.js";

export const USAGE_PROVIDERS = ["claude", "codex"];
export const TOKEN_PROVIDERS = ["claude", "codex"];
export const RANGES = { "7d": "Last 7 days", month: "This month" };
export const PLAN_PRICE_KEY = "sessions-plus.plan-price.v1";
export const CHART_DAYS = 30;
const TURN_MODELS = 64;
const num = value => Number.isFinite(value) && value > 0 ? value : 0;
const time = value => { const ms = typeof value === "number" ? value : Date.parse(value); return Number.isFinite(ms) ? ms : null; };

export function freshState() { return { sessionId: "", cwd: "", origin: "", model: "", tier: "", turns: {}, prev: null, events: [] }; }

/** One Claude Code JSONL record into the file's state. */
export function claudeRecord(record, state) {
  if (!record || typeof record !== "object") return;
  if (typeof record.cwd === "string" && record.cwd.startsWith("/")) state.cwd = record.cwd;
  if (typeof record.sessionId === "string" && record.sessionId) state.sessionId ||= record.sessionId;
  if (record.type !== "assistant") return;
  const usage = record.message?.usage, model = record.message?.model, t = time(record.timestamp);
  if (!usage || !model || model === "<synthetic>" || t === null) return;
  const split = usage.cache_creation && typeof usage.cache_creation === "object";
  const event = {
    k: record.message.id && record.requestId ? `${record.message.id}:${record.requestId}` : `${state.sessionId}:${record.uuid ?? t}`,
    t, m: String(model), i: num(usage.input_tokens), o: num(usage.output_tokens), r: num(usage.cache_read_input_tokens),
    w5: split ? num(usage.cache_creation.ephemeral_5m_input_tokens) : num(usage.cache_creation_input_tokens),
    w1: split ? num(usage.cache_creation.ephemeral_1h_input_tokens) : 0,
    s: record.sessionId || state.sessionId, c: state.cwd,
  };
  if (usage.speed === "fast") event.f = 1;
  if (event.i + event.o + event.r + event.w5 + event.w1 > 0) state.events.push(event);
}

/** One Codex rollout JSONL record into the file's state. */
export function codexRecord(record, state) {
  if (!record || typeof record !== "object") return;
  const payload = record.payload ?? {}, t = time(record.timestamp);
  if (record.type === "session_meta") {
    if (typeof payload.id === "string") state.sessionId = payload.id;
    if (typeof payload.cwd === "string" && payload.cwd.startsWith("/")) state.cwd = payload.cwd;
    state.origin = codexOrigin(payload.source);
    if (payload.service_tier) state.tier = String(payload.service_tier);
    return;
  }
  if (record.type === "turn_context") {
    if (payload.model) {
      state.model = String(payload.model);
      if (payload.turn_id) { state.turns[payload.turn_id] = state.model; const keys = Object.keys(state.turns); if (keys.length > TURN_MODELS) delete state.turns[keys[0]]; }
    }
    if (payload.service_tier) state.tier = String(payload.service_tier);
    if (typeof payload.cwd === "string" && payload.cwd.startsWith("/")) state.cwd ||= payload.cwd;
    return;
  }
  if (record.type === "token_usage_record") {
    const usage = payload.usage; if (!usage || t === null) return;
    const input = num(usage.input_tokens), cached = Math.min(input, num(usage.cached_input_tokens)), written = Math.min(input - cached, num(usage.cache_write_input_tokens));
    const event = { k: payload.response_id || `${state.sessionId}:${record.ordinal ?? t}`, t, m: (payload.turn_id && state.turns[payload.turn_id]) || state.model || "unknown",
      i: input - cached - written, r: cached, w5: written, w1: 0, o: num(usage.output_tokens), p: input, s: payload.session_id || state.sessionId, c: state.cwd, x: "rec" };
    if (["priority", "fast"].includes(state.tier)) event.f = 1;
    if (input + event.o > 0) state.events.push(event);
    return;
  }
  if (record.type !== "event_msg") return;
  if (payload.type === "thread_settings_applied" && payload.thread_settings?.service_tier) state.tier = String(payload.thread_settings.service_tier);
  else if (payload.type === "token_count" && t !== null) {
    // Older rollouts have only cumulative totals: count the growth since the previous reading.
    const total = payload.info?.total_token_usage; if (!total) return;
    const prev = state.prev ?? { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    state.prev = total;
    const input = num(total.input_tokens) - num(prev.input_tokens), cached = num(total.cached_input_tokens) - num(prev.cached_input_tokens), output = num(total.output_tokens) - num(prev.output_tokens);
    if (input <= 0 && output <= 0) return;
    const event = { k: `${state.sessionId}:${num(total.total_tokens)}`, t, m: state.model || "unknown", i: Math.max(0, input - Math.max(0, cached)), r: Math.max(0, cached), w5: 0, w1: 0,
      o: Math.max(0, output), p: num(payload.info?.last_token_usage?.input_tokens) || Math.max(0, input), s: state.sessionId, c: state.cwd, x: "cnt" };
    if (["priority", "fast"].includes(state.tier)) event.f = 1;
    state.events.push(event);
  }
}

export function localDay(ms) { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
export function rangeStarts(now = Date.now()) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const week = new Date(today); week.setDate(week.getDate() - 6);
  const month = new Date(today); month.setDate(1);
  const chart = new Date(today); chart.setDate(chart.getDate() - (CHART_DAYS - 1));
  return { "7d": +week, month: +month, chart: +chart, today: +today };
}
/** The earliest instant any view needs; older events and files can be dropped. */
export const retentionStart = (now = Date.now()) => { const s = rangeStarts(now); return Math.min(s.month, s.chart); };

const emptyTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
function addTokens(target, event) {
  const w = (event.w5 || 0) + (event.w1 || 0);
  target.input += event.i || 0; target.output += event.o || 0; target.cacheRead += event.r || 0; target.cacheWrite += w;
  target.total += (event.i || 0) + (event.o || 0) + (event.r || 0) + w;
}
const totalTokens = event => (event.i || 0) + (event.o || 0) + (event.r || 0) + (event.w5 || 0) + (event.w1 || 0);

/**
 * files: [{ provider, store, events, meta: { sessionId, cwd, origin } }]
 * titles: Map of "provider:id" → title, from the session history reader.
 * projectOf: maps a working folder to its project (the helper uses the enclosing Git checkout).
 */
export function summarize(files, { now = Date.now(), limited = false, warnings = [], projectOf = cwd => cwd, titles = new Map() } = {}) {
  const starts = rangeStarts(now), sessionsMeta = new Map(), unique = { claude: new Map(), codex: new Map() };
  for (const file of files) {
    if (!unique[file.provider]) continue;
    const meta = file.meta ?? {}, id = meta.sessionId;
    if (id) {
      const key = `${file.provider}:${id}`, prior = sessionsMeta.get(key) ?? {};
      sessionsMeta.set(key, { provider: file.provider, id, store: file.store, cwd: prior.cwd || meta.cwd || "", origin: prior.origin || meta.origin || "", title: titles.get(key) || "" });
    }
    // A rollout with per-request records also carries cumulative readings for the same requests.
    const events = file.provider === "codex" && file.events.some(e => e.x === "rec") ? file.events.filter(e => e.x === "rec") : file.events;
    const map = unique[file.provider];
    for (const event of events) {
      if (event.t < starts.chart && event.t < starts.month) continue;
      const seen = map.get(event.k);
      // Claude writes one record per content block of a message; later ones carry the final counts.
      if (!seen) map.set(event.k, { ...event, store: file.store });
      else if (file.provider === "claude") for (const field of ["i", "o", "r", "w5", "w1"]) seen[field] = Math.max(seen[field] || 0, event[field] || 0);
    }
  }
  const days = Array.from({ length: CHART_DAYS }, (_, index) => { const d = new Date(starts.chart); d.setDate(d.getDate() + index); return { date: localDay(+d), providers: {} }; });
  const dayIndex = new Map(days.map((day, index) => [day.date, index]));
  const ranges = {};
  for (const range of Object.keys(RANGES)) ranges[range] = { from: starts[range], providers: {}, projects: new Map(), sessions: new Map() };
  const unpriced = new Set();
  for (const provider of TOKEN_PROVIDERS) for (const event of unique[provider].values()) {
    const cost = eventCost(provider, event), tokens = totalTokens(event);
    if (cost === null) unpriced.add(`${PROVIDERS[provider]} · ${event.m}`);
    const day = dayIndex.get(localDay(event.t));
    if (day !== undefined && event.t >= starts.chart) {
      const slot = days[day].providers[provider] ??= { cost: 0, tokens: 0, requests: 0 };
      slot.cost += cost ?? 0; slot.tokens += tokens; slot.requests++;
    }
    for (const [range, bucket] of Object.entries(ranges)) {
      if (event.t < bucket.from || event.t > now) continue;
      const total = bucket.providers[provider] ??= { cost: 0, unpricedTokens: 0, tokens: emptyTokens(), requests: 0, sessionIds: new Set(), models: new Map() };
      total.cost += cost ?? 0; if (cost === null) total.unpricedTokens += tokens; addTokens(total.tokens, event); total.requests++;
      const sessionKey = `${provider}:${event.s}`, meta = sessionsMeta.get(sessionKey);
      if (event.s && !["review", "subagent"].includes(meta?.origin)) total.sessionIds.add(event.s);
      const model = total.models.get(event.m) ?? { model: event.m, priced: Boolean(priceFor(provider, event.m)), cost: 0, tokens: emptyTokens(), requests: 0 };
      model.cost += cost ?? 0; addTokens(model.tokens, event); model.requests++; total.models.set(event.m, model);
      const cwd = projectOf(event.c || meta?.cwd || "");
      if (cwd) {
        const project = bucket.projects.get(cwd) ?? { cwd, cost: 0, tokens: 0, requests: 0, providers: {}, sessionIds: new Set() };
        project.cost += cost ?? 0; project.tokens += tokens; project.requests++; project.providers[provider] = (project.providers[provider] ?? 0) + (cost ?? 0);
        if (event.s) project.sessionIds.add(sessionKey); bucket.projects.set(cwd, project);
      }
      if (event.s) {
        const session = bucket.sessions.get(sessionKey) ?? { provider, id: event.s, store: meta?.store || event.store || "", title: meta?.title || "", cwd: cwd || meta?.cwd || "", origin: meta?.origin || "", cost: 0, tokens: 0, requests: 0, last: 0 };
        session.cost += cost ?? 0; session.tokens += tokens; session.requests++; session.last = Math.max(session.last, event.t); bucket.sessions.set(sessionKey, session);
      }
    }
  }
  const byWeight = (a, b) => b.cost - a.cost || b.tokens - a.tokens;
  const result = { generatedAt: now, ranges: {}, days, unpriced: [...unpriced].sort(), limited, warnings };
  for (const [range, bucket] of Object.entries(ranges)) {
    const providers = {};
    for (const provider of TOKEN_PROVIDERS) {
      const total = bucket.providers[provider];
      providers[provider] = total ? { cost: total.cost, unpricedTokens: total.unpricedTokens, tokens: total.tokens, requests: total.requests, sessions: total.sessionIds.size,
        models: [...total.models.values()].sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total) } : { cost: 0, unpricedTokens: 0, tokens: emptyTokens(), requests: 0, sessions: 0, models: [] };
    }
    result.ranges[range] = {
      label: RANGES[range], from: bucket.from, to: now, providers,
      cost: TOKEN_PROVIDERS.reduce((sum, provider) => sum + providers[provider].cost, 0),
      projects: [...bucket.projects.values()].map(({ sessionIds, ...project }) => ({ ...project, sessions: sessionIds.size })).sort(byWeight).slice(0, 12),
      sessions: [...bucket.sessions.values()].map(session => ({ ...session, title: session.title || `${PROVIDERS[session.provider]} ${session.id.slice(0, 8)}` })).sort(byWeight).slice(0, 10),
    };
  }
  return result;
}

export function formatTokens(value) {
  const n = Number(value) || 0, abs = Math.abs(n);
  if (abs >= 1e9) return `${Number((n / 1e9).toFixed(abs >= 1e10 ? 1 : 2))}B`;
  if (abs >= 1e6) return `${Number((n / 1e6).toFixed(abs >= 1e7 ? 1 : 2))}M`;
  if (abs >= 1e3) return `${Number((n / 1e3).toFixed(abs >= 1e4 ? 0 : 1))}K`;
  return String(Math.round(n));
}
export function formatUsd(value) {
  const n = Number(value) || 0;
  if (n === 0) return "$0";
  if (n < 0.01) return "<$0.01";
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${formatCount(n)}`;
}

export function planPrice(value) {
  if (typeof value === "string" && /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) value = Number(value);
  return Number.isFinite(value) && value > 0 && value <= 100000 ? value : null;
}

export function planMultiple({ cost, monthlyPrice, range, partial = false, unpricedTokens = 0 }) {
  const price = planPrice(monthlyPrice);
  if (price === null || !Object.hasOwn(RANGES, range) || partial || unpricedTokens > 0 || !Number.isFinite(cost) || cost < 0) return null;
  const multiple = cost / (range === "7d" ? price * (7 / 30.4375) : price);
  return Number.isFinite(multiple) ? multiple : null;
}
// Grouped by hand: the GPUI script runtime need not ship locale data.
export const formatCount = value => String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export const shortModel = model => String(model ?? "").replace(/^claude-/, "").replace(/-\d{8}$/, "");
export const folderName = path => String(path ?? "").replace(/\/+$/, "").split("/").pop() || path || "";

/** Validate the helper's JSON before rendering it. */
export function usageResult(data) {
  if (!data || typeof data !== "object" || !data.ranges || !Array.isArray(data.days) || !Object.keys(RANGES).every(range => data.ranges[range]?.providers)) throw new Error("Usage statistics returned an invalid result.");
  return data;
}
