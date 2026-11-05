// Literal, Unicode-aware matching within the text already loaded for preview.
export function findInText(text, query, caseSensitive = false, limit = 1000) {
  const lines = String(text ?? "").split("\n").map(line => line.replace(/\r$/, ""));
  const matches = [], byLine = new Map();
  if (!query) return { lines, matches, byLine, limited: false };
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "gu" : "giu");
  for (let row = 0; row < lines.length; row++) {
    pattern.lastIndex = 0;
    for (let hit; (hit = pattern.exec(lines[row]));) {
      if (matches.length === limit) return { lines, matches, byLine, limited: true };
      const match = { index: matches.length, row, start: hit.index, end: hit.index + hit[0].length };
      matches.push(match);
      if (!byLine.has(row)) byLine.set(row, []);
      byLine.get(row).push(match);
    }
  }
  return { lines, matches, byLine, limited: false };
}

export function highlightedLine(text, matches = [], active = -1, width = 2000) {
  const selected = matches.find(match => match.index === active) || matches[0];
  const start = Math.max(0, (selected?.start || 0) - Math.floor(width / 3));
  const end = Math.min(text.length, Math.max(start + width, selected?.end || 0));
  const parts = []; let cursor = start;
  if (start) parts.push({ text: "…", match: false });
  for (const match of matches) {
    if (match.end <= start || match.start >= end) continue;
    if (match.start > cursor) parts.push({ text: text.slice(cursor, match.start), match: false });
    parts.push({ text: text.slice(Math.max(start, match.start), Math.min(end, match.end)), match: true, active: match.index === active });
    cursor = Math.min(end, match.end);
  }
  if (cursor < end) parts.push({ text: text.slice(cursor, end), match: false });
  if (end < text.length) parts.push({ text: "…", match: false });
  return parts.length ? parts : [{ text: " ", match: false }];
}
