import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as model from "../mods/sessions-plus/presets-model.js";
import * as client from "../mods/sessions-plus/presets-client.js";
import { commandContext } from "../mods/sessions-plus/commands-model.js";

const config = { name: "Demo", root: "/fixture/main", on: null, roots: ["/fixture/main", "/fixture/shared"], agentArgv: ["/bin/agent", "argument with spaces", "$(touch never); literal"], tabs: [{ name: "Shell", cwd: "/fixture/main", argv: ["/bin/shell"] }, { name: "Logs", cwd: "/fixture/shared", argv: ["/bin/log", "--follow", "a b.log"] }] };
const initial = (value = config) => model.savePreset(null, value, null, null, 1000, "p1");
const preset = state => model.presetState(state).presets[0];
const reserved = (value = config) => { const state = initial(value); return model.reservePresetLaunch(state, model.preparedPreset(preset(state)), "launch-fixture", 2000); };
const record = state => model.presetState(state).launches.at(-1);
const reply = body => ({ code: 0, stdout: JSON.stringify(body) });
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

test("presets keep literal argv, normalize file roots, and reject invalid configurations without side effects", () => {
  assert.deepEqual(model.validatePreset(config).agentArgv, config.agentArgv);
  assert.equal(model.presetRoot("C:\\"), "C:/"); assert.equal(model.presetRoot("/"), "/"); assert.equal(model.presetRoot("/fixture/name "), "/fixture/name ");
  assert.throws(() => model.presetRoot("/a/../b"), /parent/);
  for (const change of [{ tabs: [] }, { tabs: Array(4).fill(config.tabs[0]) }, { agentArgv: [] }, { roots: ["/same", "/same"] }, { roots: Array.from({ length: 8 }, (_, i) => `/r${i}`) }, { on: "machine/name" }]) assert.throws(() => model.validatePreset({ ...config, ...change }));
  const form = model.presetForm(preset(initial()), { root: "/wrong", on: "wrong" }, "draft");
  assert.equal(form.machine, ""); assert.deepEqual(model.parsePresetForm(form), config);
  assert.throws(() => model.parsePresetForm({ ...form, tabsText: "not json" }), /JSON arrays/);
});

test("preset mutations use captured revisions, copy explicitly, and never evict saved presets", () => {
  let state = initial(), original = preset(state);
  state = model.favoritePreset(state, original.id); assert.equal(preset(state).favorite, true);
  state = model.copyPreset(state, original); assert.equal(state.presets[1].name, "Copy of Demo"); assert.notEqual(state.presets[0].id, state.presets[1].id);
  state = model.savePreset(state, { ...config, name: "Changed" }, "p1", model.presetRevision(original), 1001);
  assert.throws(() => model.savePreset(state, config, "p1", model.presetRevision(original)), /another window/);
  assert.throws(() => model.removePreset(state, "p1", model.presetRevision(original)), /changed/);
  for (let i = state.presets.length; i < model.PRESET_LIMITS.presets; i++) state = model.savePreset(state, { ...config, name: `Preset ${i}` }, null, null, 1000 + i, `p${i}`);
  const before = JSON.stringify(state); assert.throws(() => model.copyPreset(state, preset(state)), /Twenty/); assert.equal(JSON.stringify(state), before);
});

test("draft CAS protects new text and deletion; reserved draft headroom prevents another save taking its editing space", () => {
  let state = initial(), form = model.presetForm(preset(state), null, "draft");
  state = model.savePresetDraft(state, form, null); const original = state.drafts[0];
  state = model.savePresetDraft(state, { ...form, name: "New text" }, model.presetDraftRevision(original));
  assert.throws(() => model.savePresetDraft(state, form, model.presetDraftRevision(original)), /changed/);
  assert.throws(() => model.removePresetDraft(state, "draft", model.presetDraftRevision(original)), /changed/);
  state = model.removePresetDraft(state, "draft", model.presetDraftRevision(state.drafts[0]));
  assert.throws(() => model.savePresetDraft(state, form, model.presetDraftRevision(original)), /discarded/);
  for (let i = 0; i < 8; i++) state = model.savePresetDraft(state, { ...form, draftId: `d${i}` }, null);
  const before = JSON.stringify(state); assert.throws(() => model.savePresetDraft(state, { ...form, draftId: "overflow" }, null), /Eight/); assert.equal(JSON.stringify(state), before);
  const draft = state.drafts[0]; state = model.savePresetDraft(state, { ...draft, tabsText: "x".repeat(52000), agentText: "x".repeat(18000), rootsText: "x".repeat(18000) }, model.presetDraftRevision(draft));
  assert.equal(state.drafts[7].tabsText.length, 52000);
});

test("launch reservations reject stale previews and coordinate windows; partial launches require explicit review without resuming", () => {
  let state = initial(), prepared = model.preparedPreset(preset(state));
  const changed = model.savePreset(state, { ...config, name: "New" }, "p1", model.presetRevision(preset(state)), 1001);
  assert.throws(() => model.reservePresetLaunch(changed, prepared, "old"), /changed after preview/);
  state = model.reservePresetLaunch(state, prepared, "one", 1000);
  assert.throws(() => model.reservePresetLaunch(state, prepared, "two", 1001), /previous launch/);
  assert.throws(() => model.reviewPresetLaunch(state, "one", 1002), /still active/);
  state = model.patchPresetLaunch(state, "one", { status: "partial" }); assert.throws(() => model.reservePresetLaunch(state, prepared, "two"), /previous launch/);
  state = model.reviewPresetLaunch(state, "one"); state = model.reservePresetLaunch(state, prepared, "two"); assert.equal(state.launches.length, 2);
  assert.equal(state.launches[0].reviewed, true); assert.equal(state.launches[0].status, "reviewed");
  const fenced = model.patchPresetLaunch(state, "one", { status: "launching", spaceId: "captured" }); assert.equal(fenced.launches[0].status, "reviewed"); assert.equal(fenced.launches[0].spaceId, "captured");
});

function coreFixture({ on = null, failTab = 0, ambiguous = false, unavailable = false, replaceTerminal = false } = {}) {
  const spaceRows = [{ id: "unrelated", name: "Existing", machine: on, folder: "/unrelated", tabs: [{ id: "existing-tab", name: "Existing" }] }], paneRows = [], terminals = new Map(), commands = [], controls = [], executions = [], mappings = new Map();
  let next = 1, closed = false;
  const qualified = value => on ? `${on}/${value}` : value;
  const makeTab = (space, args) => {
    const id = qualified(`tab-${next}`), address = qualified(`t${next}`); next++;
    space.tabs.push({ id, name: args.name || args.tab }); paneRows.push({ tab: id, pane: qualified(`pane-${next}`), terminal: address });
    terminals.set(address, { address, created_ms: Date.now(), cwd: args.folder, argv: [...args.argv], state: "live", reason: null, exit_code: null, labels: { "herdr.space": space.id.split("/").at(-1), "herdr.tab": id.split("/").at(-1) } });
  };
  const execute = async (program, argv, options) => { executions.push([program, argv, options]); return { code: 0, stdout: argv.includes('command -v "$1"') ? `/bin/${argv.at(-1)}\n` : "" }; };
  const command = (name, args) => {
    commands.push([name, args]);
    if (name === "space.new") {
      const space = { id: qualified("created-space"), name: args.name, folder: args.folder, machine: args.machine || null, tabs: [] };
      spaceRows.push(space); makeTab(space, { ...args, name: args.tab });
      if (ambiguous) spaceRows.push({ ...space, id: qualified("ambiguous-space") });
    } else if (name === "tab.new") {
      if (failTab && commands.filter(row => row[0] === "tab.new").length === failTab) throw new Error("tab creation acknowledgement lost");
      makeTab(spaceRows.find(row => row.id === args.space), args);
    } else if (name === "tab.rename") { for (const space of spaceRows) { const tab = space.tabs.find(tab => tab.id === args.id); if (tab) tab.name = args.name; } }
    else if (name === "space.rename") spaceRows.find(row => row.id === args.id).name = args.name;
    else throw new Error(`Unexpected command ${name}`);
    // Focus moves are deliberately unrelated to the created space and cannot affect attribution.
    spaceRows[0].active = true;
    if (name === "space.new") { const space = spaceRows.find(row => row.id === qualified("created-space")); const tab = space.tabs[0]; return { space: space.id, tab: tab.id, terminal: paneRows.find(row => row.tab === tab.id).terminal }; }
    if (name === "tab.new") { const space = spaceRows.find(row => row.id === args.space), tab = space.tabs.at(-1); return { space: space.id, tab: tab.id, terminal: paneRows.find(row => row.tab === tab.id).terminal }; }
    return {};
  };
  const control = async argv => {
    controls.push(argv); const terminal = terminals.get(argv[2]); if (!terminal) return { code: 1, stdout: "" };
    if (argv[0] === "label") { terminal.labels[model.PRESET_LABEL] = argv[3].split("=")[1]; terminal.labels[model.PRESET_STEP_LABEL] = argv[4].split("=")[1]; }
    return reply({ ...terminal, ...(replaceTerminal ? { argv: ["/bin/unrelated"] } : {}) });
  };
  return { spaceRows, paneRows, terminals, commands, controls, executions, mappings, close: () => { closed = true; }, deps: { execute, command, control, spaces: () => spaceRows, panes: () => paneRows, machines: () => [{ name: on, layout: unavailable ? "unavailable" : "ready" }], sleep: async () => {}, closed: () => closed, now: () => 2002,
    applyRoots: (space, config) => mappings.set(model.PRESET_WORKSPACES_KEY, model.applyPresetRoots(mappings.get(model.PRESET_WORKSPACES_KEY), space, config)) } };
}
async function launchFixture(options = {}) {
  let state = reserved({ ...config, on: options.on || null }); const core = coreFixture(options), original = record(state);
  await client.launchWorkspacePreset(original, { ...core.deps, current: () => record(state), publish: patch => { state = model.patchPresetLaunch(state, original.token, patch); } });
  return { ...core, state, record: record(state) };
}

test("production launch targets exact new space/tab IDs and machine, applies only its roots, tags verified terminals and never sends a prompt", async () => {
  const f = await launchFixture({ on: "server" }); assert.equal(f.record.status, "complete"); assert.equal(f.record.spaceId, "server/created-space");
  assert.deepEqual(f.commands.map(row => row[0]), ["space.new", "tab.new", "tab.new", "tab.rename", "tab.rename", "tab.rename", "space.rename"]);
  assert.equal(f.commands[0][1].machine, "server"); assert(f.commands.filter(row => row[0] === "tab.new").every(row => row[1].space === "server/created-space"));
  assert.deepEqual([...f.terminals.values()][0].argv, config.agentArgv); assert(f.executions.every(row => row[2].on === "server"));
  assert(f.controls.every(args => ["get", "label"].includes(args[0]))); assert(f.commands.every(([, args]) => !Object.hasOwn(args, "task")));
  const key = JSON.stringify(["space", "server", "server/created-space"]); assert.deepEqual(f.mappings.get(model.PRESET_WORKSPACES_KEY).workspaces[key].roots.map(root => root.path), config.roots);
  assert.equal(f.spaceRows[0].name, "Existing"); assert(f.record.items.filter(item => item.address).every(item => item.address.startsWith("server/") && item.identity));
});

test("launches stop after partial or ambiguous creation and do not retry or close any existing workspace", async () => {
  const partial = await launchFixture({ failTab: 1 }); assert.equal(partial.record.status, "partial"); assert.equal(partial.commands.filter(row => row[0] === "space.new").length, 1); assert.equal(partial.commands.filter(row => row[0] === "tab.new").length, 1);
  assert.equal(partial.record.items.find(row => row.key === "tab-2").status, "pending"); assert(partial.record.spaceId);
  const ambiguous = await launchFixture({ ambiguous: true }); assert.equal(ambiguous.record.status, "complete"); assert.equal(ambiguous.record.spaceId, "created-space");
  const replaced = await launchFixture({ replaceTerminal: true }); assert.equal(replaced.record.status, "partial"); assert.equal(replaced.controls.length, 1); assert.equal(replaced.commands.length, 1);
  const unavailable = await launchFixture({ unavailable: true }); assert.equal(unavailable.record.status, "failed"); assert.equal(unavailable.commands.length, 0); assert.equal(unavailable.executions.length, 0);
});

test("closing or reviewing an expired launch fences later actions while preserving already created items", async () => {
  let state = reserved(), pending; const f = coreFixture();
  const execute = (...args) => { pending = {}; pending.promise = new Promise(resolve => { pending.resolve = resolve; }); f.executions.push(args); return pending.promise; };
  const promise = client.launchWorkspacePreset(record(state), { ...f.deps, execute, current: () => record(state), publish: patch => { state = model.patchPresetLaunch(state, "launch-fixture", patch); } });
  f.close(); pending.resolve({ code: 0 }); await promise;
  assert.equal(record(state).status, "failed"); assert.equal(f.commands.length, 0);
  const g = coreFixture(), original = record(reserved()); let current = original;
  const result = client.launchWorkspacePreset(original, { ...g.deps, command: (name, args) => { g.deps.command(name, args); current = { ...current, reviewed: true, status: "reviewed" }; }, current: () => current, publish: patch => { current = { ...current, ...patch }; } });
  await result; assert.equal(g.commands.length, 1); assert.equal(g.spaceRows.length, 2);
});

test("workspace root mapping preserves unrelated workspaces and refuses an existing mapping or the wrong machine", () => {
  const space = { id: "new", machine: null, folder: config.root }, existing = { marker: "kept", workspaces: { unrelated: { roots: [{ path: "/existing" }] } } };
  const state = model.applyPresetRoots(existing, space, config); assert.equal(state.marker, "kept"); assert.deepEqual(state.workspaces.unrelated, existing.workspaces.unrelated);
  assert.throws(() => model.applyPresetRoots(state, space, config), /not overwritten/);
  assert.throws(() => model.applyPresetRoots(existing, { ...space, machine: "wrong" }, config), /no longer matches/);
});

function element() {
  const node = { attrs: {}, events: {}, childNodes: [] };
  const proxy = new Proxy(node, { get(target, key) {
    if (key === "child") return child => { target.childNodes.push(child); return proxy; };
    if (key === "children") return children => { target.childNodes.push(...children); return proxy; };
    if (key === "when") return (condition, callback) => condition ? callback(proxy) : proxy;
    if (String(key).startsWith("on_")) return (...args) => { target.events[key] = args.at(-1); return proxy; };
    if (key in target) return target[key]; return value => { target.attrs[key] = value; return proxy; };
  } }); return proxy;
}
const nodes = node => !node || typeof node !== "object" ? [] : [node, ...node.childNodes.flatMap(nodes)];
function uiFixture({ store = new Map([[model.PRESETS_KEY, initial()]]), core = coreFixture() } = {}) {
  let rendering = false; const inputs = [], tasks = [], timers = [];
  const cx = { focus_handle: () => ({ focus() {} }), notify() { assert(!rendering); }, stop_propagation() {}, sleep: async () => {}, spawn(callback) { const promise = callback(cx); tasks.push(promise); }, timer: { after(ms, callback) { const task = { ms, callback, cancel() {} }; timers.push(task); return task; } } };
  const input = options => { let value = options.value || ""; const events = {}, item = { value: () => value, set_value(next) { value = next; }, on(name, fn) { events[name] = fn; }, focus() {}, release() { this.released = true; }, type(next) { value = next; events.change?.({}, cx); } }; inputs.push(item); return item; };
  const deps = { ...model, ...client, commandContext, projectContext: () => ({ cwd: "/fixture/main", on: null }), div: element, svg: element, v_flex: element, h_flex: element, Input: { new: element }, Textarea: { new: element }, InputState: { new: input }, TextareaState: { new: input },
    shared: key => store.get(key), setShared(key, value) { assert(!rendering); store.set(key, value); }, theme: () => ({}), closeOverlay() {}, hc: core.deps.control, appHome: () => "/fixture/herdr", spaces: core.deps.spaces, panes: core.deps.panes, machines: core.deps.machines,
    exec: (program, argv, options) => program === "/usr/bin/env" ? Promise.resolve(reply(core.deps.command(argv[3], JSON.parse(argv[4])))) : core.deps.execute(program, argv, options) };
  const source = readFileSync(new URL("../mods/sessions-plus/presets.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  const Presets = new Function(...Object.keys(deps), source)(...Object.values(deps)), view = new Presets(); view.init({ context: { root: config.root, on: null } }, cx);
  return { view, cx, store, core, inputs, timers, state: () => model.presetState(store.get(model.PRESETS_KEY)), render() { rendering = true; try { return view.render(cx); } finally { rendering = false; } }, click(id) { const node = nodes(this.render()).find(node => node.attrs.id === id); assert(node, id); node.events.on_click({}, cx); }, async settle() { for (let i = 0; i < 8 && tasks.length; i++) await Promise.all(tasks.splice(0)); } };
}

test("production UI edits/copies/favorites presets without starting anything; explicit preview precedes its only Launch", async () => {
  const f = uiFixture(); f.render(); f.click("preset-copy-p1"); f.click("preset-favorite-p1"); f.click("preset-edit-p1");
  f.inputs[0].type("Edited preset"); f.click("preset-form-save"); assert.equal(f.state().presets[0].name, "Edited preset"); assert.equal(f.core.executions.length, 0); assert.equal(f.core.commands.length, 0);
  f.click("preset-preview-p1"); assert.equal(f.core.commands.length, 0); assert(nodes(f.render()).some(node => node.attrs.id === "preset-launch"));
  f.click("preset-preview-back"); assert.equal(f.core.commands.length, 0);
  f.click("preset-preview-p1"); f.click("preset-launch"); await f.settle();
  assert.equal(f.core.commands.filter(row => row[0] === "space.new").length, 1); assert.equal(record(f.state()).status, "complete");
});

test("production multiple windows restore separate form branches and stale close/discard cannot overwrite newer work", () => {
  const a = uiFixture(); a.click("preset-edit-p1"); a.inputs[0].type("Original unfinished"); a.click("preset-form-back"); const original = a.state().drafts[0];
  const b = uiFixture({ store: a.store }); a.view.openForm(null, a.cx, original); b.view.openForm(null, b.cx, original);
  a.inputs[0].type("Writer A"); b.inputs[0].type("Writer B"); const aId = a.view.form.draftId, bId = b.view.form.draftId;
  b.view.close(); a.view.close(); assert.notEqual(aId, bId);
  assert.equal(a.state().drafts.find(row => row.draftId === aId).name, "Writer A"); assert.equal(a.state().drafts.find(row => row.draftId === bId).name, "Writer B"); assert.equal(a.state().drafts.find(row => row.draftId === original.draftId).name, "Original unfinished");
  const c = uiFixture({ store: a.store }); c.view.openForm(null, c.cx, original); const own = c.state().drafts.find(row => row.draftId === c.view.form.draftId);
  const d = uiFixture({ store: a.store }); d.view.discard(own, d.cx); c.inputs[0].type("After discard"); assert.match(c.view.error, /discarded/); c.view.close(); assert.equal(c.state().drafts.some(row => row.draftId === own.draftId), false);
});

test("production full draft storage blocks a new editable copy and keeps every original; unchanged copies release their slot", () => {
  const f = uiFixture(); f.click("preset-edit-p1"); f.inputs[0].type("Keep draft"); f.click("preset-form-back"); const original = f.state().drafts[0];
  for (let i = 0; i < 12; i++) { f.view.openForm(null, f.cx, original); f.view.back(f.cx); assert.equal(f.state().drafts.length, 1); }
  let state = f.state(); for (let i = 1; i < 8; i++) state = model.savePresetDraft(state, { ...original, draftId: `extra-${i}` }, null); f.store.set(model.PRESETS_KEY, state);
  const before = JSON.stringify(f.state()); f.view.openForm(null, f.cx, original); assert.equal(f.view.form, null); assert.match(f.view.error, /Eight/); assert.equal(JSON.stringify(f.state()), before);
});


test("exact Herdr login-shell wrappers preserve literal arguments and cannot spoof a different command or tab", () => {
 const argv = ["/bin/agent", "$(literal)", "a b"], actual = ["/bin/zsh", "-lic", '\"$@\"; exec \"$0\" -li', "/bin/zsh", ...argv];
 assert.deepEqual(client.presetLaunchArgv(actual, argv), {wrapped:true});
 assert.throws(() => client.presetLaunchArgv(["/bin/zsh", "-lic", "eval $*", "/bin/zsh", ...argv], argv), /differs/);
 assert.throws(() => client.presetLaunchArgv([...actual, "extra"], argv), /differs/);
 assert.throws(() => client.presetLaunchArgv(["/bin/zsh", "-lic", actual[2], "/bin/bash", ...argv], argv), /differs/);
 const terminal={address:"t1",created_ms:3000,cwd:config.root,argv:actual,state:"live",labels:{"herdr.space":"s1","herdr.tab":"b1"}};
 const check={address:"t1",argv,cwd:config.root,on:null,started:2000,spaceId:"s1",tabId:"b1"};
 assert.match(client.checkedPresetTerminal(terminal,check).processStatus,/exit status unavailable/);
 assert.throws(() => client.checkedPresetTerminal(terminal,{...check,tabId:"other"}), /no longer belongs/);
});

test("lost acknowledgements and existing-space acknowledgements stop without guessing from matching names or focus", async () => {
  for (const mode of ["lost", "existing", "wrong-terminal"]) {
    let state = reserved(); const f = coreFixture(), original = record(state);
    await client.launchWorkspacePreset(original, { ...f.deps, current: () => record(state), publish: patch => { state = model.patchPresetLaunch(state, original.token, patch); }, command: (name, args) => {
      const acknowledged = f.deps.command(name, args);
      if (name !== "space.new") return acknowledged;
      if (mode === "lost") throw new Error("reply lost after create");
      if (mode === "existing") return { space: "unrelated", tab: "existing-tab", terminal: "old" };
      return { ...acknowledged, terminal: "unrelated-terminal" };
    } });
    assert.equal(f.commands.length, 1); assert.equal(f.controls.length, 0); assert.equal(f.spaceRows.length, 2);
    assert(["partial", "unconfirmed"].includes(record(state).status));
    assert.equal(record(state).items.find(item => item.key === "tab-1").status, "pending");
  }
});

test("preset launch resolves executable names with fixed literal argv and rejects shell builtins or unapproved app commands", async () => {
  const calls = [], argv = ["tool", "$(literal); a b"];
  const resolved = await client.resolvePresetArgv(argv, config.root, "server", async (...args) => { calls.push(args); return { code: 0, stdout: calls.length === 1 ? "/bin/tool\n" : "" }; });
  assert.deepEqual(resolved, ["/bin/tool", "$(literal); a b"]); assert.deepEqual(calls[0][1], ["-c", 'command -v "$1"', "workspace-preset", "tool"]); assert.equal(calls[0][2].on, "server");
  await assert.rejects(client.resolvePresetArgv(["echo"], config.root, null, async () => ({ code: 0, stdout: "echo\n" })), /absolute path/);
  await assert.rejects(client.presetAppCommand("space.close", { id: "existing" }, "/fixture/herdr", async () => { throw new Error("must not execute"); }), /not supported/);
  await assert.rejects(client.presetAppCommand("space.new", { task: "implicit prompt" }, "/fixture/herdr", async () => { throw new Error("must not execute"); }), /not supported/);
  const reply = await client.presetAppCommand("space.new", { name: "a b", machine: "" }, "/fixture/with spaces", async (program, args, options) => {
    assert.equal(program, "/usr/bin/env"); assert.deepEqual(args, ["HERDR_APP_HOME=/fixture/with spaces", "herdr-app", "do", "space.new", '{"name":"a b","machine":""}']); assert.equal(options.timeout, 15000);
    return { code: 0, stdout: '{"space":"new","tab":"tab","terminal":"t1"}' };
  }); assert.equal(reply.space, "new");
});
