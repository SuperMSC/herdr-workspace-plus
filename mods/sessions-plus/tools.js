import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, openOverlay, closeOverlay, settings } from "herdr";
import { privacyToggle } from "./privacy.js";

export default class WorkspaceTools {
  init(p, cx) { this.p = p; this.handle = cx.focus_handle(); this.handle.focus(); }
  open(role) {
    if (role === "privacy") { privacyToggle(); return; }
    const viewport = globalThis.window.viewport_size(), zoom = Number(settings().zoom) || 1;
    closeOverlay(this.p.overlay);
    openOverlay({ mod: "sessions-plus", kind: "dialog", frame: "none", width: Math.min(940, viewport.width / zoom * .93), height: Math.min(760, viewport.height / zoom * .9),
      props: { role, context: this.p.context, target: this.p.target, node: this.p.node } });
  }
  render() {
    const t = theme();
    const rows = [
      ["deliverables", "Deliverables", "Files and links to read, review and archive."],
      ["screen-picker", "Screen picker", "Pick paths and links from the captured terminal.", !this.p.target],
      ["services", "Services", "Containers and listening ports on this machine."],
      ["presets", "Project presets", "Review and launch a saved workspace."],
      ["lineage", "Agent lineage", "Follow agents and their child terminals."],
      ["privacy", "Screenshot mode", "Hide these panels; terminal text remains visible."],
    ];
    return v_flex().id("workspace-tools").size_full().min_h(0).p(14).gap(9).bg(t.surface).text_color(t.foreground).text_size(12)
      .track_focus(this.handle).on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child("Workspace tools")))
      .child(div().flex_none().text_color(t.muted).child("Timeline and Images are in each session’s ⋯ menu."))
      .child(v_flex().flex_1().min_h(0).gap(9).overflow_y_scrollbar().children(rows.map(([id, name, detail, disabled]) => v_flex().id("tool-" + id).flex_none().p(11).gap(4).rounded(7).border_1().border_color(t.border)
        .text_color(disabled ? t.dim : t.foreground).when(!disabled, el => el.cursor_pointer().hover(el => el.bg(t.hover)).on_click(() => this.open(id)))
        .child(div().font_semibold().child(name)).child(div().text_size(11).text_color(t.muted).child(disabled ? "Focus a live terminal before opening Tools." : detail)))));
  }
}
