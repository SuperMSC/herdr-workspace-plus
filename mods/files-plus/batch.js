import { closeButton } from "./icons.js";
import { div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";
import { exec, theme, closeOverlay, shared, setShared, pickFolder } from "herdr";
import { createFilesystem } from "./filesystem.js";
import { batchTargets, runBatch, batchDestination } from "./batch-model.js";
import { CHANGE_KEY, applyPathChange } from "./model.js";
import { LIBRARY_KEY, remapLibrary } from "./library-model.js";
const titles = { copy: "Copy selected items", move: "Move selected items", trash: "Move selected items to Trash?" };

export default class Batch {
  init(p, cx) {
    this.p = p; this.action = p.action; this.targets = []; this.results = []; this.error = ""; this.busy = false;
    try { if (!titles[p.action]) throw new Error("Unknown action"); this.targets = batchTargets(p.targets); }
    catch (error) { this.error = String(error.message ?? error); }
    this.handle = cx.focus_handle();
    this.input = InputState.new({ value: p.target?.root || this.targets[0]?.root || "", placeholder: "/absolute/destination/folder" });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    if (p.action === "trash") this.handle.focus(); else this.input.focus();
  }
  pending() { return this.targets.filter(t => !this.results.some(r => r.ok && r.target.path === t.path)); }
  submit(cx) {
    if (this.busy || this.choosing || !this.pending().length) return;
    let destination;
    try { destination = this.action === "trash" ? null : batchDestination(this.input.value()); }
    catch (error) { this.error = String(error.message ?? error); cx.notify(); return; }
    const pending = this.pending(), retained = this.results.filter(r => r.ok);
    this.busy = true; this.error = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        await runBatch(pending, this.action, destination, createFilesystem(exec, this.targets[0]), results => {
          this.results = [...retained, ...results];
          const change = { target: this.targets[0], action: "batch", operation: this.action, results: this.results.filter(r => r.ok), revision: (shared(CHANGE_KEY)?.revision ?? 0) + 1 };
          if (change.results.length) {
            setShared(CHANGE_KEY, change);
            const state = shared(LIBRARY_KEY), next = remapLibrary(state, change.target.root, change.target.on, path => applyPathChange(path, change));
            if (next !== state) setShared(LIBRARY_KEY, next);
          }
          cx.notify();
        });
      } catch (error) { this.error = String(error.message ?? error); }
      finally { this.busy = false; cx.notify(); }
    });
  }
  choose(cx) {
    if (this.busy || this.choosing) return;
    this.choosing = true; cx.notify();
    cx.spawn(async cx => {
      try { const folder = await pickFolder({ prompt: "Choose destination" }); if (folder && !this.disposed) this.input.set_value(folder); }
      catch (error) { if (!this.disposed) this.error = String(error.message ?? error); }
      finally { this.choosing = false; if (!this.disposed) cx.notify(); }
    });
  }
  close() { this.disposed = true; this.input?.release(); }
  render() {
    const t = theme(), trash = this.action === "trash", pending = this.pending(), complete = this.results.length && !pending.length;
    const button = (id, label, click, disabled = false) => div().id(id).px(12).h(32).flex_none().flex().items_center().rounded(6).bg(t.raised).disabled(disabled).when(disabled, el => el.opacity(0.5)).when(!disabled, el => el.cursor_pointer().hover(s => s.bg(t.hover))).on_click((_e, cx) => { if (!disabled) click(cx); }).child(label);
    return v_flex().id("files-batch").size_full().min_h(0).p(16).gap(10).rounded(10).overflow_hidden().border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(12).track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { if (!this.busy) closeOverlay(this.p.overlay); cx.stop_propagation(); } else if (e.key === "enter" && trash) { this.submit(cx); cx.stop_propagation(); } })
      .child(h_flex().flex_none().gap(8).items_center()
        .child(div().flex_1().min_w(0).font_semibold().text_size(15).child(titles[this.action] || "File operation"))
        .child(closeButton("batch-close", "Close file operation", () => { if (!this.busy) closeOverlay(this.p.overlay); }, t, this.busy)))
      .child(div().text_color(t.muted).child(`${this.targets.length} items · folders include their contents`))
      .when(!trash, el => el.child(div().text_color(t.muted).child("Destination folder"))
        .child(h_flex().flex_none().gap(6).items_center()
          .child(Input.new(this.input).h(32).flex_1().min_w(0).px(8).rounded(5).bg(t.surface).disabled(this.busy || this.choosing || Boolean(complete)))
          .child(button("batch-choose", "Choose…", cx => this.choose(cx), this.busy || this.choosing || Boolean(complete)))))
      .child(div().text_size(11).text_color(t.dim).child(trash ? "Uses macOS Trash. Restore items in Finder." : this.action === "move" ? "Names are preserved. No overwriting. Moves require the same volume." : "Names are preserved. Existing items are never replaced or merged."))
      .child(v_flex().id("batch-items").flex_1().min_h(0).overflow_y_scrollbar().children(this.targets.map(target => {
        const result = this.results.find(r => r.target.path === target.path);
        return v_flex().flex_none().py(5).gap(3).child(div().truncate().tooltip(target.path).child(target.relative))
          .child(div().text_size(11).text_color(result?.ok ? t.ansi2 : result ? t.ansi1 : t.dim).child(result ? result.ok ? `Done${trash ? "" : ` → ${result.path}`}` : result.error : "Pending"));
      })))
      .when(Boolean(this.error), el => el.child(div().text_color(t.ansi1).child(this.error)))
      .child(h_flex().flex_none().gap(8).items_center().child(div().flex_1().text_color(t.dim).child(this.busy ? "Working…" : complete ? "All items completed" : this.results.length ? `${this.results.filter(r => r.ok).length} completed · ${pending.length} remaining` : ""))
        .when(!this.results.length, el => el.child(button("batch-cancel", "Cancel", () => closeOverlay(this.p.overlay), this.busy)))
        .when(!complete, el => el.child(button("batch-confirm", this.results.length ? "Retry remaining" : trash ? "Move to Trash" : this.action === "move" ? "Move" : "Copy", cx => this.submit(cx), this.busy || this.choosing || !pending.length))));
  }
}
