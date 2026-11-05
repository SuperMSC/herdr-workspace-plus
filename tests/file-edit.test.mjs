import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as previewModel from "../mods/files-plus/preview-model.js";
import * as editorModel from "../mods/files-plus/editor-model.js";

function element() {
  const node = { childNodes: [], attrs: {}, events: {} };
  const proxy = new Proxy(node, { get(object, key) {
    if (key === "child") return child => { node.childNodes.push(child); return proxy; };
    if (key === "children") return children => { node.childNodes.push(...children); return proxy; };
    if (key === "when") return (condition, callback) => condition ? callback(proxy) : proxy;
    if (key in object) return object[key];
    if (key.startsWith("on_")) return (...args) => { node.events[key] = args.at(-1); return proxy; };
    return value => { node.attrs[key] = value; return proxy; };
  } });
  return proxy;
}
const nodes = node => !node || typeof node !== "object" ? [] : [node, ...node.childNodes.flatMap(nodes)];
const find = (tree, id) => nodes(tree).find(node => node.attrs.id === id);
const texts = tree => nodes(tree).flatMap(node => node.childNodes.filter(child => typeof child === "string"));
const source = readFileSync(new URL("../mods/files-plus/preview.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace("export default class", "return class");

function harness({ disk = "one\n", draft = null } = {}) {
  const files = { "/r/a.txt": disk }, writes = [], drafts = [], dropped = [], editors = [], state = new Map(), tasks = [], timers = [], clipboard = [];
  let rendering = false, failNextWrite = false;
  const cx = { notify() { assert(!rendering, "render must never notify"); }, stop_propagation() {}, write_to_clipboard: text => clipboard.push(text),
    spawn(task) { tasks.push(task(cx)); }, timer: { after(_ms, task) { timers.push(task); }, every() {} }, focus_handle: () => ({ focus() {} }) };
  const deps = { ...previewModel, ...editorModel,
    div: element, image: element, svg: element, h_flex: element, v_flex: element, Editor: { new: element }, TextView: { markdown: element },
    EditorState: { new: options => { let value = options.value; const events = {}; const state = { options, value: () => value, set_value(next) { value = next; }, on(name, callback) { events[name] = callback; }, type(next) { value = next; events.change?.({}, cx); }, release() { this.released = true; } }; editors.push(state); return state; } },
    FileFind: class { constructor() { this.handle = { focus() {} }; this.visible = false; this.result = { matches: [] }; } clear() { this.visible = false; } setText() {} key() {} close() {} },
    exec: async () => ({ code: 0, stdout: JSON.stringify({ kind: "source", signature: "s1", text: files["/r/a.txt"] ?? "", truncated: false }) }),
    appHome: () => "/home", theme: () => ({ working: "#f90", blocked: "#f00", done: "#0f0" }), settings: () => ({}),
    shared: key => state.get(key), setShared(key, value) { assert(!rendering, "render must never write shared state"); state.set(key, value); },
    readTextFile: async path => files[path] ?? null,
    writeTextFile: async (path, text, expected) => {
      if (failNextWrite || (files[path] ?? null) !== expected) { failNextWrite = false; throw new Error("stale"); }
      files[path] = text; writes.push({ path, text, expected });
    },
    loadDraft: async () => draft, keepDraft: async (root, path, text, base) => { drafts.push({ root, path, text, base }); }, dropDraft: async (root, path) => { dropped.push(path); } };
  const Preview = new Function(...Object.keys(deps), source)(...Object.values(deps));
  return { cx, Preview, files, writes, drafts, dropped, editors, state, timers, clipboard,
    failWrite() { failNextWrite = true; },
    render(view) { rendering = true; try { return view.render(cx); } finally { rendering = false; } },
    async settle() { for (let i = 0; i < 5; i++) await Promise.all(tasks.splice(0)); },
    click(view, id) { const node = find(this.render(view), id); assert(node, `missing ${id}`); node.events.on_click({}, cx); } };
}

async function editing(f, options = {}) {
  const view = new f.Preview({ editable: true, id: "preview-1", ...options });
  view.open("/r", "a.txt", null, f.cx); await f.settle();
  f.click(view, "preview-edit"); await f.settle();
  return view;
}

test("editing rules: local whole text files only, CRLF is kept, drafts round-trip", () => {
  assert.equal(editorModel.editBlocker({ text: "x" }, null), null);
  assert.match(editorModel.editBlocker({ text: "x" }, "box"), /this computer/);
  assert.match(editorModel.editBlocker({ text: "x", truncated: true }, null), /400 KB/);
  assert.match(editorModel.editBlocker({ kind: "image" }, null), /no text/);
  assert.equal(editorModel.textToSave("a\nb\n", "x\r\ny\r\n"), "a\r\nb\r\n");
  assert.equal(editorModel.textToSave("a\nb", "x\ny"), "a\nb");
  assert.equal(editorModel.isDirty("a\nb\n", "a\r\nb\r\n"), false);
  assert.equal(editorModel.isDirty("a", "b"), true);
  const name = editorModel.draftName("/r", "src/My File.py");
  assert.match(name, /^My_File\.py-[0-9a-f]{16}\.json$/); assert.equal(name, editorModel.draftName("/r", "src/My File.py"));
  assert.notEqual(name, editorModel.draftName("/r2", "src/My File.py"));
  const raw = editorModel.writeDraft("/r", "a.txt", "new", "old", 5);
  assert.deepEqual(editorModel.readDraft(raw, "/r", "a.txt"), { root: "/r", path: "a.txt", text: "new", base: "old", saved: 5 });
  assert.equal(editorModel.readDraft(raw, "/r", "b.txt"), null); assert.equal(editorModel.readDraft("{bad", "/r", "a.txt"), null);
  assert.equal(editorModel.draftAge(0, 30000), "just now"); assert.equal(editorModel.draftAge(0, 5 * 60000), "5 min ago");
});

test("Edit starts from the file on disk, marks unsaved changes, keeps a draft, and ⌘S saves only over what was read", async () => {
  const f = harness(), view = await editing(f), editor = f.editors.at(-1);
  assert.equal(view.editing, true); assert.equal(editor.options.readonly, false); assert.equal(editor.value(), "one\n");
  editor.type("two\n");
  assert.equal(f.state.get(editorModel.DIRTY_KEY)["preview-1"], true);
  assert(texts(f.render(view)).includes("Unsaved changes"));
  f.timers.splice(0).forEach(timer => timer(f.cx)); await f.settle();
  assert.deepEqual(f.drafts.at(-1), { root: "/r", path: "a.txt", text: "two\n", base: "one\n" });
  f.render(view).events.on_key_down({ key: "s", modifiers: { platform: true } }, f.cx); await f.settle();
  assert.deepEqual(f.writes, [{ path: "/r/a.txt", text: "two\n", expected: "one\n" }]);
  assert.equal(view.status, "Saved"); assert.equal(view.dirty(), false);
  assert.equal(f.state.get(editorModel.DIRTY_KEY)["preview-1"], undefined); assert(f.dropped.includes("a.txt"));
});

test("a save over someone else's change writes nothing, keeps the edits, and overwrites only after a second click", async () => {
  const f = harness(), view = await editing(f), editor = f.editors.at(-1);
  editor.type("mine\n"); f.files["/r/a.txt"] = "theirs\n";
  f.click(view, "preview-edit-save"); await f.settle();
  assert.equal(f.writes.length, 0); assert.equal(view.conflict.disk, "theirs\n"); assert.equal(editor.value(), "mine\n");
  f.click(view, "preview-conflict-copy"); assert.deepEqual(f.clipboard, ["mine\n"]);
  f.click(view, "preview-conflict-overwrite"); await f.settle(); assert.equal(f.writes.length, 0);
  f.click(view, "preview-conflict-overwrite"); await f.settle();
  assert.deepEqual(f.writes, [{ path: "/r/a.txt", text: "mine\n", expected: "theirs\n" }]); assert.equal(view.conflict, null);
});

test("Windows line endings survive an edit", async () => {
  const f = harness({ disk: "a\r\nb\r\n" }), view = await editing(f);
  f.editors.at(-1).type("a\nc\n");
  f.click(view, "preview-edit-save"); await f.settle();
  assert.equal(f.files["/r/a.txt"], "a\r\nc\r\n");
});

test("while editing, a refresh never replaces typed text; an untouched editor follows the disk", async () => {
  const f = harness(), view = await editing(f), editor = f.editors.at(-1);
  f.files["/r/a.txt"] = "changed\n"; view.refresh(f.cx); await f.settle();
  assert.equal(editor.value(), "changed\n"); assert.equal(view.external, false);
  editor.type("typed\n"); f.files["/r/a.txt"] = "again\n"; view.refresh(f.cx); await f.settle();
  assert.equal(editor.value(), "typed\n"); assert.equal(view.external, true);
  assert(find(f.render(view), "preview-external-reload"));
});

test("Done asks before discarding edits; a kept draft offers Restore when the file opens again", async () => {
  const f = harness(), view = await editing(f);
  f.editors.at(-1).type("draft text\n");
  f.click(view, "preview-edit-done"); assert.equal(view.editing, true);
  f.click(view, "preview-edit-done"); await f.settle(); assert.equal(view.editing, false); assert.equal(f.files["/r/a.txt"], "one\n");
  const g = harness({ draft: { root: "/r", path: "a.txt", text: "draft text\n", base: "one\n", saved: Date.now() } });
  const reopened = new g.Preview({ editable: true, id: "p2" }); reopened.open("/r", "a.txt", null, g.cx); await g.settle();
  assert(texts(g.render(reopened)).some(text => text.startsWith("Unsaved edits from")));
  g.click(reopened, "preview-draft-restore"); await g.settle();
  assert.equal(reopened.editing, true); assert.equal(g.editors.at(-1).value(), "draft text\n"); assert.equal(reopened.external, false);
});

test("search previews, remote files and cut-short files stay read only", async () => {
  const f = harness(), search = new f.Preview(); search.open("/r", "a.txt", null, f.cx); await f.settle();
  assert(!find(f.render(search), "preview-edit"));
  const remote = new f.Preview({ editable: true }); remote.open("/r", "a.txt", "box", f.cx); await f.settle();
  assert(!find(f.render(remote), "preview-edit"));
});
