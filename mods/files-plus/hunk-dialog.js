import { TYPE } from "./type-scale.js";
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, exec, shared, setShared, theme, closeOverlay, window } from "herdr";
import { CHANGE_KEY } from "./model.js";

export default class HunkDialog {
  init(p, cx) {
    this.p = p; this.request = p.request ? JSON.parse(JSON.stringify(p.request)) : { root: "", action: "stage", file: {}, hunk: {} }; this.handle = cx.focus_handle(); this.handle.focus(); this.error = ""; this.busy = false;
    if (!this.request.file || !this.request.hunk || !this.request.root) { this.request = { root: "", action: "stage", file: {}, hunk: {} }; this.invalid = true; this.error = "No captured hunk is available. Select a hunk in Changes first."; return; }
    this.submit(cx);
  }
  submit(cx) {
    if (this.busy || this.done || this.invalid) return;
    if (window()?.platform !== "macos" || this.request.on) { this.error = "Hunk actions require local macOS."; cx.notify(); return; }
    this.busy = true; this.error = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await exec("node", [appHome() + "/mods/files-plus/hunk-helper.mjs", JSON.stringify(this.request)], { timeout: 15000 });
        let body; try { body = JSON.parse(result.stdout || "{}"); } catch { throw new Error("The result was not confirmed. Refresh the diff before retrying."); }
        if (result.code || body.ok !== true || body.path !== this.request.file.path || body.action !== this.request.action || body.header !== this.request.hunk.header) throw new Error(body.error || "The result was not confirmed. Refresh the diff before retrying.");
        this.done = true;
        setShared(CHANGE_KEY, { target: { root: this.request.root, relative: this.request.file.path, on: null }, action: this.request.action, revision: (shared(CHANGE_KEY)?.revision || 0) + 1 });
        closeOverlay(this.p.overlay);
      } catch (error) { this.error = String(error.message || error); }
      finally { this.busy = false; if (!this.disposed) cx.notify(); }
    });
  }
  close() { this.disposed = true; }
  render() {
    const t = theme(), request = this.request;
    const button = (id, label, callback, disabled) => div().id(id).h(30).px(12).rounded(6).bg(t.raised).flex().items_center().text_color(disabled ? t.dim : t.foreground)
      .when(!disabled, el => el.cursor_pointer().hover(row => row.bg(t.hover))).on_click((_event, cx) => { if (!disabled) callback(cx); }).child(label);
    return v_flex().id("hunk-operation").size_full().min_h(0).p(18).gap(12).rounded(10).border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(TYPE.md).track_focus(this.handle)
      .on_key_down((event, cx) => { if (event.key === "escape") { if (!this.busy) closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(div().font_semibold().text_size(TYPE.lg).child(request.action === "stage" ? "Stage selected hunk" : "Unstage selected hunk"))
      .child(div().truncate().tooltip(request.root + "/" + request.file.path).child(request.file.path || "No file selected"))
      .child(div().text_color(t.muted).child(request.hunk.header || ""))
      .child(div().text_color(t.dim).child("Only this hunk changes in the Git index. Working files and other staged changes are kept."))
      .child(div().flex_1().min_h(30).overflow_y_scrollbar().text_color(this.error ? t.ansi1 : t.muted).child(this.error || "Checking source versions and updating the selected hunk…"))
      .child(h_flex().flex_none().gap(8).justify_end()
        .child(button("hunk-close", "Close", () => closeOverlay(this.p.overlay), this.busy))
        .child(button("hunk-retry", this.busy ? "Working…" : "Retry captured hunk", cx => this.submit(cx), this.busy || this.done || this.invalid)));
  }
}
