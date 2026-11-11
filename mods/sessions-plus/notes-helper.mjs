// One short-lived, bounded notes transform. Disk writes remain atomic in the native client.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeNotes, encodeNotes, updateNote, removeArchivedNote, validNoteScope } from "./notes-model.js";

const JOB = /^job-\d{13}-\d{1,12}-[a-z\d]+\.json$/;
const REQUEST_BYTES = 2200000;
async function owned(folder) {
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error("Notes storage must be an owned directory.");
  await fs.chmod(folder, 0o700);
}
export async function setupNotesHome(home) {
  if (typeof home !== "string" || !path.isAbsolute(home)) throw new Error("An absolute Herdr home is required.");
  const root = path.join(home, "data/workspace-notes"), jobs = path.join(root, "jobs");
  await owned(root); await owned(jobs);
  for (const name of await fs.readdir(jobs)) {
    if (!JOB.test(name) || Date.now() - Number(name.split("-")[1]) <= 86400000) continue;
    const file = path.join(jobs, name), info = await fs.lstat(file).catch(() => null);
    if (info?.isFile() && !info.isSymbolicLink() && info.uid === process.getuid()) await fs.unlink(file).catch(() => {});
  }
  return { ready: true };
}
export async function prepareNotesRequest(home, name) {
  if (typeof home !== "string" || !path.isAbsolute(home) || !JOB.test(name || "")) throw new Error("Invalid notes request.");
  const folder = path.join(home, "data/workspace-notes/jobs"); await owned(folder);
  const file = path.join(folder, name), info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.size > REQUEST_BYTES) throw new Error("Invalid or oversized notes request.");
  const raw = await fs.readFile(file, "utf8");
  // Remove plaintext request content before parsing/encoding, including if the parent view closes.
  await fs.unlink(file);
  const request = JSON.parse(raw), state = decodeNotes(request.raw);
  if (request.action === "validate") return { raw: encodeNotes(state) };
  if (!validNoteScope(request.scope)) throw new Error("A captured note context is required.");
  const next = request.action === "save" ? updateNote(state, request.scope, request.changes || {}, request.expectedRevision)
    : request.action === "remove" ? removeArchivedNote(state, request.scope, request.expectedRevision) : null;
  if (!next) throw new Error("Unsupported notes action.");
  return { raw: encodeNotes(next.state) };
}
if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => "") === fileURLToPath(import.meta.url)) {
  try {
    const action = process.argv[2], home = process.argv[3];
    const result = action === "setup" ? await setupNotesHome(home) : action === "prepare" ? await prepareNotesRequest(home, process.argv[4]) : null;
    if (!result) throw new Error("Unsupported notes operation.");
    process.stdout.write(JSON.stringify(result));
  } catch (error) { process.stdout.write(JSON.stringify({ error: String(error.message || error).slice(0, 400), ...(error.code === "NOTE_CONFLICT" ? { code: error.code } : {}) })); process.exitCode = 1; }
}
