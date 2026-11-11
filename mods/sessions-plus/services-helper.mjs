// Short-lived native-machine probes; no daemon launch, shell interpolation or persistent service.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SERVICE_LIMITS, CONTAINER_ID, parseContainers, associatePorts, containerIdentity } from "./services-model.js";
import { parseListeners } from "./ports-model.js";
import { INSPECT_FORMAT } from "./services-protocol.js";
export { INSPECT_FORMAT };
export function runBounded(command, args, { timeout = 9000, cap = SERVICE_LIMITS.output } = {}) {
  return new Promise(resolve => {
    let stdout = [], stderr = [], size = 0, errorSize = 0, truncated = false, timedOut = false, settled = false;
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    const stop = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), truncated, timedOut, ...result }); };
    child.stdout.on("data", value => { const left = Math.max(0, cap - size); stdout.push(value.subarray(0, left)); size += value.length; if (size > cap) { truncated = true; stop(); } });
    child.stderr.on("data", value => { const left = Math.max(0, Math.min(16000, cap) - errorSize); stderr.push(value.subarray(0, left)); errorSize += value.length; if (errorSize > Math.min(16000, cap)) { truncated = true; stop(); } });
    child.on("error", error => finish({ code: 127, error: error.code === "ENOENT" ? `${command} was not found.` : String(error.message).slice(0, 300) }));
    child.on("close", code => finish({ code: code ?? 1 }));
  });
}
const diagnostic = (result, fallback) => result.timedOut ? `${fallback}: timed out.` : result.truncated ? `${fallback}: output limit reached.` : (result.error || result.stderr || fallback).trim().slice(0, 400);
export async function scanDocker(run = runBounded) {
  const warnings = [];
  const info = await run("docker", ["info", "--format", "{{json .ID}}"], { timeout: 6000, cap: 2000 });
  let daemon = null; try { daemon = JSON.parse(info.stdout); } catch { /* Container reads can still succeed, but actions stay disabled. */ }
  if (info.code || typeof daemon !== "string" || !daemon || daemon.length > 200) warnings.push(diagnostic(info, "Docker engine identity unavailable; restart is disabled"));
  const list = await run("docker", ["ps", "--all", "--no-trunc", "--format", "{{.ID}}"], { timeout: 8000, cap: 65536 });
  if (list.code || list.truncated || list.timedOut) return { containers: [], warnings: [...warnings, diagnostic(list, "Docker list unavailable")] };
  const all = list.stdout.trim() ? list.stdout.trim().split(/\r?\n/) : [];
  if (all.some(id => !CONTAINER_ID.test(id))) return { containers: [], warnings: [...warnings, "Docker returned incomplete container IDs; refresh to retry."] };
  if (all.length > SERVICE_LIMITS.containers) warnings.push(`Showing the first ${SERVICE_LIMITS.containers} containers; additional containers were omitted.`);
  const ids = all.slice(0, SERVICE_LIMITS.containers);
  if (!ids.length) return { containers: [], warnings };
  const inspected = await run("docker", ["inspect", "--format", INSPECT_FORMAT, "--", ...ids], { timeout: 10000 });
  if (inspected.truncated || inspected.timedOut) return { containers: [], warnings: [...warnings, diagnostic(inspected, "Docker inspection incomplete")] };
  const parsed = parseContainers(inspected.stdout);
  if (inspected.code) warnings.push(diagnostic(inspected, "Some containers disappeared while refreshing"));
  return { containers: parsed.containers.map(row => ({ ...row, daemon: typeof daemon === "string" && daemon.length <= 200 ? daemon : null })), warnings: [...warnings, ...parsed.warnings] };
}
export async function scanPorts(run = runBounded, platform = process.platform) {
  const kinds = platform === "darwin" ? ["lsof", "ss"] : ["ss", "lsof"], warnings = [];
  for (const kind of kinds) {
    const result = await run(kind, kind === "lsof" ? ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"] : ["-H", "-ltnp"], { timeout: 8000 });
    if (result.code === 127) continue;
    if (result.truncated || result.timedOut || result.code && (kind !== "lsof" || result.stderr || result.stdout)) { warnings.push(diagnostic(result, "TCP listeners unavailable")); continue; }
    const ports = parseListeners(result.stdout, kind);
    if (ports.length >= SERVICE_LIMITS.ports) warnings.push(`Showing at most ${SERVICE_LIMITS.ports} TCP listeners.`);
    warnings.push("Process visibility follows current permissions; some PIDs or listeners may be hidden.");
    return { ports, warnings };
  }
  return { ports: [], warnings: [...warnings, "TCP listeners unavailable: install-free probing needs existing lsof or ss."] };
}
export async function scanServices(run = runBounded, platform = process.platform) {
  const [docker, ports] = await Promise.all([scanDocker(run).catch(error => ({ containers: [], warnings: [String(error.message).slice(0, 400)] })), scanPorts(run, platform).catch(error => ({ ports: [], warnings: [String(error.message).slice(0, 400)] }))]);
  return { containers: docker.containers, ports: associatePorts(ports.ports, docker.containers), warnings: [...new Set([...docker.warnings, ...ports.warnings])], captured: Date.now() };
}
export async function containerAction(action, expected, run = runBounded) {
  const identity = containerIdentity(expected, null);
  if (expected.on !== null || typeof expected.daemon !== "string" || !expected.daemon || expected.daemon.length > 200) throw new Error("The selected Docker engine identity is unavailable. Refresh first.");
  if (!["logs", "restart"].includes(action)) throw new Error("Unsupported container action.");
  const info = await run("docker", ["info", "--format", "{{json .ID}}"], { timeout: 6000, cap: 2000 });
  let daemon; try { daemon = JSON.parse(info.stdout); } catch { /* Checked below. */ }
  if (info.code || daemon !== expected.daemon) throw new Error("The Docker engine changed or is unavailable. No action was taken.");
  const checked = await run("docker", ["inspect", "--format", "{{println .Id}}{{.Created}}", "--", identity.id], { timeout: 6000, cap: 2000 });
  if (checked.code || checked.stdout.trim() !== `${identity.id}\n${identity.created}`) throw new Error("The container changed or disappeared. Refresh before acting.");
  const result = await run("docker", action === "restart" ? ["restart", "--time", "10", "--", identity.id] : ["logs", "--timestamps", "--tail", "300", "--", identity.id], { timeout: action === "restart" ? 20000 : 8000, cap: action === "restart" ? 2000 : SERVICE_LIMITS.logs });
  if (action === "restart") {
    if (result.code || result.timedOut || result.truncated || result.stdout.trim() !== identity.id) { const error = new Error("Restart was requested but its result was not confirmed. Refresh before trying again."); error.attempted = true; throw error; }
    return { restarted: true };
  }
  if (result.timedOut || result.truncated) return { text: (result.stdout + result.stderr).slice(0, SERVICE_LIMITS.logs), truncated: true, warning: diagnostic(result, "Logs incomplete") };
  if (result.code) throw new Error(diagnostic(result, "Container logs unavailable"));
  return { text: (result.stdout + result.stderr).slice(0, SERVICE_LIMITS.logs), truncated: result.stdout.length + result.stderr.length > SERVICE_LIMITS.logs };
}
if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => "") === fileURLToPath(import.meta.url)) {
  try {
    const action = process.argv[2];
    const result = action === "scan" ? await scanServices() : action === "ports" ? await scanPorts() : await containerAction(action, JSON.parse(process.argv[3] || "null"));
    process.stdout.write(JSON.stringify(result));
  } catch (error) { process.stdout.write(JSON.stringify({ error: String(error.message || error).slice(0, 400), attempted: error.attempted === true })); process.exitCode = 1; }
}
