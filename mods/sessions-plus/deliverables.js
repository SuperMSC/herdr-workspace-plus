import { TYPE } from "./type-scale.js";
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Textarea, TextareaState } from "gpui-base";
import { appHome, exec, theme, shared, setShared, readTextFile, openOverlay, closeOverlay } from "herdr";
import { projectContext } from "./project-context.js";
import { DELIVERABLE_DRAFTS, DELIVERABLE_CHANGED, deliverableScope, deliverableDrafts, deliverableDraftRevision, deliverableDraftContent, saveDeliverableDraft, removeDeliverableDraft, safeDeliverableUrl } from "./deliverables-model.js";
import { createDeliverablesClient } from "./deliverables-client.js";
const freshId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2, 8)}`;

export default class Deliverables {
  init(p, cx) {
    this.p = p; this.closed = false; this.generation = 0; this.filter = "unread"; this.page = 0; this.queryText = ""; this.error = ""; this.form = null; this.conflict = false;
    this.handle = cx.focus_handle(); this.handle.focus(); this.inputs = {};
    for (const [key, hint] of [["title", "Title (optional)"], ["location", "Relative or absolute file path"], ["note", "What should be reviewed? (optional)"]]) {
      this.inputs[key] = (key === "note" ? TextareaState : InputState).new({ placeholder: hint, ...(key === "note" ? { rows: 3 } : {}) }); this.inputs[key].on("change", (_event, cx) => this.keepForm(cx));
    }
    this.query = InputState.new({ placeholder: "Filter this project's delivery list…" }); this.query.on("change", (_event, cx) => { this.queryText = this.query.value(); this.page = 0; this.scheduleLoad(cx); });
    this.client = createDeliverablesClient(exec, appHome(), p.node || "node");
    try { this.scope = deliverableScope(p.context || (p.root ? { root: p.root, on: p.on ?? null } : projectContext())); }
    catch (error) { this.error = String(error.message || error); }
    this.data = { items: [], page: 0, pages: 1, total: 0, counts: { all: 0, unread: 0, archived: 0 } }; this.seen = shared(DELIVERABLE_CHANGED);
    if (this.scope) this.load(cx);
    if (p.restoreId && this.scope) { try { const draft = this.drafts().find(row => row.id === p.restoreId && row.scope.key === this.scope.key); if (draft) this.openForm(null, cx, draft); } catch (error) { this.error = String(error.message || error); } }
  }
  drafts() { return deliverableDrafts(localStorage.getItem(DELIVERABLE_DRAFTS)); }
  writeDrafts(rows) { if (rows.length) localStorage.setItem(DELIVERABLE_DRAFTS, JSON.stringify(rows)); else localStorage.removeItem(DELIVERABLE_DRAFTS); }
  value() { return { ...this.form, ...Object.fromEntries(Object.entries(this.inputs).map(([key, input]) => [key, input.value()])) }; }
  keepForm(cx) {
    if (!this.form || this.setting) return;
    try { const rows = saveDeliverableDraft(this.drafts(), this.value(), this.formRevision); this.writeDrafts(rows); this.formRevision = deliverableDraftRevision(rows.find(row => row.id === this.form.id)); this.error = ""; }
    catch (error) { this.error = String(error.message || error); } cx.notify();
  }
  cleanUnchangedForm() {
    if (!this.form || deliverableDraftContent(this.value()) !== this.baseline) return;
    if (this.origin && deliverableDraftRevision(this.drafts().find(row => row.id === this.origin.id)) !== this.origin.revision) return;
    this.writeDrafts(removeDeliverableDraft(this.drafts(), this.form.id, this.formRevision));
  }
  openForm(item, cx, draft = null) {
    if (this.busy || !this.scope) return;
    try {
      if (this.form) { this.keepForm(cx); if (this.error) return; this.cleanUnchangedForm(); }
      if (draft && (draft.scope.key !== this.scope.key || deliverableDraftRevision(this.drafts().find(row => row.id === draft.id)) !== deliverableDraftRevision(draft))) throw new Error("This saved form changed or belongs to another project.");
      const form = draft ? { ...draft, id: freshId() } : { id: freshId(), scope: { ...this.scope }, itemId: item?.id || null, baseRevision: item?.revision ?? null, kind: item?.kind || "file", title: item?.title || "", location: item?.location || "", note: item?.note || "" };
      const rows = saveDeliverableDraft(this.drafts(), form, null); this.writeDrafts(rows); this.form = form; this.formRevision = deliverableDraftRevision(rows.find(row => row.id === form.id)); this.baseline = deliverableDraftContent(form); this.origin = draft ? { id: draft.id, revision: deliverableDraftRevision(draft) } : null;
      this.setting = true; for (const [key, input] of Object.entries(this.inputs)) input.set_value(form[key]); this.setting = false; this.conflict = false; this.error = ""; this.inputs.location.focus();
    } catch (error) { this.error = String(error.message || error); } cx.notify();
  }
  back(cx) { if (this.busy) return; try { if (this.form) { this.keepForm(cx); if (this.error) return; this.cleanUnchangedForm(); this.form = null; } this.error = ""; this.conflict = false; } catch (error) { this.error = String(error.message || error); } cx.notify(); }
  restore(draft, cx) {
    if (draft.scope.key === this.scope?.key) this.openForm(null, cx, draft);
    else openOverlay({ mod: "sessions-plus", kind: "dialog", frame: "none", width: 800, height: 700, props: { role: "deliverables", root: draft.scope.root, on: draft.scope.on, restoreId: draft.id } });
  }
  discard(draft, cx) { try { this.writeDrafts(removeDeliverableDraft(this.drafts(), draft.id, deliverableDraftRevision(draft))); this.confirmDraft = null; this.error = ""; } catch (error) { this.error = String(error.message || error); } cx.notify(); }
  request(action, extra = {}) { return this.client({ action, scope: this.scope, filter: this.filter, page: this.page, query: this.queryText, ...extra }); }
  scheduleLoad(cx) { const generation = ++this.generation; this.debounce?.cancel?.(); this.debounce = cx.timer.after(250, cx => { if (!this.closed && generation === this.generation) this.load(cx); }); cx.notify(); }
  load(cx) {
    if (!this.scope || this.closed) return; const generation = ++this.generation; this.loading = true; this.error = ""; cx.notify();
    cx.spawn(async cx => { try { const data = await this.request("view"); if (!this.closed && generation === this.generation) { this.data = data; this.page = data.page; } } catch (error) { if (!this.closed && generation === this.generation) this.error = String(error.message || error); } finally { if (!this.closed && generation === this.generation) { this.loading = false; cx.notify(); } } });
  }
  change(action, extra, cx, savedDraft = null) {
    if (this.busy || !this.scope) return; this.busy = true; this.error = ""; const generation = ++this.generation; this.loading = false; cx.notify();
    cx.spawn(async cx => {
      try {
        const data = await this.request(action, extra); this.seen = freshId(); setShared(DELIVERABLE_CHANGED, this.seen);
        let formUnchanged = false;
        if (savedDraft) {
          const rows = this.drafts(), own = rows.find(row => row.id === savedDraft.id); formUnchanged = Boolean(own && deliverableDraftRevision(own) === savedDraft.revision);
          if (formUnchanged) this.writeDrafts(removeDeliverableDraft(rows, savedDraft.id, savedDraft.revision));
          else if (own && data.changed?.[0]) {
            const changed = data.changed[0], next = { ...own, itemId: changed.id, baseRevision: changed.revision };
            const updated = saveDeliverableDraft(rows, next, deliverableDraftRevision(own)); this.writeDrafts(updated);
            if (this.form?.id === own.id) { this.form.itemId = changed.id; this.form.baseRevision = changed.revision; this.formRevision = deliverableDraftRevision(updated.find(row => row.id === own.id)); }
          }
        }
        if (!this.closed) { if (generation === this.generation) { this.data = data; this.page = data.page; } else this.load(cx); if (savedDraft && this.form?.id === savedDraft.id && formUnchanged) this.form = null; this.conflict = false; }
      } catch (error) { if (!this.closed) { this.error = String(error.message || error); this.conflict = savedDraft && error.code === "conflict"; } }
      finally { this.busy = false; if (!this.closed) cx.notify(); }
    });
  }
  save(cx, separate = false) {
    if (!this.form) return; this.keepForm(cx); if (this.error) return;
    const form = this.value(); this.change(form.itemId && !separate ? "edit" : "add", { ...(form.itemId && !separate ? { id: form.itemId, expected: form.baseRevision } : {}), value: { kind: form.kind, title: form.title, location: form.location, note: form.note } }, cx, { id: form.id, revision: this.formRevision });
  }
  drop(paths, cx) {
    if (this.busy || this.form) { this.error = "Save or keep the current form before dropping files."; cx.notify(); return; }
    if (this.scope?.on) { this.error = "Dropped files are from this computer. Add a remote path manually in this project's list."; cx.notify(); return; }
    if (!Array.isArray(paths) || !paths.length || paths.length > 10) { this.error = "Drop one to ten files at a time. Folders are not scanned."; cx.notify(); return; }
    this.change("drop", { values: paths.map(location => ({ kind: "file", location, title: "", note: "" })) }, cx);
  }
  open(item, cx) {
    if (this.opening || this.closed) return; this.opening = true; this.error = "";
    cx.spawn(async cx => {
      try {
        const fresh = await this.request("get", { id: item.id, expected: item.revision }); if (this.closed) return;
        if (fresh.scope.key !== this.scope.key) throw new Error("The item belongs to a different captured project.");
        if (fresh.item.kind === "url") cx.open_url(safeDeliverableUrl(fresh.item.location));
        else {
          if (await readTextFile(`${appHome()}/mods/files-plus/mod.json`) === null) throw new Error("File preview needs the Files Plus companion. Run the full workspace updater first."); if (this.closed) return;
          const file = fresh.item.file; if (!file || file.on !== this.scope.on || typeof file.root !== "string" || typeof file.path !== "string" || !file.path || file.path.startsWith("/") || file.path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("The captured file reference is invalid.");
          openOverlay({ mod: "files-plus", kind: "dialog", width: 1000, height: 760, props: { role: "file-preview", root: file.root, path: file.path, on: file.on } });
        }
      } catch (error) { if (!this.closed) this.error = String(error.message || error); }
      finally { this.opening = false; if (!this.closed) cx.notify(); }
    });
  }
  close() { this.closed = true; ++this.generation; this.debounce?.cancel?.(); try { this.cleanUnchangedForm(); } catch { /* Changed or discarded forms remain untouched. */ } for (const input of [...Object.values(this.inputs), this.query]) input.release(); }
  render(cx) {
    if (this.seen !== shared(DELIVERABLE_CHANGED) && !this.pendingRefresh && !this.busy) { this.pendingRefresh = true; cx.timer.after(0, cx => { this.pendingRefresh = false; if (!this.closed) { this.seen = shared(DELIVERABLE_CHANGED); this.load(cx); } }); }
    const t = theme(), data = this.data;
    const button = (id, label, action, disabled = false, active = false) => div().id(id).px(8).py(5).rounded(5).flex_none().bg(active ? t.selected : t.raised).text_color(disabled ? t.dim : t.foreground).when(!disabled, el => el.cursor_pointer().hover(row => row.bg(t.hover))).on_click((_event, cx) => { cx.stop_propagation(); if (!disabled) action(cx); }).child(label);
    let body;
    if (this.form) body = v_flex().flex_1().min_h(0).gap(9)
      .child(h_flex().gap(7).child(button("delivery-kind-file", "File", cx => { this.form.kind = "file"; this.keepForm(cx); }, this.busy, this.form.kind === "file")).child(button("delivery-kind-url", "URL", cx => { this.form.kind = "url"; this.keepForm(cx); }, this.busy, this.form.kind === "url")))
      .child(Input.new(this.inputs.title).h(32).px(7).border_1().border_color(t.input).rounded(5))
      .child(div().text_size(TYPE.xs).text_color(t.dim).child(this.form.kind === "file" ? "File path on the captured machine" : "HTTP or HTTPS URL"))
      .child(Input.new(this.inputs.location).h(32).px(7).border_1().border_color(t.input).rounded(5))
      .child(div().h(110).border_1().border_color(t.input).rounded(5).child(Textarea.new(this.inputs.note).size_full()))
      .child(div().text_size(TYPE.xs).text_color(t.muted).child("This records a delivery for review. Files are opened only when you click Open; URLs open in your browser."))
      .when(this.conflict, el => el.child(div().text_color(t.blocked).child("The saved item changed. Your form is kept. Save a separate item to preserve both versions, or return and refresh the list.")))
      .child(div().flex_1()).child(h_flex().justify_end().gap(7).child(button("delivery-form-back", "Back · keep form", cx => this.back(cx), this.busy))
        .when(this.conflict, el => el.child(button("delivery-save-copy", "Save separate item", cx => this.save(cx, true), this.busy)))
        .child(button("delivery-save", this.busy ? "Saving…" : this.form.itemId ? "Save changes" : "Add to review list", cx => this.save(cx), this.busy)));
    else {
      let drafts = []; this.draftError = ""; try { drafts = this.drafts(); } catch (error) { this.draftError = String(error.message || error); }
      body = v_flex().flex_1().min_h(0).gap(8)
        .child(h_flex().gap(5).items_center().children([["unread", `Unread ${data.counts.unread}`], ["all", `Active ${data.counts.all}`], ["archived", `Archived ${data.counts.archived}`]].map(([filter, label]) => button(`delivery-filter-${filter}`, label, cx => { this.filter = filter; this.page = 0; this.load(cx); }, this.busy, this.filter === filter)))
          .child(div().flex_1()).child(button("delivery-add", "Add file / URL", cx => this.openForm(null, cx), this.busy || !this.scope)))
        .child(h_flex().gap(6).child(Input.new(this.query).h(30).px(7).flex_1().min_w(0).border_1().border_color(t.input).rounded(5)).child(button("delivery-refresh", this.loading ? "Loading…" : "Refresh", cx => this.load(cx), this.loading || this.busy)))
        .child(v_flex().id("delivery-items").flex_1().min_h(0).gap(7).overflow_y_scrollbar().children(data.items.map(item => v_flex().id(`delivery-${item.id}`).gap(5).p(9).rounded(6).bg(t.raised)
          .child(h_flex().gap(6).items_center().child(div().flex_1().min_w(0).truncate().font_semibold().child(`${item.read ? "✓" : "●"} ${item.title}`))
            .child(button(`delivery-open-${item.id}`, item.kind === "url" ? "Open URL" : "Open file", cx => this.open(item, cx), this.opening))
            .child(button(`delivery-edit-${item.id}`, "Edit", cx => this.openForm(item, cx), this.busy)))
          .child(div().truncate().text_size(TYPE.xs).text_color(t.dim).tooltip(item.location).child(item.location))
          .when(Boolean(item.note), el => el.child(div().truncate().text_size(TYPE.sm).text_color(t.muted).tooltip(item.note).child(item.note)))
          .child(h_flex().gap(6).justify_end().child(button(`delivery-read-${item.id}`, item.read ? "Mark unread" : "Mark reviewed", cx => this.change("read", { id: item.id, expected: item.revision, value: !item.read }, cx), this.busy))
            .child(button(`delivery-archive-${item.id}`, item.archived ? "Restore" : "Archive", cx => this.change("archive", { id: item.id, expected: item.revision, value: !item.archived }, cx), this.busy))
            .when(item.archived, el => el.child(button(`delivery-remove-${item.id}`, this.confirmRemove === item.id ? "Confirm remove record" : "Remove record", cx => { if (this.confirmRemove === item.id) { this.confirmRemove = null; this.change("remove", { id: item.id, expected: item.revision }, cx); } else { this.confirmRemove = item.id; cx.notify(); } }, this.busy))))))
          .when(!data.items.length, el => el.child(div().p(12).text_color(t.muted).child(this.loading ? "Loading deliveries…" : "No matching deliveries. Add a file or link explicitly; folders are never scanned."))))
        .child(h_flex().gap(7).items_center().child(div().flex_1().text_size(TYPE.xs).text_color(t.dim).child(`${data.total} matching · page ${data.page + 1}/${data.pages} · 20 per page`))
          .child(button("delivery-previous", "Previous", cx => { this.page = Math.max(0, data.page - 1); this.load(cx); }, data.page === 0 || this.loading || this.busy))
          .child(button("delivery-next", "Next", cx => { this.page = data.page + 1; this.load(cx); }, data.page + 1 >= data.pages || this.loading || this.busy)))
        .when(drafts.length > 0, el => el.child(v_flex().max_h(120).gap(4).overflow_y_scrollbar().child(div().text_size(TYPE.xs).text_color(t.dim).child("Saved forms · restoring keeps the original"))
          .children(drafts.map(draft => h_flex().gap(6).items_center().child(div().flex_1().truncate().tooltip(`${draft.scope.on || "This computer"} · ${draft.scope.root}`).child(draft.title || draft.location || "Untitled form"))
            .child(button(`delivery-restore-${draft.id}`, draft.scope.key === this.scope.key ? "Restore copy" : "Open project", cx => this.restore(draft, cx), this.busy))
            .child(button(`delivery-discard-${draft.id}`, this.confirmDraft === draft.id ? "Confirm discard" : "Discard", cx => { if (this.confirmDraft === draft.id) this.discard(draft, cx); else { this.confirmDraft = draft.id; cx.notify(); } }, this.busy))))));
    }
    return v_flex().id("deliverables").size_full().min_h(0).p(14).gap(9).rounded(10).border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(TYPE.md).track_focus(this.handle)
      .on_key_down((event, cx) => { if (event.key === "escape" && !this.busy) { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .on_drop((event, cx) => this.drop(event.paths, cx))
      .child(div().font_semibold().text_size(TYPE.lg).child("Deliverables to review"))
      .child(div().truncate().text_size(TYPE.xs).text_color(t.dim).tooltip(this.scope ? `${this.scope.on || "This computer"} · ${this.scope.root}` : "No captured project").child(this.scope ? `${this.scope.on || "This computer"} · ${this.scope.root}` : "No captured project"))
      .child(body).when(Boolean(this.error || this.draftError), el => el.child(div().text_color(t.blocked).child(this.error || this.draftError)));
  }
}
