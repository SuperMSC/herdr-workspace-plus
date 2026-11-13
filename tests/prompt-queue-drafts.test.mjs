import assert from "node:assert/strict";
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

test("unassigned drafts persist through queue edits and clearing, and assignment atomically moves one item", () => {
  let state = queue.saveQueueDraft(queue.saveComposer(null, target, "Keep composer"), { text: "Captured file", machine: "", title: "File" });
  const id = state.drafts[0].id;
  state = queue.savePrompt(state, target, "Another item"); assert.equal(state.drafts[0].id, id);
  state = queue.clearPromptQueue(state, target.key); assert.equal(state.drafts[0].text, "Captured file");
  const next = queue.assignQueueDraft(state, id, target); assert.equal(queue.queueFor(next, target).items[0].text, "Captured file");
  assert.equal(queue.queueState(next).drafts, undefined); assert.equal(state.drafts.length, 1);
  assert.throws(() => queue.assignQueueDraft(next, id, target), /removed or assigned/);
});

test("draft count, text, captured machine and total size limits reject changes without evicting work", () => {
  let state = null;
  for (let i = 0; i < queue.QUEUE_LIMITS.items; i++) state = queue.saveQueueDraft(state, { text: "Draft " + i, machine: null });
  const before = JSON.stringify(state); assert.throws(() => queue.saveQueueDraft(state, { text: "Overflow", machine: null }), /limit/); assert.equal(JSON.stringify(state), before);
  assert.throws(() => queue.saveQueueDraft(null, { text: "\0", machine: null }), /NUL/);
  assert.throws(() => queue.saveQueueDraft(null, { text: "Invalid machine", machine: 5 }), /machine/);
  const large = queue.saveQueueDraft(null, { text: "x".repeat(200000), machine: "" });
  assert.throws(() => queue.saveComposer(large, target, "x".repeat(queue.QUEUE_LIMITS.text + 1)), /characters/);
  assert.throws(() => queue.saveQueueDraft(large, { text: "x".repeat(50000), machine: null }), /full/);
  assert.throws(() => queue.assignQueueDraft(large, large.drafts[0].id, { ...target, machine: "server" }), /captured machine/);
});
