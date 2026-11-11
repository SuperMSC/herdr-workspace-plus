// Review state is scoped to a machine and checkout. Anchors keep their original source.
export const REVIEW_KEY = "files-plus.review.v1";
export const REVIEW_LIMIT = 100, COMMENT_LIMIT = 4000, MESSAGE_LIMIT = 60000;
export const reviewKey = context => JSON.stringify([context.on ?? null, context.root]);
export const reviewFileKey = file => JSON.stringify([file.section || "unstaged", file.commit || "", file.parents || [], file.path]);
export const reviewState = (value, context) => value?.repositories?.[reviewKey(context)] || { comments: [], viewed: {} };
export function saveReview(value, context, next) {
  const repositories = { ...(value?.repositories || {}), [reviewKey(context)]: { ...next, updated: Date.now() } };
  const keys = Object.keys(repositories).sort((a, b) => (repositories[b].updated || 0) - (repositories[a].updated || 0));
  for (const key of keys.slice().reverse()) {
    if (Object.keys(repositories).length <= 40) break;
    if (!(repositories[key].comments || []).length && !repositories[key].message && !repositories[key].delivery && key !== reviewKey(context)) delete repositories[key];
  }
  if (Object.keys(repositories).length > 40) throw new Error("Review storage has 40 projects with saved drafts. Remove unneeded review comments before starting another project.");
  return { repositories };
}
export function anchorFor(file, version, rows, selection = null) {
  if (!file?.path || !version) throw new Error("Refresh this file before commenting.");
  const side = selection?.side || "file", start = selection?.start ?? null, end = selection?.end ?? start;
  if (side !== "file" && (!["before", "after"].includes(side) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)) throw new Error("Select a valid line or range.");
  const field = side === "before" ? "old" : "next";
  const selected = side === "file" ? [] : rows.filter(row => Number.isSafeInteger(row[field]) && row[field] >= start && row[field] <= end);
  if (side !== "file" && !selected.length) throw new Error("Selected lines are no longer available.");
  const fullSnippet = selected.map(row => `${row[field]}: ${row.text}`).join("\n");
  const snippet = selected.slice(0, 40).map(row => `${row[field]}: ${row.text}`).join("\n").slice(0, 6000);
  return { excerptLimited: selected.length > 40 || fullSnippet.length > 6000, file: { path: file.path, section: file.section, commit: file.commit, parents: file.parents }, version, side, start, end, snippet };
}
export function validateReviewAnchor(anchor) {
  const file = anchor?.file;
  const path = file?.path;
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor) || !file || typeof file !== "object" || Array.isArray(file)
      || typeof path !== "string" || !path || path.startsWith("/") || path.includes("\0") || path.split("/").some(part => !part || part === "." || part === "..")
      || !["staged", "unstaged", "history"].includes(file.section)
      || typeof anchor.version !== "string" || !anchor.version.trim() || anchor.version.length > 16384 || anchor.version.includes("\0")
      || !["file", "before", "after"].includes(anchor.side) || typeof anchor.snippet !== "string" || anchor.snippet.length > 6000) throw new Error("This comment has no valid file, source version or line anchor. Reopen the diff and select it again.");
  if (file.section === "history" && (!/^[a-f0-9]{40,64}$/.test(file.commit || "") || !Array.isArray(file.parents)
      || file.parents.some(parent => typeof parent !== "string" || !/^[a-f0-9]{40,64}$/.test(parent)))) throw new Error("This comment has an invalid commit source. Reopen the history diff.");
  if (anchor.side === "file") {
    if (anchor.start != null || anchor.end != null) throw new Error("A whole-file comment cannot contain a line range.");
  } else if (!Number.isSafeInteger(anchor.start) || !Number.isSafeInteger(anchor.end) || anchor.start < 1 || anchor.end < anchor.start || !anchor.snippet) {
    throw new Error("This comment has no valid original line range or code excerpt.");
  }
  return anchor;
}
export function addReviewComment(state, anchor, text, id = null) {
  const body = String(text).trim();
  if (!body || body.length > COMMENT_LIMIT) throw new Error(`Comments must contain 1–${COMMENT_LIMIT} characters.`);
  const editing = id !== null && id !== undefined;
  if (!editing && (state.comments || []).length >= REVIEW_LIMIT) throw new Error(`This draft has reached ${REVIEW_LIMIT} comments.`);
  if (editing && (typeof id !== "string" || !id || !(state.comments || []).some(comment => comment.id === id))) throw new Error("This comment was removed in another view. Reopen the review.");
  if (state.delivery) throw new Error("This review is locked by a delivery attempt. Copy it or explicitly unlock sending first.");
  validateReviewAnchor(anchor);
  const comment = { ...anchor, id: id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, text: body, updated: Date.now() };
  return { ...state, message: state.message ?? null, messageStale: Boolean(state.message != null || state.messageStale), comments: editing ? (state.comments || []).map(old => old.id === id ? comment : old) : [...(state.comments || []), comment] };
}
export const viewedVersion = (state, file, version) => Boolean(version && state.viewed?.[reviewFileKey(file)] === version);
export function setViewed(state, file, version, enabled) {
  if (!version) throw new Error("Refresh this file before marking it viewed.");
  const viewed = { ...(state.viewed || {}) };
  if (enabled) viewed[reviewFileKey(file)] = version; else delete viewed[reviewFileKey(file)];
  const keys = Object.keys(viewed);
  if (keys.length > 1000) for (const key of keys.slice(0, keys.length - 1000)) delete viewed[key];
  return { ...state, viewed };
}
export function commentLabel(comment) {
  const range = comment.side === "file" ? "whole file" : `${comment.side} ${comment.start}${comment.end !== comment.start ? `–${comment.end}` : ""}`;
  return `${comment.file.path} · ${comment.file.section}${comment.file.commit ? ` ${comment.file.commit.slice(0, 8)}` : ""} · ${range}`;
}
export function reviewMessage(state, context, versions = {}) {
  return [`Please address this code review. Repository: ${context.root}${context.on ? ` (${context.on})` : ""}`, "", ...(state.comments || []).flatMap((comment, index) => {
    const outdated = versions[reviewFileKey(comment.file)] !== comment.version;
    return [`${index + 1}. ${commentLabel(comment)}${outdated ? " [OUTDATED / source not verified]" : ""}`, `Source version: ${comment.version}`, ...(comment.snippet ? [comment.excerptLimited ? "Original code excerpt (bounded to 40 visible lines / 6,000 characters):" : "Original code:", ...comment.snippet.split("\n").map(line => `> ${line}`)] : []), `Feedback: ${comment.text}`, ""];
  })].join("\n");
}
export function reviewTarget(agent, terminal) {
  if (!agent || !terminal || terminal.state !== "live" || agent.address !== terminal.address) return null;
  // A reused terminal or a changed foreground command must not inherit a chosen recipient.
  const identity = JSON.stringify([terminal.address, terminal.identity ?? null, terminal.created_ms ?? null, terminal.pid ?? null, terminal.foreground?.pid ?? null, terminal.foreground?.argv ?? terminal.argv ?? [], agent.app, agent.space, agent.tab]);
  return { address: agent.address, identity, title: agent.title || agent.tab_name || agent.program?.name || agent.address, space: agent.space_name || agent.space, status: agent.status };
}
export function reviewTargets(agentList, terminalList, machine = null) {
  return agentList.filter(agent => (agent.address.includes("/") ? agent.address.split("/")[0] : null) === (machine ?? null))
    .map(agent => reviewTarget(agent, terminalList.find(terminal => terminal.address === agent.address))).filter(Boolean);
}
export function validateReviewTarget(selected, agentList, terminalList, machine = null) {
  const current = reviewTargets(agentList, terminalList, machine).find(target => target.address === selected?.address);
  if (!current || current.identity !== selected.identity) throw new Error("The selected agent changed or exited. Choose it again.");
  if (!["idle", "done"].includes(current.status)) throw new Error("Wait until this agent is idle. Blocked agents may be showing a permission prompt.");
  return current;
}

export function validateReviewCoreTarget(selected, agentList, terminalList, fresh, machine = null) {
  validateReviewTarget(selected, agentList, terminalList, machine);
  const agent = agentList.find(row => row.address === selected.address), bare = selected.address.split("/").pop();
  if (!fresh || ![selected.address, bare].includes(fresh.address) || fresh.state !== "live" || fresh.reported === false) throw new Error("Core could not verify the receiving agent.");
  const status = typeof fresh.status === "string" ? fresh.status : fresh.status?.state;
  if (status !== "idle") throw new Error("Core reports that the receiving agent is not idle.");
  const target = reviewTarget({ ...agent, app: fresh.status?.app ?? agent.app, status }, { ...fresh, address: selected.address });
  if (!target || target.identity !== selected.identity) throw new Error("The receiving terminal changed. Choose the agent again.");
  return target;
}
export function reviewSendAcknowledged(result) {
  if (result?.code !== 0) return false;
  try {
    const body = JSON.parse(result.stdout);
    return Boolean(body && typeof body === "object" && !Array.isArray(body) && !body.error && Number.isSafeInteger(body.turn) && body.turn >= 0);
  } catch { return false; }
}
