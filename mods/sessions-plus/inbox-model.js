export const INBOX_DISMISSED = "sessions-plus.inbox-dismissed";
export const INBOX_GROUPS = [
  { status: "blocked", label: "Needs you" }, { status: "done", label: "Finished" }, { status: "working", label: "Working" },
];
const reliableSequence = agent => Number.isFinite(agent.seq) && agent.seq > 0;
export function inboxStamp(agent, terminals = []) {
  const terminal = terminals.find(item => item.address === agent.address);
  return JSON.stringify([Number(terminal?.created_ms) || 0, Number(agent.seq) || 0, agent.status, reliableSequence(agent) ? "" : [agent.title || "", agent.app || ""]]);
}
export function inboxRows(agents, terminals = [], dismissed = {}, now = Date.now()) {
  const saved = dismissed && typeof dismissed === "object" && !Array.isArray(dismissed) ? dismissed : {};
  return agents.filter(agent => {
    const terminal = terminals.find(item => item.address === agent.address);
    return typeof agent.address === "string" && (!terminal?.state || terminal.state === "live") && INBOX_GROUPS.some(group => group.status === agent.status);
  }).map(agent => {
    const stamp = inboxStamp(agent, terminals), entry = saved[agent.address];
    const handled = reliableSequence(agent) ? entry === stamp : entry?.stamp === stamp && Number(entry.expires) > now;
    return { ...agent, stamp, dismissed: Boolean(handled), temporaryDismiss: !reliableSequence(agent) };
  }).sort((a, b) => (Number(b.seq) || 0) - (Number(a.seq) || 0));
}
export function dismissUpdate(row, agents, terminals, dismissed, restore = false, now = Date.now()) {
  const current = inboxRows(agents, terminals, {}, now).find(agent => agent.address === row.address);
  if (!current || current.stamp !== row.stamp) return null;
  const saved = dismissed && typeof dismissed === "object" && !Array.isArray(dismissed) ? dismissed : {};
  const next = Object.fromEntries(agents.filter(agent => typeof saved[agent.address] === "string" || saved[agent.address]?.stamp).map(agent => [agent.address, saved[agent.address]]));
  if (restore) delete next[row.address];
  else next[row.address] = current.temporaryDismiss ? { stamp: row.stamp, expires: now + 60000 } : row.stamp;
  return next;
}
