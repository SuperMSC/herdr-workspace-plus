import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scan, preview, codexOrigin } from "../mods/sessions-plus/history.mjs";
import { sessionKey, filterRows, historyGroup, historyTime } from "../mods/sessions-plus/model.js";
const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const put = (path, rows) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n"); };
function fixture(t) {
  const root = mkdtempSync("/private/tmp/herdr-session-insights-"); t.after(() => rmSync(root, { recursive: true, force: true }));
  const stores = { claude: join(root, "claude"), codex: join(root, "codex"), agy: join(root, "agy") }, cwd = join(root, "project"); mkdirSync(cwd);
  const claude = join(stores.claude, "projects", "project", id + ".jsonl"), codex = join(stores.codex, "sessions", "2026", "11", "04", `rollout-fixture-${id}.jsonl`);
  const options = { home: root, stores, temp: root };
  return { root, stores, cwd, claude, codex, options, key: provider => sessionKey({ provider, store: stores[provider], id }) };
}

test("session sources use recorded metadata, never titles or message wording", t => {
  const f = fixture(t);
  put(f.codex, [{ type: "session_meta", payload: { id, cwd: f.cwd, source: "cli" } }, { type: "event_msg", payload: { type: "user_message", message: "Guardian review" } }]);
  put(f.claude, [{ type: "user", cwd: f.cwd, isSidechain: false, message: { content: "Guardian review" } }]);
  assert(scan(f.options).rows.every(row => row.origin === "main"));
  for (const [source, expected] of [[{ subagent: { other: "guardian" } }, "review"], [{ subagent: { thread_spawn: { parent_thread_id: other } } }, "subagent"], [null, "unknown"], ["guardian", "unknown"]]) {
    put(f.codex, [{ type: "session_meta", payload: { id, cwd: f.cwd, source } }]);
    assert.equal(scan(f.options).rows.find(row => row.provider === "codex").origin, expected);
    assert.equal(codexOrigin(source), expected);
  }
  put(f.claude, [{ type: "user", cwd: f.cwd, isSidechain: true, message: { content: "Plain title" } }]);
  assert.equal(scan(f.options).rows.find(row => row.provider === "claude").origin, "subagent");
  put(f.claude, [{ type: "user", cwd: f.cwd, message: { content: "Plain title" } }]);
  assert.equal(scan(f.options).rows.find(row => row.provider === "claude").origin, "unknown");
});

test("Claude preview returns only the latest text per role, without thinking or tool contents", t => {
  const f = fixture(t);
  put(f.claude, [
    { type: "user", cwd: f.cwd, message: { content: "Old question" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Old answer" }] } },
    { type: "user", isMeta: true, message: { content: "Internal setup" } },
    { type: "user", timestamp: "2026-11-04T00:00:00Z", message: { content: [{ type: "tool_result", content: "Tool secret" }, { type: "text", text: "Latest question" }] } },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "Private reasoning" }, { type: "text", text: "Latest answer\u001b[31m" }] } },
  ]);
  const before = readFileSync(f.claude), result = preview(f.key("claude"), f.options);
  assert.deepEqual(result.messages.map(message => message.role), ["user", "assistant"]);
  assert.deepEqual(result.messages.map(message => message.text), ["Latest question", "Latest answer[31m"]);
  assert(!JSON.stringify(result.messages).match(/Old question|Old answer|Internal setup|Tool secret|Private reasoning/));
  assert.deepEqual(readFileSync(f.claude), before); assert.equal(result.limited, false);
});

test("Codex preview supports real event messages and response-item text without duplicate messages", t => {
  const f = fixture(t);
  put(f.codex, [
    { type: "session_meta", payload: { id, cwd: f.cwd, source: "cli" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Latest question" }] } },
    { type: "event_msg", payload: { type: "user_message", message: "Latest question" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Latest answer" }] } },
    { type: "event_msg", payload: { type: "agent_message", message: "Latest answer" } },
    { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Not a visible message" }] } },
  ]);
  const result = preview(f.key("codex"), f.options);
  assert.equal(result.messages.length, 2); assert.equal(result.messages[1].text, "Latest answer");
  assert(!JSON.stringify(result).includes("Not a visible message"));
});

test("message preview bounds large tails, clips long visible text, and excludes old head messages", t => {
  const f = fixture(t);
  put(f.claude, [{ type: "user", cwd: f.cwd, message: { content: "Old question at head" } }]);
  appendFileSync(f.claude, JSON.stringify({ type: "assistant", message: { content: "x".repeat(1024 * 1024) } }) + "\n");
  appendFileSync(f.claude, JSON.stringify({ type: "assistant", message: { content: "z".repeat(7000) } }) + "\n");
  const result = preview(f.key("claude"), f.options);
  assert.equal(result.limited, true); assert.equal(result.messages.length, 1); assert.equal(result.messages[0].text.length, 6000); assert.equal(result.messages[0].truncated, true);
});

test("preview rejects absent, ambiguous, mismatched and symlink session files", t => {
  const f = fixture(t); put(f.codex, [{ type: "session_meta", payload: { id: other, cwd: f.cwd } }]);
  assert.throws(() => preview(sessionKey({ provider: "codex", store: f.stores.codex, id: other }), f.options), /identity/);
  assert.throws(() => preview(f.key("codex"), f.options), /no longer available/);
  rmSync(f.codex); symlinkSync("/etc/hosts", f.codex);
  assert.throws(() => preview(f.key("codex"), f.options), /no longer available/);
});

test("source filtering composes with provider, directory, and ID search; groups use local dates", () => {
  const now = +new Date(2026, 10, 4, 12), today = +new Date(2026, 10, 4, 0, 30), yesterday = +new Date(2026, 10, 3, 23, 30);
  const rows = [{ id, provider: "codex", cwd: "/project", origin: "review", updated: today }, { id: other, provider: "codex", cwd: "/project", origin: "main", updated: yesterday }];
  assert.deepEqual(filterRows(rows, { cwd: "/project", source: "review", query: id.slice(0, 8) }), [rows[0]]);
  assert.deepEqual(filterRows(rows, { cwd: "/different", source: "review" }), []);
  assert.equal(historyGroup(rows[0], now), "Today"); assert.equal(historyGroup(rows[1], now), "Yesterday"); assert.equal(historyGroup({ live: true }, now), "Running");
  assert.match(historyTime(rows[0], now), /Updated 11h ago · 11111111/);
  assert.equal(historyGroup({}, now), "Unknown date");
});
