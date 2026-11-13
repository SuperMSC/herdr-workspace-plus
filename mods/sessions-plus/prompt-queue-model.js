import { argvIdentity, cleanTitle, PROVIDERS } from "./model.js";
import { referenceMachineMatches } from "./reference-model.js";

export const PROMPT_QUEUE_KEY = "sessions-plus.prompt-queue.v1";
export const QUEUE_LIMITS = { queues: 40, items: 40, text: 12000, total: 240000, message: 48000 };
const text = value => typeof value === "string" ? value : "";
const validAddress = value => typeof value === "string" && value.length <= 200 && /^[^\s\x00-\x1f\x7f]+$/.test(value);

function fingerprint(value) {
  const source = JSON.stringify(value);
  let first = 2166136261, second = 3339675911;
  for (let index = 0; index < source.length; index++) {
    first = Math.imul(first ^ source.charCodeAt(index), 16777619);
    second = Math.imul(second ^ source.charCodeAt(index), 2246822519);
  }
  return `${source.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

export function promptStatus(value) {
  const state = typeof value === "string" ? value : value?.state;
  return ["idle", "working", "blocked", "done"].includes(state) ? state : null;
}

export function promptTarget(agent, terminal, pane = {}) {
  if (!agent || !terminal || terminal.state !== "live" || agent.address !== terminal.address || !validAddress(terminal.address)) return null;
  const identity = argvIdentity(terminal), created = Number(terminal.created_ms);
  if (!identity || !Object.hasOwn(PROVIDERS, identity.provider) || !Number.isFinite(created) || created <= 0) return null;
  const argv = terminal.foreground?.argv?.length ? terminal.foreground.argv : terminal.argv ?? [];
  const process = terminal.foreground?.pid ?? terminal.pid ?? null;
  const launch = fingerprint([argv, process]);
  const machine = terminal.address.includes("/") ? terminal.address.slice(0, terminal.address.lastIndexOf("/")) : "";
  const key = JSON.stringify(identity.id ? ["session", machine, identity.provider, identity.store || "default", identity.id]
    : ["terminal", terminal.address, created, identity.provider, launch]);
  return { key, address: terminal.address, created, provider: identity.provider, launch, sessionId: identity.id,
    title: cleanTitle(agent.title || agent.tab_name || terminal.title || PROVIDERS[identity.provider]),
    cwd: text(pane.cwd || terminal.cwd).slice(0, 1000), machine, status: promptStatus(terminal.status) || promptStatus(agent.status) };
}

export function promptTargets(agents, terminals, panes = []) {
  return agents.map(agent => promptTarget(agent, terminals.find(terminal => terminal.address === agent.address), panes.find(pane => pane.terminal === agent.address)))
    .filter(Boolean).filter((target, index, targets) => targets.findIndex(other => other.address === target.address) === index);
}

export function samePromptTarget(expected, actual) {
  return Boolean(expected && actual && expected.key === actual.key && expected.address === actual.address && expected.created === actual.created && expected.launch === actual.launch);
}

export function queueState(value) {
  const source = Array.isArray(value?.queues) ? value.queues : [];
  const result = { queues: source.filter(queue => queue && typeof queue.key === "string" && queue.target?.key === queue.key && Array.isArray(queue.items))
    .map(queue => ({ ...queue, composer: text(queue.composer), items: queue.items.filter(item => typeof item?.id === "string" && typeof item.text === "string")
      .map(item => ({ ...item, status: ["pending", "sent", "uncertain"].includes(item.status) ? item.status : "uncertain" })) })) };
  const drafts = (Array.isArray(value?.drafts) ? value.drafts : []).filter(item => typeof item?.id === "string" && typeof item.text === "string" && (item.machine === null || typeof item.machine === "string")).map(item => ({ ...item }));
  if (drafts.length) result.drafts = drafts;
  return result;
}

export function queueFor(state, target) {
  return queueState(state).queues.find(queue => queue.key === target?.key) ?? { key: target?.key, target, composer: "", items: [], updated: 0 };
}

function storeQueue(state, queue) {
  const next = queueState(state), exists = next.queues.findIndex(item => item.key === queue.key);
  if (exists < 0 && next.queues.length >= QUEUE_LIMITS.queues) throw new Error("Saved queue limit reached. Choose a saved queue and clear it first.");
  if (exists < 0) next.queues.push(queue); else next.queues[exists] = queue;
  const total = next.queues.reduce((sum, entry) => sum + entry.composer.length + entry.items.reduce((length, item) => length + item.text.length, 0), 0) + (next.drafts || []).reduce((sum, item) => sum + item.text.length, 0);
  if (total > QUEUE_LIMITS.total) throw new Error("Saved prompts are full. Remove or clear a saved queue before adding more.");
  return next;
}

export function saveComposer(state, target, value, now = Date.now()) {
  if (!target?.key) throw new Error("Choose an agent or saved queue first.");
  if (value.length > QUEUE_LIMITS.text) throw new Error(`Use at most ${QUEUE_LIMITS.text.toLocaleString()} characters per instruction.`);
  return storeQueue(state, { ...queueFor(state, target), target, composer: value, updated: now });
}

export function savePrompt(state, target, value, editId = null, now = Date.now(), id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`) {
  const body = text(value).trim(), queue = queueFor(state, target);
  if (!body || body.length > QUEUE_LIMITS.text || /\x00/.test(body)) throw new Error(`Use 1–${QUEUE_LIMITS.text.toLocaleString()} characters, without NUL.`);
  if (!target?.key) throw new Error("Choose an agent first.");
  const index = queue.items.findIndex(item => item.id === editId);
  if (editId && index < 0) throw new Error("This instruction was removed in another view.");
  if (index >= 0 && queue.items[index].status === "uncertain") throw new Error("Check the previous delivery before editing this instruction.");
  if (index < 0 && queue.items.length >= QUEUE_LIMITS.items) throw new Error(`A queue holds at most ${QUEUE_LIMITS.items} instructions. Remove old items first.`);
  const item = { id: index >= 0 ? editId : id, text: body, status: "pending", created: index >= 0 ? queue.items[index].created : now, updated: now };
  const items = [...queue.items];
  if (index >= 0) items[index] = item; else items.push(item);
  return storeQueue(state, { ...queue, target, composer: "", items, updated: now });
}

export function removePrompt(state, target, id) {
  const queue = queueFor(state, target);
  if (queue.items.some(item => item.id === id && item.activeUntil > Date.now())) throw new Error("Wait for the current send to finish before removing it.");
  return storeQueue(state, { ...queue, items: queue.items.filter(item => item.id !== id), updated: Date.now() });
}

export function clearPromptQueue(state, key) {
  if (queueState(state).queues.find(queue => queue.key === key)?.items.some(item => item.activeUntil > Date.now())) throw new Error("Wait for the current send to finish before clearing it.");
  const next = queueState(state);
  return { ...next, queues: next.queues.filter(queue => queue.key !== key) };
}

export function preparePrompts(state, target, ids) {
  const queue = queueFor(state, target), selected = new Set(ids);
  const items = queue.items.filter(item => selected.has(item.id));
  if (!items.length || items.length !== selected.size || items.some(item => item.status !== "pending")) throw new Error("The selected instructions changed. Preview them again.");
  const message = items.length === 1 ? items[0].text : items.map((item, index) => {
      const prefix = `${index + 1}. `;
      return prefix + item.text.replace(/\n/g, "\n" + " ".repeat(prefix.length));
    }).join("\n\n");
  if (message.length > QUEUE_LIMITS.message) throw new Error("This batch is too large. Send fewer instructions at a time.");
  return { target: { ...target }, items: items.map(item => ({ id: item.id, text: item.text, updated: item.updated })), message };
}

export function beginPromptSend(state, prepared, attempt, now = Date.now()) {
  const fresh = preparePrompts(state, prepared.target, prepared.items.map(item => item.id));
  if (JSON.stringify(fresh.items) !== JSON.stringify(prepared.items) || fresh.message !== prepared.message) throw new Error("The instructions changed after preview. Go back and preview again.");
  const ids = new Set(prepared.items.map(item => item.id)), queue = queueFor(state, prepared.target);
  return storeQueue(state, { ...queue, items: queue.items.map(item => ids.has(item.id) ? { ...item, status: "uncertain", attempt, activeUntil: now + 30000, updated: now } : item), updated: now });
}

export function finishPromptSend(state, target, attempt, accepted, now = Date.now()) {
  const queue = queueFor(state, target);
  return storeQueue(state, { ...queue, items: queue.items.map(item => item.attempt === attempt && item.status === "uncertain"
    ? { ...item, status: accepted ? "sent" : "uncertain", activeUntil: 0, updated: now, ...(accepted ? { sentAt: now } : {}) } : item), updated: now });
}

export function resolvePromptDelivery(state, target, id, delivered, now = Date.now()) {
  const queue = queueFor(state, target);
  if (queue.items.some(item => item.id === id && item.activeUntil > now)) throw new Error("Wait for the current send to finish before checking delivery.");
  return storeQueue(state, { ...queue, items: queue.items.map(item => item.id === id && item.status === "uncertain"
    ? { ...item, status: delivered ? "sent" : "pending", updated: now, attempt: null } : item), updated: now });
}

// Cross-feature additions must not replace an unfinished composer in an existing queue.
export function appendPrompt(state, target, value, now = Date.now()) {
  const composer = queueFor(state, target).composer;
  const next = savePrompt(state, target, value, null, now);

  return saveComposer(next, target, composer, now);
}

export function saveQueueDraft(state, payload, id = null, now = Date.now()) {
  const next = queueState(state), drafts = next.drafts || [], index = drafts.findIndex(item => item.id === id);
  if (id && index < 0) throw new Error("This draft was removed or assigned in another view.");
  if (!id && drafts.length >= QUEUE_LIMITS.items) throw new Error("Saved draft limit reached. Assign or remove a draft first.");
  if (typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > 200000 || payload.text.includes("\0")) throw new Error("Use 1–200,000 characters without NUL for a reference draft.");
  if (payload.machine !== null && typeof payload.machine !== "string") throw new Error("The draft's captured machine is invalid.");
  const item = { ...payload, title: String(payload.title || "Reference draft").slice(0, 120), id: id || `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`, created: index < 0 ? now : drafts[index].created, updated: now };
  const updated = [...drafts]; if (index < 0) updated.push(item); else updated[index] = item;
  const total = next.queues.reduce((sum, entry) => sum + entry.composer.length + entry.items.reduce((n, item) => n + item.text.length, 0), 0) + updated.reduce((sum, item) => sum + item.text.length, 0);
  if (total > QUEUE_LIMITS.total) throw new Error("Saved prompts are full. Remove or clear a saved queue before adding more.");
  return { ...next, drafts: updated };
}

export function removeQueueDraft(state, id) {
  const next = queueState(state);
  return { ...next, drafts: (next.drafts || []).filter(item => item.id !== id) };
}

export function assignQueueDraft(state, id, target) {
  const draft = queueState(state).drafts?.find(item => item.id === id);
  if (!draft) throw new Error("This draft was removed or assigned in another view.");
  if (!referenceMachineMatches(draft, target)) throw new Error("Choose a live agent on the draft's captured machine.");
  return appendPrompt(removeQueueDraft(state, id), target, draft.text);
}
