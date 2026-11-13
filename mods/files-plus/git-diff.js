import { TYPE } from "./type-scale.js";
import { div } from "gpui-kit";
import { h_flex, Scrollbar, v_virtual_list } from "gpui-base";

// VS Code's diff weights: a line at ~20%, its gutter a little stronger, the changed
// characters at ~40%, and a solid bar at the edge so a change reads at a glance.
const LINE = "33", GUTTER = "47", MARK = "66", BAR = "e6";
const tone = (row, t) => row?.kind === "+" ? t.ansi2 : row?.kind === "-" ? t.ansi1 : null;
const number = (value, t, color) => div().w(38).h_full().flex_none().pr(6).flex().items_center().justify_end().when(Boolean(color), e => e.bg(color + GUTTER).text_color(t.foreground)).when(!color, e => e.text_color(t.dim)).child(value === undefined ? "" : String(value));

// A hunk reads "@@ -380,6 +380,7 @@ SOURCE_DATA": the range dim, the enclosing context brighter.
function header(row, t, view = null) {
  const file = /^diff --git a\/.* b\/(.+)$/.exec(row.text);
  if (file) return h_flex().w_full().px(10).h(20).flex_none().items_center().overflow_hidden().bg(t.raised).border_y(1).border_color(t.border)
    .child(div().flex_1().min_w(0).truncate().text_ellipsis_start().font_semibold().text_color(t.foreground).child(file[1]));
  const hunk = /^(@@ [^@]* @@)(.*)$/.exec(row.text);
  return h_flex().w_full().px(10).h(20).flex_none().gap(8).items_center().overflow_hidden().bg(t.accent + "12").border_y(1).border_color(t.border)
    .when(Boolean(hunk && view?.hunkData?.hunks?.[view.activeHunk]?.header === row.text), el => el.border_color(t.accent))
    .child(div().flex_none().text_color(t.dim).child(hunk ? hunk[1] : row.text))
    .when(Boolean(hunk?.[2]?.trim()), e => e.child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(hunk[2].trim())));
}

function reviewLine(element, row, side, view, t) {
  const mark = view?.reviewLineState?.(row, side);
  if (!mark) return element;
  // Item renderers only paint. The virtual list owns all interaction handlers.
  return element.when(mark.selected, el => el.border_y(1).border_color(t.accent)).cursor_pointer()
    .child(div().w(12).h_full().flex_none().flex().items_center().justify_center().text_color(t.accent)
      .when(mark.commented, el => el.tooltip("Existing comment on this line · open Review to edit it"))
      .child(mark.commented ? "●" : ""));
}

function reviewPress(event) {
  return { modifiers: { shift: Boolean(event?.modifiers?.shift), alt: Boolean(event?.modifiers?.alt) },
    x: event?.local_position?.x, width: event?.bounds?.width };
}

function pickReviewRow(view, rows, request, mode, key, cx, event = null, comment = false) {
  if (view.disposed || view.diffRequest !== request || view.diffMode !== mode) return;
  const prefix = `${request}:${mode}:`;
  if (typeof key !== "string" || !key.startsWith(prefix)) return;
  const index = Number(key.slice(prefix.length));
  if (!Number.isSafeInteger(index) || String(index) !== key.slice(prefix.length) || index < 0 || index >= rows.length) return;
  const press = event ? reviewPress(event) : view.diffReviewPress?.request === request && view.diffReviewPress?.mode === mode ? view.diffReviewPress.event : null;
  view.diffReviewPress = null;
  let row = rows[index], side;
  if (mode === "split") {
    if (row.header) { if (row.header.text?.startsWith("@@ ")) view.selectHunkHeader?.(row.header.text, cx); return; }
    side = Number.isFinite(press?.x) && Number.isFinite(press?.width) && press.width > 0
      ? press.x < press.width / 2 ? "before" : "after" : row.after ? "after" : "before";
    row = row[side];
  } else {
    side = row.kind === "-" || (row.kind === " " && press?.modifiers?.alt) ? "before" : "after";
  }
  if (row?.kind === "@") { view.selectHunkHeader?.(row.text, cx); return; }
  if (!row || ![" ", "+", "-"].includes(row.kind)) return;
  const mark = view.reviewLineState?.(row, side);
  if (!mark?.enabled) return;
  view.selectReviewLine(row, side, { modifiers: press?.modifiers || {} }, cx);
  if (comment) { cx.stop_propagation(); view.addComment(cx); }
}

export function inlineDiffRow(row, t, review = null) {
  if (![" ", "+", "-"].includes(row.kind)) return header(row, t, review);
  const color = tone(row, t);
  return reviewLine(h_flex().w_full().h(20).flex_none().items_center().when(Boolean(color), e => e.bg(color + LINE))
    .child(div().w(3).h_full().flex_none().when(Boolean(color), e => e.bg(color + BAR)))
    .child(number(row.old, t, color)).child(number(row.next, t, color))
    .child(div().w(16).flex_none().pl(4).text_color(color ?? t.dim).child(color ? row.kind : ""))
    .child(lineText(row, color)), row, row.kind === "-" ? "before" : "after", review, t);
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

function splitCell(line, before, t, id, review = null) {
  const color = tone(line, t), wide = (line?.text.length ?? 0) > 36;
  return reviewLine(h_flex().id(id).flex_1().min_w(0).h_full().items_center().overflow_hidden()
    .when(!line, e => e.bg(t.dim + "0f"))
    .when(Boolean(color), e => e.bg(color + LINE))
    .when(wide, e => e.tooltip(line.text))
    .child(div().w(3).h_full().flex_none().when(Boolean(color), e => e.bg(color + BAR)))
    .child(number(before ? line?.old : line?.next, t, color))
    .child(div().w(16).flex_none().pl(4).text_color(color ?? t.dim).child(color ? line.kind : ""))
    .child(lineText(line, color)), line, before ? "before" : "after", review, t);
}

/** Both halves share one row, so they cannot drift; each half is exactly half the view. */
export function splitDiffRow(row, t, index = 0, review = null) {
  if (row.header) return header(row.header, t, review);
  return h_flex().w_full().h(20).flex_none()
    .child(splitCell(row.before, true, t, `split-${index}-before`, review))
    .child(div().w(1).h_full().flex_none().bg(t.border))
    .child(splitCell(row.after, false, t, `split-${index}-after`, review));
}

/** Column titles over the split view, in the same halves as its rows. */
export function splitHeader(counts, t) {
  const title = (label, count, color, sign) => h_flex().flex_1().min_w(0).px(10).gap(6).items_center()
    .child(div().child(label)).when(count > 0, e => e.child(div().text_color(color).child(`${sign}${count}`)));
  return h_flex().h(22).flex_none().items_center().text_size(TYPE.xs).text_color(t.dim).border_b(1).border_color(t.border)
    .child(title("Before", counts.removed, t.ansi1, "−"))
    .child(div().w(1).h_full().flex_none().bg(t.border))
    .child(title("After", counts.added, t.ansi2, "+"));
}

export function diffView(view, t, font) {
  const side = view.diffMode === "split", rows = side ? view.split : view.rows;
  const request = view.diffRequest, mode = view.diffMode;
  // Inline scrolls sideways for long lines; split halves fit the view and truncate (hover shows the line).
  return div().flex_1().min_h(0).relative().font_family(font).text_size(TYPE.sm)
    .on_mouse_down("left", event => { view.diffReviewPress = { request, mode, event: reviewPress(event) }; })
    .on_size_change((size, cx) => { if (Math.abs((view.diffViewport || 0) - size.width) > 2) { view.diffViewport = size.width; cx.notify(); } })
    .child(div().id("changes-diff-x").size_full().when(!side, e => e.overflow_x_scrollbar())
      .child(div().w_full().when(!side, e => e.min_w(view.diffWidth)).h_full().child(v_virtual_list("changes-diff", rows.length, 20, i => `${request}:${mode}:${i}`,
        range => rows.slice(range.start, range.end).map((row, i) => side ? splitDiffRow(row, t, range.start + i, view) : inlineDiffRow(row, t, view)))
        .on_item_click((key, cx) => pickReviewRow(view, rows, request, mode, key, cx))
        .on_item_secondary_click((key, event, cx) => pickReviewRow(view, rows, request, mode, key, cx, event, true))
        .track_scroll(view.diffScroll).size_full())))
    .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
    .when(!rows.length, e => e.child(div().absolute().top(8).px(12).text_color(t.dim).child(view.diffLoading ? "Loading diff…" : "Select a file to view its diff")));
}
