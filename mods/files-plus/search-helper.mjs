// Bounded ripgrep runner. Superseded UI results are ignored; every child is time-limited.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchArgs, fileMatcher, SEARCH_LIMIT } from './search-model.js';
import { resolveRipgrep } from './search-program.mjs';
export function searchProject(options, { program, timeout = 8000, outputLimit = 2 * 1024 * 1024 } = {}) {
  if (!options.root || typeof options.query !== 'string') return Promise.reject(new Error('A folder and search text are required'));
  const executable = program || resolveRipgrep({ override: options.rg, cwd: options.root });
  const matcher = options.mode === 'files' ? fileMatcher(options) : null;
  return new Promise((resolveResult, reject) => {
    const matches = []; let pending = '', errorText = '', total = 0, limited = false, timedOut = false, killTimer;
    const child = spawn(executable, searchArgs(options), { cwd: options.root, stdio: ['ignore', 'pipe', 'pipe'] });
    function stop() { child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 200); }
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    function accept(record) {
      if (!record) return;
      let match;
      if (matcher) { const path = record.replace(/^\.\//, ''); if (matcher.test(path)) match = { path, line: null, text: '' }; }
      else { try { const event = JSON.parse(record); if (event.type === 'match') {
        const data = event.data, decode = field => typeof field?.text === 'string' ? field.text : field?.bytes ? Buffer.from(field.bytes, 'base64').toString('utf8') : '';
        match = { path: decode(data.path).replace(/^\.\//, ''), line: data.line_number, text: decode(data.lines).replace(/[\r\n]+$/, '').slice(0, 2000) };
      } } catch { return; } }
      if (match) { if (matches.length < SEARCH_LIMIT) matches.push(match); else { limited = true; stop(); } }
    }
    child.stdout.on('data', chunk => {
      total += Buffer.byteLength(chunk); if (total > outputLimit) { limited = true; stop(); return; }
      pending += chunk; const separator = matcher ? '\0' : '\n'; let end;
      while ((end = pending.indexOf(separator)) >= 0) { accept(pending.slice(0, end)); pending = pending.slice(end + 1); if (limited) break; }
    });
    child.stderr.on('data', chunk => { if (errorText.length < 16000) errorText += chunk; });
    child.on('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(new Error(error.code === 'ENOENT' ? 'ripgrep (rg) is not available' : error.message)); });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (pending && !limited) accept(pending);
      clearTimeout(killTimer);
      if (code > 1 && !limited && !timedOut) reject(new Error(errorText.trim() || `Search exited with code ${code}`));
      else resolveResult({ matches, limited, timedOut, warning: timedOut ? 'Search stopped after 8 seconds; narrow the folder or file filter' : limited ? 'Search limited to 500 matches or 2 MiB of results' : errorText.trim() || null });
    });
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await searchProject(JSON.parse(process.argv[2])))); }
  catch (error) { console.log(JSON.stringify({ error: error.message })); process.exitCode = 1; }
}
