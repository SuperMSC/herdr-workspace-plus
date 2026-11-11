// Core parent links are the only relationship evidence; names and folders never imply ancestry.
export const LINEAGE_LIMIT = 200;
const clean = (value, limit = 160) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, limit) : "";
export const terminalMachine = address => address.includes("/") ? address.slice(0, address.lastIndexOf("/")) : null;
export function lineageIdentity(terminal) {
  const created = terminal.created_ms ?? terminal.created;
  return Number.isSafeInteger(created) && created > 0 ? JSON.stringify([terminal.address, created, terminal.parent || null]) : null;
}
export function lineageForest(terminals, agents = [], spaces = []) {
  const listed = Array.isArray(terminals) ? terminals : [], records = listed.filter(row => row && typeof row.address === "string" && row.address && row.state === "live").slice(0, LINEAGE_LIMIT);
  const agentMap = new Map(agents.map(row => [row.address, row])), spaceMap = new Map(spaces.map(row => [row.id, row])), map = new Map();
  for (const terminal of records) {
    if (map.has(terminal.address)) continue;
    const agent = agentMap.get(terminal.address), on = terminalMachine(terminal.address), label = terminal.labels?.["herdr.space"], space = agent?.space || (label ? on ? `${on}/${label}` : label : null);
    let parent = typeof terminal.parent === "string" && terminal.parent ? terminal.parent : null;
    if (parent && !parent.includes("/") && on) parent = `${on}/${parent}`;
    const status = agent?.status || (typeof terminal.status === "string" ? terminal.status : "idle");
    map.set(terminal.address, { address: terminal.address, parent, identity: lineageIdentity(terminal), on, space,
      title: clean(agent?.title || terminal.title || terminal.name || terminal.program?.name || terminal.argv?.[0] || terminal.address),
      folder: clean(terminal.cwd, 2000), project: clean(agent?.space_name || spaceMap.get(space)?.name),
      status: ["working", "blocked", "done", "idle"].includes(status) ? status : "idle", agent: Boolean(agent || terminal.program?.agent), children: [], cycle: false });
  }
  // Linear cycle detection also handles malformed or self-parented core records.
  const done = new Set();
  for (const node of map.values()) {
    if (done.has(node.address)) continue;
    const trail = [], seen = new Set(); let cursor = node;
    while (cursor && !done.has(cursor.address)) {
      if (seen.has(cursor.address)) { cursor.cycle = true; cursor.parent = null; break; }
      seen.add(cursor.address); trail.push(cursor.address); cursor = map.get(cursor.parent);
    }
    for (const address of trail) done.add(address);
  }
  const roots = [];
  for (const node of map.values()) {
    const parent = map.get(node.parent);
    if (parent) parent.children.push(node); else { node.missingParent = Boolean(node.parent); roots.push(node); }
  }
  const compare = (a, b) => ({ blocked: 0, working: 1, done: 2, idle: 3 }[a.status] - { blocked: 0, working: 1, done: 2, idle: 3 }[b.status]) || a.address.localeCompare(b.address);
  roots.sort(compare); for (const node of map.values()) node.children.sort(compare);
  return { roots, nodes: map, limited: listed.filter(row => row?.state === "live").length > LINEAGE_LIMIT };
}
export function lineageRows(forest, { query = "", activeOnly = false, folded = new Set() } = {}) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean), wanted = new Set(), matches = new Set();
  for (const node of forest.nodes.values()) {
    if (activeOnly && !["working", "blocked"].includes(node.status)) continue;
    if (terms.length) {
      const text = [node.title, node.address, node.folder, node.project, node.on || "this computer"].join(" ").toLocaleLowerCase();
      if (!terms.every(term => text.includes(term))) continue;
    }
    matches.add(node.address); let cursor = node;
    while (cursor && !wanted.has(cursor.address)) { wanted.add(cursor.address); cursor = forest.nodes.get(cursor.parent); }
  }
  const out = [], stack = forest.roots.slice().reverse().map(node => ({ node, depth: 0 })), filtering = terms.length > 0 || activeOnly;
  while (stack.length) {
    const { node, depth } = stack.pop(); if (!wanted.has(node.address)) continue;
    out.push({ ...node, depth, contextOnly: !matches.has(node.address), folded: !filtering && folded.has(node.address) });
    if (filtering || !folded.has(node.address)) for (const child of node.children.slice().reverse()) stack.push({ node: child, depth: depth + 1 });
  }
  return out;
}
