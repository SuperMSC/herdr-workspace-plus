import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { claudeCredential, claudeQuota, fetchClaude, codexQuota, agyQuota, supportsAgyUsage } from "../mods/sessions-plus/quota.mjs";
import { claudeWindows, codexWindows, agyWindows, resetTime, percentage, resetLabel } from "../mods/sessions-plus/quota-model.js";
import { PROVIDERS } from "../mods/sessions-plus/model.js";

const agyReply = { status: "SUCCESS", command: { name: "usage", data: { groups: [{ name: "Gemini", buckets: [
  { id: "gemini-weekly", name: "Weekly", window: "weekly", remaining_fraction: 0.75, reset_time: "2027-01-02T00:00:00Z" },
  { id: "unmetered", name: "Other", disabled: true, remaining_fraction: 0 },
] }] } } };

test("missing CLI executables or login return unavailable without launching work", async () => {
  const unexpected = () => assert.fail("A missing provider must not launch a process or request");
  const results = [
    await claudeQuota({ executable: null, readCredential: unexpected, request: unexpected }),
    await codexQuota({ executable: null, spawnProcess: unexpected }),
    agyQuota({ executable: null, run: unexpected, hasCredentials: unexpected }),
    await fetchClaude({ token: null, request: unexpected }),
  ];
  for (const result of results) { assert.equal(result.state, "unavailable"); assert.deepEqual(result.windows, []); assert(result.message); }
  assert.deepEqual(results.map(result => result.reason), ["missing-cli", "missing-cli", "missing-cli", "signed-out"]);
});

test("a CLI removed after discovery degrades gracefully and cleans its temporary directory", async t => {
  const root = mkdtempSync(join(tmpdir(), "quota-missing-cli-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const missing = join(root, "missing-cli");
  const codex = await codexQuota({ executable: missing, temp: root });
  const agy = agyQuota({ executable: missing, hasCredentials: () => assert.fail("Missing agy must not query credentials") });
  assert.equal(codex.state, "unavailable"); assert.equal(agy.state, "unavailable");
  assert.equal(codex.reason, "missing-cli"); assert.equal(agy.reason, "missing-cli");
  assert.deepEqual(readdirSync(root), []);
});

test("remaining and used are complementary, preserving zero and exhaustion", () => {
  const windows = claudeWindows({ five_hour: { utilization: 0, resets_at: 1800000000 }, seven_day: { utilization: 100, resets_at: "2027-01-02T00:00:00Z" } });
  assert.equal(percentage(windows[0]), "100%"); assert.equal(percentage(windows[0], "used"), "0%");
  assert.equal(percentage(windows[1]), "0%"); assert.equal(percentage(windows[1], "used"), "100%");
  assert.equal(windows[0].resetAt, 1800000000000);
  assert.deepEqual(claudeWindows({ five_hour: { utilization: null } }), []);
});

test("Codex uses every supplied bucket and its actual window duration, without identifiers", () => {
  const rows = codexWindows({ accountId: "private-account-fixture", rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: {
    codex: { limitId: "codex", primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 10, windowDurationMins: 10080 } },
    review: { limitId: "review", limitName: "Review", primary: { usedPercent: 42.5, windowDurationMins: 60 } },
  } });
  assert.equal(rows.length, 3); assert.equal(rows[2].label, "Review · 1h"); assert.equal(percentage(rows[2]), "57.5%");
  assert(!JSON.stringify(rows).includes("private-account-fixture"));
});

test("agy accepts only a command response, keeps model groups, and distinguishes unmetered", () => {
  const rows = agyWindows(agyReply); assert.equal(rows[0].remaining, 75); assert.equal(rows[0].used, 25);
  assert.equal(rows[0].label, "Gemini · Weekly"); assert.equal(percentage(rows[1]), "Unmetered");
  assert.equal(agyWindows({ status: "SUCCESS", response: "75% remaining", num_turns: 1 }), null);
  const invalid = structuredClone(agyReply); invalid.command.data.groups[0].buckets[0].remaining_fraction = -1;
  assert.equal(agyWindows(invalid).length, 1);
});

test("reset formatting never invents a reset or treat a past reset as fresh quota", () => {
  assert.equal(resetTime(null), null); assert.equal(resetTime("not a date"), null); assert.equal(resetTime("1800000000"), 1800000000000);
  assert.equal(resetLabel(null), "Reset time unavailable"); assert.match(resetLabel(1000, 2000), /passed/);
  assert.match(resetLabel(3600000, 0), /1h 0m/);
});

test("custom Claude stores cannot fall back to another account's default Keychain item", () => {
  const calls = [];
  const token = claudeCredential({ store: "/fixture/claude-profile", readKeychain: name => { calls.push(name); return null; }, readFile: () => ({ claudeAiOauth: { accessToken: "fixture-access-token" } }) });
  assert.equal(token, "fixture-access-token"); assert.equal(calls.length, 1); assert.match(calls[0], /^Claude Code-credentials-[0-9a-f]{8}$/);
});

test("Claude quota requests send credentials only to its fixed HTTPS endpoint and redact output", async () => {
  let request;
  const result = await fetchClaude({ token: "fixture-access-token", request: async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ five_hour: { utilization: 12, resets_at: 1800000000 }, email: "private@example.invalid", token: "fixture-access-token" }));
  } });
  assert.equal(request.url, "https://api.anthropic.com/api/oauth/usage"); assert.equal(request.options.redirect, "error");
  assert.equal(request.options.headers.Authorization, "Bearer fixture-access-token"); assert.equal(result.state, "ok");
  assert(!JSON.stringify(result).includes("fixture-access-token")); assert(!JSON.stringify(result).includes("private@example.invalid"));
});

test("Claude authentication, rate-limit and transport errors expose no server bodies or tokens", async () => {
  for (const status of [401, 403, 429, 500]) {
    const result = await fetchClaude({ token: "fixture-access-token", request: async () => new Response("secret fixture payload", { status }) });
    assert.equal(result.state, "unavailable"); assert(!JSON.stringify(result).includes("secret"));
  }
  const result = await fetchClaude({ token: "fixture-access-token", request: async () => { throw new Error("fixture-access-token"); } });
  assert(!JSON.stringify(result).includes("fixture-access-token"));
  assert.equal(result.reason, undefined);
});

test("missing credentials hide the account while network and rate-limit failures remain temporary", async () => {
  const claude = await claudeQuota({ executable: "/fixture/claude", readCredential: () => null, request: () => assert.fail("Signed-out Claude must not send a request") });
  assert.equal(claude.reason, "signed-out");
  const agy = agyQuota({ executable: "/fixture/agy", hasCredentials: () => false, run: (_p, args) => {
    assert.deepEqual(args, ["--version"]); return { status: 0, stdout: "1.4.12" };
  } });
  assert.equal(agy.reason, "signed-out");
  for (const status of [401, 403, 429, 500]) {
    const result = await fetchClaude({ token: "fixture-access-token", request: async () => new Response("", { status }) });
    assert.equal(result.reason, status === 401 ? "signed-out" : undefined);
  }
});

test("agy gates old versions before a print command and never bypasses slash commands", () => {
  assert.equal(supportsAgyUsage("1.1.10"), false); assert.equal(supportsAgyUsage("1.1.11"), true); assert.equal(supportsAgyUsage("1.4.12"), true); assert.equal(supportsAgyUsage("unknown"), false);
  const calls = [];
  const old = agyQuota({ executable: "/fixture/agy", hasCredentials: () => true, run: (_p, args) => { calls.push(args); return { status: 0, stdout: "1.1.10" }; } });
  assert.equal(old.state, "unavailable"); assert.deepEqual(calls, [["--version"]]);
  const current = agyQuota({ executable: "/fixture/agy", hasCredentials: () => true, run: (_p, args, options) => {
    assert.equal(options.env.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
    if (args[0] === "--version") return { status: 0, stdout: "1.4.12" };
    assert.deepEqual(args, ["-p", "/usage", "--output-format", "json", "--print-timeout", "15s"]);
    return { status: 0, stdout: JSON.stringify(agyReply) };
  } });
  assert.equal(current.state, "ok");
});

test("agy pauses a version that unexpectedly runs a model turn and skips signed-out accounts", () => {
  const run = (_p, args) => ({ status: 0, stdout: args[0] === "--version" ? "1.4.12" : JSON.stringify({ status: "SUCCESS", num_turns: 1, conversation_id: "fixture", response: "private answer" }) });
  const result = agyQuota({ executable: "/fixture/agy", hasCredentials: () => true, run });
  assert.equal(result.blockedVersion, "1.4.12"); assert(!JSON.stringify(result).includes("private answer"));
  let printed = false;
  const guarded = (_p, args) => { if (args[0] !== "--version") printed = true; return { status: 0, stdout: "1.4.12" }; };
  agyQuota({ executable: "/fixture/agy", blockedVersion: "1.4.12", hasCredentials: () => true, run: guarded });
  agyQuota({ executable: "/fixture/agy", hasCredentials: () => false, run: guarded });
  assert.equal(printed, false);
});

test("Codex uses only initialize and quota-read, closes its process, and removes logs", async t => {
  const root = mkdtempSync(join(tmpdir(), "quota-protocol-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "fixture.mjs"), record = join(root, "requests.jsonl");
  writeFileSync(file, `import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';\nconst lines=createInterface({input:process.stdin});for await(const line of lines){const r=JSON.parse(line);appendFileSync(${JSON.stringify(record)},JSON.stringify(r)+'\\n');if(r.id===1)console.log(JSON.stringify({id:1,result:{}}));if(r.id===2)console.log(JSON.stringify({id:2,result:{accountId:'private-account-fixture',rateLimits:{limitId:'codex',primary:{usedPercent:25,windowDurationMins:300,resetsAt:1800000000}}}}));}\n`);
  let child;
  const result = await codexQuota({ executable: "/fixture/codex", temp: root, spawnProcess: (_p, args, options) => {
    assert(args.includes("analytics.enabled=false")); assert.equal(options.cwd.startsWith(root), true);
    child = spawn(process.execPath, [file], options); return child;
  } });
  assert.equal(result.state, "ok"); assert.equal(result.windows[0].remaining, 75); assert.notEqual(child.exitCode, null);
  assert.deepEqual(readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line).method), ["initialize", "initialized", "account/rateLimits/read"]);
  assert(!JSON.stringify(result).includes("private-account-fixture")); assert(!readdirSync(root).some(n => n.startsWith("herdr-quota-codex-")));
});

test("Codex distinguishes explicit authentication errors from temporary RPC errors", async t => {
  const root = mkdtempSync(join(tmpdir(), "quota-auth-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "fixture.mjs");
  writeFileSync(file, `import{createInterface}from'node:readline';const lines=createInterface({input:process.stdin});for await(const line of lines){const r=JSON.parse(line);if(r.id===1)console.log(JSON.stringify({id:1,result:{}}));if(r.id===2)console.log(JSON.stringify({id:2,error:{code:-32000,message:process.argv[2]}}));}`);
  for (const [message, reason] of [["Not authenticated", "signed-out"], ["ChatGPT authentication required", "signed-out"], ["Service temporarily unavailable", undefined], ["Network request timed out", undefined]]) {
    const result = await codexQuota({ executable: "/fixture/codex", temp: root, spawnProcess: (_p, _args, options) => spawn(process.execPath, [file, message], options) });
    assert.equal(result.state, "unavailable"); assert.equal(result.reason, reason);
  }
});

function quotaElement() {
  const node = { nodes: [], attributes: {}, click: null };
  const element = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    if (key === "child") return child => { target.nodes.push(child); return element; };
    if (key === "children") return children => { target.nodes.push(...children); return element; };
    if (key === "when") return (condition, callback) => condition ? callback(element) : element;
    if (key === "on_click") return callback => { target.click = callback; return element; };
    return value => { target.attributes[key] = value; return element; };
  } });
  return element;
}

function quotaNodes(node) {
  if (!node || typeof node !== "object") return [];
  return [node, ...(node.nodes ?? []).flatMap(quotaNodes)];
}

function quotaText(node) {
  return typeof node === "string" ? node : (node?.nodes ?? []).map(quotaText).join(" ");
}

function quotaFixture(state = {}, { deferredSpawn = false } = {}) {
  let now = 1800000000000;
  const calls = [], tasks = [], queued = [];
  const source = readFileSync(new URL("../mods/sessions-plus/quota.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  const dependencies = {
    PROVIDERS, percentage, resetLabel, div: quotaElement, h_flex: quotaElement, v_flex: quotaElement,
    Date: class extends Date { static now() { return now; } },
    theme: () => ({ selected: "selected", surface: "surface" }), window: () => ({ platform: "macos" }), appHome: () => "/fixture/herdr",
    shared: key => state[key], setShared: (key, value) => { state[key] = value; },
    providerIcon: provider => ({ provider, nodes: [] }),
    exec: (program, args) => new Promise((resolve, reject) => { calls.push({ program, args, provider: args[1], resolve, reject }); }),
  };
  const Quota = new Function(...Object.keys(dependencies), source)(...Object.values(dependencies));
  const cx = { notify() {}, spawn(task) { if (deferredSpawn) queued.push(task); else tasks.push(task(cx)); } };
  const quota = new Quota(); quota.init({}, cx);
  const render = () => quota.render();
  const find = (id, tree = render()) => quotaNodes(tree).find(node => node.attributes?.id === id);
  return {
    quota, state, calls, render, find,
    providers: () => quotaNodes(find("quota-cards")).filter(node => Object.hasOwn(node, "provider")).map(node => node.provider),
    click(id) { const node = find(id); assert(node, `Missing button: ${id}`); assert.equal(typeof node.click, "function"); node.click({}, cx); },
    tick(ms) { now += ms; },
    refresh(automatic = false) { quota.refresh(cx, automatic); },
    startQueued() { while (queued.length) tasks.push(queued.shift()(cx)); },
    async fail(error = new Error("Temporary executor failure")) {
      for (const call of calls) call.reject(error);
      await Promise.all(tasks);
    },
    async finish(overrides = {}) {
      for (const call of calls) call.resolve({ code: 0, stdout: JSON.stringify({ provider: call.provider, state: "ok", updatedAt: now,
        windows: [{ label: `${call.provider} usage`, used: 25, remaining: 75, resetAt: now + 3600000 }], ...overrides[call.provider] }) });
      await Promise.all(tasks);
    },
  };
}

test("Status shows cards only after quota arrives and restores each provider's saved visibility", async () => {
  const f = quotaFixture();
  assert.deepEqual(f.providers(), []);
  assert.match(quotaText(f.find("quota-cards")), /Reading account quota/);
  assert.deepEqual(f.calls.map(call => call.provider), ["claude", "codex", "agy"]);
  assert.equal(f.find("quota-show-codex"), undefined);
  await f.finish();
  assert.deepEqual(f.providers(), ["claude", "codex", "agy"]);
  f.click("quota-agents");
  for (const provider of Object.keys(PROVIDERS)) assert(f.find(`quota-show-${provider}`));
  f.click("quota-show-codex");
  assert.deepEqual(f.providers(), ["claude", "agy"]);
  assert.deepEqual(f.state["sessions-plus.quota-hidden"], ["codex"]);
  assert.equal(f.find("quota-show-codex").attributes.bg, "surface");
  assert.equal(f.find("quota-show-claude").attributes.bg, "selected");
  await f.finish();
  const restored = quotaFixture(f.state);
  assert.deepEqual(restored.providers(), []);
  assert.deepEqual(restored.calls.map(call => call.provider), ["claude", "agy"]);
  assert.equal(quotaText(restored.find("quota-agents")), "Agents ▾");
  await restored.finish();
  assert.deepEqual(restored.providers(), ["claude", "agy"]);
});

test("hidden providers are skipped by manual refresh, automatic polling, and queued work", async () => {
  const f = quotaFixture(); await f.finish();
  f.click("quota-agents"); f.click("quota-show-claude");
  f.tick(60000); f.click("quota-refresh"); await f.finish();
  f.tick(300000); f.refresh(true); await f.finish();
  assert.deepEqual(f.calls.map(call => call.provider), ["claude", "codex", "agy", "codex", "agy", "codex", "agy"]);
  const queued = quotaFixture({}, { deferredSpawn: true });
  queued.click("quota-agents"); queued.click("quota-show-agy"); queued.startQueued();
  assert.deepEqual(queued.calls.map(call => call.provider), ["claude", "codex"]);
  await queued.finish();
  assert.equal(queued.quota.pending.size, 0);
});

test("showing a provider preserves pending work and the 60-second refresh cooldown", async () => {
  const f = quotaFixture({ "sessions-plus.quota-hidden": ["codex", "agy"] });
  f.click("quota-agents");
  f.click("quota-show-claude"); f.tick(60000); f.click("quota-show-claude");
  assert.equal(f.calls.length, 1);
  await f.finish();
  f.click("quota-show-claude"); f.click("quota-show-claude");
  assert.equal(f.calls.length, 2);
  await f.finish();
  f.click("quota-show-claude"); f.tick(59999); f.click("quota-show-claude");
  assert.equal(f.calls.length, 2);
  f.click("quota-show-claude"); f.tick(1); f.click("quota-show-claude");
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.providers(), ["claude"]);
  await f.finish();
});

test("in-flight responses cannot reveal hidden cards and an empty Status remains recoverable", async () => {
  const f = quotaFixture(); f.click("quota-agents");
  for (const provider of Object.keys(PROVIDERS)) f.click(`quota-show-${provider}`);
  assert.deepEqual(f.providers(), []);
  assert.match(quotaText(f.find("quota-cards")), /All agents are hidden/);
  assert.equal(quotaText(f.find("quota-refresh")), "Refresh");
  assert.equal(quotaText(f.find("quota-agents")), "Agents ▴");
  await f.finish();
  assert.deepEqual(f.providers(), []);
  f.tick(300000); f.refresh(true); f.click("quota-refresh");
  assert.equal(f.calls.length, 3);
  f.click("quota-agents"); assert.equal(f.find("quota-show-agy"), undefined);
  f.click("quota-agents"); f.click("quota-show-agy");
  assert.deepEqual(f.providers(), ["agy"]);
  assert.deepEqual(f.state["sessions-plus.quota-hidden"], ["claude", "codex"]);
  assert.equal(f.calls.length, 4); assert.equal(f.calls[3].provider, "agy");
  assert.doesNotMatch(quotaText(f.find("quota-cards")), /All agents are hidden/);
  await f.finish();
});

test("malformed and unknown visibility settings do not hide valid providers or break controls", async () => {
  for (const saved of [null, "claude", {}, 42, ["unknown", null, {}, "__proto__", "constructor"]]) {
    const f = quotaFixture({ "sessions-plus.quota-hidden": saved });
    assert.deepEqual(f.providers(), []); await f.finish();
    assert.deepEqual(f.providers(), ["claude", "codex", "agy"]);
    f.click("quota-agents"); f.click("quota-show-agy");
    assert.deepEqual(f.state["sessions-plus.quota-hidden"], ["agy"]);
    await f.finish();
  }
  const f = quotaFixture({ "sessions-plus.quota-hidden": ["unknown", "codex", "codex"] });
  assert.deepEqual(f.providers(), []); await f.finish();
  assert.deepEqual(f.providers(), ["claude", "agy"]);
  f.click("quota-agents"); f.click("quota-show-codex");
  assert.deepEqual(f.providers(), ["claude", "agy"]);
  assert.deepEqual(f.state["sessions-plus.quota-hidden"], []);
  assert.deepEqual(f.calls.map(call => call.provider), ["claude", "agy", "codex"]);
  await f.finish();
  assert.deepEqual(f.providers(), ["claude", "codex", "agy"]);
});

test("missing CLI and signed-out providers are omitted while another account remains visible", async () => {
  const f = quotaFixture();
  await f.finish({ claude: { state: "unavailable", windows: [], reason: "missing-cli", message: "Install Claude" },
    agy: { state: "unavailable", windows: [], reason: "signed-out", message: "Sign in to agy" } });
  assert.deepEqual(f.providers(), ["codex"]);
  assert.doesNotMatch(quotaText(f.find("quota-cards")), /Install Claude|Sign in to agy|Unavailable/);
  f.click("quota-agents");
  for (const provider of Object.keys(PROVIDERS)) assert(f.find(`quota-show-${provider}`));
  assert.equal(f.find("quota-show-claude").attributes.bg, "selected");
  f.tick(300000); f.refresh(true); await f.finish();
  assert.deepEqual(f.calls.map(call => call.provider), ["claude", "codex", "agy", "codex"]);
  f.tick(60000); f.click("quota-refresh"); await f.finish();
  assert.deepEqual(f.providers(), ["claude", "codex", "agy"]);
});

test("all unavailable accounts use one quiet empty state and no error cards", async () => {
  const f = quotaFixture();
  await f.finish(Object.fromEntries(Object.keys(PROVIDERS).map(provider => [provider, { state: "unavailable", windows: [], message: "Unavailable provider error" }])));
  assert.deepEqual(f.providers(), []);
  assert.equal(quotaText(f.find("quota-cards")), "No account quota to show.");
  assert.doesNotMatch(quotaText(f.render()), /Unavailable provider error/);
});

test("uninstalling or signing out clears cached cards while temporary failures retain Stale", async () => {
  const f = quotaFixture(); await f.finish();
  f.tick(60000); f.click("quota-refresh");
  await f.finish({ claude: { state: "unavailable", windows: [], reason: "missing-cli", message: "Install Claude" },
    codex: { state: "unavailable", windows: [], reason: "signed-out", message: "Sign in to Codex" },
    agy: { state: "unavailable", windows: [], message: "Connection temporarily unavailable" } });
  assert.deepEqual(f.providers(), ["agy"]);
  assert.deepEqual(f.quota.data.claude.windows, []); assert.deepEqual(f.quota.data.codex.windows, []);
  assert.equal(f.quota.data.agy.state, "stale"); assert.match(quotaText(f.find("quota-cards")), /Stale/);
  assert.doesNotMatch(quotaText(f.find("quota-cards")), /Install Claude|Sign in to Codex/);
});


test("temporary initial quota failures retry automatically while preserving the refresh cooldown", async () => {
  const f = quotaFixture();
  await f.finish(Object.fromEntries(Object.keys(PROVIDERS).map(provider => [provider, { state: "unavailable", windows: [], message: "Temporary service failure" }])));
  assert.deepEqual(f.providers(), []);
  f.tick(59999); f.refresh(true);
  assert.equal(f.calls.length, 3);
  f.tick(240001); f.refresh(true);
  assert.deepEqual(f.calls.slice(3).map(call => call.provider), ["claude", "codex", "agy"]);
  await f.finish();
  assert.deepEqual(f.providers(), ["claude", "codex", "agy"]);
});

test("an initial exec rejection without cached readings recovers on the next automatic refresh", async () => {
  const f = quotaFixture();
  await f.fail();
  assert.deepEqual(f.providers(), []);
  assert(Object.values(f.quota.data).every(data => data.state === "unavailable"));
  f.tick(300000); f.refresh(true);
  assert.equal(f.calls.length, 6);
  await f.finish();
  assert.deepEqual(f.providers(), ["claude", "codex", "agy"]);
});

test("only missing CLI, signed-out, or explicitly blocked versions pause automatic reads", async () => {
  const f = quotaFixture();
  await f.finish({
    claude: { state: "unavailable", windows: [], reason: "missing-cli" },
    codex: { state: "unavailable", windows: [], reason: "signed-out" },
    agy: { state: "unavailable", windows: [], blockedVersion: "1.1.11" },
  });
  f.tick(300000); f.refresh(true);
  assert.equal(f.calls.length, 3);
  f.click("quota-refresh");
  assert.equal(f.calls.length, 6);
  await f.finish();
  f.tick(300000); f.refresh(true);
  assert.equal(f.calls.length, 9);
  await f.finish();
});

test("an explicitly blocked version also pauses automatic reads when a prior reading remains stale", async () => {
  const f = quotaFixture(); await f.finish();
  f.tick(60000); f.click("quota-refresh");
  await f.finish({ agy: { state: "unavailable", windows: [], blockedVersion: "1.1.11", message: "Version paused" } });
  assert.equal(f.quota.data.agy.state, "stale");
  assert.equal(f.quota.data.agy.blockedVersion, "1.1.11");
  f.tick(300000); f.refresh(true);
  assert.deepEqual(f.calls.slice(6).map(call => call.provider), ["claude", "codex"]);
  await f.finish();
});
