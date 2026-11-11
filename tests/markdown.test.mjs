import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownStructure, markdownBlocks, resolveMarkdownLink, HEADING_LIMIT } from '../mods/files-plus/markdown-model.js';
import { diagramLook, diagramIdentity, nativeDiagramSvg, validateDiagram, diagramCachePlan, DIAGRAM_CACHE_LIMIT } from '../mods/files-plus/mermaid-model.js';
import { renderMermaidSVG } from '../mods/files-plus/mermaid.bundle.js';

test('Markdown heading offsets, Unicode slugs, duplicate collisions and Setext stay source-faithful', () => {
  const text = '# Hello *World* #\r\n\r\n## 中文 标题\r\n## Hello World\r\n## hello-world-1\r\n## Hello World\r\n\r\nMulti line\r\nsetext title\r\n---\r\n';
  const result = markdownStructure(text);
  assert.deepEqual(result.headings.map(h => h.slug), ['hello-world', '中文-标题', 'hello-world-1', 'hello-world-1-1', 'hello-world-2', 'multi-line-setext-title']);
  assert.equal(result.headings[0].title, 'Hello World');
  assert.equal(result.headings.at(-1).level, 2);
  assert.equal(text.slice(result.headings.at(-1).start).startsWith('Multi line'), true);
  for (const heading of result.headings) assert(text.slice(heading.start).length);
});

test('fences, indented code, quotes and nested list code do not become headings or live diagrams', () => {
  const text = '# Real\n\n````md\n# fake\n```mermaid\nflowchart LR\nA-->B\n```\n````\n\n    ## indented\n> ## quoted\n- item\n  ## nested\n  ```mermaid\n  flowchart LR\n  A-->B\n  ```\n\n## Last\n\n```mermaid\nflowchart LR\nA-->B\n```\n';
  const result = markdownStructure(text);
  assert.deepEqual(result.headings.map(h => h.slug), ['real', 'last']);
  assert.equal(result.diagrams.length, 1); assert.equal(result.diagrams[0].closed, true);
  assert.match(result.diagrams[0].source, /^flowchart/);
  const unclosed = markdownStructure('```mermaid\nflowchart LR\nA-->B');
  assert.equal(unclosed.diagrams[0].closed, false);
});

test('blocks preserve source and link reference definitions across native diagram boundaries', () => {
  const source = '# Start\n\n[Next][go]\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n## End\n\n[go]: other.md#end\n';
  const result = markdownStructure(source), blocks = markdownBlocks(source, result);
  assert.equal(blocks.filter(block => block.diagram).length, 1);
  assert.match(blocks.find(block => block.diagram).text, /^```mermaid\n/);
  assert.equal(blocks.find(block => block.heading?.slug === 'end').text.startsWith('## End'), true);
  for (const block of blocks.filter(block => !block.diagram)) assert.match(block.text, /\[go\]: other\.md#end/);
  const many = Array.from({ length: HEADING_LIMIT + 10 }, (_, i) => '# Heading ' + i).join('\n');
  assert.equal(markdownStructure(many).headings.length, HEADING_LIMIT);
  assert.equal(markdownStructure(many).headingsLimited, true);
});

test('Markdown links stay on the captured project and preserve encoded Unicode anchors', () => {
  assert.deepEqual(resolveMarkdownLink('/project', 'docs/a.md', '../设计.md#%E4%B8%AD%E6%96%87-%E6%A0%87%E9%A2%98'), { path: '设计.md', anchor: '中文-标题' });
  assert.deepEqual(resolveMarkdownLink('/project', 'docs/a.md', '#a'), { path: 'docs/a.md', anchor: 'a' });
  assert.deepEqual(resolveMarkdownLink('/project', 'docs/a.md', '#'), { path: 'docs/a.md', anchor: null });
  assert.deepEqual(resolveMarkdownLink('/project', 'docs/a.md', 'file:///project/b.md'), { path: 'b.md', anchor: null });
  assert.deepEqual(resolveMarkdownLink('/project', 'a.md', 'https://example.com/guide'), { external: 'https://example.com/guide' });
  for (const value of ['../../escape.md', '/elsewhere/a.md', 'file:///project-other/a.md', '%2e%2e/escape.md', 'javascript:alert(1)', 'a.md?write=1', '%xx', 'secret.txt', '..%2f..%2foutside.md']) assert.throws(() => resolveMarkdownLink('/project', 'a.md', value));
});

test('all five diagram families produce concrete native SVGs with no network fonts', () => {
  const look = diagramLook({ background: '#202020', foreground: '#eeeeee', border: '#555555' }, 'Geist');
  const sources = ['flowchart LR\nA[Read] --> B[Save]', 'sequenceDiagram\nAlice->>Bob: Hello', 'stateDiagram-v2\n[*] --> Ready\nReady --> Done', 'classDiagram\nclass Document {\n+save()\n}\nDocument --> Draft', 'erDiagram\nUSER ||--o{ FILE : owns'];
  for (const source of sources) {
    validateDiagram(source);
    const output = nativeDiagramSvg(renderMermaidSVG(source, { ...look, transparent: true }), look);
    assert(output.width > 0 && output.height > 0); assert.match(output.svg, /font-family="Geist, sans-serif"/);
    assert.doesNotMatch(output.svg, /var\(|color-mix\(|@import|https:\/\/fonts/);
  }
  assert.throws(() => validateDiagram('pie\n"one": 2'), /Supported diagrams/);
  assert.throws(() => validateDiagram('flowchart LR\n' + 'A'.repeat(24001)), /exceeds/);
  assert.throws(() => validateDiagram('flowchart LR\n' + 'A\n'.repeat(301)), /exceeds/);
  assert.throws(() => nativeDiagramSvg('<svg width="40000" height="10"></svg>', look), /size limit/);
  assert.notEqual(diagramIdentity(sources[0], look), diagramIdentity(sources[0], { ...look, fg: '#111111' }));
  assert.notEqual(diagramIdentity(sources[0], look), diagramIdentity(sources[0] + ' ', look));
});

test('diagram disk cache is bounded, age-aware and never removes unrelated files', () => {
  const now = 1790000000000;
  const files = Array.from({ length: DIAGRAM_CACHE_LIMIT + 10 }, (_, index) => `diagram-${now - index}-${index.toString(16).padStart(16, '0')}.svg`);
  const old = 'diagram-1700000000000-0123456789abcdef.svg';
  const removed = diagramCachePlan([...files, old, 'user.svg', 'diagram-invalid.svg'], files[0], now);
  assert.equal(removed.includes(files[0]), false); assert.equal(removed.includes(old), true);
  assert.equal(removed.includes('user.svg'), false); assert.equal(removed.includes('diagram-invalid.svg'), false);
  assert.equal(removed.length, 11);
});
