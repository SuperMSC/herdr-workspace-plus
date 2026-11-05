// The name dialog for Project Spaces: rename a project, or make a new one for a space.

import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, shared, setShared, closeOverlay } from "herdr";
import { STATE_KEY, normalizeState, renameGroup, newGroupKey, createGroup } from "./model.js";

export default class Prompt {
  init(p, cx) {
    this.p = p;
    this.error = "";
    this.handle = cx.focus_handle();
    this.input = InputState.new({ value: p.value ?? "", placeholder: "Project name" });
    if (p.value) this.input.set_selected_range({ start: 0, end: p.value.length });
    this.input.on("submit", (_e, cx) => this.save(cx));
    this.input.focus();
    cx.timer.after(400, () => this.input.focus());
  }

  save(cx) {
    const name = this.input.value();
    if (name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) {
      this.error = "Use up to 60 characters, on one line.";
      cx.notify();
      return;
    }
    const state = normalizeState(shared(STATE_KEY));
    if (this.p.action === "rename-group") setShared(STATE_KEY, renameGroup(state, this.p.key, name));
    else if (this.p.action === "new-group") {
      if (!name.trim()) {
        this.error = "Give the project a name.";
        cx.notify();
        return;
      }
      setShared(STATE_KEY, createGroup(state, newGroupKey(state), name, this.p.space, this.p.autoKey));
    }
    closeOverlay(this.p.overlay);
  }

  close() {
    this.input?.release();
  }

  render() {
    const t = theme();
    const button = (id, label, primary, callback) => h_flex().id(id).h(30).px(13).items_center().rounded(7).cursor_pointer()
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).hover(s => s.opacity(0.88)).on_click(callback).child(label);
    const hint = this.p.action === "rename-group" ? "Leave empty to use the folder or repository name." : "The space moves into the new project.";
    return v_flex().id("project-spaces-prompt").size_full().min_h(0).p(18).gap(10).rounded(10).overflow_hidden()
      .border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(h_flex().items_center().child(div().flex_1().font_semibold().text_size(15).child(this.p.title ?? "Project"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().h(34).px(9).flex_none().border_1().border_color(t.accent).rounded(7).bg(t.background).child(Input.new(this.input).h_full().w_full()))
      .child(div().text_size(11.5).text_color(this.error ? t.ansi1 : t.dim).child(this.error || hint))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(button("pp-cancel", "Cancel", false, () => closeOverlay(this.p.overlay)))
        .child(button("pp-save", "Save", true, (_e, cx) => this.save(cx))));
  }
}
