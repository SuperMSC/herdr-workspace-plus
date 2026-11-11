// Small native-side helpers; full store validation and filtering run in the short-lived Node helper.
export const DELIVERABLE_DRAFTS = "sessions-plus.deliverable-forms.v1";
export const DELIVERABLE_CHANGED = "sessions-plus.deliverables-changed.v1";
export const DELIVERABLE_LIMITS = { page: 20, projects: 40, perProject: 500, total: 2000, bytes: 8388608, drafts: 8 };
export function deliverableScope(value = {}) {
  let root = value.root ?? value.cwd;
  if (typeof root !== "string" || !root || root.length > 2000 || /[\x00-\x1f\x7f]/.test(root) || !(root.startsWith("/") || /^[a-z]:[\\/]/i.test(root)) || root.split(/[\\/]/).includes("..")) throw new Error("An absolute project folder is required.");
  root = /^[a-z]:[\\/]/i.test(root) ? root.replace(/\\/g, "/") : root;
  root = root.replace(/\/+/g, "/").replace(/\/+$/, "") || "/"; if (/^[a-z]:$/i.test(root)) root += "/";
  const on = value.on || null;
  if (on !== null && (typeof on !== "string" || on.length > 200 || /[\s/\x00-\x1f\x7f]/.test(on))) throw new Error("The captured machine name is invalid.");
  return { root, on, key: JSON.stringify([on, root]) };
}
export const deliverableDraftRevision = draft => draft ? JSON.stringify(draft) : null;
export const deliverableDraftContent = draft => JSON.stringify([draft.itemId, draft.baseRevision, draft.kind, draft.title, draft.location, draft.note]);
export function deliverableDrafts(raw) {
  if (raw === null || raw === undefined || raw === "") return [];
  let rows; try { rows = JSON.parse(raw); } catch { throw new Error("Saved forms are unreadable. They were not replaced."); }
  if (!Array.isArray(rows) || rows.length > 8 || rows.some(row => !row || typeof row.id !== "string" || !row.scope || deliverableScope(row.scope).key !== row.scope.key)) throw new Error("Saved forms are invalid. They were not replaced.");
  return rows;
}
export function saveDeliverableDraft(rows, draft, expected) {
  const original = rows.find(row => row.id === draft.id);
  if (expected !== undefined && deliverableDraftRevision(original) !== expected) throw new Error("This form changed or was discarded in another view. The visible form has not overwritten it.");
  if (!original && rows.length >= 8) throw new Error("Eight unfinished forms are saved. Discard an unused form first.");
  for (const [key, max] of [["title", 160], ["location", 4000], ["note", 1000]]) if (typeof draft[key] !== "string" || draft[key].length > max || draft[key].includes("\0")) throw new Error("The visible form exceeds its text limit. Shorten it before closing.");
  const result = [...rows.filter(row => row.id !== draft.id), { ...draft, updated: Date.now() }];
  if (JSON.stringify(result).length > 160000) throw new Error("Saved forms are full. Existing forms remain available.");
  return result;
}
export function removeDeliverableDraft(rows, id, expected) {
  if (expected !== undefined && deliverableDraftRevision(rows.find(row => row.id === id)) !== expected) throw new Error("This saved form changed. Review it again before discarding.");
  return rows.filter(row => row.id !== id);
}
export function safeDeliverableUrl(value) {
  if (typeof value !== "string" || value.length > 4000 || !/^https?:\/\/[^/\s?#]+/i.test(value) || /[\x00-\x20\x7f\\]/.test(value) || /^https?:\/\/[^/?#]*@/i.test(value)) throw new Error("Only an absolute HTTP or HTTPS URL can be opened.");
  return value;
}
