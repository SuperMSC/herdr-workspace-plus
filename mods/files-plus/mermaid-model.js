// Bounded Mermaid conversion for the native SVG loader. No browser CSS or network fonts.
export const DIAGRAM_CHAR_LIMIT = 24000;
export const DIAGRAM_LINE_LIMIT = 300;
export const DIAGRAM_SVG_LIMIT = 1024 * 1024;
export const DIAGRAM_CACHE_LIMIT = 48;
export const DIAGRAM_CACHE_AGE = 24 * 60 * 60 * 1000;
export const DIAGRAM_CACHE_FOLDER = 'data/files-plus-diagrams';
export const DIAGRAM_CACHE_FILE = /^diagram-\d{13}-[a-f0-9]{16}\.svg$/;
const color = (value, fallback) => /^#[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(value || '') ? value : fallback;
export function diagramLook(t = {}, font = '') {
  return { bg: color(t.background, '#202020'), fg: color(t.foreground, '#eeeeee'), line: color(t.dim, '#777777'), accent: color(t.ansi4 || t.accent, '#6699ee'), muted: color(t.muted, '#aaaaaa'), border: color(t.border, '#444444'), surface: color(t.surface, '#262626'), font: String(font || 'Arial').replace(/[<>"'&;{}\r\n]/g, '').slice(0, 120) || 'Arial' };
}
export function diagramIdentity(source, look) {
  const value = JSON.stringify([1, source, look]); let a = 2166136261, b = 5381;
  for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ value.charCodeAt(i); }
  return [a, b].map(n => (n >>> 0).toString(16).padStart(8, '0')).join('');
}
export function validateDiagram(source) {
  if (source.length > DIAGRAM_CHAR_LIMIT || source.split('\n').length > DIAGRAM_LINE_LIMIT) throw new Error('Diagram exceeds 24,000 characters or 300 lines.');
  const header = source.split('\n').map(line => line.trim()).find(line => line && !line.startsWith('%%')) || '';
  if (!/^(?:(?:graph|flowchart)\s+(?:TD|TB|BT|LR|RL)\b|sequenceDiagram\b|stateDiagram(?:-v2)?\b|classDiagram\b|erDiagram\b)/.test(header)) throw new Error('Supported diagrams: flowchart, sequence, state, class and ER.');
}
const mix = (a, b, fraction) => '#' + [0, 2, 4].map(offset => Math.round(parseInt(a.slice(offset + 1, offset + 3), 16) * fraction + parseInt(b.slice(offset + 1, offset + 3), 16) * (1 - fraction)).toString(16).padStart(2, '0')).join('');
export function nativeDiagramSvg(raw, look) {
  if (raw.length > DIAGRAM_SVG_LIMIT) throw new Error('Generated diagram exceeds 1 MiB.');
  const values = { '--bg': look.bg, '--fg': look.fg, '--line': look.line, '--accent': look.accent, '--muted': look.muted, '--border': look.border, '--surface': look.surface,
    '--_text': look.fg, '--_text-sec': look.muted, '--_text-muted': look.muted, '--_text-faint': mix(look.fg, look.bg, .25), '--_line': look.line, '--_arrow': look.accent, '--_node-fill': look.surface, '--_node-stroke': look.border, '--_group-fill': look.bg, '--_group-hdr': mix(look.fg, look.bg, .05), '--_inner-stroke': mix(look.fg, look.bg, .12), '--_key-badge': mix(look.fg, look.bg, .10) };
  // The pinned renderer uses exactly this palette. Remove its stylesheet, then concretize attributes.
  let svg = raw.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/(<svg\b[^>]*?)\sstyle="[^"]*"/, '$1').replace(/\bvar\((--[\w-]+)\)/g, (_match, name) => {
    if (!(name in values)) throw new Error('Diagram renderer returned an unknown color variable.');
    return values[name];
  });
  svg = svg.replace(/<text\b/g, `<text font-family="${look.font}, sans-serif"`);
  if (/<(?:script|foreignObject|image)\b|(?:href|src)\s*=\s*["'](?:https?:|data:|\/\/)|var\(|color-mix\(|@import/i.test(svg)) throw new Error('Diagram uses unsupported SVG features.');
  const size = name => Number(new RegExp(`<svg\\b[^>]*\\s${name}="([\\d.]+)"`).exec(svg)?.[1]);
  const width = size('width'), height = size('height');
  if (!(width > 0 && height > 0) || width > 32768 || height > 32768) throw new Error('Diagram exceeds the native size limit (32,768 pixels).');
  return { svg, width, height };
}
export function diagramCachePlan(names, keep, now = Date.now()) {
  const eligible = names.filter(name => DIAGRAM_CACHE_FILE.test(name)).sort().reverse();
  return eligible.filter((name, index) => name !== keep && (index >= DIAGRAM_CACHE_LIMIT || now - Number(name.split('-')[1]) > DIAGRAM_CACHE_AGE));
}
