import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validRelative } from "../mods/files-plus/library-model.js";

function fixture({ deferred = false, remote = false } = {}) {
  const spaceId = remote ? "server/s" : "s", machine = remote ? "server" : null;
  const state = { machines: [{ name: null, layout: "ready" }, { name: "server", layout: "ready" }], spaces: [{ id: spaceId, active: true, folder: "/default", machine, tabs: [{ id: "terminal", active: true, name: "Shell" }] }], panes: [{ pane: "terminal-pane", tab: "terminal", terminal: "t1", cwd: "/actual", focused: true }], focus: { space: spaceId, tab: "terminal", pane: "terminal-pane", terminal: "t1", cwd: "/actual" } };
  const values = {}, commands = [], timers = [], pending = []; let count = 0, now = 10000, writes = 0, failure;
  const activate = (tab, pane, space) => { state.focus = { space, tab, pane, terminal: null, cwd: null }; state.spaces.forEach(s => { s.active = s.id === space; s.tabs.forEach(t => { t.active = t.id === tab; }); }); };
  const create = (args, name = `file-${++count}`) => {
    const space = state.spaces.find(s => s.id === args.space), pane = name + "-pane";
    space.tabs.push({ id: name, name: args.name, active: false });
    state.panes.push({ pane, tab: name, terminal: null, mod: args.mod, cwd: null }); activate(name, pane, space.id);
    return name;
  };
  const deps = { machines: () => state.machines, spaces: () => state.spaces, panes: () => state.panes, focused: () => state.focus,
    shared: key => values[key], setShared: (key, value) => { values[key] = value; writes++; }, validRelative,
    Date: { now: () => now }, run(name, args) { commands.push({ name, args }); if (failure) throw failure;
      if (name === "tab.new") { if (deferred) pending.push(args); else create(args); }
      if (name === "tab.select") { const pane = state.panes.find(p => p.tab === args.id), space = state.spaces.find(s => s.tabs.some(t => t.id === args.id)); activate(args.id, pane.pane, space.id); }
      if (name === "pane.focus") { const pane = state.panes.find(p => p.pane === args.pane), space = state.spaces.find(s => s.tabs.some(t => t.id === pane.tab)); activate(pane.tab, pane.pane, space.id); }
      return null;
    } };
  const source = readFileSync(new URL("../mods/files-plus/file-tabs.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replaceAll("export ", "");
  const api = new Function(...Object.keys(deps), source + "\nreturn {openFileTab,projectContext,FILE_TABS_KEY};")(...Object.values(deps));
  const companionSource = readFileSync(new URL("../mods/sessions-plus/project-context.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replaceAll("export ", "");
  const { validRelative: _unused, ...companionDeps } = deps;
  const companion = new Function(...Object.keys(companionDeps), companionSource + "\nreturn projectContext;")(...Object.values(companionDeps));
  const originalContext = api.projectContext;
  api.projectContext = () => { const expected = originalContext(); assert.deepEqual(companion(), expected, "Sessions and Files must agree without cross-mod imports"); return expected; };
  const cx = { timer: { after(ms, fn) { timers.push({ ms, fn }); } } };
  return { ...api, state, values, commands, timers, pending, cx, spaceId, create, activate,
    data: () => values[api.FILE_TABS_KEY], writes: () => writes, tick() { const next = timers.shift(); if (next) { now += next.ms; next.fn(cx); } }, advance(ms) { now += ms; }, fail(error) { failure = error; },
    open(path = "src/file.py", root = "/actual", on = machine) { return api.openFileTab({ root, path, on }, cx); } };
}

test("file tabs preserve terminals, capture props, and reuse identity even after a tab is renamed", () => {
  const f = fixture(), tab = f.open();
  assert.equal(f.commands[0].name, "tab.new");
  assert.deepEqual(f.commands[0].args.props, { role: "file-preview", root: "/actual", path: "src/file.py", on: null, previewId: f.data().tabs[tab].previewId });
  assert(f.state.panes.some(p => p.terminal === "t1"));
  f.state.spaces[0].tabs.find(t => t.id === tab).name = "Renamed";
  assert.equal(f.open(), tab); assert.equal(f.commands.filter(c => c.name === "tab.new").length, 1);
  assert.equal(f.commands.at(-2).name, "tab.select"); assert.equal(f.commands.at(-1).name, "pane.focus");
  const writes = f.writes(); assert.deepEqual(f.projectContext(), { cwd: "/actual", on: null, space: "s" }); assert.equal(f.writes(), writes);
});

test("same names in different paths, roots and machines never share a preview tab", () => {
  const f = fixture();
  const ids = [f.open("a/file.py"), f.open("b/file.py"), f.open("a/file.py", "/other"), f.open("a/file.py", "/actual", "server")];
  assert.equal(new Set(ids).size, 4); assert.equal(Object.keys(f.data().tabs).length, 4);
  assert.deepEqual(f.projectContext(), { cwd: "/actual", on: "server", space: "s" });
});

test("closed tabs and replaced panes are pruned without dropping another space's live previews", () => {
  const f = fixture(), first = f.open();
  f.state.spaces.push({ id: "other", active: false, machine: null, folder: "/other-default", tabs: [] });
  f.state.focus = { space: "other" }; const other = f.open("other.py", "/other");
  f.state.focus = { space: "s" }; f.state.panes.find(p => p.tab === first).mod = "different-mod";
  const second = f.open(); assert.notEqual(second, first); assert(!f.data().tabs[first]); assert(f.data().tabs[other]);
  f.state.panes.find(p => p.tab === second).terminal = "replacement-terminal";
  const third = f.open(); assert.notEqual(third, second); assert(!f.data().tabs[second]);
  f.state.spaces[0].tabs = f.state.spaces[0].tabs.filter(t => t.id !== third);
  const fourth = f.open(); assert.notEqual(fourth, third); assert(!f.data().tabs[third]); assert(f.data().tabs[other]);
});

test("an asynchronous tab creation suppresses repeated clicks and provides pending context without writes", () => {
  const f = fixture({ deferred: true }); f.open(); f.open();
  assert.equal(f.pending.length, 1); assert.equal(f.timers.length, 1);
  const tab = f.create(f.pending.shift());
  const writes = f.writes(); assert.deepEqual(f.projectContext(), { cwd: "/actual", on: null, space: "s" }); assert.equal(f.writes(), writes);
  f.tick(); assert.equal(f.data().tabs[tab].path, "src/file.py"); assert.deepEqual(f.data().pending, {});
  assert.equal(f.open(), tab); assert.equal(f.commands.filter(c => c.name === "tab.new").length, 1);
});

test("different files queued during creation each receive their own captured preview", () => {
  const f = fixture({ deferred: true }); f.open("one.py"); const writes = f.writes(); f.open("two.py"); assert.equal(f.writes(), writes + 1); f.open("two.py");
  assert.equal(f.commands.length, 1);
  const first = f.create(f.pending.shift()); f.tick(); assert.equal(f.pending.length, 1);
  const second = f.create(f.pending.shift()); f.tick();
  assert.equal(f.data().tabs[first].path, "one.py"); assert.equal(f.data().tabs[second].path, "two.py");
  assert.notEqual(f.data().tabs[first].previewId, f.data().tabs[second].previewId);
});

test("remote IDs and paths stay captured and are never machine-qualified inside props", () => {
  const f = fixture({ remote: true }); const tab = f.open("src/file.py", "/remote/project");
  assert.equal(f.commands[0].args.space, "server/s"); assert.equal(f.commands[0].args.props.root, "/remote/project"); assert.equal(f.commands[0].args.props.on, "server");
  assert.deepEqual(f.projectContext(), { cwd: "/remote/project", on: "server", space: "server/s" });
  f.state.focus = { space: "server/s", tab: "terminal", pane: null, terminal: "elsewhere/t8", cwd: "/shown" };
  assert.deepEqual(f.projectContext(), { cwd: "/shown", on: "elsewhere", space: "server/s" });
  assert(f.data().tabs[tab]);
});

test("pending context cannot leak into an older mod tab or a different space", () => {
  const f = fixture({ deferred: true });
  const prior = f.create({ space: "s", name: "Existing", mod: "files-plus" }); f.open();
  assert.deepEqual(f.projectContext(), { cwd: "/default", on: null, space: "s" });
  f.state.spaces.push({ id: "other", active: false, folder: "/different", machine: "remote", tabs: [] }); f.state.focus = { space: "other" };
  assert.deepEqual(f.projectContext(), { cwd: "/different", on: "remote", space: "other" });
  f.tick(); assert.equal(Object.keys(f.data().tabs).length, 0); assert(!f.data().tabs[prior]);
});

test("ambiguous new mod tabs are never guessed, retrying is finite and stale pending context expires", () => {
  const f = fixture({ deferred: true }); f.open(); const args = f.pending.shift();
  f.create(args); f.create(args);
  assert.deepEqual(f.projectContext(), { cwd: "/default", on: null, space: "s" });
  for (let i = 0; i < 30; i++) f.tick();
  assert.equal(f.timers.length, 0); assert.deepEqual(f.data().pending, {}); assert.deepEqual(f.data().tabs, {});
  f.open(); const tab = f.create(f.pending.shift()); f.advance(4000);
  assert.deepEqual(f.projectContext(), { cwd: "/default", on: null, space: "s" }); assert(!f.data().tabs[tab]);
  f.tick(); assert.deepEqual(f.data().pending, {});
});

test("failed commands clear the pending lock, and invalid paths never issue commands", () => {
  const f = fixture(); f.fail(new Error("machine unavailable")); assert.throws(() => f.open(), /machine unavailable/); assert.deepEqual(f.data().pending, {});
  f.fail(null); f.open(); assert.equal(Object.keys(f.data().tabs).length, 1);
  for (const path of ["", "/absolute", "../outside", "a/../b", "a\n", "C:/absolute"]) {
    const before = f.commands.length; assert.throws(() => f.open(path)); assert.equal(f.commands.length, before);
  }
});

test("malformed persisted requests cannot change location or prevent opening a file", () => {
  const f = fixture();
  f.values[f.FILE_TABS_KEY] = { tabs: { bad: { tab: "terminal", pane: "terminal-pane", space: "s", root: "/bad", path: "file.py", previewId: "fake" } }, pending: { s: { space: "s", root: "/bad", path: "file.py", previewId: "fake", started: 10000 } } };
  assert.deepEqual(f.projectContext(), { cwd: "/actual", on: null, space: "s" });
  const tab = f.open(); assert(f.data().tabs[tab]); assert(!f.data().tabs.bad); assert.deepEqual(f.data().pending, {});
});

test("an offline remote space keeps its registry until its ready core confirms closure", () => {
  const f = fixture({ remote: true }), remoteTab = f.open();
  f.state.spaces = [{ id: "local", active: true, folder: "/local", machine: null, tabs: [] }]; f.state.panes = []; f.state.focus = { space: "local" };
  f.state.machines.find(m => m.name === "server").layout = "unavailable";
  f.open("local.py", "/local", null); assert(f.data().tabs[remoteTab]);
  f.state.machines.find(m => m.name === "server").layout = "ready";
  f.open("another.py", "/local", null); assert(!f.data().tabs[remoteTab]);
});

test("reuse focuses the recorded preview pane when its tab also contains a terminal", () => {
  const f = fixture(), tab = f.open(), previewPane = f.data().tabs[tab].pane;
  f.state.panes.push({ pane: "split-terminal", tab, terminal: "t2", cwd: "/elsewhere" });
  f.state.focus = { space: "s", tab, pane: "split-terminal", terminal: "t2", cwd: "/elsewhere" };
  f.open(); assert.equal(f.state.focus.pane, previewPane); assert.deepEqual(f.commands.at(-1), { name: "pane.focus", args: { pane: previewPane } });
});

test("empty app state resolves safely without publishing or creating a tab", () => {
  const f = fixture(); f.state.spaces = []; f.state.panes = []; f.state.focus = null;
  assert.deepEqual(f.projectContext(), { cwd: undefined, on: null, space: undefined });
  assert.equal(f.writes(), 0); assert.equal(f.open(), null); assert.equal(f.commands.length, 0);
});
