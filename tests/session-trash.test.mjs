import assert from "node:assert/strict";
import test from "node:test";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { scan } from "../mods/sessions-plus/history.mjs";
import { sessionKey } from "../mods/sessions-plus/model.js";
import { checkInactive, exclusiveMove, list, nativeTrash, prepare, providerProcess, restore, trash } from "../mods/sessions-plus/trash.mjs";

const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const mac = { skip: process.platform !== "darwin" };
const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const lines = values => values.map(value => JSON.stringify(value)).join("\n") + "\n";
const quiet = () => {};
const move = (source, target) => { assert.throws(() => lstatSync(target), { code: "ENOENT" }); renameSync(source, target); };

function fixture(t) {
  const root = mkdtempSync("/private/tmp/herdr-session-trash-test-"), home = join(root, "home"), cwd = join(root, "project ' ; $(literal)");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(cwd); mkdirSync(join(home, ".Trash"));
  const stores = { claude: join(home, ".claude"), codex: join(home, ".codex"), agy: join(home, ".gemini", "antigravity-cli") };
  const files = {
    claude: join(stores.claude, "projects", "project", id + ".jsonl"),
    codex: join(stores.codex, "sessions", "2026", "01", "02", `rollout-2026-${id}.jsonl`),
    agy: join(stores.agy, "conversations", id + ".db"),
  };
  put(files.claude, lines([{ type: "user", cwd, message: { content: "Fictional fixture message" } }]));
  put(files.codex, lines([{ type: "session_meta", payload: { id, cwd } }]));
  put(files.agy, "Fictional database bytes; never read as conversation content");
  put(join(stores.codex, "session_index.jsonl"), lines([{ id, thread_name: "Fixture Codex" }]));
  const database = join(stores.agy, "conversation_summaries.db"), quote = text => "'" + text.replace(/'/g, "''") + "'";
  const sql = "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, last_modified_time TEXT, parent_conversation_id TEXT);" +
    `INSERT INTO conversation_summaries VALUES (${quote(id)}, 'Fixture agy', ${quote(JSON.stringify([pathToFileURL(cwd).href]))}, '2026-01-02T00:00:00Z', '');`;
  assert.equal(spawnSync("/usr/bin/sqlite3", [database, sql]).status, 0);
  put(join(stores.agy, "cache", "last_conversations.json"), JSON.stringify({ [cwd]: id }));
  put(join(stores.agy, "history.jsonl"), "Shared history stays untouched\n");
  put(join(stores.claude, "history.jsonl"), "Shared history stays untouched\n");
  const options = { home, stores, temp: root, stateDir: join(root, "state") };
  const dependencies = { checkInactive: quiet, move, nativeTrash: source => move(source, join(home, ".Trash", basename(source))) };
  const key = provider => sessionKey({ provider, store: stores[provider], id });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, cwd, stores, files, database, options, dependencies, key };
}

function bundle(f, entry) { return join(f.options.home, ".Trash", "herdr-session-" + entry.token); }
function journal(f, token) { return join(f.options.stateDir, "entries", token + ".json"); }

test("all providers round-trip exact bytes and preserve shared metadata", mac, t => {
  const f = fixture(t), shared = [f.database, join(f.stores.codex, "session_index.jsonl"), join(f.stores.agy, "cache", "last_conversations.json"), join(f.stores.agy, "history.jsonl"), join(f.stores.claude, "history.jsonl")];
  const beforeShared = shared.map(path => readFileSync(path));
  for (const provider of ["claude", "codex", "agy"]) {
    const before = readFileSync(f.files[provider]), identity = lstatSync(f.files[provider]).ino;
    const preview = prepare(f.key(provider), f.options, f.dependencies);
    assert.equal(preview.row.key, f.key(provider)); assert.equal(preview.files.length, 1);
    const { entry } = trash(f.key(provider), f.options, f.dependencies);
    assert.equal(entry.restorable, true); assert.equal(entry.location, "trash"); assert.equal(entry.status, "trashed");
    assert(!existsSync(f.files[provider])); assert(!scan(f.options).rows.some(row => row.key === entry.key));
    assert.equal(list(f.options).entries.length, 1);
    assert.equal(restore(entry.token, f.options, f.dependencies).row.key, f.key(provider));
    assert.deepEqual(readFileSync(f.files[provider]), before); assert.equal(lstatSync(f.files[provider]).ino, identity);
    assert.equal(list(f.options).entries.length, 0); assert(!existsSync(bundle(f, entry)));
  }
  shared.forEach((path, index) => assert.deepEqual(readFileSync(path), beforeShared[index]));
});

test("Claude attachments and agy WAL, SHM, and brain belong to the same bundle", mac, t => {
  const f = fixture(t), claude = join(dirname(f.files.claude), id, "subagents", "agent.jsonl"), brain = join(f.stores.agy, "brain", id, "notes.txt");
  put(claude, "Fixture subagent"); put(brain, "Fixture brain"); put(f.files.agy + "-wal", "Fixture committed WAL"); put(f.files.agy + "-shm", "Fixture SHM");
  for (const provider of ["claude", "agy"]) {
    const expected = provider === "claude" ? [f.files.claude, claude] : [f.files.agy, f.files.agy + "-wal", f.files.agy + "-shm", brain];
    const contents = expected.map(path => readFileSync(path));
    const { entry } = trash(f.key(provider), f.options, f.dependencies);
    assert.equal(entry.files.length, provider === "claude" ? 2 : 4); assert(expected.every(path => !existsSync(path)));
    restore(entry.token, f.options, f.dependencies);
    expected.forEach((path, index) => assert.deepEqual(readFileSync(path), contents[index]));
  }
});

test("invalid keys, symlinks, and duplicate IDs cannot select another file", mac, t => {
  const f = fixture(t);
  assert.throws(() => prepare(sessionKey({ provider: "codex", id, store: f.root }), f.options, f.dependencies), /identity/);
  assert.throws(() => prepare("[]", f.options, f.dependencies), /identity/);
  const duplicate = join(dirname(f.files.codex), `rollout-another-${id}.jsonl`);
  put(duplicate, readFileSync(f.files.codex));
  assert.throws(() => prepare(f.key("codex"), f.options, f.dependencies), /More than one/);
  rmSync(duplicate); rmSync(f.files.codex); symlinkSync(f.files.claude, f.files.codex);
  assert.throws(() => prepare(f.key("codex"), f.options, f.dependencies), /symbolic/);
  put(join(dirname(f.files.claude), id, "safe"), "Fixture attachment");
  symlinkSync(f.files.agy, join(dirname(f.files.claude), id, "escape"));
  assert.throws(() => prepare(f.key("claude"), f.options, f.dependencies), /symbolic/);
  assert(existsSync(f.files.agy)); assert(existsSync(f.files.claude));
});

test("Codex file name and scanned metadata must identify the same physical file", mac, t => {
  const f = fixture(t), another = join(dirname(f.files.codex), `rollout-another-${other}.jsonl`);
  put(another, lines([{ type: "session_meta", payload: { id, cwd: f.cwd } }]));
  assert.throws(() => prepare(f.key("codex"), f.options, f.dependencies), /uniquely match/);
  put(f.files.codex, lines([{ type: "session_meta", payload: { id: other, cwd: f.cwd } }]));
  assert.throws(() => prepare(f.key("codex"), f.options, f.dependencies), /uniquely match/);
  assert(existsSync(another)); assert(existsSync(f.files.codex));
});

test("provider process detection ignores scripts and arbitrary argument text", () => {
  assert(providerProcess("codex", "/usr/local/bin/codex", "codex resume id"));
  assert(providerProcess("claude", "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper", ""));
  assert(providerProcess("codex", "/usr/local/bin/node", "node /opt/node_modules/@openai/codex/bin/codex.js resume id"));
  assert(providerProcess("claude", "/usr/local/bin/node", "node /opt/node_modules/@anthropic-ai/claude-code/cli.js"));
  assert(providerProcess("agy", "/usr/local/bin/bun", "bun /opt/bin/agy.js"));
  assert(!providerProcess("claude", "/bin/zsh", "zsh -c 'echo claude /usr/bin/claude'"));
  assert(!providerProcess("codex", "/usr/local/bin/node", "node /tmp/test.js /usr/bin/codex"));
  assert(!providerProcess("codex", "/usr/local/bin/node", "node -e 'require(\"codex\")'"));
  assert(!providerProcess("codex", "/usr/local/bin/node", "node /tmp/codex/test.js"));
  assert(!providerProcess("claude", "/bin/cat", "cat /tmp/claude"));
});

test("active checks run before movement and a changed file causes rollback", mac, t => {
  const f = fixture(t), original = readFileSync(f.files.claude);
  assert.throws(() => trash(f.key("claude"), f.options, { ...f.dependencies, checkInactive() { throw new Error("Agent is active"); } }), /active/);
  assert.deepEqual(readFileSync(f.files.claude), original); assert.deepEqual(list(f.options).entries, []);
  let calls = 0;
  assert.throws(() => trash(f.key("claude"), f.options, { ...f.dependencies, checkInactive() { if (++calls === 2) writeFileSync(f.files.claude, "Changed fixture"); } }), /changed/);
  assert.equal(readFileSync(f.files.claude, "utf8"), "Changed fixture"); assert.deepEqual(list(f.options).entries, []);
});

test("native Trash failure rolls all moved items back without changing their identities", mac, t => {
  const f = fixture(t), brain = join(f.stores.agy, "brain", id, "notes.txt"); put(brain, "Fixture note");
  const inode = lstatSync(f.files.agy).ino;
  assert.throws(() => trash(f.key("agy"), f.options, { ...f.dependencies, nativeTrash() { throw new Error("Fixture native failure"); } }), /native failure/);
  assert.equal(lstatSync(f.files.agy).ino, inode); assert.equal(readFileSync(brain, "utf8"), "Fixture note");
  assert.deepEqual(list(f.options).entries, []); assert.deepEqual(readdirSync(join(f.options.stateDir, "staging")), []);
});

test("partial movement failure rolls back and retains an entry if rollback conflicts", mac, t => {
  const f = fixture(t), attachment = join(dirname(f.files.claude), id, "note.txt"); put(attachment, "Fixture attachment");
  let count = 0;
  const fail = (source, target) => { if (++count === 2) { put(f.files.claude, "New conflicting session"); throw new Error("Fixture move failure"); } move(source, target); };
  assert.throws(() => trash(f.key("claude"), f.options, { ...f.dependencies, move: fail }), /recovery entry/);
  const entry = list(f.options).entries[0]; assert.equal(entry.status, "recovery"); assert.equal(entry.restorable, true); assert.equal(entry.location, "staging");
  assert.equal(readFileSync(f.files.claude, "utf8"), "New conflicting session");
  assert.throws(() => restore(entry.token, f.options, f.dependencies), /already exists/);
  rmSync(f.files.claude); restore(entry.token, f.options, f.dependencies);
  assert.match(readFileSync(f.files.claude, "utf8"), /Fictional fixture/); assert(existsSync(attachment));
});

test("restore refuses existing destinations and supports Finder putting the bundle back", mac, t => {
  const f = fixture(t), { entry } = trash(f.key("codex"), f.options, f.dependencies);
  put(f.files.codex, "Do not overwrite this fixture");
  assert.throws(() => restore(entry.token, f.options, f.dependencies), /already exists/);
  assert.equal(readFileSync(f.files.codex, "utf8"), "Do not overwrite this fixture"); rmSync(f.files.codex);
  move(bundle(f, entry), join(f.options.stateDir, "staging", "herdr-session-" + entry.token));
  assert.equal(list(f.options).entries[0].location, "staging");
  rmSync(f.cwd, { recursive: true });
  assert.equal(restore(entry.token, f.options, f.dependencies).row.key, f.key("codex")); assert(existsSync(f.files.codex));
});

test("interrupted restore recognizes only original file identities and retries remaining files", mac, t => {
  const f = fixture(t); put(f.files.agy + "-wal", "Fixture WAL");
  const { entry } = trash(f.key("agy"), f.options, f.dependencies), payload = join(bundle(f, entry), "data", entry.files[0]);
  move(payload, f.files.agy);
  assert.equal(restore(entry.token, f.options, f.dependencies).row.key, f.key("agy")); assert(existsSync(f.files.agy + "-wal"));
  const again = trash(f.key("agy"), f.options, f.dependencies).entry;
  move(join(bundle(f, again), "data", again.files[0]), f.files.agy); writeFileSync(f.files.agy, "Changed after partial restore");
  assert.throws(() => restore(again.token, f.options, f.dependencies), /changed/); assert(existsSync(bundle(f, again)));
});

test("restore movement failure rolls already-restored files back into the recovery bundle", mac, t => {
  const f = fixture(t); put(f.files.agy + "-wal", "Fixture WAL");
  const { entry } = trash(f.key("agy"), f.options, f.dependencies); let count = 0;
  assert.throws(() => restore(entry.token, f.options, { ...f.dependencies, move(source, target) { if (++count === 2) throw new Error("Fixture restore failure"); move(source, target); } }), /recovery entry/);
  assert(!existsSync(f.files.agy)); assert.equal(list(f.options).entries[0].status, "recovery");
  restore(entry.token, f.options, f.dependencies); assert(existsSync(f.files.agy)); assert(existsSync(f.files.agy + "-wal"));
});

test("emptying only the fixture bundle marks its persistent entry unavailable", mac, t => {
  const f = fixture(t), { entry } = trash(f.key("codex"), f.options, f.dependencies);
  rmSync(bundle(f, entry), { recursive: true });
  const missing = list(f.options).entries[0]; assert.equal(missing.restorable, false); assert.equal(missing.location, "missing"); assert.match(missing.message, /no longer/);
  assert.throws(() => restore(entry.token, f.options, f.dependencies), /no longer available/); assert(existsSync(journal(f, entry.token)));
});

test("a damaged manifest or changed store does not hide other recoverable entries", mac, t => {
  const f = fixture(t), bad = trash(f.key("claude"), f.options, f.dependencies).entry, good = trash(f.key("codex"), f.options, f.dependencies).entry;
  const manifest = join(bundle(f, bad), "manifest.json"), original = readFileSync(manifest);
  writeFileSync(manifest, "Invalid fixture JSON");
  let entries = list(f.options).entries;
  assert.equal(entries.length, 2); assert.equal(entries.find(entry => entry.token === bad.token).restorable, false); assert.equal(entries.find(entry => entry.token === good.token).restorable, true);
  writeFileSync(manifest, original);
  entries = list({ ...f.options, stores: { ...f.stores, claude: join(f.root, "different-store") } }).entries;
  assert.equal(entries.length, 2); assert.equal(entries.find(entry => entry.token === bad.token).restorable, false); assert.equal(entries.find(entry => entry.token === good.token).restorable, true);
  writeFileSync(journal(f, bad.token), "Invalid journal JSON");
  assert.equal(list(f.options).entries.find(entry => entry.token === good.token).restorable, true);
  restore(good.token, f.options, f.dependencies); assert(existsSync(f.files.codex)); assert(existsSync(bundle(f, bad)));
});

test("an interrupted restore checks original files as well as remaining WAL payloads", mac, t => {
  const f = fixture(t); put(f.files.agy + "-wal", "Fixture WAL");
  const { entry } = trash(f.key("agy"), f.options, f.dependencies);
  move(join(bundle(f, entry), "data", entry.files[0]), f.files.agy);
  const fd = openSync(f.files.agy, "r");
  try {
    assert.throws(() => restore(entry.token, f.options, { ...f.dependencies, checkInactive(_row, paths, snapshots) {
      assert(paths.includes(f.files.agy));
      checkInactive({ provider: "fixture-provider" }, paths, snapshots);
    } }), /in use/);
    assert(!existsSync(f.files.agy + "-wal"));
  } finally { closeSync(fd); }
  restore(entry.token, f.options, f.dependencies); assert(existsSync(f.files.agy + "-wal"));
});

test("unknown files survive cleanup and the journal and manifest remain readable", mac, t => {
  const f = fixture(t), { entry } = trash(f.key("claude"), f.options, f.dependencies), unexpected = join(bundle(f, entry), "unexpected.txt");
  put(unexpected, "Preserve this fixture");
  assert.throws(() => restore(entry.token, f.options, f.dependencies), /unexpected data/);
  assert.equal(readFileSync(unexpected, "utf8"), "Preserve this fixture"); assert(existsSync(join(bundle(f, entry), "manifest.json")));
  assert.equal(list(f.options).entries[0].status, "recovery");
  rmSync(unexpected); restore(entry.token, f.options, f.dependencies); assert.deepEqual(list(f.options).entries, []);
});

test("malformed journal paths, foreign devices, and symlink state directories are rejected", mac, t => {
  const f = fixture(t), { entry } = trash(f.key("agy"), f.options, f.dependencies), path = journal(f, entry.token), original = readFileSync(path, "utf8"), value = JSON.parse(original);
  value.files[0] = "../outside"; writeFileSync(path, JSON.stringify(value));
  assert.throws(() => restore(entry.token, f.options, f.dependencies), /journal/);
  writeFileSync(path, original); value.files = entry.files; value.snapshots[0][0].dev = -1; writeFileSync(path, JSON.stringify(value));
  assert.throws(() => restore(entry.token, f.options, f.dependencies), /identities/);
  writeFileSync(path, original); restore(entry.token, f.options, f.dependencies);
  symlinkSync(f.options.stateDir, join(f.root, "state-link"));
  assert.throws(() => list({ ...f.options, stateDir: join(f.root, "state-link") }), /symbolic/);
});

test("all actions share an exclusive lock and unknown CLI actions fail closed", mac, t => {
  const f = fixture(t);
  prepare(f.key("claude"), f.options, { ...f.dependencies, checkInactive() { assert.throws(() => list(f.options), /in progress/); } });
  assert(existsSync(join(f.options.stateDir, "lock")));
  const command = spawnSync(process.execPath, [new URL("../mods/sessions-plus/trash.mjs", import.meta.url).pathname, "unknown", JSON.stringify(f.options), f.key("claude")], { encoding: "utf8" });
  assert.equal(command.status, 1); assert.match(JSON.parse(command.stdout).error, /Unknown/); assert(existsSync(f.files.claude));
});

test("the permanent native lock survives its helper and releases when its owner is killed", mac, async t => {
  const f = fixture(t), moduleURL = new URL("../mods/sessions-plus/trash.mjs", import.meta.url).href;
  prepare(f.key("claude"), f.options, f.dependencies);
  const lock = join(f.options.stateDir, "lock"), inode = lstatSync(lock).ino;
  // An empty lock file left by a killed process is harmless: OS lock ownership,
  // not file contents or a stale PID, controls entry.
  writeFileSync(lock, ""); assert.deepEqual(list(f.options).entries, []);
  const code = `import {prepare} from ${JSON.stringify(moduleURL)}; prepare(${JSON.stringify(f.key("claude"))}, ${JSON.stringify(f.options)}, {checkInactive(){process.stdout.write("locked\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);}});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("Lock fixture child exited before acquiring its lock."); })]);
  assert.throws(() => list(f.options), /in progress/);
  const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
  assert.deepEqual(list(f.options).entries, []); assert.equal(lstatSync(lock).ino, inode);
});

test("lsof protects an open fixture without reading its content", mac, t => {
  const f = fixture(t), fd = openSync(f.files.codex, "r");
  try { assert.throws(() => checkInactive({ provider: "fixture-provider" }, [f.files.codex], [[{ path: "" }]]), /in use/); }
  finally { closeSync(fd); }
});

test("native macOS Trash and exclusive restoration round-trip only our unique fixture", mac, t => {
  const f = fixture(t), options = { ...f.options, home: homedir() }; let preciseTrash;
  t.after(() => { if (preciseTrash) rmSync(preciseTrash, { recursive: true, force: true }); });
  const original = readFileSync(f.files.claude);
  const { entry } = trash(f.key("claude"), options, { checkInactive: quiet, nativeTrash(source) { preciseTrash = join(homedir(), ".Trash", basename(source)); nativeTrash(source); } });
  assert.equal(entry.location, "trash"); assert(existsSync(preciseTrash)); assert(!existsSync(f.files.claude));
  restore(entry.token, options, { checkInactive: quiet }); assert.deepEqual(readFileSync(f.files.claude), original); assert(!existsSync(preciseTrash));
  const a = join(f.root, "a"), b = join(f.root, "b"); put(a, "Original A"); put(b, "Original B");
  assert.throws(() => exclusiveMove(a, b), /without overwriting/); assert.equal(readFileSync(a, "utf8"), "Original A"); assert.equal(readFileSync(b, "utf8"), "Original B");
});
