#!/usr/bin/env node
// Read quota only. Never print raw CLI output, auth material or server error bodies.
import { accessSync, constants, readFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { claudeWindows, codexWindows, agyWindows } from "./quota-model.js";

const parse = text => { try { return JSON.parse(text); } catch { return null; } };
const MAX = 512 * 1024;
function fileJson(path) { try { return statSync(path).size < MAX ? parse(readFileSync(path, "utf8")) : null; } catch { return null; } }
const unavailable = (provider, message, extra = {}) => ({ provider, state: "unavailable", windows: [], updatedAt: Date.now(), message, ...extra });
function reading(provider, windows) {
  return windows?.length ? { provider, state: "ok", windows, updatedAt: Date.now() } : unavailable(provider, "No quota windows were reported for this account.");
}
function command(name) {
  for (const dir of [...(process.env.PATH ?? "").split(":"), join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"]) {
    if (!dir.startsWith("/")) continue;
    const p = join(dir, name); try { if (statSync(p).isFile()) { accessSync(p, constants.X_OK); return p; } } catch { /* Try next path. */ }
  }
  return null;
}
function keychain(service, password = true, account = userInfo().username) {
  const result = spawnSync("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, ...(password ? ["-w"] : [])], { encoding: "utf8", timeout: 2500, maxBuffer: MAX, stdio: ["ignore", "pipe", "pipe"] });
  return result.status === 0 ? (password ? result.stdout.trim() : true) : null;
}
export function claudeCredential({ store = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), readKeychain = keychain, readFile = fileJson } = {}) {
  const custom = resolve(store) !== resolve(join(homedir(), ".claude"));
  const service = "Claude Code-credentials-" + createHash("sha256").update(resolve(store).normalize("NFC")).digest("hex").slice(0, 8);
  for (const name of [service, ...(!custom ? ["Claude Code-credentials"] : [])]) {
    const raw = readKeychain(name), token = typeof raw === "string" ? parse(raw)?.claudeAiOauth?.accessToken : null;
    if (typeof token === "string" && token && !/[\r\n]/.test(token)) return token;
  }
  const token = readFile(join(store, ".credentials.json"))?.claudeAiOauth?.accessToken;
  return typeof token === "string" && token && !/[\r\n]/.test(token) ? token : null;
}

export async function fetchClaude({ token, request = fetch } = {}) {
  if (!token) return unavailable("claude", "Sign in to Claude Code with a subscription, then refresh.", { reason: "signed-out" });
  try {
    const response = await request("https://api.anthropic.com/api/oauth/usage", { redirect: "error", signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "herdr-workspace-plus/0.3.0" } });
    if (!response.ok) {
      await response.body?.cancel();
      return unavailable("claude", response.status === 401 || response.status === 403 ? "Claude login needs attention. Open Claude Code, then refresh." : response.status === 429 ? "Claude usage is rate-limited. Try again later." : "Claude usage service is temporarily unavailable.", response.status === 401 ? { reason: "signed-out" } : {});
    }
    let text = ""; const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length > MAX) throw new Error("oversized response");
    }
    return reading("claude", claudeWindows(parse(text)));
  } catch { return unavailable("claude", "Could not reach Claude usage. Check the connection and refresh."); }
}

export async function claudeQuota({ executable = command("claude"), store, readCredential = claudeCredential, request = fetch } = {}) {
  if (!executable) return unavailable("claude", "Install and sign in to Claude Code, then refresh.", { reason: "missing-cli" });
  return fetchClaude({ token: readCredential({ store }), request });
}

function authenticationError(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  return /\b(?:not (?:authenticated|logged in|signed in)|(?:chatgpt )?authentication (?:is )?required|requires? (?:chatgpt )?authentication)\b/i.test(message);
}

export async function codexQuota({ executable = command("codex"), spawnProcess = spawn, temp = tmpdir(), store = process.env.CODEX_HOME } = {}) {
  if (!executable) return unavailable("codex", "Install and sign in to Codex, then refresh.", { reason: "missing-cli" });
  const scratch = mkdtempSync(join(temp, "herdr-quota-codex-"));
  try {
    return await new Promise(resolveResult => {
      let result, child, buffer = "", bytes = 0, killTimer;
      const finish = value => {
        if (result) return;
        result = value;
        clearTimeout(timer);
        child?.stdin.end();
        killTimer = setTimeout(() => child?.kill("SIGKILL"), 1200);
        if (!child) { clearTimeout(killTimer); resolveResult(result); }
      };
      const timer = setTimeout(() => { child?.kill("SIGTERM"); finish(unavailable("codex", "Codex quota query timed out. Try again later.")); }, 18000);
      try {
        child = spawnProcess(executable, ["-c", `log_dir=${JSON.stringify(scratch)}`, "-c", "analytics.enabled=false", "app-server", "--stdio"], {
          stdio: ["pipe", "pipe", "pipe"], cwd: scratch, env: { ...process.env, ...(store ? { CODEX_HOME: store } : {}) },
        });
      } catch (error) { finish(unavailable("codex", "Could not start the Codex quota reader.", error.code === "ENOENT" ? { reason: "missing-cli" } : {})); return; }
      const send = value => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + "\n"); };
      child.stdin.on("error", () => {});
      child.stdout.setEncoding?.("utf8");
      child.stderr.on("data", () => {});
      child.on("error", error => { finish(unavailable("codex", "Could not start the Codex quota reader.", error.code === "ENOENT" ? { reason: "missing-cli" } : {})); clearTimeout(killTimer); resolveResult(result); });
      child.on("close", () => { clearTimeout(timer); clearTimeout(killTimer); resolveResult(result ?? unavailable("codex", "Codex did not return quota information.")); });
      child.stdout.on("data", chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX) { child.kill("SIGTERM"); finish(unavailable("codex", "Codex quota response was too large.")); return; }
        buffer += chunk.toString("utf8");
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n"), record = parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          if (result || !record) continue;
          if (record.id === 1) {
            if (record.error) { finish(unavailable("codex", "Codex could not initialize its quota reader.")); continue; }
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "account/rateLimits/read", params: {} });
          } else if (record.id === 2) {
            finish(record.error ? unavailable("codex", "Codex could not refresh account quota.", authenticationError(record.error) ? { reason: "signed-out" } : {}) : reading("codex", codexWindows(record.result)));
          } else if (record.id !== undefined && record.method) {
            // Never log in, approve work or provide externally managed credentials.
            send({ id: record.id, error: { code: -32601, message: "Read-only quota client" } });
          }
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "herdr_workspace_plus", title: "Herdr Workspace Plus", version: "0.3.0" } } });
    });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export function supportsAgyUsage(version) {
  const parts = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(version.trim());
  if (!parts) return false;
  const [major, minor, patch] = parts.slice(1).map(Number);
  return major > 1 || major === 1 && (minor > 1 || minor === 1 && patch >= 11);
}
export function agyQuota({ executable = command("agy"), run = spawnSync, hasCredentials = () => keychain("gemini", false, "antigravity"), blockedVersion } = {}) {
  if (!executable) return unavailable("agy", "Install and sign in to the Antigravity CLI, then refresh.", { reason: "missing-cli" });
  const options = { encoding: "utf8", maxBuffer: MAX, timeout: 4000, cwd: homedir(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" } };
  const check = run(executable, ["--version"], options), version = (check.stdout || check.stderr || "").trim();
  if (check.error?.code === "ENOENT") return unavailable("agy", "Install and sign in to the Antigravity CLI, then refresh.", { reason: "missing-cli" });
  if (check.status !== 0 || !supportsAgyUsage(version) || blockedVersion === version) return unavailable("agy", "Antigravity CLI 1.1.11+ with the local /usage command is required. Update Antigravity before retrying.");
  if (!hasCredentials()) return unavailable("agy", "Sign in to the Antigravity CLI outside Herdr, then refresh.", { reason: "signed-out" });
  const output = run(executable, ["-p", "/usage", "--output-format", "json", "--print-timeout", "15s"], { ...options, timeout: 19000 });
  if (output.error?.code === "ENOENT") return unavailable("agy", "Install and sign in to the Antigravity CLI, then refresh.", { reason: "missing-cli" });
  const envelopes = (output.stdout ?? "").split("\n").map(parse).filter(Boolean);
  const valid = envelopes.map(agyWindows).find(windows => windows !== null);
  if (output.status === 0 && valid) return reading("agy", valid);
  if (envelopes.some(value => value.num_turns > 0 || Boolean(value.conversation_id))) return unavailable("agy", "This Antigravity version treated /usage as a conversation. Quota checks are paused until Antigravity changes.", { blockedVersion: version });
  return unavailable("agy", output.error?.code === "ETIMEDOUT" ? "Antigravity quota query timed out." : "Antigravity did not return quota. Open the Antigravity CLI to check sign-in, then refresh.");
}

export async function quota(provider, options = {}) {
  if (provider === "claude") return claudeQuota({ store: options.stores?.claude });
  if (provider === "codex") return codexQuota({ store: options.stores?.codex });
  if (provider === "agy") return agyQuota({ blockedVersion: options.blockedVersion });
  return unavailable(provider, "Unknown provider.");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.stdout.write(JSON.stringify(await quota(process.argv[2], parse(process.argv[3] ?? "{}") ?? {}))); }
  catch { process.stdout.write(JSON.stringify(unavailable(process.argv[2], "Quota information is unavailable. Refresh to retry."))); }
}
