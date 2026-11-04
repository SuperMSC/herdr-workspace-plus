import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { update } from "../update.mjs";
import { LAYOUT_NAME, LEGACY_LAYOUT_NAME } from "../layout-name.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const updateScript = join(packageRoot, "update.mjs");

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function fixture(t, { installed = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "herdr-workspace-plus-update-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const source = join(root, "sources", "files-plus");
  const sessionsSource = join(root, "sources", "sessions-plus");
  mkdirSync(join(home, "mods"), { recursive: true });
  write(join(home, "layouts", "main.json"), JSON.stringify({ id: "files", type: "block", content: { mod: "files" } }));
  write(join(home, "shared.json"), '{"sessions-plus.names":{"fictional-session":"My name"}}\n');
  write(join(home, "keys.json"), '{"global":{}}\n');
  write(join(home, "session-trash", "fictional-record.json"), '{"status":"trashed"}\n');
  write(join(home, "mods", "unrelated", "main.js"), "keep unrelated mod\n");
  for (const folder of [source, sessionsSource]) {
    write(join(folder, "main.js"), "export default class UpdatedMod {}\n");
    write(join(folder, "mod.json"), '{"place":"none"}\n');
    write(join(folder, "icons", "icon.svg"), "<svg/>\n");
  }
  write(join(sessionsSource, "history.mjs"), "export const history = [];\n");
  write(join(sessionsSource, "trash.mjs"), "export const trash = [];\n");
  if (installed) {
    for (const mod of ["files-plus", "sessions-plus"]) {
      write(join(home, "mods", mod, "main.js"), "old version\n");
      write(join(home, "mods", mod, "obsolete", "old.js"), "obsolete\n");
    }
    write(join(home, "layouts", "files-plus.json"), '{\n  "custom": "preserve these exact bytes"\n}\n');
  }
  return { root, home, source, sessionsSource };
}

function tree(root) {
  const result = {};
  function visit(folder, prefix = "") {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name), relative = prefix ? `${prefix}/${name}` : name;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) result[relative] = { link: readlinkSync(path) };
      else if (info.isDirectory()) { result[relative] = { directory: true }; visit(path, relative); }
      else result[relative] = { data: readFileSync(path).toString("base64") };
    }
  }
  visit(root);
  return result;
}

function unchangedOnFailure(f, options, pattern) {
  const before = tree(f.home);
  assert.throws(() => update({ ...f, ...options }), pattern);
  assert.deepEqual(tree(f.home), before);
}

function cli(f, args, extraEnv = {}) {
  return spawnSync(process.execPath, [updateScript, ...args], {
    cwd: f.root,
    env: { ...process.env, HERDR_APP_HOME: f.home, ...extraEnv },
    encoding: "utf8",
    timeout: 20000,
  });
}

test("replaces both mods exactly while preserving layouts, state, recovery records, and other mods", t => {
  const f = fixture(t), before = tree(f.home);
  const result = update(f);
  assert.equal(result.layoutCreated, false);
  assert.deepEqual(tree(join(f.home, "mods", "files-plus")), tree(f.source));
  assert.deepEqual(tree(join(f.home, "mods", "sessions-plus")), tree(f.sessionsSource));
  const after = tree(f.home);
  for (const [name, value] of Object.entries(before)) {
    if (!name.startsWith("mods/files-plus/") && !name.startsWith("mods/sessions-plus/")) assert.deepEqual(after[name], value, name);
  }
  assert.deepEqual(readdirSync(f.home).sort(), ["keys.json", "layouts", "mods", "session-trash", "shared.json"]);
  assert.deepEqual(readdirSync(join(f.home, "mods")).sort(), ["files-plus", "sessions-plus", "unrelated"]);
});

test("first installation creates a layout, then repeated updates preserve it without backup or staging residue", t => {
  const f = fixture(t, { installed: false });
  const result = update(f);
  assert.equal(result.layoutCreated, true);
  assert.equal(result.layoutName, LAYOUT_NAME);
  assert.equal(basename(result.layout), `${LAYOUT_NAME}.json`);
  const layout = JSON.parse(readFileSync(result.layout, "utf8"));
  assert.equal(layout.children[0].content.mod, "files-plus");
  assert.equal(layout.children[1].content.mod, "sessions-plus");
  const first = tree(f.home);
  assert.equal(update(f).layoutCreated, false);
  assert.deepEqual(tree(f.home), first);
  assert(!Object.keys(first).some(name => /backup|workspace-plus-update/.test(name)));
});

test("an existing layout is preserved even when the original layout no longer exists", t => {
  const f = fixture(t);
  rmSync(join(f.home, "layouts", "main.json"));
  const before = readFileSync(join(f.home, "layouts", "files-plus.json"));
  update(f);
  assert.deepEqual(readFileSync(join(f.home, "layouts", "files-plus.json")), before);
});

test("files-only updates leave Sessions byte-for-byte unchanged and do not require its source", t => {
  const f = fixture(t), before = tree(join(f.home, "mods", "sessions-plus"));
  rmSync(f.sessionsSource, { recursive: true });
  const result = update({ ...f, sessions: false });
  assert.deepEqual(result.mods, [realpathSync(join(f.home, "mods", "files-plus"))]);
  assert.deepEqual(tree(join(f.home, "mods", "sessions-plus")), before);
  assert.deepEqual(tree(join(f.home, "mods", "files-plus")), tree(f.source));
});

test("files-only first installation creates no Sessions files or layout references", t => {
  const f = fixture(t, { installed: false });
  const result = update({ ...f, sessions: false });
  assert(!existsSync(join(f.home, "mods", "sessions-plus")));
  assert.equal(JSON.parse(readFileSync(result.layout, "utf8")).content.mod, "files-plus");
});

for (const problem of ["missing source", "missing required file", "malformed manifest", "non-object manifest", "nested source symlink"]) {
  test(`second-mod preflight failure preserves both old mods: ${problem}`, t => {
    const f = fixture(t);
    if (problem === "missing source") rmSync(f.sessionsSource, { recursive: true });
    else if (problem === "missing required file") rmSync(join(f.sessionsSource, "history.mjs"));
    else if (problem === "malformed manifest") write(join(f.sessionsSource, "mod.json"), "{broken");
    else if (problem === "non-object manifest") write(join(f.sessionsSource, "mod.json"), "[]");
    else symlinkSync(join(f.home, "shared.json"), join(f.sessionsSource, "linked.json"));
    unchangedOnFailure(f, {}, /source|JSON|mod.json|regular files|Expected/);
  });
}

test("an unreadable second-mod file preserves old installation before staging starts", { skip: process.getuid?.() === 0 }, t => {
  const f = fixture(t), file = join(f.sessionsSource, "unreadable.js");
  write(file, "cannot read");
  chmodSync(file, 0);
  try { unchangedOnFailure(f, {}, /EACCES|EPERM/); }
  finally { chmodSync(file, 0o600); }
});

for (const relation of ["same", "source inside target", "target inside source", "cross-mod source", "parent symlink alias"]) {
  test(`rejects source/target overlap without changing files: ${relation}`, t => {
    const f = fixture(t), target = join(f.home, "mods", "files-plus");
    let source;
    if (relation === "same") source = target;
    else if (relation === "source inside target") { source = join(target, "source"); mkdirSync(source); }
    else if (relation === "target inside source") source = join(f.home, "mods");
    else if (relation === "cross-mod source") { source = join(f.home, "mods", "sessions-plus"); write(join(source, "mod.json"), "{}"); }
    else { const alias = join(f.root, "alias"); symlinkSync(f.home, alias); source = join(alias, "mods", "files-plus"); }
    unchangedOnFailure(f, { source }, /overlap/);
  });
}

for (const target of ["files-plus", "sessions-plus"]) {
  for (const dangling of [false, true]) {
    test(`rejects ${dangling ? "dangling" : "external"} ${target} target symlink without following it`, t => {
      const f = fixture(t), path = join(f.home, "mods", target), external = join(f.root, "outside");
      if (!dangling) write(join(external, "sentinel.txt"), "preserve outside\n");
      rmSync(path, { recursive: true });
      symlinkSync(external, path);
      unchangedOnFailure(f, {}, /symbolic link/);
      if (!dangling) assert.equal(readFileSync(join(external, "sentinel.txt"), "utf8"), "preserve outside\n");
      else assert(!existsSync(external));
    });
  }
}

test("rejects a source-root symbolic link before modifying installed mods", t => {
  const f = fixture(t), alias = join(f.root, "source-link");
  symlinkSync(f.source, alias);
  unchangedOnFailure(f, { source: alias }, /symbolic link/);
});

for (const folder of ["mods", "layouts"]) {
  test(`rejects a symlinked ${folder} directory without writing through it`, t => {
    const f = fixture(t), path = join(f.home, folder), external = join(f.root, `outside-${folder}`);
    mkdirSync(external);
    write(join(external, "sentinel.txt"), "outside");
    rmSync(path, { recursive: true });
    symlinkSync(external, path);
    unchangedOnFailure(f, {}, /symbolic link/);
    assert.deepEqual(readdirSync(external), ["sentinel.txt"]);
  });
}

test("rejects a symlinked Herdr home", t => {
  const f = fixture(t), alias = join(f.root, "home-link"), before = tree(f.home);
  symlinkSync(f.home, alias);
  assert.throws(() => update({ ...f, home: alias }), /symbolic link/);
  assert.deepEqual(tree(f.home), before);
});

test("removing an obsolete symlink inside a mod leaves its external destination intact", t => {
  const f = fixture(t), outside = join(f.root, "outside");
  write(join(outside, "sentinel.txt"), "keep");
  symlinkSync(outside, join(f.home, "mods", "files-plus", "obsolete-link"));
  update(f);
  assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), "keep");
  assert(!existsSync(join(f.home, "mods", "files-plus", "obsolete-link")));
});

for (const kind of ["symlink", "directory"]) {
  test(`rejects an existing ${kind} at the layout path before replacing mods`, t => {
    const f = fixture(t), path = join(f.home, "layouts", "files-plus.json");
    rmSync(path);
    if (kind === "symlink") symlinkSync(join(f.home, "shared.json"), path);
    else mkdirSync(path);
    unchangedOnFailure(f, {}, /regular file/);
  });
}

test("a missing target layout is validated before old mods are replaced", t => {
  const f = fixture(t);
  rmSync(join(f.home, "layouts", "files-plus.json"));
  for (const text of ["{broken", '{"id":"root","children":[]}']) {
    write(join(f.home, "layouts", "main.json"), text);
    unchangedOnFailure(f, {}, /JSON|Expected|no Files or Changes/);
  }
});

test("invalid layout names and absent homes cause no writes", t => {
  const f = fixture(t);
  for (const layout of ["../main", "/tmp/main", "main.json", ".", "", "dir/main"]) unchangedOnFailure(f, { layout }, /layout/);
  const missing = join(f.root, "missing-home");
  assert.throws(() => update({ ...f, home: missing }), /existing directory/);
  assert(!existsSync(missing));
});

test("failure to create staging keeps the old installation unchanged", { skip: process.getuid?.() === 0 }, t => {
  const f = fixture(t), mods = join(f.home, "mods");
  chmodSync(mods, 0o500);
  try { unchangedOnFailure(f, {}, /EACCES|EPERM/); }
  finally { chmodSync(mods, 0o700); }
});

test("a staging write failure preserves both old mods and removes all staged new files", t => {
  const f = fixture(t), originalWrite = fs.writeFileSync;
  const before = tree(f.home);
  let reachedSecondMod = false;
  fs.writeFileSync = (path, ...args) => {
    if (String(path).includes("/.workspace-plus-update-") && String(path).includes("/sessions-plus/")) {
      reachedSecondMod = true;
      throw Object.assign(new Error("simulated staging write failure"), { code: "ENOSPC" });
    }
    return originalWrite(path, ...args);
  };
  syncBuiltinESMExports();
  try { assert.throws(() => update(f), /simulated staging write failure/); }
  finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
  assert.equal(reachedSecondMod, true);
  assert.deepEqual(tree(f.home), before);
});

test("a replacement failure reports partial progress, cleans staging, and can be recovered by rerunning", t => {
  const f = fixture(t), originalRename = fs.renameSync;
  const sessionTarget = join(realpathSync(f.home), "mods", "sessions-plus");
  const preservedLayout = readFileSync(join(f.home, "layouts", "files-plus.json"));
  fs.renameSync = (from, to) => {
    if (to === sessionTarget) throw Object.assign(new Error("simulated replacement failure"), { code: "EACCES" });
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => update(f), /Update stopped after replacement began.*No backup was kept.*simulated replacement failure/);
  } finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
  assert.deepEqual(tree(join(f.home, "mods", "files-plus")), tree(f.source));
  assert(!existsSync(sessionTarget));
  assert.deepEqual(readdirSync(join(f.home, "mods")).sort(), ["files-plus", "unrelated"]);
  assert.deepEqual(readFileSync(join(f.home, "layouts", "files-plus.json")), preservedLayout);
  update(f);
  assert.deepEqual(tree(join(f.home, "mods", "files-plus")), tree(f.source));
  assert.deepEqual(tree(sessionTarget), tree(f.sessionsSource));
  assert.deepEqual(readdirSync(join(f.home, "mods")).sort(), ["files-plus", "sessions-plus", "unrelated"]);
});

test("CLI supports --home and a named layout from a different working directory", t => {
  const f = fixture(t, { installed: false });
  write(join(f.home, "layouts", "personal.json"), readFileSync(join(f.home, "layouts", "main.json")));
  rmSync(join(f.home, "layouts", "main.json"));
  const ignored = join(f.root, "ignored-env-home");
  const result = cli(f, ["--home", f.home, "--layout", "personal"], { HERDR_APP_HOME: ignored });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Created layout/);
  assert(!existsSync(ignored));
  assert.deepEqual(tree(join(f.home, "mods", "files-plus")), tree(join(packageRoot, "mods", "files-plus")));
  assert.deepEqual(tree(join(f.home, "mods", "sessions-plus")), tree(join(packageRoot, "mods", "sessions-plus")));
});

test("CLI uses HERDR_APP_HOME and preserves existing Sessions with --files-only", t => {
  const f = fixture(t), before = tree(join(f.home, "mods", "sessions-plus"));
  const result = cli(f, ["--files-only"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Preserved layout/);
  assert.deepEqual(tree(join(f.home, "mods", "sessions-plus")), before);
  assert.deepEqual(tree(join(f.home, "mods", "files-plus")), tree(join(packageRoot, "mods", "files-plus")));
});

test("CLI help and invalid arguments never modify the installation", t => {
  const f = fixture(t), before = tree(f.home);
  const help = cli(f, ["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /No backups/);
  for (const args of [["--pull"], ["--home"], ["--layout"], ["--home", f.home, "--home", f.home]]) {
    const result = cli(f, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown option|Missing value|Repeated option/);
    assert.deepEqual(tree(f.home), before);
  }
});

function oldWorkspaceLayout() {
  return {
    id: "root", type: "row", titlebar: "none", traffic_lights: [12, 16], custom: { retain: ["user", "settings"] },
    children: [
      { id: "sidebar", type: "block", size: { px: 300 }, content: { mod: "spaces" } },
      { id: "work", type: "column", children: [
        { id: "tabs", type: "block", size: { px: 42 }, window_drag: true, content: { mod: "tabs", props: { keep: true } } },
        { id: "work-body", type: "row", padding: 11, children: [
          { id: "main", type: "block", content: { tab: "active", pane: { radius: 8 } } },
          { id: "panel", type: "column", hidden: true, size: { px: 410 }, children: [
            { id: "panel-body", type: "stack", active: "changes", children: [
              { id: "files", type: "block", content: { mod: "files-plus" } },
              { id: "changes", type: "block", content: { mod: "files-plus", props: { role: "changes" } } },
            ] },
            { id: "my-session-history", type: "block", size: { weight: 2 }, content: { mod: "sessions-plus", props: { node: "/custom/node", stores: { claude: "/custom/store" }, mySetting: true } } },
          ] },
        ] },
        { id: "status", type: "block", size: { px: 28 }, content: { mod: "workspace-status" } },
      ] },
    ],
  };
}

function findLayoutNode(root, id) {
  if (root.id === id) return root;
  for (const child of root.children ?? []) { const found = findLayoutNode(child, id); if (found) return found; }
  return null;
}

function layoutParent(root, id) {
  for (const child of root.children ?? []) {
    if (child.id === id) return root;
    const found = layoutParent(child, id); if (found) return found;
  }
  return null;
}

test("explicit layout integration preserves custom settings and state without backups and is repeatable", t => {
  const f = fixture(t), layoutPath = join(f.home, "layouts", "files-plus.json"), source = oldWorkspaceLayout();
  write(layoutPath, JSON.stringify(source));
  write(join(f.home, "layouts", ".state", "files-plus.json"), '{"saved-width":410}\n');
  const before = tree(f.home), result = update({ ...f, integrateLayout: true });
  assert.equal(result.layoutCreated, false);
  assert.equal(result.layoutUpdated, true);
  const migrated = JSON.parse(readFileSync(layoutPath, "utf8"));
  assert.deepEqual(migrated.custom, source.custom);
  for (const id of ["sidebar", "main", "files", "changes"]) assert.deepEqual(findLayoutNode(migrated, id), findLayoutNode(source, id));
  assert.deepEqual(findLayoutNode(migrated, "panel").size, { px: 410 });
  assert.equal(findLayoutNode(migrated, "panel").hidden, true);
  assert.equal(findLayoutNode(migrated, "panel-body").active, "changes");
  assert.equal(findLayoutNode(migrated, "panel-body").children[2].id, "my-session-history");
  const props = findLayoutNode(source, "my-session-history").content.props;
  assert.deepEqual(findLayoutNode(migrated, "my-session-history").content.props, { ...props, role: "sessions" });
  assert.deepEqual(layoutParent(migrated, "tabs").children[1].content.props, { ...props, role: "toolbar", panel: "panel", stack: "panel-body", child: "my-session-history" });
  assert.deepEqual(findLayoutNode(migrated, "status").content.props, { ...props, role: "footer" });
  const after = tree(f.home);
  for (const [name, value] of Object.entries(before)) {
    if (name !== "layouts/files-plus.json" && !name.startsWith("mods/files-plus/") && !name.startsWith("mods/sessions-plus/")) assert.deepEqual(after[name], value, name);
  }
  assert.deepEqual(readdirSync(join(f.home, "layouts")).sort(), [".state", "files-plus.json", "main.json"]);
  assert.deepEqual(readdirSync(join(f.home, "mods")).sort(), ["files-plus", "sessions-plus", "unrelated"]);
  assert(!Object.keys(after).some(name => /backup|workspace-plus-update-|workspace-plus-layout-/.test(name)));
  const again = update({ ...f, integrateLayout: true });
  assert.equal(again.layoutUpdated, false);
  assert.deepEqual(tree(f.home), after);
});

test("ordinary updates preserve an otherwise integratable old layout byte for byte", t => {
  const f = fixture(t), layoutPath = join(f.home, "layouts", "files-plus.json");
  const original = JSON.stringify(oldWorkspaceLayout(), null, 4) + "\n\n";
  write(layoutPath, original);
  const result = update(f);
  assert.equal(result.layoutUpdated, false);
  assert.equal(readFileSync(layoutPath, "utf8"), original);
  assert.equal(findLayoutNode(JSON.parse(original), "tabs").type, "block");
});

test("unsupported existing layouts are rejected before replacing either mod", t => {
  const f = fixture(t);
  unchangedOnFailure(f, { integrateLayout: true }, /custom layout cannot be integrated/);
});

test("files-only and explicit layout integration cannot be combined in the API or CLI", t => {
  const f = fixture(t), before = tree(f.home);
  unchangedOnFailure(f, { sessions: false, integrateLayout: true }, /cannot be combined/);
  const result = cli(f, ["--files-only", "--integrate-layout"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be combined/);
  assert.deepEqual(tree(f.home), before);
});

test("the CLI integration flag migrates once and preserves the resulting layout on repeat", t => {
  const f = fixture(t), layoutPath = join(f.home, "layouts", "files-plus.json");
  write(layoutPath, JSON.stringify(oldWorkspaceLayout()));
  const first = cli(f, ["--integrate-layout"]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Updated layout/);
  assert.equal(findLayoutNode(JSON.parse(readFileSync(layoutPath, "utf8")), "status").content.props.role, "footer");
  const migrated = readFileSync(layoutPath);
  const second = cli(f, ["--integrate-layout"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Preserved layout/);
  assert.deepEqual(readFileSync(layoutPath), migrated);
});

test("a layout edited during mod replacement is not overwritten by the prepared migration", t => {
  const f = fixture(t), layoutPath = join(f.home, "layouts", "files-plus.json"), source = oldWorkspaceLayout();
  write(layoutPath, JSON.stringify(source));
  const newer = JSON.stringify({ ...source, userEdit: "changed while update was running" }, null, 4) + "\n";
  const originalRename = fs.renameSync;
  const filesTarget = join(realpathSync(f.home), "mods", "files-plus");
  let modified = false;
  fs.renameSync = (from, to) => {
    if (to === filesTarget) { write(layoutPath, newer); modified = true; }
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => update({ ...f, integrateLayout: true }), /layout changed during this update; it was not overwritten/);
  } finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
  assert.equal(modified, true);
  assert.equal(readFileSync(layoutPath, "utf8"), newer);
  assert.deepEqual(tree(join(f.home, "mods", "files-plus")), tree(f.source));
  assert.deepEqual(tree(join(f.home, "mods", "sessions-plus")), tree(f.sessionsSource));
  assert.deepEqual(readdirSync(join(f.home, "layouts")).sort(), ["files-plus.json", "main.json"]);
  assert.deepEqual(readdirSync(join(f.home, "mods")).sort(), ["files-plus", "sessions-plus", "unrelated"]);
});


test("updates prefer the current named layout and leave a legacy layout intact", t => {
  const f = fixture(t), currentPath = join(f.home, "layouts", `${LAYOUT_NAME}.json`), legacyPath = join(f.home, "layouts", `${LEGACY_LAYOUT_NAME}.json`);
  const legacy = readFileSync(legacyPath);
  const current = JSON.stringify(oldWorkspaceLayout(), null, 3) + "\n";
  write(currentPath, current);
  const result = update(f);
  assert.equal(result.layoutName, LAYOUT_NAME);
  assert.equal(result.layoutCreated, false);
  assert.equal(result.layoutUpdated, false);
  assert.equal(readFileSync(currentPath, "utf8"), current);
  assert.deepEqual(readFileSync(legacyPath), legacy);
});
