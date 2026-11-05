import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseDelimited, jsonRows, lineExcerpt, fileKind, markdownForPreview, TEXT_LIMIT } from '../mods/files-plus/preview-model.js';
import { previewFile, cleanCache } from '../mods/files-plus/preview-helper.mjs';
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'herdr-preview-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('CSV and TSV preserve quoted delimiters, escaped quotes, CRLF and embedded newlines', () => {
  assert.deepEqual(parseDelimited('name,description,empty\r\n"a,b","one\r\ntwo ""quoted""",\r\n').rows, [['name', 'description', 'empty'], ['a,b', 'one\r\ntwo "quoted"', '']]);
  assert.deepEqual(parseDelimited('a\tb\n"x\ty"\t"line\nnext"', '\t').rows, [['a', 'b'], ['x\ty', 'line\nnext']]);
  assert.deepEqual(parseDelimited('""').rows, [['']]);
  assert.equal(parseDelimited('"unfinished').error, 'Unclosed quoted field; showing the available content');
});
test('table and JSON trees are bounded while expansion IDs escape ambiguous keys', () => {
  assert.deepEqual(parseDelimited('a,b,c\nd,e,f\ng,h,i', ',', 2, 2), { rows: [['a', 'b'], ['d', 'e']], truncated: true, error: null });
  const value = { 'a/b': { '~': 1 }, many: [1, 2, 3] }, expanded = new Set(['$', '$/a~1b', '$/many']);
  assert.equal(jsonRows(value, expanded).rows.find(row => row.key === '~').path, '$/a~1b/~0');
  assert.equal(jsonRows(value, expanded, 3).limited, true);
  assert.equal(jsonRows(value, new Set()).rows.length, 1);
});
test('preview kinds and line excerpts retain original line numbers', () => {
  assert.equal(fileKind('README.MD'), 'markdown'); assert.equal(fileKind('photo.PNG'), 'image'); assert.equal(fileKind('paper.pdf'), 'unsupported');
  const excerpt = lineExcerpt('a\nb\nc\nd', 3, 1); assert.deepEqual(excerpt, { selected: 3, start: 2, rows: [{ line: 2, text: 'b' }, { line: 3, text: 'c' }, { line: 4, text: 'd' }] });
});
test('local text preview bounds UTF-8 reads and locates search lines beyond its source limit', async t => {
  const root = await fixture(t), path = 'large.txt';
  await writeFile(join(root, path), 'x'.repeat(TEXT_LIMIT - 1) + '中文\nTARGET\nend');
  const value = await previewFile({ root, path, appHome: root, line: 2 });
  assert.equal(value.truncated, true); assert.equal(value.text.includes('\ufffd'), false); assert.equal(value.excerpt.selected, 2); assert.equal(value.excerpt.rows[1].text, 'TARGET');
  await assert.rejects(() => previewFile({ root, path: '../escape.txt', appHome: root }), /outside/);
  const fromRoot = await previewFile({ root: '/', path: join(root, path).slice(1), appHome: root }); assert.equal(fromRoot.text, value.text);
  await writeFile(join(root, 'binary.dat'), Buffer.from([1, 0, 2])); await assert.rejects(() => previewFile({ root, path: 'binary.dat', appHome: root }), /Binary file/);
});
test('images cache only under app home, refresh when source changes and old cache entries expire', async t => {
  const root = await fixture(t), path = 'sample.png'; const png = Buffer.alloc(24); png.write('PNG', 1); png.writeUInt32BE(200, 16); png.writeUInt32BE(100, 20);
  await writeFile(join(root, path), png);
  const first = await previewFile({ root, path, appHome: root }); assert.equal(first.width, 200); assert.equal(first.height, 100); assert.match(first.image, /^data\/files-plus-preview\/[a-f0-9]{32}\.png$/);
  assert.deepEqual(await readFile(join(root, first.image)), png);
  await writeFile(join(root, path), Buffer.concat([png, Buffer.from([1])])); const next = await previewFile({ root, path, appHome: root }); assert.notEqual(next.image, first.image);
  const cache = join(root, 'data/files-plus-preview'), old = join(cache, first.image.split('/').at(-1)); await utimes(old, new Date(0), new Date(0));
  await writeFile(join(cache, 'user-file.txt'), 'preserve'); await cleanCache(cache);
  assert.deepEqual((await readdir(cache)).sort(), [next.image.split('/').at(-1), 'user-file.txt'].sort());
});

test('Markdown image resources become links without changing code samples', () => {
  const text = '![Image](https://example.com/a.png)\n`![code](x)`\n```md\n![code](x)\n```\n<img src="https://example.com/b.png">';
  assert.equal(markdownForPreview(text), '[Image](https://example.com/a.png)\n`![code](x)`\n```md\n![code](x)\n```\n[Image]');
});
