import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as queue from "../mods/sessions-plus/prompt-queue-model.js";
import * as reference from "../mods/sessions-plus/reference-model.js";

const terminal = { address: "t1", created_ms: 101, state: "live", foreground: { pid: 99, argv: ["codex"] }, status: { state: "idle" } };
const agent = { address: "t1", title: "My agent" };
const target = queue.promptTarget(agent, terminal);

test("references capture punctuation and machine as plain text, never evaluate a path", () => {
  const payload = reference.referencePayload({ reference: { root: "/r", relative: "a '$`file.txt", on: "server", line: 7 } });
  assert(payload.text.includes(JSON.stringify("/r/a '$`file.txt") + ":7")); assert.equal(payload.machine, "server");
  assert(!reference.referenceMachineMatches(payload, target));
  assert(reference.referenceMachineMatches(payload, { machine: "server" }));
  assert.equal(reference.referencePayload({ text: "A global note" }).machine, null);
  assert.throws(() => reference.referencePayload({ reference: { root: "/r", relative: "../escape" } }), /captured/);
});

test("appending a file or note preserves the existing queue and its unfinished composer", () => {
  let state = queue.savePrompt(null, target, "Existing item", null, 1, "first");
  state = queue.saveComposer(state, target, "Unfinished typing", 2);
  const next = queue.appendPrompt(state, target, "File reference: /r/file.txt", 3);
  assert.equal(queue.queueFor(next, target).composer, "Unfinished typing");
  assert.equal(queue.queueFor(next, target).items.length, 2);
  assert.equal(queue.queueFor(next, target).items[0].text, "Existing item");
  assert.equal(queue.queueFor(state, target).items.length, 1);
  assert.throws(() => queue.appendPrompt(state, target, "x".repeat(queue.QUEUE_LIMITS.text + 1)), /characters/);
});

function element() { const node = { childNodes: [], attrs: {}, events: {} }; const proxy = new Proxy(node, { get(target, key) {
  if (key === "child") return child => { target.childNodes.push(child); return proxy; };
  if (key === "children") return children => { target.childNodes.push(...children); return proxy; };
  if (key === "when") return (value, fn) => value ? fn(proxy) : proxy;
  if (key in target) return target[key];
  if (String(key).startsWith("on_")) return (...args) => { target.events[key] = args.at(-1); return proxy; };
  return value => { target.attrs[key] = value; return proxy; };
} }); return proxy; }
function harness() {
  let live = [terminal], state = queue.saveComposer(null, target, "Already typing");
  const opens = [], closes = [];
  const cx = { notify() {}, focus_handle: () => ({ focus() {} }) };
  const deps = { ...queue, ...reference, div: element, h_flex: element, v_flex: element, Editor: { new: element }, EditorState: { new: ({ value }) => ({ value: () => value, set_value(next) { value = next; }, on() {}, release() {} }) },
    agents: () => [agent], terminals: () => live, panes: () => [], shared: () => state, setShared: (_key, value) => { state = value; }, closeOverlay: id => closes.push(id), openOverlay: value => opens.push(value), theme: () => ({}) };
  const code = readFileSync(new URL("../mods/sessions-plus/reference.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  const Reference = new Function(...Object.keys(deps), code)(...Object.values(deps)), view = new Reference();
  view.init({ reference: { root: "/r", relative: "file.txt", on: null }, overlay: "ref" }, cx);
  return { view, cx, opens, closes, state: () => state, replace: () => { live = [{ ...terminal, created_ms: 202 }]; } };
}

test("reference UI requires an exact selected recipient and only appends a pending item", () => {
  const f = harness(); f.view.add(f.cx); assert.match(f.view.error, /Choose a live/); assert.equal(f.opens.length, 0);
  f.view.selected = { ...target }; f.view.add(f.cx);
  assert.equal(queue.queueFor(f.state(), target).items.length, 1);
  assert.equal(queue.queueFor(f.state(), target).items[0].status, "pending");
  assert.equal(queue.queueFor(f.state(), target).composer, "Already typing");
  f.view.add(f.cx); assert.equal(queue.queueFor(f.state(), target).items.length, 1);
  assert.equal(f.opens[0].props.role, "prompt-queue"); assert.deepEqual(f.closes, ["ref"]);
  const g = harness(); g.view.selected = { ...target }; g.replace(); g.view.add(g.cx);
  assert.match(g.view.error, /Choose a live/); assert.equal(queue.queueFor(g.state(), target).items.length, 0);
});
