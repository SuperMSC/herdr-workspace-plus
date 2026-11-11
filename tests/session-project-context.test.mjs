import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validRelative } from "../mods/files-plus/library-model.js";

test("Notes and Commands retain the shown terminal or captured preview machine instead of the surrounding space", () => {
  const state = { spaces: [{ id: "A/s", active: true, machine: "A", folder: "/a", tabs: [{ id: "preview" }] }], panes: [], focus: { space: "A/s", pane: null, terminal: "B/t8", cwd: "/b" }, shared: {} };
  const deps = { spaces: () => state.spaces, panes: () => state.panes, machines: () => [{ name: "A", layout: "ready" }], focused: () => state.focus, shared: key => state.shared[key] };
  const contextSource = readFileSync(new URL("../mods/sessions-plus/project-context.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replaceAll("export ", "");
  const projectContext = new Function(...Object.keys(deps), contextSource + "\nreturn projectContext;")(...Object.values(deps));
  const main = readFileSync(new URL("../mods/sessions-plus/main.js", import.meta.url), "utf8");
  const source = main.slice(main.indexOf("function location()"), main.indexOf("export default class"));
  const location = new Function("projectContext", source + "\nreturn location;")(projectContext);
  assert.deepEqual(location(), { cwd: "/b", on: "B", remote: true });
  state.focus = { space: "A/s", pane: "p", tab: "preview", cwd: null };
  state.panes = [{ pane: "p", tab: "preview", mod: "files-plus", terminal: null }];
  state.shared["files-plus.file-tabs.v1"] = { tabs: { preview: { space: "A/s", pane: "p", tab: "preview", root: "/local", path: "file.txt", previewId: "id", on: null } } };
  assert.deepEqual(location(), { cwd: "/local", on: null, remote: false });
  const commands = main.slice(main.indexOf("  openCommands()"), main.indexOf("  actionsRow("));
  const notes = main.slice(main.indexOf("  openNotes("), main.indexOf("  openCommands()"));
  const overlays = [], entry = new Function("location", "openOverlay", "return class {" + notes + commands + "};")(location, value => overlays.push(value));
  const view = new entry(); view.openCommands(); view.openNotes();
  assert.deepEqual(overlays[0].props.context, { root: "/local", on: null });
  assert.deepEqual(overlays[1].props.project, { root: "/local", on: null });
});
