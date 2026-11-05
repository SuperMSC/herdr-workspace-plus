// Unsaved edits kept on disk under Herdr's data folder, one small JSON file per edited file,
// so closing a tab (which a mod cannot stop) never loses them.
import { readFile, writeFile, unlink, mkdir, exists } from "fs/promises";
import { appHome } from "herdr";
import { draftName, readDraft, writeDraft } from "./editor-model.js";

const folder = () => `${appHome()}/data/files-plus-drafts`;
const file = (root, path) => `${folder()}/${draftName(root, path)}`;

export async function loadDraft(root, path) {
  try {
    const target = file(root, path);
    return (await exists(target)) ? readDraft(await readFile(target, "utf8"), root, path) : null;
  } catch { return null; }
}

export async function keepDraft(root, path, text, base) {
  await mkdir(folder(), { recursive: true });
  await writeFile(file(root, path), writeDraft(root, path, text, base));
}

export async function dropDraft(root, path) {
  try { const target = file(root, path); if (await exists(target)) await unlink(target); } catch { /* Already gone. */ }
}
