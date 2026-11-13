import { TYPE } from "./type-scale.js";
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Textarea, TextareaState, Editor, EditorState } from "gpui-base";
import { theme, settings, shared, setShared, terminals, panes, exec, run, closeOverlay } from "herdr";
import { COMMANDS_KEY, COMMAND_LIMITS, ACTIVE_COMMAND_STATES, commandContext, commandProject, commandRevision, parseCommandForm, saveCommand, removeCommand, favoriteCommand, moveCommand, displayedCommands, commandDraftRevision, commandDraftContent, saveCommandDraft, removeCommandDraft, reserveCommandRun, patchCommandRun, reserveCommandCancel, commandStatusText, COMMAND_LABEL } from "./commands-model.js";
import { startCommand, inspectCommand, cancelCommand, commandOutput } from "./commands-client.js";
import { projectContext } from "./project-context.js";

export default class Commands {
  init(p, cx) {
    this.p = p; this.handle = cx.focus_handle(); this.handle.focus(); this.error = ""; this.form = null; this.refreshing = false; this.busyToken = null;
    try {
      this.context = commandContext(p.context || p.source || projectContext());
    } catch (error) { this.error = String(error.message || error); }
    this.title = InputState.new({ placeholder: "Command title" });
    this.cwd = InputState.new({ placeholder: "Absolute working folder" });
    this.argv = TextareaState.new({ placeholder: '["/absolute/path/to/program", "literal argument"]', rows: 5 });
    for (const input of [this.title, this.cwd, this.argv]) input.on("change", (_event, cx) => this.keepForm(cx));
    if (this.context) this.refresh(cx);
  }
  state() { return shared(COMMANDS_KEY); }
  project() { return this.context ? commandProject(this.state(), this.context) : { commands: [], runs: [], drafts: [] }; }
  write(value) { setShared(COMMANDS_KEY, value); }
  control(args) { return exec("hc", args, { timeout: 15000 }); }
  dependencies() { return { execute: exec, control: args => this.control(args) }; }
  formValue() { return { ...this.form, title: this.title.value(), cwd: this.cwd.value(), argvText: this.argv.value() }; }
  keepForm(cx) {
    if (!this.form || this.loadingForm || !this.context) return;
    try {
      const next = saveCommandDraft(this.state(), this.context, this.formValue(), this.formRevision);
      this.write(next); this.formRevision = commandDraftRevision(commandProject(next, this.context).drafts.find(draft => draft.draftId === this.form.draftId)); this.error = "";
    }
    catch (error) { this.error = String(error.message || error); }
    cx.notify();
  }
  openForm(command, cx, draft = null) {
    if (this.form) { this.keepForm(cx); if (this.error) return; }
    try {
      if (draft && commandDraftRevision(this.project().drafts.find(item => item.draftId === draft.draftId)) !== commandDraftRevision(draft)) throw new Error("This draft changed or was discarded. Review the saved forms again.");
      const form = { ...(draft || { id: command?.id || null, expected: commandRevision(command), title: command?.title || "", cwd: command?.cwd || this.context.root, argvText: command ? JSON.stringify(command.argv, null, 2) : "[]" }), draftId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` };
      const next = saveCommandDraft(this.state(), this.context, form, null);
      this.write(next); this.form = form;
      this.formRevision = commandDraftRevision(commandProject(next, this.context).drafts.find(item => item.draftId === form.draftId));
      this.formOrigin = draft ? { draftId: draft.draftId, revision: commandDraftRevision(draft) } : null;
      this.formBaseline = commandDraftContent(form);
    } catch (error) { this.error = String(error.message || error); cx.notify(); return; }
    this.loadingForm = true;
    this.title.set_value(this.form.title); this.cwd.set_value(this.form.cwd); this.argv.set_value(this.form.argvText);
    this.loadingForm = false; this.error = ""; this.title.focus(); cx.notify();
  }
  cleanUnchangedForm() {
    if (!this.form || commandDraftContent(this.formValue()) !== this.formBaseline) return;
    const origin = this.formOrigin;
    if (origin && commandDraftRevision(this.project().drafts.find(draft => draft.draftId === origin.draftId)) !== origin.revision) return;
    this.write(removeCommandDraft(this.state(), this.context, this.form.draftId, this.formRevision));
  }
  back(cx) {
    if (this.form) {
      this.keepForm(cx); if (this.error) return;
      try { this.cleanUnchangedForm(); } catch (error) { this.error = String(error.message || error); cx.notify(); return; }
      this.form = null;
    }
    if (this.output) { this.output = null; this.outputEditor?.release(); this.outputEditor = null; }
    this.error = ""; cx.notify();
  }
  save(cx) {
    if (!this.form) return;
    try {
      const form = parseCommandForm(this.formValue(), this.context);
      const value = saveCommand(this.state(), this.context, form, this.form.id, this.form.expected);
      const draft = commandProject(value, this.context).drafts.find(draft => draft.draftId === this.form.draftId);
      this.write(draft ? removeCommandDraft(value, this.context, this.form.draftId, this.formRevision) : value); this.form = null; this.error = "";
    } catch (error) { this.error = String(error.message || error); }
    cx.notify();
  }
  discardDraft(draft, cx) {
    try { this.write(removeCommandDraft(this.state(), this.context, draft.draftId, commandDraftRevision(draft))); if (this.form?.draftId === draft.draftId) this.form = null; this.confirmDraft = null; this.error = ""; }
    catch (error) { this.error = String(error.message || error); }
    cx.notify();
  }
  remove(command, cx) {
    try { this.write(removeCommand(this.state(), this.context, command.id, this.confirmDelete?.revision)); this.confirmDelete = null; this.error = ""; }
    catch (error) { this.error = String(error.message || error); }
    cx.notify();
  }
  move(command, direction, cx) {
    try { this.write(moveCommand(this.state(), this.context, command.id, direction)); this.error = ""; }
    catch (error) { this.error = String(error.message || error); }
    cx.notify();
  }
  favorite(command, cx) {
    try { this.write(favoriteCommand(this.state(), this.context, command.id)); this.error = ""; }
    catch (error) { this.error = String(error.message || error); }
    cx.notify();
  }
  start(command, cx) {
    if (this.busyToken) return;
    const token = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    try { this.write(reserveCommandRun(this.state(), this.context, command, token)); }
    catch (error) { this.error = String(error.message || error); cx.notify(); return; }
    this.busyToken = token; this.error = ""; const record = this.project().runs.find(run => run.token === token); cx.notify();
    cx.spawn(async cx => {
      try { this.write(patchCommandRun(this.state(), this.context, token, await startCommand(record, this.dependencies()))); }
      catch (error) { this.write(patchCommandRun(this.state(), this.context, token, { status: error.launchAttempted ? "unconfirmed" : "failed", error: String(error.message || error).slice(0, 400) })); }
      finally { this.busyToken = null; if (!this.disposed) { this.refresh(cx); cx.notify(); } }
    });
  }
  refresh(cx) {
    if (!this.context || this.disposed) return;
    if (this.refreshing) { this.refreshAgain = true; return; }
    const records = this.project().runs.filter(record => ACTIVE_COMMAND_STATES.includes(record.status));
    if (!records.length) return;
    this.refreshing = true;
    cx.spawn(async cx => {
      for (const record of records) {
        try {
          const patch = await inspectCommand(record, this.dependencies());
          const current = this.project().runs.find(run => run.token === record.token);
          if (current?.cancelToken && patch.cancelToken !== null && ["running", "starting"].includes(patch.status)) patch.status = "cancelling";
          this.write(patchCommandRun(this.state(), this.context, record.token, patch));
        } catch (error) { this.write(patchCommandRun(this.state(), this.context, record.token, { error: String(error.message || error).slice(0, 400) })); }
      }
      this.refreshing = false;
      if (!this.disposed) { if (this.refreshAgain) { this.refreshAgain = false; this.refresh(cx); } cx.notify(); }
    });
  }
  scheduleRefresh(cx) {
    if (!this.context || this.disposed) return;
    const active = this.project().runs.filter(record => ACTIVE_COMMAND_STATES.includes(record.status)), tokens = new Set(active.map(record => record.token));
    const signature = JSON.stringify([active.map(record => [record.token, record.address, record.terminalIdentity]), terminals().filter(terminal => tokens.has(terminal.labels?.[COMMAND_LABEL])).map(terminal => [terminal.address, terminal.state, terminal.exit_code, terminal.reason, terminal.created_ms])]);
    if (signature === this.nativeSignature) return;
    this.nativeSignature = signature;
    if (this.refreshScheduled) return;
    this.refreshScheduled = true;
    cx.timer.after(0, cx => { this.refreshScheduled = false; if (!this.disposed && !this.busyToken) this.refresh(cx); });
  }
  cancel(record, cx) {
    const cancelToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    try { this.write(reserveCommandCancel(this.state(), this.context, record.token, cancelToken)); }
    catch (error) { this.error = String(error.message || error); cx.notify(); return; }
    const captured = this.project().runs.find(run => run.token === record.token);
    cx.spawn(async cx => {
      try { this.write(patchCommandRun(this.state(), this.context, record.token, await cancelCommand(captured, this.dependencies()))); }
      catch (error) { this.write(patchCommandRun(this.state(), this.context, record.token, { error: String(error.message || error).slice(0, 400) })); }
      finally { if (!this.disposed) cx.notify(); }
    });
  }
  console(record, cx) {
    if (!record.address || this.consoleBusy) return;
    this.consoleBusy = true; this.error = "";
    cx.spawn(async cx => {
      try {
        const checked = await inspectCommand(record, this.dependencies());
        this.write(patchCommandRun(this.state(), this.context, record.token, checked));
        if (["running", "starting", "cancelling"].includes(checked.status)) {
          const pane = panes().find(pane => pane.terminal === checked.address);
          if (pane) run("pane.focus", { pane: pane.pane }); else run("terminal.peek", { terminal: checked.address });
        } else {
          const output = await commandOutput(record, this.dependencies());
          if (this.disposed) return;
          this.outputEditor?.release();
          this.outputEditor = EditorState.new({ value: output.text, readonly: true, language: "text", line_numbers: false, soft_wrap: true, font_family: settings().font_family });
          this.output = { ...output, title: record.title, address: checked.address };
        }
      } catch (error) { if (!this.disposed) this.error = String(error.message || error); }
      finally { this.consoleBusy = false; if (!this.disposed) cx.notify(); }
    });
  }
  close() {
    this.disposed = true;
    // Every native change already saved with CAS. Closing a stale view must never write it again.
    if (this.form && this.context) { try { this.cleanUnchangedForm(); } catch { /* A changed or discarded draft is left untouched. */ } }
    for (const input of [this.title, this.cwd, this.argv, this.outputEditor]) input?.release();
  }
  render(cx) {
    this.scheduleRefresh(cx);
    const t = theme(), project = this.project();
    const button = (id, title, callback, disabled = false, primary = false) => div().id(id).px(8).py(5).flex_none().rounded(5).bg(primary ? t.solid : t.raised).text_color(disabled ? t.dim : primary ? t.solid_foreground : t.foreground)
      .when(!disabled, el => el.cursor_pointer().hover(el => el.bg(t.hover))).on_click((_event, cx) => { cx.stop_propagation(); if (!disabled) callback(cx); }).child(title);
    const activeFor = command => project.runs.some(record => record.commandId === command.id && ACTIVE_COMMAND_STATES.includes(record.status));
    const runRow = record => v_flex().id(`command-run-${record.token}`).gap(4).p(8).rounded(5).bg(t.background)
      .child(h_flex().gap(6).items_center().child(div().flex_1().truncate().text_color(record.status === "failed" || record.status === "unconfirmed" ? t.blocked : record.status === "succeeded" ? t.done : t.muted).child(commandStatusText(record)))
        .child(button(`command-console-${record.token}`, this.consoleBusy ? "Opening…" : "Console", cx => this.console(record, cx), !record.address || this.consoleBusy))
        .when(["running", "starting"].includes(record.status) && Boolean(record.address), el => el.child(button(`command-cancel-${record.token}`, "Cancel run", cx => { this.confirmCancel = record.token; cx.notify(); }, Boolean(record.cancelToken)))))
      .when(Boolean(record.error), el => el.child(div().text_size(TYPE.xs).text_color(t.blocked).child(record.error)))
      .when(this.confirmCancel === record.token, el => el.child(h_flex().gap(6).items_center().child(div().flex_1().child("Stop only this task terminal?"))
        .child(button(`command-cancel-no-${record.token}`, "Keep running", cx => { this.confirmCancel = null; cx.notify(); }))
        .child(button(`command-cancel-yes-${record.token}`, "Stop task", cx => { this.confirmCancel = null; this.cancel(record, cx); }))));
    let body;
    if (this.output) body = v_flex().flex_1().min_h(0).gap(8)
      .child(h_flex().gap(8).items_center().child(button("commands-output-back", "Back", cx => this.back(cx))).child(div().flex_1().truncate().child(`${this.output.title} · ${this.output.address}`)))
      .when(this.output.truncated, el => el.child(div().text_color(t.muted).child("Output limited to 400,000 characters.")))
      .child(div().flex_1().min_h(0).border_1().border_color(t.border).rounded(5).child(Editor.new(this.outputEditor).size_full()));
    else if (this.form) body = v_flex().flex_1().min_h(0).gap(8)
      .child(div().font_semibold().child(this.form.id ? "Edit command" : "New command"))
      .child(Input.new(this.title).h(32).border_1().border_color(t.border).rounded(5))
      .child(div().text_size(TYPE.xs).text_color(t.muted).child("Working folder"))
      .child(Input.new(this.cwd).h(32).border_1().border_color(t.border).rounded(5))
      .child(div().text_size(TYPE.xs).text_color(t.muted).child("Literal argv · JSON array · shell syntax requires an explicit shell executable"))
      .child(div().flex_1().min_h(100).border_1().border_color(t.border).rounded(5).child(Textarea.new(this.argv).size_full()))
      .child(h_flex().gap(8).justify_end().child(button("commands-form-back", "Back · keep draft", cx => this.back(cx)).tooltip("Form drafts are kept locally.")).child(button("commands-form-save", "Save command", cx => this.save(cx), false, true)));
    else body = v_flex().flex_1().min_h(0).gap(8)
      .child(h_flex().flex_none().gap(8).items_center().child(button("commands-new", "New command", cx => this.openForm(null, cx), !this.context)).child(div().flex_1())
        .child(button("commands-refresh", this.refreshing ? "Checking…" : "Check runs", cx => this.refresh(cx), this.refreshing || !project.runs.length)))
      .child(v_flex().id("commands-list").flex_1().min_h(0).gap(10).overflow_y_scrollbar()
        .children(displayedCommands(project).map(command => v_flex().id(`command-${command.id}`).gap(6).p(9).rounded(6).bg(t.raised)
          .child(h_flex().gap(6).items_center()
            .child(button(`command-favorite-${command.id}`, command.favorite ? "★" : "☆", cx => this.favorite(command, cx)))
            .child(div().flex_1().truncate().font_semibold().child(command.title))
            .child(button(`command-up-${command.id}`, "↑", cx => this.move(command, -1, cx), command.order === 0))
            .child(button(`command-down-${command.id}`, "↓", cx => this.move(command, 1, cx), command.order === project.commands.length - 1))
            .child(button(`command-edit-${command.id}`, "Edit", cx => this.openForm(command, cx), activeFor(command)))
            .child(button(`command-delete-${command.id}`, "Remove", cx => { this.confirmDelete = { id: command.id, revision: commandRevision(command) }; cx.notify(); }, activeFor(command)))
            .child(button(`command-start-${command.id}`, "Run", cx => this.start(command, cx), activeFor(command) || Boolean(this.busyToken), true)))
          .child(div().text_size(TYPE.xs).text_color(t.muted).truncate().tooltip(JSON.stringify(command.argv)).child(JSON.stringify(command.argv)))
          .child(div().text_size(TYPE.xs).text_color(t.dim).truncate().tooltip(command.cwd).child(command.cwd))
          .when(this.confirmDelete?.id === command.id, el => el.child(h_flex().gap(6).items_center().child(div().flex_1().child("Remove this saved command? Existing task output stays in core."))
            .child(button(`command-remove-no-${command.id}`, "Keep", cx => { this.confirmDelete = null; cx.notify(); }))
            .child(button(`command-remove-yes-${command.id}`, "Remove command", cx => this.remove(command, cx)))))
          .children(project.runs.filter(record => record.commandId === command.id).slice(-3).reverse().map(runRow))))
        .when(!project.commands.length, el => el.child(div().p(10).text_color(t.muted).child("Save a test, build, Python or Compose command for this project. Nothing runs until you click Run."))))
      .when(project.drafts.length > 0, el => el.child(v_flex().max_h(140).flex_none().gap(4).overflow_y_scrollbar().border_t(1).border_color(t.border)
        .child(div().text_size(TYPE.sm).text_color(t.muted).child("Unfinished command forms"))
        .children(project.drafts.map(draft => h_flex().id(`command-draft-${draft.draftId}`).gap(6).items_center()
          .child(div().flex_1().truncate().child(draft.title || "Untitled command"))
          .child(button(`command-restore-${draft.draftId}`, "Restore copy", cx => this.openForm(null, cx, draft)).tooltip("Restore opens a separate copy; its original stays until discarded."))
          .child(button(`command-discard-${draft.draftId}`, this.confirmDraft === draft.draftId ? "Confirm discard" : "Discard", cx => { if (this.confirmDraft === draft.draftId) this.discardDraft(draft, cx); else { this.confirmDraft = draft.draftId; cx.notify(); } }))))));
    return v_flex().id("project-commands").size_full().min_h(0).p(16).gap(10).rounded(10).overflow_hidden().border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(TYPE.md)
      .track_focus(this.handle).on_key_down((event, cx) => { if (event.key === "escape") { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(h_flex().gap(8).items_center().child(svg("mods/sessions-plus/commands.svg").size(16).text_color(t.muted)).child(div().flex_1().font_semibold().text_size(TYPE.lg).child("Project commands")))
      .when(Boolean(this.context), el => el.child(div().truncate().text_size(TYPE.xs).text_color(t.dim).tooltip(`${this.context.on || "This computer"} · ${this.context.root}`).child(`${this.context.on || "This computer"} · ${this.context.root}`)))
      .child(body)
      .when(Boolean(this.error), el => el.child(div().text_color(t.blocked).child(this.error)));
  }
}
