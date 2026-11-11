// One bounded Node job per document keeps graph layout work off the native UI thread.
import { exec, appHome, writeTextFile } from 'herdr';
import { mkdir, unlink } from 'fs/promises';
let sequence = 0;
export async function renderDiagrams(blocks, look) {
  const home = appHome(), name = `job-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2) || '0'}.json`;
  const folder = `${home}/data/files-plus-diagrams/jobs`, file = `${folder}/${name}`;
  await mkdir(folder, { recursive: true });
  await writeTextFile(file, JSON.stringify({ sources: blocks.map(block => ({ source: block.source, closed: block.closed })), look }), null);
  try {
    const result = await exec('node', [`${home}/mods/files-plus/mermaid-helper.mjs`, home, name], { timeout: 15000 });
    const parsed = JSON.parse(result.stdout || '{}');
    if (result.code || !Array.isArray(parsed.results) || parsed.results.length !== blocks.length) throw new Error(parsed.error || 'Diagram rendering did not finish within the preview limits.');
    return parsed.results;
  } finally { await unlink(file).catch(() => {}); }
}
