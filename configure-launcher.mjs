#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installedLayoutName } from "./layout-name.mjs";
import { ZEN_FOOTER, zenFooter } from "./mods/sessions-plus/zen-model.js";

function bindLayoutKey(source, layoutName, shortcut, action, matches = binding => binding === action) {
  const keys = structuredClone(source), section = `layout:${layoutName}`;
  for (const context of ["global", "terminal", section, "mod:sessions-plus"]) {
    const binding = keys[context]?.[shortcut];
    if (binding && !matches(binding)) return { keys, changed: false, shortcut, conflict: context };
  }
  if (matches(keys[section]?.[shortcut])) return { keys, changed: false, shortcut };
  keys[section] = { ...(keys[section] || {}), [shortcut]: action };
  return { keys, changed: true, shortcut };
}

export function launcherKeys(source, layoutName) {
  const shortcut = process.platform === "darwin" ? "cmd-alt-p" : "ctrl-shift-space";
  return bindLayoutKey(source, layoutName, shortcut, "sessions-plus.launcher");
}

export function zenKeys(source, layoutName, layout, platform = process.platform) {
  const shortcut = platform === "darwin" ? "cmd-alt-z" : "ctrl-shift-z";
  if (!zenFooter(layout)) return { keys: source, changed: false, shortcut, unavailable: true };
  const action = { command: "layout.toggle", args: { id: ZEN_FOOTER } };
  return bindLayoutKey(source, layoutName, shortcut, action, binding =>
    binding === `layout.toggle:${ZEN_FOOTER}` || (binding?.command === action.command &&
      binding.args?.id === ZEN_FOOTER && Object.keys(binding.args).length === 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--home")) throw new Error("Usage: node configure-launcher.mjs [--home PATH]");
  const home = args[1] || process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app"), path = join(home, "keys.json");
  const layouts = join(home, "layouts"), name = installedLayoutName(layouts);
  let layout;
  try { layout = JSON.parse(readFileSync(join(layouts, `${name}.json`), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const before = readFileSync(path, "utf8"), launcher = launcherKeys(JSON.parse(before), name);
  const zen = zenKeys(launcher.keys, name, layout);
  if (launcher.changed || zen.changed) {
    if (readFileSync(path, "utf8") !== before) throw new Error("Keys changed; retry without overwriting them.");
    writeFileSync(path, JSON.stringify(zen.keys, null, 2) + "\n");
  }
  if (launcher.conflict) console.log(`Shortcut already used in ${launcher.conflict}; use the footer Launch button.`);
  else console.log(`Quick launcher${launcher.changed ? "" : " already bound"}: ${launcher.shortcut}`);
  if (zen.unavailable) console.log("Zen mode requires a Sessions Plus status footer in this layout.");
  else if (zen.conflict) console.log(`Zen shortcut already used in ${zen.conflict}; enter through Launch and exit with herdr-app do layout.show --id ${ZEN_FOOTER}.`);
  else console.log(`Zen mode${zen.changed ? "" : " already bound"}: ${zen.shortcut}`);
}
