#!/usr/bin/env node
// Installs a personal mod and layout without overwriting an existing file.
import { constants, closeSync, copyFileSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const displayName = "Herdr Workspace Plus";
const modName = "files-plus";

function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function directory(path, label) {
  if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${label} is missing or is not a directory: ${path}`);
  }
}

function sourceFiles(root, relative = "") {
  const files = [];
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const child = join(relative, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Mod source must contain only regular files and directories: ${child}`);
  }
  return files;
}

export function cloneLayout(source, { sessions = false } = {}) {
  const layout = structuredClone(source);
  if (!layout || Array.isArray(layout) || typeof layout !== "object") {
    throw new Error("The source layout must be a JSON object.");
  }
  const files = new Set();
  const changes = new Set();
  function replace(node) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const original = node.content?.mod;
    if (original === "files" || original === "changes") {
      node.content.mod = modName;
      if (original === "changes") {
        node.content.props = { ...node.content.props, role: "changes" };
        changes.add(node);
      } else {
        // The shipped Files mod ignored role; preserve its browser behavior here.
        if (node.content.props && Object.hasOwn(node.content.props, "role")) delete node.content.props.role;
        files.add(node);
      }
    }
    for (const child of node.children ?? []) replace(child);
  }
  replace(layout);
  if (!files.size && !changes.size) {
    throw new Error('The source layout has no Files or Changes block (content.mod = "files" or "changes"). Choose another --layout or add files-plus manually.');
  }

  // Prefer Files across the whole layout. Do not reveal an unrelated Changes branch.
  const preferred = files.size ? files : changes;
  function reveal(node) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return false;
    let found = preferred.has(node);
    let selected;
    for (const child of node.children ?? []) {
      if (reveal(child)) {
        found = true;
        selected ??= child.id;
      }
    }
    if (found) {
      if (node.hidden === true) node.hidden = false;
      if (node.type === "stack" && selected) node.active = selected;
    }
    return found;
  }
  reveal(layout);
  if (sessions) attachSessions(layout, preferred);
  return layout;
}

function attachSessions(layout, preferred) {
  const ids = new Set();
  const visit = (node, callback) => { callback(node); for (const child of node.children ?? []) visit(child, callback); };
  visit(layout, node => ids.add(node.id));
  const unique = prefix => { let id = prefix, i = 1; while (ids.has(id)) id = `${prefix}-${i++}`; ids.add(id); return id; };
  const session = { id: unique("files-plus-sessions"), type: "block", size: { weight: 1 }, min: 200, content: { mod: "sessions-plus" } };
  let panel;
  const containsPreferred = node => preferred.has(node) || (node.children ?? []).some(containsPreferred);
  visit(layout, node => { if (node.id === "panel" && node.type === "column" && containsPreferred(node) && node.children?.some(child => child.id === "panel-body")) panel = node; });
  if (panel) {
    const body = panel.children.find(child => child.id === "panel-body");
    body.size ??= { weight: 1 }; body.min ??= 180;
    panel.children.push(session);
  } else {
    // Custom layouts keep the original block id, geometry and external selection targets.
    const node = [...preferred][0], content = node.content;
    node.type = "column"; delete node.content;
    node.children = [{ id: unique("files-plus-browser"), type: "block", size: { weight: 1 }, min: 160, content }, session];
  }
}

export function install({
  home = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app"),
  layout = "main",
  source = join(packageRoot, "mods", modName),
  sessions = true,
  sessionsSource = join(packageRoot, "mods", "sessions-plus"),
} = {}) {
  if (typeof layout !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(layout)) {
    throw new Error("--layout must be a layout name, without a path or .json suffix.");
  }
  if (layout.endsWith(".json")) throw new Error("--layout takes a name without the .json suffix.");
  if (typeof home !== "string" || !home) throw new Error("--home must be a directory path.");
  home = resolve(home);
  directory(home, "Herdr home");
  const mods = join(home, "mods");
  const layouts = join(home, "layouts");
  directory(mods, "Herdr mods directory");
  directory(layouts, "Herdr layouts directory");
  const modTarget = join(mods, modName);
  const layoutTarget = join(layouts, `${modName}.json`);
  const sessionTarget = join(mods, "sessions-plus");
  for (const target of [modTarget, layoutTarget, ...(sessions ? [sessionTarget] : [])]) {
    if (present(target)) throw new Error(`Refusing to overwrite ${target}. Keep it, or move/remove it yourself before installing.`);
  }

  directory(source, "Files Plus source");
  const files = sourceFiles(source);
  if (!files.includes("main.js") || !files.includes("mod.json")) {
    throw new Error("Files Plus source must include main.js and mod.json.");
  }
  const sourceLayout = join(layouts, `${layout}.json`);
  const sessionFiles = sessions ? sourceFiles(sessionsSource) : [];
  if (sessions && (!sessionFiles.includes("main.js") || !sessionFiles.includes("history.mjs"))) throw new Error("Sessions Plus source is incomplete.");
  const cloned = cloneLayout(JSON.parse(readFileSync(sourceLayout, "utf8")), { sessions });
  const serialized = JSON.stringify(cloned, null, 2) + "\n";
  let ownMod = false;
  let ownLayout = false;
  let ownSessions = false;
  try {
    // mkdir and wx make the final collision checks exclusive, including dangling links.
    mkdirSync(modTarget);
    ownMod = true;
    for (const file of files) {
      mkdirSync(dirname(join(modTarget, file)), { recursive: true });
      copyFileSync(join(source, file), join(modTarget, file), constants.COPYFILE_EXCL);
    }
    if (sessions) {
      mkdirSync(sessionTarget); ownSessions = true;
      for (const file of sessionFiles) {
        mkdirSync(dirname(join(sessionTarget, file)), { recursive: true });
        copyFileSync(join(sessionsSource, file), join(sessionTarget, file), constants.COPYFILE_EXCL);
      }
    }
    const layoutFile = openSync(layoutTarget, "wx");
    ownLayout = true;
    try { writeFileSync(layoutFile, serialized); }
    finally { closeSync(layoutFile); }
    return { home, mod: modTarget, sessions: sessions ? sessionTarget : null, layout: layoutTarget, sourceLayout };
  } catch (error) {
    // Never remove a pre-existing target, including one created during installation.
    if (ownLayout) rmSync(layoutTarget);
    if (ownMod) rmSync(modTarget, { recursive: true, force: true });
    if (ownSessions) rmSync(sessionTarget, { recursive: true, force: true });
    throw error;
  }
}

function usage() {
  return [
    displayName,
    "",
    "Usage: node install.mjs [--home PATH] [--layout NAME] [--files-only]",
    "",
    "Copies mods/files-plus and mods/sessions-plus, and creates layouts/files-plus.json.",
    "--files-only omits the Sessions panel. History requires Node.js at runtime.",
    "Default home: HERDR_APP_HOME, otherwise ~/.config/herdr-app.",
    "Default source layout: main. Neither target may already exist.",
    "Does not start Herdr or switch its active layout.",
  ].join("\n");
}

function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--files-only") { options.sessions = false; continue; }
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      return;
    }
    if (arg !== "--home" && arg !== "--layout") throw new Error(`Unknown option: ${arg}\n${usage()}`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (Object.hasOwn(options, arg.slice(2))) throw new Error(`Repeated option: ${arg}`);
    options[arg.slice(2)] = value;
  }
  const result = install(options);
  console.log(displayName);
  console.log(`Installed mod: ${result.mod}\nCreated personal layout: ${result.layout}\nOriginal layout unchanged: ${result.sourceLayout}`);
  if (result.sessions) console.log(`Installed sessions mod: ${result.sessions}`);
  console.log('Next: run herdr-app check on the installed mod, then select the files-plus layout.');
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`${displayName}: ${error.message}`); process.exitCode = 1; }
}
