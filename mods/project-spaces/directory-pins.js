// Directory-level pins belong to this sidebar, independently of terminal pin labels.
export const DIRECTORY_PINS_KEY = "project-spaces.directory-pins.v1";
const valid = value => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
const identifiers = value => Array.isArray(value) ? [...new Set(value.filter(valid))] : [];

/** Return a fresh, well-formed directory pin record without changing the source. */
export function normalizeDirectoryPins(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return { spaces: identifiers(source.spaces), groups: identifiers(source.groups) };
}

/** Set one exact space or project key while preserving every unrelated pin. */
export function setDirectoryPin(raw, kind, id, pinned) {
  const next = normalizeDirectoryPins(raw), key = kind === "space" ? "spaces" : kind === "group" ? "groups" : null;
  if (!key || !valid(id)) return next;
  if (pinned === true) { if (!next[key].includes(id)) next[key].push(id); }
  else next[key] = next[key].filter(value => value !== id);
  return next;
}
