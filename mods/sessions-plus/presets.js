import { TYPE } from "./type-scale.js";
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Textarea, TextareaState } from "gpui-base";
import { shared, setShared, theme, exec, hc, appHome, spaces, panes, machines, closeOverlay } from "herdr";
import { projectContext } from "./project-context.js";
import { commandContext } from "./commands-model.js";
import { PRESETS_KEY, PRESET_WORKSPACES_KEY, PRESET_LIMITS, PRESET_WORKING, presetState, presetForm, presetRevision, presetDraftRevision, presetDraftContent, parsePresetForm, savePresetDraft, removePresetDraft, savePreset, removePreset, copyPreset, favoritePreset, preparedPreset, reservePresetLaunch, patchPresetLaunch, reviewPresetLaunch, applyPresetRoots } from "./presets-model.js";
import { launchWorkspacePreset, presetAppCommand } from "./presets-client.js";
const token = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 7)}`;

export default class WorkspacePresets {
  init(p, cx) {
    this.p = p; this.error = ""; this.form = null; this.preview = null; this.resultToken = null; this.busyToken = null;
    this.handle = cx.focus_handle(); this.handle.focus();
    try { this.context = commandContext(p.context || projectContext()); } catch { this.context = null; }
    this.inputs = {};
    for (const [key, placeholder, multiline] of [["name", "Project name", false], ["machine", "Machine name; empty means this computer", false], ["root", "Absolute main folder", false], ["rootsText", '["/absolute/folder", "/another/folder"]', true], ["agentText", '["/absolute/path/to/agent"]', true], ["tabsText", '[{"name":"Shell","argv":["/bin/zsh"],"cwd":"/absolute/folder"}]', true]]) {
      const InputType = multiline ? TextareaState : InputState;
      this.inputs[key] = InputType.new({ placeholder, ...(multiline ? { rows: key === "tabsText" ? 5 : 3 } : {}) });
      this.inputs[key].on("change", (_event, cx) => this.keepDraft(cx));
    }
  }
  state() { return presetState(shared(PRESETS_KEY)); }
  write(value) { setShared(PRESETS_KEY, value); }
  formValue() { return { ...this.form, ...Object.fromEntries(Object.entries(this.inputs).map(([key, input]) => [key, input.value()])) }; }
  keepDraft(cx) {
    if (!this.form || this.loadingForm) return;
    try { const next = savePresetDraft(this.state(), this.formValue(), this.formRevision); this.write(next); this.formRevision = presetDraftRevision(next.drafts.find(row => row.draftId === this.form.draftId)); this.error = ""; }
    catch (error) { this.error = String(error.message || error); }
    cx.notify();
  }
  openForm(preset, cx, draft = null) {
    if (this.busyToken) return;
    try {
      if (this.form) { this.keepDraft(cx); if (this.error) return; this.cleanUnchangedForm(); }
      if (draft && presetDraftRevision(this.state().drafts.find(row => row.draftId === draft.draftId)) !== presetDraftRevision(draft)) throw new Error("This saved form changed or was discarded. Review the current forms again.");
      const form = draft ? { ...draft, draftId: token("draft") } : presetForm(preset, this.context, token("draft"));
      const next = savePresetDraft(this.state(), form, null); this.write(next); this.form = form;
      this.formRevision = presetDraftRevision(next.drafts.find(row => row.draftId === form.draftId)); this.baseline = presetDraftContent(form);
      this.origin = draft ? { draftId: draft.draftId, revision: presetDraftRevision(draft) } : null;
      this.loadingForm = true; for (const [key, input] of Object.entries(this.inputs)) input.set_value(form[key]); this.loadingForm = false;
      this.preview = null; this.resultToken = null; this.error = ""; this.inputs.name.focus();
    } catch (error) { this.error = String(error.message || error); }
    cx.notify();
  }
  cleanUnchangedForm() {
    if (!this.form || presetDraftContent(this.formValue()) !== this.baseline) return;
    if (this.origin && presetDraftRevision(this.state().drafts.find(row => row.draftId === this.origin.draftId)) !== this.origin.revision) return;
    this.write(removePresetDraft(this.state(), this.form.draftId, this.formRevision));
  }
  back(cx) {
    if (this.busyToken) return;
    if (this.form) { this.keepDraft(cx); if (this.error) return; try { this.cleanUnchangedForm(); } catch (error) { this.error = String(error.message || error); cx.notify(); return; } this.form = null; }
    this.preview = null; this.resultToken = null; this.error = ""; cx.notify();
  }
  save(cx) {
    if (!this.form) return;
    try {
      const next = savePreset(this.state(), parsePresetForm(this.formValue()), this.form.id, this.form.expected), own = next.drafts.find(row => row.draftId === this.form.draftId);
      this.write(own ? removePresetDraft(next, this.form.draftId, this.formRevision) : next); this.form = null; this.error = "";
    } catch (error) { this.error = String(error.message || error); }
    cx.notify();
  }
  discard(draft, cx) {
    try { this.write(removePresetDraft(this.state(), draft.draftId, presetDraftRevision(draft))); this.confirmDraft = null; this.error = ""; }
    catch (error) { this.error = String(error.message || error); } cx.notify();
  }
  mutate(callback, cx) { try { this.write(callback(this.state())); this.error = ""; } catch (error) { this.error = String(error.message || error); } cx.notify(); }
  prepare(preset, cx) {
    try {
      const current = this.state().presets.find(row => row.id === preset.id);
      if (!current || presetRevision(current) !== presetRevision(preset)) throw new Error("This preset changed. Review it again before previewing.");
      this.preview = preparedPreset(current); this.resultToken = null; this.error = "";
    } catch (error) { this.error = String(error.message || error); } cx.notify();
  }
  launch(cx) {
    if (!this.preview || this.busyToken) return;
    const launchToken = token("workspace");
    try { this.write(reservePresetLaunch(this.state(), this.preview, launchToken)); }
    catch (error) { this.error = String(error.message || error); cx.notify(); return; }
    this.preview = null; this.busyToken = launchToken; this.resultToken = launchToken; this.error = "";
    const record = this.state().launches.find(row => row.token === launchToken); cx.notify();
    cx.spawn(async cx => {
      const deps = { execute: exec, control: hc, command: (name, args) => presetAppCommand(name, args, appHome(), exec), spaces, panes, machines, sleep: ms => cx.sleep(ms), closed: () => this.disposed,
        current: () => this.state().launches.find(row => row.token === launchToken), publish: patch => { this.write(patchPresetLaunch(this.state(), launchToken, patch)); if (!this.disposed) cx.notify(); },
        checkRootsCapacity: () => { if (Object.keys(shared(PRESET_WORKSPACES_KEY)?.workspaces || {}).length >= 40) throw new Error("The file workspace mapping limit is full. Reset an unused mapping before launching."); },
        applyRoots: (space, config) => setShared(PRESET_WORKSPACES_KEY, applyPresetRoots(shared(PRESET_WORKSPACES_KEY), space, config)) };
      try { await launchWorkspacePreset(record, deps); }
      catch (error) { this.error = String(error.message || error); }
      finally { this.busyToken = null; if (!this.disposed) cx.notify(); }
    });
  }
  review(record, cx) { if (record.token === this.busyToken) return; this.mutate(state => reviewPresetLaunch(state, record.token), cx); }
  scheduleExpiry(cx) {
    const deadlines = this.state().launches.filter(row => PRESET_WORKING.includes(row.status) && row.expires > Date.now()).map(row => row.expires), at = deadlines.length ? Math.min(...deadlines) : null;
    if (this.expiryAt === at) return;
    this.expiryAt = at;
    if (this.expiryScheduled) return;
    this.expiryScheduled = true;
    this.expiryTask = cx.timer.after(0, cx => { this.expiryScheduled = false; this.expiryTimer?.cancel?.(); if (this.disposed) return; if (this.expiryAt) this.expiryTimer = cx.timer.after(Math.max(1, this.expiryAt - Date.now() + 1), cx => { if (!this.disposed) { this.expiryAt = null; cx.notify(); } }); });
  }
  close() {
    this.disposed = true; this.expiryTimer?.cancel?.(); this.expiryTask?.cancel?.();
    try { this.cleanUnchangedForm(); } catch { /* A newer or discarded form stays untouched. */ }
    for (const input of Object.values(this.inputs)) input.release();
  }
  render(cx) {
    this.scheduleExpiry(cx);
    const t = theme(), state = this.state(), current = state.launches.find(row => row.token === this.resultToken);
    const button = (id, label, action, disabled = false, primary = false) => div().id(id).px(8).py(5).flex_none().rounded(5).bg(primary ? t.solid : t.raised).text_color(disabled ? t.dim : primary ? t.solid_foreground : t.foreground).when(!disabled, el => el.cursor_pointer().hover(row => row.bg(t.hover))).on_click((_event, cx) => { cx.stop_propagation(); if (!disabled) action(cx); }).child(label);
    const detail = (label, value) => v_flex().gap(3).child(div().text_size(TYPE.xs).text_color(t.dim).child(label)).child(div().text_size(TYPE.sm).text_color(t.muted).child(value));
    const result = row => v_flex().id(`preset-result-${row.token}`).gap(6).p(10).rounded(6).bg(t.background)
      .child(div().font_semibold().child(`${row.name} · ${row.status === "complete" ? "Workspace created" : row.status}`))
      .child(div().text_size(TYPE.xs).text_color(t.dim).child(`${row.on || "This computer"}${row.spaceId ? ` · ${row.spaceId}` : ""} · ${row.spaceMarker}`))
      .children(row.items.map(item => v_flex().gap(2).child(div().text_color(item.error ? t.blocked : t.muted).child(`${item.title}: ${item.status}${item.processStatus ? ` · ${item.processStatus}` : ""}${item.address ? ` · ${item.address}` : ""}`)).when(Boolean(item.error), el => el.child(div().text_size(TYPE.xs).text_color(t.blocked).child(item.error)))))
      .when(Boolean(row.error), el => el.child(div().text_color(t.blocked).child(row.error)))
      .when(!["complete", "failed"].includes(row.status) && !row.reviewed, el => el.child(div().text_size(TYPE.xs).text_color(t.muted).child("Created items remain in Herdr. Inspect this result and its launch marker before starting another workspace; nothing retries automatically.")))
      .when(!row.reviewed, el => el.child(button(`preset-review-${row.token}`, PRESET_WORKING.includes(row.status) ? "Review interrupted launch" : "I reviewed this result", cx => this.review(row, cx), row.token === this.busyToken || PRESET_WORKING.includes(row.status) && Date.now() <= row.expires)));
    let body;
    if (this.form) {
      const field = (key, label, multi = false, height = 70) => v_flex().flex_none().gap(4).child(div().text_size(TYPE.xs).text_color(t.dim).child(label)).child(div().h(multi ? height : 30).border_1().border_color(t.input).rounded(5).child(multi ? Textarea.new(this.inputs[key]).size_full() : Input.new(this.inputs[key]).size_full()));
      body = v_flex().flex_1().min_h(0).gap(9)
        .child(v_flex().id("preset-form-scroll").flex_1().min_h(0).gap(9).overflow_y_scrollbar()
          .child(field("name", "Project name")).child(field("machine", "Machine · empty means this computer")).child(field("root", "Main folder · existing checkout"))
          .child(field("rootsText", "File roots · JSON array, up to 8; main folder is included", true, 75))
          .child(field("agentText", "Initial agent · literal argv JSON array", true, 75))
          .child(field("tabsText", 'Extra terminal tabs · 1–3 objects: {"name", "argv", "cwd"}', true, 125))
          .child(div().text_size(TYPE.xs).text_color(t.muted).child("Saving never starts a program. argv strings stay literal; a shell command needs an explicit shell executable. Restoring opens a separate copy and keeps the original.")))
        .child(h_flex().gap(8).justify_end().child(button("preset-form-back", "Back · keep form", cx => this.back(cx))).child(button("preset-form-save", "Save preset", cx => this.save(cx), false, true)));
    } else if (this.preview) {
      const config = this.preview.config;
      body = v_flex().id("preset-launch-preview").flex_1().min_h(0).gap(10)
        .child(v_flex().flex_1().min_h(0).gap(10).overflow_y_scrollbar().child(div().font_semibold().child(`Launch ${config.name}`))
          .child(detail("New workspace", `${config.on || "This computer"} · ${config.root}`)).child(detail("File roots", config.roots.join("\n")))
          .child(detail("Agent tab", JSON.stringify(config.agentArgv))).children(config.tabs.map(tab => detail(`Terminal: ${tab.name} · ${tab.cwd}`, JSON.stringify(tab.argv))))
          .child(div().text_color(t.muted).child(`Creates one new workspace and ${config.tabs.length + 1} terminal tabs. Every program below starts only when you press Launch. No prompt is sent and no setup hook is discovered.`))
          .child(div().text_size(TYPE.xs).text_color(t.dim).child("Herdr starts these commands in its login shell and keeps the shell open afterward. Session creation does not prove a command completed. A partial launch stops and keeps its created items.")))
        .child(h_flex().gap(8).justify_end().child(button("preset-preview-back", "Back", cx => this.back(cx))).child(button("preset-launch", "Launch workspace", cx => this.launch(cx), Boolean(this.busyToken), true)));
    } else if (current) body = v_flex().flex_1().min_h(0).gap(9).child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().child(result(current))).child(button("preset-result-back", this.busyToken ? "Creating workspace…" : "Back to presets", cx => this.back(cx), Boolean(this.busyToken)));
    else body = v_flex().flex_1().min_h(0).gap(9)
      .child(h_flex().gap(8).child(button("preset-new", "New preset", cx => this.openForm(null, cx))).child(div().flex_1()).child(div().text_size(TYPE.xs).text_color(t.dim).child(`${state.presets.length}/${PRESET_LIMITS.presets} presets`)))
      .child(v_flex().id("preset-list").flex_1().min_h(0).gap(9).overflow_y_scrollbar()
        .children([...state.presets].sort((a, b) => Number(b.favorite) - Number(a.favorite)).map(preset => v_flex().id(`preset-${preset.id}`).p(10).gap(6).rounded(6).bg(t.raised)
          .child(h_flex().gap(6).items_center().child(button(`preset-favorite-${preset.id}`, preset.favorite ? "★" : "☆", cx => this.mutate(state => favoritePreset(state, preset.id), cx)))
            .child(div().flex_1().truncate().font_semibold().child(preset.name))
            .child(button(`preset-edit-${preset.id}`, "Edit", cx => this.openForm(preset, cx))).child(button(`preset-copy-${preset.id}`, "Copy", cx => this.mutate(state => copyPreset(state, preset), cx)))
            .child(button(`preset-remove-${preset.id}`, "Remove", cx => { this.confirmDelete = { id: preset.id, revision: presetRevision(preset) }; cx.notify(); }))
            .child(button(`preset-preview-${preset.id}`, "Preview launch", cx => this.prepare(preset, cx), false, true)))
          .child(div().text_size(TYPE.xs).text_color(t.dim).truncate().tooltip(preset.root).child(`${preset.on || "This computer"} · ${preset.root}`))
          .child(div().text_size(TYPE.xs).text_color(t.muted).child(`${preset.roots.length} file roots · agent + ${preset.tabs.length} terminal tabs`))
          .when(this.confirmDelete?.id === preset.id, el => el.child(h_flex().gap(8).items_center().child(div().flex_1().child("Remove this saved preset? Existing workspaces stay."))
            .child(button(`preset-remove-no-${preset.id}`, "Keep", cx => { this.confirmDelete = null; cx.notify(); }))
            .child(button(`preset-remove-yes-${preset.id}`, "Remove preset", cx => this.mutate(state => { const next = removePreset(state, preset.id, this.confirmDelete.revision); this.confirmDelete = null; return next; }, cx)))))))
        .when(!state.presets.length, el => el.child(div().p(10).text_color(t.muted).child("Save a project's folders, agent and terminal commands. Preview every workspace before launching it.")))
        .when(state.drafts.length > 0, el => el.child(div().font_semibold().text_size(TYPE.sm).child("Unfinished forms"))).children(state.drafts.map(draft => h_flex().id(`preset-draft-${draft.draftId}`).gap(6).items_center()
          .child(div().flex_1().truncate().child(draft.name || "Untitled preset"))
          .child(button(`preset-restore-${draft.draftId}`, "Restore copy", cx => this.openForm(null, cx, draft)))
          .child(button(`preset-discard-${draft.draftId}`, this.confirmDraft === draft.draftId ? "Confirm discard" : "Discard", cx => { if (this.confirmDraft === draft.draftId) this.discard(draft, cx); else { this.confirmDraft = draft.draftId; cx.notify(); } }))))
        .when(state.launches.length > 0, el => el.child(div().font_semibold().text_size(TYPE.sm).child("Recent launches"))).children([...state.launches].reverse().map(row => h_flex().gap(6).items_center()
          .child(div().flex_1().truncate().text_color(["partial", "unconfirmed"].includes(row.status) ? t.blocked : t.dim).child(`${row.name} · ${row.status}`))
          .child(button(`preset-open-result-${row.token}`, "Result", cx => { this.resultToken = row.token; cx.notify(); })))));
    return v_flex().id("workspace-presets").size_full().min_h(0).p(16).gap(10).rounded(10).border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(TYPE.md).track_focus(this.handle)
      .on_key_down((event, cx) => { if (event.key === "escape" && !this.busyToken) { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(h_flex().gap(8).items_center().child(svg("mods/sessions-plus/presets.svg").size(17).text_color(t.muted)).child(div().font_semibold().text_size(TYPE.lg).child("Workspace presets")))
      .child(body).when(Boolean(this.error), el => el.child(div().text_color(t.blocked).child(this.error)));
  }
}
