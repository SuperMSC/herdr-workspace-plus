import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, shared, setShared, closeOverlay } from "herdr";
import { NAMES, cleanTitle } from "./model.js";

export default class Rename {
  init(p, cx) {
    this.p = p;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ value: shared(NAMES)?.[p.target.key] ?? p.target.title ?? "", placeholder: "Session name" });
    this.input.on("submit", (_event, cx) => this.save(cx));
    this.input.focus();
  }

  save(cx) {
    const raw = this.input.value();
    if (raw.length > 120 || /[\x00-\x1f\x7f]/.test(raw)) { this.error = "Use up to 120 characters, on one line."; cx.notify(); return; }
    const names = { ...(shared(NAMES) ?? {}) }, title = cleanTitle(raw);
    if (title) names[this.p.target.key] = title;
    else delete names[this.p.target.key];
    setShared(NAMES, names);
    closeOverlay(this.p.overlay);
  }

  render() {
    const t = theme();
    const button = (id, label, primary, callback) => div().id(id).px(12).py(7).rounded(7).cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).on_click(callback).child(label);
    return v_flex().id("sessions-rename").size_full().min_h(0).p(18).gap(12).rounded(10).overflow_hidden().border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(h_flex().flex_none().gap(8).items_center().child(div().flex_1().min_w(0).truncate().font_semibold().text_size(15).child("Rename Session")))
      .child(div().text_color(t.muted).child("Saved locally in Sessions Plus. Leave empty to use the original title."))
      .child(div().h(36).px(9).border_1().border_color(t.border).rounded(7).child(Input.new(this.input).h_full().w_full()))
      .child(div().flex_1().text_color(t.ansi1).child(this.error ?? ""))
      .child(h_flex().gap(8).justify_end()
        .child(button("session-rename-cancel", "Cancel", false, () => closeOverlay(this.p.overlay)))
        .child(button("session-rename-save", "Save", true, (_e, cx) => this.save(cx))));
  }
}
