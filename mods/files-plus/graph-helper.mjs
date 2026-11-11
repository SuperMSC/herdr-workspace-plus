// Short-lived, read-only Git child processes with explicit output and time bounds.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readGraphRepository } from "./graph-reader.js";
export function boundedGraphExec(program, argv, options) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
    const child = spawn(program, argv, { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const out = [], err = []; let total = 0, failure = null;
    const stop = message => { failure ||= new Error(message); child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop("Git graph read timed out."), options.timeout || 8000);
    child.stdout.on("data", chunk => { total += chunk.length; if (total > 700000) stop("Git graph output exceeded its preview limit."); else out.push(chunk); });
    child.stderr.on("data", chunk => { total += chunk.length; if (total > 700000) stop("Git graph output exceeded its preview limit."); else err.push(chunk); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); if (failure) reject(failure); else resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }); });
  });
}
if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => "") === fileURLToPath(import.meta.url)) {
  try { const request = JSON.parse(process.argv[2] || "{}"); if (request.context?.on) throw new Error("Local graph helper cannot read remote machines."); process.stdout.write(JSON.stringify(await readGraphRepository(boundedGraphExec, request.context, request.selection))); }
  catch (error) { process.stdout.write(JSON.stringify({ error: String(error.message || error).slice(0, 500) })); process.exitCode = 1; }
}
