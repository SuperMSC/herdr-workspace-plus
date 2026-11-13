import { TYPE } from "./type-scale.js";
import { div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { agents, terminals, exec, hc, readTextFile, shared, setShared, theme, closeOverlay, openOverlay } from "herdr";
import { createGitReader } from "./git-reader.js";
import { REVIEW_KEY, MESSAGE_LIMIT, reviewState, saveReview, reviewFileKey, reviewMessage, commentLabel, reviewTargets, validateReviewTarget, validateReviewCoreTarget, reviewSendAcknowledged } from "./review-model.js";

export default class Review {
  init(p, cx) {
    this.p = p; this.context = p.context; this.handle = cx.focus_handle(); this.handle.focus();
    this.versions = { ...(p.versions || {}) }; this.error = ""; this.selected = null; this.busy = false;
    const current = this.state();
    this.createEditor(current.message ?? reviewMessage(current, this.context, this.versions), Boolean(current.delivery));
    this.revision = this.commentRevision(); this.verify(cx);
  }
  createEditor(value, locked) {
    this.editor?.release(); this.locked = locked;
    this.editor = EditorState.new({ value, language: "markdown", readonly: locked, line_numbers: false, folding: false, soft_wrap: true });
    this.editor.on("change", (_event, cx) => { const current = this.state(); if (!current.delivery) this.save({ ...current, message: this.editor.value() }); cx.notify(); });
  }
  state() { return reviewState(shared(REVIEW_KEY), this.context); }
  save(value) { setShared(REVIEW_KEY, saveReview(shared(REVIEW_KEY), this.context, value)); }
  commentRevision() { return JSON.stringify(this.state().comments || []); }
  verify(cx) {
    if (this.disposed) return;
    if (this.checking || this.busy) { this.verifyAgain = true; return; }
    this.checking = true; this.verifyAgain = false;
    const comments = [...(this.state().comments || [])], revision = this.commentRevision();
    cx.spawn(async cx => {
      try {
        const versions = {}, reader = createGitReader(exec, readTextFile, this.context);
        for (const comment of comments) {
          if (this.disposed) return;
          const key = reviewFileKey(comment.file); if (key in versions) continue;
          try { versions[key] = await reader.reviewVersion(comment.file); } catch { versions[key] = null; }
        }
        if (!this.disposed && this.commentRevision() === revision) { this.versions = versions; this.verification = revision; }
      } catch (error) {
        if (!this.disposed && this.commentRevision() === revision) this.error = `Cannot verify review sources: ${String(error.message || error)}`;
      } finally {
        this.checking = false;
        if (!this.disposed) {
          // A skipped request, or a newer shared draft, gets one coalesced follow-up.
          const again = this.verifyAgain || this.commentRevision() !== revision;
          this.verifyAgain = false;
          if (again) this.verify(cx);
          cx.notify();
        }
      }
    });
  }
  regenerate(cx) {
    if (this.busy || this.state().delivery) return;
    this.save({ ...this.state(), message: null, messageStale: false }); this.editor.set_value(reviewMessage(this.state(), this.context, this.versions)); cx.notify();
  }
  remove(id, cx) {
    const current = this.state(); if (this.busy || current.delivery) return;
    this.save({ ...current, message: current.message ?? null, messageStale: Boolean(current.message != null || current.messageStale), comments: (current.comments || []).filter(comment => comment.id !== id) });
    if (this.state().message == null) this.editor.set_value(reviewMessage(this.state(), this.context, this.versions)); this.revision = this.commentRevision(); this.verify(cx); cx.notify();
  }
  edit(comment) {
    if (this.busy || this.state().delivery) return;
    openOverlay({ mod: "files-plus", kind: "dialog", frame: "none", width: 620, height: 420, props: { role: "review-comment", context: this.context, commentId: comment.id } });
  }
  send(cx) {
    if (this.busy || this.state().delivery) return;
    try {
      const selected = validateReviewTarget(this.selected, agents(), terminals(), this.context.on);
      const message = this.editor.value().trim(), current = this.state();
      if (!current.comments?.length || !message || message.length > MESSAGE_LIMIT) throw new Error(`A review needs comments and 1–${MESSAGE_LIMIT.toLocaleString()} message characters.`);
      if (current.messageStale) throw new Error("Comments changed after this message was edited. Regenerate it or explicitly keep the edited message.");
      if (this.checking || this.verification !== this.commentRevision()) throw new Error("Wait for source verification before sending.");
      const token = `${Date.now()}-${Math.random()}`;
      this.save({ ...current, message, delivery: { token, status: "sending", address: selected.address, started: Date.now() } });
      this.createEditor(message, true); this.busy = true; this.error = ""; cx.notify();
      cx.spawn(async cx => {
        let attempted = false;
        try {
          const fresh = {}, reader = createGitReader(exec, readTextFile, this.context);
          for (const comment of current.comments) {
            const key = reviewFileKey(comment.file); if (key in fresh) continue;
            try { fresh[key] = await reader.reviewVersion(comment.file); } catch { fresh[key] = null; }
          }
          if (Object.keys(fresh).some(key => fresh[key] !== this.versions[key])) { this.versions = fresh; throw new Error("Source versions changed. Check the outdated markers and regenerate the message before sending."); }
          const check = await hc(["get", selected.address, "--json"]);
          if (check.code !== 0) throw new Error("Core could not verify the receiving terminal.");
          let freshTerminal;
          try { freshTerminal = JSON.parse(check.stdout); } catch { throw new Error("Core returned an invalid terminal identity."); }
          validateReviewCoreTarget(selected, agents(), terminals(), freshTerminal, this.context.on);
          attempted = true;
          const result = await hc(["send", selected.address, message, "--if", "idle", "--json"]);
          if (!reviewSendAcknowledged(result)) throw new Error("Core did not confirm delivery.");
          const latest = this.state();
          if (latest.delivery?.token === token) this.save({ ...latest, delivery: { ...latest.delivery, status: "sent", finished: Date.now() } });
        } catch (error) {
          const latest = this.state();
          if (latest.delivery?.token === token) this.save({ ...latest, delivery: attempted ? { ...latest.delivery, status: "uncertain" } : null });
          this.error = attempted ? "Delivery was not confirmed. The draft is kept and will not be resent automatically. Check the agent or copy the message." : String(error.message || error);
          if (!attempted && !this.disposed) this.createEditor(message, false);
        } finally { this.busy = false; if (!this.disposed) { if (this.verifyAgain) this.verify(cx); cx.notify(); } }
      });
    } catch (error) { this.error = String(error.message || error); cx.notify(); }
  }
  newReview(cx) {
    const current = this.state();
    if (this.busy || current.delivery?.status !== "sent") return;
    this.save({ ...current, comments: [], message: null, messageStale: false, delivery: null, previous: { message: current.message, address: current.delivery.address, finished: current.delivery.finished } });
    this.createEditor(reviewMessage(this.state(), this.context, {}), false); this.selected = null; this.error = ""; this.revision = this.commentRevision(); this.verify(cx); cx.notify();
  }
  unlock(cx) {
    if (this.busy) return;
    if (!this.unlockArmed) { this.unlockArmed = true; cx.notify(); return; }
    const current = this.state(); this.save({ ...current, delivery: null }); this.createEditor(current.message ?? this.editor.value(), false); this.unlockArmed = false; this.selected = null; this.error = "Sending unlocked. Check the agent for an earlier delivery before sending again."; cx.notify();
  }
  scheduleSync(cx) {
    if (this.syncScheduled || (this.commentRevision() === this.revision && this.locked === Boolean(this.state().delivery)) || this.busy) return;
    this.syncScheduled = true;
    cx.timer.after(0, cx => {
      this.syncScheduled = false; if (this.disposed) return;
      this.revision = this.commentRevision();
      this.createEditor(this.state().message ?? reviewMessage(this.state(), this.context, this.versions), Boolean(this.state().delivery)); this.verify(cx); cx.notify();
    });
  }
  close() { this.disposed = true; this.editor?.release(); }
  render(cx) {
    this.scheduleSync(cx);
    const t = theme(), state = this.state(), comments = state.comments || [], targets = reviewTargets(agents(), terminals(), this.context.on);
    const locked = Boolean(state.delivery), selected = targets.find(target => target.identity === this.selected?.identity);
    const enabled = !locked && !this.busy && !this.checking && selected && ["idle", "done"].includes(selected.status) && comments.length > 0 && !state.messageStale;
    const action = (id, label, callback, disabled = false) => div().id(id).h(28).px(9).rounded(5).bg(t.raised).text_color(disabled ? t.dim : t.foreground).flex().items_center().when(!disabled, el => el.cursor_pointer().hover(row => row.bg(t.hover))).on_click((event, cx) => { if (!disabled) callback(event, cx); }).child(label);
    return v_flex().id("review-draft").size_full().min_h(0).p(16).gap(9).rounded(10).border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(TYPE.md).track_focus(this.handle)
      .on_key_down((event, cx) => { if (event.key === "escape" && !this.busy) { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(h_flex().flex_none().gap(8).items_center().child(div().font_semibold().text_size(TYPE.lg).child(`Review · ${comments.length} comments`)).child(div().flex_1())
        .child(action("review-copy", "Copy message", (_event, cx) => cx.write_to_clipboard(this.editor.value())))
        .when(Boolean(state.messageStale), el => el.child(action("review-keep-edited", "Keep edited message", (_event, cx) => { this.save({ ...this.state(), messageStale: false }); cx.notify(); }, locked || this.busy)))
        .child(action("review-regenerate", "Regenerate", (_event, cx) => this.regenerate(cx), locked || this.busy)))
      .when(Boolean(state.messageStale), el => el.child(div().flex_none().text_color(t.blocked).child("Comments changed. Your edited message is kept; regenerate it or explicitly keep it before sending.")))
      .child(div().flex_none().truncate().text_color(t.dim).tooltip(this.context.root).child(this.context.root))
      .child(div().id("review-comments").max_h(160).overflow_y_scrollbar().children(comments.map(comment => h_flex().id(`review-note-${comment.id}`).gap(6).py(4).items_center()
        .child(v_flex().flex_1().min_w(0).gap(2).child(div().truncate().child(commentLabel(comment)))
          .child(div().truncate().text_color(t.muted).child(comment.text))
          .when(this.versions[reviewFileKey(comment.file)] !== comment.version, el => el.child(div().text_color(t.blocked).text_size(TYPE.xs).child("Outdated / source not verified · original lines are retained"))))
        .child(action(`review-edit-${comment.id}`, "Edit", () => this.edit(comment), locked || this.busy))
        .child(action(`review-remove-${comment.id}`, "Remove", (_event, cx) => this.remove(comment.id, cx), locked || this.busy)))))
      .child(div().flex_1().min_h(100).border_1().border_color(t.border).rounded(6).child(Editor.new(this.editor).size_full()))
      .child(div().flex_none().text_size(TYPE.xs).text_color(t.dim).child(locked ? state.delivery.status === "sent" ? `Sent to ${state.delivery.address}. Draft retained.` : `Delivery ${state.delivery.status}. Draft retained; automatic resend is disabled.` : this.checking ? "Verifying original source versions…" : "Choose the receiving agent, check this message, then send once. Original code stays attached to outdated comments."))
      .child(div().id("review-targets").max_h(100).overflow_y_scrollbar().children(targets.map(target => div().id(`review-target-${target.address}`).px(8).py(5).rounded(5).truncate().bg(target.identity === selected?.identity ? t.selected : t.background).when(!locked && !this.busy, el => el.cursor_pointer().hover(row => row.bg(t.hover))).on_click((_event, cx) => { if (!locked && !this.busy) { this.selected = { ...target }; cx.notify(); } }).child(`${target.identity === selected?.identity ? "●" : "○"} ${target.title} · ${target.space} · ${target.address} · ${target.status}`))))
      .when(!targets.length, el => el.child(div().text_color(t.dim).child("No live agent on this machine. Copy the review instead.")))
      .when(Boolean(this.error), el => el.child(div().text_color(t.ansi1).child(this.error)))
      .child(h_flex().flex_none().gap(8).justify_end()
        .when(state.delivery?.status === "sent" && !this.busy, el => el.child(action("review-new", "New review", (_event, cx) => this.newReview(cx))))
        .when(locked && !this.busy, el => el.child(action("review-unlock", this.unlockArmed ? "Confirm unlock (may duplicate)" : "Unlock another send…", (_event, cx) => this.unlock(cx))))
        .child(action("review-close", "Close", () => closeOverlay(this.p.overlay), this.busy))
        .child(action("review-send", this.busy ? "Sending…" : "Send review", (_event, cx) => this.send(cx), !enabled)));
  }
}
