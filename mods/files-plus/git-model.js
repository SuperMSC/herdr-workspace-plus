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
