// UI-safe metadata and captured identities. No transcript reads or image decoding on the UI thread.
import { UUID, PROVIDERS, sessionKey } from "./model.js";
export const ACTIVITY_LIMITS = { pageBytes: 4 * 1024 * 1024, pages: 20, events: 20, images: 12, imageBytes: 2 * 1024 * 1024, pageImages: 8 * 1024 * 1024, dimension: 4096, pixels: 12000000, cacheBytes: 32 * 1024 * 1024, cacheFiles: 96, age: 86400000 };
export function activityTarget(row) {
  if (!row || row.remote || !Object.hasOwn(PROVIDERS, row.provider) || typeof row.store !== "string" || !row.store.startsWith("/") || /[\x00-\x1f\x7f]/.test(row.store) || !UUID.test(row.id || "") || row.key !== sessionKey(row)) throw new Error("Choose an identified local history session. Provider, store and session ID must match exactly.");
  return { provider: row.provider, store: row.store, id: row.id, key: row.key, title: String(row.title || "Session").slice(0, 200) };
}
export const activityTime = value => {
  const number = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(number) && number >= 1e11 && number <= 8640000000000000 ? number : null;
};
export function activityImage(value) {
  if (!value || typeof value.id !== "string" || !/^[a-f0-9]{64}$/.test(value.id) || value.image !== `data/session-gallery/${value.id}.${value.ext}` || !["png", "jpg", "webp"].includes(value.ext) || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.height < 1 || value.width > ACTIVITY_LIMITS.dimension || value.height > ACTIVITY_LIMITS.dimension || value.width * value.height > ACTIVITY_LIMITS.pixels || !Number.isInteger(value.bytes) || value.bytes < 1 || value.bytes > ACTIVITY_LIMITS.imageBytes || typeof value.path !== "string" || !value.path.startsWith("/") || /[\x00-\x1f\x7f]/.test(value.path)) throw new Error("The helper returned invalid local image metadata.");
  return value;
}
export function activityPage(value, target, mode) {
  if (!value || value.key !== target.key || value.mode !== mode || typeof value.available !== "boolean" || value.message !== undefined && (typeof value.message !== "string" || value.message.length > 500) || !Array.isArray(value.events) || value.events.length > ACTIVITY_LIMITS.events || !Array.isArray(value.images) || value.images.length > ACTIVITY_LIMITS.images || !Array.isArray(value.warnings) || value.warnings.length > 12 || !Number.isInteger(value.page) || value.page < 1 || value.page > ACTIVITY_LIMITS.pages || value.warnings.some(item => typeof item !== "string" || item.length > 300) || value.next !== null && (typeof value.next !== "string" || value.next.length > 2000)) throw new Error("The activity page did not match the captured session.");
  if (value.events.some(event => !event || typeof event.id !== "string" || !["prompt", "response", "tool", "duration"].includes(event.kind) || typeof event.title !== "string" || event.title.length > 200 || event.id.length > 100 || typeof event.text !== "string" || event.text.length > 2400 || !Array.isArray(event.files) || event.files.length > 8 || event.files.some(file => typeof file !== "string" || file.length > 301) || event.timestamp !== null && activityTime(event.timestamp) !== event.timestamp || event.durationMs !== null && (!Number.isFinite(event.durationMs) || event.durationMs < 0 || event.durationMs > 604800000))) throw new Error("The helper returned an invalid timeline event.");
  value.images.forEach(activityImage);
  if (value.images.reduce((sum, item) => sum + item.bytes, 0) > ACTIVITY_LIMITS.pageImages || value.images.reduce((sum, item) => sum + item.width * item.height, 0) > ACTIVITY_LIMITS.pixels || value.images.some(item => typeof item.label !== "string" || item.label.length > 200 || typeof item.cached !== "boolean" || item.timestamp !== null && activityTime(item.timestamp) !== item.timestamp)) throw new Error("The image page exceeded its verified preview budget.");
  return value;
}
export function activityReference(target, event) {
  return `Recorded session evidence · ${target.provider} ${target.id}\n${event.timestamp ? new Date(event.timestamp).toISOString() : "Timestamp unavailable"}\n${event.title}\nRecorded excerpt (up to 2,400 characters):\n\n${event.text}\n${event.files.length ? "Recorded tool target(s), not proof of a successful edit:\n" + event.files.join("\n") : ""}`.slice(0, 11000);
}
