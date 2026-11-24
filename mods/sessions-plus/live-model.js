export const LIVE_KEY = "sessions-plus.live.v1";
export const WINDOW_TABLE_DATE = "2026-11-03";
export const LIVE_LIMITS = { agents: 40, bytes: 8 * 1024 * 1024, deadline: 8000 };
export const LIVE_MAX_AGE = 120000;
const LIVE_PUBLISH_INTERVAL = 60000;
export const TERMINAL_SESSIONS_KEY = "sessions-plus.terminal-sessions.v1";
export const TERMINAL_SESSION_AGE = 7 * 86400000;
const TERMINAL_SESSION_INTERVAL = 3600000;
export const AUTO_TITLES_KEY = "sessions-plus.auto-titles.v1";
export const AUTO_TITLES_ENABLED = "sessions-plus.auto-titles.enabled";
export const AUTO_TITLE_INTERVAL = 30000;
const SESSION_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const localID = value => typeof value === "string" && /^[^/\s\x00-\x1f\x7f]+$/.test(value);
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const absolute = value => typeof value === "string" && value.startsWith("/") && !/[\x00-\x1f\x7f]/.test(value);
const terminalKey = ({ address, created_ms }) => `${address}@${created_ms}`;
const entries = value => value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];
export const localLayoutReady = machines => machines.some(machine => machine.name === null && machine.layout === "ready");
export const sameSession = (a, b) => !!a && !!b && a.provider === b.provider && a.id === b.id && a.store === b.store;
const sessionKey = ({ provider, id, store }) => JSON.stringify([provider, store, id]);
const exact = identity => ["claude", "codex", "agy"].includes(identity?.provider) && typeof identity.id === "string" && SESSION_ID.test(identity.id) && absolute(identity.store);
const recorded = record => localID(record?.address) && positiveInt(record.created_ms) && positiveInt(record.pid) && exact(record) && absolute(record.cwd) && Number.isFinite(record.lastSeen);

function localTabs(spaces) {
  const tabs = new Map(), duplicates = new Set();
  for (const space of spaces) {
    if (space.machine != null || !localID(space.id)) continue;
    for (const tab of space.tabs ?? []) if (localID(tab.id)) {
      if (tabs.has(tab.id)) duplicates.add(tab.id);
      else tabs.set(tab.id, { ...tab, space: space.id });
    }
  }
  for (const id of duplicates) tabs.delete(id);
  return tabs;
}

/** Use explicit pane/agent links or matching labels to assign a local terminal to a tab. */
export function workspaceTerminals(terminals, { identities = {}, spaces = [], panes = [], agents = [], knownAgents = new Set() } = {}) {
  const tabs = localTabs(spaces), panesByTerminal = new Map(), agentsByTerminal = new Map();
  for (const pane of panes) if (pane.terminal) panesByTerminal.set(pane.terminal, pane);
  for (const agent of agents) agentsByTerminal.set(agent.address, agent);
  return terminals.filter(term => localID(term.address) && positiveInt(term.created_ms)).map(term => {
    const pane = panesByTerminal.get(term.address), agent = agentsByTerminal.get(term.address);
    const labelTab = tabs.get(term.labels?.["herdr.tab"]);
    const tab = tabs.get(pane?.tab ?? agent?.tab) ?? (labelTab?.space === term.labels?.["herdr.space"] ? labelTab : null);
    const identity = identities[terminalKey(term)];
    const cwd = [term.foreground?.cwd, pane?.cwd, term.cwd].find(absolute) ?? null;
    return { ...term, identity: exact(identity) ? identity : null, cwd, space: tab?.space ?? null, tab: tab?.id ?? null,
      agent: Boolean(agent || pane?.program?.agent || term.program?.agent || exact(identity) || knownAgents.has(term.address)) };
  });
}

export function interruptedSessions(registry) {
  return entries(registry).filter(([key, record]) => recorded(record) && record.interrupted === true && terminalKey(record) === key)
    .sort(([, a], [, b]) => b.lastSeen - a.lastSeen).slice(0, LIVE_LIMITS.agents).map(([key, record]) => ({ ...record, key }));
}

export function currentInterruption(registry, entry) {
  const record = registry?.[entry?.key];
  return recorded(record) && record.interrupted === true && terminalKey(record) === entry.key &&
    record.pid === entry.pid && record.lastSeen === entry.lastSeen && sameSession(record, entry) ? record : null;
}

export function interruptionTitle(entry, names) {
  const title = names?.[sessionKey(entry)];
  if (typeof title === "string" && title.trim()) return title;
  return `${{ claude: "Claude Code", codex: "Codex", agy: "Antigravity" }[entry.provider]} · ${entry.id.slice(0, 8)}`;
}

/** Only a changed root PID on the same live terminal is restart evidence. */
export function updateTerminalSessions(previous, previousMisses, { terminals = [], ready, uncertain = new Set(), now = Date.now() } = {}) {
  if (!ready) return { registry: previous, misses: new Map() };
  const byKey = new Map(), active = new Map(), registry = {}, misses = new Map();
  for (const term of terminals) {
    if (!localID(term.address) || !positiveInt(term.created_ms)) continue;
    const key = terminalKey(term);
    byKey.set(key, term);
    if (term.state !== "live" || !exact(term.identity)) continue;
    const session = sessionKey(term.identity);
    if (!active.has(session)) active.set(session, new Set());
    active.get(session).add(key);
  }
  const elsewhere = (key, identity) => [...(active.get(sessionKey(identity)) ?? [])].some(other => other !== key);
  const eligible = term => term?.state === "live" && term.keep === true && term.parent == null;
  const tabID = id => localID(id) ? id : null;
  for (const [key, record] of entries(previous)) {
    if (!recorded(record) || terminalKey(record) !== key || now - record.lastSeen > TERMINAL_SESSION_AGE || elsewhere(key, record)) continue;
    const term = byKey.get(key);
    if (term?.state === "live" && !eligible(term)) continue;
    if (term?.state === "live" && sameSession(term.identity, record)) {
      const pid = positiveInt(term.pid) ? term.pid : record.pid;
      const placed = positiveInt(term.pid) && absolute(term.cwd);
      const cwd = placed ? term.cwd : record.cwd, space = placed ? tabID(term.space) : record.space, tab = placed ? tabID(term.tab) : record.tab;
      const changed = pid !== record.pid || cwd !== record.cwd || space !== record.space || tab !== record.tab;
      const lastSeen = changed || now - record.lastSeen >= TERMINAL_SESSION_INTERVAL ? now : record.lastSeen;
      const { interrupted, ...confirmed } = record;
      registry[key] = interrupted !== undefined || lastSeen !== record.lastSeen || changed
        ? { ...confirmed, pid, cwd, space, tab, lastSeen } : record;
      continue;
    }
    if (term?.state === "live" && positiveInt(term.pid) && term.pid !== record.pid) {
      registry[key] = record.interrupted || uncertain.size ? record : { ...record, interrupted: true };
      continue;
    }
    const miss = term?.state !== "live" ? "absent" : positiveInt(term.pid) && !uncertain.has(key) ? "foreground" : null;
    if (miss && previousMisses?.get(key) === miss) continue;
    if (miss) misses.set(key, miss);
    registry[key] = record;
  }
  for (const [key, term] of byKey) {
    if (registry[key] || !eligible(term) || !positiveInt(term.pid) || !exact(term.identity) || !absolute(term.cwd) || elsewhere(key, term.identity)) continue;
    const { provider, id, store } = term.identity;
    registry[key] = { address: term.address, created_ms: term.created_ms, pid: term.pid, provider, id, store, cwd: term.cwd,
      space: tabID(term.space), tab: tabID(term.tab), lastSeen: now };
  }
  const bounded = Object.entries(registry).sort(([, a], [, b]) => b.lastSeen - a.lastSeen).slice(0, LIVE_LIMITS.agents);
  return { registry: Object.fromEntries(bounded), misses: new Map(bounded.filter(([key]) => misses.has(key)).map(([key]) => [key, misses.get(key)])) };
}

export function planAutoTitles(previous, { terminals = [], spaces = [], names, ready, screenshot, enabled = true, renamedAt = new Map(), now = Date.now() } = {}) {
  if (!ready) return { registry: previous, actions: [] };
  const tabs = localTabs(spaces), agents = new Map(), actions = [], registry = {};
  for (const term of terminals) if (term.state === "live" && localID(term.address) && term.agent && tabs.has(term.tab)) {
    if (!agents.has(term.tab)) agents.set(term.tab, []);
    agents.get(term.tab).push(term);
  }
  for (const [id, tab] of tabs) {
    const old = Object.hasOwn(previous ?? {}, id) ? previous[id] : null, available = now - (renamedAt.get(id) ?? -Infinity) >= AUTO_TITLE_INTERVAL;
    if (old?.user === true) { registry[id] = old; continue; }
    if (old?.hidden && tab.named === false) {
      if (!enabled) continue;
      registry[id] = old;
      if (!screenshot) { actions.push({ id, name: old.name }); registry[id] = { name: old.name }; }
      continue;
    }
    if (old && tab.name !== old.name) {
      registry[id] = tab.named === false && !available ? old : { name: old.name, user: true };
      continue;
    }
    if (old) registry[id] = old;
    if (screenshot) {
      if (old?.name && (!old.hidden || available)) {
        actions.push({ id, name: "" });
        registry[id] = { name: old.name, hidden: true };
      }
      continue;
    }
    if (!enabled) {
      if (old?.name && available) { actions.push({ id, name: "" }); delete registry[id]; }
      continue;
    }
    if (old?.hidden) {
      if (!available) continue;
      registry[id] = { name: old.name };
    }
    const inTab = agents.get(id);
    if (!available || !old && tab.named !== false || inTab?.length !== 1 || !exact(inTab[0].identity)) continue;
    const identity = inTab[0].identity, value = names?.[sessionKey(identity)] || identity.title;
    const name = typeof value === "string" ? [...value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim()].slice(0, 40).join("").trimEnd() : "";
    if (!name || name === old?.name) continue;
    registry[id] = { name };
    actions.push({ id, name });
  }
  return { registry, actions };
}

// Published model families and versions as of WINDOW_TABLE_DATE. Unknown IDs stay unknown.
export function claudeWindow(model) {
  const id = String(model ?? "").toLowerCase().replace(/^claude-/, "").replaceAll(".", "-");
  if (/^(?:(?:fable|mythos|opus|sonnet)-5(?:-|$)|opus-4-[678](?:-|$)|sonnet-4-6(?:-|$)|haiku-5-5(?:-|$))/.test(id)) return 1000000;
  if (/^(?:haiku-4-5|(?:opus|sonnet)-4(?:-[015])?|3(?:-5|-7)?-(?:haiku|sonnet|opus)|(?:haiku|sonnet|opus)-3(?:-5|-7)?|2(?:-[01])?)(?:-\d{8})?$/.test(id)) return 200000;
  return null;
}

export function contextPercent(used, window) {
  return Number.isFinite(used) && used >= 0 && Number.isFinite(window) && window > 0 && used <= window
    ? Math.floor(used * 100 / window) : null;
}

export function contextLabel(entry, now = Date.now()) {
  if (!Number.isFinite(entry?.used) || entry.used < 0 || !Number.isFinite(entry.at) || now - entry.at > LIVE_MAX_AGE) return null;
  const percent = contextPercent(entry.used, entry.window);
  const tokens = count => count >= 1000000 ? `${+(count / 1000000).toFixed(2)}M` : count >= 1000 ? `${Math.round(count / 1000)}K` : String(count);
  const seconds = Math.max(0, Math.floor((now - entry.asOf) / 1000));
  const ago = seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`;
  const tooltip = [`Context ${tokens(entry.used)}${entry.window ? ` of ${tokens(entry.window)}` : ""} tokens`, entry.model || "Unknown model",
    Number.isFinite(entry.asOf) ? `as of ${ago}` : "", `window table ${WINDOW_TABLE_DATE}`].filter(Boolean).join(" · ");
  return { label: percent === null ? tokens(entry.used) : `${percent}%`, tooltip, level: percent >= 90 ? "strong" : percent >= 80 ? "warn" : null };
}

export function updateLive(previous, results, now = Date.now()) {
  const next = {}, due = [];
  for (const [key, entry] of Object.entries(results)) {
    const old = previous?.[key];
    if (entry.deferred && old?.provider === entry.provider && old.pid === entry.pid && old.id === entry.id && old.store === entry.store) {
      next[key] = old;
      continue;
    }
    const { provider, id, store, pid, title, context } = entry;
    let used = Number.isFinite(context?.used) ? Math.round(context.used / 1000) * 1000 : null;
    const window = context?.window ?? null;
    // Rounding must preserve whether the reading exceeds the observed window.
    if (window && used !== null) {
      if (context.used > window && used <= window) used = (Math.floor(window / 1000) + 1) * 1000;
      if (context.used <= window && used > window) used = Math.floor(window / 1000) * 1000;
    }
    const value = { provider, id, store, pid, title: title || null, used, window, model: context?.model || null, asOf: context?.asOf ?? null };
    if (old && Number.isFinite(old.at) && Object.keys(value).every(field => value[field] === old[field])) {
      next[key] = old;
      if (now - old.at >= LIVE_PUBLISH_INTERVAL) due.push(key);
    } else next[key] = { ...value, at: now };
  }
  const changed = Object.keys(next).length !== Object.keys(previous ?? {}).length || Object.keys(next).some(key => next[key] !== previous?.[key]);
  // Coalesce staggered idle heartbeats into at most one shared write per minute.
  const recent = !changed && Object.values(previous ?? {}).some(entry => now - entry.at < LIVE_PUBLISH_INTERVAL);
  if (!changed && (!due.length || recent)) return null;
  for (const key of due) next[key] = { ...next[key], at: now };
  return next;
}
