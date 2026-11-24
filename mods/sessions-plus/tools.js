import { TYPE } from "./type-scale.js";
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, openOverlay, closeOverlay, settings, shared, setShared } from "herdr";
import { privacyToggle } from "./privacy.js";
import { AUTO_TITLES_ENABLED } from "./live-model.js";

export default class WorkspaceTools {
  init(p, cx) { this.p = p; this.handle = cx.focus_handle(); this.handle.focus(); }
  open(role) {
    if (role === "privacy") { privacyToggle(); return; }
    if (role === "auto-titles") {
      setShared(AUTO_TITLES_ENABLED, shared(AUTO_TITLES_ENABLED) === false);
      return;
    }
    const viewport = globalThis.window.viewport_size(), zoom = Number(settings().zoom) || 1;
    closeOverlay(this.p.overlay);
    openOverlay({ mod: "sessions-plus", kind: "dialog", width: Math.min(940, viewport.width / zoom * .93), height: Math.min(760, viewport.height / zoom * .9),
      props: { role, context: this.p.context, target: this.p.target, node: this.p.node, stores: this.p.stores } });
  }
  render() {
    const t = theme();
    const rows = [
      ["launcher", "Quick launcher", "Find agents, projects and saved commands."],
      ["git-overview", "Git overview", "Pending changes, unpushed commits, stash and conflicts across repositories."],
      ["usage-stats", "Usage stats", "Claude Code and Codex tokens and estimated cost for the last 7 days and this month."],
      ["deliverables", "Deliverables", "Files and links to read, review and archive."],
      ["screen-picker", "Screen picker", "Pick paths and links from the captured terminal.", !this.p.target],
      ["presets", "Project presets", "Review and launch a saved workspace."],
      ["privacy", "Screenshot mode", "Hide these panels; terminal text remains visible."],
    ];
    return v_flex().id("workspace-tools").size_full().min_h(0).p(14).gap(9).bg(t.surface).text_color(t.foreground).text_size(TYPE.md)
      .track_focus(this.handle).on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(h_flex().items_center().gap(7).child(div().flex_1().text_size(TYPE.lg).font_semibold().child("Workspace tools"))
        .child(div().id("tool-auto-titles").px(7).py(4).flex_none().rounded(5).text_size(TYPE.sm).text_color(t.muted)
          .tooltip("Toggle naming eligible tabs from their session titles.").cursor_pointer().hover(el => el.bg(t.hover)).on_click(() => this.open("auto-titles"))
          .child(`Auto tab titles · ${shared(AUTO_TITLES_ENABLED) === false ? "Off" : "On"}`)))
      .child(div().flex_none().text_color(t.muted).child("Timeline and Images are in each session’s ⋯ menu."))
      .child(v_flex().flex_1().min_h(0).gap(9).overflow_y_scrollbar().pr(16).children(rows.map(([id, name, detail, disabled]) => v_flex().id("tool-" + id).flex_none().p(11).gap(4).rounded(7).border_1().border_color(t.border)
        .text_color(disabled ? t.dim : t.foreground).when(!disabled, el => el.cursor_pointer().hover(el => el.bg(t.hover)).on_click(() => this.open(id)))
        .child(div().font_semibold().child(name)).child(div().text_size(TYPE.sm).text_color(t.muted).child(disabled ? "Focus a live terminal before opening Tools." : detail)))));
  }
}
