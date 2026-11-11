import { HUNK_READ, HUNK_DIFF, hunkPath, hunkFileAllowed, hunkVersion, patchHunks } from "./hunk-model.js";

// Captures the same complete versions around the exact canonical Git patch.
export async function readHunkSource(execute, { root, on = null }, file) {
  hunkPath(file?.path);
  if (!hunkFileAllowed(file)) throw new Error("Hunk actions are available only for modified text files.");
  const git = async args => {
    const result = await execute("git", [...HUNK_READ, ...args], { cwd: root, on });
    if (result?.code !== 0) throw new Error((result?.stderr || "Cannot read hunk source.").trim());
    return result.stdout;
  };
  const version = async () => {
    const [head, index, work] = await Promise.all([
      git(["rev-parse", "--verify", "HEAD"]), git(["ls-files", "--stage", "-z", "--", file.path]), git(["hash-object", "--no-filters", "--", file.path]),
    ]);
    const entry = /^(100(?:644|755)) ([a-f0-9]{40,64}) 0\t([\s\S]*)\0$/.exec(index);
    if (!entry || entry[3] !== file.path) throw new Error("Hunk actions require one regular tracked file without conflicts.");
    return hunkVersion(head.trim(), index, work.trim());
  };
  const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=no", "--", file.path]);
  if (status.slice(3, -1) !== file.path || status[file.section === "staged" ? 0 : 1] !== "M" || !/^[ M]{2}$/.test(status.slice(0, 2))) throw new Error("This file's Git state changed. Refresh before using hunk actions.");
  const before = await version();
  const patch = await git(["diff", ...(file.section === "staged" ? ["--cached"] : []), ...HUNK_DIFF, "--", file.path]);
  const after = await version();
  if (before !== after) throw new Error("This file changed while its patch was being read. Refresh before using hunk actions.");
  return { file: { path: file.path, section: file.section, status: "M" }, version: after, hunks: patchHunks(patch), patch };
}
