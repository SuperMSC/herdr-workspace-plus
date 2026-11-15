#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installedLayoutName } from "./layout-name.mjs";

export function launcherKeys(source, layoutName) {
  const keys = structuredClone(source), section = `layout:${layoutName}`, shortcut = process.platform === "darwin" ? "cmd-alt-p" : "ctrl-shift-space";
  const action = "sessions-plus.launcher";
  for (const context of ["global", "terminal", section, "mod:sessions-plus"]) {
    const binding = keys[context]?.[shortcut];
    if (binding && binding !== action) return { keys, changed: false, shortcut, conflict: context };
  }
  if (keys[section]?.[shortcut] === action) return { keys, changed: false, shortcut };
  keys[section] = { ...(keys[section] || {}), [shortcut]: action };
  return { keys, changed: true, shortcut };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--home")) throw new Error("Usage: node configure-launcher.mjs [--home PATH]");
  const home = args[1] || process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app"), path = join(home, "keys.json");
  const before = readFileSync(path, "utf8"), result = launcherKeys(JSON.parse(before), installedLayoutName(join(home, "layouts")));
  if (result.conflict) console.log(`Shortcut already used in ${result.conflict}; use the footer Launch button.`);
  else if (result.changed) {
    if (readFileSync(path, "utf8") !== before) throw new Error("Keys changed; retry without overwriting them.");
    writeFileSync(path, JSON.stringify(result.keys, null, 2) + "\n");
    console.log(`Quick launcher: ${result.shortcut}`);
  } else console.log(`Quick launcher already bound: ${result.shortcut}`);
}
