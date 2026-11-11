import { COMMAND_LABEL, PROJECT_LABEL, commandRunArgs, commandTerminal, qualifiedCommandAddress } from "./commands-model.js";
const absolute = value => value.startsWith("/") || /^[a-z]:[\\/]/i.test(value);
const resultObject = result => {
  if (result?.code !== 0) throw new Error("Core did not confirm this operation.");
  let body;
  try { body = JSON.parse(result.stdout); } catch { throw new Error("Core returned an unreadable result."); }
  if (!body || typeof body !== "object" || Array.isArray(body) || body.error) throw new Error("Core returned an invalid task result.");
  return body;
};
export async function startCommand(record, { execute, control }) {
  let attempted = false;
  try {
    const argv = [...record.argv];
    if (!absolute(argv[0])) {
      if (argv[0].includes("/")) argv[0] = record.cwd.replace(/\/$/, "") + "/" + argv[0];
      else {
        const found = await execute("sh", ["-c", 'command -v "$1"', "project-command", argv[0]], { cwd: record.cwd, on: record.on, timeout: 8000 });
        const program = found.stdout?.replace(/\r?\n$/, "");
        if (found.code !== 0 || !program || !absolute(program) || /[\r\n\0]/.test(program)) throw new Error("Executable was not found as a file. Enter its full path in the command's first argument.");
        argv[0] = program;
      }
    }
    attempted = true;
    const started = resultObject(await control(commandRunArgs(record, argv)));
    // The CLI deliberately returns a compact background ACK, not the complete RPC RunResult.
    const address = qualifiedCommandAddress(started.address, record.on);
    const terminal = resultObject(await control(["get", "--json", address]));
    return { resolvedArgv: argv, ...commandTerminal({ ...record, resolvedArgv: argv, address }, terminal) };
  } catch (error) { error.launchAttempted = attempted; throw error; }
}
export async function inspectCommand(record, { control }, now = Date.now()) {
  if (record.address) {
    const current = await control(["get", "--json", record.address]);
    if (current.code === 0) {
      const terminal = resultObject(current), checked = commandTerminal(record, terminal);
      if (terminal.state === "live" && record.cancelToken && Number.isFinite(record.cancelUntil) && record.cancelUntil <= now) return { ...checked, status: terminal.reason === "spawn_pending" ? "starting" : "running", cancelToken: null, cancelUntil: null, error: "The task is still running. The earlier cancellation was not confirmed; Cancel run is available again." };
      return checked;
    }
  }
  const result = await control(["ls", "--all", "--json", "--label", `${COMMAND_LABEL}=${record.token}`, "--label", `${PROJECT_LABEL}=${record.scope}`]);
  let terminals;
  try { const data = JSON.parse(result.stdout); terminals = Array.isArray(data) ? data : data?.terminals; } catch { throw new Error("Core could not recover this run. Refresh before starting it again."); }
  if (result.code !== 0 || !Array.isArray(terminals)) throw new Error("Core could not recover this run.");
  if (terminals.length > 1) throw new Error("More than one terminal carries this run's identity. No action was taken.");
  if (terminals.length === 1) {
    // The CLI list contains compact summaries; only get returns the full ownership identity.
    const address = qualifiedCommandAddress(terminals[0]?.address, record.on);
    const checked = commandTerminal(record, resultObject(await control(["get", "--json", address])));
    if (checked.address !== address) throw new Error("Core returned a different task terminal. No action was taken.");
    return checked;
  }
  return { status: now - record.started > 30000 ? "unavailable" : "unconfirmed", error: "No terminal has confirmed this start. Refresh to check again; no automatic retry occurs." };
}
export async function cancelCommand(record, { control }) {
  const terminal = resultObject(await control(["get", "--json", record.address]));
  const checked = commandTerminal(record, terminal);
  if (terminal.state !== "live") return checked;
  const reply = await control(["kill", "--json", checked.address]);
  if (reply.code !== 0) throw new Error("Cancellation was not confirmed. Refresh the run before trying again.");
  try { return commandTerminal(record, resultObject(await control(["get", "--json", checked.address]))); }
  catch { return { status: "cancelling", error: "Cancellation requested; waiting for a final terminal result." }; }
}
export async function commandOutput(record, { control }) {
  commandTerminal(record, resultObject(await control(["get", "--json", record.address])));
  const result = await control(["read", "--lines", "1000", record.address]);
  if (result.code !== 0) throw new Error("Core no longer has this task's console output.");
  const text = result.stdout || "";
  return { text: text.slice(0, 400000), truncated: text.length > 400000 };
}
