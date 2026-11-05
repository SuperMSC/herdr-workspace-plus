import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { searchProject } from '../mods/files-plus/search-helper.mjs';
import { searchArgs, groupedMatches, parseSearchOutput, fileMatcher } from '../mods/files-plus/search-model.js';
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'herdr-search-')); t.after(() => rm(root, { recursive: true, force: true })); await mkdir(join(root, '.git')); await mkdir(join(root, 'src')); await writeFile(join(root, 'src/a.js'), 'Needle\nneedle\nneedles\n中文 needle\n'); await writeFile(join(root, 'src/b.txt'), 'needle\n'); await writeFile(join(root, '.hidden'), 'needle\n'); return root; }

test('search argv separates user regex, path globs and shell metacharacters', () => {
  const args = searchArgs({ query: '-n; $(touch nope)', include: 'src/**, *.js', exclude: 'vendor/**', caseSensitive: true, regex: false, wholeWord: true });
  assert.equal(args[0], '--no-config'); assert.deepEqual(args.slice(-3), ['--', '-n; $(touch nope)', '.']); assert(args.includes('--case-sensitive')); assert(args.includes('--fixed-strings')); assert(args.includes('--word-regexp')); assert(args.includes('!vendor/**'));
});
test('real rg content search supports case, word, regex, globs, Unicode and grouping', async t => {
  const root = await fixture(t);
  let result = await searchProject({ root, query: 'needle', include: '*.js', wholeWord: true }); assert.equal(result.matches.length, 3); assert.equal(groupedMatches(result.matches).length, 1); assert.equal(result.matches.at(-1).text, '中文 needle');
  result = await searchProject({ root, query: '^Needle$', regex: true, caseSensitive: true }); assert.equal(result.matches.length, 1); assert.equal(result.matches[0].line, 1);
  result = await searchProject({ root, query: 'needle', exclude: '*.js' }); assert.deepEqual(result.matches.map(match => match.path), ['src/b.txt']);
  result = await searchProject({ root, query: 'needle', hidden: true, exclude: 'src/**' }); assert.deepEqual(result.matches.map(match => match.path), ['.hidden']);
  await assert.rejects(() => searchProject({ root, query: '[', regex: true }), /regex parse error/);
});
test('file-name search keeps newline paths intact and literal queries remain literal', async t => {
  const root = await fixture(t); await writeFile(join(root, 'src/hello\nworld.js'), '');
  const result = await searchProject({ root, query: 'hello', mode: 'files' }); assert.equal(result.matches[0].path, 'src/hello\nworld.js');
  assert(fileMatcher({ query: 'a.js', regex: false }).test('a.js')); assert(!fileMatcher({ query: 'a.js', regex: false }).test('aXjs'));
  assert.equal(parseSearchOutput('a.js\0aXjs\0', 'files', { query: 'a.js' }).matches.length, 1);
});
test('search children have a hard timeout and output cap', async t => {
  const root = await fixture(t), slow = join(root, 'slow'); await writeFile(slow, '#!/bin/sh\nexec sleep 10\n', { mode: 0o700 });
  const start = Date.now(); const timeout = await searchProject({ root, query: 'x' }, { program: slow, timeout: 50 }); assert.equal(timeout.timedOut, true); assert(Date.now() - start < 1500);
  const limited = await searchProject({ root, query: 'needle' }, { outputLimit: 10 }); assert.equal(limited.limited, true);
});
