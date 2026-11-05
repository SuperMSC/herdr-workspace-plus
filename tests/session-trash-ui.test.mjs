import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as model from "../mods/sessions-plus/model.js";
import * as inboxModel from "../mods/sessions-plus/inbox-model.js";
import { createTrashClient } from "../mods/sessions-plus/trash-client.js";

const id = "11111111-1111-4111-8111-111111111111";
const session = () => {
  const row = { id, provider: "claude", store: "/fixture/claude", defaultStore: true, cwd: "/fixture/project", title: "Original session" };
  return { ...row, key: model.sessionKey(row) };
};
const entry = () => ({ ...session(), token: "owned-trash-entry", trashedAt: Date.now(), restorable: true, location: "trash", status: "trashed" });

function element() {
  const node = { events: {}, childNodes: [], attributes: {}, slots: {} };
  const proxy = new Proxy(node, { get(target, name) {
    if (name === "child") return child => { target.childNodes.push(child); return proxy; };
    if (name === "children") return children => { target.childNodes.push(...children); return proxy; };
    if (name === "trigger" || name === "content") return child => { target.slots[name] = child; return proxy; };
    if (name === "when") return (condition, callback) => condition ? callback(proxy) : proxy;
    if (name.startsWith("on_")) return (...args) => { target.events[`${name}:${args.length > 1 ? args[0] : ""}`] = args.at(-1); return proxy; };
    if (name in target) return target[name];
    return value => { target.attributes[name] = value; return proxy; };
  } });
  return proxy;
}

function viewClass(file, dependencies) {
  const source = readFileSync(new URL(`../mods/sessions-plus/${file}.js`, import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  return new Function(...Object.keys(dependencies), source)(...Object.values(dependencies));
}

// Keep the real dismiss guard while replacing only native element construction.
const iconsSource = readFileSync(new URL("../mods/sessions-plus/icons.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace(/export function /g, "function ");
const closeButton = new Function("div", "svg", "image", iconsSource + "\nreturn closeButton;")(element, element, element);

const nodes = node => !node || typeof node !== "object" ? [] : [node, ...node.childNodes.flatMap(nodes), ...Object.values(node.slots).flatMap(nodes)];
const find = (tree, id) => nodes(tree).find(node => node.attributes.id === id);
const text = node => typeof node === "string" ? node : (node?.childNodes ?? []).map(text).join(" ");

function harness({ state = {}, target = session(), role, action = "trash", platform = "macos", response, context = {} } = {}) {
  const calls = [], tasks = [], queued = [], timers = [], closed = [], overlays = [], launches = [], running = [];
  let stopped = 0, notifications = 0, defer = false;
  const p = { target, role, action, overlay: "overlay-1", node: "/fixture/node", stores: { claude: ["/fixture/claude"] } };
  const cx = { notify() { notifications++; }, stop_propagation() { stopped++; }, focus_handle: () => ({ focus() {} }),
    spawn(task) { if (defer) queued.push(task); else tasks.push(task(cx)); },
    timer: { every(ms, callback) { timers.push({ ms, callback }); }, after(ms, callback) { timers.push({ ms, callback }); } } };
  const dependencies = { ...model, ...inboxModel, closeButton, agents: () => running, createTrashClient, View: class {}, div: element, svg: element, h_flex: element, v_flex: element,
    InputState: { new: () => ({ on() {}, value: () => "", focus() {} }) }, Input: { new: element }, providerIcon: (provider, size) => element().id(`provider-icon-${provider}`).size(size),
    Popover: { new: id => element().id(id) },
    theme: () => ({}), window: () => ({ platform }), appHome: () => "/fixture/herdr", props: () => p,
    focused: () => context.focus || ({ cwd: "/fixture/project" }), spaces: () => context.spaces || [], panes: () => context.panes || [], terminals: () => running,
    shared: key => state[key], setShared: (key, value) => { state[key] = value; },
    run: (...args) => launches.push(args), closeOverlay: id => closed.push(id), openOverlay: data => overlays.push(data),
    exec: async (program, args) => {
      calls.push({ program, args });
      if (response) return response(program, args, calls.length);
      const action = args[1];
      const data = action === "prepare" ? { row: target, files: ["projects/project/session.jsonl"] }
        : action === "scan" ? { rows: [session()], warnings: [], limited: false }
        : action === "validate" ? { row: target, command: "/fixture/claude-bin" }
        : action === "list" ? { entries: [entry()] } : action === "restore" ? { row: target } : { entry: target };
      return { code: 0, stdout: JSON.stringify(data) };
    },
    Toolbar: class { init() {} render() { return element().id("toolbar-role"); } },
    Footer: class { init() {} render() { return element().id("footer-role"); } },
    StatusBar: class { init() {} render() { return element().id("statusbar-role"); } },
    Quota: class { init() { this.initialized = true; } render() { return element().id("quota-preserved"); } refresh() {} },
  };
  dependencies.Preview = viewClass("preview", dependencies);
  dependencies.Inbox = viewClass("inbox", dependencies);
  dependencies.Rename = viewClass("rename", dependencies);
  dependencies.Actions = viewClass("actions", dependencies);
  dependencies.TrashDialog = viewClass("trash-dialog", dependencies);
  const Panel = viewClass("main", dependencies);
  return { ...dependencies, Panel, cx, p, state, target, calls, tasks, timers, closed, overlays, launches, running,
    stopped: () => stopped, notifications: () => notifications,
    defer(value) { defer = value; }, startQueued() { while (queued.length) tasks.push(queued.shift()(cx)); },
    flush() { for (;;) { const index = timers.findIndex(timer => timer.ms === 0); if (index < 0) break; timers.splice(index, 1)[0].callback(cx); } },
    async finish() { for (let index = 0; ; ) { this.flush(); if (index >= tasks.length) break; await tasks[index++]; } },
    panel() { const panel = new Panel(); panel.init(p, cx); return panel; },
    dialog() { const dialog = new dependencies.TrashDialog(); dialog.init(p, cx); return dialog; },
    menu() { const menu = new dependencies.Actions(); menu.init(p, cx); return menu; },
  };
}

test("right-click and overflow both open captured session actions, preserving Rename", async () => {
  const f = harness(), panel = f.panel(); await f.finish();
  const tree = panel.render(f.cx), row = panel.rows()[0];
  find(tree, `session-${row.key}`).events["on_mouse_down:right"]({}, f.cx);
  find(tree, `session-name-${row.key}`).events["on_click:"]({}, f.cx);
  assert.equal(f.overlays.length, 2); assert.equal(f.stopped(), 2);
  assert(f.overlays.every(value => value.props.role === "actions" && value.props.target.key === row.key));
  const menu = f.menu(); f.p.target.title = "Changed focus"; menu.choose(0);
  assert.equal(f.overlays[2].props.role, "rename"); assert.equal(f.overlays[2].props.target.title, "Original session");
  assert.equal(f.calls.length, 1);
});

test("live, remote and unsupported-platform menus disable Trash", () => {
  for (const options of [{ target: { ...session(), live: true } }, { target: { ...session(), remote: true } }, { platform: "linux" }]) {
    const f = harness(options), menu = f.menu();
    assert.equal(menu.items[1].disabled, true); menu.choose(1);
    assert.equal(f.overlays.length, 0); assert.equal(f.calls.length, 0);
    menu.render().events["on_key_down:"]({ key: "down" }, f.cx); assert.equal(menu.at, menu.items[2].disabled ? 0 : 2);
  }
});

test("menu opens a modal Trash confirmation with captured target and helper settings", () => {
  const f = harness(), menu = f.menu(); menu.choose(1);
  assert.equal(f.overlays[0].modal, true); assert.equal(f.overlays[0].props.action, "trash");
  assert.deepEqual(f.overlays[0].props.target, session()); assert.equal(f.overlays[0].props.node, f.p.node);
  assert.deepEqual(f.overlays[0].props.stores, f.p.stores); assert.equal(f.calls.length, 0);
});

test("confirmation previews only helper-returned files and preserves the captured identity", async () => {
  const f = harness(), dialog = f.dialog(); await f.finish();
  assert.match(text(dialog.render()), /projects\/project\/session.jsonl/);
  f.p.target.key = "changed-after-open"; dialog.submit(f.cx); await f.finish();
  assert.deepEqual(f.calls.map(call => call.args[1]), ["prepare", "trash"]);
  assert.equal(f.calls[1].args[3], session().key); assert.equal(f.calls[1].program, "/fixture/node");
  assert.deepEqual(JSON.parse(f.calls[1].args[2]), { stores: f.p.stores, stateDir: "/fixture/herdr/session-trash" });
  assert.equal(f.state[model.CHANGE_KEY], 1); assert.deepEqual(f.closed, ["overlay-1"]);
  assert.deepEqual(f.state[model.OPERATIONS], {});
});

test("prepare failures show Retry and never skip a successful preview before mutation", async () => {
  const f = harness({ response: async (_program, args, count) => count === 1
    ? { code: 1, stdout: JSON.stringify({ error: "Session metadata is unreadable" }) }
    : { code: 0, stdout: JSON.stringify({ row: session(), files: ["session.jsonl"] }) } });
  const dialog = f.dialog(); await f.finish();
  assert.match(dialog.error, /unreadable/); assert.equal(text(find(dialog.render(), "session-trash-confirm")), "Retry");
  dialog.submit(f.cx); await f.finish();
  assert.equal(dialog.ready, true); assert.deepEqual(f.calls.map(call => call.args[1]), ["prepare", "prepare"]);
  assert.equal(f.closed.length, 0);
});

test("Trash rechecks running and pending sessions after the confirmation was opened", async () => {
  for (const busy of ["live", "pending", "operation"]) {
    const f = harness(), dialog = f.dialog(); await f.finish();
    if (busy === "live") f.running.push({ state: "live", address: "t1", argv: ["claude", "--resume", id] });
    if (busy === "pending") f.state[model.PENDING] = { [session().key]: Date.now() };
    if (busy === "operation") f.state[model.OPERATIONS] = { [session().key]: { expires: Date.now() + 60000 } };
    dialog.submit(f.cx); await f.finish();
    assert(dialog.error); assert.deepEqual(f.calls.map(call => call.args[1]), ["prepare"]); assert.equal(f.closed.length, 0);
  }
});

test("queued mutations acquire the shared lock immediately and block resume", async () => {
  const f = harness(), panel = f.panel(), dialog = f.dialog(); await f.finish();
  f.defer(true); dialog.submit(f.cx); dialog.submit(f.cx); panel.open(session(), f.cx);
  assert.match(panel.error, /Another operation/); assert.equal(f.calls.length, 2);
  const key = dialog.render().events["on_key_down:"];
  key({ key: "escape" }, f.cx); key({ key: "enter" }, f.cx);
  find(dialog.render(), "session-trash-cancel").events["on_click:"]({}, f.cx);
  const titleClose = find(dialog.render(), "session-trash-close");
  assert.equal(titleClose.attributes.disabled, true);
  titleClose.events["on_click:"]({}, f.cx);
  assert.equal(f.closed.length, 0); assert.equal(f.stopped(), 3);
  f.startQueued(); await f.finish();
  assert.equal(f.calls.filter(call => call.args[1] === "trash").length, 1);
  assert.deepEqual(f.state[model.OPERATIONS], {}); assert.equal(f.launches.length, 0);
});

test("resume acquires the same shared lock before queued validation", async () => {
  const f = harness(), panel = f.panel(), dialog = f.dialog(); await f.finish();
  f.defer(true); panel.open(session(), f.cx); dialog.submit(f.cx);
  assert.match(dialog.error, /opening|Another operation/);
  assert.equal(f.state[model.OPERATIONS][session().key].action, "resume");
  f.startQueued(); await f.finish();
  assert.deepEqual(f.state[model.OPERATIONS], {}); assert.equal(f.launches.length, 1);
  assert.equal(f.calls.some(call => call.args[1] === "trash"), false);
});

test("failed mutations retain dialog, clear the shared lock, and can Retry", async () => {
  let fail = true;
  const f = harness({ target: entry(), action: "restore", response: async () => fail
    ? { code: 1, stdout: JSON.stringify({ error: "Destination already exists" }) }
    : { code: 0, stdout: JSON.stringify({ row: session() }) } });
  const dialog = f.dialog(); dialog.submit(f.cx); await f.finish();
  assert.match(dialog.error, /already exists/); assert.equal(dialog.busy, false);
  assert.equal(text(find(dialog.render(), "session-trash-confirm")), "Retry");
  assert.deepEqual(f.state[model.OPERATIONS], {}); assert.equal(f.state[model.CHANGE_KEY], undefined); assert.equal(f.closed.length, 0);
  fail = false; dialog.submit(f.cx); await f.finish();
  assert.equal(f.calls[1].args[3], entry().token); assert.equal(f.state[model.CHANGE_KEY], 1); assert.equal(f.closed.length, 1);
});

test("Trash list offers Restore confirmation, keeps Status, and reads only plugin history", async () => {
  const f = harness(), panel = f.panel(); await f.finish();
  find(panel.render(f.cx), "sessions-trash").events["on_click:"]({}, f.cx); await f.finish();
  assert(find(panel.render(f.cx), "sessions-trash-view"));
  find(panel.render(f.cx), `session-restore-${entry().token}`).events["on_click:"]({}, f.cx);
  assert.equal(f.overlays[0].props.action, "restore"); assert.equal(f.overlays[0].props.target.token, entry().token);
  assert.equal(f.calls[1].args[1], "list"); assert.equal(f.calls[1].args[0], "/fixture/herdr/mods/sessions-plus/trash.mjs");
  find(panel.render(f.cx), "sessions-page-status").events["on_click:"]({}, f.cx);
  assert(find(panel.render(f.cx), "quota-preserved"));
  assert(f.timers.some(timer => timer.ms === 300000));
});

test("successful mutation revision refreshes Sessions and Trash exactly once", async () => {
  const f = harness(), panel = f.panel(); await f.finish();
  panel.showingTrash = true;
  f.state[model.CHANGE_KEY] = 1;
  panel.render(f.cx); panel.render(f.cx); await f.finish(); panel.render(f.cx);
  assert.deepEqual(f.calls.map(call => call.args[1]), ["scan", "scan", "list"]);
});

test("unavailable Trash entries show their reason and cannot start restoration", async () => {
  const f = harness(), panel = f.panel(); await f.finish(); panel.showingTrash = true;
  for (const restorable of [false, undefined]) {
    const row = { ...entry(), restorable, location: "missing", message: "The Trash was emptied." };
    panel.trashEntries = [row];
    const tree = panel.render(f.cx);
    assert.match(text(tree), /The Trash was emptied/); assert.equal(find(tree, `session-restore-${row.token}`), undefined);
    panel.restoreRow(row); assert.equal(f.overlays.length, 0);
    const restore = harness({ target: row, action: "restore" }), dialog = restore.dialog();
    dialog.submit(restore.cx); await restore.finish(); assert.match(dialog.error, /Trash was emptied/); assert.equal(restore.calls.length, 0);
  }
});

test("recovery entries retain Restore and display the helper recovery message", async () => {
  const f = harness(), panel = f.panel(); await f.finish(); panel.showingTrash = true;
  const row = { ...entry(), status: "recovery", message: "Restore will finish the interrupted operation." }; panel.trashEntries = [row];
  const tree = panel.render(f.cx);
  assert.match(text(tree), /finish the interrupted operation/); assert(find(tree, `session-restore-${row.token}`));
});

test("invalid Trash lists surface Retry without breaking the Sessions view", async () => {
  const f = harness(), panel = f.panel(); await f.finish();
  panel.trashRead = createTrashClient(async () => ({ code: 0, stdout: JSON.stringify({ entries: null }) }), {}, "/fixture/herdr");
  panel.showingTrash = true; panel.refreshTrash(f.cx); await f.finish();
  assert.match(panel.trashError, /invalid list/); assert.equal(find(panel.render(f.cx), "sessions-trash-refresh").attributes.tooltip, "Retry refreshing Trash");
  panel.trashRead = async () => ({ entries: [entry()] }); panel.refreshTrash(f.cx); await f.finish();
  assert.equal(panel.trashError, ""); assert.equal(panel.trashEntries.length, 1);
});

test("Restore also blocks duplicate submits and busy Escape until helper completion", async () => {
  let resolve;
  const gate = new Promise(done => { resolve = done; });
  const f = harness({ target: entry(), action: "restore", response: async () => { await gate; return { code: 0, stdout: JSON.stringify({ row: session() }) }; } });
  const dialog = f.dialog(); dialog.submit(f.cx); dialog.submit(f.cx);
  dialog.render().events["on_key_down:"]({ key: "escape" }, f.cx);
  assert.equal(f.calls.length, 1); assert.equal(f.closed.length, 0); assert.equal(f.stopped(), 1);
  resolve(); await f.finish(); assert.equal(f.closed.length, 1); assert.deepEqual(f.state[model.OPERATIONS], {});
});

test("revision arriving during a scan queues one follow-up and no render loop", async () => {
  const f = harness(); f.defer(true); const panel = f.panel();
  f.state[model.CHANGE_KEY] = 1; panel.render(f.cx); panel.render(f.cx);
  f.flush(); assert.equal(panel.refreshQueued, true);
  f.defer(false); f.startQueued(); await f.finish(); panel.render(f.cx);
  assert.deepEqual(f.calls.map(call => call.args[1]), ["scan", "scan"]);
});

test("roles initialize once without creating the normal Sessions panel", async () => {
  for (const role of ["actions", "rename", "trash-dialog"]) {
    const f = harness({ role }), panel = f.panel(); await f.finish();
    assert(panel.role); assert.equal(panel.input, undefined); assert.equal(f.timers.length, 0);
    assert.deepEqual(f.calls.map(call => call.args[1]), role === "trash-dialog" ? ["prepare"] : []);
    assert(panel.render(f.cx));
  }
});

test("helper errors and malformed output are visible without executing shell commands", async () => {
  for (const result of [{ code: 1, stdout: JSON.stringify({ error: "Bundle is missing" }) }, { code: 0, stdout: "not-json" }]) {
    const calls = [];
    const read = createTrashClient(async (...args) => { calls.push(args); return result; }, { node: "/fixture/node" }, "/fixture/herdr");
    await assert.rejects(read("restore", "token '$()`"), /Bundle is missing|Node.js/);
    assert.equal(calls[0][1][3], "token '$()`"); assert.equal(calls[0][0], "/fixture/node");
  }
});


test("the integrated Sessions panel renders the list without legacy page tabs", async () => {
  const f = harness({ role: "sessions" }), panel = f.panel(); await f.finish();
  const tree = panel.render(f.cx);
  assert(find(tree, "sessions-list"));
  assert.equal(find(tree, "sessions-page-sessions"), undefined);
  assert.equal(find(tree, "sessions-page-status"), undefined);
});

for (const role of ["toolbar", "statusbar", "footer"]) {
  test(`the ${role} role does not initialize a separate history scanner`, () => {
    const f = harness({ role }), panel = f.panel();
    assert(find(panel.render(f.cx), `${role}-role`));
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.timers, []);
  });
}

test("Scope and Agent filters open real menus, then select directly without launching or mutating sessions", async () => {
  const f = harness({ role: "sessions" }), panel = f.panel(); await f.finish();
  panel.history = [session(), ...["codex", "agy"].map(provider => {
    const row = { ...session(), provider, title: `${provider} session`, cwd: provider === "codex" ? "/fixture/other" : "/fixture/project" };
    return { ...row, key: model.sessionKey(row) };
  })];
  const rowIds = () => nodes(find(panel.render(f.cx), "sessions-list")).filter(node => node.attributes.id?.startsWith("session-[")).map(node => node.attributes.id);
  const open = id => find(panel.render(f.cx), `${id}-popover`).events["on_open_change:"](true, f.cx);
  const choose = (id, value) => find(panel.render(f.cx), `${id}-option-${value}`).events["on_click:"]({}, f.cx);
  assert.equal(rowIds().length, 2);
  let tree = panel.render(f.cx), scope = find(tree, "sessions-scope-popover"), agents = find(tree, "sessions-provider-popover");
  assert.match(text(scope.slots.trigger), /This folder.*▾/);
  assert.match(text(agents.slots.trigger), /All agents.*▾/);
  assert.equal(scope.attributes.anchor, "top_left");
  assert.equal(scope.slots.trigger.events["on_click:"], undefined);
  assert.match(text(find(tree, "sessions-scope-option-current")), /✓.*This folder/);
  for (const [provider, label] of Object.entries(model.PROVIDERS)) {
    const option = find(tree, `sessions-provider-option-${provider}`);
    assert.match(text(option), new RegExp(label));
    assert(find(option, `provider-icon-${provider}`));
  }
  panel.visible = 180;
  open("sessions-scope");
  assert.equal(panel.all, false);
  assert.equal(panel.visible, 180);
  assert.equal(rowIds().length, 2);
  assert.equal(find(panel.render(f.cx), "sessions-scope-popover").attributes.open, true);
  choose("sessions-scope", "all");
  assert.equal(panel.all, true);
  assert.equal(panel.visible, 60);
  assert.equal(panel.filterMenu, null);
  assert.equal(rowIds().length, 3);
  open("sessions-provider");
  assert.equal(panel.provider, "all");
  choose("sessions-provider", "agy");
  assert.equal(panel.provider, "agy");
  assert.equal(panel.filterMenu, null);
  assert.deepEqual(rowIds(), [`session-${panel.history[2].key}`]);
  tree = panel.render(f.cx);
  assert.match(text(find(tree, "sessions-provider-option-agy")), new RegExp(`✓.*${model.PROVIDERS.agy}`));
  assert.doesNotMatch(text(find(tree, "sessions-provider-option-all")), /✓/);
  assert(find(find(tree, "sessions-provider"), "provider-icon-agy"));
  open("sessions-provider"); choose("sessions-provider", "codex");
  assert.deepEqual(rowIds(), [`session-${panel.history[1].key}`]);
  open("sessions-provider"); choose("sessions-provider", "all");
  open("sessions-scope"); choose("sessions-scope", "current");
  assert.equal(rowIds().length, 2);
  assert.deepEqual(f.calls.map(call => call.args[1]), ["scan"]);
  assert.deepEqual(f.launches, []);
  assert.deepEqual(f.overlays, []);
  assert.deepEqual(f.state, {});
  for (const id of ["sessions-scope", "sessions-provider"]) {
    const popover = find(panel.render(f.cx), `${id}-popover`);
    for (const style of ["w_full", "size_full", "w", "h", "bg"]) assert.equal(popover.attributes[style], undefined);
  }
});

test("only one filter menu stays open and a late close event cannot close the other menu", async () => {
  const f = harness({ role: "sessions" }), panel = f.panel(); await f.finish();
  const scope = find(panel.render(f.cx), "sessions-scope-popover").events["on_open_change:"];
  scope(true, f.cx);
  const provider = find(panel.render(f.cx), "sessions-provider-popover").events["on_open_change:"];
  provider(true, f.cx);
  scope(false, f.cx);
  assert.equal(panel.filterMenu, "sessions-provider");
  const tree = panel.render(f.cx);
  assert.equal(find(tree, "sessions-scope-popover").attributes.open, false);
  assert.equal(find(tree, "sessions-provider-popover").attributes.open, true);
  provider(false, f.cx);
  assert.equal(panel.filterMenu, null);
  assert.equal(panel.provider, "all");
  assert.equal(panel.all, false);
  assert.deepEqual(f.calls.map(call => call.args[1]), ["scan"]);
});

test("filter menus support keyboard selection while retaining the query and scan lifecycle", async () => {
  const f = harness({ role: "sessions" }), panel = f.panel(); await f.finish();
  panel.query = "keep my search";
  panel.visible = 120;
  find(panel.render(f.cx), "sessions-provider-popover").events["on_open_change:"](true, f.cx);
  let key = find(panel.render(f.cx), "sessions-provider-menu").events["on_key_down:"];
  key({ key: "down" }, f.cx); key({ key: "ArrowDown" }, f.cx);
  assert.equal(panel.provider, "all");
  key({ key: "enter" }, f.cx);
  assert.equal(panel.provider, "codex");
  assert.equal(panel.filterMenu, null);
  assert.equal(panel.visible, 60);
  assert.equal(panel.query, "keep my search");
  find(panel.render(f.cx), "sessions-scope-popover").events["on_open_change:"](true, f.cx);
  key = find(panel.render(f.cx), "sessions-scope-menu").events["on_key_down:"];
  key({ key: "up" }, f.cx); key({ key: "Enter" }, f.cx);
  assert.equal(panel.all, true);
  assert.deepEqual(f.calls.map(call => call.args[1]), ["scan"]);
  assert.deepEqual(f.launches, []);
  assert.deepEqual(f.overlays, []);
  assert(f.timers.some(timer => timer.ms === 30000));
});


for (const stage of ["prepare", "trash"]) {
  test(`a session removed before ${stage} closes the stale dialog and refreshes its list`, async () => {
    let missing = false;
    const f = harness({ response: async (_program, args) => {
      const action = args[1];
      if (action === stage) { missing = true; return { code: 1, stdout: JSON.stringify({ code: "SESSION_MISSING", error: "Session no longer exists" }) }; }
      return { code: 0, stdout: JSON.stringify(action === "scan" ? { rows: missing ? [] : [session()], warnings: [], limited: false } : { row: session(), files: ["session.jsonl"] }) };
    } });
    const panel = f.panel(); await f.finish(); assert.equal(panel.history.length, 1);
    const dialog = f.dialog(); await f.finish();
    if (stage === "trash") { dialog.submit(f.cx); await f.finish(); }
    assert.equal(f.state[model.CHANGE_KEY], 1); assert.deepEqual(f.closed, ["overlay-1"]);
    panel.render(f.cx); await f.finish(); assert.deepEqual(panel.history, []);
    assert.equal(f.calls.filter(call => call.args[1] === "trash").length, stage === "trash" ? 1 : 0);
    assert(!f.state[model.OPERATIONS]?.[session().key]);
  });
}

test("a missing restore payload stays visible as an error instead of claiming success", async () => {
  const f = harness({ target: entry(), action: "restore", response: async () => ({ code: 1, stdout: JSON.stringify({ code: "SESSION_MISSING", error: "Payload missing" }) }) });
  const dialog = f.dialog(); dialog.submit(f.cx); await f.finish();
  assert.match(dialog.error, /Payload missing/); assert.equal(f.closed.length, 0); assert.equal(f.state[model.CHANGE_KEY], undefined);
});

test("Trash uses an accessible icon and refresh removes externally emptied entries", async () => {
  const f = harness(), panel = f.panel(); await f.finish();
  const button = find(panel.render(f.cx), "sessions-trash");
  assert.equal(text(button), ""); assert.equal(button.attributes.tooltip, "Session Trash"); assert.equal(button.attributes.accessibility_label, "Session Trash");
  button.events["on_click:"]({}, f.cx); await f.finish(); assert.equal(panel.trashEntries.length, 1);
  panel.trashRead = async () => ({ entries: [] }); panel.refreshTrash(f.cx); await f.finish();
  assert.deepEqual(panel.trashEntries, []); assert.match(text(panel.render(f.cx)), /No sessions in Trash/);
});


test("history changes defer notifications beyond render and leave manual refresh usable", async () => {
  const f = harness(), panel = f.panel(); await f.finish();
  const renderContext = { ...f.cx, notify() { throw new Error("Herdr forbids notify during render"); }, spawn() { throw new Error("The refresh must start after render"); } };
  panel.showingTrash = true; f.state[model.CHANGE_KEY] = 1;
  assert.doesNotThrow(() => { panel.render(renderContext); panel.render(renderContext); });
  assert.equal(panel.loading, false); assert.equal(panel.trashLoading, false);
  await f.finish();
  assert.deepEqual(f.calls.map(call => call.args[1]), ["scan", "scan", "list"]);
  assert.equal(panel.loading, false); assert.equal(panel.trashLoading, false);
  panel.showingTrash = false;
  const refresh = find(panel.render(f.cx), "sessions-refresh");
  assert.equal(text(refresh), ""); assert.equal(refresh.attributes.accessibility_label, "Refresh sessions");
  refresh.events["on_click:"]({}, f.cx); await f.finish(); assert.equal(f.calls.filter(call => call.args[1] === "scan").length, 3);
});


test("source filtering uses metadata and preserves search, date groups, and short identities", async () => {
  const f = harness(), panel = f.panel(); await f.finish();
  const now = Date.now();
  panel.history = [{ ...session(), title: "Guardian review", origin: "main", updated: now }, { ...session(), key: "automated", id: "22222222-2222-4222-8222-222222222222", title: "Unrelated label", origin: "review", updated: now }];
  panel.source = "main";
  let tree = panel.render(f.cx);
  assert(find(tree, `session-${session().key}`)); assert(!find(tree, "session-automated"));
  assert.match(text(tree), /Today/); assert.match(text(tree), /Updated just now · 11111111/);
  panel.source = "review"; panel.query = "Unrelated"; tree = panel.render(f.cx);
  assert(find(tree, "session-automated")); assert(!find(tree, `session-${session().key}`));
  panel.query = "no match"; assert.match(text(panel.render(f.cx)), /No sessions here/);
});

test("message preview is requested only after opening its action and never resumes a session", async () => {
  const f = harness(); const panel = f.panel(); await f.finish();
  panel.render(f.cx); assert.deepEqual(f.calls.map(call => call.args[1]), ["scan"]);
  const menu = f.menu(); menu.choose(2);
  assert.equal(f.overlays.at(-1).props.role, "preview"); assert.equal(f.calls.length, 1);
  const g = harness({ role: "preview", response: async (_program, args) => ({ code: 0, stdout: JSON.stringify({ row: session(), available: true, limited: false, messages: [{ role: "user", text: "Fictional latest question" }, { role: "assistant", text: "Fictional latest answer" }] }) }) });
  const preview = g.panel(); await g.finish();
  assert.deepEqual(g.calls.map(call => call.args[1]), ["preview"]); assert.match(text(preview.render(g.cx)), /Fictional latest answer/); assert.equal(g.launches.length, 0);
});

test("preview failures remain retryable and Antigravity's unsupported body is explicit", async () => {
  let fail = true;
  const f = harness({ role: "preview", response: async () => fail ? { code: 1, stdout: JSON.stringify({ error: "History changed" }) } : { code: 0, stdout: JSON.stringify({ row: session(), available: false, messages: [], message: "Antigravity message preview is unavailable." }) } });
  const panel = f.panel(); await f.finish(); assert.match(text(panel.render(f.cx)), /History changed/);
  fail = false; find(panel.render(f.cx), "preview-retry").events["on_click:"]({}, f.cx); await f.finish();
  assert.match(text(panel.render(f.cx)), /Antigravity message preview is unavailable/);
  assert.equal(f.launches.length, 0);
});

test("Inbox groups real statuses, dismisses only the current update, and new work returns", async () => {
  const f = harness({ role: "inbox" });
  f.running.push({ address: "t1", status: "blocked", seq: 1, title: "Needs a decision" }, { address: "t2", status: "done", seq: 2, title: "Completed" }, { address: "t3", status: "working", seq: 3, title: "Working now" }, { address: "t4", status: "idle", seq: 4 });
  const panel = f.panel(); let tree = panel.render(f.cx);
  assert.match(text(tree), /Needs you · 1/); assert.match(text(tree), /Finished · 1/); assert.match(text(tree), /Working · 1/);
  find(tree, "inbox-dismiss-t1").events["on_click:"]({}, f.cx);
  assert(!find(panel.render(f.cx), "inbox-t1")); assert.equal(f.launches.length, 0);
  f.running[0].seq = 5; assert(find(panel.render(f.cx), "inbox-t1"));
  const content = find(panel.render(f.cx), "inbox-t1").childNodes[0]; content.events["on_click:"]({}, f.cx);
  assert.deepEqual(f.launches, [["agent.focus", { terminal: "t1" }]]); assert.deepEqual(f.closed, ["overlay-1"]); assert.equal(f.calls.length, 0);
});


test("This folder stays on a center file preview's project and ignores a replaced pane", async () => {
  const context = { focus: { tab: "preview-tab", pane: "preview-pane", cwd: null }, spaces: [{ id: "space", active: true, folder: "/different" }], panes: [{ tab: "preview-tab", pane: "preview-pane", mod: "files-plus", terminal: null }] };
  const state = { "files-plus.file-tabs.v1": { tabs: { "preview-tab": { tab: "preview-tab", pane: "preview-pane", space: "space", root: "/fixture/project", path: "readme.md", on: null } } } };
  const f = harness({ role: "sessions", state, context }), panel = f.panel(); await f.finish();
  const count = () => nodes(find(panel.render(f.cx), "sessions-list")).filter(node => node.attributes.id?.startsWith("session-[")).length;
  assert.equal(count(), 1);
  context.panes[0].mod = "unrelated";
  assert.equal(count(), 0);
});
