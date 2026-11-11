// Explicit workspace recipes and bounded launch journals. This module never runs a command.
import { commandContext, validateCommand } from "./commands-model.js";
export const PRESETS_KEY = "sessions-plus.workspace-presets.v1";
export const PRESET_WORKSPACES_KEY = "files-plus.workspaces.v1";
export const PRESET_LABEL = "agent-workspace.preset";
export const PRESET_STEP_LABEL = "agent-workspace.preset-step";
export const PRESET_LIMITS = { presets: 20, drafts: 8, launches: 16, roots: 8, tabs: 3, bytes: 2400000, draftReserve: 195000, launchReserve: 160000, lease: 240000 };
export const PRESET_WORKING = ["preparing", "launching"];
const text = (value, max, label) => { if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} is missing, too long, or contains control characters.`); return value; };
export function presetRoot(value) {
  const path = text(value, 2000, "Absolute folder");
  if (/^[a-z]:[\\/]/i.test(path)) { if (path.split(/[\\/]/).includes("..")) throw new Error("Folders cannot contain parent traversal."); return path.replace(/\\/g, "/").replace(/\/+$/, "") + (/^[a-z]:[\\/]+$/i.test(path) ? "/" : ""); }
  if (!path.startsWith("/") || path.split("/").includes("..")) throw new Error("Use absolute folders without parent traversal.");
  return path.replace(/\/+/g, "/").replace(/\/+$/, "") || "/";
}
const rootName = root => root.replace(/\/+$/, "").split("/").pop() || root;
export function validatePreset(value) {
  const name = text(value.name, 100, "Project name").trim(), root = presetRoot(value.root), { on } = commandContext({ root, on: value.on });
  if (!Array.isArray(value.roots)) throw new Error("File roots must be a JSON array of absolute paths.");
  const roots = [root, ...value.roots.map(presetRoot).filter(path => path !== root)];
  if (roots.length > PRESET_LIMITS.roots || new Set(roots).size !== roots.length) throw new Error("Keep up to eight different file roots, including the main folder.");
  const agentArgv = validateCommand({ title: "Agent", cwd: root, argv: value.agentArgv }).argv;
  if (!Array.isArray(value.tabs) || value.tabs.length < 1 || value.tabs.length > PRESET_LIMITS.tabs) throw new Error("Add one to three extra terminal tabs.");
  const tabs = value.tabs.map(tab => { const name = text(tab?.name, 80, "Terminal name").trim(), cwd = presetRoot(tab.cwd || root); return { name, cwd, argv: validateCommand({ title: name, cwd, argv: tab.argv }).argv }; });
  return { name, root, on, roots, agentArgv, tabs };
}
export function parsePresetForm(form) {
  let roots, agentArgv, tabs;
  try { roots = JSON.parse(form.rootsText); agentArgv = JSON.parse(form.agentText); tabs = JSON.parse(form.tabsText); } catch { throw new Error("File roots, agent argv and terminal tabs must each be valid JSON arrays."); }
  return validatePreset({ name: form.name, root: form.root, on: form.machine || null, roots, agentArgv, tabs });
}
export const presetRevision = preset => preset ? JSON.stringify([preset.id, preset.version, preset.updated]) : null;
export const presetDraftRevision = draft => draft ? JSON.stringify(draft) : null;
export const presetDraftContent = draft => JSON.stringify([draft.id ?? null, draft.expected ?? null, draft.name, draft.root, draft.machine, draft.rootsText, draft.agentText, draft.tabsText]);
export function presetState(value) { return { presets: Array.isArray(value?.presets) ? value.presets : [], drafts: Array.isArray(value?.drafts) ? value.drafts : [], launches: Array.isArray(value?.launches) ? value.launches : [] }; }
function bounded(value) {
  const state = presetState(value), reserved = state.drafts.reduce((sum, draft) => sum + Math.max(0, PRESET_LIMITS.draftReserve - JSON.stringify(draft).length), 0) + state.launches.filter(row => PRESET_WORKING.includes(row.status)).length * PRESET_LIMITS.launchReserve;
  if (state.presets.length > PRESET_LIMITS.presets || state.drafts.length > PRESET_LIMITS.drafts || state.launches.length > PRESET_LIMITS.launches || JSON.stringify(state).length + reserved > PRESET_LIMITS.bytes) throw new Error("Saved workspace presets are full. Discard an unused draft or remove an unused preset first; existing work is retained.");
  return state;
}
export function presetForm(preset, context, draftId) {
  const root = preset?.root || context?.root || "";
  return { draftId, id: preset?.id || null, expected: presetRevision(preset), name: preset?.name || "", machine: preset ? preset.on || "" : context?.on || "", root, rootsText: JSON.stringify(preset?.roots || (root ? [root] : []), null, 2), agentText: JSON.stringify(preset?.agentArgv || [], null, 2), tabsText: JSON.stringify(preset?.tabs || [{ name: "Shell", cwd: root, argv: [] }], null, 2) };
}
export function savePresetDraft(value, draft, expected) {
  const state = presetState(value), original = state.drafts.find(row => row.draftId === draft.draftId);
  if (expected !== undefined && presetDraftRevision(original) !== expected) throw new Error("This form changed or was discarded in another window. The visible form has not overwritten it.");
  if (!original && state.drafts.length >= PRESET_LIMITS.drafts) throw new Error("Eight unfinished forms are saved. Discard an unused form before opening another copy.");
  for (const [key, max] of [["name", 100], ["machine", 200], ["root", 2000], ["rootsText", 18000], ["agentText", 18000], ["tabsText", 52000]]) if (typeof draft[key] !== "string" || draft[key].length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(draft[key])) throw new Error("This form exceeds its text limit. The visible text is retained; shorten it before closing.");
  return bounded({ ...state, drafts: [...state.drafts.filter(row => row.draftId !== draft.draftId), { ...draft, updated: Date.now() }] });
}
export function removePresetDraft(value, id, expected) {
  const state = presetState(value);
  if (expected !== undefined && presetDraftRevision(state.drafts.find(row => row.draftId === id)) !== expected) throw new Error("This saved form changed. Review it again before discarding.");
  return bounded({ ...state, drafts: state.drafts.filter(row => row.draftId !== id) });
}
export function savePreset(value, form, id = null, expected = null, now = Date.now(), newId = `preset-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`) {
  const state = presetState(value), original = state.presets.find(row => row.id === id);
  if (id && (!original || presetRevision(original) !== expected)) throw new Error("This preset changed or was removed in another window. Your form is retained.");
  if (state.launches.some(row => row.presetId === id && PRESET_WORKING.includes(row.status))) throw new Error("Wait for the current launch before editing this preset.");
  if (!id && state.presets.length >= PRESET_LIMITS.presets) throw new Error("Twenty presets are already saved. Remove an unused preset first.");
  const saved = { ...validatePreset(form), id: id || newId, favorite: original?.favorite === true, version: (original?.version || 0) + 1, updated: now };
  return bounded({ ...state, presets: original ? state.presets.map(row => row.id === id ? saved : row) : [...state.presets, saved] });
}
export function removePreset(value, id, expected) {
  const state = presetState(value), original = state.presets.find(row => row.id === id);
  if (!original || presetRevision(original) !== expected) throw new Error("This preset changed or was removed. Review it again.");
  if (state.launches.some(row => row.presetId === id && PRESET_WORKING.includes(row.status))) throw new Error("Wait for the current launch before removing this preset.");
  return bounded({ ...state, presets: state.presets.filter(row => row.id !== id) });
}
export function favoritePreset(value, id) { const state = presetState(value); return bounded({ ...state, presets: state.presets.map(row => row.id === id ? { ...row, favorite: !row.favorite } : row) }); }
export function copyPreset(value, original) {
  const current = presetState(value).presets.find(row => row.id === original.id);
  if (!current || presetRevision(current) !== presetRevision(original)) throw new Error("This preset changed. Review it before copying.");
  return savePreset(value, { ...current, name: `Copy of ${current.name}`.slice(0, 100) });
}
export function preparedPreset(preset) { return { presetId: preset.id, revision: presetRevision(preset), config: validatePreset(preset) }; }
export function reservePresetLaunch(value, prepared, token, now = Date.now()) {
  const state = presetState(value), preset = state.presets.find(row => row.id === prepared.presetId);
  if (!preset || presetRevision(preset) !== prepared.revision) throw new Error("The preset changed after preview. Preview the current version again.");
  if (state.launches.some(row => PRESET_WORKING.includes(row.status) || ["partial", "unconfirmed"].includes(row.status))) throw new Error("Review the previous launch result before starting another workspace.");
  const config = validatePreset(prepared.config);
  if (JSON.stringify(config) !== JSON.stringify(validatePreset(preset))) throw new Error("The launch preview changed. Preview the saved preset again.");
  if (state.launches.some(row => row.token === token)) throw new Error("This launch was already reserved.");
  const items = [{ key: "preflight", title: "Check folders and executables", status: "pending" }, { key: "agent", title: "Agent tab", status: "pending" }, { key: "roots", title: `${config.roots.length} file roots`, status: "pending" }, ...config.tabs.map((tab, index) => ({ key: `tab-${index + 1}`, title: tab.name, status: "pending" }))];
  const row = { token, presetId: preset.id, name: config.name, on: config.on, config, items, status: "preparing", started: now, expires: now + PRESET_LIMITS.lease, spaceId: null, spaceMarker: `${config.name} · ${token}`, error: "" };
  return bounded({ ...state, launches: [...state.launches.slice(-(PRESET_LIMITS.launches - 1)), row] });
}
export function patchPresetLaunch(value, token, patch) {
  const state = presetState(value);
  return bounded({ ...state, launches: state.launches.map(row => row.token === token ? { ...row, ...patch, ...(row.reviewed ? { reviewed: true, status: row.status } : {}) } : row) });
}
export function reviewPresetLaunch(value, token, now = Date.now()) {
  const state = presetState(value), original = state.launches.find(row => row.token === token);
  if (!original || PRESET_WORKING.includes(original.status) && now <= original.expires) throw new Error("This launch is still active. Wait for its result; an interrupted launch can be reviewed after four minutes.");
  return patchPresetLaunch(state, token, { reviewed: true, status: original.status === "complete" || original.status === "failed" ? original.status : "reviewed" });
}
export function applyPresetRoots(value, space, config) {
  if (!space?.id || (space.machine || null) !== (config.on || null) || presetRoot(space.folder) !== config.root) throw new Error("The new workspace no longer matches this preset. File roots were not changed.");
  const key = JSON.stringify(["space", config.on || null, space.id]), workspaces = { ...(value?.workspaces || {}) };
  if (Object.hasOwn(workspaces, key)) throw new Error("This new workspace already has a file-root mapping. It was not overwritten.");
  if (Object.keys(workspaces).length >= 40) throw new Error("The file workspace limit is full. Reset an unused mapping first.");
  workspaces[key] = { roots: config.roots.map(path => ({ path, name: rootName(path) })), updated: Date.now() };
  return { ...(value || {}), workspaces };
}
