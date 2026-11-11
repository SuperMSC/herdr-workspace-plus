import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import * as review from "../mods/files-plus/review-model.js";
import * as git from "../mods/files-plus/git-model.js";
function element() {
  const value = { childNodes: [], attributes: {}, events: {} }; let proxy;
  proxy = new Proxy(value, { get(target, key) {
    if (key === "child") return child => { target.childNodes.push(child); return proxy; };
    if (key === "children") return children => { target.childNodes.push(...children); return proxy; };
    if (key === "when") return (condition, callback) => condition ? callback(proxy) : proxy;
    if (key in target) return target[key];
    if (String(key).startsWith("on_")) return (...args) => { target.events[key] = args.at(-1); return proxy; };
    return value => { target.attributes[key] = value; return proxy; };
  } });
  return proxy;
}
const request = () => ({ root: "/repo", on: null, action: "stage", file: { path: "file.txt", section: "unstaged", status: "M" }, version: "version-1", hunk: { index: 0, header: "@@ -1 +1 @@", patch: "complete patch", enabled: true } });
async function load(file, deps) {
  const source = (await readFile(new URL(`../mods/files-plus/${file}.js`, import.meta.url), "utf8")).replace(/^import .+;$/gm, "").replace(/export default class \w+ \{/, match => "return " + match.slice("export default ".length));
  return new Function(...Object.keys(deps), source)(...Object.values(deps));
}

test("hunk controls capture the checkout and exact selected patch, with history/remote/loading disabled", async () => {
  const overlays = [], scrolls = [], cx = { notify() {} };
  const Changes = await load("changes", { ...review, ...git, div: element, h_flex: element, window: () => ({ platform: "macos" }), openOverlay: value => overlays.push(value) });
  const view = new Changes(), first = request(), second = { ...first.hunk, index: 1, header: "@@ -20 +20 @@", patch: "second patch" };
  Object.assign(view, { root: first.root, source: { cwd: first.root, on: null }, on: null, context: JSON.stringify({ cwd: first.root, on: null }), files: [first.file], historyFiles: [], page: "changes", open: "file.txt", section: "unstaged", diffMode: "inline", diffLoading: false,
    hunkData: { file: first.file, version: first.version, hunks: [first.hunk, second] }, activeHunk: 0, rows: [{ kind: "@", text: first.hunk.header }, { kind: "@", text: second.header }], diffScroll: { scroll_to_item: value => scrolls.push(value) } });
  assert.equal(view.selectHunkHeader(second.header, cx), true); assert.equal(view.activeHunk, 1);
  view.moveHunk(-1, cx); assert.equal(view.activeHunk, 0); assert.deepEqual(scrolls, [0]);
  view.openHunk(cx); assert.equal(overlays[0].props.role, "hunk"); assert.deepEqual(overlays[0].props.request, first);
  const toolbar = view.hunkToolbar({});
  const find = node => !node || typeof node !== "object" ? null : node.attributes.id === "git-hunk-apply" ? node : node.childNodes.map(find).find(Boolean);
  const oldButton = find(toolbar);
  view.hunkData.version = "changed"; view.activeHunk = 1;
  assert.equal(overlays[0].props.request.version, "version-1");
  oldButton.events.on_click({}, cx); assert.equal(overlays.length, 1); assert.match(view.note, /displayed hunk changed/);
  view.diffLoading = true; view.openHunk(cx); view.diffLoading = false;
  view.on = "remote"; view.openHunk(cx); view.on = null;
  view.page = "history"; view.openHunk(cx);
  assert.equal(overlays.length, 1);
});

async function dialogFixture() {
  const calls = [], tasks = [], closed = [], writes = [];
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const cx = { notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }), spawn: task => tasks.push(task(cx)) };
  const Dialog = await load("hunk-dialog", { div: element, v_flex: element, h_flex: element, theme: () => ({}), window: () => ({ platform: "macos" }), appHome: () => "/fixture-home", CHANGE_KEY: "change", shared: () => ({ revision: 2 }), setShared: (...args) => writes.push(args), closeOverlay: value => closed.push(value), exec: async (...args) => { calls.push(args); return gate; } });
  const view = new Dialog(), props = { overlay: "dialog-1", request: request() }; view.init(props, cx);
  return { view, props, cx, calls, closed, writes, finish, async settle() { await Promise.all(tasks); } };
}

test("hunk dialog starts once, keeps the captured target, blocks busy Escape and acknowledges exact success", async () => {
  const f = await dialogFixture();
  f.view.submit(f.cx); assert.equal(f.calls.length, 1); assert.equal(f.view.busy, true);
  f.props.request.root = "/other"; f.props.request.file.path = "wrong";
  const sent = JSON.parse(f.calls[0][1][1]); assert.equal(sent.root, "/repo"); assert.equal(sent.file.path, "file.txt");
  f.view.render().events.on_key_down({ key: "escape" }, f.cx); assert.deepEqual(f.closed, []);
  f.finish({ code: 0, stdout: JSON.stringify({ ok: true, action: "stage", path: "file.txt", header: request().hunk.header }) }); await f.settle();
  assert.equal(f.view.done, true); assert.deepEqual(f.closed, ["dialog-1"]); assert.equal(f.writes[0][1].revision, 3);
  f.view.submit(f.cx); assert.equal(f.calls.length, 1);
});

test("failed or ambiguous hunk results preserve the dialog and never automatically retry", async () => {
  const f = await dialogFixture(); f.finish({ code: 0, stdout: JSON.stringify({ ok: true, path: "wrong", action: "stage" }) }); await f.settle();
  assert.equal(f.view.busy, false); assert.match(f.view.error, /not confirmed/); assert.equal(f.calls.length, 1); assert.deepEqual(f.closed, []); assert.deepEqual(f.writes, []);
});
