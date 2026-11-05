import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { cloneLayout, install } from "../install.mjs";
import { LAYOUT_NAME } from "../layout-name.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "herdr-files-plus-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const source = join(root, "source");
  mkdirSync(join(home, "mods"), { recursive: true });
  mkdirSync(join(home, "layouts"));
  mkdirSync(join(source, "icons"), { recursive: true });
  writeFileSync(join(source, "main.js"), "export default class FilesPlus {}\n");
  writeFileSync(join(source, "mod.json"), '{"place":"none"}\n');
  writeFileSync(join(source, "icons", "file.svg"), "<svg/>\n");
  const layout = {
    id: "root", type: "row", background: "canvas", custom: { retain: true },
    children: [
      { id: "main", type: "block", content: { tab: "active" } },
      { id: "panel", type: "column", hidden: true, size: { px: 368 }, children: [
        { id: "panel-body", type: "stack", active: "changes", children: [
          { id: "files", type: "block", content: { mod: "files", props: { retained: true } } },
          { id: "changes", type: "block", content: { mod: "changes" } },
        ] },
      ] },
    ],
  };
  const original = JSON.stringify(layout, null, 2) + "\n";
  writeFileSync(join(home, "layouts", "main.json"), original);
  writeFileSync(join(home, "shared.json"), '{"layout":"main","workspace.panels":["changes"]}\n');
  writeFileSync(join(home, "keys.json"), '{"global":{}}\n');
  return { root, home, source, document: layout, original, sessions: false };
}

test("installs a separate Files and Changes mod with Files selected, preserving all source settings", (t) => {
  const f = fixture(t);
  const result = install(f);
  assert.equal(basename(result.layout), `${LAYOUT_NAME}.json`);
  const actual = JSON.parse(readFileSync(result.layout, "utf8"));
  const expected = structuredClone(f.document);
  expected.children[1].hidden = false;
  expected.children[1].children[0].active = "files";
  expected.children[1].children[0].children[0].content.mod = "files-plus";
  expected.children[1].children[0].children[1].content = { mod: "files-plus", props: { role: "changes" } };
  assert.deepEqual(actual, expected);
  assert.equal(readFileSync(result.sourceLayout, "utf8"), f.original);
  assert.equal(readFileSync(join(f.home, "shared.json"), "utf8"), '{"layout":"main","workspace.panels":["changes"]}\n');
  assert.equal(readFileSync(join(f.home, "keys.json"), "utf8"), '{"global":{}}\n');
  assert.equal(readFileSync(join(result.mod, "icons", "file.svg"), "utf8"), "<svg/>\n");
  assert.deepEqual(readdirSync(join(f.home, "mods")), ["files-plus"]);
});

for (const kind of ["mod directory", "layout file", "dangling mod symlink"]) {
  test(`refuses an existing ${kind} without touching it`, (t) => {
    const f = fixture(t);
    const target = kind === "layout file" ? join(f.home, "layouts", "files-plus.json") : join(f.home, "mods", "files-plus");
    if (kind === "mod directory") { mkdirSync(target); writeFileSync(join(target, "mine.txt"), "keep"); }
    else if (kind === "layout file") writeFileSync(target, "keep");
    else symlinkSync(join(f.root, "missing"), target);
    assert.throws(() => install(f), /Refusing to overwrite/);
    assert.equal(readFileSync(join(f.home, "layouts", "main.json"), "utf8"), f.original);
    if (kind === "mod directory") assert.equal(readFileSync(join(target, "mine.txt"), "utf8"), "keep");
    if (kind === "layout file") {
      assert.equal(readFileSync(target, "utf8"), "keep");
      assert.deepEqual(readdirSync(join(f.home, "mods")), []);
    }
    if (kind === "dangling mod symlink") assert.equal(lstatSync(target).isSymbolicLink(), true);
  });
}

test("supports a named personal layout without changing it", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.home, "layouts", "my-layout.json"), f.original);
  const result = install({ ...f, layout: "my-layout" });
  assert.equal(result.sourceLayout, join(f.home, "layouts", "my-layout.json"));
  assert.equal(readFileSync(result.sourceLayout, "utf8"), f.original);
});

test("a missing home is not created", (t) => {
  const f = fixture(t);
  const home = join(f.root, "not-installed");
  assert.throws(() => install({ ...f, home }), /Herdr home is missing/);
  assert.equal(existsSync(home), false);
});

test("invalid JSON or a layout with neither Files nor Changes writes no targets", (t) => {
  const f = fixture(t);
  for (const value of ["{broken", '{"id":"root","type":"row","children":[]}']) {
    writeFileSync(join(f.home, "layouts", "main.json"), value);
    assert.throws(() => install(f));
    assert.equal(existsSync(join(f.home, "mods", "files-plus")), false);
    assert.equal(existsSync(join(f.home, "layouts", `${LAYOUT_NAME}.json`)), false);
  }
});

test("layout names cannot leave the layouts directory", (t) => {
  const f = fixture(t);
  for (const layout of ["../main", "/tmp/main", "main.json", ".", "", "dir/main"]) {
    assert.throws(() => install({ ...f, layout }), /layout/);
  }
  assert.deepEqual(readdirSync(join(f.home, "mods")), []);
});

test("source symlinks are rejected before writing anything", (t) => {
  const f = fixture(t);
  symlinkSync(join(f.home, "keys.json"), join(f.source, "escape"));
  assert.throws(() => install(f), /only regular files/);
  assert.deepEqual(readdirSync(join(f.home, "mods")), []);
});

test("a failed copy removes only its partial installation", { skip: process.getuid?.() === 0 }, (t) => {
  const f = fixture(t);
  const locked = join(f.source, "unreadable.txt");
  writeFileSync(locked, "private");
  chmodSync(locked, 0);
  t.after(() => { if (existsSync(locked)) chmodSync(locked, 0o600); });
  assert.throws(() => install(f), /EACCES|EPERM/);
  assert.deepEqual(readdirSync(join(f.home, "mods")), []);
  assert.equal(existsSync(join(f.home, "layouts", `${LAYOUT_NAME}.json`)), false);
  assert.equal(readFileSync(join(f.home, "layouts", "main.json"), "utf8"), f.original);
});

test("cloneLayout does not modify its argument and leaves unrelated stacks intact", (t) => {
  const f = fixture(t);
  f.document.children.push({ id: "other", type: "stack", hidden: true, active: "a", children: [
    { id: "a", type: "block", content: { mod: "agents" } },
  ] });
  const before = structuredClone(f.document);
  const result = cloneLayout(f.document);
  assert.deepEqual(f.document, before);
  assert.deepEqual(result.children[2], before.children[2]);
});

test("installs a Changes-only layout, preserving props while selecting its Changes role", (t) => {
  const f = fixture(t);
  const document = {
    id: "root", type: "row", children: [
      { id: "panel", type: "column", hidden: true, children: [
        { id: "switcher", type: "stack", active: "other", children: [
          { id: "other", type: "block", content: { mod: "agents" } },
          { id: "diff", type: "block", hidden: true, content: {
            mod: "changes", props: { role: "old-ignored-role", retained: true, nested: { a: 1 } },
          } },
        ] },
      ] },
    ],
  };
  const original = JSON.stringify(document);
  writeFileSync(join(f.home, "layouts", "main.json"), original);
  const result = install(f);
  const actual = JSON.parse(readFileSync(result.layout, "utf8"));
  const panel = actual.children[0], stack = panel.children[0], changes = stack.children[1];
  assert.equal(panel.hidden, false);
  assert.equal(stack.active, "diff");
  assert.equal(changes.hidden, false);
  assert.deepEqual(changes.content, {
    mod: "files-plus", props: { role: "changes", retained: true, nested: { a: 1 } },
  });
  assert.equal(readFileSync(result.sourceLayout, "utf8"), original);
});

test("Files takes visibility priority even when Changes is encountered first", () => {
  const source = {
    id: "root", type: "stack", active: "changes-column", children: [
      { id: "changes-column", type: "column", hidden: true, children: [
        { id: "changes", type: "block", hidden: true, content: { mod: "changes", props: { retained: 1 } } },
      ] },
      { id: "files-column", type: "column", hidden: true, children: [
        { id: "files", type: "block", hidden: true, content: { mod: "files", props: { retained: 2 } } },
      ] },
    ],
  };
  const actual = cloneLayout(source);
  assert.equal(actual.active, "files-column");
  assert.equal(actual.children[0].hidden, true);
  assert.equal(actual.children[0].children[0].hidden, true);
  assert.equal(actual.children[1].hidden, false);
  assert.equal(actual.children[1].children[0].hidden, false);
  assert.deepEqual(actual.children[0].children[0].content, { mod: "files-plus", props: { retained: 1, role: "changes" } });
  assert.deepEqual(actual.children[1].children[0].content, { mod: "files-plus", props: { retained: 2 } });
});

test("a Files-only layout keeps the browser role and other content properties", () => {
  const source = { id: "files", type: "block", hidden: true, content: { mod: "files", props: { custom: true }, title: "Source" } };
  const actual = cloneLayout(source);
  assert.deepEqual(actual, { id: "files", type: "block", hidden: false, content: { mod: "files-plus", props: { custom: true }, title: "Source" } });
  assert.equal(source.content.mod, "files");
  assert.equal(source.hidden, true);
});

test("every Files and Changes instance is replaced while unrelated mods stay intact", () => {
  const source = { id: "root", type: "column", children: [
    { id: "one", type: "block", content: { mod: "files" } },
    { id: "two", type: "block", content: { mod: "changes" } },
    { id: "three", type: "block", content: { mod: "changes", props: { custom: 3 } } },
    { id: "four", type: "block", content: { mod: "files" } },
    { id: "five", type: "block", content: { mod: "my-changes" } },
  ] };
  const actual = cloneLayout(source);
  assert.deepEqual(actual.children.map(n => n.content.mod), ["files-plus", "files-plus", "files-plus", "files-plus", "my-changes"]);
  assert.deepEqual(actual.children[2].content.props, { custom: 3, role: "changes" });
  assert.equal(actual.children[0].content.props, undefined);
});

test("a role previously ignored by Files cannot select the Changes view after installation", () => {
  const source = { id: "files", type: "block", content: { mod: "files", props: { role: "changes", retained: true } } };
  const actual = cloneLayout(source);
  assert.deepEqual(actual.content, { mod: "files-plus", props: { retained: true } });
  assert.deepEqual(source.content.props, { role: "changes", retained: true });
});

test("default installation adds the independent Sessions mod below the right panel", t => {
  const f = fixture(t), result = install({ ...f, sessions: true });
  assert.deepEqual(readdirSync(join(f.home, "mods")).sort(), ["files-plus", "sessions-plus"]);
  assert(existsSync(join(result.sessions, "history.mjs")));
  assert(existsSync(join(result.sessions, "trash.mjs")));
  const layout = JSON.parse(readFileSync(result.layout, "utf8"));
  assert.equal(layout.children[1].children[0].id, "panel-body");
  assert.equal(layout.children[1].children[1].content.mod, "sessions-plus");
  assert.equal(readFileSync(result.sourceLayout, "utf8"), f.original);
  assert.equal(readFileSync(join(f.home, "shared.json"), "utf8"), '{"layout":"main","workspace.panels":["changes"]}\n');
});

test("an existing Sessions mod prevents all installation writes", t => {
  const f = fixture(t); mkdirSync(join(f.home, "mods", "sessions-plus"));
  assert.throws(() => install({ ...f, sessions: true }), /Refusing to overwrite/);
  assert(!existsSync(join(f.home, "mods", "files-plus")));
  assert(!existsSync(join(f.home, "layouts", `${LAYOUT_NAME}.json`)));
});

test("a custom Files-only layout gains Sessions while keeping its external block id", () => {
  const source = { id: "files", type: "block", size: { px: 400 }, content: { mod: "files", props: { custom: true } } };
  const actual = cloneLayout(source, { sessions: true });
  assert.equal(actual.id, "files"); assert.equal(actual.type, "column"); assert.deepEqual(actual.size, source.size);
  assert.equal(actual.children[0].content.mod, "files-plus"); assert.equal(actual.children[1].content.mod, "sessions-plus");
  assert.equal(source.type, "block");
});

test("a first installation of the full workspace puts Sessions in the stack with toolbar and full footer roles", t => {
  const f = fixture(t);
  const original = {
    ...f.document,
    titlebar: "none", traffic_lights: [12, 16],
    children: [
      { id: "sidebar", type: "block", size: { px: 268 }, content: { mod: "spaces" } },
      { id: "work", type: "column", children: [
        { id: "tabs", type: "block", size: { px: 42 }, window_drag: true, content: { mod: "tabs", props: { nativeSetting: true } } },
        { id: "work-body", type: "row", gap: 8, children: f.document.children },
        { id: "status", type: "block", size: { px: 28 }, content: { mod: "workspace-status" } },
      ] },
    ],
  };
  const serialized = JSON.stringify(original, null, 2) + "\n";
  writeFileSync(join(f.home, "layouts", "main.json"), serialized);
  const cloned = cloneLayout(original, { sessions: true });
  const result = install({ ...f, sessions: true });
  const actual = JSON.parse(readFileSync(result.layout, "utf8"));
  assert.deepEqual(actual, cloned);
  const work = actual.children[1], header = work.children[0], panel = work.children[1].children[1], footer = work.children[2];
  assert.equal(header.children[0].id, "tabs");
  assert.equal(header.type, "row");
  assert.equal(header.window_drag, true);
  assert.deepEqual(header.size, { px: 42 });
  assert.deepEqual(header.children[0].content, original.children[1].children[0].content);
  assert.equal(header.children[1].content.props.role, "toolbar");
  assert.equal(header.children[1].content.props.child, "files-plus-sessions");
  assert.deepEqual(panel.children.map(node => node.id), ["panel-body"]);
  assert.deepEqual(panel.children[0].children.map(node => node.content.mod), ["files-plus", "files-plus", "sessions-plus"]);
  assert.equal(panel.children[0].children[2].content.props.role, "sessions");
  assert.equal(footer.id, "status");
  assert.equal(footer.content.mod, "sessions-plus");
  assert.equal(footer.content.props.role, "footer");
  assert.equal(footer.children, undefined);
  assert.deepEqual(footer.size, { px: 28 });
  assert.deepEqual(actual.custom, original.custom);
  assert.equal(readFileSync(result.sourceLayout, "utf8"), serialized);
  assert.equal(readFileSync(join(f.home, "shared.json"), "utf8"), '{"layout":"main","workspace.panels":["changes"]}\n');
  assert.equal(readFileSync(join(f.home, "keys.json"), "utf8"), '{"global":{}}\n');
});

test("installation does not install or overwrite the retired Spaces addon", t => {
  const f = fixture(t);
  mkdirSync(join(f.home, "mods", "spaces-plus"));
  writeFileSync(join(f.home, "mods", "spaces-plus", "mine.txt"), "keep");
  const result = install({ ...f, sessions: true });
  assert.equal(result.spaces, undefined);
  assert.deepEqual(readdirSync(join(f.home, "mods")).sort(), ["files-plus", "sessions-plus", "spaces-plus"]);
  assert.equal(readFileSync(join(f.home, "mods", "spaces-plus", "mine.txt"), "utf8"), "keep");
});


test("a cloned layout restores retired Spaces references without changing node settings", () => {
  const spaces = { id: "spaces", type: "block", size: { px: 270 }, hidden: true, content: { mod: "spaces-plus", props: { custom: true } } };
  const original = { id: "root", type: "row", children: [spaces, { id: "files", type: "block", content: { mod: "files" } }] };
  const before = structuredClone(original), result = cloneLayout(original, { sessions: true });
  assert.deepEqual(original, before);
  assert.deepEqual(result.children[0], { ...spaces, content: { ...spaces.content, mod: "spaces" } });
});
