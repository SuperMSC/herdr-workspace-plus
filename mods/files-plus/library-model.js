// Bounded, project-local navigation state; never stores file contents.
export const LIBRARY_KEY = "files-plus.library.v1";
const RECENT_LIMIT = 20, PIN_LIMIT = 40, PROJECT_LIMIT = 40;
export const projectKey = (root, on = null) => JSON.stringify([on || null, root]);
export const validRelative = path => typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.split("/").some(p => !p || p === "." || p === "..") && !/[\x00-\x1f\x7f]/.test(path);
const clean = (items, limit) => [...new Set((Array.isArray(items) ? items : []).filter(validRelative))].slice(0, limit);

export function libraryFor(state, root, on) {
  const value = state?.projects?.[projectKey(root, on)];
  return { recent: clean(value?.recent, RECENT_LIMIT), pinned: clean(value?.pinned, PIN_LIMIT) };
}

export function updateLibrary(state, root, on, action, path, now = Date.now()) {
  if (!root || !validRelative(path)) return state;
  const key = projectKey(root, on), library = libraryFor(state, root, on);
  if (action === "open") library.recent = clean([path, ...library.recent], RECENT_LIMIT);
  if (action === "forget") library.recent = library.recent.filter(p => p !== path);
  if (action === "pin") {
    if (library.pinned.includes(path)) library.pinned = library.pinned.filter(p => p !== path);
    else library.pinned = clean([path, ...library.pinned], PIN_LIMIT);
  }
  const entries = Object.entries(state?.projects || {}).filter(([k]) => k !== key)
    .sort((a, b) => (b[1]?.updated || 0) - (a[1]?.updated || 0)).slice(0, PROJECT_LIMIT - 1);
  return { projects: { ...Object.fromEntries(entries), [key]: { ...library, updated: now } } };
}

export function remapLibrary(state, root, on, remap) {
  const key = projectKey(root, on), library = libraryFor(state, root, on);
  const next = { recent: clean(library.recent.map(remap), RECENT_LIMIT), pinned: clean(library.pinned.map(remap), PIN_LIMIT) };
  if (JSON.stringify(next) === JSON.stringify(library)) return state;
  return { projects: { ...state?.projects, [key]: { ...next, updated: Date.now() } } };
}

export function breadcrumbs(root, file) {
  const parts = (file || "").split("/").filter(Boolean);
  return [{ label: root?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || root || "Files", path: "", dir: true },
    ...parts.map((label, i) => ({ label, path: parts.slice(0, i + 1).join("/"), dir: i < parts.length - 1 }))];
}

export function selectPaths(selected, path, visible, anchor, modifiers = {}) {
  if (modifiers.shift && visible.includes(anchor) && visible.includes(path)) {
    const a = visible.indexOf(anchor), b = visible.indexOf(path);
    return new Set([...selected, ...visible.slice(Math.min(a, b), Math.max(a, b) + 1)]);
  }
  const next = new Set(selected);
  next.has(path) ? next.delete(path) : next.add(path);
  return next;
}
