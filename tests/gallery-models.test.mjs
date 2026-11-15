import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { quotaPace, paceLabel } from '../mods/sessions-plus/quota-model.js';
import { launcherRows, searchScore, sameLauncherTarget } from '../mods/sessions-plus/launcher-model.js';
import { launcherKeys } from '../configure-launcher.mjs';
import { parseGitStatus, repositoryNeedsAttention, overviewRows } from '../mods/sessions-plus/git-overview-model.js';
import { scanRepositories } from '../mods/sessions-plus/git-overview.mjs';
import { editableMarkdownBlocks, editableTable, replaceMarkdownRange, replaceTableCell } from '../mods/files-plus/markdown-edit-model.js';

test('quota pace uses each window duration, retains the ten-point margin and omits unknown, expired or stale windows', () => {
  const now = 1800000000000, row = { minutes: 300, resetAt: now + 150 * 60000, used: 70 };
  assert.deepEqual(quotaPace(row, now), { elapsed: 50, difference: 20, state: 'ahead' });
  assert.equal(quotaPace({ ...row, used: 60 }, now).state, 'steady'); assert.equal(quotaPace({ ...row, used: 39 }, now).state, 'under');
  assert.equal(quotaPace({ ...row, minutes: 10080, resetAt: now + 5040 * 60000 }, now).elapsed, 50);
  for (const patch of [{ resetAt: now }, { resetAt: now - 1 }, { resetAt: now + 301 * 60000 }, { minutes: null }, { unlimited: true }, { used: NaN }]) assert.equal(quotaPace({ ...row, ...patch }, now), null);
  assert.equal(quotaPace(row, now, true), null); assert.match(paceLabel(row, now), /50% time elapsed/);
});

test('launcher searches all projects, ranks blocked agents first and rejects changed targets', () => {
  const snapshot = { agents: [{ address: 't1', title: 'Build', status: 'working' }, { address: 'remote/t2', title: 'Review', status: 'blocked' }, { address: 'gone', title: 'Gone' }],
    terminals: [{ address: 't1', state: 'live', created_ms: 1 }, { address: 'remote/t2', state: 'live', created_ms: 2 }],
    spaces: [{ id: 's1', name: 'Repository', folder: '/repo', active: true }],
    commands: { projects: [{ key: 'project', context: { root: '/repo', on: null }, runs: [], commands: [{ id: 'c1', title: 'Run tests', argv: ['npm', 'test'], cwd: '/repo', version: 1 }] }] } };
  const rows = launcherRows(snapshot); assert.equal(rows[0].address, 'remote/t2'); assert(!rows.some(r => r.title === 'Gone'));
  const command = launcherRows(snapshot, 'run tests')[0]; assert.equal(command.commandId, 'c1'); assert.equal(command.context.root, '/repo');
  assert.equal(launcherRows(snapshot, 'zzzzzz').length, 0); assert(searchScore('Repository', 'rpsy') !== null);
  assert(sameLauncherTarget(command, command)); assert(!sameLauncherTarget(command, { ...command, revision: 'changed' }));
  assert(!sameLauncherTarget(rows[0], { ...rows[0], created: 9 }));
});

test('launcher shortcut is scoped to this layout, idempotent and never replaces another binding', () => {
  const source = { global: { 'cmd-p': 'app.palette' }, 'layout:Other': { 'cmd-alt-p': 'other' } }, result = launcherKeys(source, 'Agent-Workspace');
  assert(result.changed); assert.equal(result.keys['layout:Agent-Workspace'][result.shortcut], 'sessions-plus.launcher');
  assert.equal(source['layout:Agent-Workspace'], undefined); assert.equal(launcherKeys(result.keys, 'Agent-Workspace').changed, false);
  for (const section of ['global', 'terminal', 'layout:Agent-Workspace', 'mod:sessions-plus']) {
    const conflict = launcherKeys({ [section]: { [result.shortcut]: 'existing' } }, 'Agent-Workspace'); assert.equal(conflict.conflict, section); assert.equal(conflict.changed, false);
  }
});

test('Git porcelain handles renamed paths, conflicts, detached branches, stash and unknown upstream independently', () => {
  const output = ['# branch.head (detached)', '# branch.upstream origin/main', '# branch.ab +2 -3', '# stash 4', '2 R. N... 100644 100644 100644 abc abc R100 new name', '? old name', '1 .M N... 100644 100644 100644 abc abc file', '? new\nfile', 'u UU N... 100644 100644 100644 100644 a b c conflicted', ''].join('\0');
  const row = parseGitStatus(output); assert.deepEqual(row, { branch: '(detached)', upstream: 'origin/main', ahead: 2, behind: 3, stash: 4, staged: 1, modified: 1, untracked: 1, conflicts: 1 });
  assert.equal(parseGitStatus('# branch.head main\0').ahead, null); assert(repositoryNeedsAttention({ upstream: '' }));
  assert(!repositoryNeedsAttention({ upstream: 'origin/main' }));
  assert.deepEqual(overviewRows([{ path: '/clean', upstream: 'origin/main' }, { path: '/broken', error: 'Not found' }, { path: '/edited', modified: 1 }]).map(r => r.path), ['/broken', '/edited']);
});

test('repository discovery reads real repositories without changing indexes or following unrelated symlinks', async t => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-overview-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = join(root, 'projects'), a = join(base, 'a'), b = join(base, 'nested', 'b'), outside = join(root, 'outside');
  for (const path of [a, b, outside]) { mkdirSync(path, { recursive: true }); execFileSync('git', ['init', '-q', '-b', 'main', path]); writeFileSync(join(path, 'new.txt'), 'unsaved\n'); }
  symlinkSync(outside, join(base, 'linked')); mkdirSync(join(a, 'sub'));
  const config = readFileSync(join(a, '.git/config'), 'utf8'), before = readdirSync(join(a, '.git'));
  const result = await scanRepositories({ roots: [base, join(a, 'sub')] });
  assert.deepEqual(result.rows.map(r => r.path), [a, b].map(path => realpathSync(path))); assert(result.rows.every(r => r.untracked === 1 && r.branch === 'main' && !r.error));
  assert.deepEqual(readdirSync(join(a, '.git')), before); assert.equal(readFileSync(join(a, '.git/config'), 'utf8'), config);
  assert.equal((await scanRepositories({ roots: [base], depth: 1 })).rows.length, 1);
  assert.equal((await scanRepositories({ roots: [join(root, 'missing')] })).warnings.length, 1);
  await assert.rejects(scanRepositories({ roots: ['relative'] }), /absolute/);
});

test('Markdown ranges preserve blank lines, CRLF, fenced tables and the final newline', () => {
  const source = '# Heading\r\n\r\nParagraph\r\nsecond line\r\n\r\n- first\r\n- second\r\n\r\n```md\r\n| not | table |\r\n| --- | --- |\r\n```\r\n';
  const blocks = editableMarkdownBlocks(source); assert.equal(blocks.map(b => b.text).join(''), source);
  assert.deepEqual(blocks.filter(b => b.kind !== 'space').map(b => b.kind), ['heading', 'paragraph', 'list', 'code']);
  const range = blocks.find(b => b.kind === 'paragraph'), edit = replaceMarkdownRange(source, range, 'Changed\nsecond line\n');
  assert.equal(edit.source, source.replace('Paragraph', 'Changed')); assert.equal(edit.range.text, 'Changed\r\nsecond line\r\n');
  assert.throws(() => replaceMarkdownRange('Changed elsewhere' + source, range, 'overwrite'), /changed/);
  assert.equal(replaceMarkdownRange('No newline', editableMarkdownBlocks('No newline')[0], 'Edited').source, 'Edited');
});

test('Markdown cell edits keep row alignment, surrounding whitespace, escaped pipes and other cells intact', () => {
  const table = '| Name | Value |\r\n| :--- | ---: |\r\n| `a|b` | left\\|right |\r\n';
  const rows = editableTable(table); assert.equal(rows[1][0].value, '`a|b`'); assert.equal(rows[1][1].value, 'left\\|right');
  assert.equal(replaceTableCell(table, 1, 1, 'new|value'), table.replace('left\\|right', 'new\\|value'));
  assert.equal(replaceTableCell(table, 0, 0, 'Title'), table.replace('Name', 'Title'));
  assert.equal(editableTable('| A | B |\n| --- | --- |\n| one |\n'), null);
});
