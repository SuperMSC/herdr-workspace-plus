import { uiFunction } from "./helpers/ui-function.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import * as review from "../mods/files-plus/review-model.js";
import * as git from "../mods/files-plus/git-model.js";

async function harness(mode = "inline") {
  let renderingItems = false;
  const lists = [], overlays = [];
  function element() {
    let proxy;
    const state = { children: [], attributes: {}, events: {} };
    proxy = new Proxy(state, { get(target, key) {
      if (key === "raw") return target;
      if (key === "child") return value => { target.children.push(value); return proxy; };
      if (key === "children") return values => { target.children.push(...values); return proxy; };
      if (key === "when") return (value, callback) => value ? callback(proxy) : proxy;
      if (key in target) return target[key];
      if (String(key).startsWith("on_")) return (...args) => {
        assert.equal(renderingItems, false, `Native virtual item renderer forbids ${String(key)}`);
        target.events[key] = args.at(-1); return proxy;
      };
      return value => { target.attributes[key] = value; return proxy; };
    } });
    return proxy;
  }
  const v_virtual_list = (id, count, _height, key, renderer) => {
    const node = element(); node.virtual = { id, count, key, renderer }; lists.push(node); return node;
  };
  const dependencies = { div: element, h_flex: element, Scrollbar: { vertical: element }, v_virtual_list };
  const source = (await readFile(new URL("../mods/files-plus/git-diff.js", import.meta.url), "utf8")).replace(/^import .+;$/gm, "").replaceAll("export function ", "function ");
  const { diffView } = uiFunction(...Object.keys(dependencies), `${source}\nreturn { diffView };`)(...Object.values(dependencies));
  const changesDependencies = { ...git, ...review, div: element, shared: () => null, openOverlay: value => overlays.push(value) };
  const changesSource = (await readFile(new URL("../mods/files-plus/changes.js", import.meta.url), "utf8")).replace(/^import .+;$/gm, "").replace("export default class Changes {", "return class Changes {");
  const Changes = uiFunction(...Object.keys(changesDependencies), changesSource)(...Object.values(changesDependencies));
  const view = new Changes(), file = { path: "src/file.js", section: "unstaged" };
  const rawRows = git.diffRows(["@@ -1,2 +1,3 @@", " keep", "-old", "+new", "+extra"]);
  Object.assign(view, { root: "/repo", on: null, files: [file], historyFiles: [], page: "changes", open: file.path, section: file.section,
    diffRequest: 7, diffMode: mode, diffWidth: 400, rows: git.inlineDisplay(rawRows), split: git.splitDisplay(git.splitRows(rawRows)),
    rawRows, reviewVersion: "verified-version", diffLoading: false });
  const t = { ansi1: "#ff0000", ansi2: "#00ff00", accent: "#1122ff", border: "#444444", dim: "#777777", foreground: "#eeeeee", muted: "#aaaaaa", raised: "#222222" };
  const tree = diffView(view, t, "monospace"), list = lists[0];
  const cx = { notify() { assert.equal(renderingItems, false); }, stop_propagation() {} };
  return { view, tree, list, overlays, cx, renderRows() { renderingItems = true; try { return list.virtual.renderer({ start: 0, end: list.virtual.count }); } finally { renderingItems = false; } },
    click(index, { x = 800, width = 1000, shift = false, alt = false } = {}) {
      tree.events.on_mouse_down({ local_position: { x, y: 10 }, bounds: { width, height: 200 }, modifiers: { shift, alt } }, cx);
      list.events.on_item_click(list.virtual.key(index), cx);
    },
    secondary(index, { x = 800, width = 1000, shift = false } = {}) {
      list.events.on_item_secondary_click(list.virtual.key(index), { local_position: { x, y: 10 }, bounds: { width, height: 20 }, modifiers: { shift } }, cx);
    } };
}

test("inline and split deferred item renderers never register handlers", async () => {
  for (const mode of ["inline", "split"]) {
    const f = await harness(mode), rows = f.renderRows();
    assert.equal(rows.length, f.list.virtual.count); assert.ok(rows.length > 3);
    const visit = node => { if (!node || typeof node !== "object") return; assert.deepEqual(node.raw.events, {}); for (const child of node.raw.children || []) visit(child); };
    rows.forEach(visit);
    assert.equal(typeof f.list.events.on_item_click, "function"); assert.equal(typeof f.list.events.on_item_secondary_click, "function");
  }
});

test("list-level inline click preserves Shift ranges and right-click opens the selected range", async () => {
  const f = await harness(); f.renderRows();
  f.click(3); f.click(4, { shift: true });
  assert.deepEqual(f.view.reviewSelection, { side: "after", anchor: 2, start: 2, end: 3 });
  f.secondary(4, { shift: true });
  const anchor = f.overlays[0].props.anchor;
  assert.equal(anchor.side, "after"); assert.equal(anchor.start, 2); assert.equal(anchor.end, 3); assert.equal(anchor.snippet, "2: new\n3: extra");
});

test("split list chooses Before or After from the actual clicked half", async () => {
  const f = await harness("split"); f.renderRows();
  f.click(2, { x: 100 }); assert.deepEqual(f.view.reviewSelection, { side: "before", anchor: 2, start: 2, end: 2 });
  f.click(2, { x: 800 }); assert.deepEqual(f.view.reviewSelection, { side: "after", anchor: 2, start: 2, end: 2 });
  f.secondary(2, { x: 100 }); assert.equal(f.overlays[0].props.anchor.side, "before"); assert.equal(f.overlays[0].props.anchor.snippet, "2: old");
});

test("Alt-click picks Before for inline context and stale frame keys cannot redirect a selection", async () => {
  const f = await harness();
  f.click(1, { alt: true }); assert.equal(f.view.reviewSelection.side, "before");
  f.view.reviewSelection = null; f.view.diffRequest++;
  f.click(3); assert.equal(f.view.reviewSelection, null); assert.equal(f.overlays.length, 0);
});
