import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../mods/files-plus/mermaid.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export async function', 'async function') + '\nreturn { renderDiagrams };';
function client(fail = false) {
  const files = new Map(), calls = [], removed = [];
  const dependencies = {
    appHome: () => '/app with spaces', mkdir: async () => {},
    writeTextFile: async (path, text, expected) => { assert.equal(expected, null); assert(!files.has(path)); files.set(path, text); },
    unlink: async path => { files.delete(path); removed.push(path); },
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      const file = '/app with spaces/data/files-plus-diagrams/jobs/' + args[2];
      const request = JSON.parse(files.get(file)); assert.equal(request.sources.length, 2);
      if (fail) throw new Error('render timed out');
      return { code: 0, stdout: JSON.stringify({ results: request.sources.map(() => ({ media: { path: 'data/files-plus-diagrams/diagram-1790000000000-0123456789abcdef.svg', width: 300, height: 120 } })) }) };
    }
  };
  return { ...new Function(...Object.keys(dependencies), source)(...Object.values(dependencies)), files, calls, removed };
}
const blocks = [{ source: 'flowchart LR\nA-->B', closed: true }, { source: 'sequenceDiagram\nA->>B: hi', closed: true }];
test('one client invocation renders a whole document batch and removes its temporary body', async () => {
  const state = client(), result = await state.renderDiagrams(blocks, { font: 'Arial' });
  assert.equal(result.length, 2); assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].command, 'node'); assert.equal(state.calls[0].options.timeout, 15000);
  assert.equal(state.calls[0].args[0], '/app with spaces/mods/files-plus/mermaid-helper.mjs');
  assert.equal(state.files.size, 0); assert.equal(state.removed.length, 1);
});
test('a timed-out renderer keeps no temporary request and never retries automatically', async () => {
  const state = client(true); await assert.rejects(state.renderDiagrams(blocks, {}), /timed out/);
  assert.equal(state.calls.length, 1); assert.equal(state.files.size, 0); assert.equal(state.removed.length, 1);
});
