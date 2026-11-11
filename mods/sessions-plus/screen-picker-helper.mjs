// Reads only an explicitly captured terminal. Screen text never reaches executable arguments.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SCREEN_LIMITS, validScreenTarget, sameScreenTerminal, extractScreenCandidates } from "./screen-picker-model.js";
export function screenProcess(args, { cap = 80000, timeout = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("hc", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [], errors = []; let bytes = 0, errorBytes = 0, truncated = false, timedOut = false, killTimer;
    const stop = () => { child.kill("SIGTERM"); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 150); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    child.stdout.on("data", chunk => { if (bytes < cap) chunks.push(chunk.subarray(0, cap - bytes)); bytes += chunk.length; if (bytes > cap) { truncated = true; stop(); } });
    child.stderr.on("data", chunk => { if (errorBytes < 4000) errors.push(chunk.subarray(0, 4000 - errorBytes)); errorBytes += chunk.length; });
    child.on("error", error => { clearTimeout(timer); clearTimeout(killTimer); reject(new Error(error.code === "ENOENT" ? "The existing hc executable was not found." : "The terminal screen could not be read.")); });
    child.on("close", code => { clearTimeout(timer); clearTimeout(killTimer); if (timedOut) reject(new Error("The captured terminal did not answer before the read timeout.")); else resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString("utf8"), stderr: Buffer.concat(errors).toString("utf8"), truncated, bytes }); });
  });
}
export async function readScreen(request, execute = screenProcess) {
  const target = request?.target;
  if (!validScreenTarget(target) || !["scan", "verify"].includes(request.action) || request.history !== undefined && ![0, SCREEN_LIMITS.history].includes(request.history)) throw new Error("A valid captured screen request is required.");
  async function verify() {
    const result = await execute(["get", "--json", target.address], { cap: 80000, timeout: 6000 });
    let terminal; try { terminal = JSON.parse(result.stdout); } catch { throw new Error("The terminal identity could not be verified. Reopen Screen picker."); }
    if (result.code || result.truncated || !sameScreenTerminal(target, terminal, true)) throw new Error("The captured terminal ended, changed, or moved folder. Reopen Screen picker; no replacement was read.");
  }
  await verify();
  const identity = { address: target.address, created_ms: target.created_ms, stamp: target.stamp };
  if (request.action === "verify") return { verified: true, identity };
  const result = await execute(["read", "--lines", String(request.history ?? SCREEN_LIMITS.history), target.address], { cap: SCREEN_LIMITS.bytes, timeout: 8000 });
  if (result.code && !result.truncated) throw new Error("The captured terminal screen is unavailable. Use Refresh to try again.");
  await verify();
  // A cut line might contain half a URL or path. Only complete captured lines become candidates.
  let source = result.stdout;
  if (result.truncated && !source.endsWith("\n")) source = source.slice(0, source.lastIndexOf("\n") + 1);
  const parsed = extractScreenCandidates(source, target);
  return { ...parsed, identity, truncated: result.truncated, history: request.history ?? SCREEN_LIMITS.history, captured: Date.now() };
}
if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => "") === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2] || Buffer.byteLength(process.argv[2]) > 20000) throw new Error("Invalid bounded screen request.");
    process.stdout.write(JSON.stringify(await readScreen(JSON.parse(process.argv[2]))));
  } catch (error) { process.stdout.write(JSON.stringify({ error: String(error.message || error).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 500) })); process.exitCode = 1; }
}
