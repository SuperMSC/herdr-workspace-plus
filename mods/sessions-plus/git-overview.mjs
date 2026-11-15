// Bounded local discovery and Git reads. Never fetches, stages, commits or changes branches.
import { execFile } from "node:child_process";
import { readdir, lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseGitStatus } from "./git-overview-model.js";
const execute = promisify(execFile);
const SKIP = new Set([".git", "node_modules", ".venv", "venv", "vendor", "dist", "build", "target", ".cache", ".Trash"]);
const exists = async path => Boolean(await lstat(path).catch(() => null));
async function git(path, args, timeout) {
  const result = await execute("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", path, ...args],
    { timeout, maxBuffer: 2000000, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
  return result.stdout;
}
export async function scanRepositories(options = {}) {
  if (!Array.isArray(options.roots) || options.roots.length > 12 || options.roots.some(root => typeof root !== "string" || !isAbsolute(root) || /[\0\r\n]/.test(root))) throw new Error("Choose up to 12 absolute local folders.");
  const depth = Math.min(6, Math.max(0, Number.isInteger(options.depth) ? options.depth : 4));
  const deadline = Date.now() + 20000, roots = [], warnings = [], seen = new Set(), repos = new Set();
  let visited = 0, limited = false;
  for (const root of options.roots) {
    try { const path = await realpath(root); if (!(await lstat(path)).isDirectory()) throw new Error("not a folder"); if (!roots.includes(path)) roots.push(path); }
    catch { warnings.push(`Cannot read folder: ${root}`); }
  }
  const queue = roots.map(path => ({ path, level: 0 }));
  while (queue.length) {
    if (Date.now() >= deadline || visited >= 4000 || repos.size >= 150) { limited = true; break; }
    const { path, level } = queue.shift(); if (seen.has(path)) continue; seen.add(path); visited++;
    const marker = await lstat(join(path, ".git")).catch(() => null);
    if (marker && !marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile())) { repos.add(path); continue; }
    if (level >= depth) continue;
    try { for (const item of await readdir(path, { withFileTypes: true })) if (item.isDirectory() && !SKIP.has(item.name) && !item.name.startsWith(".")) queue.push({ path: join(path, item.name), level: level + 1 }); }
    catch { warnings.push(`Cannot read folder: ${path}`); }
  }
  // A selected space may start inside a checkout rather than at its root.
  for (const root of roots) {
    if (Date.now() >= deadline) { limited = true; break; }
    try { const path = (await git(root, ["rev-parse", "--show-toplevel"], Math.min(1500, Math.max(1, deadline - Date.now())))).trim(); if (path && !/[\r\n]/.test(path)) repos.add(path); } catch { /* A base folder need not itself be a repository. */ }
  }
  const rows = [], pending = [...repos].slice(0, 150); if (repos.size > 150) limited = true;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (pending.length) {
      const path = pending.shift();
      if (Date.now() >= deadline) { limited = true; rows.push({ path, error: "Scan time limit reached" }); continue; }
      try {
        const output = await git(path, ["status", "--porcelain=v2", "-z", "--branch", "--show-stash", "--untracked-files=normal", "--ignore-submodules=all"], Math.min(4000, Math.max(1, deadline - Date.now())));
        const gitdir = (await git(path, ["rev-parse", "--absolute-git-dir"], Math.min(1500, Math.max(1, deadline - Date.now())))).trim();
        const operations = [];
        for (const [file, label] of [["MERGE_HEAD", "Merge in progress"], ["rebase-merge", "Rebase in progress"], ["rebase-apply", "Rebase/apply in progress"], ["CHERRY_PICK_HEAD", "Cherry-pick in progress"], ["REVERT_HEAD", "Revert in progress"], ["BISECT_LOG", "Bisect in progress"]]) if (await exists(join(gitdir, file))) operations.push(label);
        rows.push({ path, ...parseGitStatus(output), operations });
      } catch (error) { rows.push({ path, error: error.killed ? "Git read timed out" : String(error.stderr || error.message || error).trim().slice(0, 240) }); }
    }
  }));
  return { rows: rows.sort((a, b) => a.path.localeCompare(b.path)), roots, warnings: warnings.slice(0, 30), limited, visited, scannedAt: Date.now(), depth };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await scanRepositories(JSON.parse(process.argv[2] || "{}")))); }
  catch (error) { console.log(JSON.stringify({ error: String(error.message || error) })); process.exitCode = 1; }
}
