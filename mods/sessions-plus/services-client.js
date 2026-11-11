import { SERVICE_LIMITS, containerIdentity, parseContainers, associatePorts } from "./services-model.js";
import { parseListeners } from "./ports-model.js";
import { INSPECT_FORMAT } from "./services-protocol.js";
import { REMOTE_SCAN_SCRIPT, REMOTE_ACTION_SCRIPT } from "./services-remote.js";
function bounded(result, limit = 1400000) {
  if (!result || typeof result.stdout !== "string" || result.stdout.length > limit) throw new Error("Service output exceeded its limit. Refresh to retry.");
  return result;
}
export function parseRemoteSnapshot(result) {
  bounded(result);
  const pattern = /\n__AW_ENGINE__\n([\s\S]*?)\n__AW_CONTAINERS__\n([\s\S]*?)\n__AW_PORTS__\n([\s\S]*?)\n__AW_END__\n?$/;
  const match = pattern.exec(result.stdout);
  if (result.code || !match) throw new Error("The selected remote machine returned an incomplete services snapshot. No local fallback was used.");
  const warnings = [], containerRaw = match[2].replace(/^__AW_CONTAINER_LIMIT__\n/, "").replace(/^__AW_DOCKER_MISSING__\n?/, "");
  let daemon = null; try { daemon = JSON.parse(match[1].trim()); } catch { /* Shown as a partial Docker result. */ }
  if (typeof daemon !== "string" || !daemon || daemon.length > 200) { daemon = null; warnings.push("Docker is missing, inaccessible, or not running on this machine; restart is disabled."); }
  if (match[2].includes("__AW_CONTAINER_LIMIT__")) warnings.push(`Showing at most ${SERVICE_LIMITS.containers} containers.`);
  let containers = [], ports = [];
  try { const parsed = parseContainers(containerRaw); containers = parsed.containers.map(row => ({ ...row, daemon })); warnings.push(...parsed.warnings); }
  catch (error) { warnings.push(String(error.message)); }
  const split = match[3].indexOf("\n"), format = split < 0 ? match[3].trim() : match[3].slice(0, split).trim(), portRaw = split < 0 ? "" : match[3].slice(split + 1);
  try { ports = parseListeners(portRaw, format); } catch (error) { warnings.push(String(error.message)); }
  if (result.stderr?.trim()) warnings.push(result.stderr.trim().slice(0, 500));
  if (ports.length >= SERVICE_LIMITS.ports) warnings.push(`Showing at most ${SERVICE_LIMITS.ports} TCP listeners.`);
  warnings.push("Process visibility follows current permissions; some PIDs or listeners may be hidden.");
  return { containers, ports: associatePorts(ports, containers), warnings: [...new Set(warnings)], captured: Date.now() };
}
export function createServicesClient({ execute, home, node = "node", context, connected = () => true }) {
  const on = context.on ?? null;
  const available = () => { if (on && !connected(on)) throw new Error(`Machine ${on} is disconnected or unavailable. No local fallback was used.`); };
  async function local(action, identity = null) {
    let result;
    try { result = bounded(await execute(node, [`${home}/mods/sessions-plus/services-helper.mjs`, action, ...(identity ? [JSON.stringify(identity)] : [])], { timeout: action === "restart" ? 40000 : 25000 })); }
    catch (error) { if (action === "restart") error.attempted = true; throw error; }
    let data; try { data = JSON.parse(result.stdout); } catch { throw new Error("Services need the existing Node.js executable. No daemon was started."); }
    if (result.code || data.error) { const error = new Error(data.error || "Service probe failed."); error.attempted = data.attempted === true; throw error; }
    return data;
  }
  async function scan() {
    available();
    if (!on) return local("scan");
    return parseRemoteSnapshot(await execute("sh", ["-c", REMOTE_SCAN_SCRIPT, "workspace-services", INSPECT_FORMAT], { on, timeout: 25000 }));
  }
  async function action(action, row) {
    available();
    if (row.on !== undefined && row.on !== on) throw new Error("This container belongs to another machine. Refresh first.");
    const identity = { ...containerIdentity(row, on), daemon: row.daemon };
    if (typeof identity.daemon !== "string" || !identity.daemon || identity.daemon.length > 200) throw new Error("Docker engine identity is unavailable. Refresh first.");
    if (!on) return local(action, identity);
    let result;
    try { result = bounded(await execute("sh", ["-c", REMOTE_ACTION_SCRIPT, "workspace-services", action, identity.id, identity.created, JSON.stringify(identity.daemon)], { on, timeout: action === "restart" ? 35000 : 18000 }), 150000); }
    catch (error) { if (action === "restart") error.attempted = true; throw error; }
    if (result.code) { const error = new Error((result.stderr || "Remote Docker action failed. Refresh before retrying.").slice(0, 500)); error.attempted = action === "restart" && ![40, 41, 42, 43, 44, 45].includes(result.code); throw error; }
    if (action === "restart") {
      if (result.stdout.trim() !== identity.id) { const error = new Error("Restart result is unconfirmed. Refresh before retrying."); error.attempted = true; throw error; }
      return { restarted: true };
    }
    const status = /\n__AW_LOG_RC_(\d+)__\n?$/.exec(result.stdout);
    if (status && Number(status[1])) throw new Error(result.stdout.slice(0, status.index).trim().slice(0, 500) || "Remote container logs unavailable.");
    const text = status ? result.stdout.slice(0, status.index) : result.stdout.slice(0, SERVICE_LIMITS.logs);
    return { text, truncated: !status || text.length > SERVICE_LIMITS.logs };
  }
  return { scan, logs: row => action("logs", row), restart: row => action("restart", row), async listeners() { available(); return (await scan()).ports; }, on };
}
