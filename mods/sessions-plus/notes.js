import { div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState } from "gpui-base";
import { appHome, readTextFile, writeTextFile, agents, terminals, panes, focused, theme, exec, setShared, openOverlay, closeOverlay } from "herdr";
import { mkdir, unlink } from "fs/promises";
import { promptTargets } from "./prompt-queue-model.js";
import { createNativeNotesClient } from "./notes-client.js";
import { projectContext } from "./project-context.js";
import { NOTES_LIMITS, NOTES_DRAFTS, NOTES_CHANGED, globalNoteScope, projectNoteScope, sessionNoteScope, validNoteScope, noteFor, filterNotes, decodeNoteDrafts, keepNoteDraft, dropNoteDraft } from "./notes-model.js";

export default class Notes {
  init(p, cx) {
    this.p = p; this.owner = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.handle = cx.focus_handle(); this.handle.focus(); this.generation = 0; this.stamp = 0;
    this.store = { schema: 1, notes: [] }; this.loading = false; this.saving = false; this.error = ""; this.status = ""; this.queryText = "";
    this.showAll = p.initial === "all"; this.showArchived = false; this.showVersions = false; this.confirmReload = false; this.conflict = false;
    this.client = createNativeNotesClient({ exec, read: readTextFile, write: writeTextFile, mkdir, unlink }, appHome(), p.node || "node");
    const focus = focused();
    const project = projectNoteScope(p.project || p.context || projectContext());
    const address = p.session?.address || (!p.session ? focus?.shown || focus?.agent || focus?.terminal : null);
    const live = promptTargets(agents(), terminals(), panes()).find(row => row.address === address);
    const session = sessionNoteScope(p.session ? { ...live, ...p.session } : live);
    this.contexts = [project, session, globalNoteScope()].filter(Boolean);
    this.scope = validNoteScope(p.scope) ? { ...p.scope } : this.contexts.find(scope => scope.type === p.initial) || project || session || globalNoteScope();
    this.title = InputState.new({ placeholder: "Note title" });
    this.query = InputState.new({ placeholder: "Search saved notes and drafts…" });
    this.query.on("change", (_event, cx) => { this.queryText = this.query.value(); cx.notify(); });
    this.editor = EditorState.new({ value: "", language: "markdown", readonly: false, line_numbers: false, folding: false, soft_wrap: true });
    this.title.on("change", (_event, cx) => this.changed(cx)); this.editor.on("change", (_event, cx) => this.changed(cx));
    this.load(cx);
  }

  drafts() {
    const raw = localStorage.getItem(NOTES_DRAFTS);
    if (raw === this.draftRaw && this.parsedDrafts) return this.parsedDrafts;
    const drafts = decodeNoteDrafts(raw); this.draftRaw = raw; this.parsedDrafts = drafts; return drafts;
  }
  filteredNotes() {
    if (this.filteredStore !== this.store || this.filteredQuery !== this.queryText || this.filteredArchived !== this.showArchived) {
      this.filtered = filterNotes(this.store, this.queryText, this.showArchived);
      this.filteredStore = this.store; this.filteredQuery = this.queryText; this.filteredArchived = this.showArchived;
    }
    return this.filtered;
  }
  writeDrafts(drafts) { if (drafts.length) localStorage.setItem(NOTES_DRAFTS, JSON.stringify(drafts)); else localStorage.removeItem(NOTES_DRAFTS); }
  fields() { return { title: this.title.value(), body: this.editor.value() }; }
  dirty() { const value = this.fields(); return value.title !== (this.note?.title || this.scope.label) || value.body !== (this.note?.body || ""); }
  setFields(title, body) { this.setting = true; this.title.set_value(title); this.editor.set_value(body); this.setting = false; }
  keepDraft() {
    if (this.loading || this.loadFailed || !this.scope) return;
    const drafts = this.drafts();
    if (!this.dirty()) this.writeDrafts(dropNoteDraft(drafts, this.owner, this.scope.key));
    else this.writeDrafts(keepNoteDraft(drafts, { owner: this.owner, scope: { ...this.scope }, ...this.fields(), baseRevision: this.baseRevision || 0 }));
  }
  forgetDraft(owner, key) { this.writeDrafts(dropNoteDraft(this.drafts(), owner, key)); }
  changed(cx) {
    if (this.setting || this.loading || this.loadFailed || this.closed) return;
    this.removeArmed = false; this.versionsArmed = false; this.confirmReload = false; this.status = "";
    try { this.keepDraft(); this.error = ""; this.scheduleSave(cx); }
    catch (error) { this.error = String(error.message || error); }
    cx.notify();
  }
  scheduleSave(cx) {
    const stamp = ++this.stamp, key = this.scope.key;
    if (this.conflict || !this.dirty()) return;
    cx.timer.after(700, cx => {
      if (this.closed || this.stamp !== stamp || this.scope.key !== key || this.conflict) return;
      this.save(cx);
    });
  }
  load(cx) {
    const generation = ++this.generation, scope = this.scope;
    this.loading = true; this.loadFailed = false; this.error = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        const state = await this.client.load();
        if (this.closed || this.generation !== generation) return;
        this.store = state; this.note = noteFor(state, scope); this.baseRevision = this.note?.revision || 0; this.conflict = false;
        const own = this.drafts().find(draft => draft.owner === this.owner && draft.scope.key === scope.key);
        this.setFields(own?.title ?? this.note?.title ?? scope.label, own?.body ?? this.note?.body ?? "");
        if (own) { this.baseRevision = own.baseRevision; this.conflict = own.baseRevision !== (this.note?.revision || 0); }
        this.status = own ? "Unsaved draft restored for this view" : this.note ? "Saved locally" : "New note · saved after typing";
        if (this.conflict) this.error = "The saved note changed while this draft was open. Your text is kept; copy or reload the saved note.";
      } catch (error) { if (!this.closed && this.generation === generation) { this.loadFailed = true; this.error = String(error.message || error); } }
      finally { if (!this.closed && this.generation === generation) { this.loading = false; cx.notify(); } }
    });
  }
  choose(scope, cx) {
    if (this.saving || !validNoteScope(scope)) return;
    try { this.keepDraft(); } catch (error) { this.error = String(error.message || error); cx.notify(); return; }
    this.scope = { ...scope }; this.showAll = false; this.showVersions = false; this.removeArmed = false; this.versionsArmed = false; this.confirmReload = false; this.stamp++;
    this.load(cx);
  }
  all(cx) {
    try { this.keepDraft(); this.showAll = !this.showAll; this.error = ""; }
    catch (error) { this.error = String(error.message || error); }
    cx.notify();
  }
  refresh(cx) {
    if (this.saving || this.loading) return;
    try { this.keepDraft(); this.load(cx); }
    catch (error) { this.error = String(error.message || error); cx.notify(); }
  }
  save(cx, archived = undefined, clearVersions = false) {
    if (this.closed || this.loading || this.loadFailed) return;
    if (this.saving) { this.saveAgain = true; return; }
    if (!this.dirty() && archived === undefined && !clearVersions) return;
    try { this.keepDraft(); }
    catch (error) { if (error.code !== "NOTE_DRAFT_LIMIT") { this.error = String(error.message || error); cx.notify(); return; } }
    const scope = this.scope, generation = this.generation, value = this.fields(), base = this.baseRevision || 0;
    this.saving = true; this.error = ""; this.status = "Saving…"; cx.notify();
    cx.spawn(async cx => {
      let saved = false;
      try {
        const result = await this.client.save(scope, { ...value, ...(archived !== undefined ? { archived } : {}), ...(clearVersions ? { clearVersions: true } : {}) }, base);
        setShared(NOTES_CHANGED, `${Date.now()}-${this.owner}`);
        if (this.closed || this.generation !== generation) return;
        this.store = result.state; this.note = result.note; this.baseRevision = result.note.revision; this.conflict = false; this.status = "Saved locally"; saved = true;
        if (this.title.value() === value.title && this.editor.value() === value.body) this.setFields(result.note.title, result.note.body);
        this.keepDraft();
      } catch (error) {
        if (!this.closed && this.generation === generation) { this.error = String(error.message || error); this.conflict = error.code === "NOTE_CONFLICT"; this.status = "Draft kept"; }
      } finally {
        this.saving = false;
        if (!this.closed && this.generation === generation) {
          const again = this.saveAgain; this.saveAgain = false;
          if (saved && !this.conflict && (again || this.dirty())) this.scheduleSave(cx);
          cx.notify();
        }
      }
    });
  }
  restoreDraft(draft, cx) {
    if (this.saving || this.loading || draft.scope.key !== this.scope.key) return;
    try {
      if (this.dirty()) throw new Error("Save or copy the current edit before restoring another draft.");
      const remaining = dropNoteDraft(this.drafts(), draft.owner, draft.scope.key);
      const adopted = keepNoteDraft(remaining, { ...draft, owner: this.owner });
      this.writeDrafts(adopted);
      this.setFields(draft.title, draft.body); this.baseRevision = draft.baseRevision; this.conflict = draft.baseRevision !== (this.note?.revision || 0);
      this.status = "Recovery draft restored";
      this.error = this.conflict ? "This draft predates the saved note. Your text is kept; copy or reload to resolve the conflict." : "";
      if (!this.conflict) this.scheduleSave(cx);
    } catch (error) { this.error = String(error.message || error); }
    cx.notify();
  }
  reloadSaved(cx) {
    if (this.saving || this.loading) return;
    if (!this.confirmReload) { this.confirmReload = true; cx.notify(); return; }
    try { this.forgetDraft(this.owner, this.scope.key); this.confirmReload = false; this.load(cx); }
    catch (error) { this.error = String(error.message || error); cx.notify(); }
  }
  restoreVersion(version, cx) {
    if (this.saving || this.loading || this.conflict) return;
    if (this.dirty()) { this.error = "Save the current draft before restoring a saved version."; cx.notify(); return; }
    this.setFields(version.title, version.body); this.showVersions = false; this.changed(cx);
  }
  clearVersions(cx) {
    if (this.saving || this.loading) return;
    if (!this.versionsArmed) { this.versionsArmed = true; cx.notify(); return; }
    this.versionsArmed = false; this.save(cx, undefined, true);
  }
  removeArchived(cx) {
    if (this.saving || this.loading || this.dirty() || !this.note?.archived) return;
    if (!this.removeArmed) { this.removeArmed = true; cx.notify(); return; }
    const scope = this.scope, note = this.note, generation = this.generation;
    try {
      this.writeDrafts(keepNoteDraft(this.drafts(), { owner: `removed-${this.owner}-${Date.now()}`, scope, title: note.title, body: note.body, baseRevision: 0 }));
    } catch (error) { this.error = String(error.message || error); cx.notify(); return; }
    this.saving = true; this.removeArmed = false; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await this.client.remove(scope, note.revision);
        setShared(NOTES_CHANGED, `${Date.now()}-${this.owner}`);
        if (this.closed || this.generation !== generation) return;
        this.store = result.state; this.note = null; this.baseRevision = 0; this.conflict = false;
        this.setFields(scope.label, ""); this.status = "Archived note removed · latest text kept as a recovery draft"; this.error = "";
      } catch (error) { if (!this.closed && this.generation === generation) this.error = String(error.message || error); }
      finally { this.saving = false; if (!this.closed && this.generation === generation) cx.notify(); }
    });
  }
  addToQueue(cx) {
    try {
      this.keepDraft();
      const value = this.fields(); if (!value.body.trim()) throw new Error("Write a note before adding it to pending prompts.");
      openOverlay({ mod: "sessions-plus", kind: "dialog", frame: "none", width: 660, height: 640, props: { role: "reference", text: `Notes: ${value.title}\n\n${value.body}`, title: value.title, on: this.scope.on ?? null } });
    } catch (error) { this.error = String(error.message || error); cx.notify(); }
  }
  async close() {
    try { this.keepDraft(); } catch { /* The error is already visible while the editor is open. */ }
    this.closed = true; this.generation++; this.stamp++;
    this.title?.release(); this.query?.release(); this.editor?.release();
    await localStorage.flush();
  }
  render(cx) {
    const t = theme(), busy = this.loading || this.saving;
    let recoveries = [], recoveryError = "";
    try { recoveries = this.drafts(); } catch (error) { recoveryError = String(error.message || error); }
    const button = (id, text, callback, disabled = false, selected = false) => div().id(id).px(9).py(6).flex_none().rounded(5).bg(selected ? t.selected : t.raised).text_color(disabled ? t.dim : t.foreground)
      .when(!disabled, el => el.cursor_pointer().hover(row => row.bg(t.hover))).on_click((_event, cx) => { cx.stop_propagation(); if (!disabled) callback(cx); }).child(text);
    const currentRecoveries = recoveries.filter(draft => draft.scope.key === this.scope.key && draft.owner !== this.owner);
    const notes = this.showAll ? this.filteredNotes() : [];
    const terms = this.queryText.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const unsaved = recoveries.filter(draft => terms.every(term => [draft.title, draft.body, draft.scope.label, draft.scope.folder].some(value => value.toLocaleLowerCase().includes(term))));
    const list = v_flex().id("notes-list").flex_1().min_h(0).gap(7)
      .child(Input.new(this.query).w_full().h(32).flex_none())
      .child(h_flex().flex_none().gap(7).items_center().child(button("notes-show-archived", this.showArchived ? "Hide archived" : "Show archived", cx => { this.showArchived = !this.showArchived; cx.notify(); })).child(div().text_size(10.5).text_color(t.muted).child(`${this.store.notes.length}/${NOTES_LIMITS.notes} saved contexts`)))
      .child(v_flex().id("notes-results").flex_1().min_h(0).gap(5).overflow_y_scrollbar()
        .children(notes.map(note => div().id("notes-entry-" + note.key).p(9).rounded(6).bg(t.raised).cursor_pointer().hover(row => row.bg(t.hover)).on_click((_event, cx) => this.choose(note.scope, cx))
          .child(div().font_semibold().truncate().child(`${note.archived ? "Archived · " : ""}${note.title}`))
          .child(div().text_size(10.5).text_color(t.muted).truncate().tooltip(note.scope.folder).child(`${note.scope.type} · ${note.scope.label}${note.scope.on ? " · " + note.scope.on : ""}`))
          .child(div().text_size(11).text_color(t.muted).truncate().child(note.body.slice(0, 240).replace(/\s+/g, " ").slice(0, 110)))))
        .children(unsaved.map(draft => button(`notes-unsaved-${draft.owner}-${draft.scope.key}`, `Recovery draft · ${draft.title}`, cx => this.choose(draft.scope, cx))))
        .when(!notes.length && !unsaved.length, el => el.child(div().p(12).text_color(t.muted).child("No saved notes match this search."))));
    const editor = v_flex().id("notes-editor").flex_1().min_h(0).gap(8)
      .child(Input.new(this.title).w_full().h(32).flex_none().disabled(this.loading))
      .when(Boolean(this.note?.archived), el => el.child(div().text_size(11).text_color(t.muted).child("Archived note · still saved and searchable")))
      .children(currentRecoveries.map(draft => h_flex().gap(6).items_center().flex_none()
        .child(div().flex_1().text_size(10.5).text_color(t.blocked).child("An unsaved draft is available from a closed or another view."))
        .child(button(`notes-recover-${draft.owner}`, "Restore draft", cx => this.restoreDraft(draft, cx), busy))))
      .child(div().flex_1().min_h(100).border_1().border_color(t.border).rounded(6).child(Editor.new(this.editor).size_full()))
      .when(this.showVersions && Boolean(this.note?.versions.length), el => el.child(v_flex().max_h(120).overflow_y_scrollbar().flex_none().gap(4)
        .children(this.note.versions.map(version => button(`notes-version-${version.revision}`, `Restore saved version ${version.revision} · ${new Date(version.updated).toLocaleString()}`, cx => this.restoreVersion(version, cx), busy || this.conflict)))))
      .child(h_flex().flex_none().gap(6).flex_wrap()
        .child(button("notes-save", this.saving ? "Saving…" : "Save", cx => this.save(cx), busy))
        .child(button("notes-copy", "Copy text", cx => cx.write_to_clipboard(this.fields().body)))
        .child(button("notes-queue", "Add to pending prompts…", cx => this.addToQueue(cx), this.loading || !this.fields().body.trim()))
        .child(button("notes-history", `Versions (${this.note?.versions.length || 0})`, cx => { this.showVersions = !this.showVersions; cx.notify(); }, busy || !this.note?.versions.length))
        .child(button("notes-archive", this.note?.archived ? "Unarchive" : "Archive", cx => this.save(cx, !this.note?.archived), busy || !this.note))
        .when(Boolean(this.note?.versions.length), el => el.child(button("notes-clear-versions", this.versionsArmed ? this.dirty() ? "Confirm save & clear old versions" : "Confirm clear old versions" : this.dirty() ? "Save & clear old versions…" : "Clear old versions…", cx => this.clearVersions(cx), busy)))
        .when(Boolean(this.note?.archived), el => el.child(button("notes-remove", this.removeArmed ? "Confirm remove · keep latest recovery" : "Remove archived note…", cx => this.removeArchived(cx), busy || this.dirty()))))
      .when(this.removeArmed, el => el.child(div().text_size(10.5).text_color(t.blocked).child("Removal frees this saved slot. Latest text stays in recovery; older saved versions are removed.")))
      .when(this.conflict, el => el.child(button("notes-reload", this.confirmReload ? "Confirm reload · discard this view's draft" : "Reload saved note…", cx => this.reloadSaved(cx), busy)))
      .child(div().flex_none().text_size(10.5).text_color(t.muted).child(`${this.status}${this.dirty() ? " · Unsaved changes" : ""} · ${this.fields().body.length.toLocaleString()}/${NOTES_LIMITS.body.toLocaleString()} characters`));
    return v_flex().id("workspace-notes").size_full().min_h(0).min_w(0).p(14).gap(9).rounded(10).overflow_hidden().border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(12)
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === "s" && (event.modifiers?.platform || event.modifiers?.control)) { this.save(cx); cx.stop_propagation(); }
        else if (event.key === "escape") { closeOverlay(this.p.overlay); cx.stop_propagation(); }
      })
      .child(h_flex().gap(7).flex_none().items_center().child(div().flex_1().font_semibold().text_size(15).child("Notes"))
        .child(button("notes-refresh", "Refresh", cx => this.refresh(cx), busy)))
      .child(h_flex().gap(6).flex_none().flex_wrap()
        .children(this.contexts.map(scope => button("notes-context-" + scope.type, scope.type === "project" ? "Project" : scope.type === "session" ? "Session" : "Global", cx => this.choose(scope, cx), this.saving, !this.showAll && this.scope.key === scope.key)))
        .child(button("notes-all", "All notes", cx => this.all(cx), this.saving, this.showAll)))
      .child(div().flex_none().text_size(10.5).text_color(t.muted).truncate().tooltip(this.scope.folder || this.scope.label).child(`${this.scope.type} · ${this.scope.label}${this.scope.on ? " · " + this.scope.on : ""}`))
      .child(this.loading ? div().flex_1().p(12).text_color(t.muted).child("Loading saved notes…") : this.loadFailed ? div().flex_1().p(12).text_color(t.muted).child("Saved notes could not be opened. Existing notes and recovery drafts were left unchanged. Use Refresh to try again.") : this.showAll ? list : editor)
      .when(Boolean(this.error || recoveryError), el => el.child(div().flex_none().max_h(75).overflow_y_scrollbar().text_size(11).text_color(t.ansi1).child(this.error || recoveryError)))
      .child(div().flex_none().text_size(10).text_color(t.dim).child("Saved on this computer. Closing a tab keeps its notes. The last three saved versions are retained."));
  }
}
