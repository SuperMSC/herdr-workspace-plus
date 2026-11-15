import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, updates, layout } from "herdr";
import { TYPE } from "./type-scale.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = find(child, id); if (found) return found; }
  return null;
}

// The native footer actions, inside the rounded workspace sidebar surface.
export default class SidebarFooter {
  init(p) { this.p = p; }
  render() {
    const t = theme(), collapsed = (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
    const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
      .when(collapsed, el => el.relative().w(32).px(0).justify_center().tooltip(label))
      .text_color(dim ? t.dim : t.muted).hover(el => el.bg(t.hover).text_color(t.foreground)).cursor_pointer()
      .on_click(action).child(svg(`mods/workspace-chrome/${icon}.svg`).size(14)).when(!collapsed, el => el.child(label));
    const ready = div().size(6).rounded_full().bg(t.accent);
    return v_flex().size_full().rounded_b(this.p.panelRadius ?? 0).overflow_hidden().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(TYPE.md)
      .when(collapsed, el => el.px(0).items_center())
      .child(row("settings", "settings", "Settings", false, () => run("app.settings"))
        .when(Boolean(updates().app.ready), el => el.child(collapsed ? ready.absolute().top(5).right(6) : ready)))
      .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
  }
}
