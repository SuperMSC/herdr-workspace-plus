// Pure grouping logic for Project Spaces: no Herdr calls, so tests can run it in Node.
//
// A space belongs to a project automatically: its Git repository (the main checkout and
// every linked worktree share one), else the folder it is in. Dragging a space onto another
// group, or choosing "Move to project", records a manual assignment that wins over that.

export const STATE_KEY = "project-spaces.v1";
export const MODES = [
  { id: "project", label: "Project" },
  { id: "status", label: "Status" },
  { id: "none", label: "None" },
];
export const SORTS = [
  { id: "manual", label: "Manual", about: "Drag to arrange" },
  { id: "recent", label: "Recent", about: "Latest agent activity first" },
];
export const STATUS_GROUPS = [
  { id: "blocked", label: "Needs you" },
  { id: "done", label: "Done" },
  { id: "working", label: "Working" },
  { id: "idle", label: "Idle" },
];
export const PALETTE = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
// The avatar colors Herdr's Spaces draws for these names: one strong color per hue, light and dark alike.
export const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const URGENCY = { blocked: 3, done: 2, working: 1, idle: 0 };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, limit = 80) => typeof value === "string" ? value.slice(0, limit) : "";

export const baseName = path => String(path ?? "").replace(/\/+$/, "").split("/").pop() || "/";

/** Return a well-formed copy of the stored state; unknown or damaged fields fall back to defaults. */
export function normalizeState(raw) {
  const source = object(raw) ? raw : {};
  const groups = {};
  for (const [key, meta] of Object.entries(object(source.groups) ? source.groups : {})) {
    if (!object(meta)) continue;
    const entry = {};
    if (text(meta.name)) entry.name = text(meta.name);
    if (text(meta.color, 16)) entry.color = text(meta.color, 16);
    if (meta.custom === true) entry.custom = true;
    if (Object.keys(entry).length) groups[key] = entry;
  }
  const assign = {};
  for (const [id, key] of Object.entries(object(source.assign) ? source.assign : {})) if (typeof key === "string" && key) assign[id] = key;
  const strings = list => Array.isArray(list) ? [...new Set(list.filter(item => typeof item === "string" && item))] : [];
  return {
    mode: MODES.some(m => m.id === source.mode) ? source.mode : "project",
    sort: SORTS.some(s => s.id === source.sort) ? source.sort : "manual",
    folded: strings(source.folded),
    order: strings(source.order),
    assign,
    groups,
  };
}

/** The project a space falls into on its own. `git` is the Spaces Git record or null. */
export function autoProject(space, git, place, home = "") {
  const machine = space.machine ?? null;
  if (git?.repo) {
    let common = "";
    try { common = JSON.parse(git.repo)[1] ?? ""; } catch {}
    const root = common.endsWith("/.git") ? common.slice(0, -5) : common;
    return { key: `repo:${JSON.stringify([machine, root])}`, name: git.name || baseName(root), folder: root, machine };
  }
  const folder = place || space.folder || "";
  const name = !folder || folder === home || folder === "~" ? "Home" : baseName(folder);
  return { key: `dir:${JSON.stringify([machine, folder])}`, name, folder, machine };
}

/** When something in the space last changed, for Recent sorting. */
export function activity(space) {
  let latest = 0;
  for (const tab of space.tabs ?? []) latest = Math.max(latest, Number(tab.changed_at) || 0, Number(tab.working_since) || 0);
  return latest;
}

export function urgent(statuses) {
  let best = null;
  for (const status of statuses) if (status && (best === null || (URGENCY[status] ?? -1) > (URGENCY[best] ?? -1))) best = status;
  return best;
}

function hash(key) {
  let value = 0;
  for (const char of key) value = (value * 31 + char.codePointAt(0)) >>> 0;
  return value;
}

export function groupColor(state, key) {
  return state.groups[key]?.color ?? PALETTE[hash(key) % PALETTE.length];
}

const byIndex = (a, b) => a.i - b.i;
const byRecent = (a, b) => b.activity - a.activity || a.i - b.i;

/**
 * Arrange rows into groups.
 * rows: [{ w: SpaceInfo, i: its position in spaces(), g: Git record or null, place }]
 * Returns [{ key, name, color, folder, machine, custom, manual, rows, status, active, folded, header }].
 */
export function buildGroups(rows, rawState, { home = "" } = {}) {
  const state = normalizeState(rawState);
  const sorter = state.sort === "recent" ? byRecent : byIndex;
  const items = rows.map(row => {
    const auto = autoProject(row.w, row.g, row.place, home);
    return { ...row, auto, activity: activity(row.w) };
  });
  const finish = group => {
    group.rows.sort(sorter);
    group.status = urgent(group.rows.map(r => r.w.status));
    group.active = group.rows.some(r => r.w.active);
    group.activity = Math.max(0, ...group.rows.map(r => r.activity));
    group.first = Math.min(...group.rows.map(r => r.i));
    group.folded = state.folded.includes(group.key);
    return group;
  };

  if (state.mode === "none") {
    return items.length ? [finish({ key: "all", name: "Spaces", color: null, header: false, rows: items, manual: 0 })] : [];
  }

  if (state.mode === "status") {
    return STATUS_GROUPS.map(status => finish({
      key: `status:${status.id}`, name: status.label, color: null, header: true, statusGroup: status.id, manual: 0,
      rows: items.filter(r => (URGENCY[r.w.status] === undefined ? "idle" : r.w.status) === status.id),
    })).filter(group => group.rows.length);
  }

  const groups = new Map();
  for (const item of items) {
    const key = state.assign[item.w.id] ?? item.auto.key;
    item.key = key;
    item.manual = key !== item.auto.key;
    if (!groups.has(key)) groups.set(key, { key, header: true, rows: [] });
    groups.get(key).rows.push(item);
  }
  for (const group of groups.values()) {
    // Name, folder and machine come from a member that belongs here automatically, if any.
    const native = group.rows.find(r => r.auto.key === group.key) ?? null;
    const meta = state.groups[group.key] ?? {};
    group.custom = Boolean(meta.custom);
    group.name = meta.name || native?.auto.name || "Project";
    group.folder = native?.auto.folder ?? group.rows[0].auto.folder;
    group.machine = native?.auto.machine ?? group.rows[0].auto.machine;
    group.color = groupColor(state, group.key);
    group.manual = group.rows.filter(r => r.manual).length;
    finish(group);
  }
  const list = [...groups.values()];
  if (state.sort === "recent") return list.sort((a, b) => b.activity - a.activity || a.first - b.first);
  const rank = key => { const at = state.order.indexOf(key); return at === -1 ? Infinity : at; };
  return list.sort((a, b) => rank(a.key) - rank(b.key) || a.first - b.first);
}

/** The space order that keeps each project's spaces together, or null when order is not managed. */
export function targetOrder(groups, rawState) {
  const state = normalizeState(rawState);
  if (state.mode !== "project" || state.sort !== "manual") return null;
  return groups.flatMap(group => group.rows.map(r => r.w.id));
}

/**
 * The space.move calls that turn `order` into `target`, each index counted from 1
 * after the earlier moves. Spaces missing from either list are left in place.
 */
export function moves(order, target) {
  const current = [...order];
  const wanted = target.filter(id => current.includes(id));
  const result = [];
  for (let i = 0; i < wanted.length; i++) {
    const from = current.indexOf(wanted[i]);
    if (from === i) continue;
    result.push({ id: wanted[i], index: i + 1 });
    current.splice(i, 0, current.splice(from, 1)[0]);
  }
  return result;
}

/** Put a space in a group. Its own automatic project clears the manual choice. */
export function assignSpace(rawState, spaceId, key, autoKey, name = "") {
  const state = normalizeState(rawState);
  if (key === autoKey) delete state.assign[spaceId];
  else {
    state.assign[spaceId] = key;
    // Keep a name, so the group still reads right after its own spaces close.
    if (name && !state.groups[key]?.name) state.groups[key] = { ...state.groups[key], name: text(name) };
  }
  return cleanup(state);
}

/** A new, empty manual group's key. */
export function newGroupKey(rawState, now = Date.now()) {
  const state = normalizeState(rawState);
  let key = `group:${now.toString(36)}`, n = 1;
  while (state.groups[key]) key = `group:${now.toString(36)}-${n++}`;
  return key;
}

export function createGroup(rawState, key, name, spaceId, autoKey) {
  const state = normalizeState(rawState);
  state.groups[key] = { ...state.groups[key], name: text(name.trim()) || "Project", custom: true };
  if (spaceId) state.assign[spaceId] = key;
  if (autoKey && spaceId && key === autoKey) delete state.assign[spaceId];
  return cleanup(state);
}

export function renameGroup(rawState, key, name) {
  const state = normalizeState(rawState);
  const clean = text(name.trim());
  const meta = { ...state.groups[key] };
  if (clean) meta.name = clean;
  else if (meta.custom) meta.name = meta.name || "Project";
  else delete meta.name;
  state.groups[key] = meta;
  return cleanup(state);
}

export function setGroupColor(rawState, key, color) {
  const state = normalizeState(rawState);
  const meta = { ...state.groups[key] };
  if (color) meta.color = color;
  else delete meta.color;
  state.groups[key] = meta;
  return cleanup(state);
}

export function toggleFold(rawState, key) {
  const state = normalizeState(rawState);
  state.folded = state.folded.includes(key) ? state.folded.filter(k => k !== key) : [...state.folded, key];
  return state;
}

export function foldAll(rawState, keys, folded) {
  const state = normalizeState(rawState);
  state.folded = folded ? [...new Set([...state.folded, ...keys])] : state.folded.filter(k => !keys.includes(k));
  return state;
}

/** Release every manual assignment into a group; a manual group goes with them. */
export function ungroup(rawState, key) {
  const state = normalizeState(rawState);
  for (const [id, target] of Object.entries(state.assign)) if (target === key) delete state.assign[id];
  if (state.groups[key]?.custom) delete state.groups[key];
  state.folded = state.folded.filter(k => k !== key);
  return cleanup(state);
}

/** Move group `from` before (or after) group `to`, given the order shown now. */
export function moveGroup(rawState, shown, from, to, after = false) {
  const state = normalizeState(rawState);
  if (from === to || !shown.includes(from) || !shown.includes(to)) return state;
  const list = shown.filter(key => key !== from);
  list.splice(list.indexOf(to) + (after ? 1 : 0), 0, from);
  // Keep the places of groups not shown now (their spaces are closed or still loading).
  state.order = [...list, ...state.order.filter(key => !list.includes(key))];
  return state;
}

/** Shift a group one place up (-1) or down (+1) among those shown. */
export function stepGroup(rawState, shown, key, step) {
  const at = shown.indexOf(key), to = shown[at + step];
  if (at === -1 || to === undefined) return normalizeState(rawState);
  return moveGroup(rawState, shown, key, to, step > 0);
}

/** Forget assignments of spaces that are gone, and manual groups nothing points to. */
export function prune(rawState, liveIds) {
  const state = normalizeState(rawState);
  const live = new Set(liveIds);
  for (const id of Object.keys(state.assign)) if (!live.has(id)) delete state.assign[id];
  return cleanup(state);
}

function cleanup(state) {
  const used = new Set(Object.values(state.assign));
  for (const [key, meta] of Object.entries(state.groups)) {
    if (meta.custom && !used.has(key)) delete state.groups[key];
    else if (!Object.keys(meta).length) delete state.groups[key];
  }
  return state;
}

export function sameState(a, b) {
  return JSON.stringify(normalizeState(a)) === JSON.stringify(normalizeState(b));
}
