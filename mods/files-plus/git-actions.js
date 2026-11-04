// Files Plus Git actions: explicit index changes for one captured local path.
function relativePath(path) {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\0") || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("A file path relative to the repository is required.");
  }
  return path;
}

/** Change only the selected path in a local macOS repository's index. */
export function createGitActions(executor, { root, on = null, platform = "macos" } = {}) {
  function localRepository() {
    if (on != null && on !== "") throw new Error("Git actions are unavailable for remote spaces.");
    if (platform !== "macos") throw new Error("Git actions currently require macOS.");
    if (typeof root !== "string" || !root.startsWith("/") || root.includes("\0")) throw new Error("An absolute repository folder is required.");
  }

  async function git(args, allowMissingHead = false) {
    const result = await executor("git", ["--literal-pathspecs", ...args], { cwd: root, on: null });
    if (!result || (result.code !== 0 && !(allowMissingHead && result.code === 1))) {
      throw new Error((result?.stderr || result?.stdout || "Git action failed.").trim());
    }
    return result;
  }

  return {
    async stage(path) {
      localRepository();
      const selected = relativePath(path);
      await git(["add", "--", selected]);
      return selected;
    },
    async unstage(path) {
      localRepository();
      const selected = relativePath(path);
      const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], true);
      if (head.code === 0) await git(["restore", "--source=HEAD", "--staged", "--", selected]);
      // There is no HEAD tree in an unborn repository. Remove just this index entry;
      // --cached preserves its working file even when it differs from the index.
      else await git(["rm", "--cached", "-f", "--ignore-unmatch", "--", selected]);
      return selected;
    },
  };
}
