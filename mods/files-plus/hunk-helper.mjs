// A short-lived local transaction. Git index changes are isolated until atomic publication.
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { HUNK_READ, hunkPath } from "./hunk-model.js";
import { readHunkSource } from "./hunk-reader.js";
const digest = value => createHash("sha256").update(value).digest("hex");
const aborted = signal => { if (signal?.aborted) throw new Error("Hunk action was cancelled before publication."); };

function executeGit(root, env, deadline, signal, args, input = null) {
  aborted(signal);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Hunk action timed out. Refresh the diff before retrying.");
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...HUNK_READ, ...args], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], signal });
    const output = [], errors = []; let bytes = 0, overflow = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), Math.min(remaining, 2500));
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { overflow = true; child.kill("SIGKILL"); } else output.push(chunk); });
    child.stderr.on("data", chunk => { if (errors.reduce((sum, part) => sum + part.length, 0) < 64000) errors.push(chunk); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", (code, killed) => {
      clearTimeout(timer);
      if (overflow) reject(new Error("Git output exceeds the hunk action limit."));
      else if (killed) reject(new Error("Hunk action was interrupted. Refresh before retrying."));
      else resolve({ code, stdout: Buffer.concat(output).toString("utf8"), stderr: Buffer.concat(errors).toString("utf8") });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input === null ? undefined : input);
  });
}

export async function applyHunk(request, { signal, execute: suppliedExecute } = {}) {
  if (process.platform !== "darwin") throw new Error("Hunk actions currently require local macOS.");
  if (!request || typeof request.root !== "string" || !path.isAbsolute(request.root) || request.root.includes("\0") || request.on) throw new Error("A captured local repository is required.");
  if (!["stage", "unstage"].includes(request.action) || request.file?.section !== (request.action === "stage" ? "unstaged" : "staged")) throw new Error("Invalid hunk operation.");
  hunkPath(request.file?.path);
  if (typeof request.version !== "string" || !Number.isSafeInteger(request.hunk?.index) || request.hunk.index < 0 || typeof request.hunk.patch !== "string" || request.hunk.patch.length > 100000) throw new Error("Invalid captured hunk.");
  const root = await fs.realpath(request.root), deadline = Date.now() + 8000, env = { ...process.env };
  const execute = suppliedExecute || ((args, options = {}) => executeGit(root, options.env || env, deadline, signal, args, options.input ?? null));
  const git = async (args, options) => {
    aborted(signal);
    const result = await execute(args, options);
    if (result?.code !== 0) throw new Error((result?.stderr || result?.stdout || "Git rejected this hunk.").trim());
    return result.stdout;
  };
  const top = (await git(["rev-parse", "--show-toplevel"])).replace(/\r?\n$/, "");
  if (await fs.realpath(top) !== root) throw new Error("The captured folder no longer identifies this checkout.");
  const working = path.join(root, request.file.path), workingReal = await fs.realpath(working), workingInfo = await fs.lstat(working);
  if (!workingReal.startsWith(root + path.sep) || !workingInfo.isFile() || workingInfo.isSymbolicLink()) throw new Error("Hunk actions require a regular file inside this checkout.");
  const rawIndex = (await git(["rev-parse", "--git-path", "index"])).replace(/\r?\n$/, "");
  const index = path.resolve(root, rawIndex), info = await fs.lstat(index);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error("The checkout index is not a regular owned file.");
  const lockPath = index + ".lock";
  let lock, lockIdentity, scratch, published = false;
  try {
    try { lock = await fs.open(lockPath, "wx", info.mode & 0o777); }
    catch (error) { if (error.code === "EEXIST") throw new Error("Another Git operation holds the index lock. Wait, then refresh before retrying."); throw error; }
    lockIdentity = await lock.stat();
    const original = await fs.readFile(index);
    const capture = () => readHunkSource(async (_command, args) => {
      // The reader already supplies its read-only prefix.
      const result = await execute(args.slice(HUNK_READ.length));
      return result;
    }, { root, on: null }, request.file);
    const current = await capture();
    const selected = current.hunks[request.hunk.index];
    if (current.version !== request.version || !selected?.enabled || selected.header !== request.hunk.header || selected.patch !== request.hunk.patch) throw new Error("This hunk or its source versions changed. Refresh and select the hunk again.");
    scratch = await fs.mkdtemp(path.join(path.dirname(index), ".files-plus-hunk-"));
    const alternate = path.join(scratch, "index");
    await fs.writeFile(alternate, original, { flag: "wx", mode: 0o600 });
    const flags = ["apply", "--cached", "--whitespace=nowarn", ...(request.action === "unstage" ? ["--reverse"] : [])];
    const options = { env: { ...env, GIT_INDEX_FILE: alternate }, input: selected.patch };
    await git([...flags, "--check", "-"], options);
    await git([...flags, "-"], options);
    aborted(signal);
    const final = await capture();
    if (final.version !== request.version || digest(await fs.readFile(index)) !== digest(original)) throw new Error("The checkout changed during this action. No hunk was published; refresh before retrying.");
    const next = await fs.readFile(alternate);
    await lock.writeFile(next); await lock.sync();
    aborted(signal);
    const existingLock = await fs.lstat(lockPath);
    if (existingLock.dev !== lockIdentity.dev || existingLock.ino !== lockIdentity.ino) throw new Error("The Git lock changed. Refresh before retrying.");
    await lock.close(); lock = null;
    await fs.rename(lockPath, index); published = true;
    return { ok: true, action: request.action, path: request.file.path, header: selected.header };
  } finally {
    if (lock) await lock.close().catch(() => {});
    if (!published && lockIdentity) {
      const existingLock = await fs.lstat(lockPath).catch(() => null);
      if (existingLock?.dev === lockIdentity.dev && existingLock?.ino === lockIdentity.ino) await fs.unlink(lockPath).catch(() => {});
    }
    if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort()); process.once("SIGINT", () => controller.abort());
  try {
    if (!process.argv[2] || Buffer.byteLength(process.argv[2]) > 120000) throw new Error("Captured hunk request is too large.");
    process.stdout.write(JSON.stringify(await applyHunk(JSON.parse(process.argv[2]), { signal: controller.signal })));
  } catch (error) { process.stdout.write(JSON.stringify({ error: String(error.message || error).slice(0, 500) })); process.exitCode = 1; }
}
