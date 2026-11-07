import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, run, shared, setShared, theme } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Toolbar {
  init(p) {
    this.panel = p.panel || "panel";
    this.stack = p.stack || "panel-body";
    this.child = p.child || "files-plus-sessions";
    this.enable();
  }

  enable() {
    // The shipped tab bar restores only enabled panel IDs when switching spaces.
    const saved = shared("workspace.panels");
    const enabled = Array.isArray(saved) ? saved : ["files", "changes"];
    if (!enabled.includes(this.child)) setShared("workspace.panels", [...enabled, this.child]);
  }

  render() {
    this.enable();
    const t = theme(), root = layout(), panel = find(root, this.panel), body = find(root, this.stack);
    const available = Boolean(panel && body?.children?.some(child => child.id === this.child));
    const on = available && !panel.hidden && body.active === this.child;
    return h_flex().size_full().items_center().pr(10).bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("panel-sessions").ml(-7).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .when(available, el => el.cursor_pointer().hover(el => el.bg(t.hover)))
        .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
        .on_click(() => {
          if (!available) return;
          if (on) run("layout.hide", { id: this.panel });
          else { run("layout.select", { stack: this.stack, child: this.child }); run("layout.show", { id: this.panel }); }
        })
        .child(svg("mods/sessions-plus/sessions.svg").size(14))
        .child(div().child("Sessions")));
  }
}
