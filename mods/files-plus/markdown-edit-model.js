// Source ranges stay lossless. Only the selected range is replaced on edit.
function linesOf(text) {
  const rows = []; let start = 0;
  for (const raw of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    rows.push({ start, end: start + raw.length, text: raw.replace(/\r?\n$/, '') }); start += raw.length;
  }
  return rows;
}
const fence = text => /^ {0,3}(`{3,}|~{3,})/.exec(text);
const heading = text => /^ {0,3}#{1,6}\s/.test(text);
const list = text => /^\s*(?:[-+*]|\d+[.)])\s/.test(text);
function cellsOf(line) {
  const cuts = []; let ticks = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '`') { let n = 1; while (line[i + n] === '`') n++; ticks = ticks === n ? 0 : ticks || n; i += n - 1; continue; }
    if (line[i] === '|' && !ticks) cuts.push(i);
  }
  if (!cuts.length) return null;
  const bounds = [-1, ...cuts, line.length];
  const cells = bounds.slice(0, -1).map((a, i) => {
    const b = bounds[i + 1], raw = line.slice(a + 1, b), left = raw.length - raw.trimStart().length;
    return { start: a + 1 + left, end: Math.max(a + 1 + left, b - (raw.length - raw.trimEnd().length)), value: raw.trim() };
  });
  if (!line.slice(0, cuts[0]).trim()) cells.shift();
  if (!line.slice(cuts.at(-1) + 1).trim()) cells.pop();
  return cells;
}
const alignment = line => {
  const cells = cellsOf(line); return cells?.length && cells.every(cell => /^:?-{3,}:?$/.test(cell.value));
};
export function editableMarkdownBlocks(text, offset = 0) {
  const lines = linesOf(text), blocks = []; let i = 0;
  while (i < lines.length) {
    const start = i, opening = fence(lines[i].text); let kind = 'paragraph';
    if (!lines[i].text.trim()) { kind = 'space'; while (i < lines.length && !lines[i].text.trim()) i++; }
    else if (opening) {
      kind = 'code'; i++;
      const closing = new RegExp('^ {0,3}' + opening[1][0] + '{' + opening[1].length + ',}\\s*$');
      while (i < lines.length) { if (closing.test(lines[i++].text)) break; }
    } else if (i + 1 < lines.length && cellsOf(lines[i].text) && alignment(lines[i + 1].text)) {
      kind = 'table'; i += 2; while (i < lines.length && lines[i].text.trim() && cellsOf(lines[i].text)) i++;
    } else if (heading(lines[i].text)) { kind = 'heading'; i++; }
    else {
      kind = list(lines[i].text) ? 'list' : 'paragraph'; i++;
      while (i < lines.length && lines[i].text.trim() && !fence(lines[i].text) && !heading(lines[i].text)) {
        if (kind === 'paragraph' && list(lines[i].text)) break;
        if (i + 1 < lines.length && cellsOf(lines[i].text) && alignment(lines[i + 1].text)) break;
        i++;
      }
    }
    const from = lines[start].start, to = lines[i - 1].end;
    blocks.push({ start: offset + from, end: offset + to, text: text.slice(from, to), kind });
  }
  if (!blocks.length) blocks.push({ start: offset, end: offset, text: '', kind: 'paragraph' });
  return blocks;
}
export function editableTable(text) {
  const lines = linesOf(text);
  if (lines.length < 2 || !alignment(lines[1].text) || lines.length > 41) return null;
  const width = cellsOf(lines[0].text)?.length;
  if (!width || width > 20 || width * (lines.length - 1) > 300 || cellsOf(lines[1].text).length !== width) return null;
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === 1) continue;
    const cells = cellsOf(lines[i].text); if (cells?.length !== width) return null;
    rows.push(cells.map(cell => ({ ...cell, start: lines[i].start + cell.start, end: lines[i].start + cell.end })));
  }
  return rows;
}
export function replaceMarkdownRange(source, range, value) {
  if (source.slice(range.start, range.end) !== range.text) throw new Error('This block changed. Close it and select the current block.');
  const eol = source.includes('\r\n') ? '\r\n' : '\n', text = value.replace(/\r?\n/g, eol);
  return { source: source.slice(0, range.start) + text + source.slice(range.end), range: { ...range, text, end: range.start + text.length } };
}
export function replaceTableCell(text, row, column, value) {
  const cell = editableTable(text)?.[row]?.[column]; if (!cell) throw new Error('This table changed. Reopen its editor.');
  // Keep Markdown syntax visible; escape only newly entered, unescaped pipes.
  const encoded = value.replace(/[\r\n]+/g, ' ').replace(/\\[\s\S]|\|/g, part => part === '|' ? '\\|' : part);
  return text.slice(0, cell.start) + encoded + text.slice(cell.end);
}
