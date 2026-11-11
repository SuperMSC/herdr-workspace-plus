import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as model from '../mods/project-spaces/model.js';

function fixture(props = { unified: true }, mode = 'project') {
  const calls = [], shared = new Map([[model.STATE_KEY, { mode, groups: {}, assign: {}, folded: [] }]]);
  const spaces = [{ id: 's', name: 'Demo', folder: '/demo/repo', machine: null, active: true, status: 'working', tabs: [{ id: 'tab', name: 'Task', named: true }] }];
  const agents = [{ address: 't1', space: 's', tab: 'tab', pane: 'p', status: 'working' }], terminals = [{ address: 't1', state: 'live', created_ms: 1, argv: ['claude'], cwd: '/demo/repo' }], panes = [{ pane: 'p', terminal: 't1', tab: 'tab', cwd: '/demo/repo' }], focus = { space: 's', tab: 'tab', pane: 'p', terminal: 't1' };
  const input = { on() {}, release() { calls.push('release'); } };
  const dependencies = { ...model, View: class {}, props: () => props, shared: key => shared.get(key), setShared: (key, value) => shared.set(key, value), privacyGuard: () => null,
    spaces: () => spaces, agents: () => agents, terminals: () => terminals, panes: () => panes, focused: () => focus, machines: () => [], layout: () => ({ id: 'sidebar', size: { px: 268 } }), home: () => '/demo', theme: () => ({}),
    InputState: { new: () => input }, UnifiedSidebar: class { init(p) { calls.push(['init', p]); } render(frame, owner, cx) { calls.push(['render', frame, owner, cx]); return 'UNIFIED'; } close() { calls.push('close'); } },
    Menu: class { init(p) { calls.push(['menu', p]); } render() { return 'MENU'; } }, Prompt: class {}, run: (...args) => calls.push(['run', ...args]), exec: () => { throw Error('No automatic execution'); }, openMenu: (...args) => calls.push(['open-menu', ...args]), menuRows: () => 1,
  };
  const source = readFileSync(new URL('../mods/project-spaces/main.js', import.meta.url), 'utf8').replace(/^import[\s\S]*?;\n/gm, '').replace('export default class', 'return class');
  const Sidebar = new Function(...Object.keys(dependencies), source)(...Object.values(dependencies)), sidebar = new Sidebar(), cx = { timer: { every() {} }, notify() {} };
  sidebar.init({}, cx);
  return { sidebar, cx, calls, shared, spaces, agents, terminals, panes, focus };
}

test('unified main passes one complete machine-aware snapshot and canonical project groups in both views', () => {
  for (const mode of ['project', 'status']) {
    const f = fixture(undefined, mode), before = JSON.stringify(f.shared.get(model.STATE_KEY));
    assert.equal(f.sidebar.render(f.cx), 'UNIFIED');
    const [, frame, owner, cx] = f.calls.find(call => call[0] === 'render');
    assert.equal(owner, f.sidebar); assert.equal(cx, f.cx); assert.equal(frame.state.mode, mode);
    assert.equal(frame.groups[0].name, 'repo'); assert.equal(frame.fullGroups, frame.groups);
    assert.deepEqual(frame.snapshots, { spaces: f.spaces, agents: f.agents, terminals: f.terminals, panes: f.panes, focus: f.focus });
    assert.equal(frame.density, 'detailed'); assert.equal(f.sidebar.lastRows.length, 1); assert.equal(JSON.stringify(f.shared.get(model.STATE_KEY)), before);
    assert(!f.calls.some(call => call[0] === 'run'));
    f.sidebar.viewMenu(); assert.equal(f.calls.find(call => call[0] === 'open-menu')[2].unified, true);
    f.sidebar.close(f.cx); assert(f.calls.includes('close')); assert(f.calls.includes('release'));
  }
});

test('unified menu roles bypass sidebar initialization and legacy ungrouped mode migrates only its display preference', () => {
  const menu = fixture({ role: 'view-menu', unified: true }); assert.equal(menu.sidebar.render(menu.cx), 'MENU'); assert(!menu.calls.some(call => call[0] === 'init'));
  const legacy = fixture(undefined, 'none'); assert.equal(legacy.sidebar.state().mode, 'project'); assert.deepEqual(legacy.sidebar.state().assign, {});
});

test('unified group folding uses its tree callback while legacy groups retain persistent folding',()=>{
 const f=fixture();f.sidebar.render(f.cx);const group=f.sidebar.lastGroups[0],before=JSON.stringify(f.shared.get(model.STATE_KEY));let folded=0;
 f.sidebar.drag={kind:'group',id:group.key};f.sidebar.dropOnGroup({...group,onFold:cx=>{assert.equal(cx,f.cx);folded++;}},f.cx);assert.equal(folded,1);assert.equal(JSON.stringify(f.shared.get(model.STATE_KEY)),before);assert.equal(f.sidebar.drag,null);
 f.sidebar.drag={kind:'group',id:group.key};f.sidebar.dropOnGroup(group,f.cx);assert(f.sidebar.state().folded.includes(group.key));
});
