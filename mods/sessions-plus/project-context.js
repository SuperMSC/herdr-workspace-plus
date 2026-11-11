// Read-only counterpart of Files projectContext; Herdr isolates imports to each mod.
import { spaces, panes, machines, focused, shared } from "herdr";
const validRelative = path => typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.split("/").some(p => !p || p === "." || p === "..") && !/[\x00-\x1f\x7f]/.test(path);
const FILE_TABS_KEY = "files-plus.file-tabs.v1";
const TTL = 3000;
const snapshot = () => ({ spaces: spaces(), panes: panes(), machines: machines(), focus: focused() });
const stored = () => { const value = shared(FILE_TABS_KEY); return value && typeof value === "object" ? value : {}; };
const machine = value => value ?? null;
const pendingLive = row => row && typeof row.space === "string" && typeof row.root === "string" && validRelative(row.path) && typeof row.previewId === "string" && Array.isArray(row.before) && Array.isArray(row.queue) && Number.isFinite(row.started) && Date.now() >= row.started && Date.now() - row.started < TTL;
const modPane = pane => pane?.mod === "files-plus" && pane.terminal === null;
function live(row, state) {
  return row && typeof row.tab === "string" && typeof row.previewId === "string" && typeof row.root === "string" && validRelative(row.path)
    && state.spaces.some(space => space.id === row.space && space.tabs.some(tab => tab.id === row.tab))
    && state.panes.some(pane => pane.pane === row.pane && pane.tab === row.tab && modPane(pane));
}
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
