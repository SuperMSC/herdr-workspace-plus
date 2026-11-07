import { div } from "gpui-kit";
import { h_flex, Scrollbar, v_virtual_list } from "gpui-base";

// VS Code's diff weights: a line at ~20%, its gutter a little stronger, the changed
// characters at ~40%, and a solid bar at the edge so a change reads at a glance.
const LINE = "33", GUTTER = "47", MARK = "66", BAR = "e6";
const tone = (row, t) => row?.kind === "+" ? t.ansi2 : row?.kind === "-" ? t.ansi1 : null;
const number = (value, t, color) => div().w(38).h_full().flex_none().pr(6).flex().items_center().justify_end().when(Boolean(color), e => e.bg(color + GUTTER).text_color(t.foreground)).when(!color, e => e.text_color(t.dim)).child(value === undefined ? "" : String(value));

// A hunk reads "@@ -380,6 +380,7 @@ SOURCE_DATA": the range dim, the enclosing context brighter.
function header(row, t) {
  const file = /^diff --git a\/.* b\/(.+)$/.exec(row.text);
  if (file) return h_flex().w_full().px(10).h(20).flex_none().items_center().overflow_hidden().bg(t.raised).border_y(1).border_color(t.border)
    .child(div().flex_1().min_w(0).truncate().text_ellipsis_start().font_semibold().text_color(t.foreground).child(file[1]));
  const hunk = /^(@@ [^@]* @@)(.*)$/.exec(row.text);
  return h_flex().w_full().px(10).h(20).flex_none().gap(8).items_center().overflow_hidden().bg(t.accent + "12").border_y(1).border_color(t.border)
    .child(div().flex_none().text_color(t.dim).child(hunk ? hunk[1] : row.text))
    .when(Boolean(hunk?.[2]?.trim()), e => e.child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(hunk[2].trim())));
}

export function inlineDiffRow(row, t) {
  if (![" ", "+", "-"].includes(row.kind)) return header(row, t);
  const color = tone(row, t);
  return h_flex().w_full().h(20).flex_none().items_center().when(Boolean(color), e => e.bg(color + LINE))
    .child(div().w(3).h_full().flex_none().when(Boolean(color), e => e.bg(color + BAR)))
    .child(number(row.old, t, color)).child(number(row.next, t, color))
    .child(div().w(16).flex_none().pl(4).text_color(color ?? t.dim).child(color ? row.kind : ""))
    .child(lineText(row, color));
}

// The line, with its changed span (when paired) on a stronger tint.
function lineText(line, color) {
  if (!line) return div().flex_1();
  const [start, end] = line.mark ?? [];
  if (!color || !Number.isFinite(start)) return div().flex_1().min_w(0).truncate().child(line.text);
  return h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap()
    .when(start > 0, e => e.child(div().flex_none().child(line.text.slice(0, start))))
    .when(end > start, e => e.child(div().flex_none().rounded(2).bg(color + MARK).child(line.text.slice(start, end))))
    .child(div().flex_1().min_w(0).truncate().child(line.text.slice(end)));
}

function splitCell(line, before, t, id) {
  const color = tone(line, t), wide = (line?.text.length ?? 0) > 36;
  return h_flex().id(id).flex_1().min_w(0).h_full().items_center().overflow_hidden()
    .when(!line, e => e.bg(t.dim + "0f"))
    .when(Boolean(color), e => e.bg(color + LINE))
    .when(wide, e => e.tooltip(line.text))
    .child(div().w(3).h_full().flex_none().when(Boolean(color), e => e.bg(color + BAR)))
    .child(number(before ? line?.old : line?.next, t, color))
    .child(div().w(16).flex_none().pl(4).text_color(color ?? t.dim).child(color ? line.kind : ""))
    .child(lineText(line, color));
}

/** Both halves share one row, so they cannot drift; each half is exactly half the view. */
export function splitDiffRow(row, t, index = 0) {
  if (row.header) return header(row.header, t);
  return h_flex().w_full().h(20).flex_none()
    .child(splitCell(row.before, true, t, `split-${index}-before`))
    .child(div().w(1).h_full().flex_none().bg(t.border))
    .child(splitCell(row.after, false, t, `split-${index}-after`));
}

/** Column titles over the split view, in the same halves as its rows. */
export function splitHeader(counts, t) {
  const title = (label, count, color, sign) => h_flex().flex_1().min_w(0).px(10).gap(6).items_center()
    .child(div().child(label)).when(count > 0, e => e.child(div().text_color(color).child(`${sign}${count}`)));
  return h_flex().h(22).flex_none().items_center().text_size(10).text_color(t.dim).border_b(1).border_color(t.border)
    .child(title("Before", counts.removed, t.ansi1, "−"))
    .child(div().w(1).h_full().flex_none().bg(t.border))
    .child(title("After", counts.added, t.ansi2, "+"));
}

export function diffView(view, t, font) {
  const side = view.diffMode === "split", rows = side ? view.split : view.rows;
  // Inline scrolls sideways for long lines; split halves fit the view and truncate (hover shows the line).
  return div().flex_1().min_h(0).relative().font_family(font).text_size(11)
    .on_size_change((size, cx) => { if (Math.abs((view.diffViewport || 0) - size.width) > 2) { view.diffViewport = size.width; cx.notify(); } })
    .child(div().id("changes-diff-x").size_full().when(!side, e => e.overflow_x_scrollbar())
      .child(div().w_full().when(!side, e => e.min_w(view.diffWidth)).h_full().child(v_virtual_list("changes-diff", rows.length, 20, i => `${view.diffRequest}:${view.diffMode}:${i}`,
        range => rows.slice(range.start, range.end).map((row, i) => side ? splitDiffRow(row, t, range.start + i) : inlineDiffRow(row, t))).track_scroll(view.diffScroll).size_full())))
    .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
    .when(!rows.length, e => e.child(div().absolute().top(8).px(12).text_color(t.dim).child(view.diffLoading ? "Loading diff…" : "Select a file to view its diff")));
}
