// Only quota fields cross the helper boundary; account identifiers and credentials do not.
const label = value => String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 100);
const finite = value => typeof value === "number" && Number.isFinite(value);
export function resetTime(value) {
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) value = Number(value);
  const ms = finite(value) ? (value < 1e11 ? value * 1000 : value) : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}
function window(id, name, used, reset, minutes) {
  if (!finite(used)) return null;
  used = Math.max(0, Math.min(100, used));
  return { id: label(id), label: label(name), used, remaining: 100 - used, resetAt: resetTime(reset), minutes: finite(minutes) && minutes > 0 ? minutes : null };
}
export function durationLabel(minutes) {
  if (!finite(minutes) || minutes <= 0) return "Quota window";
  return minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}
export function claudeWindows(data) {
  const windows = [];
  const known = { five_hour: ["5h", 300], seven_day: ["7d", 10080], seven_day_sonnet: ["Sonnet · 7d", 10080], seven_day_opus: ["Opus · 7d", 10080] };
  for (const [key, [name, minutes]] of Object.entries(known)) {
    const raw = data?.[key], row = window(key, name, raw?.utilization ?? raw?.used_percentage, raw?.resets_at, minutes);
    if (row) windows.push(row);
  }
  return windows;
}
export function codexWindows(data) {
  const buckets = data?.rateLimitsByLimitId && Object.keys(data.rateLimitsByLimitId).length ? Object.values(data.rateLimitsByLimitId) : [data?.rateLimits];
  return buckets.filter(Boolean).flatMap(bucket => ["primary", "secondary"].flatMap(key => {
    const raw = bucket[key];
    const pool = label(bucket.limitName || bucket.limitId || "Codex").trim();
    const name = /^codex$/i.test(pool) ? durationLabel(raw?.windowDurationMins) : `${pool} · ${durationLabel(raw?.windowDurationMins)}`;
    const row = window(`${bucket.limitId || "codex"}:${key}`, name, raw?.usedPercent, raw?.resetsAt, raw?.windowDurationMins);
    return row ? [row] : [];
  }));
}
/** Daily account tokens from Codex `account/usage/read`: `[{ date: "YYYY-MM-DD", tokens }]`, oldest first. Nothing else is kept. */
export function codexUsageDays(data) {
  const days = new Map();
  for (const bucket of Array.isArray(data?.dailyUsageBuckets) ? data.dailyUsageBuckets.slice(-400) : []) {
    const date = typeof bucket?.startDate === "string" ? /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(bucket.startDate)?.[1] : null;
    if (date && finite(bucket.tokens) && bucket.tokens >= 0) days.set(date, Math.round(bucket.tokens));
  }
  return [...days].sort(([a], [b]) => a < b ? -1 : 1).map(([date, tokens]) => ({ date, tokens }));
}
export function agyWindows(envelope) {
  if (envelope?.status !== "SUCCESS" || envelope.command?.name !== "usage" || !Array.isArray(envelope.command.data?.groups)) return null;
  return envelope.command.data.groups.flatMap(group => {
    const rows = (Array.isArray(group.buckets) ? group.buckets : []).flatMap(bucket => {
      const name = `${label(group.name || "Antigravity")}${bucket.name ? " · " + label(bucket.name) : ""}`;
      if (bucket.disabled === true) return [{ id: label(bucket.id), label: name, unlimited: true, used: null, remaining: null, resetAt: null, minutes: null }];
      const fraction = bucket.remaining_fraction;
      if (!finite(fraction) || fraction < 0 || fraction > 1) return [];
      const row = window(bucket.id, name, (1 - fraction) * 100, bucket.reset_time, bucket.window === "weekly" ? 10080 : bucket.window === "5h" ? 300 : null);
      return row ? [row] : [];
    });
    return rows
      .map((row, index) => [row, index])
      .sort(([a, i], [b, j]) => {
        const ma = a.minutes ?? Infinity, mb = b.minutes ?? Infinity;
        return ma !== mb ? ma - mb : i - j;
      })
      .map(([row]) => row);
  });
}
export function quotaWarning(data) {
  if (!["stale", "unavailable"].includes(data?.state) || ["missing-cli", "signed-out"].includes(data.reason)) return "";
  return data.message || "Quota refresh failed. Try again.";
}
export function percentage(row, mode = "remaining") {
  if (row.unlimited) return "Unmetered";
  const value = row[mode === "used" ? "used" : "remaining"];
  return finite(value) ? `${Number(value.toFixed(1))}%` : "Unavailable";
}
export function resetLabel(value, now = Date.now()) {
  if (!value) return "Reset time unavailable";
  const minutes = Math.ceil((value - now) / 60000);
  if (minutes <= 0) return "Reset time passed · refresh";
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
  const relative = days ? `${days}d ${hours}h` : hours ? `${hours}h ${mins}m` : `${mins}m`;
  const date = new Date(value), clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `Resets in ${relative} · ${date.getMonth() + 1}/${date.getDate()} ${clock}`;
}

// A time benchmark, not a prediction. Expired, stale or unknown windows have no pace reading.
export function quotaPace(row, now = Date.now(), stale = false) {
  if (stale || row?.unlimited || !finite(row?.used) || row.used < 0 || row.used > 100 ||
    !finite(row.resetAt) || !finite(row.minutes) || row.minutes <= 0 || !finite(now)) return null;
  const duration = row.minutes * 60000, left = row.resetAt - now;
  if (left <= 0 || left > duration || !finite(duration)) return null;
  const elapsed = 100 * (1 - left / duration), difference = row.used - elapsed;
  return { elapsed, difference, state: difference > 10 ? "ahead" : difference < -10 ? "under" : "steady" };
}
export function paceLabel(row, now = Date.now(), stale = false) {
  const pace = quotaPace(row, now, stale);
  if (!pace) return "Pace unavailable";
  const label = pace.state === "ahead" ? "Using faster than time elapsed" : pace.state === "under" ? "Using slower than time elapsed" : "Near the time benchmark";
  return `${label} · ${Math.round(pace.elapsed)}% time elapsed / ${Number(row.used.toFixed(1))}% used`;
}
