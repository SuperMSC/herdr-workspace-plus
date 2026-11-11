// Local GitHub reads run off the UI thread with strict time/output bounds and no shell.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readGithub } from "./github-client.js";
import { GITHUB_LIMITS, githubError } from "./github-model.js";

export function githubProcess(program, args, { cwd, timeout = 12000, log = false, env = process.env } = {}) {
  return new Promise((resolveResult, reject) => {
    const childEnv = { ...env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" };
    // GH_REPO overrides cwd discovery; preserve the user's existing authentication.
    delete childEnv.GH_REPO;
    const child = spawn(program, args, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    const output = [], errors = []; const limit = log ? GITHUB_LIMITS.log : GITHUB_LIMITS.json;
    let total = 0, errorBytes = 0, truncated = false, timedOut = false, killTimer;
    const stop = () => { child.kill("SIGTERM"); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 200); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, timeout));
    child.stdout.on("data", chunk => {
      const room = limit - total;
      if (room > 0) output.push(chunk.subarray(0, room));
      total += chunk.length;
      if (total > limit) { truncated = true; stop(); }
    });
    child.stderr.on("data", chunk => { if (errorBytes < 16000) errors.push(chunk.subarray(0, 16000 - errorBytes)); errorBytes += chunk.length; });
    child.on("error", error => { clearTimeout(timer); clearTimeout(killTimer); const failure = new Error(githubError(error, program)); reject(failure); });
    child.on("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (timedOut) reject(new Error("GitHub read timed out."));
      else if (truncated && !log) reject(new Error("GitHub output exceeded the bounded preview limit."));
      else if (signal && !truncated) reject(new Error("GitHub read was interrupted. Use Refresh to try again."));
      else resolveResult({ code: truncated && log ? 0 : code, stdout: Buffer.concat(output).toString("utf8"), stderr: Buffer.concat(errors).toString("utf8"), truncated });
    });
  });
}
export async function localGithub(request, { execute = githubProcess, timeout = 24000 } = {}) {
  if (request?.context?.on) throw new Error("Remote reads must use the captured Herdr transport.");
  const deadline = Date.now() + timeout;
  return readGithub(request, (program, args, options) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("GitHub read timed out.");
    return execute(program, args, { cwd: options.cwd, timeout: Math.min(options.timeout, remaining), log: options.log });
  });
}
if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => "") === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2] || Buffer.byteLength(process.argv[2]) > 20000) throw new Error("Invalid bounded GitHub request.");
    process.stdout.write(JSON.stringify(await localGithub(JSON.parse(process.argv[2]))));
  } catch (error) { process.stdout.write(JSON.stringify({ error: githubError(error) })); process.exitCode = 1; }
}
