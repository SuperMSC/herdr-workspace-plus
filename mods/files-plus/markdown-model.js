// Markdown structure and project-local navigation. Source offsets always refer to untouched text.
export const HEADING_LIMIT = 200;
export const DIAGRAM_LIMIT = 24;
export const HISTORY_LIMIT = 40;
const fenceMarker = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const headingMarker = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/;
const indented = line => /^(?: {4}|\t)/.test(line);
const listMarker = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/;
const thematic = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

export function headingText(source) {
  return source.replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '')
    .replace(/\\([\p{P}\p{S}])/gu, '$1').replace(/[`*~]/g, '').replace(/_{1,2}([^_]+)_{1,2}/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

export function markdownStructure(text) {
  const headings = [], diagrams = [], slugs = new Set();
  let offset = 0, fence = null, paragraph = null, list = false, listBlank = false, headingsLimited = false;
  const addHeading = (value, level, start) => {
    if (headings.length >= HEADING_LIMIT) { headingsLimited = true; return; }
    const title = headingText(value), base = title.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-') || 'section';
    let slug = base, suffix = 0;
    while (slugs.has(slug)) slug = `${base}-${++suffix}`;
    slugs.add(slug); headings.push({ title: title || 'Untitled', level, slug, start });
  };
  for (const raw of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const line = raw.replace(/\r?\n$/, ''), marker = fenceMarker.exec(line), heading = headingMarker.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && !marker[2].trim()) {
        if (fence.diagram) diagrams.push({ start: fence.start, end: offset + raw.length, source: text.slice(fence.body, offset), closed: true });
        fence = null;
      }
      paragraph = null;
    } else {
      if (!line.trim()) { listBlank = list; paragraph = null; offset += raw.length; continue; }
      if (listMarker.test(line) && !thematic.test(line)) { list = true; listBlank = false; paragraph = null; offset += raw.length; continue; }
      if (list && (/^[ \t]+/.test(line) || /^ {0,3}>/.test(line) || (!listBlank && !heading && !marker && !thematic.test(line)))) { paragraph = null; offset += raw.length; continue; }
      list = false; listBlank = false;
      if (indented(line) || /^ {0,3}>/.test(line)) paragraph = null;
      else if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
        fence = { marker: marker[1], start: offset, body: offset + raw.length, diagram: marker[2].trim().toLowerCase() === 'mermaid' }; paragraph = null;
      } else if (heading) { addHeading((heading[2] || '').replace(/[ \t]+#+[ \t]*$/, ''), heading[1].length, offset); paragraph = null; }
      else if (paragraph && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) { addHeading(paragraph.text, line.trim()[0] === '=' ? 1 : 2, paragraph.start); paragraph = null; }
      else paragraph = thematic.test(line) || /^ {0,3}\[.*\]:/.test(line) ? null : paragraph ? { text: paragraph.text + ' ' + line.trim(), start: paragraph.start } : { text: line, start: offset };
    }
    offset += raw.length;
  }
  if (fence?.diagram) diagrams.push({ start: fence.start, end: text.length, source: text.slice(fence.body), closed: false });
  return { headings, diagrams, headingsLimited };
}

export function markdownBlocks(text, structure = markdownStructure(text)) {
  const events = [...structure.headings.map(heading => ({ ...heading, end: heading.start, heading })), ...structure.diagrams.slice(0, DIAGRAM_LIMIT).map(diagram => ({ ...diagram, diagram: true }))]
    .sort((a, b) => a.start - b.start || (a.heading ? -1 : 1));
  const blocks = []; let cursor = 0, heading = null;
  const pushText = end => { if (end > cursor) { blocks.push({ text: text.slice(cursor, end), heading }); heading = null; } cursor = end; };
  for (const event of events) {
    if (event.start < cursor) continue;
    pushText(event.start);
    if (event.heading) { heading = event.heading; continue; }
    blocks.push({ diagram: true, text: text.slice(event.start, event.end), source: event.source, closed: event.closed, heading }); heading = null; cursor = event.end;
  }
  pushText(text.length);
  if (!blocks.length) blocks.push({ text: '' });
  // Native TextViews parse blocks independently, so repeat reference definitions in each one.
  const definitions = []; let fence = null;
  for (const line of text.split('\n')) {
    const marker = fenceMarker.exec(line);
    if (fence) { if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null; continue; }
    if (marker) { fence = marker[1]; continue; }
    if (/^ {0,3}\[[^\]\n]+\]:/.test(line)) definitions.push(line);
  }
  if (blocks.length > 1 && definitions.length) for (const block of blocks) if (!block.diagram) block.text += '\n\n' + definitions.join('\n');
  return blocks;
}

const decode = value => { try { return decodeURIComponent(value); } catch { throw new Error('The link contains invalid percent encoding.'); } };
export function resolveMarkdownLink(root, current, href) {
  if (typeof href !== 'string' || /[\0-\x1f\x7f]/.test(href)) throw new Error('This link is not supported.');
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) return { external: href };
  if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^file:\/\//i.test(href)) throw new Error('Only project Markdown links and web links are supported.');
  if (/^file:\/\//i.test(href) && !/^file:\/\/\//i.test(href)) throw new Error('Network file links are not opened inside this preview.');
  const hash = href.indexOf('#'), rawPath = hash < 0 ? href : href.slice(0, hash), anchor = hash < 0 ? null : decode(href.slice(hash + 1));
  let path = decode(rawPath.replace(/^file:\/\//i, ''));
  if (!path) return { path: current, anchor: anchor || null };
  if (path.includes('?') || path.includes('\\')) throw new Error('This Markdown link is not a project-relative file path.');
  const normalizedRoot = root.replace(/\/+$/, '') || '/';
  if (path.startsWith('/')) {
    if (normalizedRoot === '/') path = path.slice(1);
    else if (path.startsWith(normalizedRoot + '/')) path = path.slice(normalizedRoot.length + 1);
    else throw new Error('The linked file is outside this project.');
  } else path = `${current.slice(0, Math.max(0, current.lastIndexOf('/') + 1))}${path}`;
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) throw new Error('The linked file is outside this project.'); parts.pop(); }
    else parts.push(part);
  }
  const relative = parts.join('/');
  if (!/\.(?:md|markdown|mdown)$/i.test(relative)) throw new Error('Only Markdown files open inside this preview.');
  return { path: relative, anchor: anchor || null };
}
