// Bounded note documents and recovery drafts. Context identities never depend on tab names.
import { PROVIDERS, UUID } from "./model.js";

export const NOTES_LIMITS = { notes: 120, title: 120, body: 40000, versions: 3, bytes: 900000, drafts: 40, draftText: 200000 };
export const NOTES_DRAFTS = "sessions-plus.notes.drafts.v1";
export const NOTES_CHANGED = "sessions-plus.notes.changed.v1";
const string = value => typeof value === "string" ? value : "";
const label = value => string(value).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
const machine = value => typeof value === "string" && value ? value : null;
export const globalNoteScope = () => ({ key: '["global"]', type: "global", label: "Global", on: null, folder: "" });

export function projectNoteScope(value = {}) {
  const folder = string(value.root || value.cwd).replace(/[\\/]+$/, "") || (value.root === "/" || value.cwd === "/" ? "/" : "");
  if (!folder || !/^(?:\/|[A-Za-z]:[\\/])/.test(folder) || folder.length > 2000 || /[\x00-\x1f\x7f]/.test(folder)) return null;
  const on = machine(value.on ?? value.machine);
  return { key: JSON.stringify(["project", on, folder]), type: "project", label: label(value.title || folder.split(/[\\/]/).pop() || folder), on, folder };
}

export function sessionNoteScope(row) {
  if (!row || !Object.hasOwn(PROVIDERS, row.provider)) return null;
  let fields = [];
  try { fields = JSON.parse(row.key || "[]"); } catch { /* Only explicit, verifiable identities are used. */ }
  const on = machine(row.on ?? row.machine ?? (row.address?.includes("/") ? row.address.slice(0, row.address.lastIndexOf("/")) : null));
  const id = row.id || row.sessionId;
  const store = row.store || (fields[0] === "session" ? fields[3] : "");
  let identity;
  if (UUID.test(id || "") && typeof store === "string" && store && store !== "default") identity = ["session", on, row.provider, store, id];
  else if (typeof row.address === "string" && Number.isFinite(row.created) && row.created > 0 && typeof row.launch === "string" && row.launch) identity = ["terminal", row.address, row.created, row.provider, row.launch];
  else return null;
  return { key: JSON.stringify(identity), type: "session", label: label(row.title || PROVIDERS[row.provider]), on, folder: string(row.cwd).slice(0, 2000), provider: row.provider, sessionId: UUID.test(id || "") ? id : null };
}

export function validNoteScope(scope) {
  if (!scope || !["project", "session", "global"].includes(scope.type) || typeof scope.key !== "string" || scope.key.length > 5000 || typeof scope.label !== "string" || scope.label.length > 120 || typeof scope.folder !== "string" || scope.folder.length > 2000 || !(scope.on == null || typeof scope.on === "string" && scope.on.length <= 200)) return false;
  try {
    const parts = JSON.parse(scope.key);
    return Array.isArray(parts) && (scope.type === "global" ? parts.length === 1 && parts[0] === "global" : scope.type === "project" ? parts.length === 3 && parts[0] === "project" && parts[1] === (scope.on ?? null) && parts[2] === scope.folder : ["session", "terminal"].includes(parts[0]) && parts.length >= 5);
  } catch { return false; }
}

export function utf8Size(value) {
  // Native replacements avoid a per-character JavaScript loop on a nearly full store.
  return value.replace(/[\ud800-\udbff][\udc00-\udfff]/g, "0000").replace(/[\u0080-\u07ff]/g, "00").replace(/[\u0800-\uffff]/g, "000").length;
}

function validContent(note) { return typeof note?.title === "string" && note.title.length <= NOTES_LIMITS.title && typeof note.body === "string" && note.body.length <= NOTES_LIMITS.body && !note.body.includes("\0"); }
export function decodeNotes(raw) {
  if (raw === null || raw === undefined) return { schema: 1, notes: [] };
  if (typeof raw !== "string" || utf8Size(raw) > NOTES_LIMITS.bytes) throw new Error("Notes storage exceeds its size limit. The existing file was left unchanged.");
  let state;
  try { state = JSON.parse(raw); } catch { throw new Error("Notes storage is unreadable. The existing file was left unchanged."); }
  if (state?.schema !== 1 || !Array.isArray(state.notes) || state.notes.length > NOTES_LIMITS.notes) throw new Error("Unsupported notes storage. The existing file was left unchanged.");
  const keys = new Set();
  for (const note of state.notes) {
    if (!validNoteScope(note.scope) || note.key !== note.scope.key || keys.has(note.key) || !validContent(note) || typeof note.archived !== "boolean" || !Number.isSafeInteger(note.revision) || note.revision < 1 || !Number.isFinite(note.updated) || !Array.isArray(note.versions) || note.versions.length > NOTES_LIMITS.versions || note.versions.some(version => !validContent(version) || !Number.isSafeInteger(version.revision) || version.revision < 1 || !Number.isFinite(version.updated))) throw new Error("A saved note is invalid. The existing file was left unchanged.");
    keys.add(note.key);
  }
  if (state.clock !== undefined && (!Number.isSafeInteger(state.clock) || state.clock < Math.max(0, ...state.notes.map(note => note.revision)))) throw new Error("Notes revision data is invalid. The existing file was left unchanged.");
  return state;
}
export function encodeNotes(state) { const raw = JSON.stringify(state); decodeNotes(raw); return raw; }

export function noteFor(state, scope) { return state.notes.find(note => note.key === scope?.key) || null; }
export function updateNote(state, scope, changes, expectedRevision, now = Date.now()) {
  if (!validNoteScope(scope)) throw new Error("A captured project, session or global context is required.");
  const previous = noteFor(state, scope), revision = previous?.revision || 0;
  if (revision !== expectedRevision) { const error = new Error("This note changed in another view. Your draft is kept; copy or reload the saved note."); error.code = "NOTE_CONFLICT"; error.note = previous; throw error; }
  const title = label(changes.title) || scope.label || "Untitled", body = string(changes.body);
  if (string(changes.title).length > NOTES_LIMITS.title || body.length > NOTES_LIMITS.body || body.includes("\0")) throw new Error(`A note supports ${NOTES_LIMITS.title} title characters and ${NOTES_LIMITS.body.toLocaleString()} body characters, without NUL.`);
  if (!previous && state.notes.length >= NOTES_LIMITS.notes) throw new Error(`The ${NOTES_LIMITS.notes}-note limit is reached. No saved notes were removed.`);
  const changed = previous && (previous.title !== title || previous.body !== body);
  const versions = changes.clearVersions ? [] : changed ? [{ title: previous.title, body: previous.body, revision: previous.revision, updated: previous.updated }, ...previous.versions].slice(0, NOTES_LIMITS.versions) : previous?.versions || [];
  const clock = Math.max(state.clock || 0, ...state.notes.map(note => note.revision)) + 1;
  if (!Number.isSafeInteger(clock)) throw new Error("The notes revision limit was reached. Existing notes were left unchanged.");
  const note = { key: scope.key, scope: { ...scope }, title, body, archived: changes.archived ?? previous?.archived ?? false, revision: clock, created: previous?.created || now, updated: now, versions };
  const next = { schema: 1, clock, notes: [...state.notes.filter(entry => entry.key !== scope.key), note] };
  encodeNotes(next);
  return { state: next, note };
}

export function removeArchivedNote(state, scope, expectedRevision) {
  const current = noteFor(state, scope);
  if (!current || current.revision !== expectedRevision) { const error = new Error("This note changed before removal. Refresh and check it again."); error.code = "NOTE_CONFLICT"; throw error; }
  if (!current.archived) throw new Error("Archive the note before removing it.");
  const clock = Math.max(state.clock || 0, ...state.notes.map(note => note.revision)) + 1;
  const next = { schema: 1, clock, notes: state.notes.filter(note => note.key !== scope.key) };
  encodeNotes(next);
  return { state: next, note: null };
}

export function filterNotes(state, query = "", archived = false) {
  const terms = String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return state.notes.filter(note => (archived || !note.archived) && terms.every(term => [note.title, note.body, note.scope.label, note.scope.folder, note.scope.provider].some(value => string(value).toLocaleLowerCase().includes(term))))
    .sort((a, b) => b.updated - a.updated);
}

export function decodeNoteDrafts(raw) {
  if (raw === null || raw === undefined) return [];
  let drafts;
  try { drafts = JSON.parse(raw); } catch { throw new Error("Note recovery data is unreadable. It was left unchanged."); }
  if (!Array.isArray(drafts) || drafts.length > NOTES_LIMITS.drafts || drafts.some(draft => !validNoteScope(draft.scope) || typeof draft.owner !== "string" || draft.owner.length > 100 || !validContent(draft) || !Number.isSafeInteger(draft.baseRevision) || draft.baseRevision < 0)) throw new Error("Note recovery data is invalid. It was left unchanged.");
  return drafts;
}
export function keepNoteDraft(drafts, value) {
  if (!validNoteScope(value.scope) || !validContent(value)) throw new Error("This draft exceeds the note limit; copy the text before closing.");
  const next = [...drafts.filter(draft => !(draft.owner === value.owner && draft.scope.key === value.scope.key)), { ...value, updated: Date.now() }];
  if (next.length > NOTES_LIMITS.drafts || next.reduce((sum, draft) => sum + draft.title.length + draft.body.length, 0) > NOTES_LIMITS.draftText) { const error = new Error("Note recovery is full. Use Save or copy this edit before closing; existing drafts are kept."); error.code = "NOTE_DRAFT_LIMIT"; throw error; }
  return next;
}
export const dropNoteDraft = (drafts, owner, key) => drafts.filter(draft => draft.owner !== owner || draft.scope.key !== key);
