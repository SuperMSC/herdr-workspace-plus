import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { scan, validate, agySummaries } from "../mods/sessions-plus/history.mjs";
import { NAMES, PENDING, PROVIDERS, sessionKey, cleanTitle, argvIdentity, sessionRows, filterRows, resumeArgv, launchCommand } from "../mods/sessions-plus/model.js";

const id = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222";
const put = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); };
const jsonl = rows => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "sessions-plus-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), cwd = join(root, "project ' ; $ name"), stores = { claude: join(home, ".claude"), codex: join(home, ".codex"), agy: join(home, ".gemini", "antigravity-cli") };
  mkdirSync(cwd, { recursive: true });
  put(join(stores.claude, "projects", "encoded-project", id + ".jsonl"), jsonl([
    { type: "user", cwd, message: { content: "First Claude message" } },
    { type: "custom-title", customTitle: "Claude custom title" },
  ]));
  put(join(stores.codex, "sessions", "2026", "01", "02", `rollout-2026-${id}.jsonl`), jsonl([
    { type: "session_meta", payload: { id, cwd } },
    { type: "event_msg", payload: { type: "user_message", message: "First Codex message" } },
  ]));
  put(join(stores.codex, "session_index.jsonl"), jsonl([{ id, thread_name: "Codex custom title" }]));
  mkdirSync(stores.agy, { recursive: true });
  const database = join(stores.agy, "conversation_summaries.db");
  const sql = "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, last_modified_time TEXT, parent_conversation_id TEXT);";
  const result = spawnSync("/usr/bin/sqlite3", [database, sql]); assert.equal(result.status, 0);
  const esc = s => "'" + s.replace(/'/g, "''") + "'";
  assert.equal(spawnSync("/usr/bin/sqlite3", [database, `INSERT INTO conversation_summaries VALUES (${esc(id)}, 'agy saved title', ${esc(JSON.stringify([pathToFileURL(cwd).href]))}, '2026-01-02 12:00:00Z', '');`]).status, 0);
  put(join(stores.agy, "conversations", id + ".db"), "fixture conversation; never read by the scanner");
  for (const name of ["claude", "codex", "agy"]) { const file = join(home, ".local", "bin", name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); }
  return { root, home, cwd, stores, database, options: { home, stores, temp: root } };
}

test("reads all three providers, preserves distinct identities, and never changes their files", t => {
  const f = fixture(t), before = readFileSync(f.database), files = readdirSync(f.stores.agy);
  const data = scan(f.options);
  assert.equal(data.rows.length, 3); assert.deepEqual(data.warnings, []);
  assert.deepEqual(new Set(data.rows.map(r => r.title)), new Set(["Claude custom title", "Codex custom title", "agy saved title"]));
  assert.equal(new Set(data.rows.map(r => r.key)).size, 3);
  assert(data.rows.every(r => r.cwd === f.cwd));
  assert.deepEqual(readFileSync(f.database), before); assert.deepEqual(readdirSync(f.stores.agy), files);
  assert(!readdirSync(f.root).some(n => n.startsWith("herdr-sessions-read-")));
});

test("partial JSON lines, bad files and symlink transcripts cannot break other providers", t => {
  const f = fixture(t), folder = join(f.stores.claude, "projects", "encoded-project");
  appendFileSync(join(folder, id + ".jsonl"), '{"incomplete":');
  symlinkSync(join(folder, id + ".jsonl"), join(folder, second + ".jsonl"));
  put(join(f.stores.codex, "sessions", "bad.jsonl"), "not json");
  const data = scan(f.options); assert.equal(data.rows.length, 3); assert(!data.rows.some(r => r.id === second));
});

test("large transcripts retain first metadata and latest title within bounded reads", t => {
  const f = fixture(t), file = join(f.stores.claude, "projects", "encoded-project", id + ".jsonl");
  appendFileSync(file, jsonl([{ type: "assistant", message: { content: "x".repeat(1024 * 1024) } }, { type: "custom-title", customTitle: "Latest title" }]));
  assert.equal(scan(f.options).rows.find(r => r.provider === "claude").title, "Latest title");
});

test("agy snapshot includes committed WAL rows and removes temporary sidecars", async t => {
  const f = fixture(t);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(f.database); t.after(() => db.close());
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  db.prepare("UPDATE conversation_summaries SET title=? WHERE conversation_id=?").run("Title from WAL", id);
  const walBefore = readFileSync(f.database + "-wal");
  assert.equal(agySummaries(f.stores.agy, { temp: f.root })[0].title, "Title from WAL");
  assert.deepEqual(readFileSync(f.database + "-wal"), walBefore);
  assert(!readdirSync(f.root).some(n => n.startsWith("herdr-sessions-read-")));
});

test("failed SQLite reads clean up their snapshot and leave other provider rows available", t => {
  const f = fixture(t);
  assert.throws(() => agySummaries(f.stores.agy, { temp: f.root, sqlite: join(f.root, "missing-sqlite") }), /Could not read/);
  const data = scan({ ...f.options, sqlite: join(f.root, "missing-sqlite") });
  assert.equal(data.rows.length, 2); assert.equal(data.warnings.length, 1);
  assert(!readdirSync(f.root).some(n => n.startsWith("herdr-sessions-read-")));
});

test("agy can read a checkpointed WAL database with no remaining sidecars", t => {
  const f = fixture(t);
  assert.equal(spawnSync("/usr/bin/sqlite3", [f.database, "PRAGMA journal_mode=WAL;"]).status, 0);
  assert(!existsSync(f.database + "-wal"));
  assert.equal(agySummaries(f.stores.agy, { temp: f.root })[0].title, "agy saved title");
  assert(!existsSync(f.database + "-wal"));
});

test("validation checks a still-existing history entry and its original working directory", t => {
  const f = fixture(t), row = scan(f.options).rows.find(r => r.provider === "codex");
  assert.equal(validate(row.key, f.options).row.cwd, f.cwd);
  rmSync(f.cwd, { recursive: true }); assert.throws(() => validate(row.key, f.options), /directory no longer exists/);
  assert.throws(() => validate("missing", f.options), /no longer available/);
});

const row = (provider = "claude") => { const r = { provider, id, store: `/home/demo/.${provider}`, cwd: "/projects/demo", title: "Original", defaultStore: true }; return { ...r, key: sessionKey(r) }; };
test("live matching understands Herdr wrappers, explicit roots, and excludes ended agents", () => {
  const history = row();
  const argv = ["/bin/zsh", "-lic", '"$@"; exec "$0" -li', "/bin/zsh", ...resumeArgv(history, "/bin/claude")];
  assert.deepEqual(argvIdentity({ argv }), { provider: "claude", id, store: history.store });
  const terminal = { state: "live", address: "t1", created_ms: 10, argv, title: "Terminal" };
  const rows = sessionRows([history], [terminal], [], { [history.key]: "My name" });
  assert.equal(rows.length, 1); assert.equal(rows[0].live, true); assert.equal(rows[0].title, "My name");
  assert.equal(argvIdentity({ ...terminal, foreground: { argv: ["/bin/zsh", "-li"] } }), null);
  assert.equal(sessionRows([history], [{ ...terminal, address: "remote/t1" }], []).length, 2);
  assert.equal(sessionRows([history], [{ ...terminal, argv: ["claude", "--resume", "--help"] }], []).length, 2);
});

test("same-folder sessions are never guessed to be the same conversation", () => {
  const history = row();
  const rows = sessionRows([history], [{ state: "live", address: "t2", cwd: history.cwd, argv: ["claude"], program: { agent: true } }], []);
  assert.equal(rows.length, 2); assert.notEqual(rows[0].key, rows[1].key);
});

test("resume commands keep metacharacters as arguments and always target a local space", () => {
  for (const provider of Object.keys(PROVIDERS)) {
    const r = { ...row(provider), cwd: "/projects/a ' ; $(no)", store: "/home/a ' ; $(no)/store" };
    const [name, args] = launchCommand(r, `/bin/${provider}`, [{ id: "remote", machine: "server", folder: r.cwd }, { id: "local", machine: null, folder: r.cwd }]);
    assert.equal(name, "tab.new"); assert.equal(args.space, "local"); assert.equal(args.folder, r.cwd);
    assert.deepEqual(args.argv.slice(-2), [provider === "codex" ? "resume" : provider === "agy" ? "--conversation" : "--resume", id]);
    assert(!args.argv.includes("--dangerously-skip-permissions"));
    assert.equal(launchCommand(r, `/bin/${provider}`, [{ id: "remote", machine: "server", folder: r.cwd }])[0], "space.new");
  }
  assert.throws(() => resumeArgv({ ...row(), id: "--help" }, "/bin/claude"), /Invalid/);
});

test("folder and provider filters preserve local/remote boundaries and renamed title search", () => {
  const r = row(), other = { ...row("agy"), cwd: "/projects/other" }, remote = { ...r, remote: true };
  assert.deepEqual(filterRows([r, other, remote], { cwd: r.cwd }), [r]);
  assert.deepEqual(filterRows([r, other], { all: true, provider: "agy", query: "orig" }), [other]);
  assert.deepEqual(filterRows([r], { cwd: r.cwd, remote: true }), []);
  assert.equal(cleanTitle("name\n\twith control"), "name with control");
});

function viewClass(file, dependencies) {
  const source = readFileSync(new URL(`../mods/sessions-plus/${file}.js`, import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  return new Function(...Object.keys(dependencies), source)(...Object.values(dependencies));
}

test("a repeated resume click starts once and uses the captured session directory", async () => {
  const r = row(), state = {}, calls = [], tasks = [], timers = [];
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const Panel = viewClass("main", { View: class {}, NAMES, PENDING, PROVIDERS, sessionRows, filterRows, launchCommand,
    focused: () => ({ cwd: "/changed/focus" }), spaces: () => [], panes: () => [], terminals: () => [],
    shared: key => state[key], setShared: (key, value) => state[key] = value, run: (...args) => calls.push(args),
  });
  const panel = new Panel(); Object.assign(panel, { history: [r], busy: new Set(), error: "", read: async () => { await gate; return { row: r, command: "/bin/claude" }; } });
  const cx = { notify() {}, spawn: task => tasks.push(task(cx)), timer: { after: (_ms, callback) => timers.push(callback) } };
  panel.open(r, cx); panel.open(r, cx); assert.equal(tasks.length, 1);
  finish(); await Promise.all(tasks);
  assert.equal(calls.length, 1); assert.equal(calls[0][1].folder, r.cwd); assert.equal(timers.length, 1);
  panel.open(r, cx); assert.equal(tasks.length, 1);
});

test("live sessions focus immediately, while failed validation never launches a command", async () => {
  const r = row(), calls = [], tasks = [], state = {};
  const Panel = viewClass("main", { View: class {}, NAMES, PENDING, shared: k => state[k], setShared: (k, v) => state[k] = v, run: (...args) => calls.push(args) });
  const panel = new Panel(); panel.busy = new Set(); panel.rows = () => [{ ...r, live: true, address: "t9" }];
  const cx = { notify() {}, spawn: task => tasks.push(task(cx)) };
  panel.open(r, cx); assert.deepEqual(calls, [["agent.focus", { terminal: "t9" }]]);
  panel.rows = () => []; panel.read = async () => { throw new Error("gone"); };
  panel.open(r, cx); await Promise.all(tasks); assert.equal(calls.length, 1); assert.equal(panel.error, "gone"); assert(!state[PENDING][r.key]);
});

test("renaming uses the captured identity and clearing restores the original title", () => {
  const a = row(), b = row("codex"), state = { [NAMES]: { [b.key]: "Keep other name" } }, closed = [];
  const Rename = viewClass("rename", { NAMES, cleanTitle, shared: k => state[k], setShared: (k, v) => state[k] = v, closeOverlay: id => closed.push(id) });
  const view = new Rename(); view.p = { target: a, overlay: "rename" }; view.input = { value: () => "My saved name" };
  view.save({ notify() {} }); assert.equal(state[NAMES][a.key], "My saved name"); assert.equal(state[NAMES][b.key], "Keep other name");
  view.input.value = () => ""; view.save({ notify() {} }); assert(!Object.hasOwn(state[NAMES], a.key)); assert.equal(closed.length, 2);
});
