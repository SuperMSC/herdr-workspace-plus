import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { appendFileSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readLive } from "../mods/sessions-plus/live.mjs";
import { claudeWindow, contextLabel, contextPercent, LIVE_KEY, LIVE_LIMITS, updateLive } from "../mods/sessions-plus/live-model.js";
import { argvIdentity, liveKey, sessionKey, sessionRows } from "../mods/sessions-plus/model.js";
import { promptTarget } from "../mods/sessions-plus/prompt-queue-model.js";
import { uiFunction } from "./helpers/ui-function.mjs";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const timestamp = "2026-11-24T10:34:00.000Z", asOf = Date.parse(timestamp);
const user = content => ({ type: "user", message: { content }, sessionId: id });
const assistant = (model = "claude-opus-4-8", extra = {}) => ({
  type: "assistant", sessionId: id, timestamp, isSidechain: false,
  message: { model, usage: { input_tokens: 4000, cache_read_input_tokens: 160000, cache_creation_input_tokens: 10000, output_tokens: 7000 } }, ...extra,
});
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const jsonl = (...records) => records.map(record => JSON.stringify(record)).join("\n") + "\n";

function fixture(t) {
  const folder = mkdtempSync(join(realpathSync(tmpdir()), "live-sessions-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = join(folder, "claude"), pidFile = join(store, "sessions", process.pid + ".json"), transcript = join(store, "projects", "project", id + ".jsonl");
  const procStart = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], {
    encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
  }).trim();
  const writePid = (props = {}) => put(pidFile, JSON.stringify({ pid: process.pid, sessionId: id, kind: "interactive", procStart, startedAt: Date.now() + 10000, ...props }));
  writePid();
  const request = { key: "t7@100", pid: process.pid, provider: "claude", argvId: other, store };
  return { folder, store, pidFile, transcript, writePid, request, read: (changes = {}) => readLive([{ ...request, ...changes }])[request.key] };
}

test("Claude validates the foreground process start in UTC and prefers pid identity to argv", t => {
  const f = fixture(t);
  put(f.transcript, jsonl(user("<command-name>/resume</command-name>"), user("/compact"), user("<system-reminder>ignore</system-reminder>"),
    user("  The first   real prompt."), assistant(), assistant("claude-haiku-4-5", { isSidechain: true })));
  const output = JSON.parse(execFileSync(process.execPath, [
    new URL("../mods/sessions-plus/live.mjs", import.meta.url).pathname, JSON.stringify([f.request]),
  ], { encoding: "utf8", env: { ...process.env, TZ: "Asia/Singapore" } }))[f.request.key];
  assert.equal(output.id, id);
  assert.equal(output.title, "The first real prompt.");
  assert.deepEqual(output.context, { used: 174000, window: 1000000, model: "claude-opus-4-8", asOf });
  f.writePid({ name: "  Current\n name ", nameSource: "user" });
  assert.equal(f.read().title, "Current name");
});

test("derived or untyped PID names yield to the transcript title in priority order", t => {
  const f = fixture(t);
  f.writePid({ name: "agent-workspace-80", nameSource: "derived" });
  put(f.transcript, jsonl(user("/compact"), user("First real prompt"), { type: "summary", summary: "Summary" }, assistant()));
  assert.equal(f.read().title, "First real prompt");
  appendFileSync(f.transcript, jsonl({ type: "ai-title", aiTitle: "AI title" }));
  assert.equal(f.read().title, "AI title");
  appendFileSync(f.transcript, jsonl({ type: "custom-title", customTitle: "Custom title" }, { type: "ai-title", aiTitle: "New AI title" }));
  assert.equal(f.read().title, "Custom title");
  for (const nameSource of [undefined, 1]) {
    f.writePid({ name: "claude-7a", nameSource });
    assert.equal(f.read().title, "Custom title");
  }
  f.writePid({ name: "Explicit PID name", nameSource: "user" });
  assert.equal(f.read().title, "Explicit PID name");
});

test("stale, missing, mismatched and non-interactive Claude pid records never resolve", t => {
  const f = fixture(t);
  for (const changes of [{ procStart: "Sun Nov 22 12:37:13 2026" }, { procStart: null }, { pid: process.pid + 1 }, { kind: "background" }]) {
    f.writePid(changes);
    assert.equal(f.read(), undefined);
  }
  rmSync(f.pidFile);
  assert.equal(f.read(), undefined);
});

test("Claude retries a usage-free 512 KiB tail once at 2 MiB", t => {
  const f = fixture(t), padding = bytes => ({ type: "progress", data: "a".repeat(bytes) });
  put(f.transcript, jsonl(user("First prompt"), assistant(), padding(600 * 1024)));
  assert.equal(f.read().context?.used, 174000);
  put(f.transcript, jsonl(user("First prompt"), assistant(), padding(2200 * 1024)));
  const entry = f.read();
  assert.equal(entry.context, null);
  assert.equal(entry.id, id);
  assert.equal(entry.title, "First prompt");
});

test("Codex requires an exact argv ID and reads the last request rather than cumulative counts", t => {
  const f = fixture(t), store = join(f.folder, "codex");
  const transcript = join(store, "sessions", "2026", "11", "24", "rollout-2026-11-24T10-34-00-" + id + ".jsonl");
  const tokenCount = used => ({ type: "event_msg", timestamp, payload: { type: "token_count", info: {
    last_token_usage: { input_tokens: used - 100, output_tokens: 100, total_tokens: used },
    total_token_usage: { total_tokens: 2000000 }, model_context_window: 200000,
  } } });
  const session = { type: "session_meta", payload: { id, cwd: f.folder } };
  const request = { provider: "codex", store, argvId: id };
  mkdirSync(dirname(transcript), { recursive: true });
  assert.equal(f.read(request), undefined);
  put(transcript, jsonl(session, { type: "turn_context", payload: { model: "gpt-fixture" } }, tokenCount(1500), tokenCount(126000)));
  const confirmed = f.read(request);
  assert.deepEqual(confirmed.context, { used: 126000, model: "gpt-fixture", window: 200000, asOf });
  assert.equal(f.read({ ...request, prev: confirmed.stamp }).unchanged, true);
  assert.equal(f.read({ ...request, argvId: null }), undefined);
  put(transcript, jsonl({ ...session, payload: { ...session.payload, id: other } }, tokenCount(126000)));
  assert.equal(f.read(request), undefined);
  const { size, mtimeMs: mtime } = statSync(transcript);
  assert.equal(f.read({ ...request, prev: { path: transcript, size, mtime } }), undefined);
  put(transcript, jsonl(tokenCount(126000)));
  assert.equal(f.read(request), undefined);
});

test("unchanged transcript stamps skip data reads and changed size causes a new reading", t => {
  const f = fixture(t);
  put(f.transcript, jsonl(assistant()));
  const first = f.read();
  const unchanged = f.read({ prev: first.stamp });
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.context, null);
  assert.deepEqual(unchanged.stamp, first.stamp);
  f.writePid({ name: "Changed title", nameSource: "user" });
  assert.equal(f.read({ prev: first.stamp }).title, "Changed title");
  appendFileSync(f.transcript, jsonl(assistant("claude-haiku-4-5")));
  assert.equal(f.read({ prev: first.stamp }).context?.window, 200000);
});

test("a transcript appending during a probe uses its snapshot and rejects shrinkage or replacement", t => {
  const f = fixture(t), original = jsonl(assistant());
  put(f.transcript, original);
  utimesSync(f.transcript, 1, 1);
  const snapshot = statSync(f.transcript);

  function readDuring(change) {
    const read = fs.readSync, target = statSync(f.transcript);
    let changed = false;
    const mock = t.mock.method(fs, "readSync", (fd, ...args) => {
      const count = read(fd, ...args), stat = fstatSync(fd);
      if (!changed && stat.ino === target.ino && stat.dev === target.dev) {
        changed = true;
        change();
      }
      return count;
    });
    syncBuiltinESMExports();
    try {
      const result = f.read();
      assert.equal(changed, true);
      return result;
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
  }

  const grew = readDuring(() => appendFileSync(f.transcript, jsonl(assistant("claude-haiku-4-5"))));
  assert.equal(grew.context.window, 1000000);
  assert.deepEqual(grew.stamp, { path: f.transcript, size: snapshot.size, mtime: snapshot.mtimeMs });
  assert.equal(f.read({ prev: grew.stamp }).context.window, 200000);

  const shrank = readDuring(() => truncateSync(f.transcript, 0));
  assert.equal(shrank.context, null);
  assert.equal(shrank.stamp, undefined);

  put(f.transcript, original);
  const replaced = readDuring(() => {
    renameSync(f.transcript, f.transcript + ".old");
    put(f.transcript, original);
  });
  assert.equal(replaced.context, null);
  assert.equal(replaced.stamp, undefined);
});

test("symbolic-link stores, directories, pid records, and transcripts are rejected", t => {
  const f = fixture(t);
  const alias = join(f.folder, "alias");
  symlinkSync(f.store, alias);
  assert.equal(f.read({ store: alias }), undefined);
  const target = join(f.folder, "transcript.jsonl");
  put(target, jsonl(assistant()));
  mkdirSync(dirname(f.transcript), { recursive: true });
  symlinkSync(target, f.transcript);
  assert.equal(f.read().context, null);
  const fakeProject = join(f.folder, "outside");
  put(join(fakeProject, id + ".jsonl"), jsonl(assistant()));
  symlinkSync(fakeProject, join(f.store, "projects", "another-project"));
  assert.equal(f.read().context, null);
  const realPid = join(f.folder, "record.json");
  put(realPid, readFileSync(f.pidFile));
  rmSync(f.pidFile);
  symlinkSync(realPid, f.pidFile);
  assert.equal(f.read(), undefined);
});

test("polling caps the number of agents and shares an eight MiB read budget", t => {
  const f = fixture(t);
  let input = Array.from({ length: LIVE_LIMITS.agents + 3 }, (_, index) => ({ ...f.request, key: `t${index}@100` }));
  assert.equal(Object.keys(readLive(input)).length, 40);
  put(f.transcript, jsonl({ type: "progress", text: "x".repeat(3 * 1024 * 1024) }));
  input = input.slice(0, 4);
  const result = Object.values(readLive(input));
  assert.equal(result.length, 4);
  assert.equal(result.filter(entry => entry.stamp).length, 2);
  assert.equal(result.filter(entry => entry.deferred).length, 2);
  assert(result.every(entry => entry.id === id && entry.context === null));
});

test("formatting honors known models, warning thresholds, over-window readings and freshness", () => {
  for (const model of ["claude-fable-5-20261010", "claude-mythos-5-1", "claude-opus-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-5-1", "claude-sonnet-4-6", "claude-haiku-5-5"]) assert.equal(claudeWindow(model), 1000000, model);
  for (const model of ["claude-haiku-4-5-20251001", "claude-sonnet-4-5", "claude-3-5-haiku-20241022", "claude-2.1"]) assert.equal(claudeWindow(model), 200000, model);
  assert.equal(claudeWindow("unknown"), null);
  assert.equal(contextPercent(174000, null), null);
  assert.equal(contextPercent(200400, 200000), null);
  const entry = { used: 126000, window: 200000, model: "gpt-fixture", asOf, at: asOf };
  assert.deepEqual(contextLabel(entry, asOf + 12000), { label: "63%", level: null, tooltip: "Context 126K of 200K tokens · gpt-fixture · as of 12s ago · window table 2026-11-03" });
  assert.equal(contextLabel({ ...entry, used: 160000 }, asOf).level, "warn");
  assert.equal(contextLabel({ ...entry, used: 180000 }, asOf).level, "strong");
  assert.equal(contextLabel({ ...entry, used: 174000, window: null }, asOf).label, "174K");
  assert.equal(contextLabel({ ...entry, used: 201000 }, asOf).label, "201K");
  assert.equal(contextLabel(entry, asOf + 120001), null);
  assert.equal(contextLabel({ ...entry, used: null }, asOf), null);
});

test("confirmed idle context gets one publication per minute and deferred readings still expire", () => {
  const key = "t7@100", entry = { provider: "claude", pid: 11, id, store: "/claude", title: "Title",
    context: { used: 200201, window: 200000, model: "claude-haiku-4-5", asOf } };
  const first = updateLive({}, { [key]: entry }, asOf);
  assert.equal(first[key].at, asOf);
  assert.equal(contextPercent(first[key].used, first[key].window), null);
  assert.equal(updateLive(first, { [key]: { ...entry, context: { ...entry.context, used: 200301 } } }, asOf + 20000), null);
  const second = updateLive(first, { [key]: entry }, asOf + 60000);
  assert.deepEqual(second[key], { ...first[key], at: asOf + 60000 });
  assert.equal(updateLive(second, { [key]: entry }, asOf + 119999), null);
  assert.equal(updateLive(second, { [key]: { ...entry, deferred: true } }, asOf + 120001), null);
  assert.equal(contextLabel(first[key], asOf + 120001), null);
  assert(contextLabel(second[key], asOf + 120001));
  assert.deepEqual(updateLive(first, {}), {});
});

test("staggered idle agents share a publication and content changes still publish immediately", () => {
  const a = { provider: "claude", pid: 11, id, store: "/claude", context: { used: 40000, window: 200000, asOf } };
  const b = { ...a, pid: 22, id: other };
  const first = updateLive({}, { a }, asOf);
  const second = updateLive(first, { a, b }, asOf + 20000);
  assert.equal(updateLive(second, { a, b }, asOf + 60000), null);
  const heartbeat = updateLive(second, { a, b }, asOf + 80000);
  assert.equal(heartbeat.a.at, asOf + 80000);
  assert.equal(heartbeat.b.at, asOf + 80000);
  const changed = updateLive(heartbeat, { a: { ...a, title: "New title" }, b }, asOf + 100000);
  assert.equal(changed.a.at, asOf + 100000);
  assert.equal(changed.b, heartbeat.b);
});

test("prompt targets use only a live matching foreground PID in the local identities map", () => {
  const terminal = { state: "live", address: "t7", created_ms: 100, pid: 10, foreground: { pid: 11, argv: ["claude", "--resume", other] } };
  const current = { provider: "claude", id, pid: 11, store: "/claude" };
  const identities = { [liveKey(terminal)]: current };
  const agent = { address: terminal.address, status: "idle" };
  assert.equal(promptTarget(agent, terminal, {}, identities).sessionId, id);
  assert.equal(promptTarget(agent, { ...terminal, foreground: { ...terminal.foreground, pid: 12 } }, {}, identities).sessionId, other);
  assert.equal(promptTarget({ ...agent, address: "host/t7" }, { ...terminal, address: "host/t7" }, {}, { "host/t7@100": current }).sessionId, other);
});

test("footer respects process identity and preserves the Sessions key and badge when a requested probe is omitted", async () => {
  let active = false, inCheck = true, probe, pending, published, probes = 0, delay, tick;
  const terminal = { state: "live", address: "t7", created_ms: 100, pid: 10, foreground: { pid: 11, argv: ["claude", "--resume", other] } };
  const remote = { ...terminal, address: "host/t8" }, missingRoot = { ...terminal, address: "t9", pid: null };
  const source = readFileSync(new URL("../mods/sessions-plus/footer.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "class");
  const Service = uiFunction("checking", "window", "terminals", "exec", "appHome", "shared", "setShared", "argvIdentity", "liveKey", "LIVE_KEY", "LIVE_LIMITS", "updateLive",
    source + "\nreturn LiveSessions;")(() => inCheck, () => ({ active }), () => [terminal, remote, missingRoot],
    (_node, argv, opts) => { probes++; probe = JSON.parse(argv[1]); assert.equal(opts.timeout, 10000); return new Promise(resolve => { pending = resolve; }); },
    () => "/app", () => published, (_key, value) => { published = value; }, argvIdentity, liveKey, LIVE_KEY, LIVE_LIMITS, updateLive);
  let task, observation;
  const cx = { spawn: run => { task = run(); }, timer: { every: (ms, fn) => { delay = ms; tick = fn; } } };
  new Service().init({}, cx);
  assert.equal(delay, undefined);
  inCheck = false;
  const service = new Service((...args) => { observation = args; });
  service.init({}, cx);
  assert.equal(delay, 20000);
  assert.equal(probes, 0);
  active = true;
  tick(cx); tick(cx);
  assert.equal(probes, 1);
  assert.deepEqual(probe, [{ key: "t7@100", provider: "claude", pid: 11, argvId: other, store: null }]);
  const entry = { provider: "claude", id, store: "/claude", pid: 11, context: { used: 17000, window: 200000, asOf } };
  const answer = { code: 0, stdout: JSON.stringify({ "t7@100": entry }) };
  terminal.pid = 12;
  pending(answer); await task;
  assert.equal(published, undefined);
  tick(cx); pending(answer); await task;
  assert.equal(published["t7@100"].id, id);
  const first = published;
  tick(cx); pending({ code: 0, stdout: "{}" }); await task;
  assert.equal(published, first);
  assert.deepEqual(observation.slice(1), [{}, new Set(["t7@100"])]);
  const [row] = sessionRows([], [terminal], [], {}, published);
  assert.equal(row.key, sessionKey(entry));
  assert.equal(row.context.label, "8%");
  terminal.foreground.pid = 13;
  tick(cx); pending({ code: 0, stdout: "{}" }); await task;
  assert.deepEqual(published, {});
  service.close(); tick(cx);
  assert.equal(probes, 4);
});
