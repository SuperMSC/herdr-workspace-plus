// Atomic compare-and-swap protects concurrent views; the only file is this mod's owned note store.
import { decodeNotes, encodeNotes, updateNote, removeArchivedNote } from "./notes-model.js";

export function createNotesClient({ read, write, mkdir }, home) {
  if (typeof home !== "string" || !home.startsWith("/") || home.includes("\0")) throw new Error("An absolute Herdr home is required.");
  const folder = `${home}/data/workspace-notes`, file = `${folder}/notes.json`;
  async function mutate(change) {
    await mkdir(folder, { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = await read(file), current = decodeNotes(raw), result = change(current);
      try { await write(file, encodeNotes(result.state), raw); return result; }
      catch (error) { if (await read(file) === raw || attempt === 2) throw error; }
    }
    throw new Error("Notes changed repeatedly. Your draft is kept; try Save again.");
  }
  return {
    async load() { return decodeNotes(await read(file)); },
    save: (scope, changes, expectedRevision) => mutate(current => updateNote(current, scope, changes, expectedRevision)),
    remove: (scope, expectedRevision) => mutate(current => removeArchivedNote(current, scope, expectedRevision)),
    file,
  };
}


// The native runtime delegates bounded validation/serialization to Node, then uses its atomic write API.
export function createNativeNotesClient({ exec, read, write, mkdir, unlink }, home, node = "node") {
  if (typeof home !== "string" || !home.startsWith("/") || home.includes("\0")) throw new Error("An absolute Herdr home is required.");
  const folder = `${home}/data/workspace-notes`, file = `${folder}/notes.json`, helper = `${home}/mods/sessions-plus/notes-helper.mjs`;
  let ready = null, sequence = 0;
  async function response(args) {
    const result = await exec(node, [helper, ...args], { timeout: 10000 });
    let data;
    try { data = JSON.parse(result.stdout || "{}"); } catch { throw new Error("Notes storage needs the existing Node.js executable. No saved notes were changed."); }
    if (result.code || data.error) { const error = new Error(data.error || "Could not update notes storage."); error.code = data.code; throw error; }
    return data;
  }
  async function ensure() {
    if (!ready) ready = response(["setup", home]);
    try { await ready; } catch (error) { ready = null; throw error; }
  }
  async function prepare(request) {
    await ensure();
    const name = `job-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2) || "0"}.json`, job = `${folder}/jobs/${name}`;
    try {
      await write(job, JSON.stringify(request), null);
      const data = await response(["prepare", home, name]);
      if (typeof data.raw !== "string") throw new Error("Notes storage returned an invalid result. No saved notes were changed.");
      // The helper has validated the bounded schema. Native JSON parsing stays off JS character loops.
      return { raw: data.raw, state: JSON.parse(data.raw) };
    } catch (error) { ready = null; throw error; }
    finally { await unlink(job).catch(() => {}); }
  }
  async function mutate(scope, changes, expectedRevision, remove = false) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = await read(file);
      const result = await prepare({ action: remove ? "remove" : "save", raw, scope, changes, expectedRevision });
      try {
        await write(file, result.raw, raw);
        return { state: result.state, note: result.state.notes.find(note => note.key === scope.key) || null };
      } catch (error) { if (await read(file) === raw || attempt === 2) throw error; }
    }
    throw new Error("Notes changed repeatedly. Your draft is kept; try Save again.");
  }
  return {
    async load() { return (await prepare({ action: "validate", raw: await read(file) })).state; },
    save: (scope, changes, expectedRevision) => mutate(scope, changes, expectedRevision),
    remove: (scope, expectedRevision) => mutate(scope, null, expectedRevision, true),
    file,
  };
}
