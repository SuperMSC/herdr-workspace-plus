import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uiFunction } from './helpers/ui-function.mjs';
import * as launcherModel from '../mods/sessions-plus/launcher-model.js';
import * as overviewModel from '../mods/sessions-plus/git-overview-model.js';
import { COMMANDS_KEY } from '../mods/sessions-plus/commands-model.js';
import { PRESETS_KEY, presetState } from '../mods/sessions-plus/presets-model.js';

function element() {
  const node = { childNodes: [], attrs: {}, events: {} };
  const el = new Proxy(node, { get(target, key) {
    if (key === 'child') return value => { node.childNodes.push(value); return el; };
    if (key === 'children') return values => { node.childNodes.push(...values); return el; };
    if (key === 'when') return (condition, fn) => condition ? fn(el) : el;
    if (key in target) return target[key];
    if (key.startsWith('on_')) return (...args) => { node.events[key] = args.at(-1); return el; };
    return value => { node.attrs[key] = value; return el; };
  } }); return el;
}
const nodes = tree => typeof tree !== 'object' || !tree ? [] : [tree, ...tree.childNodes.flatMap(nodes)];
const find = (tree, id) => nodes(tree).find(n => n.attrs.id === id);
function load(path, deps) {
  const source = readFileSync(new URL('../mods/' + path + '.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export default class', 'return class');
  return uiFunction(...Object.keys(deps), source)(...Object.values(deps));
}
function fixture() {
  const calls = [], tasks = [], stored = new Map(), inputs = [], state = { spaces: [{ id: 's1', name: 'Project', folder: '/repo', machine: null, tabs: [] }, { id: 'remote/s1', name: 'Remote', folder: '/srv/repo', machine: 'remote', tabs: [] }], agents: [], terminals: [], props: { overlay: 'dialog', dialog: true } };
  const cx = { notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }), timer: { every() {} }, spawn(fn) { tasks.push(fn(cx)); } };
  const deps = { ...launcherModel, COMMANDS_KEY, PRESETS_KEY, View: class {}, div: element, image: element, svg: element, h_flex: element, v_flex: element,
    Input: { new: element }, InputState: { new(options) { let value = options?.value || ''; const events = {}; const input = { value: () => value, on: (key, fn) => { events[key] = fn; }, set_value: v => { value = v; }, focus() {}, release() {}, type(v) { value = v; events.change?.({}, cx); }, submit() { events.submit?.({}, cx); } }; inputs.push(input); return input; } },
    ScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    theme: () => ({ border: '#333333', dim: '#777777' }), window: () => ({ platform: 'macos' }), privacyGuard: () => null,
    spaces: () => state.spaces, agents: () => state.agents, terminals: () => state.terminals, panes: () => [], props: () => state.props, focused: () => ({ pane: 'original-pane' }), projectContext: () => ({ cwd: '/repo', on: null }),
    shared: key => stored.get(key), setShared: (key, value) => stored.set(key, value), setAgentOrder: order => calls.push(['order', order]),
    run: (...args) => calls.push(['run', ...args]), closeOverlay: id => calls.push(['close', id]), openOverlay: spec => calls.push(['open', spec]),
    knownAgents: async options => { calls.push(['known', options]); return [{ key: 'agent', name: 'Agent', installed: true, run: ['/bin/agent', '--flag'] }, { key: 'missing', name: 'Missing', installed: false, run: ['/bin/missing'] }]; },
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) }, layout: () => ({ id: 'sidebar', size: { px: 44 }, hidden: true }) };
  return { calls, state, stored, cx, deps, inputs, async settle() { while (tasks.length) await Promise.all(tasks.splice(0)); } };
}

test('launcher opens a captured command for review, never runs it, and rejects stale selections', () => {
  const f = fixture(); f.stored.set(COMMANDS_KEY, { projects: [{ key: 'p', context: { root: '/other', on: 'remote' }, commands: [{ id: 'c', title: 'Build', cwd: '/other', argv: ['make'], version: 1 }], runs: [] }] });
  const Launcher = load('sessions-plus/launcher', f.deps), view = new Launcher(); view.init({ overlay: 'launcher' }, f.cx);
  const row = view.rows().find(r => r.kind === 'command'); view.activate(row, f.cx);
  assert.deepEqual(f.calls[0], ['run', 'pane.focus', { pane: 'original-pane' }]); assert.deepEqual(f.calls[1], ['close', 'launcher']);
  const spec = f.calls[2][1]; assert.equal(spec.props.role, 'commands'); assert.equal(spec.props.commandId, 'c'); assert.deepEqual(spec.props.context, { root: '/other', on: 'remote' });
  f.calls.length = 0; f.stored.get(COMMANDS_KEY).projects[0].commands[0].version++;
  view.activate(row, f.cx); assert.match(view.error, /changed/); assert.equal(f.calls.length, 0);
});

test('launcher discovers installed agents on the chosen machine and preserves literal launch arguments', async () => {
  const f = fixture(), Launcher = load('sessions-plus/launcher', f.deps), view = new Launcher(); view.init({ overlay: 'launcher' }, f.cx);
  view.activate(view.rows().find(r => r.action === 'new-agent'), f.cx); view.activate(view.rows().find(r => r.id === 'remote/s1'), f.cx); await f.settle();
  assert.deepEqual(f.calls[0], ['known', { on: 'remote' }]); assert.equal(view.rows().length, 1); assert(find(view.render(), 'launcher-row-agent'));
  view.activate(view.rows()[0], f.cx); assert.deepEqual(f.calls.at(-1), ['run', 'tab.new', { space: 'remote/s1', argv: ['/bin/agent', '--flag'] }]);
});

test('agents dialog keeps the full list when the sidebar is hidden/narrow and closes before focusing a live agent', () => {
  const f = fixture(); f.state.agents = [{ address: 't1', pane: 'p1', space: 's1', space_name: 'Project', tab: 'tab1', title: 'Build', program: { name: 'Agent' }, status: 'blocked', seq: 1 }];
  f.state.terminals = [{ address: 't1', state: 'live' }];
  const Agents = load('sessions-plus/live-agents', f.deps), view = new Agents(); view.init({ overlay: 'dialog' }, f.cx); const tree = view.render(f.cx);
  assert.equal(find(tree, 'agents-dialog-close'), undefined); assert.equal(find(tree, 'collapse'), undefined); assert.equal(f.calls.length, 0);
  find(tree, 'live-agent-t1').events.on_click(); assert.deepEqual(f.calls, [['close', 'dialog'], ['run', 'agent.focus', { terminal: 't1' }]]);
  f.calls.length = 0; f.state.agents = []; find(tree, 'live-agent-t1').events.on_click(); assert.deepEqual(f.calls, []);
});

test('Git overview includes the captured local working folder and honors an explicitly empty saved selection', async () => {
  const f = fixture(), deps = { ...f.deps, ...overviewModel, presetState, appHome: () => '/app',
    exec: async () => ({ code: 0, stdout: JSON.stringify({ rows: [], warnings: [], limited: false, scannedAt: 1 }) }) };
  const Overview = load('sessions-plus/git-overview', deps), view = new Overview(); view.init({ context: { root: '/focused', on: null } }, f.cx); await f.settle();
  assert.deepEqual(view.roots, ['/focused', '/repo']); assert.equal(view.error, ''); assert(find(view.render(), 'overview-repos')); assert.equal(find(view.render(), 'overview-close'), undefined);
  f.stored.set(overviewModel.GIT_OVERVIEW_KEY, { roots: [] }); const empty = new Overview(); empty.init({ context: { root: '/focused' } }, f.cx); await f.settle();
  assert.deepEqual(empty.roots, []); view.close(); empty.close();
});
