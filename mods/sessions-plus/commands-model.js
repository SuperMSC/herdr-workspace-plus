// Captured project command templates and run reservations. Nothing executes in this module.
export const COMMANDS_KEY = "sessions-plus.commands.v1";
export const COMMAND_LABEL = "agent-workspace.command-run";
export const PROJECT_LABEL = "agent-workspace.command-project";
export const COMMAND_LIMITS = { projects: 40, commands: 40, arguments: 64, text: 16000, runs: 40, drafts: 8, total: 2000000 };
export const ACTIVE_COMMAND_STATES = ["starting", "running", "cancelling", "unconfirmed"];
const absolute = value => typeof value === "string" && (value.startsWith("/") || /^[a-z]:[\\/]/i.test(value));
const cleanText = (value, limit, label) => {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} is missing, too long, or contains control characters.`);
  return value;
};
export function commandContext(value = {}) {
  const root = cleanText(value.root ?? value.cwd, 2000, "Project folder");
  if (!absolute(root)) throw new Error("An absolute project folder is required.");
  const on = value.on == null || value.on === "" ? null : cleanText(value.on, 200, "Machine");
  if (on?.includes("/")) throw new Error("The project machine name is invalid.");
  return { root, on };
}
export const commandProjectKey = context => JSON.stringify([context.on ?? null, context.root]);
export function commandScope(context) {
  const value = commandProjectKey(context); let a = 2166136261, b = 3339675911;
  for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b ^ value.charCodeAt(i), 2246822519); }
  return [a, b].map(number => (number >>> 0).toString(16).padStart(8, "0")).join("");
}
export function commandState(value) {
  return { projects: Array.isArray(value?.projects) ? value.projects.filter(project => project && typeof project.key === "string" && Array.isArray(project.commands) && Array.isArray(project.runs)).map(project => ({ ...project, drafts: Array.isArray(project.drafts) ? project.drafts : [] })) : [] };
}
export function commandProject(value, context) {
  return commandState(value).projects.find(project => project.key === commandProjectKey(context)) ?? { key: commandProjectKey(context), context: { ...context }, commands: [], runs: [], drafts: [] };
}
function storeProject(value, project) {
  const next = commandState(value), index = next.projects.findIndex(item => item.key === project.key);
  if (index < 0 && next.projects.length >= COMMAND_LIMITS.projects) {
    const empty = next.projects.findIndex(item => !item.commands.length && !item.drafts.length && !item.runs.some(run => ACTIVE_COMMAND_STATES.includes(run.status)));
    if (empty < 0) throw new Error("Saved project limit reached. Remove unused templates and drafts from another saved project first.");
    next.projects.splice(empty, 1);
  }
  if (index < 0) next.projects.push(project); else next.projects[index] = project;
  const reserved = next.projects.reduce((sum, item) => sum + item.runs.filter(run => ACTIVE_COMMAND_STATES.includes(run.status)).reduce((bytes, run) => bytes + (run.terminalIdentity ? 1000 : 8000 + 4 * JSON.stringify(run.argv || []).length), 0), 0);
  if (JSON.stringify(next).length + reserved > COMMAND_LIMITS.total) throw new Error("Saved project commands are full. Remove unused templates or drafts first.");
  return next;
}
export function parseCommandForm({ title, argvText, cwd }, context) {
  let argv;
  try { argv = JSON.parse(argvText); } catch { throw new Error('Arguments must be a JSON array, such as ["/bin/echo", "hello world"].'); }
  return validateCommand({ title, argv, cwd: cwd || context.root });
}
export function validateCommand(command) {
  const title = cleanText(command.title, 100, "Command title").trim();
  const cwd = cleanText(command.cwd, 2000, "Working folder");
  if (!absolute(cwd)) throw new Error("Working folder must be an absolute path.");
  const argv = command.argv;
  if (!Array.isArray(argv) || !argv.length || argv.length > COMMAND_LIMITS.arguments || argv.some(argument => typeof argument !== "string" || argument.includes("\0")) || !argv[0]?.trim() || argv.join("").length > COMMAND_LIMITS.text) throw new Error("Use 1–64 literal argument strings, with a nonempty executable and at most 16,000 characters.");
  if (argv[0].startsWith("-")) throw new Error("The first argument must name an executable.");
  return { title, argv: [...argv], cwd };
}
export function commandRevision(command) { return command ? JSON.stringify([command.title, command.argv, command.cwd, command.version]) : null; }
export function saveCommand(value, context, form, id = null, expected = null, now = Date.now(), newId = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`) {
  const command = validateCommand(form), project = commandProject(value, context), original = project.commands.find(item => item.id === id);
  if (id && (!original || commandRevision(original) !== expected)) throw new Error("This command changed or was removed in another view. Your form is retained.");
  if (id && project.runs.some(run => run.commandId === id && ACTIVE_COMMAND_STATES.includes(run.status))) throw new Error("Wait for this command's active run before editing its template.");
  if (!id && project.commands.length >= COMMAND_LIMITS.commands) throw new Error("This project already has 40 commands. Remove an unused template first.");
  const saved = { ...command, id: id || newId, favorite: original?.favorite === true, version: (original?.version || 0) + 1, updated: now };
  const commands = original ? project.commands.map(item => item.id === id ? saved : item) : [...project.commands, saved];
  return storeProject(value, { ...project, commands });
}
export function removeCommand(value, context, id, expected) {
  const project = commandProject(value, context), command = project.commands.find(item => item.id === id);
  if (!command || commandRevision(command) !== expected) throw new Error("This command changed or was already removed.");
  if (project.runs.some(run => run.commandId === id && ACTIVE_COMMAND_STATES.includes(run.status))) throw new Error("An active or unconfirmed run still uses this command.");
  return storeProject(value, { ...project, commands: project.commands.filter(item => item.id !== id) });
}
export function favoriteCommand(value, context, id) {
  const project = commandProject(value, context);
  return storeProject(value, { ...project, commands: project.commands.map(command => command.id === id ? { ...command, favorite: !command.favorite } : command) });
}
export function moveCommand(value, context, id, direction) {
  const project = commandProject(value, context), commands = [...project.commands], at = commands.findIndex(command => command.id === id), next = at + direction;
  if (at < 0 || next < 0 || next >= commands.length) return value;
  [commands[at], commands[next]] = [commands[next], commands[at]];
  return storeProject(value, { ...project, commands });
}
export function displayedCommands(project) { return project.commands.map((command, order) => ({ ...command, order })).sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.order - b.order); }
export const commandDraftRevision = draft => draft ? JSON.stringify(draft) : null;
export const commandDraftContent = draft => JSON.stringify([draft.id ?? null, draft.expected ?? null, draft.title, draft.cwd, draft.argvText]);
export function saveCommandDraft(value, context, draft, expected) {
  const project = commandProject(value, context), original = project.drafts.find(item => item.draftId === draft.draftId);
  if (expected !== undefined && commandDraftRevision(original) !== expected) throw new Error("This draft changed or was discarded in another view. The visible form has not overwritten it.");
  if (!original && project.drafts.length >= COMMAND_LIMITS.drafts) throw new Error("Eight unfinished command forms are already saved. Discard an unused form before opening another copy.");
  if (typeof draft.title !== "string" || typeof draft.cwd !== "string" || typeof draft.argvText !== "string" || draft.title.length > 100 || draft.cwd.length > 2000 || draft.argvText.length > 24000) throw new Error("Command form is too large. The visible text is retained.");
  return storeProject(value, { ...project, drafts: [...project.drafts.filter(item => item.draftId !== draft.draftId), { ...draft, updated: Date.now() }] });
}
export function removeCommandDraft(value, context, draftId, expected) {
  const project = commandProject(value, context);
  if (expected !== undefined && commandDraftRevision(project.drafts.find(draft => draft.draftId === draftId)) !== expected) throw new Error("This draft changed or was already discarded. Review it again first.");
  return storeProject(value, { ...project, drafts: project.drafts.filter(draft => draft.draftId !== draftId) });
}
export function reserveCommandRun(value, context, command, token, now = Date.now()) {
  const project = commandProject(value, context), current = project.commands.find(item => item.id === command.id);
  if (!current || commandRevision(current) !== commandRevision(command)) throw new Error("This command changed. Review it again before running.");
  if (project.runs.some(run => run.commandId === command.id && ACTIVE_COMMAND_STATES.includes(run.status))) throw new Error("This command already has an active or unconfirmed run. Refresh its status first.");
  const active = project.runs.filter(run => ACTIVE_COMMAND_STATES.includes(run.status));
  if (active.length >= COMMAND_LIMITS.runs) throw new Error("Too many active project runs.");
  const room = COMMAND_LIMITS.runs - active.length - 1;
  const finished = room ? project.runs.filter(run => !ACTIVE_COMMAND_STATES.includes(run.status)).slice(-room) : [];
  const record = { token, commandId: command.id, title: command.title, argv: [...command.argv], cwd: command.cwd, scope: commandScope(context), status: "starting", started: now, on: context.on, error: "" };
  return storeProject(value, { ...project, runs: [...active, ...finished, record] });
}
export function patchCommandRun(value, context, token, patch) {
  const project = commandProject(value, context);
  if (!project.runs.some(run => run.token === token)) return value;
  return storeProject(value, { ...project, runs: project.runs.map(run => run.token === token ? { ...run, ...patch } : run) });
}
export function reserveCommandCancel(value, context, token, cancelToken, now = Date.now()) {
  const project = commandProject(value, context), record = project.runs.find(run => run.token === token);
  if (!record || !["running", "starting"].includes(record.status) || !record.address || record.cancelToken) throw new Error("This run cannot be cancelled now. Refresh its status.");
  return patchCommandRun(value, context, token, { status: "cancelling", cancelToken, cancelUntil: now + 30000, cancelRequested: true });
}
export function qualifiedCommandAddress(address, on) {
  if (typeof address !== "string" || !/^[^\s\x00-\x1f\x7f]+$/.test(address)) throw new Error("Core did not identify a task terminal.");
  if (on) return address.includes("/") ? address.startsWith(on + "/") ? address : (() => { throw new Error("Core returned the wrong machine."); })() : on + "/" + address;
  if (address.includes("/")) throw new Error("Core returned the wrong machine.");
  return address;
}
export function commandTerminal(record, terminal) {
  if (!terminal || terminal.labels?.[COMMAND_LABEL] !== record.token || terminal.labels?.[PROJECT_LABEL] !== record.scope || !Array.isArray(terminal.argv) || !Number.isSafeInteger(terminal.created_ms) || terminal.created_ms <= 0) throw new Error("This terminal no longer belongs to the selected run.");
  const address = qualifiedCommandAddress(terminal.address, record.on);
  const identity = JSON.stringify([address, terminal.created_ms, terminal.cwd, terminal.argv]);
  if (record.address && record.address !== address || record.terminalIdentity && record.terminalIdentity !== identity) throw new Error("The task terminal changed. No action was taken.");
  if (record.resolvedArgv && JSON.stringify(record.resolvedArgv) !== JSON.stringify(terminal.argv)) throw new Error("Core returned a different command.");
  let status = "running";
  if (terminal.state === "finished") status = terminal.reason === "killed" ? "cancelled" : Number.isInteger(terminal.exit_code) ? terminal.exit_code === 0 ? "succeeded" : "failed" : ["server_stop", "holder_lost", "stopped_by_restart", "host_shutdown", "signaled"].includes(terminal.reason) ? "lost" : "finished";
  else if (terminal.state !== "live") throw new Error("The task terminal is unavailable.");
  else if (record.cancelToken) status = "cancelling";
  else if (terminal.reason === "spawn_pending") status = "starting";
  return { address, terminalIdentity: identity, status, exitCode: Number.isInteger(terminal.exit_code) ? terminal.exit_code : null, reason: terminal.reason || null, finished: terminal.finished_ms || null, error: "", ...(terminal.state === "finished" ? { cancelToken: null, cancelUntil: null } : {}) };
}
export function commandRunArgs(record, argv) {
  return ["run", "--json", "--bg", "--no-parent", "--no-notify", "--cwd", record.cwd, ...(record.on ? ["--on", record.on] : []), "--label", `${COMMAND_LABEL}=${record.token}`, "--label", `${PROJECT_LABEL}=${record.scope}`, "--", ...argv];
}
export function commandStatusText(run) {
  const names = { starting: "Starting", running: "Running", cancelling: "Cancelling", unconfirmed: "Start unconfirmed", succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled", lost: "Lost after core/session stop", unavailable: "Terminal unavailable", finished: "Finished · exit code unavailable" };
  return `${names[run.status] || "Unknown"}${Number.isInteger(run.exitCode) && run.exitCode !== 0 ? ` · exit ${run.exitCode}` : ""}`;
}
