// Search arguments are always separate argv values, never shell interpolation.
export const SEARCH_LIMIT = 500;
export function globLines(value) { return String(value || '').split(/[\n,]/).map(v => v.trim()).filter(Boolean).slice(0, 24); }
export function searchArgs(options) {
  const args = options.mode === 'files' ? ['--files', '-0'] : ['--json', '--line-number', '--max-count', '30', '--max-filesize', '2M'];
  args.unshift('--no-config');
  args.push('--glob', '!.git/**');
  if (options.hidden) args.push('--hidden');
  for (const glob of globLines(options.include)) args.push('--glob', glob);
  for (const glob of globLines(options.exclude)) args.push('--glob', `!${glob}`);
  if (options.mode !== 'files') {
    args.push(options.caseSensitive ? '--case-sensitive' : '--ignore-case');
    if (!options.regex) args.push('--fixed-strings');
    if (options.wholeWord) args.push('--word-regexp');
    args.push('--', options.query || '', '.');
  } else args.push('--', '.');
  return args;
}
export function fileMatcher(options) {
  const source = options.regex ? options.query : String(options.query || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = options.wholeWord ? `(^|[^\\p{L}\\p{N}_])(?:${source})(?=$|[^\\p{L}\\p{N}_])` : source;
  return new RegExp(pattern, options.caseSensitive ? 'u' : 'iu');
}
export function groupedMatches(matches) {
  const files = new Map();
  for (const match of matches) { if (!files.has(match.path)) files.set(match.path, []); files.get(match.path).push(match); }
  return [...files].map(([path, matches]) => ({ path, matches }));
}
export function parseSearchOutput(stdout, mode, options) {
  if (mode === 'files') {
    const matcher = fileMatcher(options), matches = stdout.split('\0').filter(Boolean).map(path => path.replace(/^\.\//, '')).filter(path => matcher.test(path));
    return { matches: matches.slice(0, SEARCH_LIMIT).map(path => ({ path, line: null, text: '' })), limited: matches.length > SEARCH_LIMIT };
  }
  const matches = []; let limited = false;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    try { const event = JSON.parse(line); if (event.type === 'match' && typeof event.data?.path?.text === 'string') {
      if (matches.length >= SEARCH_LIMIT) { limited = true; break; }
      matches.push({ path: event.data.path.text.replace(/^\.\//, ''), line: event.data.line_number, text: String(event.data.lines?.text || '').replace(/[\r\n]+$/, '').slice(0, 2000) });
    } } catch { /* A bounded remote output can end with an incomplete JSON record. */ }
  }
  return { matches, limited };
}
