import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const load = (mod, deps) => { deps = {privacyGuard: () => null, ...deps}; return new Function(...Object.keys(deps), readFileSync(new URL(`../mods/${mod}`, import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace("export default class", "return class"))(...Object.values(deps)); };

test("new Sessions roles dispatch without starting the normal history panel", () => {
  for (const role of ["services", "presets", "lineage", "tools", "timeline", "gallery", "deliverables", "screen-picker"]) {
    const calls = [], child = class { init(p, cx) { calls.push(["init", p, cx]); } render() { return "child"; } close() { calls.push(["close"]); } }, p = { role, context: { root: "/project", on: "server" } };
    const Panel = load("sessions-plus/main.js", { View: class {}, props: () => p, Services: child, WorkspacePresets: child, Lineage: child, WorkspaceTools: child, Timeline: child, SessionGallery: child, Deliverables: child, ScreenPicker: child });
    const view = new Panel(), cx = {}; view.init({}, cx); assert.equal(view.render(cx), "child"); assert.equal(calls.length, 1); assert.equal(calls[0][1].context.on, "server"); view.close(cx); assert.equal(calls[1][0], "close");
  }
});
test("new Files roles dispatch and preserve captured repository and machine props", () => {
  for (const role of ["graph", "github"]) {
    let captured; const child = class { init(p) { captured = p; } render() { return role; } close() {} }, p = { role, root: "/repo", on: "server" };
    const Panel = load("files-plus/main.js", { View: class {}, props: () => p, GitGraph: child, GithubPanel: child }); const view = new Panel(); view.init({}, {}); assert.equal(view.render({}), role); assert.equal(captured, p);
  }
});
test("workspace and repository entry buttons clamp dialogs and capture exact machine without using later focus", () => {
  const overlays = []; let current = { cwd: "/project", on: "server" };
  globalThis.window = { viewport_size: () => ({ width: 900, height: 700 }) };
  const Panel = load("sessions-plus/main.js", { View: class {}, focused: () => ({}), terminals: () => [], projectContext: () => current, settings: () => ({ zoom: 1.25 }), openOverlay: value => overlays.push(value) }), panel = new Panel();
  panel.openWorkspaceTool("services"); current = { cwd: "/elsewhere", on: null }; panel.openWorkspaceTool("presets"); panel.openWorkspaceTool("lineage"); panel.openWorkspaceTool("unsupported");
  assert.equal(overlays.length, 3); assert.deepEqual(overlays[0].props.context, { root: "/project", on: "server" }); assert.equal(overlays[1].props.context.on, null); assert(overlays.every(item => item.height <= 504 && item.width < 720));
  const Changes = load("files-plus/changes.js", { settings: () => ({ zoom: 1.25 }), openOverlay: value => overlays.push(value) }), changes = new Changes(); changes.root = "/canonical/repo"; changes.sourceLocation = () => ({ cwd: "/repo/subdir", on: "other-server" });
  changes.openRepositoryTool("graph"); changes.openRepositoryTool("github"); assert.equal(overlays[3].props.root, "/canonical/repo"); assert.equal(overlays[3].props.on, "other-server"); assert.equal(overlays[4].props.role, "github");
});


test("Tools captures the shown remote terminal and keeps that identity when focus changes", () => {
  const overlays = []; let focus = {shown:"server/t9",terminal:"t1"};
  globalThis.window = {viewport_size:()=>({width:1200,height:900})};
  const records = [{address:"t1",state:"live",created_ms:1,argv:["zsh"],cwd:"/local"},{address:"server/t9",state:"live",created_ms:9,argv:["zsh"],cwd:"/remote"}];
  const Panel=load("sessions-plus/main.js",{View:class{},focused:()=>focus,terminals:()=>records,projectContext:()=>({cwd:"/remote",on:"server"}),settings:()=>({zoom:1}),openOverlay:data=>overlays.push(data)});
  const panel=new Panel();panel.openWorkspaceTool("tools");focus={terminal:"t1"};
  assert.equal(overlays[0].props.target.address,"server/t9");assert.equal(overlays[0].props.target.created_ms,9);assert.equal(overlays[0].props.target.on,"server");assert.equal(overlays[0].props.context.root,"/remote");
});
