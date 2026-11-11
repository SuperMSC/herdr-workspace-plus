// Runs once for a bounded batch of local diagram sources; never starts a service or browser.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMermaidSVG } from './mermaid.bundle.js';
import { diagramIdentity, diagramLook, validateDiagram, nativeDiagramSvg, diagramCachePlan, DIAGRAM_CACHE_FOLDER } from './mermaid-model.js';
const JOB = /^job-\d{13}-\d{1,12}-[a-z\d]+\.json$/;
const REQUEST_LIMIT = 650000;
async function ownedDirectory(folder) {
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('Diagram cache must be an owned directory.');
}
export async function renderBatch(home, sources, suppliedLook) {
  if (!Array.isArray(sources) || sources.length > 24) throw new Error('At most 24 diagrams can be rendered per document.');
  const look = diagramLook({ background: suppliedLook?.bg, foreground: suppliedLook?.fg, dim: suppliedLook?.line, ansi4: suppliedLook?.accent, muted: suppliedLook?.muted, border: suppliedLook?.border, surface: suppliedLook?.surface }, suppliedLook?.font);
  const folder = path.join(home, DIAGRAM_CACHE_FOLDER); await ownedDirectory(folder);
  const results = [];
  for (const entry of sources) {
    try {
      if (!entry || typeof entry.source !== 'string') throw new Error('Invalid diagram source.');
      if (!entry.closed) throw new Error('Unclosed Mermaid fence.');
      validateDiagram(entry.source);
      const media = nativeDiagramSvg(renderMermaidSVG(entry.source, { ...look, transparent: true }), look);
      const name = `diagram-${Date.now()}-${diagramIdentity(entry.source, look)}.svg`, full = path.join(folder, name);
      try { await fs.writeFile(full, media.svg, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST' || await fs.readFile(full, 'utf8') !== media.svg) throw error; }
      const names = await fs.readdir(folder);
      for (const old of diagramCachePlan(names, name)) {
        const target = path.join(folder, old), info = await fs.lstat(target).catch(() => null);
        if (info?.isFile() && !info.isSymbolicLink() && info.uid === process.getuid()) await fs.unlink(target).catch(() => {});
      }
      results.push({ media: { path: `${DIAGRAM_CACHE_FOLDER}/${name}`, width: media.width, height: media.height } });
    } catch (error) { results.push({ error: String(error.message || error).slice(0, 300) }); }
  }
  return results;
}
export async function renderRequest(home, jobName) {
  if (typeof home !== 'string' || !path.isAbsolute(home) || !JOB.test(jobName || '')) throw new Error('Invalid diagram render request.');
  const folder = path.join(home, DIAGRAM_CACHE_FOLDER, 'jobs'); await ownedDirectory(folder);
  const file = path.join(folder, jobName), info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || info.size > REQUEST_LIMIT) throw new Error('Invalid diagram job file.');
  const text = await fs.readFile(file, 'utf8');
  // Remove all document text before expensive layout, including if the parent is subsequently closed.
  await fs.unlink(file);
  const request = JSON.parse(text);
  for (const old of await fs.readdir(folder)) {
    if (JOB.test(old) && Date.now() - Number(old.split('-')[1]) > 24 * 60 * 60 * 1000) {
      const target = path.join(folder, old), stat = await fs.lstat(target).catch(() => null);
      if (stat?.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid()) await fs.unlink(target).catch(() => {});
    }
  }
  return { results: await renderBatch(home, request.sources, request.look) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await renderRequest(process.argv[2], process.argv[3]))); }
  catch (error) { process.stdout.write(JSON.stringify({ error: String(error.message || error).slice(0, 300) })); process.exitCode = 1; }
}
