// Pure bounded preview parsing shared by the native view and helper tests.
export const TEXT_LIMIT = 400000;
export const PREVIEW_FONT_KEY = 'files-plus.preview-font-size.v1';
export function previewFontSize(value) {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? Math.max(10, Math.min(24, Math.round(size))) : 12;
}
export const IMAGE_LIMIT = 16 * 1024 * 1024;
export const TABLE_ROWS = 500, TABLE_COLUMNS = 40;
export function fileKind(path) {
  const ext = String(path).split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return 'image';
  if (['md', 'markdown', 'mdown'].includes(ext)) return 'markdown';
  if (ext === 'json') return 'json';
  if (ext === 'csv' || ext === 'tsv') return ext;
  if (ext === 'pdf') return 'unsupported';
  return 'source';
}
export function parseDelimited(text, delimiter = ',', rowLimit = TABLE_ROWS, columnLimit = TABLE_COLUMNS) {
  const rows = []; let row = [], cell = '', quoted = false, atStart = true, truncated = false;
  function finishCell() { if (row.length < columnLimit) row.push(cell); else truncated = true; cell = ''; atStart = true; }
  function finishRow() { finishCell(); if (rows.length < rowLimit) rows.push(row); else truncated = true; row = []; }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"' && atStart) { quoted = true; atStart = false; }
    else if (c === delimiter) finishCell();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      finishRow(); if (rows.length >= rowLimit && i + 1 < text.length) { truncated = true; break; }
    } else { cell += c; atStart = false; }
  }
  if (row.length || cell || !atStart) finishRow();
  return { rows, truncated, error: quoted ? 'Unclosed quoted field; showing the available content' : null };
}
export function jsonRows(value, expanded, limit = 1000) {
  const rows = []; let limited = false;
  function visit(item, key, path, depth) {
    if (rows.length >= limit || depth > 40) { limited = true; return; }
    const branch = item !== null && typeof item === 'object', keys = branch ? Object.keys(item) : [];
    rows.push({ key, path, depth, branch, open: expanded.has(path), value: branch ? `${Array.isArray(item) ? 'Array' : 'Object'} (${keys.length})` : JSON.stringify(item) });
    if (branch && expanded.has(path)) for (const child of keys) {
      if (rows.length >= limit) { limited = true; break; }
      visit(item[child], child, `${path}/${child.replace(/~/g, '~0').replace(/\//g, '~1')}`, depth + 1);
    }
  }
  visit(value, '$', '$', 0);
  return { rows, limited };
}
export function lineExcerpt(text, line, radius = 8) {
  const lines = text.split('\n'), selected = Math.max(1, Math.min(lines.length, Number(line) || 1));
  const start = Math.max(0, selected - radius - 1), end = Math.min(lines.length, selected + radius);
  return { selected, start: start + 1, rows: lines.slice(start, end).map((text, i) => ({ line: start + i + 1, text: text.replace(/\r$/, '') })) };
}

// The native text view renders image labels as links; assets load only in image preview.
export function markdownForPreview(text) {
  let fence = null;
  const imagesAsLinks = value => value.replace(/!\[/g, '[').replace(/<img\b[^>]*>/gi, '[Image]');
  return text.split('\n').map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return line;
    }
    if (fence) return line;
    let cursor = 0, rendered = '';
    for (const code of line.matchAll(/(`+)(.*?)\1/g)) {
      rendered += imagesAsLinks(line.slice(cursor, code.index)) + code[0]; cursor = code.index + code[0].length;
    }
    return rendered + imagesAsLinks(line.slice(cursor));
  }).join('\n');
}
