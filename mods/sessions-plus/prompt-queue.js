import { TYPE } from "./type-scale.js";
import { div } from "gpui-kit";
import { v_flex, h_flex, Textarea, TextareaState } from "gpui-base";
import { agents, terminals, panes, focused, shared, setShared, theme, exec, hc, closeOverlay, run } from "herdr";
import { PROVIDERS } from "./model.js";
import { PROMPT_QUEUE_KEY, QUEUE_LIMITS, promptTargets, samePromptTarget, queueState, queueFor, saveComposer, savePrompt, removePrompt, clearPromptQueue, preparePrompts, beginPromptSend, finishPromptSend, resolvePromptDelivery } from "./prompt-queue-model.js";
import { deliverPrompts } from "./prompt-queue-client.js";
import { saveQueueDraft, removeQueueDraft, assignQueueDraft } from "./prompt-queue-model.js";
import { referencePayload, referenceMachineMatches } from "./reference-model.js";

export default class PromptQueue {
  init(p, cx) {
    this.p = p;
    this.handle = cx.focus_handle();
    const focus = focused(), initial = p.target?.key ? { ...p.target } : this.targets().find(target => target.address === (focus?.shown || focus?.agent || focus?.terminal));
    this.target = initial || null;
    this.choosing = !this.target;
    this.editId = null; this.error = ""; this.busy = false; this.prepared = null; this.confirmClear = false; this.checkId = null;
    this.draftId = null;
    if (p.reference || typeof p.text === "string") {
      try {
        const next = saveQueueDraft(this.read(), referencePayload(p));
        setShared(PROMPT_QUEUE_KEY, next); this.draftId = next.drafts.at(-1).id;
        this.previousTarget = this.target; this.target = null; this.choosing = false;
      } catch (error) { this.error = String(error.message || error); }
    }
    this.input = TextareaState.new({ placeholder: "An instruction for this agent…", value: this.draftId ? this.draft().text : this.target ? this.queue().composer : "", rows: 3 });
    this.input.on("change", (_event, cx) => {
      if (this.loadingInput) return;
      if (this.draftId) {
        try { this.write(saveQueueDraft(this.read(), { ...this.draft(), text: this.input.value() }, this.draftId), cx); }
        catch (error) { this.error = String(error.message || error); cx.notify(); }
        return;
      }
      if (this.loadingInput || !this.target || this.busy || this.prepared) return;
      try { this.write(saveComposer(this.read(), this.target, this.input.value()), cx); }
      catch (error) { this.error = String(error.message || error); cx.notify(); }
    });
    this.input.focus();
    this.scheduleExpiry(cx);
  }

  scheduleExpiry(cx) {
    if (!cx?.timer) return;
    const now = Date.now(), deadlines = this.queue().items.map(item => Number(item.activeUntil) || 0).filter(deadline => deadline > now);
    const earliest = deadlines.length ? Math.min(...deadlines) : 0;
    if (this.expiryAt === earliest) return;
    this.expiryAt = earliest;
    if (earliest) cx.timer.after(Math.max(1, earliest - now + 1), cx => {
      if (this.expiryAt !== earliest) return;
      this.expiryAt = 0; cx.notify();
    });
  }

  targets() { return promptTargets(agents(), terminals(), panes()); }
  draft() { return this.read().drafts?.find(item => item.id === this.draftId); }
  read() { return queueState(shared(PROMPT_QUEUE_KEY)); }
  queue() { return queueFor(this.read(), this.target); }
  current() { return this.targets().find(target => samePromptTarget(this.target, target)) || null; }
  write(value, cx) { setShared(PROMPT_QUEUE_KEY, value); this.error = ""; cx.notify(); }
  setInput(value) { this.loadingInput = true; this.input.set_value(value); this.loadingInput = false; }

  choose(target, cx) {
    if (this.busy || this.prepared) return;
    if (this.draftId) {
      try {
        const fresh = this.targets().find(item => samePromptTarget(target, item));
        if (!fresh) throw new Error("Choose a live recipient; this agent changed or exited.");
        const next = saveQueueDraft(this.read(), { ...this.draft(), text: this.input.value() }, this.draftId);
        this.write(assignQueueDraft(next, this.draftId, fresh), cx);
        this.draftId = null; this.previousTarget = null; this.target = { ...fresh }; this.editId = null; this.choosing = false;
        this.setInput(this.queue().composer); this.input.focus();
      } catch (error) { this.error = String(error.message || error); cx.notify(); }
      return;
    }
    if (this.target) {
      try { setShared(PROMPT_QUEUE_KEY, saveComposer(this.read(), this.target, this.input.value())); }
      catch (error) { this.error = String(error.message || error); cx.notify(); return; }
    }
    this.target = { ...target }; this.editId = null; this.choosing = false; this.confirmClear = false; this.checkId = null;
    this.setInput(this.queue().composer); this.error = ""; this.input.focus(); cx.notify();
  }

  save(cx) {
    if (!this.target || this.busy || this.prepared) return;
    try {
      this.write(savePrompt(this.read(), this.target, this.input.value(), this.editId), cx);
      this.editId = null; this.setInput(""); this.input.focus();
    } catch (error) { this.error = String(error.message || error); cx.notify(); }
  }

  openDraft(id, cx) {
    if (this.busy || this.prepared) return;
    const draft = this.read().drafts?.find(item => item.id === id); if (!draft) return;
    if (this.target) {
      try { setShared(PROMPT_QUEUE_KEY, saveComposer(this.read(), this.target, this.input.value())); }
      catch (error) { this.error = String(error.message || error); cx.notify(); return; }
    }
    this.previousTarget = this.target; this.target = null; this.draftId = id; this.choosing = false; this.editId = null;
    this.setInput(draft.text); this.error = ""; this.input.focus(); cx.notify();
  }

  leaveDraft(cx, remove = false) {
    if (remove) this.write(removeQueueDraft(this.read(), this.draftId), cx);
    this.draftId = null; this.target = this.previousTarget || null; this.previousTarget = null; this.choosing = !this.target;
    this.setInput(this.target ? this.queue().composer : ""); cx.notify();
  }

  edit(item, cx) {
    if (this.busy || this.prepared || item.status === "uncertain") return;
    if (this.input.value() && (this.editId !== item.id || this.input.value() !== item.text)) {
      this.error = "Add, save, or cancel the current draft before editing another instruction."; cx.notify(); return;
    }
    this.editId = item.id; this.setInput(item.text);
    try { this.write(saveComposer(this.read(), this.target, item.text), cx); }
    catch (error) { this.error = String(error.message || error); cx.notify(); }
    this.input.focus();
  }

  cancelEdit(cx) {
    this.editId = null; this.setInput("");
    try { this.write(saveComposer(this.read(), this.target, ""), cx); }
    catch (error) { this.error = String(error.message || error); cx.notify(); }
  }

  remove(id, cx) {
    if (this.busy || this.prepared) return;
    try { this.write(removePrompt(this.read(), this.target, id), cx); if (this.editId === id) this.cancelEdit(cx); }
    catch (error) { this.error = String(error.message || error); cx.notify(); }
  }

  prepare(ids, cx) {
    if (!this.current() || this.busy || this.editId) return;
    try { this.prepared = preparePrompts(this.read(), this.target, ids); this.error = ""; }
    catch (error) { this.error = String(error.message || error); }
    cx.notify();
  }

  send(cx) {
    if (!this.prepared || this.busy) return;
    const prepared = this.prepared, attempt = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      if (!this.current()) throw new Error("The selected agent changed or ended. Choose it again before sending.");
      this.write(beginPromptSend(this.read(), prepared, attempt), cx);
    } catch (error) { this.error = String(error.message || error); cx.notify(); return; }
    this.busy = true;
    cx.spawn(async cx => {
      let accepted = false;
      try {
        await deliverPrompts(prepared, {
          current: () => this.targets().find(target => samePromptTarget(prepared.target, target)),
          inspect: address => hc(["get", "--json", address]),
          send: args => exec("hc", args, { timeout: 15000 }),
        });
        accepted = true;
      } catch { this.error = "Delivery was not confirmed. Check the recipient; nothing will be retried automatically."; }
      finally {
        try { setShared(PROMPT_QUEUE_KEY, finishPromptSend(this.read(), prepared.target, attempt, accepted)); }
        catch { this.error = "The delivery result could not be saved. Check the recipient before retrying."; }
        this.busy = false; this.prepared = null; cx.notify();
      }
    });
  }

  resolve(id, delivered, cx) {
    if (this.busy) return;
    try { this.write(resolvePromptDelivery(this.read(), this.target, id, delivered), cx); this.checkId = null; }
    catch (error) { this.error = String(error.message || error); cx.notify(); }
  }

  clear(cx) {
    if (this.busy || !this.target) return;
    try {
      this.write(clearPromptQueue(this.read(), this.target.key), cx);
      this.editId = null; this.confirmClear = false; this.checkId = null; this.setInput("");
    } catch (error) { this.error = String(error.message || error); cx.notify(); }
  }

  render(cx) {
    this.scheduleExpiry(cx);
    const t = theme(), queue = this.queue(), current = this.current(), pending = queue.items.filter(item => item.status === "pending");
    const button = (id, label, callback, disabled = false, primary = false) => div().id(id).px(9).py(6).rounded(5).flex_none()
      .bg(primary ? t.solid : t.raised).text_color(disabled ? t.dim : primary ? t.solid_foreground : t.foreground)
      .when(!disabled, el => el.cursor_pointer().hover(el => el.bg(t.hover))).disabled(disabled)
      .on_click((_event, cx) => { cx.stop_propagation(); if (!disabled) callback(cx); }).child(label);
    const targetLabel = target => `${PROVIDERS[target.provider] || "Agent"} · ${target.title || target.address}`;
    const draft = this.draft(), drafts = this.read().drafts || [];
    const live = this.targets().filter(target => !this.draftId || draft && referenceMachineMatches(draft, target)), saved = this.draftId ? [] : this.read().queues.filter(saved => !live.some(target => target.key === saved.key));
    const chooser = v_flex().id("prompt-queue-recipients").flex_1().min_h(0).gap(5).overflow_y_scrollbar()
      .child(div().font_semibold().child("Live agents"))
      .children(live.map(target => button(`prompt-recipient-${target.address}`, targetLabel(target), cx => this.choose(target, cx))))
      .when(!live.length, el => el.child(div().text_color(t.muted).child("No supported live agents. Start Claude Code, Codex, or agy first.")))
      .when(saved.length > 0, el => el.child(div().pt(9).font_semibold().child("Saved queues · View or clear")))
      .children(saved.map(saved => button(`prompt-saved-${saved.key}`, `${targetLabel(saved.target)} · ${saved.items.length} instructions`, cx => this.choose(saved.target, cx))));
    const row = item => v_flex().id(`prompt-item-${item.id}`).gap(6).p(9).rounded(6).bg(t.raised)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().text_size(TYPE.xs).text_color(item.status === "uncertain" ? t.blocked : item.status === "sent" ? t.done : t.muted)
          .child(item.status === "uncertain" ? this.busy || item.activeUntil > Date.now() ? "Sending…" : "Delivery unconfirmed" : item.status === "sent" ? "Sent" : "Pending"))
        .child(button(`prompt-edit-${item.id}`, "Edit", cx => this.edit(item, cx), this.busy || item.status === "uncertain"))
        .child(button(`prompt-remove-${item.id}`, "Remove", cx => this.remove(item.id, cx), this.busy || item.activeUntil > Date.now()))
        .when(item.status === "pending", el => el.child(button(`prompt-send-${item.id}`, "Preview send…", cx => this.prepare([item.id], cx), this.busy || !current || Boolean(this.editId))))
        .when(item.status === "uncertain", el => el.child(button(`prompt-check-${item.id}`, "Check delivery…", cx => { this.checkId = this.checkId === item.id ? null : item.id; cx.notify(); }, this.busy || item.activeUntil > Date.now()))))
      .child(div().text_color(item.status === "sent" ? t.muted : t.foreground).child(item.text))
      .when(this.checkId === item.id, el => el.child(v_flex().gap(5)
        .child(div().text_size(TYPE.sm).text_color(t.blocked).child("Check the agent first. A timed-out send may already have arrived."))
        .child(h_flex().gap(6)
          .child(button(`prompt-delivered-${item.id}`, "It arrived · mark sent", cx => this.resolve(item.id, true, cx)))
          .child(button(`prompt-retry-${item.id}`, "It did not arrive · allow retry", cx => this.resolve(item.id, false, cx))))));
    const body = this.draftId ? v_flex().id("prompt-draft-editor").flex_1().min_h(0).gap(8)
      .child(div().font_semibold().child(draft?.title || "Reference draft"))
      .child(div().text_size(TYPE.sm).text_color(t.muted).child(`Choose an agent${draft?.machine ? " on " + draft.machine : draft?.machine === "" ? " on this computer" : ""} to add this draft to its queue.`))
      .child(div().flex_1().min_h(100).border_1().border_color(t.border).rounded(6).p(7).child(Textarea.new(this.input).size_full()))
      .child(div().text_size(TYPE.xs).text_color(t.dim).child(`${this.input.value().length.toLocaleString()} characters · up to ${QUEUE_LIMITS.text.toLocaleString()} per instruction`))
      .child(chooser.max_h(220))
      .child(h_flex().gap(7).justify_end().child(button("prompt-draft-remove", "Remove draft", cx => this.leaveDraft(cx, true))).child(button("prompt-draft-keep", "Keep draft", cx => this.leaveDraft(cx))))
      : this.choosing ? chooser : this.prepared ? v_flex().id("prompt-send-preview").flex_1().min_h(0).gap(9)
      .child(div().font_semibold().child(`Send ${this.prepared.items.length} instruction${this.prepared.items.length === 1 ? "" : "s"} to this agent`))
      .child(div().text_color(t.muted).child("The message below is sent once, only when you click Send."))
      .child(div().id("prompt-message-preview").flex_1().min_h(0).p(10).rounded(6).bg(t.raised).overflow_y_scrollbar().child(this.prepared.message))
      .child(h_flex().gap(7).justify_end()
        .child(button("prompt-preview-back", "Back", cx => { this.prepared = null; cx.notify(); }, this.busy))
        .child(button("prompt-preview-send", this.busy ? "Sending…" : "Send", cx => this.send(cx), this.busy || !current, true)))
      : v_flex().id("prompt-queue-body").flex_1().min_h(0).gap(9)
        .child(v_flex().id("prompt-queue-items").flex_1().min_h(0).gap(7).overflow_y_scrollbar().children(queue.items.map(row))
          .when(!queue.items.length, el => el.child(div().p(10).text_color(t.muted).child("No instructions yet. Write one below while the agent works."))))
        .child(div().h(92).flex_none().border_1().border_color(t.border).rounded(6).p(7).child(Textarea.new(this.input).size_full()))
        .child(h_flex().gap(7).items_center()
          .child(div().flex_1().text_size(TYPE.xs).text_color(t.muted).tooltip(this.editId ? "Editing an instruction makes it pending again." : "Saved locally").child(`${queue.items.length}/${QUEUE_LIMITS.items} instructions`))
          .when(Boolean(this.editId), el => el.child(button("prompt-cancel-edit", "Cancel edit", cx => this.cancelEdit(cx), this.busy)))
          .child(button("prompt-save", this.editId ? "Save edit" : "Add instruction", cx => this.save(cx), this.busy || !this.target, true)))
        .child(h_flex().gap(7).justify_between()
          .child(button("prompt-clear", "Clear queue…", cx => { this.confirmClear = true; cx.notify(); }, this.busy || queue.items.some(item => item.activeUntil > Date.now()) || !queue.items.length && !queue.composer))
          .child(button("prompt-send-all", `Preview send all (${pending.length})…`, cx => this.prepare(pending.map(item => item.id), cx), this.busy || !current || !pending.length || Boolean(this.editId)).tooltip("Only your explicit Send submits a message. Existing input drafts are respected.")))
        .when(this.confirmClear, el => el.child(v_flex().gap(5).p(8).rounded(5).bg(t.raised)
          .child(div().text_size(TYPE.sm).child("Clear this queue and its draft? This does not cancel a message already submitted."))
          .child(h_flex().gap(7).justify_end()
            .child(button("prompt-clear-cancel", "Keep", cx => { this.confirmClear = false; cx.notify(); }))
            .child(button("prompt-clear-confirm", "Clear queue", cx => this.clear(cx))))));
    return v_flex().id("prompt-queue").size_full().min_h(0).p(16).gap(10).rounded(10).overflow_hidden().border_1().border_color(t.border)
      .bg(t.popover).text_color(t.foreground).text_size(TYPE.md)
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === "escape" && !this.busy) { closeOverlay(this.p.overlay); cx.stop_propagation(); }
      })
      .child(h_flex().gap(7).items_center().flex_none()
        .child(div().flex_1().font_semibold().text_size(TYPE.lg).child("Pending prompts"))
        .when(!this.draftId, el => el.child(button("prompt-choose-recipient", this.choosing ? "Back" : "Change recipient…", cx => { this.choosing = !this.choosing; cx.notify(); }, this.busy || Boolean(this.prepared) || !this.target && this.choosing))))
      .when(Boolean(this.target), el => el.child(v_flex().gap(3).flex_none()
        .child(div().truncate().font_semibold().tooltip(this.target.address).child(targetLabel(this.target)))
        .child(div().truncate().text_size(TYPE.xs).text_color(t.muted).tooltip(this.target.cwd).child([this.target.machine || "This computer", this.target.cwd, this.target.sessionId?.slice(0, 8) || this.target.address].filter(Boolean).join(" · ")))
        .when(!current, el => el.child(div().text_size(TYPE.sm).text_color(t.blocked).child("This captured agent is unavailable or its session changed. Choose a live agent to send.")))
        .when(Boolean(current) && current.status === "blocked", el => el.child(button("prompt-open-agent", "Agent needs you · open it", () => run("agent.focus", { terminal: current.address }))))))
      .when(drafts.length > 0 && !this.draftId, el => el.child(v_flex().flex_none().max_h(120).gap(4).overflow_y_scrollbar().children(drafts.map(item => button(`prompt-draft-${item.id}`, item.title, cx => this.openDraft(item.id, cx), this.busy || Boolean(this.prepared))))))
      .child(body)
      .when(Boolean(this.error), el => el.child(div().max_h(65).overflow_y_scrollbar().text_size(TYPE.sm).text_color(t.ansi1).child(this.error)));
  }

  close() { this.input?.release(); }
}
