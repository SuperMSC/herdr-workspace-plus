import { lstatSync } from "node:fs";
import { join } from "node:path";

export const DISPLAY_NAME = "Agent Workspace";
export const LAYOUT_NAME = "Agent-Workspace";
export const LEGACY_LAYOUT_NAME = "files-plus";

export function installedLayoutName(layouts) {
  for (const name of [LAYOUT_NAME, LEGACY_LAYOUT_NAME]) {
    try { lstatSync(join(layouts, `${name}.json`)); return name; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return LAYOUT_NAME;
}
