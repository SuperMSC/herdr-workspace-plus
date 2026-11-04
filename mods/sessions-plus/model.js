// Session identities, launch commands and shared operation coordination.
export const NAMES = "sessions-plus.names";
export const PENDING = "sessions-plus.pending";
export const OPERATIONS = "sessions-plus.operations";
export const CHANGE_KEY = "sessions-plus.history-change";
export const OPERATION_TTL = 300000;
export const operationPending = (operations, key, now = Date.now()) => Number(operations?.[key]?.expires ?? 0) > now;
export const PROVIDERS = { claude: "Claude Code", codex: "Codex", agy: "agy" };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const base = value => String(value ?? "").split(/[\\/]/).pop();
export const sessionKey = row => JSON.stringify([row.provider, row.store, row.id]);
export const cleanTitle = text => String(text ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);

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
  const flag = provider === "codex" ? "resume" : provider === "agy" ? "--conversation" : "--resume";
  const index = argv.indexOf(flag, 1);
  const id = index >= 0 ? argv[index + 1] : null;
  return { provider, id: UUID.test(id ?? "") ? id : null, store: env[provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] ?? null };
}

export function sessionRows(history, terminals, panes, names = {}) {
  const rows = [], used = new Set();
  for (const terminal of terminals.filter(t => t.state === "live")) {
    const pane = panes.find(p => p.terminal === terminal.address);
    const identity = argvIdentity(terminal);
    if (!identity && !terminal.program?.agent && !pane?.program?.agent) continue;
    const remote = terminal.address.includes("/");
    const match = !remote && identity?.id ? history.find(row => row.provider === identity.provider && row.id === identity.id &&
      (identity.store ? row.store === identity.store : row.defaultStore)) : null;
    if (match) used.add(match.key);
    const key = match?.key ?? JSON.stringify(["terminal", terminal.address, terminal.created_ms ?? 0]);
    rows.push({ ...match, key, provider: match?.provider ?? identity?.provider ?? "agent", address: terminal.address,
      cwd: pane?.cwd || terminal.cwd || "", tab: pane?.tab, remote, live: true,
      status: terminal.status || pane?.status || "running", focused: pane?.focused ?? false,
      updated: terminal.created_ms ?? 0, title: cleanTitle(names[key] || match?.title || terminal.title || terminal.name || terminal.program?.name || identity?.provider || "Agent session") });
  }
  for (const row of history) if (!used.has(row.key)) rows.push({ ...row, live: false, remote: false, title: cleanTitle(names[row.key] || row.title) });
  return rows.sort((a, b) => Number(b.live) - Number(a.live) || (b.updated ?? 0) - (a.updated ?? 0));
}

export function filterRows(rows, { cwd, remote = false, all = false, provider = "all", query = "" }) {
  const search = query.trim().toLocaleLowerCase();
  return rows.filter(row => (all || (!remote && !row.remote && cwd && row.cwd.replace(/\/$/, "") === cwd.replace(/\/$/, ""))) &&
    (provider === "all" || row.provider === provider) && (!search || [row.title, row.cwd, row.id, row.provider].some(value => String(value ?? "").toLocaleLowerCase().includes(search))));
}

export function resumeArgv(row, executable) {
  if (!Object.hasOwn(PROVIDERS, row.provider) || !UUID.test(row.id) || !row.cwd?.startsWith("/") || !row.store?.startsWith("/") || !executable?.startsWith("/")) throw new Error("Invalid session metadata.");
  if (row.provider === "agy") return [executable, "--conversation", row.id];
  const env = row.provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  return ["/usr/bin/env", `${env}=${row.store}`, executable, ...(row.provider === "codex" ? ["resume", row.id] : ["--resume", row.id])];
}

export function launchCommand(row, executable, spaces) {
  const argv = resumeArgv(row, executable), title = cleanTitle(row.title) || PROVIDERS[row.provider];
  const space = spaces.find(s => !s.machine && s.folder === row.cwd);
  return space ? ["tab.new", { space: space.id, name: title, folder: row.cwd, argv }] : ["space.new", { folder: row.cwd, tab: title, argv }];
}
