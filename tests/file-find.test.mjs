import assert from 'node:assert/strict';
import test from 'node:test';
import { findInText, highlightedLine } from '../mods/files-plus/file-find-model.js';

test('file find treats patterns literally, respects case, and preserves Unicode and CRLF columns', () => {
  const found = findInText('İ x.* x.*\r\n中文 😀 X.*', 'x.*');
  assert.deepEqual(found.matches.map(({ row, start, end }) => [row, start, end]), [[0, 2, 5], [0, 6, 9], [1, 6, 9]]);
  assert.equal(findInText('aA', 'a', true).matches.length, 1);
  assert.equal(findInText('aa', ' ').matches.length, 0);
  assert.equal(findInText(' a ', ' ').matches.length, 2);
  assert.equal(findInText('中文中文', '中文').matches.length, 2);
  assert.equal(findInText('😀😀', '😀').matches[1].start, 2);
  assert.equal(findInText('anything', '').matches.length, 0);
  for (const query of ['[', ']', '\\', '(', ')', '*', '+', '?', '^', '$', '{', '}', '|', '.']) assert.equal(findInText(query, query).matches.length, 1);
});

test('file find bounds match count and distinguishes an exact limit from extra matches', () => {
  assert.equal(findInText('x'.repeat(1000), 'x').limited, false);
  const result = findInText('x'.repeat(1001), 'x');
  assert.equal(result.limited, true); assert.equal(result.matches.length, 1000);
  assert.equal(result.byLine.get(0).length, 1000);
});

test('highlights preserve original text and target the selected occurrence, including long lines', () => {
  const text = 'prefix needle needle suffix', result = findInText(text, 'needle');
  const parts = highlightedLine(text, result.byLine.get(0), 1);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.equal(parts.filter(part => part.active).length, 1);
  assert.equal(parts.find(part => part.active).text, 'needle');
  const long = 'a'.repeat(5000) + 'needle' + 'b'.repeat(5000), found = findInText(long, 'needle');
  const window = highlightedLine(long, found.byLine.get(0), 0);
  assert(window.some(part => part.active && part.text === 'needle'));
  assert(window.map(part => part.text).join('').length < 2100);
  assert.equal(window[0].text, '…'); assert.equal(window.at(-1).text, '…');
});
