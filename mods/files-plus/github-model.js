// Bounded GitHub snapshots. This module never starts a program or changes a repository.
export const GITHUB_LIMITS = { prs: 40, checks: 150, threads: 50, json: 1200000, body: 12000, log: 64000 };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sha = value => typeof value === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value);
const text = (value, limit, label, optional = false) => {
  if (optional && value == null) return "";
  if (typeof value !== "string" || value.length > limit || value.includes("\0")) throw new Error(`GitHub returned an invalid ${label}.`);
  return value;
};
export function githubContext(value = {}) {
  const root = value.root ?? value.cwd;
  if (typeof root !== "string" || !/^(?:\/|[A-Za-z]:[\\/])/.test(root) || root.length > 4096 || /[\x00-\x1f\x7f]/.test(root)) throw new Error("Choose an absolute repository folder before opening Pull requests.");
  const on = value.on == null || value.on === "" ? null : value.on;
  if (on !== null && (typeof on !== "string" || on.length > 200 || /[\s/\x00-\x1f\x7f]/.test(on))) throw new Error("The captured machine name is invalid.");
  return { root, on };
}
export function githubJson(raw) {
  if (typeof raw !== "string" || raw.length > GITHUB_LIMITS.json) throw new Error("GitHub output exceeded the bounded preview limit.");
  try { return JSON.parse(raw); } catch { throw new Error("GitHub returned malformed JSON. Previous data was retained."); }
}
export function githubRepo(value) {
  if (!object(value) || typeof value.nameWithOwner !== "string" || (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.nameWithOwner) || value.nameWithOwner.split("/").some(part => part === "." || part === ".."))) throw new Error("GitHub did not identify a repository.");
  const match = /^https:\/\/([A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]{1,5})?)\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/?$/.exec(value.url || "");
  if (!match || match[2].toLowerCase() !== value.nameWithOwner.toLowerCase()) throw new Error("GitHub returned an unverified repository URL.");
  const host = match[1].toLowerCase(), [owner, name] = value.nameWithOwner.split("/");
  return { nameWithOwner: value.nameWithOwner, host, owner, name, url: `https://${host}/${value.nameWithOwner}`, spec: `${host}/${value.nameWithOwner}` };
}
export function githubUrl(value, repo) {
  if (typeof value !== "string" || value.length > 3000 || /[\s\\\x00-\x1f\x7f]/.test(value)) return null;
  const match = /^https:\/\/([^/?#]+)(\/[^?#]*)(?:[?#].*)?$/.exec(value);
  if (!match || match[1].toLowerCase() !== repo.host || !match[2].startsWith(`/${repo.nameWithOwner}/`) || /(?:^|\/)\.{1,2}(?:\/|$)|%2f|%5c|%2e/i.test(match[2])) return null;
  return value;
}
export function githubPr(value, repo) {
  if (!object(value) || !Number.isSafeInteger(value.number) || value.number < 1 || !["OPEN", "CLOSED", "MERGED"].includes(value.state) || typeof value.isDraft !== "boolean" || !sha(value.headRefOid)) throw new Error("GitHub returned an invalid pull request.");
  const url = githubUrl(value.url, repo);
  if (url !== `${repo.url}/pull/${value.number}`) throw new Error("GitHub returned a pull request outside the captured repository.");
  const reviewDecision = value.reviewDecision ?? "";
  if (!["", "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(reviewDecision)) throw new Error("GitHub returned an unknown review decision.");
  return { number: value.number, title: text(value.title, 1000, "PR title"), url, state: value.state, isDraft: value.isDraft,
    headRefName: text(value.headRefName, 1000, "head branch"), baseRefName: text(value.baseRefName, 1000, "base branch"), headRefOid: value.headRefOid,
    reviewDecision, updatedAt: text(value.updatedAt, 100, "updated time"), mergeStateStatus: text(value.mergeStateStatus, 100, "merge state", true),
    body: text(value.body, GITHUB_LIMITS.body, "PR description", true), bodyTruncated: value.bodyTruncated === true };
}
export function githubList(values, current, branch, repo) {
  if (!Array.isArray(values) || values.length > GITHUB_LIMITS.prs || !Array.isArray(current) || current.length > 1) throw new Error("GitHub returned an invalid pull request list.");
  text(branch, 1000, "current branch");
  const prs = [...current, ...values].map(value => githubPr(value, repo));
  return prs.filter((pr, index) => prs.findIndex(other => other.number === pr.number) === index).slice(0, GITHUB_LIMITS.prs);
}
export function githubChecks(values, repo) {
  if (values == null) return [];
  if (!Array.isArray(values) || values.length > GITHUB_LIMITS.checks) throw new Error("GitHub returned an invalid check list.");
  return values.map((check, index) => {
    if (!object(check) || !["CheckRun", "StatusContext"].includes(check.__typename)) throw new Error("GitHub returned an unsupported check record.");
    const state = check.__typename === "CheckRun" ? check.status === "COMPLETED" ? check.conclusion : check.status : check.state;
    if (typeof state !== "string") throw new Error("GitHub returned an incomplete check state.");
    const status = ["SUCCESS"].includes(state) ? "passed" : ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(state) ? "failed"
      : ["QUEUED", "PENDING", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED", "PENDING_DEPLOYMENT"].includes(state) ? "pending" : ["NEUTRAL", "SKIPPED"].includes(state) ? "skipped" : state === "CANCELLED" ? "cancelled" : "unknown";
    return { index, name: text(check.name ?? check.context, 1000, "check name"), status, state, url: githubUrl(check.detailsUrl ?? check.targetUrl, repo),
      workflow: text(check.workflowName, 300, "workflow name", true) };
  });
}
export function githubCounts(checks) {
  const counts = { passed: 0, failed: 0, pending: 0, skipped: 0, cancelled: 0, unknown: 0 };
  for (const check of checks) counts[check.status]++;
  return counts;
}
export function githubThreads(value, repo, pr) {
  if (!object(value) || value.headRefOid !== pr.headRefOid || value.number !== pr.number) throw new Error("The PR head changed while details were loading. Refresh to read one consistent version.");
  if (!Array.isArray(value.threads) || value.threads.length > GITHUB_LIMITS.threads || typeof value.hasNextPage !== "boolean") throw new Error("GitHub returned invalid review threads.");
  return { limited: value.hasNextPage, threads: value.threads.filter(thread => {
    if (!object(thread) || typeof thread.isResolved !== "boolean" || typeof thread.isOutdated !== "boolean") throw new Error("GitHub returned an incomplete review thread.");
    return !thread.isResolved;
  }).map((thread, index) => ({ index, path: text(thread.path, 2000, "thread path"), line: Number.isSafeInteger(thread.line) && thread.line > 0 ? thread.line : null,
    outdated: thread.isOutdated, body: text(thread.body, 2000, "thread excerpt", true), truncated: thread.bodyTruncated === true,
    author: text(thread.author, 100, "thread author", true), url: githubUrl(thread.url, repo) })) };
}
export function githubLogTarget(check, repo) {
  if (check?.status !== "failed" || !githubUrl(check.url, repo)) return null;
  const prefix = `${repo.url}/actions/runs/`;
  if (!check.url.startsWith(prefix)) return null;
  const match = /^(\d+)(?:\/job\/(\d+))?(?:[?#].*)?$/.exec(check.url.slice(prefix.length));
  return match && match[1].length <= 20 && (!match[2] || match[2].length <= 20) ? { run: match[1], job: match[2] || null } : null;
}
export function githubSummary(repo, detail, stale = false) {
  const { pr, counts, threads } = detail;
  const lines = [`PR ${repo.nameWithOwner}#${pr.number}: ${pr.title}`, pr.url, `Head: ${pr.headRefOid}`, `${pr.headRefName} → ${pr.baseRefName} · ${pr.isDraft ? "Draft" : pr.state} · ${pr.reviewDecision || "No review decision"}`,
    `Checks: ${counts.passed} passed, ${counts.failed} failed, ${counts.pending} pending, ${counts.skipped} skipped, ${counts.cancelled} cancelled, ${counts.unknown} unknown.`, ...(stale ? ["This is a retained stale snapshot; verify current GitHub state before acting."] : []), ""];
  if (pr.body) lines.push("Description excerpt:", pr.body.slice(0, 1600), "");
  const failures = detail.checks.filter(check => check.status === "failed").slice(0, 20);
  if (failures.length) lines.push("Failed checks:", ...failures.map(check => `- ${check.name.slice(0, 150)}: ${check.state}${check.url ? ` · ${check.url}` : ""}`), "");
  if (threads.length) lines.push("Unresolved thread excerpts:", ...threads.slice(0, 8).map(thread => `- ${thread.path.slice(0, 150)}${thread.line ? `:${thread.line}` : ""}: ${thread.body.slice(0, 250)}`));
  if (detail.threadsLimited || detail.checksLimited) lines.push("The snapshot is bounded; more checks or review threads may exist.");
  return lines.join("\n").slice(0, 11000);
}
export function githubError(error, program = "gh") {
  const message = String(error?.message || error || "GitHub read failed.");
  if (error?.code === "ENOENT" || /program not found|not installed|not recognized|cannot start .*no such file/i.test(message)) return `${program === "git" ? "Git" : program === "node" ? "Node.js" : "GitHub CLI (gh)"} is unavailable on the captured machine. No installation or login was started.`;
  if (/auth login|not logged|authentication|bad credentials|HTTP 401|token.*invalid/i.test(message)) return "GitHub CLI is not authenticated on the captured machine. Use its existing login when you choose to configure it; this panel does not start login.";
  if (/timed? out|timeout/i.test(message)) return "GitHub read timed out. Previous data was retained; use Refresh to try again.";
  return message.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").slice(0, 500);
}
