// Explicit workspace mappings are metadata only. Removing one never touches a directory.
export const WORKSPACES_KEY = "files-plus.workspaces.v1";
export const WORKSPACE_FOLDS_KEY = "files-plus.workspace-folds.v1";
export const ROOT_LIMIT = 8, WORKSPACE_LIMIT = 40;
export function normalizeWorkspaceRoot(value) {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Choose an absolute folder path.");
  if (/^[A-Za-z]:[\\/]/.test(value)) { if (value.split(/[\\/]/).includes("..")) throw new Error("Choose an absolute folder without parent traversal."); const path = value.replace(/\\/g, "/"); return /^[A-Za-z]:\/+$/.test(path) ? path.slice(0, 2) + "/" : path.replace(/\/+$/, ""); }
  if (!value.startsWith("/") || value.split("/").includes("..")) throw new Error("Choose an absolute folder path without parent traversal.");
  return value.replace(/\/+/g, "/").replace(/\/+$/, "") || "/";
}
export function workspaceKey(context = {}) {
  return JSON.stringify(context.space ? ["space", context.on || null, context.space] : ["folder", context.on || null, context.cwd || ""]);
}
export const rootKey = (root, on = null) => JSON.stringify([on || null, root]);
export const rootName = root => root.replace(/\/+$/, "").split(/^[A-Za-z]:[\\/]|^\\\\/.test(root) ? /[\\/]/ : /\//).pop() || root;
export function workspaceRecord(state, context) {
  const record = state?.workspaces?.[workspaceKey(context)];
  if (!record || !Array.isArray(record.roots) || record.roots.length < 1 || record.roots.length > ROOT_LIMIT) return null;
  try {
    const roots = record.roots.map(root => ({ path: normalizeWorkspaceRoot(root.path), name: String(root.name || rootName(root.path)).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 80) }));
    if (new Set(roots.map(root => root.path)).size !== roots.length) return null;
    return { ...record, roots };
  } catch { return null; }
}
export function workspaceRoots(state, context) {
  return workspaceRecord(state, context)?.roots || (context?.cwd ? [{ path: context.cwd, name: rootName(context.cwd) }] : []);
}
export function saveWorkspace(state, context, roots, expected) {
  const key = workspaceKey(context), raw = state?.workspaces?.[key] ?? null;
  if (expected !== undefined && JSON.stringify(raw) !== expected) throw new Error("Workspace folders changed in another view. Reopen the folder manager before saving.");
  if (!Array.isArray(roots) || !roots.length || roots.length > ROOT_LIMIT) throw new Error(`Keep between 1 and ${ROOT_LIMIT} folders.`);
  const next = roots.map(root => ({ path: normalizeWorkspaceRoot(root.path), name: String(root.name || rootName(root.path)).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 80) }));
  if (new Set(next.map(root => root.path)).size !== next.length) throw new Error("This folder is already in the workspace.");
  const workspaces = { ...(state?.workspaces || {}) };
  if (!(key in workspaces) && Object.keys(workspaces).length >= WORKSPACE_LIMIT) throw new Error("Saved workspace limit reached. Reset an unused workspace first.");
  workspaces[key] = { roots: next, updated: Date.now() };
  return { workspaces };
}
export function resetWorkspace(state, context, expected) {
  const key = workspaceKey(context), workspaces = { ...(state?.workspaces || {}) };
  if (expected !== undefined && JSON.stringify(workspaces[key] ?? null) !== expected) throw new Error("Workspace folders changed in another view. Reopen this manager.");
  delete workspaces[key];
  return { workspaces };
}
export function addWorkspaceRoot(roots, path) {
  const normalized = normalizeWorkspaceRoot(path);
  if (roots.some(root => root.path === normalized)) throw new Error("This folder is already in the workspace.");
  if (roots.length >= ROOT_LIMIT) throw new Error(`A workspace holds up to ${ROOT_LIMIT} folders.`);
  return [...roots, { path: normalized, name: rootName(normalized) }];
}
