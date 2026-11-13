import { uiFunction } from "./helpers/ui-function.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as model from "../mods/sessions-plus/notes-model.js";
import { createNotesClient } from "../mods/sessions-plus/notes-client.js";

const project = model.projectNoteScope({ root: "/project/main", on: null });
const global = model.globalNoteScope();
const empty = () => ({ schema: 1, notes: [] });
const note = (state, scope, body, revision = 0, title = scope.label) => model.updateNote(state, scope, { title, body }, revision);

async function files(t) {
  const home = await mkdtemp(join(tmpdir(), "herdr-notes-")); t.after(() => rm(home, { recursive: true, force: true }));
  let writes = Promise.resolve();
  const io = {
    read: async file => { try { return await readFile(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } },
    mkdir,
    write(file, text, expected) {
      const result = writes.catch(() => {}).then(async () => {
        if (await io.read(file) !== expected) throw new Error("stale snapshot");
        await writeFile(file, text, "utf8");
      }); writes = result; return result;
    },
  };
  return { home, io, client: createNotesClient(io, home) };
}

test("note scopes keep projects, explicit sessions and unknown terminal incarnations separate", () => {
  assert.equal(model.projectNoteScope({ root: "/project/main/" }).key, project.key);
  assert.notEqual(model.projectNoteScope({ root: "/project/main", on: "remote" }).key, project.key);
  assert.equal(model.projectNoteScope({ root: "relative" }), null);
  const id = "11111111-1111-4111-8111-111111111111";
  const a = model.sessionNoteScope({ provider: "codex", id, store: "/store", address: "t1", title: "Original" });
  const b = model.sessionNoteScope({ provider: "codex", id, store: "/store", address: "t2", title: "Renamed" });
  assert.equal(a.key, b.key);
  assert.notEqual(a.key, model.sessionNoteScope({ provider: "codex", id, store: "/other" }).key);
  const fresh = launch => model.sessionNoteScope({ provider: "codex", address: "t1", created: 100, launch });
  assert.notEqual(fresh("first").key, fresh("replacement").key);
  assert.equal(model.sessionNoteScope({ provider: "codex", key: '["terminal","t1",100]' }), null);
  assert.equal(model.sessionNoteScope({ provider: "zsh", address: "t1", created: 100, launch: "shell" }), null);
  assert(model.validNoteScope(a)); assert(model.validNoteScope(fresh("first"))); assert(model.validNoteScope(global));
});

test("saved notes retain three previous versions, archive without deletion and reject stale writes", () => {
  let value = note(empty(), project, "one");
  for (const text of ["two", "three", "four", "five"]) value = note(value.state, project, text, value.note.revision);
  assert.equal(value.note.versions.length, 3); assert.deepEqual(value.note.versions.map(version => version.body), ["four", "three", "two"]);
  const archived = model.updateNote(value.state, project, { title: "Goal", body: "five", archived: true }, value.note.revision);
  assert.equal(model.filterNotes(archived.state).length, 0);
  assert.equal(model.filterNotes(archived.state, "five", true)[0].body, "five");
  assert.equal(archived.state.notes.length, 1);
  assert.throws(() => note(archived.state, project, "overwrite", value.note.revision), error => error.code === "NOTE_CONFLICT");
  assert.equal(model.decodeNotes(model.encodeNotes(archived.state)).notes[0].body, "five");
});

test("capacity and UTF-8 bounds fail explicitly without removing notes or mutating the input", () => {
  let state = empty();
  for (let index = 0; index < model.NOTES_LIMITS.notes; index++) state = note(state, model.projectNoteScope({ root: `/project/${index}` }), "keep").state;
  const before = JSON.stringify(state);
  assert.throws(() => note(state, global, "new"), /limit/);
  assert.equal(JSON.stringify(state), before);
  assert.equal(model.utf8Size("abc中文😀"), Buffer.byteLength("abc中文😀"));
  assert.throws(() => note(empty(), global, "x".repeat(model.NOTES_LIMITS.body + 1)), /body characters/);
  let large = empty();
  for (let index = 0; index < 8; index++) large = note(large, model.projectNoteScope({ root: `/large/${index}` }), "中".repeat(35000)).state;
  const raw = JSON.stringify(large);
  assert.throws(() => note(large, global, "中".repeat(35000)), /size limit/);
  assert.equal(JSON.stringify(large), raw);
});

test("real note files survive client reopening and unrelated changes merge under atomic expected writes", async t => {
  const f = await files(t);
  assert.deepEqual(await f.client.load(), empty());
  assert.deepEqual(await readdir(f.home), []);
  const second = createNotesClient(f.io, f.home);
  await Promise.all([f.client.save(project, { title: "Project", body: "Decisions" }, 0), second.save(global, { title: "Global", body: "Checklist" }, 0)]);
  const state = await second.load(); assert.equal(state.notes.length, 2);
  assert.equal(model.noteFor(state, project).body, "Decisions");
  const savedRevision = model.noteFor(state, project).revision;
  await second.save(project, { title: "Project", body: "New decision" }, savedRevision);
  await assert.rejects(() => f.client.save(project, { title: "Wrong", body: "Old view" }, savedRevision), error => error.code === "NOTE_CONFLICT");
  assert.equal(model.noteFor(await f.client.load(), project).body, "New decision");
  assert((await readFile(f.client.file, "utf8")).includes("New decision"));
});

test("corrupt, unsupported and oversized storage is never overwritten", async t => {
  const f = await files(t); await mkdir(join(f.home, "data/workspace-notes"), { recursive: true });
  for (const raw of ["{broken", '{"schema":99,"notes":[]}', "x".repeat(model.NOTES_LIMITS.bytes + 1)]) {
    await writeFile(f.client.file, raw);
    await assert.rejects(() => f.client.save(global, { title: "New", body: "Must not replace old data" }, 0));
    assert.equal(await readFile(f.client.file, "utf8"), raw);
  }
});

test("recovery drafts are per view and context, never silently evicting another draft", () => {
  const first = { owner: "view1", scope: project, title: "One", body: "Unsaved", baseRevision: 1 };
  let drafts = model.keepNoteDraft([], first);
  drafts = model.keepNoteDraft(drafts, { ...first, owner: "view2", body: "Concurrent edit" });
  assert.equal(drafts.length, 2);
  assert.equal(model.decodeNoteDrafts(JSON.stringify(drafts))[1].body, "Concurrent edit");
  assert.equal(model.dropNoteDraft(drafts, "view1", project.key)[0].body, "Concurrent edit");
  let full = [];
  for (let index = 0; index < model.NOTES_LIMITS.drafts; index++) full = model.keepNoteDraft(full, { ...first, owner: `view${index}` });
  const raw = JSON.stringify(full);
  assert.throws(() => model.keepNoteDraft(full, { ...first, owner: "new-view" }), /full/);
  assert.equal(JSON.stringify(full), raw);
  assert.throws(() => model.decodeNoteDrafts("{broken"), /left unchanged/);
});

function element() {
  const node = { attributes: {}, events: {}, childNodes: [] };
  const proxy = new Proxy(node, { get(object, name) {
    if (name === "child") return child => { object.childNodes.push(child); return proxy; };
    if (name === "children") return children => { object.childNodes.push(...children); return proxy; };
    if (name === "when") return (condition, callback) => condition ? callback(proxy) : proxy;
    if (String(name).startsWith("on_")) return (...args) => { object.events[name] = args.at(-1); return proxy; };
    if (name in object) return object[name];
    return value => { object.attributes[name] = value; return proxy; };
  } }); return proxy;
}
const descendants = node => !node || typeof node !== "object" ? [] : [node, ...node.childNodes.flatMap(descendants)];
const find = (node, id) => descendants(node).find(item => item.attributes.id === id);
const source = readFileSync(new URL("../mods/sessions-plus/notes.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class");
function memoryStorage() { const values = new Map(); return { values, flushed: 0, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), async flush() { this.flushed++; } }; }
function harness({ disk = { raw: null }, storage = memoryStorage(), props = {}, failWrite = false, resolvedContext = { cwd: "/resolved-project", on: null } } = {}) {
  const tasks = [], timers = [], editors = [], inputs = [], overlays = [];
  let render = false, writes = 0, gate = null;
  const cx = { notify() { assert(!render, "render must not notify"); }, stop_propagation() {}, focus_handle: () => ({ focus() {} }), write_to_clipboard() {},
    timer: { after(ms, callback) { assert(!render); timers.push({ ms, callback }); } }, spawn(task) { tasks.push(task(cx)); } };
  const retained = options => {
    let text = options.value || ""; const handlers = {};
    return { options, value: () => text, set_value(value) { text = value; }, on(event, callback) { handlers[event] = callback; }, type(value) { text = value; handlers.change?.({}, cx); }, release() { this.released = true; } };
  };
  const deps = { ...model, createNotesClient, createNativeNotesClient: createNotesClient, exec: async () => { throw new Error("UI fixtures never start real helpers"); }, unlink: async () => {}, div: element, h_flex: element, v_flex: element, Input: { new: element }, Editor: { new: element },
    InputState: { new(options) { const state = retained(options); inputs.push(state); return state; } }, EditorState: { new(options) { const state = retained(options); editors.push(state); return state; } },
    localStorage: storage, appHome: () => "/app", theme: () => ({}), projectContext: () => resolvedContext, focused: () => ({ cwd: "/focus-changed" }), spaces: () => [], agents: () => [], terminals: () => [], panes: () => [], promptTargets: () => [],
    shared: () => null, setShared() { assert(!render); }, openOverlay: spec => overlays.push(spec), closeOverlay() {}, mkdir: async () => {},
    readTextFile: async () => disk.raw,
    writeTextFile: async (_file, value, expected) => { if (gate) await gate; if (failWrite) throw new Error("Disk denied"); if (disk.raw !== expected) throw new Error("stale"); disk.raw = value; writes++; },
  };
  const Class = uiFunction(...Object.keys(deps), source)(...Object.values(deps));
  const view = new Class(); view.init({ project: { root: "/project/main" }, ...props }, cx);
  return { view, cx, storage, disk, editors, inputs, timers, overlays, writes: () => writes,
    setGate(value) { gate = value; }, render() { render = true; try { return view.render(cx); } finally { render = false; } },
    async settle() { for (let round = 0; round < 8; round++) await Promise.all(tasks.splice(0)); },
    fireTimers() { const pending = timers.splice(0); for (const timer of pending) timer.callback(cx); },
    click(id) { const item = find(this.render(), id); assert(item, `missing ${id}`); item.events.on_click({}, cx); } };
}

test("native role captures its context and switching preserves unfinished drafts", async () => {
  const f = harness(); await f.settle();
  f.editors[0].type("Project decision"); assert.equal(f.view.scope.key, project.key);
  assert.equal(model.decodeNoteDrafts(f.storage.getItem(model.NOTES_DRAFTS))[0].body, "Project decision");
  f.view.choose(global, f.cx); await f.settle(); f.fireTimers(); await f.settle();
  assert.equal(f.writes(), 0, "the old timer cannot save into another scope");
  f.view.choose(project, f.cx); await f.settle();
  assert.equal(f.editors[0].value(), "Project decision");
  f.view.save(f.cx); await f.settle();
  assert.equal(model.noteFor(model.decodeNotes(f.disk.raw), project).body, "Project decision");
  assert.equal(f.storage.getItem(model.NOTES_DRAFTS), null);
  f.render();
});

test("closing and reopening retains the unsaved text until explicit recovery", async () => {
  const f = harness(); await f.settle(); f.editors[0].type("Before close"); await f.view.close();
  assert.equal(f.storage.flushed, 1); assert.equal(f.editors[0].released, true);
  const g = harness({ storage: f.storage, disk: f.disk }); await g.settle();
  assert.equal(g.editors[0].value(), "");
  const recovered = model.decodeNoteDrafts(g.storage.getItem(model.NOTES_DRAFTS))[0];
  g.view.restoreDraft(recovered, g.cx); assert.equal(g.editors[0].value(), "Before close");
  g.view.save(g.cx); await g.settle(); assert.equal(model.noteFor(model.decodeNotes(g.disk.raw), project).body, "Before close");
});

test("notes retain save status while fixed storage guidance lives in Refresh's tooltip", async () => {
  const f = harness(); await f.settle();
  const text = node => typeof node === "string" ? node : node?.childNodes?.map(text).join("\n") || "";
  let tree = f.render();
  assert.match(find(tree, "notes-refresh").attributes.tooltip, /Closing a tab keeps its notes.*last three saved versions/);
  assert.doesNotMatch(text(tree), /Saved on this computer|last three saved versions/);
  f.editors[0].type("Unsaved decision"); tree = f.render();
  assert.match(text(tree), /Unsaved changes/); assert.match(text(tree), /characters/);
});

test("concurrent views never overwrite the other's saved note and retain conflict text", async () => {
  const disk = { raw: null }, storage = memoryStorage(), f = harness({ disk, storage }), g = harness({ disk, storage });
  await Promise.all([f.settle(), g.settle()]);
  f.editors[0].type("First view"); f.view.save(f.cx); await f.settle();
  g.editors[0].type("Second view"); g.view.save(g.cx); await g.settle();
  assert.equal(g.view.conflict, true); assert.equal(g.editors[0].value(), "Second view");
  assert.equal(model.noteFor(model.decodeNotes(disk.raw), project).body, "First view");
  assert(model.decodeNoteDrafts(storage.getItem(model.NOTES_DRAFTS)).some(draft => draft.body === "Second view"));
  g.click("notes-reload"); assert.equal(g.editors[0].value(), "Second view");
  g.click("notes-reload"); await g.settle(); assert.equal(g.editors[0].value(), "First view");
});

test("typing during an asynchronous save remains dirty and is saved against the acknowledged revision", async () => {
  const f = harness(); await f.settle(); let release;
  f.setGate(new Promise(resolve => { release = resolve; }));
  f.editors[0].type("First snapshot"); f.view.save(f.cx);
  await Promise.resolve(); await Promise.resolve();
  f.editors[0].type("Typed while saving"); release(); await f.settle();
  assert.equal(model.noteFor(model.decodeNotes(f.disk.raw), project).body, "First snapshot");
  assert.equal(f.editors[0].value(), "Typed while saving");
  assert(model.decodeNoteDrafts(f.storage.getItem(model.NOTES_DRAFTS)).some(draft => draft.body === "Typed while saving"));
  f.setGate(null); f.fireTimers(); await f.settle();
  assert.equal(model.noteFor(model.decodeNotes(f.disk.raw), project).body, "Typed while saving");
});

test("write and load errors preserve recovery data and do not create retry loops", async () => {
  const f = harness({ failWrite: true }); await f.settle(); f.editors[0].type("Keep after error");
  f.fireTimers(); await f.settle(); assert.match(f.view.error, /Disk denied/); assert.equal(f.timers.length, 0);
  assert(model.decodeNoteDrafts(f.storage.getItem(model.NOTES_DRAFTS)).some(draft => draft.body === "Keep after error"));
  f.disk.raw = "{corrupt"; f.view.choose(global, f.cx); await f.settle();
  assert.equal(f.view.loadFailed, true);
  await f.view.close();
  assert(!model.decodeNoteDrafts(f.storage.getItem(model.NOTES_DRAFTS)).some(draft => draft.scope.key === global.key));
  assert.equal(f.disk.raw, "{corrupt");
});

test("notes search includes closed contexts, archive is reversible, and queue handoff only opens a preview", async () => {
  const f = harness(); await f.settle(); f.editors[0].type("Decision to carry forward"); f.view.save(f.cx); await f.settle();
  f.view.save(f.cx, true); await f.settle(); assert.equal(model.filterNotes(f.view.store).length, 0);
  assert.equal(model.filterNotes(f.view.store, "carry", true).length, 1);
  f.view.save(f.cx, false); await f.settle(); assert.equal(model.filterNotes(f.view.store).length, 1);
  f.click("notes-queue"); assert.equal(f.overlays[0].props.role, "prompt-queue");
  assert.match(f.overlays[0].props.text, /Decision to carry forward/); assert.equal(f.overlays[0].props.on, null);
  f.view.choose(global, f.cx); await f.settle(); f.click("notes-all");
  assert(find(f.render(), "notes-entry-" + project.key));
});


test("recovery adoption works even at the draft limit and search finds drafts for an existing saved note", async () => {
  const f = harness(); await f.settle(); f.editors[0].type("Saved baseline"); f.view.save(f.cx); await f.settle();
  const otherScopes = Array.from({ length: model.NOTES_LIMITS.drafts }, (_, index) => ({ owner: `old-${index}`, scope: index === 0 ? project : model.projectNoteScope({ root: `/closed/${index}` }), title: "Closed draft", body: index === 0 ? "only-in-recovery keyword" : "Keep text", baseRevision: index === 0 ? 1 : 0 }));
  f.storage.setItem(model.NOTES_DRAFTS, JSON.stringify(otherScopes));
  f.view.restoreDraft(otherScopes[0], f.cx);
  assert.equal(f.editors[0].value(), "only-in-recovery keyword");
  assert.equal(model.decodeNoteDrafts(f.storage.getItem(model.NOTES_DRAFTS)).length, model.NOTES_LIMITS.drafts);
  assert(!model.decodeNoteDrafts(f.storage.getItem(model.NOTES_DRAFTS)).some(draft => draft.owner === "old-0"));
  f.click("notes-all"); f.inputs[1].type("only-in-recovery keyword");
  assert(find(f.render(), `notes-unsaved-${f.view.owner}-${project.key}`));
  assert(!find(f.render(), "notes-entry-" + project.key), "saved body does not contain the recovery search term");
});


test("explicit archived removal frees capacity and monotonic revisions reject old views after recreation", () => {
  let saved = note(empty(), project, "Original");
  saved = model.updateNote(saved.state, project, { title: project.label, body: "Updated", archived: true }, saved.note.revision);
  const previous = saved.note.revision;
  assert(saved.note.versions.length > 0);
  saved = model.updateNote(saved.state, project, { title: project.label, body: "Updated", clearVersions: true }, previous);
  assert.equal(saved.note.versions.length, 0);
  const removed = model.removeArchivedNote(saved.state, project, saved.note.revision);
  assert.equal(removed.state.notes.length, 0);
  const recreated = note(removed.state, project, "Recovered latest text");
  assert(recreated.note.revision > saved.note.revision);
  assert.throws(() => note(recreated.state, project, "Late stale writer", saved.note.revision), error => error.code === "NOTE_CONFLICT");
  assert.throws(() => model.removeArchivedNote(recreated.state, project, recreated.note.revision), /Archive/);
});

test("native capacity controls require confirmation and preserve removed text as a recoverable draft", async () => {
  const f = harness(); await f.settle(); f.editors[0].type("First"); f.view.save(f.cx); await f.settle();
  f.editors[0].type("Second"); f.view.save(f.cx); await f.settle();
  assert.equal(f.view.note.versions.length, 1);
  const writes = f.writes(); f.click("notes-clear-versions"); await f.settle(); assert.equal(f.writes(), writes);
  f.click("notes-clear-versions"); await f.settle(); assert.equal(f.view.note.versions.length, 0);
  assert.equal(f.view.note.body, "Second");
  f.click("notes-archive"); await f.settle(); const oldRevision = f.view.note.revision;
  f.click("notes-remove"); await f.settle(); assert.equal(f.view.store.notes.length, 1);
  f.click("notes-remove"); await f.settle(); assert.equal(f.view.store.notes.length, 0);
  const recovery = model.decodeNoteDrafts(f.storage.getItem(model.NOTES_DRAFTS)).find(draft => draft.body === "Second");
  assert(recovery); assert.equal(recovery.baseRevision, 0);
  f.view.restoreDraft(recovery, f.cx); f.view.save(f.cx); await f.settle();
  assert.equal(f.view.note.body, "Second"); assert(f.view.note.revision > oldRevision);
});


test("explicit Save can persist a new edit when recovery capacity is full, without evicting old drafts", async () => {
  const storage = memoryStorage();
  const drafts = Array.from({ length: model.NOTES_LIMITS.drafts }, (_, index) => ({ owner: `full-${index}`, scope: model.projectNoteScope({ root: `/draft/${index}` }), title: "Kept", body: "Original draft", baseRevision: 0 }));
  storage.setItem(model.NOTES_DRAFTS, JSON.stringify(drafts));
  const f = harness({ storage }); await f.settle();
  f.editors[0].type("Current edit");
  assert.match(f.view.error, /recovery is full/);
  f.view.save(f.cx); await f.settle();
  assert.equal(model.noteFor(model.decodeNotes(f.disk.raw), project).body, "Current edit");
  assert.deepEqual(model.decodeNoteDrafts(storage.getItem(model.NOTES_DRAFTS)), drafts);
});


test("direct notes role captures the shared project resolver machine and folder", async () => {
  const resolvedContext = { cwd: "/remote/selected-project", on: "remote-host" };
  const f = harness({ props: { project: null }, resolvedContext }); await f.settle();
  const captured = model.projectNoteScope({ root: "/remote/selected-project", on: "remote-host" });
  assert.deepEqual(f.view.scope, captured);
  resolvedContext.cwd = "/different-focused-folder"; resolvedContext.on = null;
  f.editors[0].type("Captured remote project note"); f.view.save(f.cx); await f.settle();
  assert.equal(model.noteFor(model.decodeNotes(f.disk.raw), captured).body, "Captured remote project note");
  assert.equal(f.view.scope.on, "remote-host");
});
