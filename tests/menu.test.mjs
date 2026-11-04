import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { targetFor, localActions, menuItems, menuHeight, copyValue, creationFolder, applyPathChange, CHANGE_KEY, SHOW_HIDDEN_KEY, visibleEntry } from "../mods/files-plus/model.js";
import { validateName } from "../mods/files-plus/filesystem.js";

globalThis.window = { viewport_size: () => ({ width: 1280, height: 800 }) };
const root = "/projects/demo";
const file = () => targetFor(root, "src/my file.js", false, null, "macos");

// Exercise the real view event handlers with lightweight native-UI substitutes.
function element() {
  const node = { events: {}, childNodes: [] };
  let proxy;
  proxy = new Proxy(node, { get(object, name) {
    if (name in object) return object[name];
    if (name === "child") return child => { node.childNodes.push(child); return proxy; };
    if (name === "children") return children => { node.childNodes.push(...children); return proxy; };
    if (name === "when") return (condition, callback) => condition ? callback(proxy) : proxy;
    if (name === "id") return value => { node.idValue = value; return proxy; };
    if (name.startsWith("on_")) return (...args) => { node.events[`${name}:${args.length > 1 ? args[0] : ""}`] = args.at(-1); return proxy; };
    return () => proxy;
  }});
  return proxy;
}

function view(name, dependencies) {
  const source = readFileSync(new URL(`../mods/files-plus/${name}.js`, import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace("export function changed", "function changed")
    .replace("export default class", "return class");
  return new Function(...Object.keys(dependencies), source)(...Object.values(dependencies));
}

function context() {
  const tasks = [];
  const clipboard = [];
  let stopped = false;
  const cx = { focus_handle: () => ({ focus() {} }), notify() {},
    stop_propagation() { stopped = true; },
    write_to_clipboard(value) { clipboard.push(value); },
    spawn(callback) { tasks.push(callback(cx)); } };
  return { cx, tasks, clipboard, stopped: () => stopped };
}

function menuHarness(target) {
  const overlays = [], closed = [], changes = [], executions = [];
  let state;
  const Menu = view("menu", { div: element, v_flex: element, h_flex: element,
    closeOverlay: id => closed.push(id), openOverlay: value => overlays.push(value), theme: () => ({}),
    exec: (...args) => executions.push(args), shared: () => state, setShared: (_key, value) => { state = value; changes.push(value); },
    createFilesystem: () => ({ reveal: async path => executions.push(["reveal", path]) }),
    createGitActions: () => ({ stage: async path => executions.push(["stage", path]), unstage: async path => executions.push(["unstage", path]) }),
    settings: () => ({ zoom: 1 }), CHANGE_KEY, SHOW_HIDDEN_KEY, menuItems, menuHeight, copyValue, localActions, parentPath: path => path.slice(0, path.lastIndexOf("/")) || "/" });
  const env = context(), menu = new Menu();
  menu.init({ target, overlay: "menu1" }, env.cx);
  return { ...env, menu, overlays, closed, changes, executions };
}

test("targets preserve punctuation, backslashes and platform roots", () => {
  const target = targetFor(root, "a\\b ' $` name.txt", false, null, "macos");
  assert.equal(target.name, "a\\b ' $` name.txt");
  assert.equal(copyValue("copyRelative", target), "a\\b ' $` name.txt");
  assert.equal(targetFor("/", "x", false, null, "macos").path, "/x");
  assert.equal(targetFor("C:\\", "a.txt", false, null, "windows").path, "C:/a.txt");
  assert.equal(targetFor("/a\\b", "", true, null, "macos").name, "a\\b");
  assert.equal(targetFor("/tmp/project\\", "a", false, null, "macos").path, "/tmp/project\\/a");
  assert.equal(copyValue("copyRelative", targetFor(root)), ".");
});

test("remote and non-Mac menus expose only copy and refresh", () => {
  for (const target of [targetFor(root, "x", false, "server", "macos"), targetFor(root, "x", false, null, "linux"), targetFor(root, "x", false, null, "windows")]) {
    assert.deepEqual(menuItems(target).map(item => item.id), ["copyPath", "copyRelative", "copyName", "refresh"]);
  }
  assert(!menuItems(targetFor(root, "", true, null, "macos")).some(item => ["rename", "trash"].includes(item.id)));
  assert(menuHeight(file()) <= 450);
});

test("new items go inside a selected folder or beside a selected file", () => {
  assert.equal(creationFolder(file()), `${root}/src`);
  assert.equal(creationFolder(targetFor(root, "src", true, null, "macos")), `${root}/src`);
  assert.equal(creationFolder(targetFor("/", "file", false, null, "macos")), "/");
});

test("copy and rename use the captured target, without running programs", () => {
  const env = menuHarness(file());
  env.menu.choose(env.menu.items.findIndex(item => item.id === "copyPath"), env.cx);
  assert.deepEqual(env.clipboard, [`${root}/src/my file.js`]);
  assert.deepEqual(env.closed, ["menu1"]);
  assert.equal(env.executions.length, 0);
  const next = menuHarness(file());
  next.menu.choose(next.menu.items.findIndex(item => item.id === "rename"), next.cx);
  assert.deepEqual(next.overlays[0].props.target, file());
  assert.equal(next.overlays[0].props.action, "rename");
  assert.equal(next.overlays[0].modal, true);
  assert.equal(next.executions.length, 0);
});

test("menu keyboard selection runs the selected action and stops propagation", () => {
  const env = menuHarness(targetFor(root, "x", false, "server", "macos"));
  const key = env.menu.render().events["on_key_down:"];
  key({ key: "down" }, env.cx);
  key({ key: "enter" }, env.cx);
  assert.deepEqual(env.clipboard, ["x"]);
  assert(env.stopped());
});

test("rename and trash remap exact descendants without matching sibling prefixes", () => {
  const target = targetFor(root, "src", true, null, "macos");
  const change = { target, action: "rename", name: "lib" };
  assert.equal(applyPathChange("src/my file.js", change), "lib/my file.js");
  assert.equal(applyPathChange("src-old/file", change), "src-old/file");
  assert.equal(applyPathChange("src/file", { ...change, action: "trash" }), null);
  assert.equal(applyPathChange(null, change), null);
});

function dialogHarness(target, action, operation) {
  const closed = [], calls = [], changes = [];
  const Dialog = view("dialog", { div: element, v_flex: element, h_flex: element,
    Input: { new: element }, InputState: { new: () => ({ on() {}, focus() {} }) },
    closeOverlay: id => closed.push(id), exec() {}, theme: () => ({}), validateName,
    createFilesystem: () => ({ [action]: async (...args) => { calls.push(args); return operation?.(); } }),
    createGitActions: () => ({ [action]: async (...args) => { calls.push(args); return operation?.(); } }),
    localActions, creationFolder, changed: (...args) => changes.push(args) });
  const env = context(), dialog = new Dialog();
  dialog.init({ target, action, overlay: "dialog1" }, env.cx);
  return { ...env, dialog, closed, calls, changes };
}

test("dialogs refuse remote mutation, root trash and traversal names before exec", async () => {
  for (const [target, action, text] of [
    [targetFor(root, "x", false, "remote", "macos"), "rename", "y"],
    [targetFor(root, "", true, null, "macos"), "trash", ""],
    [file(), "createFile", "../escape"],
  ]) {
    const env = dialogHarness(target, action);
    env.dialog.text = text;
    env.dialog.submit(env.cx);
    await Promise.all(env.tasks);
    assert(env.dialog.error);
    assert.equal(env.calls.length, 0);
    assert.equal(env.closed.length, 0);
  }
});

test("submit captures the name and blocks double submission until completion", async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const env = dialogHarness(file(), "rename", () => pending);
  env.dialog.text = "new.js";
  env.dialog.submit(env.cx);
  env.dialog.text = "changed-after-submit.js";
  env.dialog.submit(env.cx);
  assert.deepEqual(env.calls, [[file().path, "new.js"]]);
  resolve();
  await Promise.all(env.tasks);
  assert.deepEqual(env.changes, [[file(), "rename", "new.js"]]);
  assert.deepEqual(env.closed, ["dialog1"]);
});

test("filesystem failure stays visible, preserves the dialog, and does not broadcast success", async () => {
  const env = dialogHarness(file(), "rename", () => { throw new Error("Destination already exists"); });
  env.dialog.text = "existing.js";
  env.dialog.submit(env.cx);
  await Promise.all(env.tasks);
  assert.match(env.dialog.error, /already exists/);
  assert.equal(env.dialog.busy, false);
  assert.equal(env.closed.length, 0);
  assert.equal(env.changes.length, 0);
});

test("busy dialogs consume Escape without closing an operation in progress", () => {
  const env = dialogHarness(file(), "rename");
  env.dialog.busy = true;
  env.dialog.render().events["on_key_down:"]({ key: "escape" }, env.cx);
  assert(env.stopped());
  assert.equal(env.closed.length, 0);
});

test("Changes offers stage/unstage from each index/worktree state", () => {
  const ids = xy => menuItems({ ...file(), kind: "changes", xy }).map(item => item.id);
  assert(ids("??").includes("stage"));
  assert(!ids("??").includes("unstage"));
  assert(ids(" M").includes("stage"));
  assert(!ids(" M").includes("unstage"));
  assert(ids("M ").includes("unstage"));
  assert(!ids("M ").includes("stage"));
  assert(ids("MM").includes("stage") && ids("MM").includes("unstage"));
  assert.equal(menuItems({ ...file(), kind: "changes", xy: "UU" }).find(item => item.id === "stage").label, "Stage Resolution");
});

test("Changes stage transfers the captured target to a modal task", async () => {
  const target = { ...file(), kind: "changes", xy: " M" };
  const env = menuHarness(target);
  env.menu.choose(env.menu.items.findIndex(item => item.id === "stage"), env.cx);
  assert.equal(env.overlays[0].modal, true);
  assert.deepEqual(env.overlays[0].props.target, target);
  assert.equal(env.executions.length, 0);
  const task = dialogHarness(target, "stage");
  await Promise.all(task.tasks);
  assert.deepEqual(task.calls, [["src/my file.js"]]);
  assert.equal(task.changes[0][0].root, root);
  assert.equal(task.changes[0][1], "stage");
});

test("deleted Changes hide Open and reveal the parent folder", async () => {
  const env = menuHarness({ ...file(), kind: "changes", xy: " D", deleted: true });
  assert(!env.menu.items.some(item => item.id === "open"));
  env.menu.choose(env.menu.items.findIndex(item => item.id === "reveal"), env.cx);
  await Promise.all(env.tasks);
  assert.deepEqual(env.executions, [["reveal", `${root}/src`]]);
});

function browserHarness({ readTextFile = async () => "", exec = async () => ({ code: 0, stdout: "" }), change } = {}) {
  const location = { cwd: root, on: null, space: "s" };
  const Browser = view("browser", { div: element, svg: element, v_flex: element, h_flex: element,
    Editor: { new: element }, EditorState: { new: options => ({ ...options, release() {} }) },
    spaces: () => [{ active: true, id: "s", folder: root }], panes: () => [], focused: () => ({ pane: null, terminal: "t1", cwd: root }),
    exec, readTextFile, watchFolder() {}, theme: () => ({}), settings: () => ({}), window: () => ({ platform: "macos" }),
    openOverlay() {}, shared: () => change, CHANGE_KEY, SHOW_HIDDEN_KEY, visibleEntry, targetFor, menuHeight, applyPathChange });
  const browser = new Browser();
  Object.assign(browser, { context: { ...location, key: JSON.stringify(location) }, root, on: null,
    entries: new Map(), folders: new Set(), pending: new Set(), folderRequests: new Map() });
  return { browser, ...context() };
}

test("rename invalidates old directory counts and pending reads, and refreshes previews", () => {
  const change = { revision: 2, target: targetFor(root, "src", true, null, "macos"), action: "rename", name: "lib" };
  const env = browserHarness({ change });
  const oldContext = env.browser.context;
  env.browser.entries.set("src", Array(500).fill({ name: "old" }));
  env.browser.folders.add("src");
  env.browser.file = "src/my file.js";
  env.browser.loading = true;
  let shown, refresh = 0;
  env.browser.show = path => { shown = path; };
  env.browser.refresh = () => { refresh++; };
  env.browser.consumeChange(env.cx);
  assert.notEqual(env.browser.context, oldContext);
  assert.equal(env.browser.entries.size, 0);
  assert.deepEqual([...env.browser.folders], ["lib"]);
  assert.equal(shown, "lib/my file.js");
  assert.equal(refresh, 1);
});

test("late same-path preview response cannot replace the newest preview", async () => {
  const pending = [];
  const env = browserHarness({ readTextFile: () => new Promise(resolve => pending.push(resolve)) });
  env.browser.show("a.txt", env.cx);
  env.browser.show("a.txt", env.cx);
  pending[1]("newest");
  await env.tasks[1];
  pending[0]("old");
  await env.tasks[0];
  assert.equal(env.browser.code.value, "newest");
});

test("late folder load cannot overwrite a newer refresh", async () => {
  const pending = [];
  const env = browserHarness({ exec: () => new Promise(resolve => pending.push(resolve)) });
  const first = env.browser.loadFolder("", env.browser.context);
  const second = env.browser.loadFolder("", env.browser.context);
  pending[1]({ code: 0, stdout: "f\0new.txt\0" });
  await second;
  pending[0]({ code: 0, stdout: "f\0old.txt\0" });
  await first;
  assert.equal(env.browser.entries.get("")[0].name, "new.txt");
});
