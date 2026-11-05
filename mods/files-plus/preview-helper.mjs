// Local file reads and bounded app-owned image caching. No project files are modified.
import { open, mkdir, readdir, lstat, unlink, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TEXT_LIMIT, IMAGE_LIMIT, fileKind, lineExcerpt } from './preview-model.js';
const CACHE_AGE = 24 * 60 * 60 * 1000, CACHE_TOTAL = 64 * 1024 * 1024;
export async function cleanCache(cache, now = Date.now()) {
  const entries = [];
  for (const name of await readdir(cache).catch(() => [])) {
    if (!/^[a-f0-9]{32}\.(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(name)) continue;
    const path = join(cache, name), s = await lstat(path).catch(() => null);
    if (s?.isFile()) entries.push({ path, size: s.size, time: s.mtimeMs });
  }
  entries.sort((a, b) => b.time - a.time); let used = 0;
  for (const item of entries) { used += item.size; if (now - item.time > CACHE_AGE || used > CACHE_TOTAL) await unlink(item.path).catch(() => {}); }
}
function imageSize(bytes, ext) {
  if (ext === '.png' && bytes.length >= 24 && bytes.toString('ascii', 1, 4) === 'PNG') return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (ext === '.gif' && bytes.length >= 10) return [bytes.readUInt16LE(6), bytes.readUInt16LE(8)];
  if (ext === '.bmp' && bytes.length >= 26) return [Math.abs(bytes.readInt32LE(18)), Math.abs(bytes.readInt32LE(22))];
  if (ext === '.ico' && bytes.length >= 8) return [bytes[6] || 256, bytes[7] || 256];
  if ((ext === '.jpg' || ext === '.jpeg') && bytes[0] === 255 && bytes[1] === 216) {
    for (let i = 2; i + 9 < bytes.length;) {
      if (bytes[i] !== 255) break;
      const marker = bytes[i + 1]; if (marker === 216 || marker === 217) { i += 2; continue; }
      const length = bytes.readUInt16BE(i + 2); if (length < 2) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) return [bytes.readUInt16BE(i + 7), bytes.readUInt16BE(i + 5)];
      i += length + 2;
    }
  }
  if (ext === '.webp' && bytes.length >= 30 && bytes.toString('ascii', 12, 16) === 'VP8X') return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
  if (ext === '.webp' && bytes.length >= 30 && bytes.toString('ascii', 12, 16) === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
  if (ext === '.webp' && bytes.length >= 25 && bytes.toString('ascii', 12, 16) === 'VP8L' && bytes[20] === 0x2f) return [1 + (((bytes[22] & 0x3f) << 8) | bytes[21]), 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6))];
  if (ext === '.svg') {
    const tag = bytes.toString('utf8').match(/<svg\b[^>]*>/i)?.[0] || '';
    const box = tag.match(/\bviewBox\s*=\s*["']\s*([\d.e+\-]+)[ ,]+([\d.e+\-]+)[ ,]+([\d.e+\-]+)[ ,]+([\d.e+\-]+)/i);
    if (box) return [Number(box[3]), Number(box[4])];
    const width = tag.match(/\bwidth\s*=\s*["']([\d.]+)/i), height = tag.match(/\bheight\s*=\s*["']([\d.]+)/i);
    if (width && height) return [Number(width[1]), Number(height[1])];
  }
  return [640, 480];
}
export async function previewFile({ root, path, appHome, line }) {
  if (typeof root !== 'string' || typeof path !== 'string') throw new Error('A folder and relative file path are required');
  const target = resolve(root, path), base = resolve(root);
  const childPath = relative(base, target);
  if (childPath === '..' || childPath.startsWith('../') || childPath.startsWith('..\\') || isAbsolute(childPath)) throw new Error('The file is outside this folder');
  const handle = await open(target, 'r');
  try {
    const info = await handle.stat(); if (!info.isFile()) throw new Error('This is not a regular file');
    const kind = fileKind(path), signature = `${info.ino}:${info.size}:${info.mtimeMs}`;
    if (kind === 'unsupported') return { kind, signature, error: 'PDF preview is not included. Open this file in its default app.' };
    if (kind === 'image' && info.size > IMAGE_LIMIT) throw new Error('Image preview is limited to 16 MiB');
    const bytes = Buffer.alloc(Math.min(info.size, kind === 'image' ? IMAGE_LIMIT : line ? 2 * 1024 * 1024 : TEXT_LIMIT));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0), content = bytes.subarray(0, bytesRead);
    if (kind !== 'image') {
      if (content.includes(0)) throw new Error('Binary file · no text preview');
      // Decode only complete UTF-8 sequences when the byte limit cuts a character.
      const textBytes = content.subarray(0, TEXT_LIMIT);
      const text = new TextDecoder('utf-8').decode(textBytes, { stream: info.size > textBytes.length });
      const excerpt = line ? lineExcerpt(content.toString('utf8'), line) : null;
      return { kind, signature, text, excerpt, truncated: info.size > textBytes.length, size: info.size };
    }
    if (!appHome || !resolve(appHome).startsWith('/')) throw new Error('Image cache location unavailable');
    const cache = join(appHome, 'data', 'files-plus-preview'); await mkdir(cache, { recursive: true }); await cleanCache(cache);
    const ext = extname(path).toLowerCase(), name = createHash('sha256').update(target).update(signature).digest('hex').slice(0, 32) + ext;
    await writeFile(join(cache, name), content, { mode: 0o600 }); await cleanCache(cache);
    const [width, height] = imageSize(content, ext);
    return { kind, signature, image: `data/files-plus-preview/${name}`, width: Math.max(1, width || 640), height: Math.max(1, height || 480), size: info.size };
  } finally { await handle.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await previewFile(JSON.parse(process.argv[2])))); }
  catch (error) { console.log(JSON.stringify({ error: error.code === 'ENOENT' ? 'This file is no longer available' : error.message })); process.exitCode = 1; }
}
