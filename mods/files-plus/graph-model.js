// Bounded topology over captured commit IDs. This module never changes refs or files.
export const GRAPH_LIMIT = 200, GRAPH_REF_LIMIT = 500, GRAPH_LANES = 32;
export const graphHash = value => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const clean = (value, limit) => String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, limit);
export function parseGraphLog(text) {
  if (typeof text !== "string" || text.length > 700000) throw new Error("Git history exceeds the graph preview limit.");
  const fields = text.split("\0"), commits = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    const hash = fields[i].replace(/^\n/, ""), parents = fields[i + 1].split(" ").filter(Boolean), time = Number(fields[i + 3]);
    if (!graphHash(hash) || parents.some(hash => !graphHash(hash)) || !Number.isFinite(time)) throw new Error("Git returned invalid commit history.");
    commits.push({ hash, parents, author: clean(fields[i + 2], 200), time, subject: clean(fields[i + 4], 2000) });
    if (commits.length > GRAPH_LIMIT) break;
  }
  return { commits: commits.slice(0, GRAPH_LIMIT), limited: commits.length > GRAPH_LIMIT };
}
export function parseGraphRefs(text) {
  if (typeof text !== "string" || text.length > 700000) throw new Error("Git references exceed the graph preview limit.");
  const refs = [];
  for (const line of text.split("\n").filter(Boolean).slice(0, GRAPH_REF_LIMIT + 1)) {
    const [name, hash, peeled] = line.split("\0");
    if (!/^refs\/(?:heads|remotes|tags)\/[^\x00-\x1f\x7f]+$/.test(name) || !graphHash(hash) || peeled && !graphHash(peeled)) throw new Error("Git returned an invalid reference.");
    refs.push({ name, label: name.replace(/^refs\/(?:heads|remotes)\//, "").replace(/^refs\/tags\//, "tag: "), hash: peeled || hash });
  }
  return { refs: refs.slice(0, GRAPH_REF_LIMIT), limited: refs.length > GRAPH_REF_LIMIT };
}
export function graphRows(commits, refs = [], head = null) {
  if (!Array.isArray(commits) || commits.length > GRAPH_LIMIT) throw new Error("Graph commit limit exceeded.");
  const known = new Set(commits.map(commit => commit.hash)), slots = [], rows = [], seen = new Set();
  for (const commit of commits) {
    if (!graphHash(commit.hash) || seen.has(commit.hash) || !Array.isArray(commit.parents) || commit.parents.some(hash => !graphHash(hash) || hash === commit.hash || seen.has(hash))) throw new Error("Commit topology is invalid or out of order.");
    seen.add(commit.hash);
    let lane = slots.indexOf(commit.hash), incoming = lane >= 0;
    if (lane < 0) { lane = slots.indexOf(null); if (lane < 0) lane = slots.length; slots[lane] = commit.hash; }
    const before = slots.slice(), after = slots.slice(), edges = []; after[lane] = null;
    const parents = commit.parents.filter(hash => known.has(hash)), boundary = commit.parents.length - parents.length;
    for (const parent of parents) {
      let to = after.indexOf(parent);
      if (to < 0) { to = after[lane] === null ? lane : after.indexOf(null); if (to < 0) to = after.length; after[to] = parent; }
      edges.push({ from: lane, to, kind: "out" });
    }
    for (let i = 0; i < before.length; i++) if (before[i] && i !== lane) edges.push({ from: i, to: after.indexOf(before[i]), kind: "pass" });
    if (incoming) edges.push({ from: lane, to: lane, kind: "in" });
    while (after.length && after[after.length - 1] === null) after.pop();
    const width = Math.max(lane + 1, before.length, after.length);
    if (width > GRAPH_LANES) throw new Error("This history needs more than 32 graph lanes. Select a branch to narrow it.");
    rows.push({ ...commit, lane, width, edges, boundary, head: commit.hash === head, refs: refs.filter(ref => ref.hash === commit.hash).map(ref => ref.label).slice(0, 8) });
    slots.splice(0, slots.length, ...after);
  }
  return rows;
}
export function validateGraphData(data) {
  if (!data || typeof data.root !== "string" || !data.root || /[\0\r\n]/.test(data.root) || data.head !== null && !graphHash(data.head) || !Array.isArray(data.refs) || data.refs.length > GRAPH_REF_LIMIT) throw new Error("Git graph returned invalid repository data.");
  if (data.refs.some(ref => typeof ref.name !== "string" || !/^refs\/(heads|remotes|tags)\//.test(ref.name) || !graphHash(ref.hash) || typeof ref.label !== "string")) throw new Error("Git graph returned invalid branch data.");
  const rows = graphRows(data.commits, data.refs, data.head);
  return { ...data, rows, lanes: Math.max(1, ...rows.map(row => row.width)) };
}
