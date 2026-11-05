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

// How Recent and Pinned are listed: "flat" in their own order, or "tree" by folder.
export const LIBRARY_VIEW_KEY = "files-plus.library-view.v1";
export const libraryView = value => value === "tree" ? "tree" : "flat";

/** Forget recent files: all of them, or those inside `folder`. Pins are kept. */
export function forgetRecent(state, root, on, folder = "", now = Date.now()) {
  if (!root || (folder && !validRelative(folder))) return state;
  const key = projectKey(root, on), library = libraryFor(state, root, on);
  const inside = path => !folder || path === folder || path.startsWith(folder + "/");
  const recent = library.recent.filter(path => !inside(path));
  if (recent.length === library.recent.length) return state;
  return { projects: { ...state?.projects, [key]: { ...library, recent, updated: now } } };
}

/**
 * Group relative paths into folders, folders first, then by name. A folder holding only one
 * folder joins it on one row ("a/b"), as editors show compact folders.
 * Returns [{ name, path, dir, count, children }], where count is the files inside.
 */
export function pathTree(paths) {
  const root = { children: new Map() };
  for (const path of paths) {
    const parts = path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      if (!node.children.has(part)) node.children.set(part, { name: part, path: parts.slice(0, i + 1).join("/"), dir: i < parts.length - 1, children: new Map() });
      node = node.children.get(part);
    });
  }
  const build = node => [...node.children.values()]
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    .map(child => {
      let item = child, name = child.name;
      while (item.dir && item.children.size === 1 && [...item.children.values()][0].dir) {
        item = [...item.children.values()][0];
        name += "/" + item.name;
      }
      const children = item.dir ? build(item) : [];
      return { name, path: item.path, dir: item.dir, count: item.dir ? children.reduce((n, c) => n + (c.dir ? c.count : 1), 0) : 1, children };
    });
  return build(root);
}

/** The visible rows of a path tree, skipping the children of folders in `folded`. */
export function treeRows(nodes, folded = new Set(), depth = 0, out = []) {
  for (const node of nodes) {
    out.push({ path: node.path, name: node.name, dir: node.dir, count: node.count, depth, group: node.dir });
    if (node.dir && !folded.has(node.path)) treeRows(node.children, folded, depth + 1, out);
  }
  return out;
}
