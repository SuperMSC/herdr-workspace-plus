import { hunkFileAllowed } from "./hunk-model.js";
import { readHunkSource } from "./hunk-reader.js";
import { PAGE_SIZE, numstat, statusFiles, branchInfo, parseHistory, commitFiles } from "./git-model.js";

// Read commands never refresh the index or invoke external diff/fsmonitor tools.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const DIFF = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"];
const hashOK = hash => typeof hash === "string" && /^[a-f0-9]{40,64}$/.test(hash);
const literalPath = path => typeof path === "string" && path.length > 0 && !path.includes("\0") && !path.startsWith("/") && !path.split("/").some(part => part === ".." || part === "");
const checked = result => { if (result.code !== 0) throw new Error((result.stderr || result.stdout || "Git read failed").trim()); return result.stdout; };

export function createGitReader(execute, readFile, { root, on = null }) {
  const git = args => execute("git", [...READ, "--literal-pathspecs", ...args], { cwd: root, on });
  const comparison = commit => {
    if (!hashOK(commit?.hash) || (commit.parents || []).some(parent => !hashOK(parent))) throw new Error("Invalid commit identifier");
    return commit.parents?.length ? ["diff", ...DIFF, commit.parents[0], commit.hash] : ["show", "--format=", "--root", ...DIFF, commit.hash];
  };
  return {
    async reviewVersion(file) {
      if (!literalPath(file?.path)) throw new Error("Invalid repository path");
      if (file.section === "history") {
        comparison({ hash: file.commit, parents: file.parents });
        return JSON.stringify(["history", file.commit, file.parents || [], file.path]);
      }
      const index = checked(await git(["ls-files", "--stage", "-z", "--", file.path]));
      if (file.section === "staged") {
        const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"]);
        if (head.code !== 0 && head.code !== 1) checked(head);
        return JSON.stringify(["staged", head.code === 0 ? head.stdout.trim() : "unborn", index]);
      }
      const work = await git(["hash-object", "--no-filters", "--", file.path]);
      if (work.code === 0 && /^[a-f0-9]{40,64}$/.test(work.stdout.trim())) return JSON.stringify(["unstaged", index, work.stdout.trim()]);
      // Absence is distinct from an unreadable file. Never call the latter viewed.
      let absent = false;
      try { absent = await readFile(`${root}/${file.path}`, { on }) === null; } catch { /* Report the original Git read failure. */ }
      if (absent && !file.fresh) return JSON.stringify(["unstaged", index, "deleted"]);
      throw new Error("Cannot verify this file's complete content version.");
    },
    async snapshot() {
      const results = await Promise.all([
        git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]),
        git(["diff", "--cached", ...DIFF, "--numstat", "-z"]),
        git(["diff", ...DIFF, "--numstat", "-z"]),
        git(["status", "--porcelain=v2", "--branch", "--untracked-files=no"]),
      ]);
      const [status, staged, unstaged, branch] = results.map(checked);
      return { ...statusFiles(status, numstat(staged), numstat(unstaged)), branch: branchInfo(branch) };
    },
    async history(offset = 0) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid history offset");
      const result = await git(["log", "--date-order", `--max-count=${PAGE_SIZE + 1}`, `--skip=${offset}`, "--format=%H%x00%P%x00%an%x00%at%x00%s%x00"]);
      if (result.code !== 0) {
        const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"]);
        if (head.code === 1) return { commits: [], more: false };
      }
      const commits = parseHistory(checked(result));
      return { commits: commits.slice(0, PAGE_SIZE), more: commits.length > PAGE_SIZE };
    },
    async files(commit) {
      const base = comparison(commit);
      const results = await Promise.all([git([...base, "--name-status", "-z"]), git([...base, "--numstat", "-z"])]);
      return commitFiles(checked(results[0]), numstat(checked(results[1])), commit);
    },
    // A whole commit as one diff: each file starts at its `diff --git` line; the
    // index/mode/---/+++ lines before its first hunk are left out.
    async commitDiff(commit) {
      const text = checked(await git(comparison(commit)));
      const lines = [];
      let header = false;
      for (const line of text.replace(/\n$/, "").split("\n")) {
        if (line.startsWith("diff --git ")) { lines.push(line); header = true; continue; }
        if (line.startsWith("@@")) header = false;
        if (header && !/^(Binary files|GIT binary patch)/.test(line)) continue;
        lines.push(line.length > 4000 ? `${line.slice(0, 4000)}… (line truncated)` : line);
        if (lines.length >= 4000) { lines.push("Preview truncated · showing the first 4,000 diff lines"); break; }
      }
      return { lines: lines.length ? lines : ["No text diff in this commit"] };
    },
    async diff(file) {
      if (!literalPath(file?.path)) throw new Error("Invalid repository path");
      let text, additions;
      if (file.fresh && file.section !== "staged" && file.section !== "history") {
        try { text = await readFile(`${root}/${file.path}`, { on }); }
        catch { throw new Error("File cannot be read as text (binary, over 1 MiB, or unreadable)"); }
        if (text === null) throw new Error("File no longer exists; refresh to update the list");
        if (typeof text !== "string") throw new Error("File cannot be read as text");
        if (text.includes("\0")) return { lines: ["Binary file · no text diff"] };
        additions = text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
        if (!text) return { lines: ["Empty untracked file"], additions: 0 };
        const content = text.slice(0, 400000).replace(/\n$/, "").split("\n");
        const lines = [`@@ -0,0 +1,${additions} @@`, ...content.slice(0, 1500).map(line => `+${line.length > 4000 ? `${line.slice(0, 4000)}… (line truncated)` : line}`)];
        if (content.length > 1500 || text.length > 400000) lines.push("Preview truncated · file exceeds the text preview limit");
        return { lines, additions };
      }
      let hunk = null, hunkError = null;
      if (!on && hunkFileAllowed(file)) {
        try { const source = await readHunkSource(execute, { root, on }, file); hunk = { file: source.file, version: source.version, hunks: source.hunks }; text = source.patch; }
        catch (error) { hunkError = String(error.message || error); }
      }
      if (text === undefined) {
        const args = file.section === "history" ? comparison({ hash: file.commit, parents: file.parents }) : ["diff", ...(file.section === "staged" ? ["--cached"] : []), ...DIFF];
        text = checked(await git([...args, "--", file.path]));
      }
      const all = text.replace(/\n$/, "").split("\n"), first = all.findIndex(line => line.startsWith("@@"));
      if (first < 0) return { lines: [/Binary files|GIT binary patch/.test(text) || file.binary ? "Binary file changed" : /[+-]{3}|mode|Subproject/.test(text) ? text.trim() : "No text diff available"] };
      const lines = all.slice(first, first + 2500).map(line => line.length > 4000 ? `${line.slice(0, 4000)}… (line truncated)` : line);
      if (all.length - first > 2500) lines.push("Preview truncated · showing the first 2,500 diff lines");
      return { lines, hunk, hunkError };
    },
  };
}
