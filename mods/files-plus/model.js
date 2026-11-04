// Pure menu/target helpers. Targets are captured before focus moves to an overlay.
export const CHANGE_KEY = "files-plus.change";

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

export function menuItems(target) {
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
    ...(localActions(target) ? [
      { id: "createFile", label: "New File…", separator: true },
      { id: "createFolder", label: "New Folder…" },
      ...(!target.isRoot ? [
        { id: "rename", label: "Rename…", separator: true },
        { id: "trash", label: "Move to Trash…", danger: true },
      ] : []),
    ] : []),
    { id: "refresh", label: "Refresh", separator: true },
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

export function menuHeight(target) {
  const items = menuItems(target);
  return 38 + items.length * 30 + items.filter(item => item.separator).length * 9 + 44;
}

export function applyPathChange(path, change) {
  if (path == null || !["rename", "trash"].includes(change.action)) return path;
  const old = change.target.relative;
  if (!old || (path !== old && !path.startsWith(`${old}/`))) return path;
  if (change.action === "trash") return null;
  const prefix = old.includes("/") ? old.slice(0, old.lastIndexOf("/") + 1) : "";
  return prefix + change.name + path.slice(old.length);
}
