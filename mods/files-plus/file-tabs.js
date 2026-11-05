import { spaces, panes, machines, focused, shared, setShared, run } from "herdr";
import { validRelative } from "./library-model.js";

export const FILE_TABS_KEY = "files-plus.file-tabs.v1";
const TTL = 3000, RETRIES = 20;
const snapshot = () => ({ spaces: spaces(), panes: panes(), machines: machines(), focus: focused() });
const stored = () => { const value = shared(FILE_TABS_KEY); return value && typeof value === "object" ? value : {}; };
const machine = value => value ?? null;
const sameFile = (a, b) => a.root === b.root && a.path === b.path && machine(a.on) === machine(b.on);
const pendingLive = row => row && typeof row.space === "string" && typeof row.root === "string" && validRelative(row.path) && typeof row.previewId === "string" && Array.isArray(row.before) && Array.isArray(row.queue) && Number.isFinite(row.started) && Date.now() >= row.started && Date.now() - row.started < TTL;
const modPane = pane => pane?.mod === "files-plus" && pane.terminal === null;
function live(row, state) {
  return row && typeof row.tab === "string" && typeof row.previewId === "string" && typeof row.root === "string" && validRelative(row.path)
    && state.spaces.some(space => space.id === row.space && space.tabs.some(tab => tab.id === row.tab))
    && state.panes.some(pane => pane.pane === row.pane && pane.tab === row.tab && modPane(pane));
}
function retain(row, state) {
  if (live(row, state)) return true;
  if (!row || typeof row.space !== "string" || typeof row.previewId !== "string" || !validRelative(row.path) || state.spaces.some(space => space.id === row.space)) return false;
  // An offline core omits its spaces; absence is not proof that its tabs closed.
  return !("spaceMachine" in row) || !state.machines.some(item => item.name === row.spaceMachine && item.layout === "ready");
}
function clean(value, state) {
  return {
    tabs: Object.fromEntries(Object.values(value.tabs || {}).filter(row => retain(row, state)).map(row => [row.tab, row])),
    pending: Object.fromEntries(Object.entries(value.pending || {}).filter(([space, row]) => pendingLive(row) && row.space === space && state.spaces.some(item => item.id === space))),
  };
}
function save(value) { if (JSON.stringify(value) !== JSON.stringify(stored())) setShared(FILE_TABS_KEY, value); }
function candidates(request, state) {
  const space = state.spaces.find(item => item.id === request.space);
  return (space?.tabs || []).filter(tab => !request.before.includes(tab.id)).flatMap(tab => {
    const found = state.panes.filter(pane => pane.tab === tab.id && modPane(pane));
    return found.length === 1 ? [{ tab: tab.id, pane: found[0].pane }] : [];
  });
}
function context(row) { return { cwd: row.root, on: machine(row.on), space: row.space }; }

// A read-only resolver: render calls never publish shared state.
export function projectContext() {
  const state = snapshot(), focus = state.focus, space = state.spaces.find(item => item.id === focus?.space) || state.spaces.find(item => item.active);
  const pane = state.panes.find(item => item.pane === focus?.pane), value = stored(), row = value.tabs?.[focus?.tab];
  if (row && space && row.space === space.id && row.pane === focus?.pane && live(row, state)) return context(row);
  const pending = value.pending?.[space?.id];
  if (pendingLive(pending) && modPane(pane)) {
    const added = candidates(pending, state);
    if (added.length === 1 && added[0].tab === focus?.tab && added[0].pane === focus?.pane) return context(pending);
  }
  const on = focus?.pane === null && focus?.terminal ? (focus.terminal.includes("/") ? focus.terminal.split("/")[0] : null) : machine(space?.machine);
  return { cwd: pane?.cwd || focus?.cwd || space?.folder, on, space: space?.id };
}

function drain(queue, cx) {
  for (const target of queue || []) openIn(target.space, target, cx);
}
function discover(request, cx, attempt = 0) {
  const state = snapshot(), value = clean(stored(), state), current = value.pending[request.space];
  if (current?.previewId !== request.previewId) { save(value); return null; }
  const added = candidates(current, state);
  if (added.length === 1) {
    const { tab, pane } = added[0];
    value.tabs[tab] = { tab, pane, space: request.space, root: request.root, path: request.path, on: request.on, previewId: request.previewId, spaceMachine: request.spaceMachine };
    delete value.pending[request.space]; save(value); drain(current.queue, cx);
    return tab;
  }
  if (attempt >= RETRIES || !cx?.timer?.after) {
    delete value.pending[request.space]; save(value); drain(current.queue, cx);
    return null;
  }
  cx.timer.after(100, next => discover(request, next, attempt + 1));
  return null;
}
function openIn(spaceId, target, cx) {
  const state = snapshot(), space = state.spaces.find(item => item.id === spaceId);
  if (!space) return null;
  const value = clean(stored(), state);
  const existing = Object.values(value.tabs).find(row => row.space === spaceId && live(row, state) && sameFile(row, target));
  if (existing) {
    save(value); run("tab.select", { id: existing.tab }); run("pane.focus", { pane: existing.pane });
    return existing.tab;
  }
  const pending = value.pending[spaceId];
  if (pending) {
    if (!sameFile(pending, target) && !pending.queue.some(row => sameFile(row, target))) {
      value.pending[spaceId] = { ...pending, queue: [...pending.queue, { ...target, space: spaceId }].slice(0, 40) }; save(value);
    }
    return null;
  }
  const request = { ...target, space: spaceId, spaceMachine: machine(space.machine), previewId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, before: space.tabs.map(tab => tab.id), started: Date.now(), queue: [] };
  value.pending[spaceId] = request; save(value);
  try {
    run("tab.new", { name: target.path.split("/").at(-1), space: spaceId, mod: "files-plus", props: { role: "file-preview", root: target.root, path: target.path, on: target.on, previewId: request.previewId } });
  } catch (error) {
    const latest = clean(stored(), snapshot());
    if (latest.pending[spaceId]?.previewId === request.previewId) { delete latest.pending[spaceId]; save(latest); }
    throw error;
  }
  return discover(request, cx);
}

export function openFileTab({ root, path, on = null }, cx) {
  if (typeof root !== "string" || !root || /[\x00-\x1f\x7f]/.test(root) || !validRelative(path) || /^[A-Za-z]:[\\/]/.test(path) || (on !== null && typeof on !== "string")) throw new Error("A project folder and relative file path are required.");
  const state = snapshot(), space = state.spaces.find(item => item.id === state.focus?.space) || state.spaces.find(item => item.active);
  return openIn(space?.id, { root, path, on }, cx);
}
