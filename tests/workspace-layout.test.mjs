import assert from "node:assert/strict";
import test from "node:test";
import { integrateWorkspace } from "../workspace-layout.mjs";

function fixture() {
  return {
    id: "root", type: "row", titlebar: "none", traffic_lights: [12, 16], background: "canvas", custom: { preserve: true },
    children: [
      { id: "sidebar", type: "column", size: { px: 268 }, children: [{ id: "spaces", type: "block", content: { mod: "spaces" } }] },
      { id: "work", type: "column", resizable: false, children: [
        { id: "tabs", type: "block", size: { px: 42 }, window_drag: true, background: "chrome", content: { mod: "tabs", props: { native: true }, title: "Original tabs" } },
        { id: "work-body", type: "row", padding: 8, gap: 8, children: [
          { id: "main", type: "block", content: { tab: "active", pane: { radius: 10 } } },
          { id: "panel", type: "column", hidden: false, size: { px: 368 }, min: 280, max: 900, children: [
            { id: "panel-body", type: "stack", active: "changes", size: { weight: 1 }, min: 180, children: [
              { id: "files", type: "block", content: { mod: "files-plus", props: { mySetting: 1 } } },
              { id: "changes", type: "block", content: { mod: "files-plus", props: { role: "changes" } } },
            ] },
            { id: "files-plus-sessions", type: "block", size: { weight: 1 }, min: 200, background: "surface", content: { mod: "sessions-plus", title: "My Sessions", props: { node: "/custom/node", stores: { codex: "/custom/store" }, custom: true } } },
          ] },
        ] },
        { id: "status", type: "block", size: { px: 28 }, padding: [0, 2], content: { mod: "workspace-status", props: { native: true } } },
      ] },
    ],
  };
}

function find(node, id) {
  if (node.id === id) return node;
  for (const child of node.children ?? []) { const found = find(child, id); if (found) return found; }
  return null;
}

function parentOf(root, id) {
  for (const child of root.children ?? []) {
    if (child.id === id) return root;
    const found = parentOf(child, id); if (found) return found;
  }
  return null;
}

function everyNode(node) {
  return [node, ...(node.children ?? []).flatMap(everyNode)];
}

test("moves the existing Sessions block into the panel stack and adds header/footer roles", () => {
  const source = fixture(), original = structuredClone(source);
  const { layout, changed, integrated } = integrateWorkspace(source);
  assert.equal(changed, true);
  assert.equal(integrated, true);
  assert.deepEqual(source, original);
  const panel = find(layout, "panel"), body = find(layout, "panel-body"), session = find(layout, "files-plus-sessions");
  assert.deepEqual(panel.children.map(node => node.id), ["panel-body"]);
  assert.deepEqual(body.children.map(node => node.id), ["files", "changes", "files-plus-sessions"]);
  assert.equal(body.active, "changes");
  assert.deepEqual(session, { ...find(original, "files-plus-sessions"), content: { ...find(original, "files-plus-sessions").content, props: { ...find(original, "files-plus-sessions").content.props, role: "sessions" } } });
  const header = parentOf(layout, "tabs"), footer = find(layout, "status");
  assert.equal(header.type, "row");
  assert.equal(header.children[0].id, "tabs");
  assert.equal(footer.id, "status");
  assert.equal(header.children[0].type, "block");
  assert.equal(header.children[0].window_drag, undefined);
  assert.deepEqual(header.size, { px: 42 });
  assert.equal(header.window_drag, true);
  assert.equal(header.resizable, false);
  assert.equal(header.divider.width, 0);
  assert.deepEqual(header.children[0].content, find(original, "tabs").content);
  assert.deepEqual(header.children[0].size, { weight: 1 });
  assert.deepEqual(header.children[1].size, { px: 102 });
  assert.deepEqual(header.children[1].content.props, { ...find(original, "files-plus-sessions").content.props, role: "toolbar", panel: "panel", stack: "panel-body", child: "files-plus-sessions" });
  assert.equal(footer.type, "block");
  assert.deepEqual(footer.size, { px: 28 });
  assert.deepEqual(footer.padding, [0, 2]);
  assert.equal(footer.content.mod, "sessions-plus");
  assert.deepEqual(footer.content.props, { native: true, ...find(original, "files-plus-sessions").content.props, role: "footer" });
  assert.equal(footer.children, undefined);
});

test("preserves all unrelated layout content and old node IDs/properties", () => {
  const source = fixture();
  find(source, "panel").children.push({ id: "custom-panel-footer", type: "block", content: { mod: "my-help" } });
  find(source, "panel-body").children.push({ id: "custom-panel", type: "block", content: { mod: "my-inspector" } });
  const { layout } = integrateWorkspace(source);
  for (const id of ["sidebar", "main", "files", "changes", "custom-panel", "custom-panel-footer"]) assert.deepEqual(find(layout, id), find(source, id));
  for (const id of ["panel", "panel-body", "tabs", "status"]) {
    for (const [key, value] of Object.entries(find(source, id))) {
      if (!["id", "type", "children", "content", "resizable", "divider"].includes(key)) assert.deepEqual((id === "tabs" ? parentOf(layout, id) : find(layout, id))[key], value, `${id}.${key}`);
    }
  }
  assert.deepEqual(layout.custom, source.custom);
  assert.deepEqual(layout.traffic_lights, source.traffic_lights);
  assert.deepEqual(find(layout, "panel").children.map(node => node.id), ["panel-body", "custom-panel-footer"]);
});

test("integration is idempotent and preserves subsequent user sizing", () => {
  const first = integrateWorkspace(fixture()).layout;
  parentOf(first, "tabs").children[1].size.px = 120;
  find(first, "status").size.px = 32;
  find(first, "panel-body").active = "files-plus-sessions";
  const again = integrateWorkspace(first);
  assert.equal(again.integrated, true);
  assert.equal(again.changed, false);
  assert.deepEqual(again.layout, first);
  assert.notEqual(again.layout, first);
});

test("generated IDs avoid collisions anywhere in the layout", () => {
  const source = fixture();
  const names = ["workspace-plus-toolbar", "workspace-plus-toolbar-1", "workspace-plus-footer", "workspace-plus-sessions-button", "workspace-plus-quota"];
  source.children[0].children.push(...names.map(id => ({ id, type: "block", content: { mod: "custom" } })));
  const { layout } = integrateWorkspace(source);
  const ids = everyNode(layout).map(node => node.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(parentOf(layout, "tabs").id, "workspace-plus-toolbar-2");
  for (const id of names) assert.deepEqual(find(layout, id), find(source, id));
});

test("keeps the actual Sessions ID and forwards default props when none were set", () => {
  const source = fixture(), session = find(source, "files-plus-sessions");
  session.id = "my-session-panel";
  delete session.content.props;
  const { layout } = integrateWorkspace(source);
  assert.equal(parentOf(layout, "tabs").children[1].content.props.child, "my-session-panel");
  assert.deepEqual(find(layout, "my-session-panel").content.props, { role: "sessions" });
  assert.deepEqual(find(layout, "status").content.props, { native: true, role: "footer" });
});

test("supports an existing Sessions stack child without duplicating it", () => {
  const source = fixture(), panel = find(source, "panel"), body = find(source, "panel-body");
  const session = panel.children.pop();
  body.children.push(session);
  const result = integrateWorkspace(source);
  assert.equal(result.integrated, true);
  assert.equal(everyNode(result.layout).filter(node => node.id === session.id).length, 1);
  assert.equal(find(result.layout, session.id).content.props.role, "sessions");
});

for (const missing of ["tabs", "status", "panel", "panel-body", "files-plus-sessions"]) {
  test(`missing known structure returns an untouched copy: ${missing}`, () => {
    const source = fixture();
    find(source, missing).id = "different-id";
    if (missing === "files-plus-sessions") find(source, "different-id").content.mod = "different-mod";
    const before = structuredClone(source), result = integrateWorkspace(source);
    assert.equal(result.integrated, false);
    assert.equal(result.changed, false);
    assert.deepEqual(result.layout, before);
    assert.deepEqual(source, before);
  });
}

test("unknown header/footer implementations are not replaced", () => {
  for (const id of ["tabs", "status"]) {
    const source = fixture();
    find(source, id).content.mod = "custom-toolbar";
    const result = integrateWorkspace(source);
    assert.equal(result.integrated, false);
    assert.deepEqual(result.layout, source);
  }
});

test("ambiguous sessions, duplicate structural IDs, or malformed session props leave layout unchanged", () => {
  for (const change of [
    source => find(source, "panel-body").children.push({ id: "another-session", type: "block", content: { mod: "sessions-plus" } }),
    source => source.children.push({ id: "tabs", type: "block", content: { mod: "tabs" } }),
    source => { find(source, "files-plus-sessions").content.props = []; },
  ]) {
    const source = fixture(); change(source);
    const result = integrateWorkspace(source);
    assert.equal(result.integrated, false);
    assert.equal(result.changed, false);
    assert.deepEqual(result.layout, source);
  }
});

test("an already integrated toolbar targeting other nodes is not rewritten", () => {
  const source = integrateWorkspace(fixture()).layout;
  parentOf(source, "tabs").children[1].content.props.child = "some-other-session";
  const result = integrateWorkspace(source);
  assert.equal(result.integrated, false);
  assert.equal(result.changed, false);
  assert.deepEqual(result.layout, source);
});

test("custom standalone and non-layout values are returned unchanged", () => {
  for (const source of [null, [], {}, { id: "my-files", type: "block", content: { mod: "files-plus" } }]) {
    const result = integrateWorkspace(source);
    assert.equal(result.integrated, false);
    assert.equal(result.changed, false);
    assert.deepEqual(result.layout, source);
  }
});

function splitFooterFixture({ extra = false } = {}) {
  const source = integrateWorkspace(fixture()).layout;
  const status = find(source, "status"), parent = parentOf(source, "status");
  const native = { id: "status", type: "block", size: { weight: 1 }, min: 0, content: { mod: "workspace-status", props: { native: true } } };
  const quota = { id: "workspace-plus-quota", type: "block", size: { px: 710 }, min: 180,
    content: { mod: "sessions-plus", props: { ...status.content.props, role: "statusbar", node: "/quota-specific/node", quotaSetting: true } } };
  const wrapper = { id: "workspace-plus-footer", type: "row", size: { px: 34 }, min: 29, padding: [0, 4], background: "chrome",
    border: { width: 2, color: "border" }, customOuter: { preserve: true }, resizable: false, divider: { width: 0 }, children: [native, quota] };
  if (extra) wrapper.children.push({ id: "custom-footer-block", type: "block", size: { px: 77 }, content: { mod: "user-status" } });
  parent.children[parent.children.indexOf(status)] = wrapper;
  return source;
}

test("the previous split footer collapses to the original status ID and preserves outer sizing and quota props", () => {
  const source = splitFooterFixture(), before = structuredClone(source);
  const result = integrateWorkspace(source);
  assert.equal(result.integrated, true);
  assert.equal(result.changed, true);
  assert.deepEqual(source, before);
  const status = find(result.layout, "status");
  assert.equal(status.type, "block");
  assert.equal(status.content.mod, "sessions-plus");
  assert.equal(status.content.props.role, "footer");
  assert.equal(status.content.props.node, "/quota-specific/node");
  assert.deepEqual(status.content.props.stores, { codex: "/custom/store" });
  assert.equal(status.content.props.quotaSetting, true);
  assert.equal(status.content.props.native, true);
  assert.deepEqual(status.size, { px: 34 });
  assert.equal(status.min, 29);
  assert.deepEqual(status.padding, [0, 4]);
  assert.deepEqual(status.border, { width: 2, color: "border" });
  assert.deepEqual(status.customOuter, { preserve: true });
  assert.equal(parentOf(result.layout, "status").id, "work");
  assert.equal(find(result.layout, "workspace-plus-footer"), null);
  assert.equal(find(result.layout, "workspace-plus-quota"), null);
  assert.equal(integrateWorkspace(result.layout).changed, false);
});

test("a split footer with unrelated user blocks preserves them and removes only the old quota slot", () => {
  const source = splitFooterFixture({ extra: true }), before = structuredClone(source);
  const result = integrateWorkspace(source);
  assert.equal(result.integrated, true);
  assert.equal(result.changed, true);
  const wrapper = find(result.layout, "workspace-plus-footer"), status = find(result.layout, "status");
  assert.deepEqual(wrapper.children.map(node => node.id), ["status", "custom-footer-block"]);
  assert.deepEqual(find(result.layout, "custom-footer-block"), find(before, "custom-footer-block"));
  assert.deepEqual(wrapper.size, find(before, "workspace-plus-footer").size);
  assert.deepEqual(wrapper.customOuter, find(before, "workspace-plus-footer").customOuter);
  assert.deepEqual(status.size, { weight: 1 });
  assert.equal(status.content.props.role, "footer");
  assert.equal(find(result.layout, "workspace-plus-quota"), null);
  const again = integrateWorkspace(result.layout);
  assert.equal(again.integrated, true);
  assert.equal(again.changed, false);
  assert.deepEqual(again.layout, result.layout);
});
