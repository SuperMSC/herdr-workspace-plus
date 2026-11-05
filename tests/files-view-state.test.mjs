import * as libraryModel from "../mods/files-plus/library-model.js";
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as previewModel from '../mods/files-plus/preview-model.js';
import * as searchModel from '../mods/files-plus/search-model.js';
import * as findModel from '../mods/files-plus/file-find-model.js';
function element() { const target = { childNodes: [], attrs: {}, events: {} }; let proxy; proxy = new Proxy(target, { get(obj, key) { if (key === 'child') return value => { obj.childNodes.push(value); return proxy; }; if (key === 'children') return values => { obj.childNodes.push(...values); return proxy; }; if (key === 'when') return (value, fn) => value ? fn(proxy) : proxy; if (key in obj) return obj[key]; if (key.startsWith('on_')) return (...args) => { obj.events[key] = args.at(-1); return proxy; }; return value => { obj.attrs[key] = value; return proxy; }; } }); return proxy; }
function load(name, deps) { const source = readFileSync(new URL(`../mods/files-plus/${name}.js`, import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export default class', 'return class'); return new Function(...Object.keys(deps), source)(...Object.values(deps)); }
function input(options = {}) { let value = options.value || ''; const events = {}; return { value: () => value, set_value: next => { value = next; }, on(event, callback) { events[event] = callback; }, emit(event, value, cx) { events[event]?.(value, cx); }, release() { this.released = true; }, focus() { this.focused = true; }, set_selected_range(range) { this.selection = range; } }; }
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...node.childNodes.flatMap(nodes)];
const find = (tree, id) => nodes(tree).find(node => node.attrs.id === id);
function harness() {
  const requests = [], tasks = [], timers = [], editorOptions = [], state = new Map(); let rendering = false, editors = 0;
  const cx = { focus_handle: () => ({ focus() { assert(!rendering); }, release() { this.released = true; } }), stop_propagation() {}, notify() { assert.equal(rendering, false, 'render must never notify'); }, spawn(task) { tasks.push(task(cx)); }, timer: { every() {}, after(_delay, task) { timers.push(task); } } };
  const dependencies = { projectContext: () => ({ cwd: "/fixture", on: null }), ...previewModel, ...searchModel, ...libraryModel, ...findModel, shared: key => state.get(key), setShared(key, value) { assert(!rendering); state.set(key, value); }, closeButton: element, iconButton: (id, _icon, label, callback) => element().id(id).tooltip(label).on_click(callback), v_resizable: element, resizable_panel: element, fileIcon: element, div: element, svg: element, image: element, h_flex: element, v_flex: element, v_virtual_list: (id, count, size, _key, rows) => element().id(id).itemSize(size).children(rows({ start: 0, end: Math.min(count, 20) })), VirtualListScrollHandle: { new: () => ({ scroll_to_item(index) { assert(!rendering); this.index = index; }, release() { this.released = true; } }) }, Scrollbar: { vertical: element }, Input: { new: element }, InputState: { new: input }, Editor: { new: element }, TextView: { markdown: element }, EditorState: { new: options => { assert(!rendering); editors++; editorOptions.push(options); let value = options.value; return { value: () => value, set_value: next => { value = next; }, release() { this.released = true; } }; } }, theme: () => ({}), settings: () => ({}), appHome: () => '/fixture', spaces: () => [], panes: () => [], focused: () => null, closeOverlay() {}, readTextFile: async () => null, exec: (_program, args) => new Promise(resolve => requests.push({ args, resolve })) };
  dependencies.FileFind = load('file-find', dependencies);
  const Preview = load('preview', dependencies); dependencies.Preview = Preview;
  const Search = load('search', dependencies);
  return { cx, requests, tasks, timers, Preview, Search, state, editorOptions, editors: () => editors, render(view) { rendering = true; try { return view.render(cx); } finally { rendering = false; } }, async finish() { await Promise.all(tasks); } };
}
function result(data) { return { code: 0, stdout: JSON.stringify(data) }; }

test('out-of-order search responses cannot replace a newer query and renders remain side-effect free', async () => {
  const f = harness(), search = new f.Search(); search.init({ root: '/folder', on: null, rg: '/custom/rg' }, f.cx);
  search.query.set_value('old'); search.run(f.cx); assert.equal(JSON.parse(f.requests[0].args[1]).rg, '/custom/rg'); search.query.set_value('new'); search.run(f.cx);
  f.requests[1].resolve(result({ matches: [{ path: 'new.js', line: 2, text: 'new' }] })); await f.tasks[1];
  f.requests[0].resolve(result({ matches: [{ path: 'old.js', line: 1, text: 'old' }] })); await f.finish();
  assert.equal(search.matches[0].path, 'new.js'); assert.equal(search.loading, false); f.render(search);
  search.query.set_value('third'); search.schedule(f.cx); search.query.set_value('fourth'); search.schedule(f.cx);
  f.timers.at(-2)(f.cx); assert.equal(f.requests.length, 2); f.timers.at(-1)(f.cx); assert.equal(f.requests.length, 3);
  f.requests[2].resolve(result({ matches: [] })); await f.finish(); search.close();
});
test('switching files invalidates old preview reads and refresh preserves retained state', async () => {
  const f = harness(), preview = new f.Preview(); preview.open('/folder', 'old.json', null, f.cx); preview.open('/folder', 'new.json', null, f.cx);
  f.requests[1].resolve(result({ kind: 'json', signature: 'new', text: '{"nested":{"v":1}}' })); await f.tasks[1];
  f.requests[0].resolve(result({ kind: 'json', signature: 'old', text: '{"old":true}' })); await f.finish();
  assert.equal(preview.data.signature, 'new'); assert.equal(f.editors(), 1); preview.expanded.add('$/nested'); preview.mode = 'source';
  preview.refresh(f.cx); f.requests[2].resolve(result({ kind: 'json', signature: 'changed', text: '{"nested":{"v":2}}' })); await f.finish();
  assert.equal(f.editors(), 1); assert(preview.expanded.has('$/nested')); assert.equal(preview.mode, 'source'); f.render(preview);
  preview.mode = 'preview'; f.render(preview); preview.close();
});

test('file find opens by button or keyboard and navigates occurrences with Enter and Shift+Enter', async () => {
  const f = harness(), preview = new f.Preview(); preview.open('/folder', 'demo.py', null, f.cx);
  f.requests[0].resolve(result({ kind: 'source', signature: 'one', text: 'needle needle\nother\nNEEDLE' })); await f.finish();
  find(f.render(preview), 'preview-find').events.on_click({}, f.cx);
  const search = preview.find;
  assert.equal(search.visible, true);
  search.input.set_value('needle'); search.input.emit('change', {}, f.cx);
  assert.equal(search.result.matches.length, 3); assert.equal(search.scroll.index, 0);
  search.input.emit('submit', {}, f.cx); assert.equal(search.active, 1);
  search.input.emit('submit', {}, f.cx); assert.equal(search.active, 2); assert.equal(search.scroll.index, 2);
  search.input.emit('submit', {}, f.cx); assert.equal(search.active, 0);
  search.input.emit('submit', { shift: true }, f.cx); assert.equal(search.active, 2);
  let tree = f.render(preview); assert(find(tree, 'file-find-source'));
  find(tree, 'file-find-case').events.on_click({}, f.cx); assert.equal(search.result.matches.length, 2);
  find(f.render(preview), 'file-find-close').events.on_click({}, f.cx); assert.equal(search.visible, false);
  tree = f.render(preview); assert(!find(tree, 'file-find-bar'));
  tree.events.on_key_down({ key: 'f', modifiers: { platform: true } }, f.cx);
  assert.equal(search.visible, true);
  f.timers.at(-1)(f.cx); assert.deepEqual(search.input.selection, { start: 0, end: 6 });
  f.render(preview).events.on_key_down({ key: 'escape' }, f.cx); assert.equal(search.visible, false);
  f.render(preview).events.on_key_down({ key: 'f', modifiers: { control: true } }, f.cx); assert.equal(search.visible, true);
  preview.close(); assert(search.input.released); assert(search.scroll.released); assert(search.handle.released);
  for (const timer of f.timers) timer(f.cx);
});

test('file find preserves structured previews and handles refreshed, truncated, missing and new files', async () => {
  const f = harness(), preview = new f.Preview(); preview.open('/folder', 'demo.json', null, f.cx);
  f.requests[0].resolve(result({ kind: 'json', signature: 'one', text: '{"name":"needle","value":"needle"}', truncated: true })); await f.finish();
  const search = preview.find; search.show(f.cx); search.input.set_value('needle'); search.input.emit('change', {}, f.cx); search.move(1, f.cx);
  assert.equal(preview.mode, 'preview'); assert.equal(search.active, 1); assert(search.truncated);
  preview.refresh(f.cx); f.requests[1].resolve(result({ kind: 'json', signature: 'two', text: '{"value":"needle"}' })); await f.finish();
  assert.equal(search.active, 0); assert.equal(search.result.matches.length, 1); assert.equal(search.truncated, false);
  search.input.set_value('missing'); search.input.emit('change', {}, f.cx);
  let tree = f.render(preview); assert(find(tree, 'json-file-preview')); assert(!find(tree, 'file-find-source'));
  assert.deepEqual(find(tree, 'file-find-count').childNodes, ['No matches']);
  preview.refresh(f.cx); f.requests[2].resolve(result({ error: 'This file is no longer available' })); await f.finish();
  tree = f.render(preview); assert(!find(tree, 'preview-find')); assert(!find(tree, 'file-find-source'));
  preview.open('/folder', 'photo.png', null, f.cx);
  f.requests[3].resolve(result({ kind: 'image', signature: 'image', image: 'fixture.png', width: 10, height: 10 })); await f.finish();
  tree = f.render(preview); assert(!find(tree, 'preview-find')); assert.equal(search.input.value(), ''); assert.equal(search.visible, false);
  tree.events.on_key_down({ key: 'f', modifiers: { platform: true } }, f.cx); assert.equal(search.visible, false);
  preview.close();
});

test('preview font controls preserve text and search state and remember the size for another file', async () => {
  const f = harness(), preview = new f.Preview(); preview.open('/folder', 'demo.py', null, f.cx);
  f.requests[0].resolve(result({ kind: 'source', signature: 'one', text: 'needle\nother\nneedle' })); await f.finish();
  assert.equal(f.editorOptions.at(-1).font_size, 12);
  const previous = preview.code;
  preview.find.show(f.cx); preview.find.input.set_value('needle'); preview.find.input.emit('change', {}, f.cx); preview.find.move(1, f.cx);
  find(f.render(preview), 'preview-font-larger').events.on_click({}, f.cx);
  assert.equal(preview.fontSize, 13); assert.equal(f.editorOptions.at(-1).font_size, 13); assert(previous.released);
  assert.equal(preview.code.value(), 'needle\nother\nneedle'); assert.equal(preview.find.active, 1);
  assert.equal(f.state.get(previewModel.PREVIEW_FONT_KEY), 13);
  const another = new f.Preview(); another.open('/folder', 'another.json', null, f.cx);
  f.requests[1].resolve(result({ kind: 'json', signature: 'two', text: '{"size":13}' })); await f.finish();
  assert.equal(another.fontSize, 13); assert.equal(find(f.render(another), 'json-file-preview').attrs.text_size, 13);
  find(f.render(another), 'preview-font-reset').events.on_click({}, f.cx); assert.equal(another.fontSize, 12);
  f.render(preview); f.render(preview); assert(preview.fontSyncScheduled);
  while (f.timers.length) f.timers.shift()(f.cx);
  assert.equal(preview.fontSize, 12);
  preview.setFontSize(99, f.cx); assert.equal(preview.fontSize, 24);
  assert.equal(find(f.render(preview), 'file-find-lines').attrs.itemSize, 44);
  preview.setFontSize(1, f.cx); assert.equal(preview.fontSize, 10);
  assert.equal(find(f.render(preview), 'preview-font-smaller').attrs.disabled, true);
  f.state.set(previewModel.PREVIEW_FONT_KEY, 18); f.render(preview); const total = f.editors(); preview.close();
  while (f.timers.length) f.timers.shift()(f.cx);
  assert.equal(f.editors(), total); another.close();
});
