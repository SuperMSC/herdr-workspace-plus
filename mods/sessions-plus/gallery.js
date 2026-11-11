import { div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, exec, theme, openOverlay, closeOverlay } from "herdr";
import { createActivityClient } from "./activity-client.js";
import { activityTarget } from "./activity-model.js";
export default class SessionGallery {
  init(p, cx) {
    this.p = p; this.images = []; this.pages = []; this.pageIndex = 0; this.warnings = []; this.generation = 0; this.error = ""; this.scale = 1; this.handle = cx.focus_handle(); this.handle.focus(); this.read = createActivityClient(exec, appHome(), p);
    try { this.target = activityTarget(p.target); this.load(cx, true); } catch (error) { this.error = String(error.message || error); }
  }
  load(cx, reset = false) {
    if (this.loading || this.closed || !this.target || !reset && !this.next) return;
    if (!reset && this.pageIndex < this.pages.length - 1) { this.showPage(this.pageIndex + 1, cx); return; }
    const generation = ++this.generation; this.loading = true; this.error = ""; const cursor = reset ? null : this.next; cx.notify();
    cx.spawn(async cx => {
      try {
        const data = await this.read("gallery", this.target, cursor); if (this.closed || generation !== this.generation) return;
        if (reset) this.pages = [data]; else this.pages.push(data);
        this.showPage(reset ? 0 : this.pages.length - 1, cx); this.stale = false;
      } catch (error) { if (!this.closed && generation === this.generation) { this.error = String(error.message || error); this.stale = this.images.length > 0; } }
      finally { if (!this.closed && generation === this.generation) { this.loading = false; cx.notify(); } }
    });
  }
  showPage(index, cx) { const data = this.pages[index]; if (!data) return; this.pageIndex = index; this.images = data.images; this.next = data.next; this.page = data.page; this.notice = data.message || ""; this.warnings = data.warnings; this.selected = null; cx.notify(); }
  reference(item) {
    return `Recorded session image · ${this.target.provider} ${this.target.id}\n${item.timestamp ? new Date(item.timestamp).toISOString() : "Timestamp unavailable"}\n${item.label}\n${JSON.stringify(item.path)}\n${item.cached ? "Temporary owned image cache; retained for at most 24 hours and may be evicted earlier." : "Original local path recorded by the session; the file may have changed since the recorded event."}\nImage SHA-256: ${item.id}`;
  }
  queue(item) { openOverlay({ mod: "sessions-plus", kind: "dialog", frame: "none", width: 660, height: 620, props: { role: "reference", text: this.reference(item), title: "Recorded session image", on: null } }); }
  close() { this.closed = true; this.generation++; }
  render() {
    const t = theme(), button = (id, label, callback, disabled = false) => div().id(id).px(8).py(5).rounded(5).flex_none().bg(t.raised).text_color(disabled ? t.dim : t.foreground).when(!disabled, el => el.cursor_pointer().hover(row => row.bg(t.hover))).on_click((_event, cx) => { cx.stop_propagation(); if (!disabled) callback(cx); }).child(label);
    const actions = item => h_flex().gap(6).flex_wrap().child(button(`gallery-copy-${item.id}`, "Copy path", cx => cx.write_to_clipboard(item.path))).child(button(`gallery-reference-${item.id}`, "Copy evidence", cx => cx.write_to_clipboard(this.reference(item)))).child(button(`gallery-queue-${item.id}`, "Add to pending prompts…", () => this.queue(item)));
    const selected = this.selected;
    const content = selected ? v_flex().flex_1().min_h(0).gap(8)
      .child(h_flex().gap(6).child(button("gallery-back", "Back to images", cx => { this.selected = null; cx.notify(); })).child(button("gallery-zoom-out", "−", cx => { this.scale = Math.max(.125, this.scale / 1.5); cx.notify(); })).child(button("gallery-zoom-in", "+", cx => { this.scale = Math.min(3, this.scale * 1.5); cx.notify(); })))
      .child(div().flex_1().min_h(100).overflow_scroll().child(image(selected.image).w(selected.width * this.scale).h(selected.height * this.scale).flex_none()))
      .child(div().text_size(10.5).text_color(t.dim).child(`${selected.width} × ${selected.height} · ${(selected.bytes / 1024).toFixed(1)} KiB · ${selected.label}`)).child(actions(selected))
      : v_flex().id("gallery-images").flex_1().min_h(0).gap(9).overflow_y_scrollbar()
        .child(h_flex().flex_wrap().gap(9).items_start().children(this.images.map(item => {
          const ratio = Math.min(220 / item.width, 160 / item.height, 1);
          return v_flex().id(`gallery-image-${item.id}`).w(238).p(8).gap(6).rounded(6).bg(t.raised).flex_none()
            .child(div().w_full().h(165).flex().items_center().justify_center().cursor_pointer().on_click((_event, cx) => { this.selected = item; this.scale = Math.min(1, 800 / item.width, 500 / item.height); cx.notify(); }).child(image(item.image).w(Math.max(1, item.width * ratio)).h(Math.max(1, item.height * ratio))))
            .child(div().text_size(10.5).text_color(t.muted).child(`${item.width} × ${item.height} · ${item.timestamp ? new Date(item.timestamp).toLocaleString() : "Timestamp unavailable"}`))
            .child(div().text_size(10).text_color(t.dim).truncate().tooltip(item.path).child(item.label)).child(actions(item));
        })))
        .when(!this.images.length && !this.loading && !this.notice && !this.error, el => el.child(div().p(12).text_color(t.muted).child("No supported local session images in this byte page.")))
        .child(h_flex().gap(6).child(button("gallery-newer", "Newer page", cx => this.showPage(this.pageIndex - 1, cx), this.loading || this.pageIndex === 0)).child(button("gallery-older", "Older page", cx => this.load(cx), this.loading || !this.next && this.pageIndex >= this.pages.length - 1)));
    return v_flex().id("session-gallery").size_full().min_h(0).min_w(0).p(14).gap(8).rounded(10).border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(12).track_focus(this.handle)
      .on_key_down((event, cx) => { if (event.key === "escape") { if (this.selected) { this.selected = null; cx.notify(); } else closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(h_flex().gap(8).items_center().child(div().flex_1().font_semibold().text_size(15).child("Session images")).child(button("gallery-refresh", this.loading ? "Reading…" : "Refresh", cx => this.load(cx, true), this.loading || !this.target)))
      .child(div().text_size(10.5).text_color(t.dim).truncate().child(this.target ? `${this.target.provider} · ${this.target.title} · ${this.target.id}` : "No verified local session"))
      .when(Boolean(this.error || this.notice), el => el.child(div().text_color(this.error ? t.ansi1 : t.muted).child(this.error || this.notice)))
      .when(this.stale, el => el.child(div().text_color(t.ansi3).child("Previous images retained; the source page needs refresh.")))
      .child(content)
      .when(this.warnings.length > 0, el => el.child(div().flex_none().max_h(65).overflow_y_scrollbar().text_size(10.5).text_color(t.ansi3).child(this.warnings.join("\n"))))
      .child(div().text_size(10).text_color(t.dim).child(`Local records only · ${this.images.length}/12 images on this page · page ${this.page || 0}/20 · cache ≤24h / 32 MiB · remote URLs are never fetched`));
  }
}
