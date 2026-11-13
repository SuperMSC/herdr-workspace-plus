import { TYPE } from "./type-scale.js";
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, exec, theme, openOverlay, closeOverlay } from "herdr";
import { createActivityClient } from "./activity-client.js";
import { activityTarget, activityReference } from "./activity-model.js";
export default class Timeline {
  init(p, cx) {
    this.p = p; this.events = []; this.pages = []; this.pageIndex = 0; this.warnings = []; this.generation = 0; this.error = ""; this.handle = cx.focus_handle(); this.handle.focus();
    this.read = createActivityClient(exec, appHome(), p);
    try { this.target = activityTarget(p.target); this.load(cx, true); } catch (error) { this.error = String(error.message || error); }
  }
  load(cx, reset = false) {
    if (this.loading || this.closed || !this.target || !reset && !this.next) return;
    if (!reset && this.pageIndex < this.pages.length - 1) { this.showPage(this.pageIndex + 1, cx); return; }
    const generation = ++this.generation, cursor = reset ? null : this.next; this.loading = true; this.error = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        const data = await this.read("timeline", this.target, cursor);
        if (this.closed || this.generation !== generation) return;
        if (reset) this.pages = [data]; else this.pages.push(data);
        this.showPage(reset ? 0 : this.pages.length - 1, cx); this.stale = false;
      } catch (error) { if (!this.closed && this.generation === generation) { this.error = String(error.message || error); this.stale = this.events.length > 0; } }
      finally { if (!this.closed && this.generation === generation) { this.loading = false; cx.notify(); } }
    });
  }
  showPage(index, cx) { const data = this.pages[index]; if (!data) return; this.pageIndex = index; this.events = data.events; this.next = data.next; this.page = data.page; this.available = data.available; this.notice = data.message || ""; this.warnings = data.warnings; this.selected = null; cx.notify(); }
  queue(event) { openOverlay({ mod: "sessions-plus", kind: "dialog", frame: "none", width: 660, height: 620, props: { role: "prompt-queue", text: activityReference(this.target, event), title: "Recorded session evidence", on: null } }); }
  close() { this.closed = true; this.generation++; }
  render() {
    const t = theme(), button = (id, label, callback, disabled = false) => div().id(id).px(8).py(5).rounded(5).flex_none().bg(t.raised).text_color(disabled ? t.dim : t.foreground).when(!disabled, el => el.cursor_pointer().hover(row => row.bg(t.hover))).on_click((_event, cx) => { cx.stop_propagation(); if (!disabled) callback(cx); }).child(label);
    return v_flex().id("session-timeline").size_full().min_h(0).min_w(0).p(14).gap(8).rounded(10).border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(TYPE.md).track_focus(this.handle)
      .on_key_down((event, cx) => { if (event.key === "escape") { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(h_flex().gap(8).items_center().flex_none().child(div().flex_1().font_semibold().text_size(TYPE.lg).child("Work timeline")).child(button("timeline-refresh", this.loading ? "Reading…" : "Refresh", cx => this.load(cx, true), this.loading || !this.target).tooltip("Read only · latest first · timestamps and explicit duration fields only · no generated summary")))
      .child(div().truncate().text_size(TYPE.xs).text_color(t.dim).child(this.target ? `${this.target.provider} · ${this.target.title} · ${this.target.id}` : "No verified local session"))
      .when(this.stale, el => el.child(div().text_color(t.ansi3).child("Previous evidence retained · refresh required")))
      .when(Boolean(this.error || this.notice), el => el.child(div().text_color(this.error ? t.ansi1 : t.muted).child(this.error || this.notice)))
      .child(this.selected ? v_flex().flex_1().min_h(0).gap(8).child(button("timeline-detail-back", "Back to page", cx => { this.selected = null; cx.notify(); })).child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(8).child(div().font_semibold().child(this.selected.title)).child(div().text_size(TYPE.xs).text_color(t.dim).child("Recorded excerpt · up to 2,400 characters; omitted text is marked …")).child(div().child(this.selected.text)).when(this.selected.files.length > 0, el => el.child(div().text_size(TYPE.sm).text_color(t.muted).child("Recorded target paths (long paths may be shortened)\n" + this.selected.files.join("\n"))))).child(h_flex().gap(6).child(button("timeline-detail-copy", "Copy evidence", cx => cx.write_to_clipboard(activityReference(this.target, this.selected)))).child(button("timeline-detail-queue", "Add to pending prompts…", () => this.queue(this.selected)))) : v_flex().id("timeline-events").flex_1().min_h(0).gap(7).overflow_y_scrollbar().children(this.events.map(event => v_flex().id(`timeline-${event.id}`).flex_none().p(9).gap(5).rounded(6).bg(t.raised)
        .child(h_flex().gap(7).items_center().child(div().flex_1().font_semibold().text_color(event.kind === "prompt" ? t.accent : t.foreground).child(event.title)).child(div().text_size(TYPE.xs).text_color(t.dim).child(event.timestamp ? new Date(event.timestamp).toLocaleString() : "Timestamp unavailable")))
        .child(div().text_size(TYPE.sm).child(event.text.length > 300 ? event.text.slice(0, 300) + "…" : event.text))
        .when(event.files.length > 0, el => el.child(div().text_size(TYPE.xs).text_color(t.muted).child("Recorded tool target(s) · success not inferred\n" + event.files.slice(0, 3).map(file => file.length > 100 ? file.slice(0, 100) + "…" : file).join("\n"))))
        .when(event.durationMs !== null, el => el.child(div().text_size(TYPE.xs).text_color(t.dim).child(`Explicit recorded duration: ${(event.durationMs / 1000).toFixed(2)} s`)))
        .child(h_flex().gap(6).child(button(`timeline-detail-${event.id}`, "Details", cx => { this.selected = event; cx.notify(); })).child(button(`timeline-copy-${event.id}`, "Copy evidence", cx => cx.write_to_clipboard(activityReference(this.target, event)))).child(button(`timeline-queue-${event.id}`, "Add to pending prompts…", () => this.queue(event))))))
        .when(!this.events.length && !this.loading && !this.notice && !this.error, el => el.child(div().p(12).text_color(t.muted).child("No supported events in this byte page.")))
        .child(h_flex().gap(6).child(button("timeline-newer", "Newer page", cx => this.showPage(this.pageIndex - 1, cx), this.loading || this.pageIndex === 0)).child(button("timeline-older", "Older page", cx => this.load(cx), this.loading || !this.next && this.pageIndex >= this.pages.length - 1))))
      .when(this.warnings.length > 0, el => el.child(div().flex_none().max_h(65).overflow_y_scrollbar().text_size(TYPE.xs).text_color(t.ansi3).child(this.warnings.join("\n"))))
      .child(div().text_size(TYPE.xs).text_color(t.dim).child(`Page ${this.page || 0}/20`));
  }
}
