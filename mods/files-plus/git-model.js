// Pure Git presentation helpers. Paths remain literal, including tabs and newlines.
export const PAGE_SIZE = 50;
export const FILE_LIMIT = 1000;
export const fileKey = file => `${file.section || "unstaged"}\0${file.commit || ""}\0${file.path}`;

export function numstat(text) {
  const stats = Object.create(null);
  for (const entry of text.split("\0")) {
    const first = entry.indexOf("\t"), second = entry.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const add = entry.slice(0, first), del = entry.slice(first + 1, second);
    stats[entry.slice(second + 1)] = { add: Number(add) || 0, del: Number(del) || 0, binary: add === "-" || del === "-" };
  }
  return stats;
}

export function statusFiles(text, staged = {}, unstaged = {}) {
  const entries = text.split("\0").filter(Boolean), files = [];
  for (const entry of entries.slice(0, FILE_LIMIT)) {
    const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
    const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
    if (xy === "!!") continue;
    const base = { path, xy, fresh, deleted: xy[1] === "D" || (xy[0] === "D" && xy[1] === " ") };
    if (!fresh && !conflict && ![" ", "?", "!"].includes(xy[0])) {
      files.push({ ...base, section: "staged", status: xy[0], add: 0, del: 0, ...staged[path] });
    }
    if (fresh || conflict || xy[1] !== " ") {
      files.push({ ...base, section: "unstaged", status: conflict ? "U" : fresh ? "A" : xy[1], add: 0, del: 0, ...unstaged[path] });
    }
  }
  return { files, limited: entries.length > FILE_LIMIT, count: Math.min(entries.length, FILE_LIMIT) };
}

export function branchInfo(text) {
  const result = { name: "", oid: "", upstream: "", ahead: 0, behind: 0 };
  for (const line of text.split("\n")) {
    if (line.startsWith("# branch.head ")) result.name = line.slice(14);
    if (line.startsWith("# branch.oid ")) result.oid = line.slice(13);
    if (line.startsWith("# branch.upstream ")) result.upstream = line.slice(18);
    const counts = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
    if (counts) { result.ahead = +counts[1]; result.behind = +counts[2]; }
  }
  if (result.name === "(detached)") result.name = `Detached ${result.oid.slice(0, 8)}`;
  result.unborn = result.oid === "(initial)";
  return result;
}

export function parseHistory(text) {
  const fields = text.split("\0"), commits = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    const hash = fields[i].replace(/^\n/, "");
    if (!/^[a-f0-9]{40,64}$/.test(hash)) continue;
    commits.push({ hash, parents: fields[i + 1].split(" ").filter(Boolean), author: fields[i + 2], time: Number(fields[i + 3]), subject: fields[i + 4] });
  }
  return commits;
}

export function commitFiles(text, stats, commit) {
  const fields = text.split("\0"), files = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i], path = fields[i + 1];
    if (!status || !path) continue;
    files.push({ path, status, section: "history", commit: commit.hash, parents: commit.parents, add: 0, del: 0, ...stats[path] });
  }
  return files;
}

export function fileTree(files, collapsed = new Set()) {
  const result = [], root = { directories: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/"); let node = root, path = "";
    for (const part of parts.slice(0, -1)) {
      path = path ? `${path}/${part}` : part;
      if (!node.directories.has(part)) node.directories.set(part, { name: part, path, directories: new Map(), files: [] });
      node = node.directories.get(part);
    }
    node.files.push(file);
  }
  const visit = (node, depth) => {
    for (const directory of [...node.directories.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const key = `${files[0]?.section || ""}:${directory.path}`;
      result.push({ directory: true, name: directory.name, path: directory.path, key, depth, collapsed: collapsed.has(key) });
      if (!collapsed.has(key)) visit(directory, depth + 1);
    }
    for (const file of node.files.sort((a, b) => a.path.localeCompare(b.path))) result.push({ ...file, depth });
  };
  visit(root, 0);
  return result;
}

export function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map(line => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, old: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, next: next++, text: line.slice(1) || " " };
    if (kind === " ") return { kind, old: old++, next: next++, text: line.slice(1) || " " };
    return { kind: "", text: line };
  });
}

// Both sides share one virtual row and scroll container, so they cannot drift.
export function splitRows(rows) {
  const result = [];
  for (let i = 0; i < rows.length;) {
    const row = rows[i];
    if (row.kind === "-" || row.kind === "+") {
      const before = [], after = [], notes = new Set();
      while (i < rows.length && (["-", "+"].includes(rows[i].kind) || rows[i].text.startsWith("\\ No newline at end of file"))) {
        if (["-", "+"].includes(rows[i].kind)) (rows[i].kind === "-" ? before : after).push(rows[i]);
        else notes.add(rows[i - 1]?.kind === "-" ? "Before" : "After");
        i++;
      }
      for (let j = 0; j < Math.max(before.length, after.length); j++) result.push({ before: before[j], after: after[j] });
      if (notes.size) result.push({ header: { kind: "", text: `${[...notes].join(" / ")}: no newline at end of file` } });
    } else { result.push(row.kind === " " ? { before: row, after: row } : { header: row }); i++; }
  }
  return result;
}

/** Keys of every folder `fileTree` would show for these files, folded or not. */
export function treeFolders(files) {
  return fileTree(files).filter(row => row.directory).map(row => row.key);
}

/** Tabs to spaces at `size` stops, so columns line up in a monospace cell. */
export function expandTabs(text, size = 4) {
  if (!text.includes("\t")) return text;
  let out = "";
  for (const char of text) out += char === "\t" ? " ".repeat(size - (out.length % size)) : char;
  return out;
}

/**
 * The changed span of a removed/added pair: common prefix and suffix are left out.
 * Returns `[[start, end], [start, end]]` for before and after, or null when nothing
 * is shared (the whole line is the change) or nothing differs.
 */
export function lineMarks(before, after) {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before[start] === after[start]) start++;
  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  // Whitespace alone in common says nothing; marking the whole line would say nothing either.
  if (!before.slice(0, start).trim() && !before.slice(before.length - end).trim()) return null;
  return [[start, before.length - end], [start, after.length - end]];
}

const indentOf = text => text.length - text.trimStart().length;

/**
 * Split rows ready to draw: tabs expanded, each hunk's common indentation removed
 * (relative indentation stays), and changed spans marked on paired lines. Cells are
 * copies; `splitRows` output and inline rows are left as they were.
 */
export function splitDisplay(split) {
  const result = [], hunk = [];
  const flush = () => {
    const texts = hunk.flatMap(row => [row.before, row.after]).filter(Boolean).map(cell => expandTabs(cell.text)).filter(text => text.trim());
    const indent = texts.length ? Math.min(...texts.map(indentOf)) : 0;
    for (const row of hunk) {
      const before = row.before && { ...row.before, text: expandTabs(row.before.text).slice(indent) || " " };
      const after = row.after === row.before ? before : row.after && { ...row.after, text: expandTabs(row.after.text).slice(indent) || " " };
      if (before && after && before !== after && before.kind === "-" && after.kind === "+") {
        const marks = lineMarks(before.text, after.text);
        if (marks) { before.mark = marks[0]; after.mark = marks[1]; }
      }
      result.push({ before, after, indent });
    }
    hunk.length = 0;
  };
  for (const row of split) {
    if (row.header) { flush(); result.push(row); }
    else hunk.push(row);
  }
  flush();
  return result;
}

/** Removed and added line counts of diff rows. */
export function diffCounts(rows) {
  let removed = 0, added = 0;
  for (const row of rows) { if (row.kind === "-") removed++; else if (row.kind === "+") added++; }
  return { removed, added };
}

/**
 * Inline rows ready to draw, the inline counterpart of `splitDisplay`: tabs expanded,
 * each hunk's common indentation removed, and the n-th removed line of a change block
 * paired with its n-th added line for changed-span marks. Rows are copies.
 */
export function inlineDisplay(rows) {
  const result = [], hunk = [];
  const flush = () => {
    const texts = hunk.map(row => expandTabs(row.text)).filter(text => text.trim());
    const indent = texts.length ? Math.min(...texts.map(indentOf)) : 0;
    const shown = hunk.map(row => ({ ...row, text: expandTabs(row.text).slice(indent) || " " }));
    for (let i = 0; i < shown.length;) {
      if (shown[i].kind !== "-") { i++; continue; }
      const removed = [], added = [];
      while (i < shown.length && shown[i].kind === "-") removed.push(shown[i++]);
      while (i < shown.length && shown[i].kind === "+") added.push(shown[i++]);
      for (let j = 0; j < Math.min(removed.length, added.length); j++) {
        const marks = lineMarks(removed[j].text, added[j].text);
        if (marks) { removed[j].mark = marks[0]; added[j].mark = marks[1]; }
      }
    }
    result.push(...shown);
    hunk.length = 0;
  };
  for (const row of rows) {
    if ([" ", "+", "-"].includes(row.kind)) hunk.push(row);
    else { flush(); result.push(row); }
  }
  flush();
  return result;
}
