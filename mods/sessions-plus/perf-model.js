// Herdr's own CPU and memory, read from `ps`, in the manner of Orca's resource manager.
//
// Herdr is the app process plus herdr-core (server and helpers). A terminal is a process
// herdr-core started that is not herdr-core itself; its whole process tree counts as that
// terminal. CPU is ps's decaying average; 100% is one core, so a sum can pass 100%.

export const PS_ARGS = ["-axo", "pid=,ppid=,%cpu=,rss=,comm="];
export const SAMPLE_EVERY = 5000;
export const OPEN_SAMPLE_EVERY = 2000;
export const HISTORY = 24;

const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "login", "pwsh", "-zsh", "-bash", "-sh", "-fish"]);
const base = comm => String(comm ?? "").trim().split("/").pop();
const isApp = name => /^herdr(-app)?$/i.test(name);
const isCore = name => name === "herdr-core";

/** Rows of `ps -axo pid=,ppid=,%cpu=,rss=,comm=`: rss is in KiB. */
export function parsePs(stdout) {
  const rows = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), cpu: Number(match[3]), rss: Number(match[4]) * 1024, name: base(match[5]) });
  }
  return rows;
}

const sum = (rows, field) => rows.reduce((total, row) => total + (Number.isFinite(row[field]) ? row[field] : 0), 0);

// The process that names a terminal: its biggest non-shell program, else its shell.
function terminalLabel(tree) {
  const programs = tree.filter(row => !SHELLS.has(row.name) && !isCore(row.name));
  const pick = (programs.length ? programs : tree).reduce((best, row) => !best || row.rss > best.rss ? row : best, null);
  return pick?.name ?? "terminal";
}

/**
 * `{ cpu, memory, app, core, terminals, herdr }` from ps rows, or null without a Herdr process.
 * memory is in bytes. `herdr` is the app plus herdr-core; the totals include terminals.
 */
export function usageSnapshot(rows) {
  const app = rows.filter(row => isApp(row.name));
  const core = rows.filter(row => isCore(row.name));
  if (!app.length && !core.length) return null;
  const kids = new Map();
  for (const row of rows) {
    if (!kids.has(row.ppid)) kids.set(row.ppid, []);
    kids.get(row.ppid).push(row);
  }
  const subtree = root => {
    const out = [], stack = [root], seen = new Set();
    while (stack.length) {
      const row = stack.pop();
      if (seen.has(row.pid)) continue;
      seen.add(row.pid); out.push(row);
      for (const kid of kids.get(row.pid) ?? []) if (!isCore(kid.name) && !isApp(kid.name)) stack.push(kid);
    }
    return out;
  };
  const corePids = new Set(core.map(row => row.pid));
  const terminals = rows.filter(row => corePids.has(row.ppid) && !isCore(row.name) && !isApp(row.name)).map(root => {
    const tree = subtree(root);
    return { pid: root.pid, label: terminalLabel(tree), shell: root.name, processes: tree.length, cpu: sum(tree, "cpu"), memory: sum(tree, "rss") };
  }).sort((a, b) => b.memory - a.memory || a.pid - b.pid);
  const group = list => ({ count: list.length, cpu: sum(list, "cpu"), memory: sum(list, "rss") });
  const appUse = group(app), coreUse = group(core);
  const herdr = { count: appUse.count + coreUse.count, cpu: appUse.cpu + coreUse.cpu, memory: appUse.memory + coreUse.memory };
  const termCpu = sum(terminals, "cpu"), termMemory = sum(terminals, "memory");
  return { app: appUse, core: coreUse, herdr, terminals, cpu: herdr.cpu + termCpu, memory: herdr.memory + termMemory, terminalCpu: termCpu, terminalMemory: termMemory };
}

/** Orca's formats: one decimal for CPU, KB / MB (1 dp) / GB (2 dp) for memory. */
export function formatCpu(percent) {
  return Number.isFinite(percent) ? `${percent.toFixed(1)}%` : "—";
}

export function formatMemory(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// The status-bar badge: whole megabytes read faster in a narrow slot.
export function badgeMemory(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** "high" past 1.5 GB resident or 80% CPU for Herdr itself, else null. */
export function pressure(snapshot) {
  if (!snapshot) return null;
  return snapshot.herdr.memory >= 1.5 * 1024 ** 3 || snapshot.herdr.cpu >= 80 ? "high" : null;
}

/** Keeps the last `limit` samples, oldest first. */
export function pushSample(history, value, limit = HISTORY) {
  const next = [...(Array.isArray(history) ? history : []), value].filter(Number.isFinite);
  return next.slice(Math.max(0, next.length - limit));
}
