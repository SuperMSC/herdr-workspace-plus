// Pure menu/target helpers. Targets are captured before focus moves to an overlay.
export const CHANGE_KEY = "files-plus.change";
export const SHOW_HIDDEN_KEY = "files-plus.show-hidden";

export function visibleEntry(name, showHidden = false) {
  return showHidden || !String(name).startsWith(".");
}

export function targetFor(root, relative = "", dir = true, on = null, platform = "") {
  if (!root) return null;
  const windowsPath = /^[A-Za-z]:[\\/]|^\\\\/.test(root);
  const base = windowsPath ? root.replace(/[\\/]+$/, "") : root.replace(/\/+$/, "");
  const path = relative ? `${base}/${relative}` : root;
  const name = relative ? relative.split("/").pop() : (windowsPath ? root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : root.replace(/\/+$/, "").split("/").pop()) || root;
  return { root, relative, path, name, dir, on, platform, isRoot: !relative };
}

export function localActions(target) {
  return Boolean(target?.path && !target.on && target.platform === "macos");
}

export function parentPath(path) {
  const end = path.lastIndexOf("/");
  return end === 0 ? "/" : path.slice(0, end);
}

export function menuItems(target, { preferences = false, showHidden = false } = {}) {
  if (!target) return [];
  if (target.kind === "changes") {
    const local = localActions(target), xy = target.xy ?? "  ";
    const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
    return [
      ...(local ? [
        ...(!target.deleted ? [{ id: "open", label: "Open with Default App" }] : []),
        { id: "reveal", label: target.deleted ? "Reveal Parent in Finder" : "Reveal in Finder" },
      ] : []),
      { id: "copyPath", label: "Copy Path", separator: local },
      { id: "copyRelative", label: "Copy Relative Path" },
      { id: "copyName", label: "Copy Name" },
      { id: "queueReference", label: "Add reference to pending prompts…", separator: true },
      ...(local && (xy === "??" || xy[1] !== " " || conflict) ? [{ id: "stage", label: conflict ? "Stage Resolution" : "Stage File", separator: true }] : []),
      ...(local && xy !== "??" && xy[0] !== " " ? [{ id: "unstage", label: "Unstage File", separator: true }] : []),
      { id: "refresh", label: "Refresh", separator: true },
    ];
  }
  return [
    ...(localActions(target) ? [
      { id: "open", label: "Open with Default App" },
      { id: "reveal", label: "Reveal in Finder" },
    ] : []),
    { id: "copyPath", label: "Copy Path", separator: localActions(target) },
    { id: "copyRelative", label: "Copy Relative Path" },
    { id: "copyName", label: "Copy Name" },
    { id: "queueReference", label: "Add reference to pending prompts…", separator: true },
    ...(localActions(target) ? [
      { id: "createFile", label: "New File…", separator: true },
      { id: "createFolder", label: "New Folder…" },
      ...(!target.isRoot ? [
        { id: "rename", label: "Rename…", separator: true },
        { id: "trash", label: "Move to Trash…", danger: true },
      ] : []),
    ] : []),
    { id: "refresh", label: "Refresh", separator: true },
    ...(preferences || target.isRoot ? [{ id: "toggleHidden", label: "Show Hidden Files", checked: showHidden, separator: true }] : []),
  ];
}

export function copyValue(action, target) {
  if (action === "copyPath") return target.path;
  if (action === "copyRelative") return target.relative || ".";
  if (action === "copyName") return target.name;
  throw new Error("Unknown clipboard action");
}

export function creationFolder(target) {
  return target.dir ? target.path : parentPath(target.path);
}

export function menuHeight(target, options, maximum = Infinity) {
  const items = menuItems(target, options);
  // Padding (8), title (22), hint (22), rows (30), separators (7).
  return Math.min(52 + items.length * 30 + items.filter(item => item.separator).length * 7, maximum);
}

export function applyPathChange(path, change) {
  if (path == null) return path;
  if (!["rename", "trash"].includes(change.action)) return path;
  const old = change.target.relative;
  if (!old || (path !== old && !path.startsWith(`${old}/`))) return path;
  if (change.action === "trash") return null;
  const prefix = old.includes("/") ? old.slice(0, old.lastIndexOf("/") + 1) : "";
  return prefix + change.name + path.slice(old.length);
}

const MARK_RANK = { U: 4, D: 3, M: 2, A: 1 };

/** Folders, relative to `root`, that contain a Git mark, each with the strongest mark inside. */
export function dirtyFolders(marks, root) {
  const prefix = String(root ?? "").replace(/\/+$/, "") + "/", out = new Map();
  for (const [path, mark] of Object.entries(marks ?? {})) {
    if (!path.startsWith(prefix)) continue;
    const parts = path.slice(prefix.length).split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if ((MARK_RANK[mark] ?? 0) > (MARK_RANK[out.get(folder)] ?? 0)) out.set(folder, mark);
    }
  }
  return out;
}

/** Mix two #rrggbb colors (alpha ignored); anything else comes back as `a` unchanged. */
export function mixColor(a, b, amount) {
  const parse = c => /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c ?? "") ? [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)) : null;
  const x = parse(a), y = parse(b);
  if (!x || !y) return a;
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * amount).toString(16).padStart(2, "0")).join("");
}

/**
 * The color for a Git mark, as editors show them: added green, deleted or conflicted red,
 * modified amber. Terminal ANSI colors are tuned for text on black, so they are blended
 * toward the theme's text color: the same lightness with less saturation. Modified takes a
 * little red first, so a pure yellow becomes the amber that editors use.
 */
export function markColor(mark, t) {
  if (!mark) return null;
  const base = mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : mixColor(t.ansi3, t.ansi1, 0.2);
  return mixColor(base, t.foreground, 0.35);
}

// Expand all opens the tree a few levels down, never into dependency or build folders,
// and stops at a folder budget so the periodic refresh stays cheap.
export const AUTO_SKIP = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build", "target", ".next", ".cache", ".idea", ".mypy_cache", ".pytest_cache", ".ruff_cache"]);
export const EXPAND_DEPTH = 4;
export const EXPAND_LIMIT = 80;

/** Open folders below `base` (not `base` itself). */
export function openBelow(folders, base = "") {
  return [...folders].filter(path => path !== base && (!base || path.startsWith(base + "/")));
}

/** Listed sub-folders of `parents` that expand all may open, as full paths. */
export function childFolders(entries, parents, showHidden = false) {
  return parents.flatMap(parent => (entries.get(parent) ?? [])
    .filter(entry => entry.dir && !AUTO_SKIP.has(entry.name) && visibleEntry(entry.name, showHidden))
    .map(entry => parent ? `${parent}/${entry.name}` : entry.name));
}
