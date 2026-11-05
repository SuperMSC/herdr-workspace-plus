import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { resolveRipgrep } from '../mods/files-plus/search-program.mjs';
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'herdr-rg-resolver-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function fake(path, version = 'ripgrep 99.0.0') { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o700 }); return path; }
function options(home, extra = {}) { return { home, env: { PATH: '' }, commonPaths: [], ...extra }; }

test('resolver uses PATH first and verifies executable identity, not just its filename', async t => {
  const home = await fixture(t), bad = await fake(join(home, 'bad/rg'), 'another tool'), good = await fake(join(home, 'good/rg'));
  assert.equal(resolveRipgrep(options(home, { env: { PATH: `${dirname(bad)}:${dirname(good)}` } })), good);
  await chmod(good, 0o600);
  assert.throws(() => resolveRipgrep(options(home, { env: { PATH: dirname(good) } })), /not found/);
});
test('resolver supports common paths and explicit overrides without falling back from a broken override', async t => {
  const home = await fixture(t), common = await fake(join(home, 'common/rg')), custom = await fake(join(home, 'custom/my-rg'));
  assert.equal(resolveRipgrep(options(home, { commonPaths: [common] })), common);
  assert.equal(resolveRipgrep(options(home, { override: custom, commonPaths: [common] })), custom);
  assert.equal(resolveRipgrep(options(home, { override: '~/custom/my-rg' })), custom);
  assert.throws(() => resolveRipgrep(options(home, { override: join(home, 'missing'), commonPaths: [common] })), /configured rg executable/);
});
test('resolver finds the stable Codex current link with an empty PATH and follows future upgrades', async t => {
  const home = await fixture(t), standalone = join(home, '.codex/packages/standalone');
  const old = join(standalone, 'releases/arbitrary-old'), next = join(standalone, 'releases/arbitrary-new');
  await fake(join(old, 'codex-path/rg')); await symlink(old, join(standalone, 'current'));
  const stable = join(standalone, 'current/codex-path/rg'); assert.equal(resolveRipgrep(options(home)), stable);
  await fake(join(next, 'codex-path/rg')); await rm(join(standalone, 'current')); await symlink(next, join(standalone, 'current'));
  assert.equal(resolveRipgrep(options(home)), stable);
});
test('resolver honors custom CODEX_HOME and discovers releases when current is missing', async t => {
  const home = await fixture(t), codex = join(home, 'custom-codex');
  const bundled = await fake(join(codex, 'packages/standalone/releases/any-version/codex-path/rg'));
  assert.equal(resolveRipgrep(options(home, { env: { PATH: '', CODEX_HOME: codex } })), bundled);
});
test('resolver gives a slow first run of a real ripgrep time to answer', async t => {
  const home = await fixture(t), rg = await fake(join(home, 'slow/rg'));
  const seen = [];
  const probe = (file, args, options) => { seen.push(options.timeout); return { status: 0, stdout: 'ripgrep 14.1.0\n' }; };
  assert.equal(resolveRipgrep(options(home, { env: { PATH: dirname(rg) }, probe })), rg);
  assert(seen.every(timeout => timeout >= 5000), `probe timeout ${seen}`);
});
