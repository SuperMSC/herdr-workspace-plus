#!/usr/bin/env node
// Updates installed mods from this package without keeping old copies.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cloneLayout } from "./install.mjs";
import { integrateWorkspace } from "./workspace-layout.mjs";
import { DISPLAY_NAME, installedLayoutName } from "./layout-name.mjs";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const displayName = DISPLAY_NAME;

function entry(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function directory(path, label) {
  const info = entry(path);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be an existing directory, not a symbolic link: ${path}`);
  }
  return realpathSync(path);
}

function contains(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function readTree(root, current = "", files = []) {
  for (const item of readdirSync(join(root, current), { withFileTypes: true })) {
    const name = join(current, item.name);
    if (item.isDirectory()) readTree(root, name, files);
    else if (item.isFile()) {
      const path = join(root, name);
      files.push({ name, data: readFileSync(path), mode: lstatSync(path).mode & 0o777 });
    } else throw new Error(`Mod source must contain only regular files and directories: ${join(root, name)}`);
  }
  return files;
}

export function update({
  home = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app"),
  layout = "main",
  source = join(packageRoot, "mods", "files-plus"),
  sessions = true,
  integrateLayout = false,
  sessionsSource = join(packageRoot, "mods", "sessions-plus"),
} = {}) {
  if (typeof home !== "string" || !home) throw new Error("--home must be a directory path.");
  if (typeof layout !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(layout) || layout.endsWith(".json")) {
    throw new Error("--layout must be a name without a path or .json suffix.");
  }
  if (integrateLayout && !sessions) throw new Error("--integrate-layout cannot be combined with --files-only.");
  home = directory(resolve(home), "Herdr home");
  const mods = directory(join(home, "mods"), "Herdr mods directory");
  const layouts = directory(join(home, "layouts"), "Herdr layouts directory");
  const plans = [{ name: "files-plus", source, required: ["main.js", "mod.json"] }];
  if (sessions) plans.push({ name: "sessions-plus", source: sessionsSource, required: ["main.js", "mod.json", "history.mjs", "trash.mjs"] });
  for (const plan of plans) {
    plan.source = directory(resolve(plan.source), `${plan.name} source`);
    plan.target = join(mods, plan.name);
    const existing = entry(plan.target);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
      throw new Error(`Mod target must be a directory, not a symbolic link: ${plan.target}`);
    }
    if (existing) plan.target = realpathSync(plan.target);
  }
  // Canonical paths also detect aliases through symbolic links in parent folders.
  for (const plan of plans) {
    for (const root of [realpathSync(packageRoot), ...plans.map(item => item.source)]) {
      if (contains(root, plan.target) || contains(plan.target, root)) {
        throw new Error(`Mod source and update target must not overlap: ${plan.target}`);
      }
    }
    plan.files = readTree(plan.source);
    if (plan.required.some(name => !plan.files.some(file => file.name === name))) {
      throw new Error(`${plan.name} source is incomplete.`);
    }
    const manifest = JSON.parse(plan.files.find(file => file.name === "mod.json").data.toString("utf8"));
    if (!manifest || Array.isArray(manifest) || typeof manifest !== "object") throw new Error(`${plan.name} mod.json must be an object.`);
  }
  const layoutName = installedLayoutName(layouts);
  const layoutTarget = join(layouts, `${layoutName}.json`);
  const existingLayout = entry(layoutTarget);
  if (existingLayout && (!existingLayout.isFile() || existingLayout.isSymbolicLink())) {
    throw new Error(`Layout target must be a regular file, not a symbolic link: ${layoutTarget}`);
  }
  // Ordinary updates preserve existing layouts without reading their original source.
  let serialized = null, originalLayout = null, layoutUpdated = false;
  if (!existingLayout) {
    serialized = JSON.stringify(cloneLayout(JSON.parse(readFileSync(join(layouts, `${layout}.json`), "utf8")), { sessions }), null, 2) + "\n";
  } else if (integrateLayout) {
    originalLayout = readFileSync(layoutTarget, "utf8");
    const integration = integrateWorkspace(JSON.parse(originalLayout));
    if (!integration.integrated) throw new Error("This custom layout cannot be integrated automatically. Update without --integrate-layout to keep its existing interface.");
    if (integration.changed) { serialized = JSON.stringify(integration.layout, null, 2) + "\n"; layoutUpdated = true; }
  }

  // Prepare only NEW files on the destination filesystem. No old copy is saved.
  const staging = mkdtempSync(join(mods, ".workspace-plus-update-"));
  let replacing = false, layoutStaging = null;
  try {
    if (layoutUpdated) {
      layoutStaging = mkdtempSync(join(layouts, ".workspace-plus-layout-"));
      writeFileSync(join(layoutStaging, "layout.json"), serialized, { flag: "wx" });
    }
    for (const plan of plans) {
      const staged = join(staging, plan.name);
      mkdirSync(staged);
      for (const file of plan.files) {
        const target = join(staged, file.name);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.data, { flag: "wx", mode: file.mode });
      }
    }
    for (const plan of plans) {
      const existing = entry(plan.target);
      if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error(`Mod target changed: ${plan.target}`);
      replacing = true;
      rmSync(plan.target, { recursive: true, force: true });
      renameSync(join(staging, plan.name), plan.target);
    }
    // Exclusive creation avoids overwriting a layout created during the update.
    if (layoutUpdated) {
      const latest = entry(layoutTarget);
      if (!latest?.isFile() || latest.isSymbolicLink() || readFileSync(layoutTarget, "utf8") !== originalLayout) throw new Error("The layout changed during this update; it was not overwritten. Rerun to integrate its current version.");
      renameSync(join(layoutStaging, "layout.json"), layoutTarget);
    } else if (serialized !== null) writeFileSync(layoutTarget, serialized, { flag: "wx" });
    return { home, mods: plans.map(plan => plan.target), layout: layoutTarget, layoutName, layoutCreated: !existingLayout, layoutUpdated };
  } catch (error) {
    if (replacing) throw new Error(`Update stopped after replacement began; some mods may already be updated. No backup was kept. Resolve the error and rerun: ${error.message}`, { cause: error });
    throw error;
  } finally {
    if (layoutStaging) rmSync(layoutStaging, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

function usage() {
  return [
    displayName,
    "",
    "Usage: node update.mjs [--home PATH] [--layout NAME] [--files-only] [--integrate-layout]",
    "",
    "Updates installed mods from this package and removes obsolete mod files. No backups.",
    "Preserves existing layouts, shared state, and session-trash recovery records.",
    "Creates the Agent Workspace layout only when absent, using --layout (default: main).",
    "--files-only leaves any existing Sessions mod untouched.",
    "--integrate-layout moves Sessions to the toolbar and quota to the status bar in a supported existing layout.",
    "Default home: HERDR_APP_HOME, otherwise ~/.config/herdr-app.",
    "Does not run git pull, start Herdr, or switch its active layout.",
  ].join("\n");
}

function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { console.log(usage()); return; }
    if (arg === "--integrate-layout") { options.integrateLayout = true; continue; }
    if (arg === "--files-only") { options.sessions = false; continue; }
    if (arg !== "--home" && arg !== "--layout") throw new Error(`Unknown option: ${arg}\n${usage()}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (Object.hasOwn(options, arg.slice(2))) throw new Error(`Repeated option: ${arg}`);
    options[arg.slice(2)] = value;
  }
  const result = update(options);
  console.log(displayName);
  for (const mod of result.mods) console.log(`Updated mod: ${mod}`);
  console.log(`${result.layoutCreated ? "Created" : result.layoutUpdated ? "Updated" : "Preserved"} layout: ${result.layout}`);
  console.log("No backups created. Shared state and session-trash recovery records preserved.");
  console.log(`Next: run herdr-app check on each updated mod. Select ${result.layoutName} for a first installation.`);
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`${displayName}: ${error.message}`); process.exitCode = 1; }
}
