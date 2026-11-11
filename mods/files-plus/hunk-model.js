// Canonical one-file text patches. No shell interpolation and no working-tree writes.
export const HUNK_DIFF = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--full-index", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3", "--inter-hunk-context=0"];
export const HUNK_READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "--literal-pathspecs"];
export const HUNK_DIFF_LIMIT = 512000, HUNK_PATCH_LIMIT = 48000;
export function hunkBytes(text) {
  let bytes = 0;
  for (const char of text) { const point = char.codePointAt(0); bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4; }
  return bytes;
}
export function hunkFileAllowed(file) {
  return Boolean(file?.path && ["staged", "unstaged"].includes(file.section) && file.status === "M" && !file.fresh && !file.binary && !file.deleted && (!file.xy || /^[ M]{2}$/.test(file.xy)));
}
export function hunkPath(path) {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\0") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("A literal repository-relative file path is required.");
  return path;
}
export function patchHunks(text) {
  if (typeof text !== "string" || !text.endsWith("\n") || hunkBytes(text) > HUNK_DIFF_LIMIT) throw new Error("The full patch exceeds the hunk preview limit.");
  const lines = text.slice(0, -1).split("\n"), first = lines.findIndex(line => line.startsWith("@@ "));
  if (first < 0 || lines.filter(line => line.startsWith("diff --git ")).length !== 1) throw new Error("A complete, single-file text patch is required.");
  const header = lines.slice(0, first);
  if (!/^diff --git /.test(header[0]) || header.filter(line => line.startsWith("--- ")).length !== 1 || header.filter(line => line.startsWith("+++ ")).length !== 1 || !header.some(line => /^index [a-f0-9]{40,64}\.\.[a-f0-9]{40,64} 100(?:644|755)$/.test(line)) || header.some(line => /^(?:new file|deleted file|old mode|new mode|rename |copy |similarity |Binary |GIT binary)/.test(line))) throw new Error("Hunk actions require a normal modified text file without a mode change.");
  if (lines.length - first > 2500 || lines.some(line => line.length > 4000)) throw new Error("Hunk actions require a complete preview (up to 2,500 lines and 4,000 characters per line).");
  const hunks = [];
  for (let offset = first; offset < lines.length;) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(lines[offset]);
    if (!match) throw new Error("Malformed hunk header.");
    const start = offset++, oldCount = match[2] === undefined ? 1 : Number(match[2]), nextCount = match[4] === undefined ? 1 : Number(match[4]);
    let before = 0, after = 0;
    while (offset < lines.length && !lines[offset].startsWith("@@ ")) {
      const line = lines[offset++];
      if (line === "\\ No newline at end of file") continue;
      if (![" ", "+", "-"].includes(line[0])) throw new Error("Malformed hunk body.");
      if (line[0] !== "+") before++;
      if (line[0] !== "-") after++;
    }
    if (before !== oldCount || after !== nextCount) throw new Error("The patch is incomplete. Refresh before using hunk actions.");
    const patch = [...header, ...lines.slice(start, offset)].join("\n") + "\n";
    hunks.push({ index: hunks.length, header: lines[start], oldStart: Number(match[1]), oldCount, nextStart: Number(match[3]), nextCount,
      patch, enabled: hunkBytes(patch) <= HUNK_PATCH_LIMIT, reason: hunkBytes(patch) > HUNK_PATCH_LIMIT ? "This hunk exceeds the 48 KB action limit." : null });
  }
  return hunks;
}
export function hunkVersion(head, index, working) {
  if (!/^[a-f0-9]{40,64}$/.test(head) || !/^[a-f0-9]{40,64}$/.test(working)) throw new Error("Cannot verify complete hunk source versions.");
  return JSON.stringify([1, head, index, working]);
}
