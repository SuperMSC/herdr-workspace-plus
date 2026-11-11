import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as model from "../mods/sessions-plus/commands-model.js";
import * as client from "../mods/sessions-plus/commands-client.js";

const context = { root: "/fixture/project", on: null };
const form = { title: "Unit test", argv: ["/bin/echo", "hello world", "$(touch never)"], cwd: context.root };
const initial = () => model.saveCommand(null, context, form, null, null, 100, "command-1");
const command = state => model.commandProject(state, context).commands[0];
const reserve = (state = initial(), token = "run-1") => model.reserveCommandRun(state, context, command(state), token, 1000);
const record = state => model.commandProject(state, context).runs.at(-1);
const terminal = (run, options = {}) => ({ address: "t5", created_ms: 12345, cwd: run.cwd, argv: run.resolvedArgv || run.argv, labels: { [model.COMMAND_LABEL]: run.token, [model.PROJECT_LABEL]: run.scope }, state: "live", ...options });
const reply = body => ({ code: 0, stdout: JSON.stringify(body) });

test("commands are literal project/machine templates, validated without evaluating any argument", () => {
  assert.deepEqual(model.parseCommandForm({ title: "Test", cwd: context.root, argvText: '["/bin/echo", "a b", "$(danger)", "; cat /secret"]' }, context).argv, ["/bin/echo", "a b", "$(danger)", "; cat /secret"]);
  assert.throws(() => model.parseCommandForm({ title: "Test", cwd: context.root, argvText: "echo hi" }, context), /JSON array/);
  for (const argv of [[], [""], ["--keep"], ["echo", null], ["echo", "\0"], Array(65).fill("x")]) assert.throws(() => model.validateCommand({ ...form, argv }));
  assert.throws(() => model.commandContext({ root: "relative" }), /absolute/);
  assert.notEqual(model.commandProjectKey(context), model.commandProjectKey({ ...context, on: "remote" }));
  const state = initial(), before = JSON.stringify(state);
  assert.throws(() => model.saveCommand(state, context, { ...form, title: "Changed" }, "command-1", "stale"), /another view/);
  assert.equal(JSON.stringify(state), before);
});

test("templates, favorite/order and unfinished forms persist; capacity never evicts templates", () => {
  let state = initial();
  state = model.saveCommand(state, context, { ...form, title: "Other" }, null, null, 200, "command-2");
  state = model.favoriteCommand(state, context, "command-2");
  assert.equal(model.displayedCommands(model.commandProject(state, context))[0].id, "command-2");
  state = model.moveCommand(state, context, "command-2", -1);
  state = model.saveCommandDraft(state, context, { draftId: "draft-1", title: "Unfinished", cwd: context.root, argvText: '["echo",' });
  const reloaded = JSON.parse(JSON.stringify(state));
  assert.equal(model.commandProject(reloaded, context).drafts[0].argvText, '["echo",');
  assert.equal(model.commandProject(reloaded, context).commands[0].id, "command-2");
  const project = model.commandProject(state, context), full = { projects: [{ ...project, commands: Array.from({ length: 40 }, (_, i) => ({ ...command(initial()), id: `cmd-${i}` })) }] };
  const before = JSON.stringify(full);
  assert.throws(() => model.saveCommand(full, context, form), /40 commands/);
  assert.equal(JSON.stringify(full), before);
});

test("run and cancellation reservations coordinate copies and retain all active tasks at history limit", () => {
  let state = reserve(), run = record(state);
  assert.throws(() => model.reserveCommandRun(state, context, command(state), "duplicate"), /active or unconfirmed/);
  assert.throws(() => model.saveCommand(state, context, form, command(state).id, model.commandRevision(command(state))), /active run/);
  state = model.patchCommandRun(state, context, run.token, { ...model.commandTerminal(run, terminal(run)), resolvedArgv: [...run.argv] });
  state = model.reserveCommandCancel(state, context, run.token, "cancel-1");
  assert.throws(() => model.reserveCommandCancel(state, context, run.token, "cancel-2"), /cannot be cancelled/);
  assert.equal(model.commandTerminal(record(state), terminal(record(state))).status, "cancelling");
  const project = model.commandProject(initial(), context);
  const full = { projects: [{ ...project, runs: [ ...Array.from({ length: 39 }, (_, i) => ({ ...run, token: `active-${i}`, commandId: `other-${i}` })), { ...run, token: "old", status: "succeeded" }] }] };
  const next = model.reserveCommandRun(full, context, project.commands[0], "new");
  assert.equal(model.commandProject(next, context).runs.length, 40);
  assert(model.commandProject(next, context).runs.some(item => item.token === "active-0"));
});

test("core outcomes are honest and terminal ownership blocks replaced or unrelated tasks", () => {
  const run = record(reserve());
  const running = model.commandTerminal(run, terminal(run));
  assert.equal(running.status, "running");
  assert.equal(model.commandTerminal(run, terminal(run, { state: "finished", exit_code: 0, reason: "exited" })).status, "succeeded");
  assert.equal(model.commandTerminal(run, terminal(run, { state: "finished", exit_code: 7, reason: "exited" })).status, "failed");
  assert.equal(model.commandTerminal(run, terminal(run, { state: "finished", exit_code: null, reason: "killed" })).status, "cancelled");
  assert.equal(model.commandTerminal(run, terminal(run, { state: "finished", exit_code: null, reason: "holder_lost" })).status, "lost");
  assert.throws(() => model.commandTerminal({ ...run, ...running }, terminal(run, { created_ms: 999 })), /changed/);
  assert.throws(() => model.commandTerminal(run, terminal(run, { labels: {} })), /belongs/);
});

test("launcher resolves executable names without shell-expanding argv and uses detached unique labels", async () => {
  const run = { ...record(reserve()), argv: ["python", "path with spaces.py", "$(danger)"] }, calls = [];
  const result = await client.startCommand(run, { execute: async (program, argv, options) => { calls.push([program, argv, options]); return { code: 0, stdout: "/uv/env/bin/python\n" }; }, control: async argv => { calls.push(argv); return argv[0] === "run" ? reply({ address: "t5", agent: "python", cwd: run.cwd, state: "live", turn: 0 }) : reply(terminal({ ...run, resolvedArgv: ["/uv/env/bin/python", ...run.argv.slice(1)] })); } });
  assert.equal(result.status, "running");
  assert.deepEqual(calls[0][1], ["-c", 'command -v "$1"', "project-command", "python"]);
  const sent = calls[1];
  assert(sent.includes("--no-parent") && sent.includes("--no-notify") && sent.includes("--bg"));
  assert(!sent.includes("--keep") && !sent.includes("--rm"));
  assert.deepEqual(sent.slice(sent.indexOf("--") + 1), ["/uv/env/bin/python", "path with spaces.py", "$(danger)"]);
});

test("lost launch acknowledgements recover by exact labels, never auto-start again", async () => {
  const run = record(reserve()), calls = [];
  await assert.rejects(client.startCommand(run, { execute: async () => { throw new Error("no resolve for absolute"); }, control: async argv => { calls.push(argv); throw new Error("network gone"); } }), error => error.launchAttempted === true);
  const recovered = await client.inspectCommand(run, { control: async argv => { calls.push(argv); return reply(argv[0] === "get" ? terminal(run) : [terminal(run)]); } });
  assert.equal(recovered.address, "t5"); assert.equal(calls.length, 3); assert.equal(calls[1][0], "ls"); assert.deepEqual(calls[2], ["get", "--json", "t5"]);
  await assert.rejects(client.inspectCommand(run, { control: async () => reply([terminal(run), terminal(run, { address: "t6" })]) }), /More than one/);
  const unavailable = await client.inspectCommand(run, { control: async () => reply([]) }, 40000);
  assert.equal(unavailable.status, "unavailable");
});

test("cancel rechecks the exact owned terminal and never kills a replacement; output reads are bounded", async () => {
  const reserved = record(reserve()), run = { ...reserved, ...model.commandTerminal(reserved, terminal(reserved)), resolvedArgv: reserved.argv }, calls = [];
  await assert.rejects(client.cancelCommand(run, { control: async argv => { calls.push(argv); return reply(terminal(run, { created_ms: 999 })); } }), /changed/);
  assert.equal(calls.length, 1); calls.length = 0;
  const result = await client.cancelCommand(run, { control: async argv => { calls.push(argv); return argv[0] === "get" ? reply(terminal(run, calls.length > 2 ? { state: "finished", exit_code: null, reason: "killed" } : {})) : reply({}); } });
  assert.equal(result.status, "cancelled"); assert.equal(calls.filter(argv => argv[0] === "kill").length, 1);
  const output = await client.commandOutput(run, { control: async argv => argv[0] === "get" ? reply(terminal(run, { state: "finished", exit_code: 0 })) : { code: 0, stdout: "x".repeat(400100) } });
  assert.equal(output.text.length, 400000); assert.equal(output.truncated, true);
});

function element() {
  const node = { attrs: {}, events: {}, childNodes: [] };
  const proxy = new Proxy(node, { get(target, key) {
    if (key === "child") return child => { target.childNodes.push(child); return proxy; };
    if (key === "children") return values => { target.childNodes.push(...values); return proxy; };
    if (key === "when") return (condition, callback) => condition ? callback(proxy) : proxy;
    if (String(key).startsWith("on_")) return (...args) => { target.events[key] = args.at(-1); return proxy; };
    if (key in target) return target[key];
    return value => { target.attrs[key] = value; return proxy; };
  } }); return proxy;
}
const nodes = node => !node || typeof node !== "object" ? [] : [node, ...node.childNodes.flatMap(nodes)];
const find = (node, id) => nodes(node).find(item => item.attrs.id === id);
function harness({ state = initial(), holdStart = false, store = { value: state } } = {}) {
  let rendering = false, notifications = 0; const tasks = [], timers = [], controls = [], inputs = [];
  const cx = { focus_handle: () => ({ focus() {} }), stop_propagation() {}, notify() { assert(!rendering); notifications++; }, spawn(task) { tasks.push(task(cx)); }, timer: { after(ms, callback) { timers.push({ ms, callback }); }, every() { throw new Error("Idle commands must not poll."); } } };
  const input = options => { let text = options.value || ""; const events = {}; const control = { value: () => text, set_value(next) { text = next; }, on(name, callback) { events[name] = callback; }, type(next) { text = next; events.change?.({}, cx); }, focus() {}, release() { this.released = true; } }; inputs.push(control); return control; };
  const deps = { ...model, ...client, div: element, svg: element, v_flex: element, h_flex: element, Input: { new: element }, Textarea: { new: element }, Editor: { new: element }, InputState: { new: input }, TextareaState: { new: input }, EditorState: { new: input },
    projectContext: () => context, focused: () => ({}), spaces: () => [], panes: () => [], terminals: () => [], theme: () => ({}), settings: () => ({}), shared: () => store.value,
    setShared(_key, next) { assert(!rendering); store.value = next; }, closeOverlay() {}, run(...args) { controls.push(args); },
    exec: async (program, argv) => { controls.push([program, argv]); if (argv[0] === "run") { if (holdStart) await new Promise(() => {}); const current = record(store.value); return reply({ address: "t5", agent: "echo", cwd: current.cwd, state: "live", turn: 0 }); } if (argv[0] === "get") { const current = record(store.value); return reply(terminal(current, { state: "finished", exit_code: 0, reason: "exited" })); } return reply([]); } };
  const source = readFileSync(new URL("../mods/sessions-plus/commands.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  const Commands = new Function(...Object.keys(deps), source)(...Object.values(deps)), view = new Commands(); view.init({ context }, cx);
  return { view, cx, store, inputs, controls, tasks, timers, state: () => store.value, render() { rendering = true; try { return view.render(cx); } finally { rendering = false; } }, click(id) { const item = find(this.render(), id); assert(item, id); item.events.on_click({}, cx); }, async settle() { for (let i = 0; i < 10 && tasks.length; i++) await Promise.all(tasks.splice(0)); } };
}

test("production UI keeps form drafts, saves explicitly, and never starts commands from editing or rendering", async () => {
  const f = harness(); f.render(); assert.equal(f.controls.length, 0);
  f.click("commands-new"); f.inputs[0].type("Build"); f.inputs[1].type("/fixture/project"); f.inputs[2].type('["/bin/echo", "Build"]');
  f.click("commands-form-back"); assert.equal(model.commandProject(f.state(), context).drafts[0].title, "Build"); assert.equal(f.controls.length, 0);
  f.click(`command-restore-${model.commandProject(f.state(), context).drafts[0].draftId}`); f.click("commands-form-save");
  assert.equal(model.commandProject(f.state(), context).commands.length, 2); assert.equal(model.commandProject(f.state(), context).drafts.length, 1);
  f.click("command-start-command-1"); f.click("command-start-command-1"); await f.settle();
  assert.equal(f.controls.filter(call => call[1]?.[0] === "run").length, 1);
  assert.equal(record(f.state()).status, "succeeded");
});

test("closing the command panel keeps task reservations and releases only native input state", () => {
  const f = harness({ holdStart: true }); f.click("command-start-command-1"); f.view.close();
  assert.equal(record(f.state()).status, "starting");
  assert.equal(f.controls.some(call => call[1]?.[0] === "kill"), false);
  assert(f.inputs.every(input => input.released));
});

test("an unconfirmed cancellation unlocks only after a fresh owned-terminal check and deadline, never by automatically killing again", async () => {
  let state = reserve(), original = record(state);
  state = model.patchCommandRun(state, context, original.token, model.commandTerminal(original, terminal(original)));
  state = model.reserveCommandCancel(state, context, original.token, "cancel-1", 1000);
  const run = record(state), calls = [];
  const deps = { control: async argv => { calls.push(argv); return reply(terminal(run)); } };
  assert.equal((await client.inspectCommand(run, deps, 2000)).status, "cancelling");
  const checked = await client.inspectCommand(run, deps, 31000);
  assert.equal(checked.status, "running"); assert.equal(checked.cancelToken, null);
  assert(calls.every(argv => argv[0] === "get"));
  const updated = model.patchCommandRun(state, context, run.token, checked);
  assert.equal(record(model.reserveCommandCancel(updated, context, run.token, "cancel-2", 31001)).cancelToken, "cancel-2");
});


test("production forms restore independent bounded copies and closing a stale copy never overwrites another edit", () => {
  const a = harness(); a.click("commands-new"); a.inputs[0].type("Unfinished"); a.inputs[2].type('["/bin/echo", "original"]'); a.click("commands-form-back");
  const original = a.view.project().drafts[0], b = harness({ store: a.store });
  a.view.openForm(null, a.cx, original); b.view.openForm(null, b.cx, original);
  assert.notEqual(a.view.form.draftId, b.view.form.draftId); assert.notEqual(a.view.form.draftId, original.draftId);
  const aId = a.view.form.draftId;
  a.inputs[2].type('["/bin/echo", "newer edit A"]'); b.view.close();
  const drafts = a.view.project().drafts;
  assert.equal(drafts.find(draft => draft.draftId === aId).argvText, '["/bin/echo", "newer edit A"]');
  assert.equal(drafts.find(draft => draft.draftId === original.draftId).argvText, '["/bin/echo", "original"]');
  assert.equal(drafts.length, 2); assert.equal(a.controls.length + b.controls.length, 0);
});

test("production copies keep both writers and saving one cannot erase the other or the source", () => {
  let state = model.saveCommandDraft(initial(), context, { draftId: "source", title: "Shared", cwd: context.root, argvText: '["/bin/echo", "original"]' });
  const a = harness({ state }), b = harness({ store: a.store }), original = a.view.project().drafts[0];
  a.view.openForm(null, a.cx, original); b.view.openForm(null, b.cx, original);
  a.inputs[2].type('["/bin/echo", "writer A"]'); b.inputs[2].type('["/bin/echo", "writer B"]');
  a.view.save(a.cx); b.view.close();
  assert(a.view.project().commands.some(command => command.argv[1] === "writer A"));
  assert(a.view.project().drafts.some(draft => draft.argvText === '["/bin/echo", "writer B"]'));
  assert(a.view.project().drafts.some(draft => draft.draftId === "source"));
});

test("production stale views cannot resurrect discarded drafts, and stale discard cannot delete newer text", () => {
  const a = harness(); a.click("commands-new"); a.inputs[0].type("Draft"); const stale = a.view.project().drafts[0];
  const b = harness({ store: a.store });
  a.inputs[2].type('["/bin/echo", "newer"]'); b.view.discardDraft(stale, b.cx);
  assert.match(b.view.error, /changed/); assert.equal(a.view.project().drafts[0].argvText, '["/bin/echo", "newer"]');
  b.view.discardDraft(a.view.project().drafts[0], b.cx); assert.equal(a.view.project().drafts.length, 0);
  a.inputs[2].type('["/bin/echo", "after discard"]'); assert.match(a.view.error, /discarded/);
  a.view.close(); assert.equal(a.view.project().drafts.length, 0);
});

test("production form capacity refuses a restore before editing and leaves every original untouched", () => {
  let state = initial();
  for (let i = 0; i < model.COMMAND_LIMITS.drafts; i++) state = model.saveCommandDraft(state, context, { draftId: `full-${i}`, title: `Form ${i}`, cwd: context.root, argvText: '["/bin/echo", "keep"]' });
  const f = harness({ state }), before = JSON.stringify(f.state());
  f.view.openForm(null, f.cx, f.view.project().drafts[0]);
  assert.equal(f.view.form, null); assert.match(f.view.error, /Eight unfinished/); assert.equal(JSON.stringify(f.state()), before);
  f.view.openForm(null, f.cx); assert.equal(f.view.form, null); assert.equal(JSON.stringify(f.state()), before);
  f.view.close(); assert.equal(JSON.stringify(f.state()), before);
});

test("production unchanged restore copies return their reserved slot on close or Back", () => {
  let state = model.saveCommandDraft(initial(), context, { draftId: "source", title: "Shared", cwd: context.root, argvText: '["/bin/echo"]' });
  const f = harness({ state }), original = f.view.project().drafts[0];
  for (let i = 0; i < 12; i++) { f.view.openForm(null, f.cx, original); assert.equal(f.view.project().drafts.length, 2); f.view.back(f.cx); assert.equal(f.view.project().drafts.length, 1); }
  const g = harness({ store: f.store }); g.view.openForm(null, g.cx, original); g.view.close();
  assert.deepEqual(f.view.project().drafts, [original]);
});


test("lost ACK recovery accepts the current hc object envelope and the legacy array without relaunching", async () => {
  const run = record(reserve()), calls = [];
  for (const envelope of [{ hidden_finished: 0, terminals: [terminal(run)] }, [terminal(run)]]) {
    const result = await client.inspectCommand(run, { control: async args => { calls.push(args); return reply(args[0] === "get" ? terminal(run) : envelope); } });
    assert.equal(result.address, "t5"); assert.equal(result.status, "running");
  }
  assert(calls.filter(args => args[0] === "ls").every(args => args.includes("--all") && args.includes(`${model.COMMAND_LABEL}=${run.token}`)));
  assert.deepEqual(calls.map(args => args[0]), ["ls", "get", "ls", "get"]);
  await assert.rejects(() => client.inspectCommand(run, { control: async () => reply({ hidden_finished: 0, terminals: [terminal(run), terminal(run, { address: "t6" })] }) }), /More than one/);
  await assert.rejects(() => client.inspectCommand(run, { control: async () => reply({ hidden_finished: 0, terminals: "invalid" }) }), /could not recover/);
  await assert.rejects(() => client.inspectCommand(run, { control: async args => reply(args[0] === "get" ? terminal(run, { labels: {} }) : { hidden_finished: 0, terminals: [terminal(run)] }) }), /belongs/);
  assert.equal((await client.inspectCommand(run, { control: async () => reply({ hidden_finished: 0, terminals: [] }) }, 1001)).status, "unconfirmed");
  assert.equal((await client.inspectCommand(run, { control: async () => reply({ hidden_finished: 0, terminals: [] }) }, 40000)).status, "unavailable");
});


test("lost ACK recovery resolves a real compact hc list summary through full get before checking ownership", async () => {
  const run = record(reserve()), summary = { address: "t5", agent: "echo", cwd: run.cwd, name: "fixture", state: "live", turn: 0 }, calls = [];
  const recovered = await client.inspectCommand(run, { control: async args => { calls.push(args); return reply(args[0] === "ls" ? { hidden_finished: 0, terminals: [summary] } : terminal(run)); } });
  assert.equal(recovered.status, "running"); assert.deepEqual(calls.map(args => args[0]), ["ls", "get"]);
  await assert.rejects(() => client.inspectCommand(run, { control: async args => reply(args[0] === "ls" ? { terminals: [summary] } : terminal(run, { labels: {} })) }), /belongs/);
  await assert.rejects(() => client.inspectCommand(run, { control: async args => reply(args[0] === "ls" ? { terminals: [summary] } : terminal(run, { address: "t6" })) }), /different task terminal/);
  const remote = { ...run, on: "server" }, remoteCalls = [];
  await client.inspectCommand(remote, { control: async args => { remoteCalls.push(args); return reply(args[0] === "ls" ? { terminals: [{ ...summary, address: "server/t5" }] } : terminal(remote, { address: "t5" })); } });
  assert.deepEqual(remoteCalls[1], ["get", "--json", "server/t5"]); assert(remoteCalls.every(args => ["ls", "get"].includes(args[0])));
  await assert.rejects(() => client.inspectCommand(remote, { control: async () => reply({ terminals: [{ ...summary, address: "wrong/t5" }] }) }), /wrong machine/);
});
