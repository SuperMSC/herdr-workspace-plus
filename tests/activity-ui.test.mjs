import { uiFunction } from "./helpers/ui-function.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as model from "../mods/sessions-plus/activity-model.js";
const id = "11111111-2222-4333-8444-555555555555", target = { provider: "claude", store: "/fixture/store", id, title: "Literal 'quoted' $(never)", key: JSON.stringify(["claude", "/fixture/store", id]) };
const event = n => ({ id: `${n}:0`, kind: "tool", title: `Read file ${n} ` + "title".repeat(25), text: `Literal 'quoted' $(never) ${n}\n` + "evidence ".repeat(250), files: Array.from({ length: 8 }, (_, i) => "/fixture/" + String(i) + "/" + "p".repeat(280)), timestamp: 1794358923000, durationMs: n % 2 ? null : 1234 });
const image = n => { const sha = n.toString(16).padStart(64, "0"); return { id: sha, ext: "png", image: `data/session-gallery/${sha}.png`, path: `/fixture/image 'quoted' $(never) ${n}.png`, width: 800, height: 600, bytes: 1200, timestamp: 1794358923000, cached: false, label: "Recorded local attachment" }; };
const page = (mode, n = 1, next = n < 3 ? `cursor-${n}` : null) => ({ key: target.key, mode, available: true, events: mode === "timeline" ? Array.from({ length: 20 }, (_, i) => event((n - 1) * 20 + i + 1)) : [], images: mode === "gallery" ? Array.from({ length: 12 }, (_, i) => image((n - 1) * 12 + i + 1)) : [], warnings: [], next, page: n });
function element() {
  const state = { childNodes: [], attrs: {}, events: {} }, proxy = new Proxy(state, { get(o, key) {
    if (key === "child") return value => { o.childNodes.push(value); return proxy; };
    if (key === "children") return values => { o.childNodes.push(...values); return proxy; };
    if (key === "when") return (condition, action) => condition ? action(proxy) : proxy;
    if (String(key).startsWith("on_")) return (...args) => { o.events[key] = args.at(-1); return proxy; };
    if (key in o) return o[key]; return value => { o.attrs[key] = value; return proxy; };
  } }); return proxy;
}
const nodes = node => !node || typeof node !== "object" ? [] : [node, ...node.childNodes.flatMap(nodes)];
const text = node => typeof node === "string" ? node : node?.childNodes?.map(text).join("\n") || "";
function harness(mode, read = async (_mode, _target, cursor) => page(mode, cursor ? Number(cursor.split("-")[1]) + 1 : 1)) {
  const tasks = [], calls = [], overlays = [], copied = []; let rendering = false;
  const cx = { focus_handle: () => ({ focus() {} }), notify() { assert(!rendering, "render must not mutate state"); }, stop_propagation() {}, write_to_clipboard: value => copied.push(value), spawn(action) { tasks.push(action(cx)); }, timer: { every() { throw new Error("Activity must not poll"); }, after() { throw new Error("Activity must not schedule reads"); } } };
  const deps = { ...model, div: element, image: element, v_flex: element, h_flex: element, appHome: () => "/fixture/app", exec() { throw new Error("No real commands in UI fixtures"); }, theme: () => ({}), openOverlay: spec => overlays.push(spec), closeOverlay() {}, createActivityClient: () => async (...args) => { assert(!rendering); calls.push(args); return read(...args); } };
  const source = readFileSync(new URL(`../mods/sessions-plus/${mode === "timeline" ? "timeline" : "gallery"}.js`, import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class");
  const Role = uiFunction(...Object.keys(deps), source)(...Object.values(deps)); const view = new Role(), props = { target: { ...target } }; view.init(props, cx);
  return { view, props, cx, tasks, calls, overlays, copied, async settle() { for (let i = 0; i < 10 && tasks.length; i++) await Promise.all(tasks.splice(0)); }, render() { rendering = true; try { return view.render(); } finally { rendering = false; } }, click(id) { const node = nodes(this.render()).find(node => node.attrs.id === id); assert(node, id); node.events.on_click({}, cx); } };
}

test("production timeline renders one 20-event page, clips previews, and copies only explicit full evidence", async () => {
  const f = harness("timeline"); await f.settle(); const tree = f.render(); f.render(); assert.equal(f.calls.length, 1); assert.equal(f.view.events.length, 20);
  assert.equal(nodes(tree).filter(node => /^timeline-\d+:/.test(node.attrs.id || "")).length, 20); assert(!text(tree).includes(event(1).text));
  f.click("timeline-detail-1:0"); assert(text(f.render()).includes(event(1).text)); f.click("timeline-detail-copy"); assert(f.copied[0].includes(event(1).text)); assert(f.copied[0].includes("not proof of a successful edit"));
  f.click("timeline-detail-queue"); assert.equal(f.overlays[0].props.role, "prompt-queue"); assert.equal(f.overlays[0].props.on, null); assert(f.overlays[0].props.text.includes("$(never)"));
  f.click("timeline-detail-back"); f.click("timeline-older"); await f.settle(); assert.equal(f.view.events.length, 20); assert.equal(f.view.events[0].id, "21:0"); assert.equal(f.view.pages.length, 2);
  f.click("timeline-newer"); assert.equal(f.view.events[0].id, "1:0"); f.click("timeline-older"); await f.settle(); assert.equal(f.calls.length, 2, "cached pages are reused without another read");
});

test("production gallery keeps 12 cards per page, explicit image actions, and bounded zoom", async () => {
  const f = harness("gallery"); await f.settle(); assert.equal(nodes(f.render()).filter(node => /^gallery-image-/.test(node.attrs.id || "")).length, 12); f.render(); assert.equal(f.calls.length, 1);
  f.click(`gallery-copy-${image(1).id}`); assert.equal(f.copied[0], image(1).path); f.click(`gallery-queue-${image(1).id}`); assert.equal(f.overlays.length, 1); assert.equal(f.overlays[0].props.role, "prompt-queue"); assert.equal(f.overlays[0].props.on, null); assert(f.overlays[0].props.text.includes("file may have changed"));
  f.click("gallery-older"); await f.settle(); assert.equal(f.view.images.length, 12); assert.equal(f.view.images[0].id, image(13).id); f.click("gallery-newer"); assert.equal(f.view.images[0].id, image(1).id);
  const card = nodes(f.render()).find(node => node.attrs.id === `gallery-image-${image(1).id}`); nodes(card).find(node => node.events.on_click).events.on_click({}, f.cx); assert(f.view.selected);
  for (let i = 0; i < 20; i++) f.click("gallery-zoom-in"); assert.equal(f.view.scale, 3); for (let i = 0; i < 20; i++) f.click("gallery-zoom-out"); assert.equal(f.view.scale, .125);
});

for (const mode of ["timeline", "gallery"]) test(`production ${mode} retains failed pages as stale and preserves captured identity`, async () => {
  let fail = false; const f = harness(mode, async () => { if (fail) throw new Error("Transcript changed; refresh required"); return page(mode); }); await f.settle();
  const before = mode === "timeline" ? f.view.events : f.view.images; f.props.target.store = "/wrong/focused"; f.props.target.id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"; fail = true;
  f.click(`${mode}-refresh`); await f.settle(); assert(f.view.stale); assert.equal(mode === "timeline" ? f.view.events : f.view.images, before); assert.match(f.view.error, /changed/); assert(f.calls.every(call => call[1].key === target.key));
});

for (const mode of ["timeline", "gallery"]) test(`production ${mode} fences closed async work and rejects remote identities`, async () => {
  let finish; const f = harness(mode, () => new Promise(resolve => { finish = resolve; })); f.view.close(); finish(page(mode)); await f.settle(); assert.equal(f.view.pages.length, 0);
  const g = harness(mode); await g.settle(); assert.throws(() => model.activityTarget({ ...target, remote: true }));
});

for (const mode of ["timeline", "gallery"]) test(`production ${mode} moves fixed guidance to Refresh while retaining page counts and warnings`, async () => {
  const f = harness(mode); await f.settle();
  let tree = f.render(), refresh = nodes(tree).find(node => node.attrs.id === `${mode}-refresh`);
  assert.match(refresh.attrs.tooltip, mode === "timeline" ? /Read only · latest first/ : /Local records only · cache ≤24h \/ 32 MiB/);
  assert.doesNotMatch(text(tree), /Read only · latest first|Local records only|remote URLs are never fetched|no generated summary/);
  assert.match(text(tree), /Page 1\/20/);
  if (mode === "gallery") assert.match(text(tree), /12\/12 images/);
  f.view.warnings = ["A recorded item was too large to display."];
  tree = f.render(); assert.match(text(tree), /A recorded item was too large/);
});

test("response metadata rejects unsafe dimensions, absurd dates, malformed rich fields and page limits", () => {
  assert.equal(model.activityTime(1e30), null); const good = page("timeline"); model.activityPage(good, target, "timeline");
  for (const value of [{ ...good, page: 21 }, { ...good, events: [...good.events, event(90)] }, { ...good, events: [{ ...event(1), files: [5] }] }, { ...good, events: [{ ...event(1), timestamp: 1e30 }] }, { ...good, warnings: [42] }]) assert.throws(() => model.activityPage(value, target, "timeline"));
  const gallery = page("gallery"); model.activityPage(gallery, target, "gallery"); assert.throws(() => model.activityPage({ ...gallery, images: gallery.images.map(item => ({ ...item, width: 4000, height: 3000 })) }, target, "gallery"), /budget/);
});
