import { div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { shared, setShared, theme, closeOverlay } from "herdr";
import { REVIEW_KEY, reviewState, saveReview, addReviewComment, commentLabel, COMMENT_LIMIT } from "./review-model.js";

export default class ReviewComment {
  init(p, cx) {
    this.p = p; this.context = p.context; this.handle = cx.focus_handle(); this.handle.focus();
    this.editing = p.commentId !== null && p.commentId !== undefined; this.id = this.editing ? p.commentId : null;
    const original = this.editing ? reviewState(shared(REVIEW_KEY), this.context).comments?.find(comment => comment.id === this.id) : null;
    this.anchor = this.editing ? original : p.anchor; this.missing = this.editing && !original;
    this.error = this.missing ? "This comment was removed in another view. Reopen the review." : "";
    this.editor = EditorState.new({ value: original?.text || "", language: "markdown", line_numbers: false, folding: false, soft_wrap: true, readonly: false });
    this.editor.on("change", (_event, cx) => { if (!this.missing) this.error = ""; cx.notify(); });
  }
  save(cx) {
    try {
      const current = reviewState(shared(REVIEW_KEY), this.context);
      if (this.editing && !current.comments?.some(comment => comment.id === this.id)) throw new Error("This comment was removed in another view. Reopen the review.");
      const next = addReviewComment(current, this.anchor, this.editor.value(), this.id);
      setShared(REVIEW_KEY, saveReview(shared(REVIEW_KEY), this.context, next));
      closeOverlay(this.p.overlay);
    } catch (error) { this.error = String(error.message || error); cx.notify(); }
  }
  close() { this.editor?.release(); }
  render() {
    const t = theme();
    const action = (id, title, callback) => div().id(id).h(30).px(10).rounded(6).bg(t.raised).flex().items_center().cursor_pointer().hover(el => el.bg(t.hover)).on_click(callback).child(title);
    return v_flex().id("review-comment").size_full().min_h(0).p(18).gap(10).rounded(10).border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(12).track_focus(this.handle)
      .on_key_down((event, cx) => { if (event.key === "escape") { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(div().font_semibold().text_size(15).child(this.editing ? "Edit review comment" : "Add review comment"))
      .child(div().text_color(t.muted).truncate().tooltip(this.anchor ? commentLabel(this.anchor) : "").child(this.anchor ? commentLabel(this.anchor) : "No selection"))
      .when(Boolean(this.anchor?.snippet), el => el.child(div().max_h(100).overflow_y_scrollbar().p(8).bg(t.background).text_size(11).child(this.anchor.snippet)))
      .child(div().flex_1().min_h(90).border_1().border_color(t.border).rounded(6).child(Editor.new(this.editor).size_full()))
      .child(div().text_size(10).text_color(t.dim).child(`Saved locally as a review draft · up to ${COMMENT_LIMIT.toLocaleString()} characters`))
      .when(Boolean(this.error), el => el.child(div().text_color(t.ansi1).child(this.error)))
      .child(h_flex().flex_none().gap(8).justify_end()
        .child(action("review-comment-cancel", "Cancel", () => closeOverlay(this.p.overlay)))
        .child(action("review-comment-save", "Save comment", (_event, cx) => this.save(cx))));
  }
}
