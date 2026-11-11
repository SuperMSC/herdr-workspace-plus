import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as previewModel from '../mods/files-plus/preview-model.js';
import * as editorModel from '../mods/files-plus/editor-model.js';
import * as markdownModel from '../mods/files-plus/markdown-model.js';
import * as mermaidModel from '../mods/files-plus/mermaid-model.js';

function element() {
  const node = { childNodes: [], attrs: {}, events: {} };
  const proxy = new Proxy(node, { get(object, key) {
    if (key === 'child') return child => { node.childNodes.push(child); return proxy; };
    if (key === 'children') return children => { node.childNodes.push(...children); return proxy; };
    if (key === 'when') return (condition, callback) => condition ? callback(proxy) : proxy;
    if (key in object) return object[key];
    if (key.startsWith('on_')) return (...args) => { node.events[key] = args.at(-1); return proxy; };
    return value => { node.attrs[key] = value; return proxy; };
  } });
  return proxy;
}
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...node.childNodes.flatMap(nodes)];
const find = (tree, id) => nodes(tree).find(node => node.attrs.id === id);
const texts = tree => nodes(tree).flatMap(node => node.childNodes.filter(child => typeof child === 'string'));
const source = readFileSync(new URL('../mods/files-plus/preview.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export default class', 'return class');
function harness() {
  const files = { '/r/a.md': '# First\n\n[Next](docs/b.md#second)\n\n## Last\nEnd\n', '/r/docs/b.md': '# Second\n\n```mermaid\nflowchart LR\nA-->B\n```\n' };
  const tasks = [], timers = [], drafts = [], navigated = [], opened = [], state = new Map(), editors = [];
  let rendering = false, deferDiagram = null;
  const cx = { notify() { assert(!rendering, 'render must not notify'); }, stop_propagation() {}, open_url: url => opened.push(url), focus_handle: () => ({ focus() {} }),
    timer: { after(_ms, fn) { timers.push(fn); } }, spawn(fn) { tasks.push(fn(cx)); } };
  const dependencies = { ...previewModel, ...editorModel, ...markdownModel, ...mermaidModel,
    div: element, image: path => element().id('image-' + path), svg: element, v_flex: element, h_flex: element,
    TextView: { markdown: (id, text) => element().id(id).child(text) }, Editor: { new: element },
    EditorState: { new: options => { let value = options.value; const handlers = {}; const editor = { value: () => value, set_value: text => { value = text; }, on: (name, fn) => { handlers[name] = fn; }, type: text => { value = text; handlers.change?.({}, cx); }, release() {} }; editors.push(editor); return editor; } },
    FileFind: class { constructor() { this.handle = { focus() {} }; this.visible = false; this.result = { matches: [] }; } clear() { this.visible = false; } setText(text) { this.text = text; } key() {} close() {} },
    theme: () => ({ background: '#202020', foreground: '#eeeeee', dim: '#777777', muted: '#aaaaaa', border: '#444444', ansi4: '#6699ee', working: '#ff9900', blocked: '#ff0000' }), settings: () => ({ font_family: 'Arial' }),
    shared: key => state.get(key), setShared: (key, value) => { assert(!rendering); state.set(key, value); }, appHome: () => '/app',
    exec: async (_cmd, args) => { const options = JSON.parse(args[1]); const text = files[options.root + '/' + options.path]; return { code: 0, stdout: JSON.stringify(text === undefined ? { error: 'Missing file' } : { kind: previewModel.fileKind(options.path), text, signature: text, truncated: false }) }; },
    readTextFile: async path => files[path] ?? null, writeTextFile: async (path, text, expected) => { assert.equal(files[path], expected); files[path] = text; },
    keepDraft: async (root, path, text, base) => { drafts.push({ root, path, text, base }); }, dropDraft: async () => {}, loadDraft: async () => null,
    renderDiagrams: async blocks => {
      if (deferDiagram) return deferDiagram(blocks);
      return blocks.map(block => { try { if (!block.closed) throw new Error('Unclosed Mermaid fence.'); mermaidModel.validateDiagram(block.source); return { media: { path: 'test.svg', width: 300, height: 120 } }; } catch (error) { return { error: error.message }; } });
    }
  };
  const Preview = new Function(...Object.keys(dependencies), source)(...Object.values(dependencies));
  return { Preview, cx, files, drafts, navigated, opened, editors, timers,
    view() { const view = new Preview({ editable: true, id: 'p', onNavigate: target => navigated.push(target) }); view.open('/r', 'a.md', null, cx); return view; },
    render(view) { rendering = true; try { return view.render(cx); } finally { rendering = false; } },
    click(view, id) { const node = find(this.render(view), id); assert(node, 'Missing ' + id); node.events.on_click({}, cx); },
    async settle() { for (let round = 0; round < 8; round++) await Promise.all(tasks.splice(0)); },
    defer(fn) { deferDiagram = fn; }
  };
}

test('Contents, heading links, relative Markdown links and Back use captured file context', async () => {
  const f = harness(), view = f.view(); await f.settle();
  f.click(view, 'preview-contents'); assert(find(f.render(view), 'markdown-heading-last'));
  f.click(view, 'markdown-heading-last'); assert.equal(view.anchor, 'last'); assert.equal(view.history.length, 1);
  assert(!texts(f.render(view)).some(text => text.startsWith('# First')));
  f.click(view, 'preview-back-document'); assert.equal(view.anchor, null);
  view.followMarkdown('docs/b.md#second', f.cx); await f.settle();
  assert.equal(view.path, 'docs/b.md'); assert.equal(view.anchor, 'second'); assert.equal(view.history.at(-1).path, 'a.md');
  assert.equal(f.navigated.at(-1).path, 'docs/b.md');
  assert(find(f.render(view), 'markdown-diagram-1'));
  f.click(view, 'preview-back-document'); await f.settle(); assert.equal(view.path, 'a.md');
  view.followMarkdown('../../private.md', f.cx); assert.match(view.linkError, /outside/); assert.equal(view.path, 'a.md');
  view.followMarkdown('https://example.com', f.cx); assert.deepEqual(f.opened, ['https://example.com']);
});

test('missing linked files retain Back, and dirty navigation persists the original draft without saving it', async () => {
  const f = harness(), view = f.view(); await f.settle();
  view.followMarkdown('missing.md', f.cx); await f.settle(); assert.match(view.error, /Missing/);
  f.click(view, 'preview-back-document'); await f.settle(); assert.equal(view.path, 'a.md');
  view.startEdit(f.cx); await f.settle(); f.editors.at(-1).type('# Draft\nnot saved');
  const original = f.files['/r/a.md']; view.navigateMarkdown({ path: 'docs/b.md', anchor: 'second' }, f.cx); await f.settle();
  assert.equal(f.files['/r/a.md'], original); assert.deepEqual(f.drafts.at(-1), { root: '/r', path: 'a.md', text: '# Draft\nnot saved', base: original });
  assert.equal(view.path, 'docs/b.md'); assert.equal(view.editing, false);
});

test('diagram errors keep original source; stale async diagram completions cannot replace another document', async () => {
  const f = harness(); f.files['/r/a.md'] = '# Bad\n```mermaid\npie\n"A":2\n```\n```mermaid\nflowchart LR\n';
  const view = f.view(); await f.settle(); const tree = f.render(view);
  assert(texts(tree).some(text => text.includes('Supported diagrams')));
  assert(texts(tree).some(text => text.includes('Unclosed Mermaid fence')));
  assert(texts(tree).some(text => text.includes('"A":2')));
  let resolve;
  f.defer(() => new Promise(done => { resolve = done; }));
  view.open('/r', 'docs/b.md', null, f.cx);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(typeof resolve, 'function');
  f.defer(null); view.open('/r', 'a.md', null, f.cx);
  resolve([{ media: { path: 'stale.svg', width: 1, height: 1 } }]); await f.settle();
  assert.equal(view.path, 'a.md'); assert.equal(view.markdownBlocks.some(block => block.media?.path === 'stale.svg'), false);
});
