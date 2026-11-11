import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Editor, EditorState } from "gpui-base";
import { appHome, exec, terminals, theme, readTextFile, openOverlay, closeOverlay } from "herdr";
import { SCREEN_LIMITS, capturedScreenTarget, sameScreenTerminal, screenPath, screenReference } from "./screen-picker-model.js";
import { createScreenPickerClient } from "./screen-picker-client.js";
const errorText = error => String(error.message || error).slice(0, 600);
export default class ScreenPicker {
  init(p, cx) {
    this.p = p; this.handle = cx.focus_handle(); this.handle.focus(); this.rows = []; this.page = 0; this.query = ""; this.generation = 0; this.selectionVersion = 0; this.error = ""; this.status = ""; this.loading = false; this.busy = false; this.history = SCREEN_LIMITS.history;
    this.input = InputState.new({ placeholder: "Search captured URLs and paths…" });
    this.input.on("change", (_event, cx) => { this.query = this.input.value().slice(0, 300); this.page = 0; this.error = this.input.value().length > 300 ? "Search uses the first 300 characters." : ""; cx.notify(); });
    this.editor = EditorState.new({ value: "Select a captured item to preview its literal text and source line.", readonly: true, language: "text", line_numbers: false, soft_wrap: true });
    try {
      this.target = capturedScreenTarget(p.target, p.context || null);
      if (!sameScreenTerminal(this.target, terminals().find(row => row.address === this.target.address))) throw new Error("The captured terminal changed before Screen picker opened. Choose it again.");
      this.client = createScreenPickerClient({ execute: exec, home: appHome(), node: p.node || "node", target: this.target, current: () => terminals().find(row => row.address === this.target.address) });
      this.refresh(cx);
    } catch (error) { this.error = errorText(error); }
  }
  filtered() {
    if (this.filteredRows === this.rows && this.filteredQuery === this.query) return this.filteredValue;
    const terms = this.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 20);
    this.filteredValue = terms.length ? this.rows.filter(row => {
      const search = row.searchText ?? `${row.kind} ${row.value} ${row.resolved || ""} ${row.excerpt}`.toLocaleLowerCase();
      return terms.every(term => search.includes(term));
    }) : this.rows;
    this.filteredRows = this.rows; this.filteredQuery = this.query; return this.filteredValue;
  }
  selected() { return this.rows.find(row => row.id === this.selectedId) || null; }
  refresh(cx) {
    if (!this.client || this.loading || this.busy || this.disposed) return;
    const generation = ++this.generation; ++this.selectionVersion; this.loading = true; this.error = ""; this.status = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await this.client.scan(this.history);
        if (this.disposed || generation !== this.generation) return;
        this.rows = result.candidates; this.snapshot = result; this.selectedId = null; this.page = 0; this.stale = false;
        this.editor.set_value("Select a captured item to preview its literal text and source line.");
      } catch (error) { if (!this.disposed && generation === this.generation) { this.error = errorText(error); this.stale = true; } }
      finally { if (!this.disposed && generation === this.generation) { this.loading = false; cx.notify(); } }
    });
  }
  choose(row, cx) {
    if (this.disposed || !this.rows.some(candidate => candidate.id === row?.id)) return;
    this.selectedId = row.id; ++this.selectionVersion; this.error = ""; this.status = ""; this.handle.focus();
    this.editor.set_value(`${row.kind === "url" ? "URL" : "Path"}: ${row.value}\n\n${row.reason || ""}${row.resolved ? `\nResolved: ${row.resolved}${row.line ? `\nFile line: ${row.line}${row.column ? ":" + row.column : ""}` : ""}` : ""}\n\nCaptured screen line ${row.sourceLine}:\n${row.excerpt}`);
    cx.notify();
  }
  movePage(step, cx) { const last = Math.max(0, Math.ceil(this.filtered().length / SCREEN_LIMITS.page) - 1); this.page = Math.max(0, Math.min(last, this.page + step)); this.selectedId = null; ++this.selectionVersion; this.editor.set_value("Select an item on this page."); this.handle.focus(); cx.notify(); }
  copy(cx) { const row = this.selected(); if (!row) return; cx.write_to_clipboard(row.value); this.status = "Copied the literal selected text"; cx.notify(); }
  action(kind, cx) {
    const row = this.selected(); if (!row || this.loading || this.busy || this.disposed || this.stale) return;
    const version = this.selectionVersion, generation = this.generation;
    this.busy = true; this.error = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        await this.client.verify();
        if (this.disposed || generation !== this.generation || version !== this.selectionVersion) return;
        if (kind === "url") {
          if (row.kind !== "url" || !row.openable || !/^https?:\/\//i.test(row.value)) throw new Error("Only a selected HTTP(S) URL without embedded credentials can open in the browser.");
          cx.open_url(row.value); this.status = "Opened the selected URL";
        } else if (kind === "reference") {
          openOverlay({ mod: "sessions-plus", kind: "dialog", frame: "none", width: 660, height: 640, props: { role: "reference", title: "Terminal screen reference", text: screenReference(row, this.target), on: this.target.on } });
          this.status = "Reference opened for review before adding to pending prompts";
        } else if (kind === "file") {
          const path = row.kind === "path" ? screenPath(row.value, this.target) : null;
          if (!path?.previewable) throw new Error("A selected path inside the captured filesystem root is required for file preview.");
          const text = await readTextFile(path.resolved, { on: this.target.on });
          await this.client.verify();
          if (this.disposed || generation !== this.generation || version !== this.selectionVersion) return;
          if (text === null) throw new Error("The selected file is no longer available.");
          if (text.includes("\0")) throw new Error("The selected file is binary; use literal copy or a reference.");
          this.editor.set_value(text.slice(0, SCREEN_LIMITS.preview));
          this.status = `File preview: ${path.resolved}${text.length > SCREEN_LIMITS.preview ? " · first 80,000 characters" : ""}`;
        }
      } catch (error) { if (!this.disposed && generation === this.generation && version === this.selectionVersion) this.error = errorText(error); }
      finally { this.busy = false; if (!this.disposed) cx.notify(); }
    });
  }
  key(event, cx) {
    if (event.key === "escape") { closeOverlay(this.p.overlay); cx.stop_propagation(); return; }
    if (!this.handle.is_focused() || event.modifiers?.platform || event.modifiers?.control || event.modifiers?.alt || event.modifiers?.secondary) return;
    const rows = this.filtered().slice(this.page * SCREEN_LIMITS.page, (this.page + 1) * SCREEN_LIMITS.page), letter = String(event.key).toLowerCase();
    if (/^[a-t]$/.test(letter)) { const row = rows[letter.charCodeAt(0) - 97]; if (row) this.choose(row, cx); }
    else if (event.key === "enter") this.copy(cx);
    else if (event.key === "pagedown") this.movePage(1, cx);
    else if (event.key === "pageup") this.movePage(-1, cx);
    else if (event.key === "/") this.input.focus();
    else return;
    cx.stop_propagation();
  }
  close() { this.disposed = true; ++this.generation; ++this.selectionVersion; this.input?.release(); this.editor?.release(); }
  render() {
    const t = theme(), rows = this.filtered(), shown = rows.slice(this.page * SCREEN_LIMITS.page, (this.page + 1) * SCREEN_LIMITS.page), selected = this.selected(), disabled = this.loading || this.busy;
    const button = (id, label, callback, off = false) => div().id(id).px(8).py(5).flex_none().rounded(5).bg(t.raised).text_color(off ? t.dim : t.foreground)
      .when(!off, el => el.cursor_pointer().hover(row => row.bg(t.hover))).on_click((_event, cx) => { cx.stop_propagation(); if (!off) callback(cx); }).child(label);
    return v_flex().id("terminal-screen-picker").size_full().min_h(0).min_w(0).p(14).gap(8).rounded(10).border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(12).track_focus(this.handle).on_key_down((event, cx) => this.key(event, cx))
      .child(h_flex().gap(7).items_center().child(div().flex_1().font_semibold().text_size(15).child("Screen picker"))
        .child(button("screen-picker-depth", this.history ? "+ 200 history lines" : "Screen only", cx => { this.history = this.history ? 0 : SCREEN_LIMITS.history; this.refresh(cx); }, disabled || !this.client))
        .child(button("screen-picker-refresh", this.loading ? "Reading…" : "Refresh", cx => this.refresh(cx), disabled || !this.client)))
      .child(div().text_size(10.5).text_color(t.dim).truncate().tooltip(`${this.target?.address || ""}\n${this.target?.cwd || ""}\nRoot: ${this.target?.root || "unverified"}`).child(this.target ? `${this.target.on || "This computer"} · ${this.target.address} · ${this.target.cwd || "Folder unknown"}` : "No captured live terminal"))
      .child(Input.new(this.input).h(32).flex_none())
      .child(h_flex().flex_1().min_h(0).min_w(0).items_stretch().gap(9)
        .child(v_flex().w(310).h_full().flex_none().min_h(0).gap(5).overflow_y_scrollbar().children(shown.map((row, index) => div().id(`screen-picker-row-${row.id}`).px(8).py(7).rounded(5).bg(selected?.id === row.id ? t.selected : t.raised).cursor_pointer().hover(el => el.bg(t.hover)).on_click((_event, cx) => this.choose(row, cx))
          .child(h_flex().gap(6).items_center().child(div().w(16).font_semibold().text_color(t.muted).child(String.fromCharCode(97 + index))).child(div().flex_1().truncate().tooltip(row.value).child(row.value)))
          .child(div().text_size(10).text_color(t.dim).child(`${row.kind} · screen line ${row.sourceLine}`))))
          .when(!shown.length, el => el.child(div().p(10).text_color(t.muted).child(this.loading ? "Reading the captured screen…" : "No literal URLs or paths match this snapshot."))))
        .child(div().flex_1().h_full().min_w(0).min_h(0).border_1().border_color(t.border).rounded(5).child(Editor.new(this.editor).size_full())))
      .child(h_flex().flex_none().gap(6).items_center().child(div().flex_1().text_size(10.5).text_color(t.dim).child(`${rows.length} candidates · page ${this.page + 1}/${Math.max(1, Math.ceil(rows.length / SCREEN_LIMITS.page))}`))
        .child(button("screen-picker-prev", "Previous", cx => this.movePage(-1, cx), this.page === 0))
        .child(button("screen-picker-next", "Next", cx => this.movePage(1, cx), (this.page + 1) * SCREEN_LIMITS.page >= rows.length)))
      .child(h_flex().flex_none().gap(6).flex_wrap()
        .child(button("screen-picker-copy", "Copy literal", cx => this.copy(cx), !selected))
        .child(button("screen-picker-file", "Preview file", cx => this.action("file", cx), disabled || this.stale || !selected?.previewable))
        .child(button("screen-picker-url", "Open URL", cx => this.action("url", cx), disabled || this.stale || !selected?.openable))
        .child(button("screen-picker-reference", "Add to pending prompts…", cx => this.action("reference", cx), disabled || this.stale || !selected)))
      .when(Boolean(this.error), el => el.child(div().max_h(70).overflow_y_scrollbar().text_size(11).text_color(t.ansi1).child(this.error)))
      .when(Boolean(this.status), el => el.child(div().text_size(10.5).text_color(t.muted).child(this.status)))
      .when(Boolean(this.snapshot?.limited || this.snapshot?.truncated || this.snapshot?.lineLimited), el => el.child(div().text_size(10.5).text_color(t.blocked).child(`${this.snapshot?.limited ? "First 200 unique candidates. " : ""}${this.snapshot?.truncated ? "Screen read reached 1 MiB; incomplete final line omitted. " : ""}${this.snapshot?.lineLimited ? "Long lines or excess lines were bounded. " : ""}`)))
      .child(div().text_size(10).text_color(t.dim).child("a–t select · Enter copies · / searches · Page Up/Down changes page · only explicit buttons open files, URLs or a reference"));
  }
}
