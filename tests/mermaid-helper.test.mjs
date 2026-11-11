import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderBatch, renderRequest } from '../mods/files-plus/mermaid-helper.mjs';
import { diagramLook, DIAGRAM_CACHE_FOLDER } from '../mods/files-plus/mermaid-model.js';
const execute = promisify(execFile);
const complex = 'flowchart LR\n' + Array.from({ length: 4 }, (_, group) => 'subgraph Group' + group + '\n' + Array.from({ length: 10 }, (_, index) => { const n = group * 10 + index; return `N${n}[Step ${n}] --> N${n + 1}[Step ${n + 1}]`; }).join('\n') + '\nend').join('\n');
const sources = [complex, 'sequenceDiagram\nAlice->>Bob: Hello', 'stateDiagram-v2\n[*] --> Ready\nReady --> Done', 'classDiagram\nclass Document {\n+save()\n}\nDocument --> Draft', 'erDiagram\nUSER ||--o{ FILE : owns'];
async function fixture(t) { const root = await fs.mkdtemp(path.join(tmpdir(), 'herdr-diagrams ')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }

test('real helper renders one batch containing a 41-node grouped graph and four other families', async t => {
  const root = await fixture(t), folder = path.join(root, DIAGRAM_CACHE_FOLDER, 'jobs'); await fs.mkdir(folder, { recursive: true });
  const job = `job-${Date.now()}-1-test.json`, file = path.join(folder, job);
  await fs.writeFile(file, JSON.stringify({ sources: sources.map(source => ({ source, closed: true })), look: diagramLook({}, 'Arial') }));
  const helper = new URL('../mods/files-plus/mermaid-helper.mjs', import.meta.url);
  const result = JSON.parse((await execute(process.execPath, [helper.pathname, root, job], { timeout: 15000 })).stdout);
  assert.equal(result.results.length, 5);
  for (const item of result.results) {
    assert(item.media, item.error); assert(item.media.width > 0 && item.media.height > 0);
    const svg = await fs.readFile(path.join(root, item.media.path), 'utf8'); assert.match(svg, /^<svg/); assert.doesNotMatch(svg, /@import|var\(|color-mix\(/);
  }
  assert.equal(await fs.stat(file).catch(() => null), null); assert.deepEqual(await fs.readdir(folder), []);
});

test('errors are isolated per diagram and job text is removed before validation or layout', async t => {
  const root = await fixture(t), folder = path.join(root, DIAGRAM_CACHE_FOLDER, 'jobs'); await fs.mkdir(folder, { recursive: true });
  const job = `job-${Date.now()}-2-invalid.json`, file = path.join(folder, job);
  await fs.writeFile(file, JSON.stringify({ sources: [{ source: 'pie\n"one":2', closed: true }, { source: 'flowchart LR\nA-->B', closed: false }, { source: 'flowchart LR\nA-->B', closed: true }], look: diagramLook() }));
  const result = await renderRequest(root, job);
  assert.match(result.results[0].error, /Supported/); assert.match(result.results[1].error, /Unclosed/); assert(result.results[2].media);
  assert.equal(await fs.stat(file).catch(() => null), null);
  await fs.writeFile(file, '{bad JSON'); await assert.rejects(renderRequest(root, job)); assert.equal(await fs.stat(file).catch(() => null), null);
  await assert.rejects(renderBatch(root, new Array(25).fill({ source: '', closed: true }), diagramLook()), /At most 24/);
});

test('helper refuses a symlink cache and preserves unrelated files during cleanup', async t => {
  const root = await fixture(t), outside = path.join(root, 'outside'), cache = path.join(root, DIAGRAM_CACHE_FOLDER);
  await fs.mkdir(outside); await fs.mkdir(path.dirname(cache)); await fs.symlink(outside, cache);
  await assert.rejects(renderBatch(root, [{ source: 'flowchart LR\nA-->B', closed: true }], diagramLook()), /owned directory/);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(cache); await fs.mkdir(cache);
  await fs.writeFile(path.join(cache, 'user.svg'), 'preserve');
  await fs.writeFile(path.join(cache, 'diagram-1700000000000-0123456789abcdef.svg'), 'expired');
  const result = await renderBatch(root, [{ source: 'flowchart LR\nA-->B', closed: true }], diagramLook()); assert(result[0].media);
  assert.equal(await fs.readFile(path.join(cache, 'user.svg'), 'utf8'), 'preserve');
  assert.equal(await fs.stat(path.join(cache, 'diagram-1700000000000-0123456789abcdef.svg')).catch(() => null), null);
});
