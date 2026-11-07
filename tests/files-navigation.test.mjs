import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import * as library from "../mods/files-plus/library-model.js";
import * as model from "../mods/files-plus/model.js";
import { iconName } from "../mods/files-plus/icon-model.js";

test("recent files and pins survive serialization, deduplicate and stay scoped to machine and project", () => {
  let state = library.updateLibrary(null, "/one", null, "open", "src/main.py");
  state = library.updateLibrary(state, "/one", null, "pin", "src/main.py");
  state = library.updateLibrary(state, "/one", "server", "open", "remote.py");
  state = JSON.parse(JSON.stringify(state));
  assert.deepEqual(library.libraryFor(state, "/one", null), { recent: ["src/main.py"], pinned: ["src/main.py"] });
  assert.deepEqual(library.libraryFor(state, "/two", null), { recent: [], pinned: [] });
  for (let i = 0; i < 30; i++) state = library.updateLibrary(state, "/one", null, "open", `${i}.py`);
  state = library.updateLibrary(state, "/one", null, "open", "15.py");
  assert.equal(library.libraryFor(state, "/one").recent.length, 20);
  assert.equal(library.libraryFor(state, "/one").recent[0], "15.py");
  assert.deepEqual(library.libraryFor(state, "/one", "server").recent, ["remote.py"]);
  state = library.updateLibrary(state, "/one", null, "forget", "15.py");
  assert(!library.libraryFor(state, "/one").recent.includes("15.py"));
});

test("state is bounded and corrupt or escaping history entries are discarded", () => {
  let state;
  for (let i = 0; i < 55; i++) state = library.updateLibrary(state, `/project-${i}`, null, "pin", "a.py", i);
  assert.equal(Object.keys(state.projects).length, 40);
  assert(!state.projects[library.projectKey("/project-0")]);
  for (let i = 0; i < 50; i++) state = library.updateLibrary(state, "/pins", null, "pin", `${i}.py`);
  assert.equal(library.libraryFor(state, "/pins").pinned.length, 40);
  assert.equal(library.updateLibrary(state, "/pins", null, "open", "../outside"), state);
  assert.deepEqual(library.libraryFor({ projects: { [library.projectKey("/bad")]: { recent: ["a", "a", null, "/outside", "a/../b"], pinned: "broken" } } }, "/bad"), { recent: ["a"], pinned: [] });
});

test("rename and Trash remap pins and history with exact path boundaries", () => {
  let state;
  for (const path of ["src/a.py", "src-old/a.py"]) {
    state = library.updateLibrary(state, "/project", null, "open", path);
    state = library.updateLibrary(state, "/project", null, "pin", path);
  }
  const target = model.targetFor("/project", "src", true, null, "macos");
  const rename = { target, action: "rename", name: "lib" };
  state = library.remapLibrary(state, target.root, null, path => model.applyPathChange(path, rename));
  assert.deepEqual(library.libraryFor(state, "/project").pinned, ["src-old/a.py", "lib/a.py"]);
  const trash = { target: model.targetFor("/project", "lib", true), action: "trash" };
  state = library.remapLibrary(state, target.root, null, path => model.applyPathChange(path, trash));
  assert.deepEqual(library.libraryFor(state, "/project").recent, ["src-old/a.py"]);
});

test("breadcrumbs mark every ancestor as a folder", () => {
  assert.deepEqual(library.breadcrumbs("/project", "src/deep/a.py").map(c => [c.path, c.dir]), [["", true], ["src", true], ["src/deep", true], ["src/deep/a.py", false]]);
});

test("type and folder icons always resolve to bundled assets, including special names", () => {
  const cases = [["MAIN.PY", false, "python"], ["a.tsx", false, "typescript"], ["a.jsonl", false, "json"], [".env.local", false, "config"], ["tests", true, "folder-test"], [".git", true, "folder-git"], ["src", true, "folder-code"], ["README", false, "markdown"], ["new.unknown", false, "file"]];
  for (const [path, dir, expected] of cases) { const name = iconName(path, dir); assert.equal(name, expected); assert(existsSync(new URL(`../mods/files-plus/icons/${name}.svg`, import.meta.url))); }
});

function element() {
  const target = { childNodes: [], attrs: {}, events: {} }; let proxy;
  proxy = new Proxy(target, { get(object, key) {
    if (key === "child") return child => { object.childNodes.push(child); return proxy; };
    if (key === "children") return children => { object.childNodes.push(...children); return proxy; };
    if (key === "when") return (condition, fn) => condition ? fn(proxy) : proxy;
    if (key in object) return object[key];
    if (key.startsWith("on_")) return (...args) => { object.events[key] = args.at(-1); return proxy; };
    return value => { object.attrs[key] = value; return proxy; };
  } }); return proxy;
}
const nodes = node => !node || typeof node !== "object" ? [] : [node, ...node.childNodes.flatMap(nodes)];
const find = (tree, id) => nodes(tree).find(node => node.attrs.id === id);
function harness(persisted = {}) {
  let location = { cwd: "/project", on: null, space: "s" }, rendering = false;
  const tasks = [], timers = [], previews = [], opened = [], overlays = [], state = persisted;
  const cx = { notify() { assert.equal(rendering, false); }, stop_propagation() {}, focus_handle: () => ({ focus() {} }), timer: { after(_ms, fn) { timers.push(fn); }, every() {} }, spawn(fn) { tasks.push(fn(cx)); } };
  const deps = { ...library, ...model, projectContext: () => ({ ...location }), openFileTab: value => opened.push(value), div: element, svg: element, h_flex: element, v_flex: element, fileIcon: element,
    iconButton: (id, icon, label, fn) => element().id(id).on_click(fn),
    Preview: class { clear() {} close() {} refresh() {} open(root, path, on) { previews.push({ root, path, on }); } render() { return element().id("preview"); } },
    shared: key => state[key], setShared(key, value) { assert.equal(rendering, false); state[key] = value; },
    spaces: () => [{ active: true, folder: location.cwd, machine: location.on, id: "s" }], panes: () => [], focused: () => ({ cwd: location.cwd, pane: "p" }),
    theme: () => ({}), settings: () => ({ zoom: 1 }), window: () => ({ platform: "macos" }), openOverlay: value => overlays.push(value), watchFolder: async () => { throw new Error("No fixture watcher"); },
    exec: async (program, args) => ({ code: program === "git" ? 1 : 0, stdout: program === "git" ? "" : args[3].endsWith("/src") ? "f\0a.py\0f\0b.py\0" : "d\0src\0f\0readme.md\0" }) };
  const source = readFileSync(new URL("../mods/files-plus/browser.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  const Browser = new Function(...Object.keys(deps), source)(...Object.values(deps)), browser = new Browser(); browser.init({}, cx);
  return { browser, cx, state, previews, opened, overlays, async flush() { while (timers.length) timers.shift()(cx); for (let i = 0; i < tasks.length; i++) await tasks[i]; }, switchTo(next) { location = next; }, render() { rendering = true; try { return browser.render(cx); } finally { rendering = false; } } };
}
globalThis.window = { viewport_size: () => ({ width: 1400, height: 900 }) };

test("opening a file uses a center tab while narrow and wide sidebars keep navigation, pins and breadcrumbs", async () => {
  const f = harness(); await f.flush(); f.browser.toggle("src", f.cx); await f.flush();
  f.browser.pick(f.browser.visibleEntries().find(entry => entry.path === "src/a.py"), {}, f.cx); const narrow = f.render();
  assert.deepEqual(f.opened, [{ root: "/project", path: "src/a.py", on: null }]);
  assert(!find(narrow, "preview")); assert(find(narrow, "files-navigation"));
  find(narrow, "files-pin-current").events.on_click({}, f.cx);
  f.browser.width = 900; const wide = f.render(); assert(!find(wide, "preview")); assert(find(wide, "files-navigation"));
  find(wide, "crumb-src").events.on_click({}, f.cx); await f.flush();
  assert.equal(f.browser.file, null); assert.equal(f.browser.browseFolder, "src"); assert(find(f.render(), "file-src/a.py"));
  const next = harness(JSON.parse(JSON.stringify(f.state))); await next.flush();
  find(next.render(), "files-pinned").events.on_click({}, next.cx);
  assert.deepEqual(next.browser.visibleEntries().map(e => e.path), ["src/a.py"]);
});

test("modifier clicks open files normally, the header has no selection control and refresh never writes during render", async () => {
  const f = harness(); await f.flush(); f.browser.toggle("src", f.cx); await f.flush();
  const entries = f.browser.visibleEntries();
  f.browser.pick(entries.find(e => e.path === "src/a.py"), { modifiers: { platform: true } }, f.cx);
  f.browser.pick(entries.find(e => e.path === "src/b.py"), { modifiers: { shift: true } }, f.cx);
  assert.deepEqual(f.opened.map(o => o.path), ["src/a.py", "src/b.py"]);
  const tree = f.render();
  assert(!find(tree, "files-select")); assert(!nodes(tree).some(node => /^batch-|^selection-/.test(node.attrs.id ?? "")));
  f.switchTo({ cwd: "/other", on: "remote", space: "other" }); f.render(); await f.flush();
  assert.equal(f.browser.root, "/other");
  f.render();
});

test("folders carry their strongest Git mark, marks map to theme colors, and folders have open icons", () => {
  const marks = { "/project/src/deep/a.py": "A", "/project/src/b.py": "M", "/project/readme.md": "A", "/elsewhere/x.py": "D" };
  assert.deepEqual([...model.dirtyFolders(marks, "/project/")].sort(), [["src", "M"], ["src/deep", "A"]]);
  assert.equal(model.dirtyFolders({}, "/project").size, 0);
  const t = { ansi1: "red", ansi2: "green", ansi3: "amber" };
  assert.deepEqual(["A", "M", "D", "U", undefined].map(mark => model.markColor(mark, t)), ["green", "amber", "red", "red", null]);
  // VS Code Dark: neon terminal yellow on near-black is blended toward the text color.
  assert.equal(model.markColor("M", { ansi3: "#e5e510", ansi1: "#cd3131", foreground: "#bfbfbf" }), "#d4c052");
  assert.equal(model.markColor("A", { ansi2: "#0dbc79", foreground: "#bfbfbf" }), "#4bbd92");
  assert.equal(model.mixColor("#000000", "#ffffff80", 0.5), "#808080");
  const source = readFileSync(new URL("../mods/files-plus/icons.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replaceAll("export function", "function");
  const { iconFile } = new Function("div", "svg", "image", "iconName", source + "\nreturn { iconFile };")(element, element, element, iconName);
  assert.equal(iconFile("src", true, true), "mods/files-plus/icons/folder-code-open.svg");
  assert.equal(iconFile("scripts", true), "mods/files-plus/icons/folder-scripts.svg");
  assert.equal(iconFile("a.py", false, true), "mods/files-plus/icons/python.svg");
  for (const name of ["folder", "folder-code", "folder-docs", "folder-test", "folder-git", "folder-config", "folder-scripts", "folder-data", "folder-assets"])
    for (const variant of [name, name + "-open"]) assert(existsSync(new URL(`../mods/files-plus/icons/${variant}.svg`, import.meta.url)), variant);
});

test("recent and pinned paths group into compact folders, and recent files clear by folder or all at once", () => {
  const paths = ["AiData/Wechat/README.md", "GTSData/AnnounceInfo/a.py", "ruff.toml", "GTSData/AnnounceInfo/main.py", "GTSData/x.py"];
  const rows = library.treeRows(library.pathTree(paths));
  assert.deepEqual(rows.map(r => [r.depth, r.name, r.dir, r.count]), [
    [0, "AiData/Wechat", true, 1], [1, "README.md", false, 1], [0, "GTSData", true, 3], [1, "AnnounceInfo", true, 2],
    [2, "a.py", false, 1], [2, "main.py", false, 1], [1, "x.py", false, 1], [0, "ruff.toml", false, 1]]);
  assert.equal(rows[0].path, "AiData/Wechat");
  assert.deepEqual(library.treeRows(library.pathTree(paths), new Set(["GTSData"])).map(r => r.name), ["AiData/Wechat", "README.md", "GTSData", "ruff.toml"]);
  let state;
  for (const path of paths) { state = library.updateLibrary(state, "/p", null, "open", path); }
  state = library.updateLibrary(state, "/p", null, "pin", "GTSData/x.py");
  const folder = library.forgetRecent(state, "/p", null, "GTSData");
  assert.deepEqual(library.libraryFor(folder, "/p").recent, ["ruff.toml", "AiData/Wechat/README.md"]);
  assert.deepEqual(library.libraryFor(folder, "/p").pinned, ["GTSData/x.py"]);
  assert.deepEqual(library.libraryFor(library.forgetRecent(state, "/p", null), "/p").recent, []);
  assert.equal(library.forgetRecent(state, "/p", null, "../x"), state);
  assert.equal(library.forgetRecent(state, "/p", null, "Missing"), state);
  assert.equal(library.libraryView("tree"), "tree"); assert.equal(library.libraryView("junk"), "flat");
});

test("Recent lists flat with dimmed folders or by folder, folds folders, and clears only after a second click", async () => {
  const f = harness(); await f.flush();
  for (const path of ["src/a.py", "src/b.py", "readme.md"]) f.state[library.LIBRARY_KEY] = library.updateLibrary(f.state[library.LIBRARY_KEY], "/project", null, "open", path);
  find(f.render(), "files-recent").events.on_click({}, f.cx);
  assert.deepEqual(f.browser.visibleEntries().map(e => [e.name, e.hint]), [["readme.md", ""], ["b.py", "src"], ["a.py", "src"]]);
  find(f.render(), "library-tree").events.on_click({}, f.cx);
  assert.equal(f.state[library.LIBRARY_VIEW_KEY], "tree");
  assert.deepEqual(f.browser.visibleEntries().map(e => e.name), ["src", "a.py", "b.py", "readme.md"]);
  find(f.render(), "file-src").events.on_click({}, f.cx);
  assert.deepEqual(f.browser.visibleEntries().map(e => e.name), ["src", "readme.md"]);
  assert.equal(f.opened.length, 0);
  find(f.render(), "forget-src").events.on_click({}, f.cx);
  assert.deepEqual(library.libraryFor(f.state[library.LIBRARY_KEY], "/project").recent, ["readme.md"]);
  find(f.render(), "recent-clear").events.on_click({}, f.cx);
  assert.deepEqual(library.libraryFor(f.state[library.LIBRARY_KEY], "/project").recent, ["readme.md"]);
  await f.flush(); assert.equal(f.browser.clearArmed, false);
  find(f.render(), "recent-clear").events.on_click({}, f.cx);
  find(f.render(), "recent-clear").events.on_click({}, f.cx);
  assert.deepEqual(library.libraryFor(f.state[library.LIBRARY_KEY], "/project").recent, []);
  assert(!find(f.render(), "recent-clear"));
});

test("the fold button opens folders a few levels down, skipping dependency folders, then collapses them", async () => {
  const f = harness(); await f.flush();
  find(f.render(), "files-fold-all").events.on_click({}, f.cx); await f.flush();
  assert.deepEqual([...f.browser.folders], ["src"]);
  assert.deepEqual(f.browser.visibleEntries().map(e => e.path), ["src", "src/a.py", "src/b.py", "readme.md"]);
  find(f.render(), "files-fold-all").events.on_click({}, f.cx);
  assert.deepEqual([...f.browser.folders], []);
  const entries = new Map([["", [{ name: "src", dir: true }, { name: "node_modules", dir: true }, { name: ".git", dir: true }, { name: ".config", dir: true }, { name: "a.py", dir: false }]]]);
  assert.deepEqual(model.childFolders(entries, [""]), ["src"]);
  assert.deepEqual(model.childFolders(entries, [""], true), ["src", ".config"]);
  assert.deepEqual(model.openBelow(new Set(["src", "src/x", "lib"]), "src"), ["src/x"]);
  assert.deepEqual(model.openBelow(new Set(["src", "lib"])), ["src", "lib"]);
});

test("in grouped Recent the fold button folds and unfolds every group", async () => {
  const f = harness({ [library.LIBRARY_VIEW_KEY]: "tree" }); await f.flush();
  for (const path of ["a/x.py", "b/y.py"]) f.state[library.LIBRARY_KEY] = library.updateLibrary(f.state[library.LIBRARY_KEY], "/project", null, "open", path);
  f.browser.mode = "recent";
  find(f.render(), "files-fold-all").events.on_click({}, f.cx);
  assert.deepEqual([...f.browser.libraryFolded].sort(), ["a", "b"]);
  find(f.render(), "files-fold-all").events.on_click({}, f.cx);
  assert.equal(f.browser.libraryFolded.size, 0);
});
