import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as model from "../mods/sessions-plus/prompt-queue-model.js";
import { PROVIDERS } from "../mods/sessions-plus/model.js";
import { deliverPrompts } from "../mods/sessions-plus/prompt-queue-client.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const terminal = (options = {}) => ({ address: "t7", state: "live", created_ms: 100, pid: 200, cwd: "/fixture/project", status: { state: "idle", task: "Fixture task" }, argv: ["codex", "resume", sessionId], foreground: { pid: 201, argv: ["codex", "resume", sessionId] }, ...options });
const agent = (options = {}) => ({ address: "t7", title: "Target agent", status: "idle", program: { agent: true }, ...options });
const target = () => model.promptTarget(agent(), terminal());
const itemState = (text = "Check the edge case") => model.savePrompt({}, target(), text, null, 1000, "item-1");

function element() {
  const node = { attributes: {}, events: {}, childNodes: [] };
  const proxy = new Proxy(node, { get(object, name) {
    if (name === "child") return child => { object.childNodes.push(child); return proxy; };
    if (name === "children") return children => { object.childNodes.push(...children); return proxy; };
    if (name === "when") return (condition, callback) => condition ? callback(proxy) : proxy;
    if (String(name).startsWith("on_")) return (...args) => { object.events[name] = args.at(-1); return proxy; };
    if (name in object) return object[name];
    return value => { object.attributes[name] = value; return proxy; };
  } });
  return proxy;
}
const descendants = node => !node || typeof node !== "object" ? [] : [node, ...node.childNodes.flatMap(descendants)];
const find = (node, id) => descendants(node).find(child => child.attributes.id === id);
const content = node => typeof node === "string" ? node : (node?.childNodes || []).map(content).join(" ");

function harness({ initial = {}, reply = { code: 0, stdout: '{"turn":4}' } } = {}) {
  const state = { value: initial, terminals: [terminal()], agents: [agent()], focus: { terminal: "t7" } }, tasks = [], sent = [], timers = [];
  const p = { target: target(), overlay: "queue-overlay" };
  const cx = { notify() {}, stop_propagation() {}, focus_handle: () => ({ focus() {} }),
    timer: { every(milliseconds, callback) { timers.push({ milliseconds, callback, repeat: true }); }, after(milliseconds, callback) { timers.push({ milliseconds, callback }); } }, spawn(callback) { tasks.push(callback(cx)); } };
  const retained = { value: "", released: false, listeners: {}, focus() {}, set_value(value) { this.value = value; }, release() { this.released = true; }, on(name, callback) { this.listeners[name] = callback; } };
  const dependencies = { ...model, PROVIDERS, deliverPrompts, div: element, v_flex: element, h_flex: element, Textarea: { new: element },
    TextareaState: { new: options => { retained.value = options.value; return { value: () => retained.value, set_value: value => retained.set_value(value), on: (name, callback) => retained.on(name, callback), focus() {}, release: () => retained.release() }; } },
    theme: () => ({}), focused: () => state.focus, agents: () => state.agents, terminals: () => state.terminals, panes: () => [],
    shared: () => state.value, setShared: (_key, value) => { state.value = value; }, closeOverlay() {}, run() {},
    hc: async () => ({ code: 0, stdout: JSON.stringify(state.terminals[0]) }), exec: async (command, args, options) => { sent.push({ command, args, options }); return reply; },
  };
  const source = readFileSync(new URL("../mods/sessions-plus/prompt-queue.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  const Queue = new Function(...Object.keys(dependencies), source)(...Object.values(dependencies));
  const view = new Queue(); view.init(p, cx);
  return { view, state, sent, retained, cx, tasks, timers, render: () => view.render(cx),
    async finish() { for (let index = 0; index < tasks.length; index++) await tasks[index]; },
    type(value) { retained.value = value; retained.listeners.change({}, cx); },
    click(id) { const button = find(view.render(cx), id); assert(button, `Missing ${id}`); button.events.on_click({}, cx); } };
}

test("targets separate fresh processes and reused terminals, and reject shells or incomplete identity", () => {
  const original = target();
  assert(original);
  assert.equal(model.promptTarget(agent(), terminal({ created_ms: null })), null);
  assert.equal(model.promptTarget(agent(), terminal({ state: "finished" })), null);
  assert.equal(model.promptTarget(agent(), terminal({ foreground: { pid: 999, argv: ["zsh", "-li"] } })), null);
  const resumed = model.promptTarget(agent(), terminal({ address: "t8", foreground: { pid: 999, argv: ["codex", "resume", sessionId] } }));
  assert.equal(resumed, null, "agent and terminal addresses must agree");
  const sameSession = model.promptTarget(agent({ address: "t8" }), terminal({ address: "t8", created_ms: 500 }));
  assert.equal(sameSession.key, original.key);
  assert.equal(model.samePromptTarget(original, sameSession), false);
  const fresh = pid => model.promptTarget(agent(), terminal({ argv: ["codex"], foreground: { pid, argv: ["codex"] } }));
  assert.notEqual(fresh(201).key, fresh(202).key);
  assert.notEqual(model.promptTarget(agent(), terminal({ created_ms: 101 })).created, original.created);
  assert(!JSON.stringify(original).includes('"argv"'), "raw launch arguments are not persisted");
});

test("pending drafts survive persistence, sent edits return to pending, and queue limits never evict work", () => {
  let state = model.saveComposer(itemState(), target(), "Unfinished draft");
  assert.equal(model.queueFor(JSON.parse(JSON.stringify(state)), target()).composer, "Unfinished draft");
  const prepared = model.preparePrompts(state, target(), ["item-1"]);
  state = model.beginPromptSend(state, prepared, "attempt", 2000);
  assert.throws(() => model.savePrompt(state, target(), "Changed", "item-1"), /delivery/);
  state = model.finishPromptSend(state, target(), "attempt", true, 3000);
  assert.equal(model.queueFor(state, target()).items[0].status, "sent");
  state = model.savePrompt(state, target(), "Changed", "item-1", 4000);
  assert.equal(model.queueFor(state, target()).items[0].status, "pending");
  const full = { queues: Array.from({ length: model.QUEUE_LIMITS.queues }, (_, index) => ({ key: `saved-${index}`, target: { key: `saved-${index}` }, composer: "", items: [{ id: "pending", text: "Keep me", status: index % 2 ? "uncertain" : "pending" }] })) };
  const before = JSON.stringify(full);
  assert.throws(() => model.savePrompt(full, target(), "New"), /limit/);
  assert.equal(JSON.stringify(full), before);
});

test("preview snapshots reject changed text, deduplicate sending, and require manual resolution after uncertainty", () => {
  let state = itemState();
  state = model.savePrompt(state, target(), "Second\ncontinued", null, 1001, "item-2");
  const prepared = model.preparePrompts(state, target(), ["item-1", "item-2"]);
  assert.equal(prepared.message, "1. Check the edge case\n\n2. Second\n   continued");
  assert.throws(() => model.beginPromptSend(model.savePrompt(state, target(), "Changed", "item-1", 1002), prepared, "send"), /changed/);
  state = model.beginPromptSend(state, prepared, "send", 10000);
  assert.throws(() => model.beginPromptSend(state, prepared, "duplicate"), /changed/);
  assert.throws(() => model.resolvePromptDelivery(state, target(), "item-1", false, 10001), /Wait/);
  state = model.finishPromptSend(state, target(), "send", false, 10010);
  assert(model.queueFor(state, target()).items.every(item => item.status === "uncertain"));
  assert.throws(() => model.preparePrompts(state, target(), ["item-1"]), /changed/);
  state = model.resolvePromptDelivery(state, target(), "item-1", false, 10020);
  assert.equal(model.queueFor(state, target()).items[0].status, "pending");
  assert.equal(model.queueFor(state, target()).items[1].status, "uncertain");
});

test("sender revalidates live/core identity and never sends to a shell or replacement agent", async () => {
  const prepared = model.preparePrompts(itemState(), target(), ["item-1"]), sent = [];
  const dependencies = { current: () => target(), inspect: async () => ({ code: 0, stdout: JSON.stringify(terminal()) }), send: async argv => { sent.push(argv); return { code: 0, stdout: '{"turn":4}' }; } };
  await deliverPrompts(prepared, dependencies);
  assert.deepEqual(sent, [["send", "--json", "--if", "idle", "t7", "Check the edge case"]]);
  assert(!sent[0].includes("--force"));
  sent.length = 0;
  await assert.rejects(deliverPrompts(prepared, { ...dependencies, current: () => null }), /changed/);
  await assert.rejects(deliverPrompts(prepared, { ...dependencies, inspect: async () => ({ code: 0, stdout: JSON.stringify(terminal({ foreground: { pid: 999, argv: ["zsh", "-li"] } })) }) }), /changed/);
  let switched = false;
  await assert.rejects(deliverPrompts(prepared, { ...dependencies, current: () => switched ? null : target(), inspect: async () => { switched = true; return { code: 0, stdout: JSON.stringify(terminal()) }; } }), /changed/);
  assert.equal(sent.length, 0);
});

test("sender rejects blocked dialogs and ambiguous acknowledgements without retrying", async () => {
  const prepared = model.preparePrompts(itemState(), target(), ["item-1"]);
  let calls = 0;
  const base = { current: () => target(), inspect: async () => ({ code: 0, stdout: JSON.stringify(terminal()) }), send: async () => { calls++; return { code: 0, stdout: "" }; } };
  await assert.rejects(deliverPrompts(prepared, { ...base, inspect: async () => ({ code: 0, stdout: JSON.stringify(terminal({ status: { state: "blocked" } })) }) }), /dialog/);
  assert.equal(calls, 0);
  await assert.rejects(deliverPrompts(prepared, base), /not confirmed/);
  assert.equal(calls, 1);
  await assert.rejects(deliverPrompts(prepared, { ...base, send: async () => { calls++; throw new Error("timeout"); } }), /timeout/);
  assert.equal(calls, 2);
  for (const response of [{}, { ok: false, turn: 1 }, { turn: -1 }, { turn: 1.5 }, { turn: "1" }]) {
    await assert.rejects(deliverPrompts(prepared, { ...base, send: async () => ({ code: 0, stdout: JSON.stringify(response) }) }), /not confirmed/);
  }
});

test("production UI persists composition, previews explicitly and sends once to the captured target", async () => {
  const f = harness();
  f.type("Explain `$(literal)`\nand fix it");
  assert.equal(f.view.queue().composer, "Explain `$(literal)`\nand fix it");
  f.click("prompt-save");
  assert.equal(f.view.queue().items.length, 1);
  assert.equal(f.sent.length, 0);
  f.click("prompt-send-all");
  assert.match(content(find(f.render(), "prompt-message-preview")), /Explain `\$\(literal\)`/);
  assert.equal(f.sent.length, 0);
  f.state.focus = { terminal: "other-agent" };
  f.click("prompt-preview-send"); f.click("prompt-preview-send");
  await f.finish();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].args.at(-2), "t7");
  assert.equal(f.sent[0].args.at(-1), "Explain `$(literal)`\nand fix it");
  assert.equal(f.sent[0].options.timeout, 15000);
  assert.equal(f.view.queue().items[0].status, "sent");
  f.view.close(); assert(f.retained.released);
});

test("production UI retains failed sends, prevents implicit retry, and confirms queue clearing", async () => {
  const f = harness({ initial: itemState(), reply: { code: 1, stdout: '{"error":"unavailable"}' } });
  f.click("prompt-send-all"); f.click("prompt-preview-send"); await f.finish();
  const item = f.view.queue().items[0];
  assert.equal(item.status, "uncertain"); assert.equal(f.sent.length, 1);
  assert.equal(find(f.render(), `prompt-send-${item.id}`), undefined);
  f.click(`prompt-check-${item.id}`); f.click(`prompt-retry-${item.id}`);
  assert.equal(f.view.queue().items[0].status, "pending"); assert.equal(f.sent.length, 1);
  f.click("prompt-clear"); assert.equal(f.view.queue().items.length, 1);
  f.click("prompt-clear-cancel"); assert.equal(f.view.queue().items.length, 1);
  f.click("prompt-clear"); f.click("prompt-clear-confirm");
  assert.equal(f.view.queue().items.length, 0); assert.equal(f.state.value.queues.length, 0);
});

test("saved queues remain available when an agent ends, with sending disabled", () => {
  const f = harness({ initial: itemState() });
  f.state.terminals = [terminal({ state: "finished" })];
  assert.equal(find(f.render(), "prompt-send-all").attributes.disabled, true);
  assert.match(content(f.render()), /unavailable or its session changed/);
  f.click("prompt-choose-recipient");
  assert.match(content(f.render()), /Saved queues/);
  assert.equal(f.sent.length, 0);
});


test("switching recipients keeps the composer draft and editing never overwrites another draft", () => {
  const f = harness({ initial: itemState() });
  f.type("Keep this unfinished note");
  f.click("prompt-edit-item-1");
  assert.match(f.view.error, /current draft/);
  assert.equal(f.retained.value, "Keep this unfinished note");
  const another = model.promptTarget(agent({ address: "t8" }), terminal({ address: "t8", foreground: { pid: 777, argv: ["claude"] } }));
  f.view.choose(another, f.cx);
  assert.equal(f.retained.value, "");
  f.view.choose(target(), f.cx);
  assert.equal(f.retained.value, "Keep this unfinished note");
  assert.equal(f.sent.length, 0);
});


test("idle queues schedule no redraw timer; active delivery schedules a single expiry notification", () => {
  const f = harness({ initial: itemState() });
  f.render(); f.render();
  assert.equal(f.timers.length, 0);
  const prepared = model.preparePrompts(f.state.value, target(), ["item-1"]);
  f.state.value = model.beginPromptSend(f.state.value, prepared, "in-flight");
  f.render(); f.render();
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].repeat, undefined);
  assert(f.timers[0].milliseconds > 29000 && f.timers[0].milliseconds <= 30001);
});


test("sender reads the core Status.state object and never guesses status from cached agent data", async () => {
  const prepared = model.preparePrompts(itemState(), target(), ["item-1"]), sent = [];
  const send = async argv => { sent.push(argv); return { code: 0, stdout: '{"turn":7}' }; };
  for (const status of [{ state: "idle", task: "Real core shape" }, { state: "working", needs_input: false }, "idle", "working"]) {
    await deliverPrompts(prepared, { current: () => ({ ...target(), status: "blocked" }), inspect: async () => ({ code: 0, stdout: JSON.stringify(terminal({ status })) }), send });
    assert.equal(sent.at(-1)[3], typeof status === "string" ? status : status.state);
  }
  assert.equal(sent.length, 4);
  for (const status of [{ state: "blocked" }, { state: "done" }, null, {}, { state: "unknown" }]) {
    await assert.rejects(deliverPrompts(prepared, { current: () => ({ ...target(), status: "working" }), inspect: async () => ({ code: 0, stdout: JSON.stringify(terminal({ status })) }), send }), /dialog/);
  }
  assert.equal(sent.length, 4, "blocked, done, absent and unknown core states cannot submit");
  assert.equal(model.promptTarget(agent(), terminal({ status: { state: "working" } })).status, "working");
});
