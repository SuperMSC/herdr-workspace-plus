// Modified from Herdr's shipped pane header (mods/pane): terminal panes look the same, and a
// file preview shows its own file here (icon, name, folder, pin, actions), so the preview
// needs no toolbar row of its own.
import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, spaces, props, run, theme, home, shared, setShared, openOverlay, settings, window, layout } from "herdr";
import { fileIcon, iconButton } from "./icons.js";
import { FILE_TABS_KEY } from "./file-tabs.js";
import { LIBRARY_KEY, libraryFor, updateLibrary } from "./library-model.js";
import { targetFor, menuHeight } from "./model.js";
import { DIRTY_KEY } from "./editor-model.js";

export const HEADER_ROLE = "pane-header";

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

/** Whether a layout frames its tab panes with this header. */
export function usesHeader(tree) {
  const stack = [tree];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    const header = node.content?.pane?.header?.content;
    if (node.content?.tab === "active" && header?.mod === "files-plus" && header.props?.role === HEADER_ROLE) return true;
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return false;
}

/** The registered file preview shown in a pane, if any. */
export function previewIn(pane, tabs = shared(FILE_TABS_KEY)?.tabs) {
  return Object.values(tabs || {}).find(row => row?.pane === pane) ?? null;
}

export default class PaneHeader {
  init(p) { this.p = p; this.hovered = false; }

  me() {
    const pane = props()?.pane ?? this.p?.pane;
    return panes().find(p => p.pane === pane);
  }

  button(t, id, name, command, args) {
    return div().id(id).p(3).rounded(4).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); run(command, args); })
      .child(svg(`mods/pane/${name}.svg`).size(14));
  }

  controls(t, p) {
    const pane = p.pane;
    return [
      this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }),
      this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }),
      this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }),
      this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane }),
    ];
  }

  frame(t, p) {
    return h_flex().id(`pane-head-${p.pane}`).size_full().px(10).gap(8).items_center().bg(t.background)
      .border_b(1).border_color(t.border).text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane: p.pane }));
  }

  file(t, p, row) {
    const tab = spaces().flatMap(space => space.tabs ?? []).find(tab => tab.id === p.tab);
    const path = row?.path ?? null, name = path ? path.split("/").pop() : tab?.name || "File";
    const dir = path && path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const where = row ? `${row.on ? row.on + ":" : ""}${folder(dir ? `${row.root}/${dir}` : row.root)}` : "";
    const pinned = row ? libraryFor(shared(LIBRARY_KEY), row.root, row.on ?? null).pinned.includes(path) : false;
    return this.frame(t, p)
      .child(path ? fileIcon(path) : div().w(16).flex_none())
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).tooltip(path ?? name).child(name))
      .when(Boolean(row && shared(DIRTY_KEY)?.[row.previewId]), el => el.child(div().size(7).flex_none().rounded(4).bg(t.working).tooltip("Unsaved changes")))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(where))
      .when(Boolean(row), el => el
        .child(iconButton(`ph-pin-${p.pane}`, "pin", pinned ? "Unpin file" : "Pin file", (_e, cx) => {
          setShared(LIBRARY_KEY, updateLibrary(shared(LIBRARY_KEY), row.root, row.on ?? null, "pin", row.path)); cx.notify();
        }, t, pinned))
        .child(iconButton(`ph-more-${p.pane}`, "more", "File actions", (_e, cx) => {
          const target = targetFor(row.root, row.path, false, row.on ?? null, window()?.platform);
          if (target) openOverlay({ mod: "files-plus", kind: "popup", width: 220, height: menuHeight(target, {}, globalThis.window.viewport_size().height / (settings().zoom || 1) * 0.85), props: { role: "menu", target } });
        }, t)))
      .when(this.hovered, el => el.children(this.controls(t, p)));
  }

  render() {
    const t = theme(), p = this.me();
    if (!p) return div();
    if (p.mod === "files-plus" && !p.terminal) {
      const row = previewIn(p.pane);
      if (row || (spaces().flatMap(space => space.tabs ?? []).find(tab => tab.id === p.tab)?.name ?? "").includes(".")) return this.file(t, p, row);
    }
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim), st = p.status;
    return this.frame(t, p)
      .when(Boolean(pic), el => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el.children(this.controls(t, p)));
  }
}

/** Whether the shown layout gives file previews this header (then they drop their toolbar). */
export function headerShown() {
  try { return usesHeader(layout()); } catch { return false; }
}
