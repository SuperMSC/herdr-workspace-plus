import { SERVICE_LIMITS } from "./services-model.js";
const clean = value => String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 140);
export function parseEndpoint(value) {
  const match = /^(?:\[([^\]]+)\]|(.+)):(\d{1,5})$/.exec(value || "");
  if (!match) return null;
  const port = Number(match[3]), address = match[1] || match[2];
  if (port < 1 || port > 65535 || address.length > 100 || /[\s\x00-\x1f\x7f]/.test(address)) return null;
  return { address, port };
}
function deduplicate(rows) {
  const seen = new Set(); return rows.filter(row => { const key = JSON.stringify([row.address, row.port, row.pid, row.name]); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, SERVICE_LIMITS.ports);
}
export function parseListeners(raw, format) {
  if (typeof raw !== "string" || raw.length > SERVICE_LIMITS.output) throw new Error("Listener output is too large; the previous snapshot was kept.");
  const lines = raw.split("\n");
  if (lines.length > 12000) throw new Error("Listener output exceeds the bounded record limit.");
  const rows = [];
  if (format === "lsof") {
    let pid = null, name = "Unknown process";
    for (const line of lines) {
      if (/^p\d+$/.test(line)) { pid = Number(line.slice(1)); name = "Unknown process"; }
      else if (line[0] === "c") name = clean(line.slice(1));
      else if (line[0] === "n") { const endpoint = parseEndpoint(line.slice(1)); if (endpoint) rows.push({ ...endpoint, pid, name }); }
    }
  } else if (format === "ss") {
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      if (fields[0] !== "LISTEN") continue;
      const endpoint = parseEndpoint(fields[3]); if (!endpoint) continue;
      const processes = [...line.matchAll(/\("([^"\n]{0,140})",pid=(\d+)/g)].slice(0, 10);
      if (!processes.length) rows.push({ ...endpoint, pid: null, name: "Process hidden by permissions" });
      for (const match of processes) rows.push({ ...endpoint, pid: Number(match[2]), name: clean(match[1]) });
    }
  } else throw new Error("No supported listener format was returned.");
  return deduplicate(rows);
}
