// Pure rules for editing a previewed file: when it may be edited, how text is saved, and
// where an unsaved draft is kept. No Herdr calls, so tests run it in Node.

export const EDIT_LIMIT = 400000;
export const DRAFT_LIMIT = 1024 * 1024;
// Files with unsaved edits, by preview id, so the pane header can mark them.
export const DIRTY_KEY = "files-plus.dirty.v1";

/** Why a loaded preview cannot be edited, or null when it can. */
export function editBlocker(data, on) {
  if (on) return "Editing is available for files on this computer";
  if (!data || typeof data.text !== "string") return "This preview has no text to edit";
  if (data.truncated || data.text.length > EDIT_LIMIT) return "Files over 400 KB open read only";
  return null;
}

/**
 * The text to write. Editors work in LF; a file saved with CRLF keeps CRLF, so an edit never
 * rewrites every line ending of a Windows file.
 */
export function textToSave(value, base) {
  const text = String(value ?? "");
  if (!String(base ?? "").includes("\r\n")) return text;
  return text.replace(/\r?\n/g, "\r\n");
}

/** Whether the editor holds anything that differs from the file it started from. */
export function isDirty(value, base) {
  if (typeof value !== "string" || typeof base !== "string") return false;
  return textToSave(value, base) !== base;
}

/** A stable file name for one file's draft: no path characters, the same on every run. */
export function draftName(root, path) {
  let hash = 0x811c9dc5, second = 0x01000193;
  for (const char of JSON.stringify([root, path])) {
    const code = char.codePointAt(0);
    hash = Math.imul(hash ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x5bd1e995) >>> 0;
  }
  const base = String(path).split("/").pop().replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "file";
  return `${base}-${hash.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}.json`;
}

/** A draft as stored, or null when the record is damaged or belongs to another file. */
export function readDraft(raw, root, path) {
  let draft;
  try { draft = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
  if (!draft || typeof draft !== "object" || draft.root !== root || draft.path !== path) return null;
  if (typeof draft.text !== "string" || typeof draft.base !== "string" || draft.text.length > DRAFT_LIMIT) return null;
  return { root, path, text: draft.text, base: draft.base, saved: Number(draft.saved) || 0 };
}

export function writeDraft(root, path, text, base, now = Date.now()) {
  return JSON.stringify({ version: 1, root, path, base, text, saved: now });
}

/** "just now", "5 min ago", or a local date and time, for when a draft was kept. */
export function draftAge(saved, now = Date.now()) {
  const minutes = Math.floor((now - saved) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return new Date(saved).toLocaleString();
}
