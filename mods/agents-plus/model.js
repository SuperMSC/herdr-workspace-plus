// Agent groups for the sidebar: priority sections or spaces, with pinned agents
// together at the top, split by space at the top, or at the top of their own group.

export const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
export const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
export const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };
export const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
export const PIN_MODES = [
  { id: "together", label: "Together at top", icon: "pin" },
  { id: "split", label: "Split by space", icon: "layers" },
  { id: "inline", label: "Inside groups", icon: "folder" },
];
export const SORT_KEY = "agents.sort";
export const PIN_KEY = "agents-plus.pinned";

export const sortOf = value => SORTS.find(s => s.id === value) ?? SORTS[0];
export const pinModeOf = value => PIN_MODES.find(m => m.id === value) ?? PIN_MODES[0];

// Groups keep the order their first member appears in, so a space split in two
// by sorting still reads as one group.
function collect(list, keyOf) {
  const groups = [], index = new Map();
  for (const a of list) {
    const key = keyOf(a);
    let group = index.get(key.id);
    if (!group) { group = { ...key, members: [] }; index.set(key.id, group); groups.push(group); }
    group.members.push(a);
  }
  return groups;
}

/**
 * Groups `{ id, label, status, pinned, space, members }` for agents already in display
 * order. `space` is set when the header names the space, so rows can leave it out.
 * `rankOf(a)` is the agent's urgency (its own or its most urgent sub-agent's).
 */
export function buildGroups(list, { byPriority, pins = "together", rankOf }) {
  const section = a => {
    if (!byPriority) return { id: `sp-${a.space}`, label: a.space_name || "", status: null, pinned: false, space: a.space };
    const r = rankOf(a) || RANK.idle;
    return { id: `sec-${r}`, label: SECTION[r], status: SECTION_STATUS[r] ?? null, pinned: false, space: null };
  };
  if (pins === "inline") {
    const groups = collect(list, section);
    for (const g of groups) g.members = [...g.members.filter(a => a.pinned), ...g.members.filter(a => !a.pinned)];
    return groups;
  }
  const pinned = list.filter(a => a.pinned), rest = list.filter(a => !a.pinned);
  const top = pins === "split"
    ? collect(pinned, a => ({ id: `pin-sp-${a.space}`, label: a.space_name || "", status: null, pinned: true, space: a.space }))
    : pinned.length ? [{ id: "pinned", label: "Pinned", status: null, pinned: true, space: null, members: pinned }] : [];
  return [...top, ...collect(rest, section)];
}

/** Agents in the order the groups show them, for agent.next / agent.prev. */
export const groupOrder = groups => groups.flatMap(g => g.members);

/** A kept sub-agent (one with a pane) is in agents() too: where a tree shows it
 *  (`nested`, its addresses), it gets no row of its own, unless it's pinned. */
export const dropNested = (list, nested) => list.filter(a => a.pinned || !nested.has(a.address));

/** How many listed agents each tab holds: a tab with several names each by its own title. */
export function countByTab(list) {
  const counts = new Map();
  for (const a of list) counts.set(a.tab, (counts.get(a.tab) ?? 0) + 1);
  return counts;
}
