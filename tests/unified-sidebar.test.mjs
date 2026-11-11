import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { useUnifiedSidebar, hasUnifiedSidebar, UNIFIED_SIDEBAR_META } from "../workspace-layout.mjs";
import { install, cloneLayout } from "../install.mjs";
import { update } from "../update.mjs";
import { LAYOUT_NAME } from "../layout-name.mjs";

function fixtureLayout({ native = false } = {}) {
  return { id: "root", type: "row", settings: { retained: true }, children: [
    { id: "sidebar", type: "column", size: { px: 268 }, min: 44, max: 480, background: "chrome", children: [
      { id: "brand", type: "block", size: { px: 46 }, content: { mod: "workspace-chrome" } },
      { id: "sidebar-lists", type: "column", size: { weight: 3 }, gap: 2, divider: { color: "border", width: 3 }, children: [
        { id: "spaces", type: "block", size: { px: 220 }, min: 80, max: 400, padding: [1, 2], localStorage: { fixture: "retained" }, content: { mod: native ? "spaces" : "project-spaces", title: "Projects", props: { a: 1, nested: { keep: true }, unified: false } } },
        { id: "agents", type: "block", size: { weight: 2 }, min: 99, max: 350, background: "surface", content: { mod: native ? "agents" : "agents-plus", props: { pinned: "split", fixture: { b: 2 } } } },
      ] },
      { id: "sidebar-extra", type: "block", content: { mod: "user-widget", props: { untouched: true } } },
      { id: "sidebar-footer", type: "block", size: { px: 69 }, content: { mod: "workspace-chrome", props: { footer: true } } },
    ] },
    { id: "work", type: "column", children: [{ id: "active", type: "block", content: { tab: "active" } }, { id: "panel", type: "stack", active: "files", children: [{ id: "files", type: "block", content: { mod: native ? "files" : "files-plus" } }] }, { id: "status", type: "block", content: { mod: "sessions-plus", props: { role: "footer" } } }] },
  ] };
}
const lists = layout => layout.children[0].children[1];

test("unification preserves the Spaces identity and props, gives it the full list height, and round-trips every original JSON field", () => {
  for (const reverse of [false, true]) {
    const original = fixtureLayout(); if (reverse) lists(original).children.reverse(); const before = JSON.stringify(original), result = useUnifiedSidebar(original);
    assert.equal(JSON.stringify(original), before); assert(result.changed && result.unified && result.restorable); assert.equal(lists(result.layout).children.length, 1);
    const merged = lists(result.layout).children[0], spaces = lists(original).children.find(row => row.id === "spaces");
    assert.equal(merged.id, spaces.id); assert.deepEqual(merged.content, { ...spaces.content, props: { ...spaces.content.props, unified: true } }); assert.deepEqual(merged.localStorage, spaces.localStorage);
    assert.deepEqual(merged.size, { weight: 1 }); assert.equal(merged.min, 0); assert.equal(merged.max, undefined);
    assert.deepEqual(result.layout[UNIFIED_SIDEBAR_META].originalChildren, lists(original).children);
    assert.deepEqual(result.layout.children[0].children.filter(row => row.id !== "sidebar-lists"), original.children[0].children.filter(row => row.id !== "sidebar-lists")); assert.deepEqual(result.layout.children[1], original.children[1]);
    const again = useUnifiedSidebar(result.layout); assert.equal(again.changed, false); assert.deepEqual(again.layout, result.layout);
    const restored = useUnifiedSidebar(result.layout, false); assert(restored.changed && !restored.unified); assert.equal(JSON.stringify(restored.layout), before); assert.equal(useUnifiedSidebar(restored.layout, false).changed, false);
  }
});

test("single-block unified layouts are recognized without inventing a restore snapshot", () => {
  const original = useUnifiedSidebar(fixtureLayout()).layout; delete original[UNIFIED_SIDEBAR_META];
  const result = useUnifiedSidebar(original); assert.equal(result.changed, false); assert(result.unified); assert.equal(result.restorable, false); assert(hasUnifiedSidebar(original)); assert.throws(() => useUnifiedSidebar(original, false), /no original-block metadata/);
});

for (const problem of ["extra component", "extra nested component", "unknown mod", "duplicate spaces", "duplicate lists", "wrong parent", "duplicate live id", "malformed props", "conflicting flag"]) test(`unknown or ambiguous sidebar refuses without mutation: ${problem}`, () => {
  const source = fixtureLayout();
  if (problem === "extra component") lists(source).children.push({ id: "mine", type: "block", content: { mod: "mine" } });
  if (problem === "extra nested component") lists(source).children[0].children = [{ id: "nested", type: "block", content: { mod: "mine" } }];
  if (problem === "unknown mod") lists(source).children[1].content.mod = "my-agents";
  if (problem === "duplicate spaces") lists(source).children[1].content.mod = "project-spaces";
  if (problem === "duplicate lists") source.children.push(structuredClone(lists(source)));
  if (problem === "wrong parent") source.children[0].id = "other-sidebar";
  if (problem === "duplicate live id") source.children[1].children.push({ id: "spaces", type: "block", content: { mod: "mine" } });
  if (problem === "malformed props") lists(source).children[0].content.props = [];
  if (problem === "conflicting flag") lists(source).children[0].content.props.unified = true;
  const before = JSON.stringify(source); assert.throws(() => useUnifiedSidebar(source)); assert.equal(JSON.stringify(source), before);
});

test("restoration refuses current edits, added components, original ID collisions, and tampered backup metadata", () => {
  for (const change of [layout => { lists(layout).children[0].content.props.newUserSetting = true; }, layout => { lists(layout).children.push({ id: "mine", type: "block", content: { mod: "mine" } }); }, layout => { layout.children[1].children.push({ id: "agents", type: "block", content: { mod: "mine" } }); }, layout => { layout[UNIFIED_SIDEBAR_META].originalChildren[1].content.props.fixture.b = "edited"; }, layout => { layout[UNIFIED_SIDEBAR_META].version = 2; }, layout => { layout[UNIFIED_SIDEBAR_META].extra = "user data"; }]) {
    const source = useUnifiedSidebar(fixtureLayout()).layout; change(source); const before = JSON.stringify(source); assert.throws(() => useUnifiedSidebar(source, false)); assert.equal(JSON.stringify(source), before);
  }
  const source = fixtureLayout(); source[UNIFIED_SIDEBAR_META] = { user: "not ours" }; assert.throws(() => useUnifiedSidebar(source), /metadata/);
});

function homeFixture(t, { existing = false, layout = fixtureLayout({ native: !existing }) } = {}) {
  const base = mkdtempSync("/private/tmp/unified-sidebar-test-"); t.after(() => rmSync(base, { recursive: true, force: true })); const home = join(base, "home"), sources = join(base, "sources"); mkdirSync(join(home, "mods"), { recursive: true }); mkdirSync(join(home, "layouts"));
  const source = join(sources, "files-plus"), projectsSource = join(sources, "project-spaces"), agentsSource = join(sources, "agents-plus");
  for (const folder of [source, projectsSource, agentsSource]) { mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, "main.js"), "export default class Fixture {}\n"); writeFileSync(join(folder, "model.js"), "export const fixture = true;\n"); writeFileSync(join(folder, "mod.json"), '{"place":"none"}'); }
  writeFileSync(join(home, "layouts", "main.json"), JSON.stringify(fixtureLayout({ native: true }), null, 2) + "\n");
  if (existing) writeFileSync(join(home, "layouts", `${LAYOUT_NAME}.json`), JSON.stringify(layout, null, 2) + "\n");
  writeFileSync(join(home, "layouts", "unrelated.json"), '{"user":"retain exact bytes"}\n'); writeFileSync(join(home, "shared.json"), '{"project-spaces.v1":{"assign":{"s":"group:mine"}},"agents-plus.pinned":"split"}\n'); writeFileSync(join(home, "keys.json"), '{"global":{"ctrl-j":"mine"}}\n'); writeFileSync(join(home, "settings.json"), '{"zoom":1.2}\n');
  return { base, home, source, projectsSource, agentsSource, sessions: false };
}
const retained = f => ["shared.json", "keys.json", "settings.json", "layouts/unrelated.json"].map(name => readFileSync(join(f.home, name), "utf8"));

test("install/clone unified flags are opt-in, prepare both mods, and never alter the source layout or user state", t => {
  const native = fixtureLayout({ native: true }), ordinary = cloneLayout(native); assert.equal(lists(ordinary).children.length, 2); assert.equal(lists(ordinary).children[0].content.mod, "spaces");
  const f = homeFixture(t), before = retained(f), original = readFileSync(join(f.home, "layouts", "main.json"), "utf8"), result = install({ ...f, unifiedSidebar: true });
  const installed = JSON.parse(readFileSync(result.layout, "utf8")); assert.equal(lists(installed).children.length, 1); assert.equal(lists(installed).children[0].content.props.unified, true); assert.deepEqual(readdirSync(join(f.home, "mods")).sort(), ["agents-plus", "files-plus", "project-spaces"]); assert.deepEqual(retained(f), before); assert.equal(readFileSync(join(f.home, "layouts", "main.json"), "utf8"), original);
});

test("explicit update unifies once, default update preserves bytes, and separate restores the exact original block geometry", t => {
  const f = homeFixture(t, { existing: true }), before = retained(f), target = join(f.home, "layouts", `${LAYOUT_NAME}.json`), original = readFileSync(target, "utf8");
  const first = update({ ...f, unifiedSidebar: true }); assert(first.layoutUpdated); const unified = readFileSync(target, "utf8"); assert.equal(lists(JSON.parse(unified)).children.length, 1);
  assert.equal(update({ ...f, unifiedSidebar: true }).layoutUpdated, false); assert.equal(readFileSync(target, "utf8"), unified);
  assert.equal(update(f).layoutUpdated, false); assert.equal(readFileSync(target, "utf8"), unified);
  assert.equal(update({ ...f, unifiedSidebar: false }).layoutUpdated, true); assert.equal(readFileSync(target, "utf8"), original); assert.deepEqual(retained(f), before);
  assert.equal(update({ ...f, unifiedSidebar: false }).layoutUpdated, false); assert.deepEqual(readdirSync(join(f.home, "mods")).sort(), ["agents-plus", "files-plus", "project-spaces"]);
});

test("unsupported explicit migrations and conflicting native flags fail before replacing any mod", t => {
  const source = fixtureLayout(); lists(source).children.push({ id: "user", type: "block", content: { mod: "user" } }); const f = homeFixture(t, { existing: true, layout: source }); const target = join(f.home, "layouts", `${LAYOUT_NAME}.json`), before = readFileSync(target, "utf8");
  assert.throws(() => update({ ...f, unifiedSidebar: true }), /exactly/); assert.deepEqual(readdirSync(join(f.home, "mods")), []); assert.equal(readFileSync(target, "utf8"), before);
  assert.throws(() => update({ ...f, unifiedSidebar: true, projects: false }), /cannot be combined/); assert.throws(() => update({ ...f, unifiedSidebar: true, agents: false }), /cannot be combined/);
});

test("native-list requests require an explicit separate restore and then keep user settings", t => {
  const f = homeFixture(t, { existing: true, layout: useUnifiedSidebar(fixtureLayout()).layout }); assert.throws(() => update({ ...f, projects: false }), /separate-sidebar/); assert.equal(readdirSync(join(f.home, "mods")).length, 0);
  update({ ...f, unifiedSidebar: false, projects: false, agents: false }); const actual = JSON.parse(readFileSync(join(f.home, "layouts", `${LAYOUT_NAME}.json`), "utf8")); assert.deepEqual(lists(actual).children.map(row => row.content.mod), ["spaces", "agents"]); assert.deepEqual(lists(actual).children[0].content.props, lists(fixtureLayout()).children[0].content.props);
});

test("CLI documents explicit flags and rejects duplicate/conflicting choices without touching any home", t => {
  const f = homeFixture(t, { existing: true });
  for (const script of ["install.mjs", "update.mjs"]) {
    const file = new URL(`../${script}`, import.meta.url).pathname, help = spawnSync(process.execPath, [file, "--help"], { encoding: "utf8" }); assert.equal(help.status, 0); assert.match(help.stdout, /--unified-sidebar/); assert.match(help.stdout, /--separate-sidebar/);
    for (const args of [["--unified-sidebar", "--separate-sidebar"], ["--unified-sidebar", "--unified-sidebar"]]) { const result = spawnSync(process.execPath, [file, "--home", f.home, ...args], { encoding: "utf8" }); assert.equal(result.status, 1); assert.match(result.stderr, /Use one/); assert.equal(readdirSync(join(f.home, "mods")).length, 0); }
  }
});

test("positive CLI installation and separate restoration use only their temporary owned layout and keep user state", t => {
  const f = homeFixture(t), before = retained(f), installFile = new URL("../install.mjs", import.meta.url).pathname, updateFile = new URL("../update.mjs", import.meta.url).pathname;
  const installed = spawnSync(process.execPath, [installFile, "--home", f.home, "--files-only", "--unified-sidebar"], { encoding: "utf8", timeout: 20000 }); assert.equal(installed.status, 0, installed.stderr);
  const target = join(f.home, "layouts", `${LAYOUT_NAME}.json`), merged = JSON.parse(readFileSync(target, "utf8")); assert.equal(lists(merged).children.length, 1); assert(merged[UNIFIED_SIDEBAR_META]);
  const separate = spawnSync(process.execPath, [updateFile, "--home", f.home, "--files-only", "--separate-sidebar"], { encoding: "utf8", timeout: 20000 }); assert.equal(separate.status, 0, separate.stderr);
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), cloneLayout(fixtureLayout({ native: true }), { projects: true, agents: true })); assert.deepEqual(retained(f), before);
  assert.deepEqual(readdirSync(join(f.home, "mods")).sort(), ["agents-plus", "files-plus", "project-spaces"]);
});
