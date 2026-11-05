import { div } from "gpui-kit";
import { h_flex, Scrollbar, v_virtual_list } from "gpui-base";

const number = (value, t) => div().w(38).flex_none().pr(6).text_right().text_color(t.dim).child(value === undefined ? "" : String(value));
const background = (element, row, t) => element.when(row?.kind === "+", e => e.bg(t.ansi2 + "18")).when(row?.kind === "-", e => e.bg(t.ansi1 + "18"));
const header = (row, t) => div().w_full().px(10).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(row.text);

export function inlineDiffRow(row, t) {
  if (![" ", "+", "-"].includes(row.kind)) return header(row, t);
  return background(h_flex().w_full().h(20).flex_none().items_center(), row, t)
    .child(number(row.old, t)).child(number(row.next, t))
    .child(div().w(14).flex_none().text_color(t.dim).child(row.kind))
    .child(div().flex_1().min_w(0).truncate().child(row.text));
}

export function splitDiffRow(row, t, width) {
  if (row.header) return header(row.header, t);
  const cell = (line, before) => background(h_flex().w(width).min_w(width).h(20).flex_none().items_center(), line, t)
    .child(number(before ? line?.old : line?.next, t))
    .child(div().flex_1().min_w(0).truncate().child(line?.text || ""));
  return h_flex().h(20).w(width * 2).flex_none().child(cell(row.before, true).border_r(1).border_color(t.border)).child(cell(row.after, false));
}

export function diffView(view, t, font) {
  const side = view.diffMode === "split", rows = side ? view.split : view.rows;
  const half = Math.max(280, view.diffWidth - 50, (view.diffViewport || 560) / 2), width = side ? half * 2 : view.diffWidth;
  return div().flex_1().min_h(0).relative().font_family(font).text_size(11)
    .on_size_change((size, cx) => { if (Math.abs((view.diffViewport || 0) - size.width) > 2) { view.diffViewport = size.width; cx.notify(); } })
    .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
      .child(div().w_full().min_w(width).h_full().child(v_virtual_list("changes-diff", rows.length, 20, i => `${view.diffRequest}:${view.diffMode}:${i}`,
        range => rows.slice(range.start, range.end).map(row => side ? splitDiffRow(row, t, half) : inlineDiffRow(row, t))).track_scroll(view.diffScroll).size_full())))
    .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
    .when(!rows.length, e => e.child(div().absolute().top(8).px(12).text_color(t.dim).child(view.diffLoading ? "Loading diff…" : "Select a file to view its diff")));
}
