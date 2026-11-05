import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, exec, theme, closeOverlay } from "herdr";
import { PROVIDERS } from "./model.js";

export default class Preview {
  init(p, cx) {
    this.p = p; this.target = { ...p.target }; this.loading = false; this.error = ""; this.data = null;
    this.handle = cx.focus_handle(); this.handle.focus(); this.load(cx);
  }
  load(cx) {
    if (this.loading) return;
    if (this.target.remote || !this.target.id || !this.target.key) { this.error = "Preview requires an identified local history session."; cx.notify(); return; }
    this.loading = true; this.error = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await exec(this.p.node || "node", [appHome() + "/mods/sessions-plus/history.mjs", "preview", JSON.stringify({ stores: this.p.stores ?? {} }), this.target.key]);
        const data = JSON.parse(result.stdout);
        if (result.code || data.error) throw new Error(data.error || "Could not read this session.");
        if (data.row?.key !== this.target.key || !Array.isArray(data.messages)) throw new Error("The preview did not match the selected session.");
        this.data = data;
      } catch (error) { this.error = String(error.message ?? error); }
      finally { this.loading = false; cx.notify(); }
    });
  }
  render() {
    const t = theme();
    const button = (id, label, callback) => div().id(id).px(10).py(6).rounded(5).bg(t.raised).cursor_pointer().on_click(callback).child(label);
    return v_flex().id("session-preview").size_full().min_h(0).p(16).gap(10).rounded(10).overflow_hidden().border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(12)
      .track_focus(this.handle).on_key_down((event, cx) => { if (event.key === "escape") { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(h_flex().flex_none().gap(8).items_center().child(div().flex_1().min_w(0).truncate().font_semibold().text_size(15).child("Recent messages")))
      .child(div().truncate().child(this.target.title || "Session"))
      .child(div().text_size(10.5).text_color(t.dim).child(`${PROVIDERS[this.target.provider] || this.target.provider} · ${this.target.id || ""}`))
      .child(v_flex().id("session-preview-messages").flex_1().min_h(0).gap(10).overflow_y_scrollbar()
        .when(this.loading, el => el.child(div().text_color(t.muted).child("Reading recent messages…")))
        .when(Boolean(this.error), el => el.child(div().text_color(t.ansi1).child(this.error)))
        .when(Boolean(this.data?.message), el => el.child(div().text_color(t.muted).child(this.data.message)))
        .children((this.data?.messages ?? []).map(message => v_flex().p(10).gap(5).rounded(6).bg(t.raised)
          .child(div().font_semibold().text_color(t.accent).child(message.role === "user" ? "Latest user message" : "Latest assistant message"))
          .child(div().child(message.text))
          .when(message.truncated, el => el.child(div().text_size(10.5).text_color(t.dim).child("Message shortened to 6,000 characters."))))))
      .child(div().text_size(10.5).text_color(t.dim).child(this.data?.limited ? "Recent history is read with a size limit; older or oversized messages may be absent. No summary is generated." : "Read-only excerpts · No generated summary or persistent message index."))
      .when(Boolean(this.error), el => el.child(h_flex().flex_none().gap(8).justify_end()
        .child(button("preview-retry", "Retry", (_e, cx) => this.load(cx)))));
  }
}
