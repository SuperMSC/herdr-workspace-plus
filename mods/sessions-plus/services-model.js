// Bounded snapshots only. Container names and labels never become executable arguments.
export const SERVICE_LIMITS = { containers: 120, ports: 2000, output: 600000, logs: 120000 };
export const CONTAINER_ID = /^[a-f0-9]{64}$/;
const clean = (value, length = 180) => String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, length);
export function serviceContext(value = {}) {
  const on = value.on == null || value.on === "" ? null : value.on;
  if (on !== null && (typeof on !== "string" || on.length > 200 || /[\s/\x00-\x1f\x7f]/.test(on))) throw new Error("The selected machine is invalid.");
  return { root: clean(value.root ?? value.cwd, 2000), on };
}
export function containerIdentity(row, on = null) {
  if (!row || !CONTAINER_ID.test(row.id || "") || typeof row.created !== "string" || !row.created || row.created.length > 100 || /[\x00-\x1f\x7f]/.test(row.created)) throw new Error("A complete container identity is required. Refresh the list.");
  return { id: row.id, created: row.created, on: serviceContext({ on }).on };
}
export function sameContainer(expected, actual, on) {
  return Boolean(expected && actual && expected.on === (on ?? null) && expected.id === actual.id && expected.created === actual.created);
}
export function normalizeContainer(row) {
  containerIdentity(row);
  const project = clean(row.project), service = clean(row.service), mappings = [];
  if (row.ports && typeof row.ports === "object" && !Array.isArray(row.ports)) {
    for (const [target, bindings] of Object.entries(row.ports).slice(0, 300)) {
      const match = /^(\d{1,5})\/(tcp|udp)$/.exec(target);
      if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535 || !Array.isArray(bindings)) continue;
      for (const binding of bindings.slice(0, 20)) {
        const hostPort = Number(binding.HostPort);
        if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) continue;
        mappings.push({ address: clean(binding.HostIp || "0.0.0.0", 100), port: hostPort, target: Number(match[1]), protocol: match[2] });
      }
    }
  }
  return { id: row.id, created: row.created, name: clean(row.name).replace(/^\//, "") || row.id.slice(0, 12), image: clean(row.image), project, service,
    group: ["database", "gts", "ai"].includes(project) ? project : "other", state: clean(row.state, 32) || "unknown", health: clean(row.health, 32), mappings };
}
export const containerPriority = row => row.health === "unhealthy" || ["dead", "restarting", "removing"].includes(row.state) ? 0 : row.state !== "running" ? 1 : row.health === "starting" ? 2 : 3;
export function filteredContainers(rows, query = "") {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(row => terms.every(term => [row.name, row.image, row.project, row.service, row.state, row.health, ...row.mappings.map(port => `${port.address}:${port.port}:${port.target}`)].join(" ").toLocaleLowerCase().includes(term)))
    .sort((a, b) => containerPriority(a) - containerPriority(b) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}
export function parseContainers(raw) {
  if (typeof raw !== "string" || raw.length > SERVICE_LIMITS.output) throw new Error("Container output is too large; the previous snapshot was kept.");
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length > SERVICE_LIMITS.containers) throw new Error("Container output exceeds the bounded list limit.");
  const rows = [], warnings = [];
  for (const line of lines) { try { rows.push(normalizeContainer(JSON.parse(line))); } catch { warnings.push("A container record was invalid and was omitted. Refresh to retry."); } }
  return { containers: rows, warnings: [...new Set(warnings)] };
}
export function associatePorts(ports, containers) {
  const byPort = new Map();
  for (const container of containers) {
    if (container.state !== "running") continue;
    for (let order = 0; order < container.mappings.length; order++) {
      const mapping = container.mappings[order];
      if (mapping.protocol !== "tcp") continue;
      let bucket = byPort.get(mapping.port);
      if (!bucket) { bucket = { addresses: new Map(), wildcard: new Map(), matches: new Map() }; byPort.set(mapping.port, bucket); }
      let bindings = bucket.wildcard;
      if (!["0.0.0.0", "::", "*"].includes(mapping.address)) {
        bindings = bucket.addresses.get(mapping.address);
        if (!bindings) { bindings = new Map(); bucket.addresses.set(mapping.address, bindings); }
      }
      // Keep the first applicable TCP binding for this exact address/host port and container.
      if (!bindings.has(container.id)) bindings.set(container.id, { order, value: { id: container.id, name: container.name, project: container.project, target: mapping.target } });
    }
  }
  return ports.map(port => {
    const bucket = byPort.get(port.port);
    if (!bucket) return { ...port, containers: [] };
    let matches = bucket.matches.get(port.address);
    if (!matches) {
      const selected = new Map(bucket.wildcard);
      for (const [id, binding] of bucket.addresses.get(port.address) || []) {
        if (!selected.has(id) || binding.order < selected.get(id).order) selected.set(id, binding);
      }
      matches = [...selected.values()].map(binding => binding.value); bucket.matches.set(port.address, matches);
    }
    return { ...port, containers: matches };
  });
}
export function filteredPorts(rows, query = "") {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(row => terms.every(term => `${row.port} ${row.address} ${row.pid ?? ""} ${row.name} ${row.containers?.map(container => `${container.name} ${container.project}`).join(" ") || ""}`.toLocaleLowerCase().includes(term)))
    .sort((a, b) => a.port - b.port || a.address.localeCompare(b.address) || (a.pid || 0) - (b.pid || 0));
}
export function sameListener(left, right) { return Boolean(left && right && left.port === right.port && left.address === right.address && left.pid === right.pid && left.name === right.name); }
export function listenerURL(row, on = null, scheme = "http") {
  if (on !== null || !row || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535 || !["http", "https"].includes(scheme)) return null;
  const address = row.address;
  const loopback = address === "::1" || address === "localhost" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(address) && address.split(".").every(part => Number(part) <= 255);
  return loopback ? `${scheme}://${address === "::1" ? "[::1]" : address}:${row.port}` : null;
}
