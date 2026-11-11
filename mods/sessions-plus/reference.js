import { div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { agents, terminals, panes, shared, setShared, theme, closeOverlay, openOverlay } from "herdr";
import { PROMPT_QUEUE_KEY, QUEUE_LIMITS, promptTargets, samePromptTarget, appendPrompt } from "./prompt-queue-model.js";
import { referencePayload, referenceMachineMatches } from "./reference-model.js";

export default class Reference {
  init(p, cx) {
    this.p = p; this.handle = cx.focus_handle(); this.handle.focus(); this.error = ""; this.selected = null; this.added = false;
    try { this.payload = referencePayload(p); }
    catch (error) { this.error = String(error.message || error); this.payload = { title: "Add reference", text: "", machine: null, invalid: true }; }
    this.editor = EditorState.new({ value: this.payload.text, language: "markdown", readonly: false, line_numbers: false, folding: false, soft_wrap: true });
    this.editor.on("change", (_event, cx) => { if (!this.payload.invalid) this.error = ""; cx.notify(); });
  }
  targets() { return promptTargets(agents(), terminals(), panes()).filter(target => referenceMachineMatches(this.payload, target)); }
  add(cx) {
    if (this.added || this.disposed) return;
    try {
      if (this.payload.invalid) throw new Error("This reference is invalid.");
      const target = this.targets().find(target => samePromptTarget(this.selected, target));
      if (!target) throw new Error("Choose a live recipient. An exited or replaced agent cannot receive this reference.");
      const next = appendPrompt(shared(PROMPT_QUEUE_KEY), target, this.editor.value());
      setShared(PROMPT_QUEUE_KEY, next); this.added = true;
      closeOverlay(this.p.overlay);
      openOverlay({ mod: "sessions-plus", kind: "dialog", frame: "none", width: 660, height: 650, props: { role: "prompt-queue", target } });
    } catch (error) { this.error = String(error.message || error); cx.notify(); }
  }
  close() { this.disposed = true; this.editor?.release(); }
  render() {
    const t = theme(), targets = this.targets(), selected = targets.some(target => samePromptTarget(this.selected, target));
    const button = (id, label, action, disabled = false) => div().id(id).h(28).px(9).rounded(5).bg(t.raised).text_color(disabled ? t.dim : t.foreground).flex().items_center().when(!disabled, el => el.cursor_pointer().hover(row => row.bg(t.hover))).on_click((_e, cx) => { if (!disabled) action(cx); }).child(label);
    return v_flex().id("queue-reference").size_full().min_h(0).p(16).gap(9).rounded(10).border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(12).track_focus(this.handle)
      .on_key_down((event, cx) => { if (event.key === "escape") { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(div().font_semibold().text_size(15).child(this.payload.title))
      .child(div().text_color(t.muted).child("Choose a recipient and add your instructions. This adds a pending item; it does not send a message."))
      .child(div().id("reference-recipients").max_h(140).overflow_y_scrollbar().children(targets.slice(0, 200).map(target => div().id(`reference-recipient-${target.address}`).px(8).py(6).rounded(5).truncate().cursor_pointer().bg(samePromptTarget(this.selected, target) ? t.selected : t.background).hover(row => row.bg(t.hover))
        .on_click((_e, cx) => { this.selected = { ...target }; cx.notify(); }).child(`${samePromptTarget(this.selected, target) ? "●" : "○"} ${target.title} · ${target.address}`))))
      .when(!targets.length, el => el.child(div().text_color(t.blocked).child("No supported live agent on the reference's machine. Your text remains available to copy.")))
      .child(div().flex_1().min_h(100).border_1().border_color(t.border).rounded(6).child(Editor.new(this.editor).size_full()))
      .child(div().text_size(10.5).text_color(t.dim).child(`Up to ${QUEUE_LIMITS.text.toLocaleString()} characters. Existing queue items and its composer draft are preserved.`))
      .when(Boolean(this.error), el => el.child(div().text_color(t.ansi1).child(this.error)))
      .child(h_flex().flex_none().gap(8).justify_end().child(button("reference-copy", "Copy text", cx => cx.write_to_clipboard(this.editor.value())))
        .child(button("reference-cancel", "Cancel", () => closeOverlay(this.p.overlay)))
        .child(button("reference-add", "Add to pending prompts", cx => this.add(cx), !selected || this.payload.invalid)));
  }
}
