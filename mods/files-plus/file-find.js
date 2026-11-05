// A retained file-local find bar; no project scan or file writes are involved.
import { div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, v_virtual_list, VirtualListScrollHandle, Scrollbar } from "gpui-base";
import { settings } from "herdr";
import { iconButton } from "./icons.js";
import { findInText, highlightedLine } from "./file-find-model.js";

export default class FileFind {
  constructor(cx) {
    this.handle = cx.focus_handle(); this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Find in file…" });
    this.input.on("change", (_e, cx) => { this.update(false); cx.notify(); });
    this.input.on("submit", (e, cx) => this.move(e.shift ? -1 : 1, cx));
    this.text = ""; this.visible = false; this.caseSensitive = false; this.active = -1;
    this.result = findInText("", "");
  }
  clear() {
    this.visible = false; this.text = ""; this.active = -1; this.truncated = false;
    this.input.set_value(""); this.result = findInText("", "");
  }
  setText(text, truncated) {
    this.truncated = Boolean(truncated);
    if (this.text === text) return;
    this.text = text; this.update(true);
  }
  update(preserve) {
    this.result = findInText(this.text, this.input.value(), this.caseSensitive);
    this.active = this.result.matches.length ? preserve ? Math.max(0, Math.min(this.active, this.result.matches.length - 1)) : 0 : -1;
    this.locate();
  }
  locate() { const match = this.result.matches[this.active]; if (match) this.scroll.scroll_to_item(match.row, "center"); }
  show(cx) {
    this.visible = true; this.locate(); cx.notify();
    cx.timer.after(0, () => { if (this.visible) { this.input.focus(); this.input.set_selected_range({ start: 0, end: this.input.value().length }); } });
  }
  hide(cx) { this.visible = false; this.handle.focus(); cx.notify(); }
  move(direction, cx) {
    if (!this.result.matches.length) return;
    this.active = (this.active + direction + this.result.matches.length) % this.result.matches.length;
    this.locate(); cx.notify();
  }
  key(event, cx, searchable) {
    if (searchable && event.key === "f" && (event.modifiers?.platform || event.modifiers?.control) && !event.modifiers?.alt) this.show(cx);
    else if (event.key === "escape" && this.visible) this.hide(cx);
    else return;
    cx.stop_propagation();
  }
  close() { this.visible = false; this.input.release(); this.scroll.release(); this.handle.release(); }
  control(id, label, tooltip, active, disabled, action, t) {
    return div().id(`file-find-${id}`).h(28).min_w(28).px(6).flex_none().flex().items_center().justify_center().rounded(4)
      .bg(active ? t.selected : t.surface).text_color(active ? t.accent : t.foreground).disabled(disabled)
      .tooltip(tooltip).accessibility_label(tooltip)
      .when(disabled, el => el.opacity(0.4)).when(!disabled, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
      .on_click((e, cx) => { cx.stop_propagation(); if (!disabled) action(e, cx); }).child(label);
  }
  bar(t) {
    const count = this.result.matches.length, query = this.input.value();
    return v_flex().id("file-find-bar").flex_none().px(8).py(6).gap(4).bg(t.surface).border_b(1).border_color(t.border)
      .child(h_flex().gap(4).items_center()
        .child(Input.new(this.input).h(30).flex_1().min_w(40).px(8).rounded(4).border_1().border_color(t.input).bg(t.background))
        .child(this.control("case", "Aa", "Match case", this.caseSensitive, false, (_e, cx) => { this.caseSensitive = !this.caseSensitive; this.update(false); cx.notify(); }, t))
        .child(div().id("file-find-count").min_w(55).flex_none().text_center().text_size(11).text_color(query && !count ? t.blocked : t.muted).child(query ? count ? `${this.active + 1}/${count}${this.result.limited ? "+" : ""}` : "No matches" : ""))
        .child(this.control("previous", "↑", "Previous match · Shift+Enter", false, !count, (_e, cx) => this.move(-1, cx), t))
        .child(this.control("next", "↓", "Next match · Enter", false, !count, (_e, cx) => this.move(1, cx), t))
        .child(iconButton("file-find-close", "close", "Close find · Esc", (_e, cx) => this.hide(cx), t)))
      .when(Boolean(this.truncated || this.result.limited), el => el.child(div().text_size(10).text_color(t.blocked).child([
        this.truncated ? "Searching the first 400 KB only" : "",
        this.result.limited ? "Showing the first 1,000 matches" : "",
      ].filter(Boolean).join(" · "))));
  }
  content(t, width, fontSize = 12) {
    const result = this.result, active = this.active, selected = result.matches[active];
    const columns = Math.max(20, Math.floor((width - 90) / (fontSize * 0.6))), rowHeight = Math.max(24, Math.ceil(fontSize * 1.8));
    return v_flex().id("file-find-source").relative().flex_1().min_h(0).min_w(0).overflow_hidden()
      .on_mouse_down("left", () => this.handle.focus())
      .child(v_virtual_list("file-find-lines", result.lines.length, rowHeight, index => String(index), range =>
        result.lines.slice(range.start, range.end).map((line, index) => {
          const row = range.start + index;
          return h_flex().h(rowHeight).px(8).gap(10).items_center().bg(row === selected?.row ? t.surface : t.background)
            .child(div().w(48).flex_none().text_right().text_size(Math.max(10, fontSize - 1)).text_color(t.dim).child(String(row + 1)))
            .child(h_flex().min_w(0).overflow_hidden().font_family(settings().font_family || "JetBrains Mono").text_size(fontSize)
              .children(highlightedLine(line, result.byLine.get(row), active, columns).map(part => div().flex_none().whitespace_nowrap()
                .text_color(part.active ? t.accent_foreground : t.foreground).when(Boolean(part.match), el => el.bg(part.active ? t.accent : t.selected))
                .child(part.text.replace(/\t/g, "    ")))));
        })).track_scroll(this.scroll).flex_1().min_h(0))
      .child(Scrollbar.vertical("file-find-lines").absolute().inset_0());
  }
}
