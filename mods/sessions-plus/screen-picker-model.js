// Terminal output stays data. Only explicit, validated selections become references or reads.
export const SCREEN_LIMITS = { bytes: 1048576, candidates: 200, page: 20, history: 200, value: 2048, preview: 80000 };
const control = /[\x00-\x1f\x7f]/;
function digest(value) {
  let a = 2166136261, b = 3339675911;
  for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b ^ value.charCodeAt(i), 2246822519); }
  return `${value.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}
export function absoluteUnix(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 4096 || control.test(value)) return null;
  const parts = [];
  for (const part of value.split("/")) { if (!part || part === ".") continue; if (part === "..") parts.pop(); else parts.push(part); }
  return "/" + parts.join("/");
}
export function capturedScreenTarget(value, context = null) {
  if (!value || value.state !== "live" || typeof value.address !== "string" || value.address.length > 200 || !/^[^\s/\x00-\x1f\x7f]+(?:\/[^\s/\x00-\x1f\x7f]+)?$/.test(value.address)) throw new Error("Choose an exact live terminal before opening Screen picker.");
  const address = value.address, on = address.includes("/") ? address.slice(0, address.indexOf("/")) : null, created_ms = value.created_ms ?? value.created;
  if (!Number.isSafeInteger(created_ms) || created_ms <= 0 || value.on !== undefined && (value.on ?? null) !== on || context && (context.on ?? null) !== on) throw new Error("The terminal creation identity or captured machine does not match.");
  if (!Array.isArray(value.argv) || value.argv.length > 128 || value.argv.some(argument => typeof argument !== "string") || JSON.stringify(value.argv).length > 16000) throw new Error("The terminal launch identity is unavailable or too large.");
  const cwd = typeof value.cwd === "string" && value.cwd.length <= 4096 && !control.test(value.cwd) ? value.cwd : "";
  const root = context ? context.root ?? context.cwd : cwd;
  const safeRoot = absoluteUnix(root);
  return { address, on, created_ms, cwd, root: safeRoot || null, stamp: digest(JSON.stringify([value.argv, value.pid ?? null, cwd])), title: String(value.title || value.name || address).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120) };
}
export function validScreenTarget(target) {
  if (!target || typeof target.address !== "string" || !/^[^\s/\x00-\x1f\x7f]+(?:\/[^\s/\x00-\x1f\x7f]+)?$/.test(target.address) || target.address.length > 200 || !Number.isSafeInteger(target.created_ms) || target.created_ms <= 0 || typeof target.cwd !== "string" || target.cwd.length > 4096 || control.test(target.cwd) || typeof target.stamp !== "string" || !/^\d{1,5}:[a-f\d]{1,8}:[a-f\d]{1,8}$/.test(target.stamp)) return false;
  const on = target.address.includes("/") ? target.address.slice(0, target.address.indexOf("/")) : null;
  return target.on === on && (target.root === null || absoluteUnix(target.root) === target.root);
}
export function sameScreenTerminal(target, terminal, qualify = false) {
  if (!validScreenTarget(target) || !terminal || terminal.state !== "live") return false;
  let address = terminal.address;
  if (qualify && target.on && typeof address === "string" && !address.includes("/")) address = `${target.on}/${address}`;
  try { const actual = capturedScreenTarget({ ...terminal, address }, { root: target.root, on: target.on }); return actual.address === target.address && actual.created_ms === target.created_ms && actual.stamp === target.stamp; } catch { return false; }
}
export function screenPath(value, target) {
  let path = value, line = null, column = null;
  const suffix = /:(\d{1,7})(?::(\d{1,7}))?$/.exec(path);
  if (suffix) { path = path.slice(0, suffix.index); line = Number(suffix[1]) || null; column = Number(suffix[2]) || null; }
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(path);
  if (!path || control.test(path) || path.length > SCREEN_LIMITS.value) return null;
  if (windows) return { kind: "path", value, path, line, column, resolved: null, relative: null, previewable: false, reason: "Windows path retained literally; no matching filesystem root was verified." };
  if (path.startsWith("~")) return { kind: "path", value, path, line, column, resolved: null, relative: null, previewable: false, reason: "Home-relative path retained literally; home expansion is not inferred from screen output." };
  const cwd = absoluteUnix(target.cwd), resolved = absoluteUnix(path.startsWith("/") ? path : cwd ? `${cwd}/${path}` : "");
  const inside = resolved && target.root && resolved !== target.root && (target.root === "/" || resolved.startsWith(target.root + "/"));
  return { kind: "path", value, path, line, column, resolved, relative: inside ? resolved.slice(target.root === "/" ? 1 : target.root.length + 1) : null, previewable: Boolean(inside),
    reason: inside ? path.startsWith("/") ? "Absolute path within the captured root." : "Relative path interpreted from the captured terminal folder; verify the selected text." : "Path is outside the captured root or its source folder is unknown; literal copy and reference remain available." };
}
function trimToken(value) {
  let next = value.replace(/[.,;!?]+$/, "");
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
    while (next.endsWith(close) && next.split(close).length > next.split(open).length) next = next.slice(0, -1);
  }
  return next;
}
function urlCandidate(value) {
  try {
    const url = new URL(value);
    return { kind: "url", value, scheme: url.protocol.slice(0, -1), openable: ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && Boolean(url.hostname), reason: "Literal URL from the captured terminal screen." };
  } catch { return null; }
}
function looksPath(value) {
  return !value.includes("://") && !/^[!-]/.test(value) && (/^(?:\/|\.\.?[\/]|~[\/]|[A-Za-z]:[\\/]|\\\\)/.test(value) || /^(?:[\w.@+-]+[\/])+/ .test(value) || /^[A-Za-z_@-][\w.@+-]*\.[A-Za-z\d]{1,12}(?::\d+(?::\d+)?)?$/.test(value));
}
export function extractScreenCandidates(source, target) {
  if (!validScreenTarget(target) || typeof source !== "string" || source.length > SCREEN_LIMITS.bytes) throw new Error("The screen snapshot is invalid or exceeds its read limit.");
  const text = source.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  const lines = text.split(/\r?\n/), candidates = [], seen = new Set(); let limited = false, lineLimited = false;
  const add = (value, sourceLine, lineText) => {
    value = trimToken(value); if (!value || value.length > SCREEN_LIMITS.value) return;
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? urlCandidate(value) : looksPath(value) ? screenPath(value, target) : null;
    if (!candidate) return;
    const key = `${candidate.kind}:${candidate.value}`; if (seen.has(key)) return; seen.add(key);
    if (candidates.length >= SCREEN_LIMITS.candidates) { limited = true; return; }
    candidates.push({ ...candidate, searchText: `${candidate.kind} ${candidate.value} ${candidate.resolved || ""} ${lineText.slice(0, 500)}`.toLocaleLowerCase(), id: `pick-${candidates.length + 1}`, sourceLine, excerpt: lineText.slice(0, 500) });
  };
  for (let index = 0; index < lines.length && index < 5000; index++) {
    if (lines[index].length > 12000) lineLimited = true;
    const line = lines[index].slice(0, 12000), covered = [];
    for (const match of line.matchAll(/(?:https?|ftp|ssh|file):\/\/[^\s<>"'`]+/gi)) { add(match[0], index + 1, line); covered.push([match.index, match.index + match[0].length]); }
    for (const match of line.matchAll(/"([^"\r\n]{1,2048})"|'([^'\r\n]{1,2048})'|`([^`\r\n]{1,2048})`/g)) { add(match[1] ?? match[2] ?? match[3], index + 1, line); covered.push([match.index, match.index + match[0].length]); }
    for (const match of line.matchAll(/[^\s<>"'`]+/g)) {
      if (covered.some(([start, end]) => match.index >= start && match.index < end)) continue;
      add(match[0].replace(/^[([{]+/, ""), index + 1, line);
    }
    if (limited) break;
  }
  return { candidates, limited, lineLimited: lineLimited || lines.length > 5000, lines: lines.length };
}
export function screenReference(candidate, target) {
  if (!candidate || !validScreenTarget(target) || typeof candidate.value !== "string" || candidate.value.length > SCREEN_LIMITS.value) throw new Error("Choose a captured screen item first.");
  return `Terminal screen reference on ${target.on || "this computer"} (${target.address}, created ${target.created_ms})\nCaptured folder: ${JSON.stringify(target.cwd)}\n${candidate.kind === "url" ? "URL" : "Path"}: ${JSON.stringify(candidate.value)}${candidate.resolved ? `\nResolved from captured context: ${JSON.stringify(candidate.resolved)}` : ""}\nScreen line ${candidate.sourceLine}:\n${candidate.excerpt}\n\n`;
}
