import * as libraryModel from "../mods/files-plus/library-model.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import * as model from "../mods/files-plus/model.js";

globalThis.window = { viewport_size: () => ({ width: 1280, height: 800 }) };

function element() {
  const node = { childNodes: [], attrs: {}, events: {} };
  const proxy = new Proxy(node, { get(target, name) {
    if (name === "child") return child => { target.childNodes.push(child); return proxy; };
    if (name === "children") return children => { target.childNodes.push(...children); return proxy; };
    if (name === "when") return (condition, callback) => condition ? callback(proxy) : proxy;
    if (name.startsWith("on_")) return (...args) => { target.events[name] = args.at(-1); return proxy; };
    if (name in target) return target[name];
    return value => { target.attrs[name] = value; return proxy; };
  } });
  return proxy;
}
const nodes = node => !node || typeof node !== "object" ? [] : [node, ...node.childNodes.flatMap(nodes)];
const find = (node, id) => nodes(node).find(node => node.attrs.id === id);
const text = node => typeof node === "string" ? node : (node?.childNodes ?? []).map(text).join(" ");

function view(file, dependencies) {
  dependencies = { ...libraryModel, fileIcon: element, iconButton: (id, icon, label, click) => element().id(id).on_click(click), ...dependencies };
  const source = readFileSync(new URL(`../mods/files-plus/${file}.js`, import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export function changed", "function changed").replace("export default class", "return class");
  return new Function(...Object.keys(dependencies), source)(...Object.values(dependencies));
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "agent-workspace-hidden-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["file.txt", "file.name", ".env", "src/normal.js", "src/.secret", ".config/normal.txt", ".git/config"]) {
    const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "fixture");
  }
  return root;
}

function harness(root, state = {}, options = {}) {
  const calls = [], tasks = [], overlays = [], closed = [], timers = [];
  const cx = { notify() {}, stop_propagation() {}, timer: { every() {}, after(_delay, fn) { timers.push(fn); } }, focus_handle: () => ({ focus() {} }),
    spawn(task) { tasks.push(task(cx)); } };
  const dependencies = {
    projectContext: () => ({ cwd: root, on: null, space: "space" }),
    Preview: class { clear() {} refresh() {} open() {} close() {} render() { return element(); } },
    ...model, div: element, svg: element, h_flex: element, v_flex: element,
    Editor: { new: element }, EditorState: { new: () => ({ release() {} }) },
    spaces: () => [{ id: "space", active: true, folder: root }], panes: () => [],
    focused: () => ({ pane: null, terminal: "t1", cwd: root }),
    theme: () => ({}), settings: () => ({ zoom: 1 }), window: () => ({ platform: options.platform || "macos" }),
    shared: key => state[key], setShared: (key, value) => { state[key] = value; },
    openOverlay: props => overlays.push(props), closeOverlay: id => closed.push(id),
    readTextFile: async () => "fixture preview", watchFolder: async () => { throw new Error("Fixture has no watcher"); },
    createFilesystem() { throw new Error("Hidden toggle must not perform a filesystem action"); },
    exec: async (program, args) => {
      calls.push({ program, args });
      if (options.exec) return options.exec(program, args);
      if (program === "git") return { code: 1, stdout: "" };
      const result = spawnSync(program, args, { encoding: "utf8" });
      return { code: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
    },
  };
  const Browser = view("browser", dependencies), Menu = view("menu", dependencies);
  const browser = new Browser(); browser.init({}, cx);
  return {
    browser, state, calls, overlays, closed, cx,
    async finish() { for (let i = 0; i < tasks.length; i++) await tasks[i]; },
    render: () => { const result = browser.render(cx); while (timers.length) timers.shift()(cx); return result; },
    rows: () => browser.rows("", 0, [], {}).map(row => row.attrs.id),
    menu(props) { const menu = new Menu(); menu.init({ ...props, overlay: "fixture-menu" }, cx); return menu; },
  };
}

test("hidden files default off across nested folders and enabling includes dot names without changing real paths", async t => {
  const root = fixture(t), f = harness(root); await f.finish();
  assert.deepEqual(f.rows(), ["file-src", "file-file.name", "file-file.txt"]);
  f.browser.toggle("src", f.cx); await f.finish();
  assert(f.rows().includes("file-src/normal.js")); assert(!f.rows().includes("file-src/.secret"));
  const target = model.targetFor(root, "", true, null, "macos"), menu = f.menu({ target });
  const index = menu.items.findIndex(item => item.id === "toggleHidden");
  assert.equal(menu.items[index].checked, false);
  menu.choose(index, f.cx);
  assert.equal(f.state[model.SHOW_HIDDEN_KEY], true);
  assert.deepEqual(f.closed, ["fixture-menu"]);
  f.render(); await f.finish();
  assert(f.rows().includes("file-.env")); assert(f.rows().includes("file-.git")); assert(f.rows().includes("file-src/.secret"));
  const next = f.menu({ target });
  assert.equal(next.items.find(item => item.id === "toggleHidden").checked, true);
  assert.match(text(find(next.render(), "files-plus-toggleHidden")), /✓/);
  assert.equal(model.targetFor(root, ".env", false, null, "macos").path, `${root}/.env`);
  assert(!menu.items.some(item => ["rename", "trash"].includes(item.id)));
});

test("hiding dot folders omits their expanded descendants and enumeration, while restoring expands them again", async t => {
  const root = fixture(t), f = harness(root, { [model.SHOW_HIDDEN_KEY]: true }); await f.finish();
  f.browser.toggle(".config", f.cx); await f.finish();
  assert(f.rows().includes("file-.config/normal.txt"));
  const before = f.calls.length;
  f.state[model.SHOW_HIDDEN_KEY] = false; f.render(); await f.finish();
  assert(!f.rows().some(id => id.startsWith("file-.")));
  assert(!f.calls.slice(before).some(call => call.program === "sh" && call.args[3].endsWith("/.config")));
  f.state[model.SHOW_HIDDEN_KEY] = true; f.render(); await f.finish();
  assert(f.rows().includes("file-.config/normal.txt"));
});

test("dot entries do not consume the visible folder limit", async t => {
  const root = fixture(t);
  for (let index = 0; index < 510; index++) writeFileSync(join(root, `.hidden-${index}`), "fixture");
  const f = harness(root); await f.finish();
  assert.equal(f.browser.entries.get("").length, 3);
  assert.equal(f.browser.limited, false);
  assert(f.rows().includes("file-file.txt"));
  f.state[model.SHOW_HIDDEN_KEY] = true; f.render(); await f.finish();
  assert.equal(f.browser.entries.get("").length, 500);
  assert.equal(f.browser.limited, true);
});

test("the Files header exposes preferences while previewing and ordinary item/Changes menus stay unchanged", async t => {
  const root = fixture(t), f = harness(root); await f.finish();
  f.browser.file = "file.txt";
  const tree = f.render();
  assert.match(text(tree), /Files/); assert.doesNotMatch(text(tree), /Files Plus/);
  find(tree, "files-plus-root-menu").events.on_click({}, f.cx);
  const props = f.overlays[0].props;
  assert.equal(props.preferences, true); assert.equal(props.target.path, `${root}/file.txt`);
  assert(f.menu(props).items.some(item => item.id === "toggleHidden"));
  assert(!model.menuItems(props.target).some(item => item.id === "toggleHidden"));
  assert(!model.menuItems({ ...props.target, kind: "changes", xy: " M" }, { preferences: true }).some(item => item.id === "toggleHidden"));
  assert(model.menuHeight(props.target, { preferences: true }) > model.menuHeight(props.target));
});

test("a directory response from the old hidden preference cannot replace the new view", async t => {
  const root = fixture(t), pending = [];
  const f = harness(root, {}, { exec: (program, args) => program === "sh" ? new Promise(resolve => pending.push({ args, resolve })) : { code: 1, stdout: "" } });
  const previous = f.browser.context;
  f.state[model.SHOW_HIDDEN_KEY] = true; f.render();
  assert.notEqual(f.browser.context, previous);
  assert.equal(pending[0].args[4], "0"); assert.equal(pending[1].args[4], "1");
  pending[1].resolve({ code: 0, stdout: "f\0.visible-now\0" });
  await Promise.resolve(); await Promise.resolve();
  pending[0].resolve({ code: 0, stdout: "f\0older.txt\0" });
  await f.finish();
  assert.deepEqual(f.browser.entries.get("").map(entry => entry.name), [".visible-now"]);
});

test("Windows applies dot-name filtering before its cap and preserves literal path escaping", async t => {
  const root = fixture(t), f = harness(root, {}, { platform: "windows", exec: (program, args) => {
    if (program === "powershell") return { code: 0, stdout: JSON.stringify([{ name: ".hidden", dir: true }, { name: "shown.txt", dir: false }]) };
    return { code: 1, stdout: "" };
  } });
  await f.finish();
  const command = f.calls.find(call => call.program === "powershell").args[2];
  assert(command.indexOf("Where-Object") < command.indexOf("Select-Object -First 501"));
  assert.match(command, /Name\.StartsWith\('\.'\)/); assert.match(command, /\$false$/);
  assert.deepEqual(f.browser.entries.get("").map(entry => entry.name), ["shown.txt"]);
  f.state[model.SHOW_HIDDEN_KEY] = true; f.render(); await f.finish();
  assert.match(f.calls.filter(call => call.program === "powershell").at(-1).args[2], /\$true$/);
  assert(f.rows().includes("file-.hidden"));
});
