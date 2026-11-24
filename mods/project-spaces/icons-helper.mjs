// Read fixed project icon candidates and publish private, content-addressed copies.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const CACHE_MAX = 200, IMAGE_MAX = 256 * 1024, SVG_MAX = 64 * 1024, DIMENSION = 1024;
const FOLDERS = ["", "public", "static", "assets", "app", "src/app", ".github"];
const NAMES = ["favicon", "icon", "logo"], EXTENSIONS = ["png", "jpg", "jpeg", "webp", "svg"];
const MAX_INVENTORY = 500, MAX_AGE = 3600000;
const CACHED_NAME = /^[a-f0-9]{64}\.(?:png|jpg|webp|svg)$/;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SHA = bytes => createHash("sha256").update(bytes).digest("hex");
const absolute = value => typeof value === "string" && value.length <= 1024 && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
const lstat = name => fs.lstatSync(name, { throwIfNoEntry: false });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const dimensions = (width, height) => width >= 1 && height >= 1 && width <= DIMENSION && height <= DIMENSION;

function png(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG) || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") return false;
  if (!dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20))) return false;
  let data = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset), kind = bytes.toString("ascii", offset + 4, offset + 8);
    offset += size + 12;
    if (offset > bytes.length || ["acTL", "fcTL", "fdAT"].includes(kind)) return false;
    if (kind === "IDAT" && size) data = true;
    if (kind === "IEND") return data && size === 0 && offset === bytes.length;
  }
  return false;
}

function jpeg(bytes) {
  if (bytes.length < 12 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return false;
  for (let offset = 2; offset + 3 < bytes.length;) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (offset + 2 > bytes.length || marker === 0xda || marker === 0xd9) return false;
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return size >= 8 && dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    offset += size;
  }
  return false;
}

function webp(bytes) {
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  let image = false, offset = 12;
  while (offset + 8 <= bytes.length) {
    const tag = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    offset = start + size + (size % 2);
    if (offset > bytes.length || tag === "ANIM" || tag === "ANMF") return false;
    if (tag === "VP8X" && (size !== 10 || (bytes[start] & 2) || !dimensions(1 + bytes.readUIntLE(start + 4, 3), 1 + bytes.readUIntLE(start + 7, 3)))) return false;
    if (tag === "VP8 " || tag === "VP8L") {
      if (image) return false;
      if (tag === "VP8 ") {
        if (size < 10 || (bytes[start] & 1) || bytes.readUIntBE(start + 3, 3) !== 0x9d012a) return false;
        image = dimensions(bytes.readUInt16LE(start + 6) & 16383, bytes.readUInt16LE(start + 8) & 16383);
      } else {
        if (size < 5 || bytes[start] !== 47) return false;
        const bits = bytes.readUInt32LE(start + 1);
        image = dimensions(1 + (bits & 16383), 1 + ((bits >>> 14) & 16383));
      }
      if (!image) return false;
    }
  }
  return image && offset === bytes.length;
}

// The SVG subset contains drawing elements, local references and inert text.
// XML declarations/comments are inert; entity references, CSS escapes and resource-loading elements are excluded.
const SVG_TAGS = new Set("svg g defs path rect circle ellipse line polyline polygon text tspan title desc lineargradient radialgradient stop clippath mask pattern marker symbol use filter feblend fecolormatrix fecomponenttransfer fecomposite feconvolvematrix fediffuselighting fedisplacementmap fedistantlight fedropshadow feflood fefunca fefuncb fefuncg fefuncr fegaussianblur femerge femergenode femorphology feoffset fepointlight fespecularlighting fespotlight fetile feturbulence".split(" "));
function svg(bytes) {
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/<\/?\s*(?:[\w.-]+:)?(?:script|foreignObject|image)\b|<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) return false;
  const document = xml.replace(/^\s*<\?xml\s+[^?]*\?>/i, "").replace(/<!--[\s\S]*?-->/g, "");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(document)) return false;
  const tokens = /<(\/?)([A-Za-z][\w.-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g;
  const stack = [];
  let root = false, offset = 0;
  for (const match of document.matchAll(tokens)) {
    const [, closing, tag, fields] = match, between = document.slice(offset, match.index);
    if (between.includes("<") || !stack.length && between.trim()) return false;
    offset = match.index + match[0].length;
    if (!SVG_TAGS.has(tag.toLowerCase())) return false;
    if (closing) {
      if (fields.trim() || stack.pop() !== tag) return false;
      continue;
    }
    if (!stack.length && (root || tag !== "svg")) return false;
    root = true;
    const selfClosing = /\/\s*$/.test(fields), attributes = selfClosing ? fields.replace(/\/\s*$/, "") : fields;
    const attr = /\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
    let end = 0;
    for (let attribute; (attribute = attr.exec(attributes));) {
      end = attr.lastIndex;
      const name = attribute[1].toLowerCase(), value = attribute[2] ?? attribute[3];
      if (name === "xmlns" && value === "http://www.w3.org/2000/svg" || name === "xmlns:xlink" && value === "http://www.w3.org/1999/xlink") continue;
      if (name.startsWith("xmlns") || name === "xml:base" || name.split(":").at(-1).startsWith("on") || /[&\\<>]/.test(value)) return false;
      if (name.split(":").at(-1) === "href" && !/^#[\w.:-]+$/.test(value.trim())) return false;
      const rest = value.replace(/\burl\s*\(\s*(?:(["'])(#[\w.:-]+)\1|#[\w.:-]+)\s*\)/gi, "");
      if (/\burl\s*\(|\/\*/i.test(rest) || name === "style" && /[@'"\u0000]|\b(?:image|image-set|src)\s*\(/i.test(rest)) return false;
    }
    if (attributes.slice(end).trim()) return false;
    if (!selfClosing) stack.push(tag);
  }
  return root && !stack.length && !document.slice(offset).trim();
}

function safeDirectory(folder) {
  const root = path.parse(folder).root;
  let current = root, info = lstat(root);
  for (const part of folder.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    info = lstat(current);
    if (!info?.isDirectory()) return null;
  }
  return info?.isDirectory() ? info : null;
}

function ownedFile(file, limit, uid, mode) {
  const folder = path.dirname(file);
  if (!safeDirectory(folder)) return null;
  const before = lstat(file);
  if (!before?.isFile() || before.uid !== uid || before.size < 1 || before.size > limit || mode && (before.mode & 0o777) !== mode) return null;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd), current = safeDirectory(folder) && lstat(file);
    if (!current || !sameFile(info, current) || !info.isFile() || info.uid !== uid || !sameFile(info, before) ||
      info.size !== before.size || info.mtimeMs !== before.mtimeMs || mode && (info.mode & 0o777) !== mode) return null;
    const bytes = Buffer.alloc(info.size);
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return null;
    const after = fs.fstatSync(fd);
    return after.size === info.size && after.mtimeMs === info.mtimeMs ? bytes : null;
  } finally { fs.closeSync(fd); }
}

function findIcon(root, uid, deadline) {
  if (!safeDirectory(root)) return null;
  for (const subfolder of FOLDERS) {
    if (performance.now() >= deadline) break;
    const folder = path.join(root, subfolder);
    if (!safeDirectory(folder)) continue;
    for (const name of NAMES) for (const ext of EXTENSIONS) {
      if (performance.now() >= deadline) return null;
      try {
        const candidate = path.join(folder, name + "." + ext);
        const format = ext === "jpeg" ? "jpg" : ext, validate = { png, jpg: jpeg, webp, svg }[format];
        const bytes = ownedFile(candidate, format === "svg" ? SVG_MAX : IMAGE_MAX, uid);
        if (bytes && validate(bytes)) return { bytes, name: SHA(bytes) + "." + format };
      } catch { /* The project may be changing. Try the next candidate. */ }
    }
  }
  return null;
}

function cacheDirectory(home, uid) {
  if (!absolute(home) || safeDirectory(home)?.uid !== uid) return null;
  const data = path.join(home, "data"), cache = path.join(data, "project-icons");
  for (const directory of [data, cache]) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = lstat(directory);
    if (!info?.isDirectory() || info.uid !== uid || directory === cache && (info.mode & 0o777) !== 0o700) return null;
  }
  return cache;
}

function inventory(cache, uid) {
  const dir = fs.opendirSync(cache), files = new Map();
  try {
    let visited = 0;
    for (let entry; (entry = dir.readSync());) {
      if (++visited > MAX_INVENTORY) throw new Error("Project icon cache inventory exceeded its limit.");
      if (!entry.isFile()) continue;
      const file = path.join(cache, entry.name), info = lstat(file);
      if (!info?.isFile() || info.uid !== uid) continue;
      if (CACHED_NAME.test(entry.name)) files.set(entry.name, info);
      else if (/^\.pending-\d+-[a-f0-9]+$/.test(entry.name) && Date.now() - info.mtimeMs > MAX_AGE) fs.unlinkSync(file);
    }
  } finally { dir.closeSync(); }
  return files;
}

function trim(cache, files, keep, target) {
  const oldest = [...files].filter(([name]) => !keep.has(name)).sort((a, b) => a[1].mtimeMs - b[1].mtimeMs || a[0].localeCompare(b[0]));
  for (const [name, initial] of oldest) {
    if (files.size <= target) break;
    const file = path.join(cache, name), info = lstat(file);
    if (info?.isFile() && sameFile(info, initial)) fs.unlinkSync(file);
    files.delete(name);
  }
}

function cacheIcon(cache, files, kept, icon, uid) {
  const target = path.join(cache, icon.name);
  const valid = () => ownedFile(target, IMAGE_MAX, uid, 0o600)?.equals(icon.bytes);
  if (lstat(target)) return valid();
  trim(cache, files, kept, CACHE_MAX - 1);
  if (files.size >= CACHE_MAX) return false;
  const pending = path.join(cache, ".pending-" + process.pid + "-" + randomBytes(6).toString("hex"));
  fs.writeFileSync(pending, icon.bytes, { flag: "wx", mode: 0o600 });
  try {
    try { fs.linkSync(pending, target); }
    catch (error) { if (error.code !== "EEXIST" || !valid()) return false; }
    const info = lstat(target);
    if (!info?.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600) return false;
    files.set(icon.name, info);
    return true;
  } finally { fs.unlinkSync(pending); }
}

export function projectIcons({ home, roots } = {}) {
  const result = Object.create(null), uid = process.getuid?.();
  if (uid === undefined || !absolute(home) || !Array.isArray(roots)) return result;
  const deadline = performance.now() + 8000, seen = new Set(), kept = new Set();
  let cache, files;
  for (const item of roots.slice(0, CACHE_MAX)) {
    if (performance.now() >= deadline) break;
    if (item?.on != null || !absolute(item?.root) || seen.has(item.root)) continue;
    seen.add(item.root);
    try {
      const icon = findIcon(path.resolve(item.root), uid, deadline);
      if (!icon) continue;
      if (!cache) {
        cache = cacheDirectory(path.resolve(home), uid);
        if (!cache) break;
        files = inventory(cache, uid);
      }
      if (!cacheIcon(cache, files, kept, icon, uid)) continue;
      kept.add(icon.name); result[item.root] = icon.name;
    } catch { /* Invalid or inaccessible candidates leave the existing letter. */ }
  }
  if (files) {
    try { trim(cache, inventory(cache, uid), kept, CACHE_MAX); } catch { /* A concurrent cleanup may already have removed an entry. */ }
  }
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  let result;
  try { result = projectIcons(JSON.parse(process.argv[2] || "{}")); } catch { result = {}; }
  process.stdout.write(JSON.stringify(result));
}
