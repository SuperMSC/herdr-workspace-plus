// Resolve an installed ripgrep without relying on the GUI app's abbreviated PATH.
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const COMMON = ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg'];
function pathCandidates(name, env) { return String(env.PATH || '').split(delimiter).filter(Boolean).map(folder => resolve(folder, name)); }
function usable(candidate, env, probe) {
  try {
    accessSync(candidate, constants.X_OK); if (!statSync(candidate).isFile()) return false;
    const result = probe(candidate, ['--version'], { encoding: 'utf8', env, timeout: 1000, maxBuffer: 16384 });
    return result.status === 0 && /^ripgrep\s+\d/m.test(result.stdout || '');
  } catch { return false; }
}
export function resolveRipgrep({ override, env = process.env, home = homedir(), cwd = process.cwd(), commonPaths = COMMON, probe = spawnSync } = {}) {
  let candidates;
  if (override !== undefined && override !== null && override !== '') {
    if (typeof override !== 'string') throw new Error('The configured rg path must be a string');
    const value = override.startsWith('~/') ? join(home, override.slice(2)) : override;
    candidates = isAbsolute(value) || /[/\\]/.test(value) ? [resolve(cwd, value)] : pathCandidates(value, env);
  } else {
    const codexHome = env.CODEX_HOME || join(home, '.codex'), standalone = join(codexHome, 'packages', 'standalone');
    candidates = [...pathCandidates('rg', env), ...commonPaths, join(home, '.local', 'bin', 'rg'), join(standalone, 'current', 'codex-path', 'rg')];
    // `current` is the stable updater-managed symlink. Bounded release discovery
    // also handles an interrupted update without embedding a particular version.
    const releases = join(standalone, 'releases');
    try {
      const directories = readdirSync(releases, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => ({ path: join(releases, entry.name), modified: statSync(join(releases, entry.name)).mtimeMs })).sort((a, b) => b.modified - a.modified).slice(0, 10);
      candidates.push(...directories.map(item => join(item.path, 'codex-path', 'rg')));
    } catch { /* No standalone distribution is installed. */ }
  }
  for (const candidate of new Set(candidates)) if (usable(candidate, env, probe)) return candidate;
  throw new Error(override ? 'The configured rg executable is unavailable or is not ripgrep' : 'ripgrep (rg) was not found in PATH or known installation folders; set props.rg to its executable path');
}
