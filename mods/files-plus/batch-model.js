import { localActions } from "./model.js";
import { validRelative } from "./library-model.js";

export function batchTargets(targets) {
  if (!Array.isArray(targets) || !targets.length) throw new Error("Select at least one item.");
  if (targets.length > 100) throw new Error("Select at most 100 items per operation.");
  const first = targets[0], root = first.root?.replace(/\/+$/, "") || "/";
  for (const target of targets) {
    if (!localActions(target) || target.root !== first.root || target.on !== first.on)
      throw new Error("All selected items must belong to the same local macOS folder.");
    if (!validRelative(target.relative) || target.isRoot || target.path !== `${root === "/" ? "" : root}/${target.relative}`)
      throw new Error("The browser root or an invalid path cannot be transferred.");
  }
  // Selecting a directory already includes its descendants. Preserve visible order.
  return targets.filter((target, i) => targets.findIndex(t => t.path === target.path) === i &&
    !targets.some(parent => parent !== target && parent.dir && target.path.startsWith(`${parent.path}/`)));
}

export function batchDestination(value) {
  if (typeof value !== "string" || !value.startsWith("/") || /[\x00-\x1f\x7f]/.test(value) || value.split("/").some(p => p === "." || p === ".."))
    throw new Error("Enter an absolute destination folder path, without . or .. components.");
  return value.replace(/\/+$/, "") || "/";
}

export async function runBatch(targets, action, destination, fs, progress = () => {}) {
  if (!["copy", "move", "trash"].includes(action)) throw new Error("Unknown batch action.");
  const items = batchTargets(targets), folder = action === "trash" ? null : batchDestination(destination), results = [];
  for (const target of items) {
    try {
      const path = action === "trash" ? await fs.trash(target.path) : await fs[action](target.path, folder);
      results.push({ target, path, ok: true });
    } catch (error) { results.push({ target, ok: false, error: String(error.message ?? error) }); }
    progress([...results]);
  }
  return results;
}
