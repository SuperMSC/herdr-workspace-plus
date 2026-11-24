// Session identities, launch commands and shared operation coordination.
import { contextLabel } from "./live-model.js";
export { LIVE_KEY, TERMINAL_SESSIONS_KEY, interruptedSessions } from "./live-model.js";
export const NAMES = "sessions-plus.names";
export const PENDING = "sessions-plus.pending";
export const OPERATIONS = "sessions-plus.operations";
export const CHANGE_KEY = "sessions-plus.history-change";
export const FORK_REQUEST = "sessions-plus.fork-request.v1";
export const OPERATION_TTL = 300000;
export const operationPending = (operations, key, now = Date.now()) => Number(operations?.[key]?.expires ?? 0) > now;
export const PROVIDERS = { claude: "Claude Code", codex: "Codex", agy: "Antigravity" };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const base = value => String(value ?? "").split(/[\\/]/).pop();
export const sessionKey = row => JSON.stringify([row.provider, row.store, row.id]);
export const cleanTitle = text => String(text ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
const CODEX_VALUE_OPTIONS = new Set(["-c", "--config", "-p", "--profile", "-m", "--model", "-C", "--cd", "-s", "--sandbox", "-a", "--ask-for-approval", "--add-dir", "--enable", "--disable", "--remote"]);

function codexSessionCommand(argv) {
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (CODEX_VALUE_OPTIONS.has(arg)) { index++; continue; }
    if (typeof arg !== "string" || arg === "--" || !arg.startsWith("-")) return arg === "resume" ? index : -1;
  }
  return -1;
}

export function argvIdentity(terminal) {
  let argv = terminal.foreground?.argv?.length ? terminal.foreground.argv : terminal.argv ?? [];
  // Herdr passes the agent's arguments separately through its login-shell wrapper.
  if (["sh", "bash", "zsh", "fish"].includes(base(argv[0])) && /-.*c$/.test(argv[1] ?? "") &&
      ["\"$@\"; exec \"$0\" -li", "\"$@\"; exec \"$0\" -i", "command $argv[2..]; exec $argv[1] -li", "command $argv[2..]; exec $argv[1] -i"].includes(argv[2])) argv = argv.slice(4);
  const env = {};
  if (base(argv[0]) === "env") {
    argv = argv.slice(1);
    while (/^[A-Z_][A-Z_0-9]*=/.test(argv[0] ?? "")) {
      const at = argv[0].indexOf("="); env[argv[0].slice(0, at)] = argv[0].slice(at + 1); argv = argv.slice(1);
    }
  }
  const provider = base(argv[0]);
  if (!Object.hasOwn(PROVIDERS, provider)) return null;
  const index = provider === "codex" ? codexSessionCommand(argv) : argv.indexOf(provider === "agy" ? "--conversation" : "--resume", 1);
  const id = index >= 0 && !argv.includes("--fork-session", 1) ? argv[index + 1] : null;
  return { provider, id: UUID.test(id ?? "") ? id : null, store: env[provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] ?? null };
}

export function liveKey(terminal) {
  return `${terminal.address}@${terminal.created_ms}`;
}

export function liveIdentity(terminal, identities, argv = argvIdentity(terminal)) {
  if (terminal.state !== "live" || typeof terminal.address !== "string" || terminal.address.includes("/") || !Number.isSafeInteger(terminal.foreground?.pid)) return null;
  const entry = identities?.[liveKey(terminal)];
  return entry?.pid === terminal.foreground.pid && entry.provider === argv?.provider &&
    (!argv.store || argv.store === entry.store) && (entry.provider === "claude" || entry.id === argv.id) ? entry : null;
}

export function sessionIdentity(terminal, identities) {
  const argv = argvIdentity(terminal), live = liveIdentity(terminal, identities, argv);
  return live?.provider === "claude" && UUID.test(live.id ?? "") ? live : argv;
}

export function sessionRows(history, terminals, panes, names = {}, identities = {}) {
  const rows = [], used = new Set(), now = Date.now();
  for (const terminal of terminals.filter(t => t.state === "live")) {
    const pane = panes.find(p => p.terminal === terminal.address);
    const identity = sessionIdentity(terminal, identities), reading = liveIdentity(terminal, identities);
    if (!identity && !terminal.program?.agent && !pane?.program?.agent) continue;
    const remote = terminal.address.includes("/");
    const match = !remote && identity?.id ? history.find(row => !row.ambiguous && row.provider === identity.provider && row.id === identity.id &&
      (identity.store ? row.store === identity.store : row.defaultStore)) : null;
    if (match) used.add(match.key);
    const exact = !remote && reading?.id && reading.store ? { id: reading.id, store: reading.store } : {};
    const key = match?.key ?? (exact.id ? sessionKey(reading) : JSON.stringify(["terminal", terminal.address, terminal.created_ms ?? 0]));
    rows.push({ ...exact, ...match, key, provider: match?.provider ?? identity?.provider ?? "agent", address: terminal.address, context: contextLabel(reading, now),
      cwd: pane?.cwd || terminal.cwd || "", tab: pane?.tab, remote, live: true,
      status: terminal.status || pane?.status || "running", focused: pane?.focused ?? false,
      updated: terminal.created_ms ?? 0, title: cleanTitle(names[key] || reading?.title || match?.title || terminal.title || terminal.name || terminal.program?.name || PROVIDERS[identity?.provider] || "Agent session") });
  }
  for (const row of history) if (!used.has(row.key)) rows.push({ ...row, live: false, remote: false, title: cleanTitle(names[row.key] || row.title) });
  return rows.sort((a, b) => Number(b.live) - Number(a.live) || (b.updated ?? 0) - (a.updated ?? 0));
}

export function filterRows(rows, { cwd, remote = false, all = false, provider = "all", query = "", source = "all" }) {
  const search = query.trim().toLocaleLowerCase();
  return rows.filter(row => (all || (!remote && !row.remote && cwd && row.cwd.replace(/\/$/, "") === cwd.replace(/\/$/, ""))) &&
    (provider === "all" || row.provider === provider) && (source === "all" || (row.origin || "unknown") === source) && (!search || [row.title, row.cwd, row.id, row.provider].some(value => String(value ?? "").toLocaleLowerCase().includes(search))));
}

export function canFork(row) {
  return Boolean(!row?.remote && !row?.ambiguous && ["claude", "codex"].includes(row?.provider) && typeof row.id === "string" && UUID.test(row.id) &&
    typeof row.store === "string" && row.store.startsWith("/") && row.key === sessionKey(row));
}

export function resumeArgv(row, executable, { fork = false } = {}) {
  if (!Object.hasOwn(PROVIDERS, row.provider) || !UUID.test(row.id) || !row.cwd?.startsWith("/") || !row.store?.startsWith("/") || !executable?.startsWith("/")) throw new Error("Invalid session metadata.");
  if (fork && row.provider === "agy") throw new Error("Antigravity does not support forking sessions.");
  if (row.provider === "agy") return [executable, "--conversation", row.id];
  const env = row.provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  const args = row.provider === "codex" ? [fork ? "fork" : "resume", row.id] : ["--resume", row.id, ...(fork ? ["--fork-session"] : [])];
  return ["/usr/bin/env", `${env}=${row.store}`, executable, ...args];
}

export function launchCommand(row, executable, spaces, { fork = false } = {}) {
  const argv = resumeArgv(row, executable, { fork }), name = cleanTitle(row.title) || PROVIDERS[row.provider];
  const title = fork ? cleanTitle("Fork: " + name) : name;
  const space = spaces.find(s => !s.machine && s.folder === row.cwd);
  return space ? ["tab.new", { space: space.id, name: title, folder: row.cwd, argv }] : ["space.new", { folder: row.cwd, tab: title, argv }];
}


export function codexOrigin(source) {
  if (["cli", "vscode", "exec", "app-server"].includes(source)) return "main";
  if (source && typeof source === "object" && Object.hasOwn(source, "subagent")) {
    const kind = source.subagent;
    if (kind === "review" || kind?.other === "guardian" || (kind && typeof kind === "object" && Object.hasOwn(kind, "review"))) return "review";
    return "subagent";
  }
  return "unknown";
}

export const ORIGINS = { main: "Main", review: "Auto review", subagent: "Subagent", unknown: "Unknown source" };
export function historyGroup(row, now = Date.now()) {
  if (row.live) return "Running";
  if (!Number.isFinite(row.updated) || row.updated <= 0) return "Unknown date";
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const week = new Date(today); week.setDate(week.getDate() - 6);
  return row.updated >= +today ? "Today" : row.updated >= +yesterday ? "Yesterday" : row.updated >= +week ? "Previous 7 days" : "Earlier";
}
export function historyTime(row, now = Date.now()) {
  const id = row.id?.slice(0, 8) || row.address || "";
  if (row.live) return id;
  if (!Number.isFinite(row.updated) || row.updated <= 0) return ["Update time unavailable", id].filter(Boolean).join(" · ");
  const minutes = Math.max(0, Math.floor((now - row.updated) / 60000));
  const ago = minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
  return [`Updated ${ago}`, id].filter(Boolean).join(" · ");
}
