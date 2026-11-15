export const GIT_OVERVIEW_KEY = "sessions-plus.git-overview.v1";

export function parseGitStatus(output) {
  const result = { branch: "", upstream: "", ahead: null, behind: null, staged: 0, modified: 0, untracked: 0, conflicts: 0, stash: 0 };
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (row.startsWith("# branch.head ")) result.branch = row.slice(14);
    else if (row.startsWith("# branch.upstream ")) result.upstream = row.slice(18);
    else if (row.startsWith("# branch.ab ")) { const counts = /^# branch\.ab \+(\d+) -(\d+)$/.exec(row); if (counts) { result.ahead = Number(counts[1]); result.behind = Number(counts[2]); } }
    else if (row.startsWith("# stash ")) result.stash = Number(row.slice(8)) || 0;
    else if (row.startsWith("? ")) result.untracked++;
    else if (row.startsWith("u ")) result.conflicts++;
    else if (/^[12] /.test(row)) {
      const xy = row.split(" ", 3)[1];
      if (xy?.[0] !== ".") result.staged++;
      if (xy?.[1] !== ".") result.modified++;
      if (row[0] === "2") i++; // The second NUL-delimited path belongs to this rename.
    }
  }
  return result;
}
export function repositoryNeedsAttention(row) {
  return Boolean(row.error || row.conflicts || row.staged || row.modified || row.untracked || row.stash || row.ahead || row.behind || row.operations?.length || !row.upstream);
}
export function repositorySummary(row) {
  if (row.error) return `Unavailable · ${row.error}`;
  const parts = [[row.conflicts, "conflicts"], [row.staged, "staged"], [row.modified, "modified"], [row.untracked, "untracked"], [row.stash, "stash"], [row.ahead, "ahead"], [row.behind, "behind"]]
    .filter(([count]) => count > 0).map(([count, name]) => `${count} ${name}`);
  parts.push(...(row.operations || []));
  if (!row.upstream) parts.push("No upstream");
  return parts.join(" · ") || "Clean · up to date with local refs";
}
export function overviewRows(rows, query = "", attention = true) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(row => (!attention || repositoryNeedsAttention(row)) && terms.every(term => `${row.path} ${row.branch} ${repositorySummary(row)}`.toLocaleLowerCase().includes(term)))
    .sort((a, b) => Number(Boolean(b.error || b.conflicts || b.operations?.length)) - Number(Boolean(a.error || a.conflicts || a.operations?.length)) || Number(repositoryNeedsAttention(b)) - Number(repositoryNeedsAttention(a)) || a.path.localeCompare(b.path));
}
