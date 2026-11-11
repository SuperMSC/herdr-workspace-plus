// Only an explicitly reserved launch reaches this client. No prompts or project hooks are sent.
import { PRESET_LABEL, PRESET_STEP_LABEL, PRESET_WORKING, presetRoot } from "./presets-model.js";
import { qualifiedCommandAddress } from "./commands-model.js";
const absolute = value => value.startsWith("/") || /^[a-z]:[\\/]/i.test(value);
const objectReply = result => { if (result?.code !== 0) throw new Error(result?.stderr?.slice(0, 300) || "Core did not confirm the new terminal."); let body; try { body = JSON.parse(result.stdout); } catch { throw new Error("Core returned an unreadable terminal result."); } if (!body || typeof body !== "object" || Array.isArray(body) || body.error) throw new Error("Core returned an invalid terminal result."); return body; };
export async function presetAppCommand(name, args, appFolder, execute) {
  if (!["space.new", "tab.new", "tab.rename", "space.rename"].includes(name) || Object.hasOwn(args, "task")) throw new Error("This preset operation is not supported.");
  const result = await execute("/usr/bin/env", [`HERDR_APP_HOME=${appFolder}`, "herdr-app", "do", name, JSON.stringify(args)], { timeout: 15000 });
  if (result.code !== 0) throw new Error(result.stderr?.slice(0, 300) || "Herdr did not confirm this workspace operation.");
  let value; try { value = JSON.parse(result.stdout); } catch { throw new Error("Herdr returned an unreadable workspace acknowledgement."); }
  if (value?.error) throw new Error("Herdr rejected this workspace operation.");
  return value;
}
export function presetLaunchArgv(actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return { wrapped: false };
  const shell = actual?.[0]?.split(/[\\/]/).pop(), posix = ['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(shell), fish = shell === 'fish';
  const scripts = posix ? ['"$@"; exec "$0" -li', '"$@"; exec "$0" -i'] : fish ? ['command $argv[2..]; exec $argv[1] -li', 'command $argv[2..]; exec $argv[1] -i'] : [];
  if (!Array.isArray(actual) || !absolute(actual[0]) || actual[3] !== actual[0] || !['-lic', '-ic'].includes(actual[1]) || !scripts.includes(actual[2]) || JSON.stringify(actual.slice(4)) !== JSON.stringify(expected)) throw new Error("The new terminal's command differs from this preset.");
  return { wrapped: true };
}
export function checkedPresetTerminal(terminal, { address, argv, cwd, on, started, spaceId, tabId, identity = null }) {
  const qualified = qualifiedCommandAddress(terminal?.address, on);
  if (qualified !== address || !Number.isSafeInteger(terminal.created_ms) || terminal.created_ms < started - 5000 || terminal.cwd !== cwd) throw new Error("The new terminal could not be verified. No further tabs were started.");
  const launch = presetLaunchArgv(terminal.argv, argv), bare = id => id?.slice(id.lastIndexOf("/") + 1);
  if (typeof spaceId !== "string" || typeof tabId !== "string" || terminal.labels?.["herdr.space"] !== bare(spaceId) || terminal.labels?.["herdr.tab"] !== bare(tabId)) throw new Error("The terminal no longer belongs to the acknowledged new workspace and tab.");
  const next = JSON.stringify([qualified, terminal.created_ms, terminal.cwd, terminal.argv]);
  if (identity && identity !== next) throw new Error("The new terminal was replaced. No further action was taken.");
  const status = terminal.state === "live" ? terminal.reason === "spawn_pending" ? "session starting" : launch.wrapped ? "session live · command exit status unavailable" : "session live" : terminal.state === "finished" ? `exited${Number.isInteger(terminal.exit_code) ? ` ${terminal.exit_code}` : " · code unavailable"}` : "unavailable";
  return { address: qualified, identity: next, wrapped: launch.wrapped, processStatus: status, exitCode: launch.wrapped ? null : terminal.exit_code ?? null };
}
export async function resolvePresetArgv(argv, cwd, on, execute) {
  const resolved = [...argv];
  if (!absolute(resolved[0])) {
    if (resolved[0].includes("/")) resolved[0] = cwd.replace(/\/$/, "") + "/" + resolved[0];
    else {
      const found = await execute("sh", ["-c", 'command -v "$1"', "workspace-preset", resolved[0]], { cwd, on, timeout: 8000 }), path = found.stdout?.replace(/\r?\n$/, "");
      if (found.code !== 0 || !path || !absolute(path) || /[\r\n\0]/.test(path)) throw new Error("An executable was not found as a file. Use its absolute path (or explicitly choose a shell).");
      resolved[0] = path;
    }
  }
  const executable = await execute("sh", ["-c", 'test -x "$1" && test ! -d "$1"', "workspace-preset", resolved[0]], { cwd, on, timeout: 8000 });
  if (executable.code !== 0) throw new Error(`Executable is unavailable on ${on || "this computer"}: ${resolved[0]}`);
  return resolved;
}
export async function launchWorkspacePreset(record, deps) {
  const { execute, control, command, spaces, panes, machines, sleep, current, publish, applyRoots } = deps;
  const now = deps.now || Date.now, config = record.config, items = record.items.map(item => ({ ...item }));
  let attempted = false, space = null, currentKey = "preflight";
  const active = () => { const fresh = current(); if (deps.closed?.() || !fresh || fresh.reviewed || !PRESET_WORKING.includes(fresh.status) || now() > fresh.expires) throw new Error("This launch was interrupted. No more workspace items were started."); };
  const update = patch => publish(patch);
  const item = (key, patch) => { const at = items.findIndex(row => row.key === key); items[at] = { ...items[at], ...patch }; update({ items: items.map(row => ({ ...row })) }); };
  const snapshot = () => { const result = spaces(); if (!Array.isArray(result) || result.length > 500) throw new Error("The workspace snapshot is unavailable or too large to verify safely."); return result; };
  const waitFor = async find => { for (let i = 0; i < 32; i++) { active(); const matches = find(); if (matches.length > 1) throw new Error("More than one workspace item matches this launch. No further items were started."); if (matches.length === 1) return matches[0]; await sleep(100); } throw new Error("The app did not confirm the new workspace item. Inspect the launch marker before starting another workspace."); };
  const targetSpace = () => { const target = snapshot().find(row => row.id === space?.id); if (!target || target.name !== record.spaceMarker || (target.machine || null) !== (config.on || null) || presetRoot(target.folder) !== config.root) throw new Error("The captured new workspace changed or closed. No further items were started."); return target; };
  const captureTerminal = async (tab, expectedAddress, argv, cwd, key) => {
    const candidates = panes().filter(pane => pane.tab === tab.id && typeof pane.terminal === "string" && !pane.mod);
    if (candidates.length !== 1) throw new Error("The new tab does not have exactly one terminal. It was not guessed from focus.");
    const address = qualifiedCommandAddress(candidates[0].terminal, config.on);
    if (address !== qualifiedCommandAddress(expectedAddress, config.on)) throw new Error("The new tab does not hold its acknowledged terminal. No further action was taken.");
    const terminal = objectReply(await control(["get", "--json", address]));
    active();
    const checked = checkedPresetTerminal(terminal, { address, argv, cwd, on: config.on, started: record.started, spaceId: space.id, tabId: tab.id });
    item(key, { status: "created", tabId: tab.id, ...checked });
    const labelled = objectReply(await control(["label", "--json", address, `${PRESET_LABEL}=${record.token}`, `${PRESET_STEP_LABEL}=${key}`]));
    active(); checkedPresetTerminal(labelled, { address, argv, cwd, on: config.on, started: record.started, spaceId: space.id, tabId: tab.id, identity: checked.identity });
    if (labelled.labels?.[PRESET_LABEL] !== record.token || labelled.labels?.[PRESET_STEP_LABEL] !== key) throw new Error("The new terminal's launch labels were not confirmed.");
    if (terminal.state === "finished" && terminal.exit_code !== 0 || terminal.state !== "live" && terminal.state !== "finished") throw new Error(`The new terminal ${checked.processStatus}. Later tabs were not started.`);
  };
  try {
    active(); item("preflight", { status: "checking" });
    if (!machines().some(machine => (machine.name || null) === (config.on || null) && machine.layout === "ready")) throw new Error("The selected machine's workspace layout is unavailable. Nothing was opened.");
    const paths = [...new Set([...config.roots, ...config.tabs.map(tab => tab.cwd)])];
    const folders = await execute("sh", ["-c", 'for p do test -d "$p" || exit 1; done', "workspace-preset", ...paths], { cwd: config.root, on: config.on, timeout: 8000 });
    active(); if (folders.code !== 0) throw new Error("A preset folder is unavailable on the selected machine. Nothing was opened.");
    const agentArgv = await resolvePresetArgv(config.agentArgv, config.root, config.on, execute); active();
    const tabs = []; for (const tab of config.tabs) { tabs.push({ ...tab, argv: await resolvePresetArgv(tab.argv, tab.cwd, config.on, execute) }); active(); }
    deps.checkRootsCapacity?.(); item("preflight", { status: "ready" }); update({ status: "launching" });
    const before = new Set(snapshot().map(row => row.id)), marker = `${record.token} · Agent`;
    currentKey = "agent"; item("agent", { status: "creating" }); active(); attempted = true;
    const acknowledged = await command("space.new", { name: record.spaceMarker, folder: config.root, tab: marker, argv: agentArgv, machine: config.on || "" });
    const spaceId = qualifiedCommandAddress(acknowledged?.space, config.on), tabId = qualifiedCommandAddress(acknowledged?.tab, config.on);
    if (before.has(spaceId)) throw new Error("Herdr acknowledged an existing workspace. No further action was taken.");
    space = await waitFor(() => snapshot().filter(row => row.id === spaceId && row.name === record.spaceMarker && (row.machine || null) === (config.on || null) && presetRoot(row.folder) === config.root));
    update({ spaceId: space.id });
    const agentTab = await waitFor(() => targetSpace().tabs.filter(tab => tab.id === tabId && tab.name === marker));
    await captureTerminal(agentTab, acknowledged.terminal, agentArgv, config.root, "agent"); active();
    currentKey = "roots"; item("roots", { status: "applying" }); applyRoots(targetSpace(), config); item("roots", { status: "applied" });
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i], key = `tab-${i + 1}`, marker = `${record.token} · ${i + 1}`, beforeTabs = new Set(targetSpace().tabs.map(row => row.id));
      currentKey = key; item(key, { status: "creating" }); active();
      const acknowledged = await command("tab.new", { space: space.id, name: marker, folder: tab.cwd, argv: tab.argv });
      const tabId = qualifiedCommandAddress(acknowledged?.tab, config.on);
      if (beforeTabs.has(tabId) || acknowledged.space && qualifiedCommandAddress(acknowledged.space, config.on) !== space.id) throw new Error("Herdr acknowledged the wrong workspace or an existing tab.");
      const created = await waitFor(() => targetSpace().tabs.filter(row => row.id === tabId && !beforeTabs.has(row.id) && row.name === marker));
      await captureTerminal(created, acknowledged.terminal, tab.argv, tab.cwd, key); active();
    }
    for (const created of items.filter(row => row.tabId)) { active(); targetSpace(); await command("tab.rename", { id: created.tabId, name: created.key === "agent" ? "Agent" : config.tabs[Number(created.key.slice(4)) - 1].name }); }
    active(); targetSpace(); await command("space.rename", { id: space.id, name: config.name });
    update({ status: "complete", finished: now(), error: "" });
  } catch (error) {
    const message = String(error.message || error).slice(0, 600);
    item(currentKey, { status: attempted ? "unconfirmed" : "failed", error: message });
    update({ status: attempted ? space ? "partial" : "unconfirmed" : "failed", finished: now(), error: message });
  }
}
