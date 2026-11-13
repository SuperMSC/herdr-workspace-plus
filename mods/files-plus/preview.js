// Native type previews. Retained editors and view IDs survive refreshes. A file preview tab
// can also edit a local text file: saves only replace what was read, and unsaved edits are
// kept as drafts on disk.
import { TYPE } from './type-scale.js';
import { div, image, svg } from 'gpui-kit';
import { h_flex, v_flex, Editor, EditorState, TextView } from 'gpui-base';
import { exec, appHome, readTextFile, writeTextFile, theme, settings, shared, setShared } from 'herdr';
import { editBlocker, textToSave, isDirty, draftAge, DIRTY_KEY } from './editor-model.js';
import { loadDraft, keepDraft, dropDraft } from './drafts.js';
import { fileKind, parseDelimited, jsonRows, lineExcerpt, markdownForPreview, TEXT_LIMIT, PREVIEW_FONT_KEY, previewFontSize } from './preview-model.js';
import FileFind from './file-find.js';
import { markdownStructure, markdownBlocks, resolveMarkdownLink, HISTORY_LIMIT } from './markdown-model.js';
import { diagramLook } from './mermaid-model.js';
import { renderDiagrams } from './mermaid.js';
const LANG = { ts: 'js', tsx: 'js', mts: 'js', cts: 'js', jsx: 'js', mjs: 'js', toml: 'yaml', jsonc: 'json', svelte: 'html', vue: 'html', md: 'markdown' };
export default class Preview {
  constructor({ editable = false, id = null, onNavigate = null } = {}) { this.onNavigate = onNavigate; this.history = []; this.expanded = new Set(['$']); this.width = 320; this.mode = 'preview'; this.fontSize = 12; this.editable = editable; this.id = id; }
  clear() {
    this.request = {}; this.code?.release(); this.code = null; this.path = null; this.data = null; this.error = null; this.loading = false; this.find?.clear();
    this.editing = false; this.base = null; this.conflict = null; this.external = false; this.draft = null; this.draftChecked = false; this.armed = null; this.saving = false; this.status = '';
    this.markdownRequest = {}; this.markdownBlocks = null; this.headings = []; this.anchor = null; this.contents = false; this.markdownBusy = false; this.markdownLook = null; this.linkError = null;
    this.markDirty(false);
  }
  open(root, path, on, cx, line = null, navigating = false) {
    if (this.dirty()) keepDraft(this.root, this.path, this.code.value(), this.base).catch(() => {});
    this.clear(); this.root = root; this.path = path; this.on = on; this.line = line; this.mode = line ? 'source' : 'preview'; this.expanded = new Set(['$']); this.zoom = 1;
    this.disposed = false; this.fontSize = previewFontSize(shared(PREVIEW_FONT_KEY));
    if (!navigating) this.history = [];
    this.onNavigate?.({ root, path, on });
    if (!this.find) this.find = new FileFind(cx);
    if (!line) cx.timer.after(0, () => this.find?.handle.focus());
    if (path) this.refresh(cx);
  }
  refresh(cx) {
    if (this.editing) { this.checkDisk(cx); return; }
    if (!this.path || this.loading) return;
    const request = {}; this.request = request; this.loading = true;
    const path = this.path, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        let next;
        if (on) {
          const kind = fileKind(path);
          if (kind === 'image' || kind === 'unsupported') next = { kind, error: kind === 'image' ? 'Image preview is available for local folders' : 'PDF preview is not included' };
          else { const text = await readTextFile(`${root}/${path}`, { on }); next = text === null ? { error: 'This file is no longer available' } : text.includes('\0') ? { error: 'Binary file · no text preview' } : { kind, text: text.slice(0, TEXT_LIMIT), truncated: text.length > TEXT_LIMIT, signature: text }; }
        } else {
          const result = await exec('node', [`${appHome()}/mods/files-plus/preview-helper.mjs`, JSON.stringify({ root, path, line: this.line, appHome: appHome() })]);
          next = JSON.parse(result.stdout || '{}'); if (result.code && !next.error) throw new Error(result.stderr || 'Cannot read this file');
        }
        if (this.request !== request) return;
        this.error = next.error || null;
        if (!next.error && (next.signature !== this.data?.signature || !this.data)) {
          this.data = next; this.parseError = null;
          if (next.kind === 'json') { try { this.json = JSON.parse(next.text); } catch { this.parseError = next.truncated ? 'JSON exceeds the preview limit; showing source' : 'Invalid JSON; showing source'; } }
          if (next.kind === 'csv' || next.kind === 'tsv') this.table = parseDelimited(next.text.replace(/^\uFEFF/, ''), next.kind === 'tsv' ? '\t' : ',');
          if (next.text !== undefined) {
            this.find.setText(next.text, next.truncated);
            if (this.code) this.code.set_value(next.text);
            else this.createEditor();
          }
          if (next.kind === 'markdown') this.prepareMarkdown(cx);
        }
      } catch (error) { if (this.request === request) this.error = `Cannot preview this file: ${String(error)}`; }
      finally { if (this.request === request) { this.loading = false; if (!this.draftChecked) this.checkDraft(cx); } cx.notify(); }
    });
  }
  createEditor() {
    if (typeof this.data?.text !== 'string') return;
    const t = theme(), ext = this.path.split('.').pop().toLowerCase();
    // An editor rebuilt while editing (a new text size) keeps what was typed.
    const value = this.editing ? (this.code?.value() ?? this.base) : this.data.text;
    this.code?.release();
    this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: !this.editing, value, font_family: settings().font_family, font_size: this.fontSize, syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
    if (this.editing) this.code.on('change', (_e, cx) => this.changed(cx));
  }
  absolute() { return `${this.root}/${this.path}`; }
  blocker() { return this.editable ? editBlocker(this.data, this.on) : 'Read only'; }
  dirty() { return this.editing && Boolean(this.code) && isDirty(this.code.value(), this.base); }
  markDirty(flag) {
    if (!this.id) return;
    const marks = shared(DIRTY_KEY) ?? {};
    if (Boolean(marks[this.id]) === flag) return;
    const next = { ...marks }; if (flag) next[this.id] = true; else delete next[this.id];
    setShared(DIRTY_KEY, next);
  }
  // Edit from the file as it is on disk now, not from a preview that may be stale or cut short.
  startEdit(cx, draft = null) {
    if (this.blocker() || this.editing || this.saving) return;
    const path = this.path, request = this.request;
    this.status = 'Opening…'; cx.notify();
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(this.absolute());
        if (this.disposed || this.path !== path || this.request !== request) return;
        if (text === null) { this.status = ''; this.error = 'This file is no longer available'; return; }
        if (text.length > 400000) { this.status = 'Files over 400 KB open read only'; return; }
        this.base = draft ? draft.base : text; this.editing = true; this.mode = 'source'; this.line = null; this.status = '';
        this.find?.clear(); this.data = { ...this.data, text, truncated: false };
        this.createEditor();
        if (draft) { this.code.set_value(draft.text); if (draft.base !== text) this.external = true; }
        this.draft = null; this.markDirty(this.dirty());
      } catch (error) { this.status = `Cannot edit: ${String(error.message ?? error)}`; }
      finally { cx.notify(); }
    });
  }
  changed(cx) {
    const dirty = this.dirty(); this.markDirty(dirty);
    if (this.status === 'Saved') this.status = '';
    // Keep the draft a moment after typing stops; a closed tab loses at most that moment.
    const stamp = this.typed = Date.now(), path = this.path, root = this.root;
    cx.timer.after(400, () => {
      if (this.typed !== stamp || !this.editing || this.path !== path) return;
      if (this.dirty()) keepDraft(root, path, this.code.value(), this.base).catch(() => {});
      else dropDraft(root, path);
    });
    cx.notify();
  }
  save(cx, expected = this.base) {
    if (!this.editing || this.saving || !this.code) return;
    const text = textToSave(this.code.value(), this.base), path = this.path, root = this.root;
    if (expected === this.base && text === this.base) { this.status = 'No changes'; cx.notify(); return; }
    this.saving = true; this.status = 'Saving…'; this.armed = null; cx.notify();
    cx.spawn(async cx => {
      try {
        await writeTextFile(this.absolute(), text, expected);
        if (this.path !== path) return;
        this.base = text; this.conflict = null; this.external = false; this.status = 'Saved';
        this.data = { ...this.data, text, truncated: false }; this.find?.setText(text, false);
        dropDraft(root, path); this.markDirty(this.dirty());
      } catch {
        // The file is not what was read: someone else changed or removed it. Nothing was written.
        const disk = await readTextFile(this.absolute()).catch(() => null);
        if (this.path === path) { this.conflict = { disk }; this.status = ''; keepDraft(root, path, this.code.value(), this.base).catch(() => {}); }
      } finally { this.saving = false; cx.notify(); }
    });
  }
  // Two clicks for anything that throws edits or another writer's change away.
  confirm(key, cx, action) {
    if (this.armed === key) { this.armed = null; action(); return; }
    const armed = this.armed = key;
    cx.timer.after(3000, cx => { if (this.armed === armed) { this.armed = null; cx.notify(); } });
    cx.notify();
  }
  reload(cx) {
    const root = this.root, path = this.path;
    this.editing = false; this.conflict = null; this.external = false; this.base = null; this.status = ''; this.data = null;
    this.markDirty(false); dropDraft(root, path); this.refresh(cx); cx.notify();
  }
  finish(cx) {
    if (this.dirty()) { this.confirm('discard', cx, () => this.reload(cx)); return; }
    this.editing = false; this.conflict = null; this.external = false; this.status = ''; this.markDirty(false);
    this.createEditor(); this.refresh(cx); cx.notify();
  }
  checkDisk(cx) {
    if (this.saving || this.checking) return;
    const path = this.path; this.checking = true;
    cx.spawn(async cx => {
      try {
        const disk = await readTextFile(this.absolute());
        if (!this.editing || this.path !== path || disk === this.base) return;
        if (disk !== null && !this.dirty()) { this.base = disk; this.code.set_value(disk); this.data = { ...this.data, text: disk }; }
        else this.external = true;
      } catch { /* Checked again on the next refresh. */ }
      finally { this.checking = false; cx.notify(); }
    });
  }
  checkDraft(cx) {
    this.draftChecked = true;
    if (!this.editable || this.on || this.editing || typeof this.data?.text !== 'string') return;
    const path = this.path, root = this.root;
    cx.spawn(async cx => {
      const draft = await loadDraft(root, path);
      if (!draft || this.path !== path || this.editing) return;
      if (draft.text === this.data?.text) { dropDraft(root, path); return; }
      this.draft = draft; cx.notify();
    });
  }
  banner(t, tone, text, actions) {
    return h_flex().id('edit-banner').flex_none().flex_wrap().min_h(34).px(10).py(4).gap(6).items_center().bg(tone + '1f').border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(120).text_size(TYPE.sm).text_color(t.foreground).child(text)).children(actions);
  }
  setFontSize(size, cx, persist = true) {
    if (this.disposed) return;
    const next = previewFontSize(size);
    if (next !== this.fontSize) { this.fontSize = next; this.createEditor(); if (this.find?.visible) this.find.locate(); }
    if (persist) setShared(PREVIEW_FONT_KEY, next);
    cx.notify();
  }
  close() {
    if (this.dirty()) keepDraft(this.root, this.path, this.code.value(), this.base).catch(() => {});
    this.disposed = true; this.clear(); this.find?.close(); this.find = null;
  }
  prepareMarkdown(cx) {
    if (this.data?.kind !== 'markdown' || typeof this.data.text !== 'string') return;
    const request = this.markdownRequest = {}, text = this.data.text, path = this.path;
    const look = diagramLook(theme(), settings().font_family);
    this.markdownLook = JSON.stringify(look); this.linkError = null;
    const structure = markdownStructure(text);
    this.headings = structure.headings; this.headingsLimited = structure.headingsLimited;
    this.diagramsLimited = structure.diagrams.length > 24;
    const blocks = markdownBlocks(text, structure); this.markdownBlocks = blocks;
    if (this.anchor && !this.headings.some(heading => heading.slug === this.anchor)) {
      this.linkError = 'This heading was not found in the available document.'; this.anchor = null;
    }
    const diagrams = blocks.filter(block => block.diagram); this.markdownBusy = diagrams.length > 0;
    if (!diagrams.length) return;
    cx.spawn(async cx => {
      try {
        const results = await renderDiagrams(diagrams, look);
        if (this.disposed || this.markdownRequest !== request || this.path !== path || this.data?.text !== text) return;
        diagrams.forEach((block, index) => Object.assign(block, results[index]));
      } catch (error) {
        if (this.markdownRequest !== request) return;
        for (const block of diagrams) block.error = String(error.message || error);
      }
      if (this.markdownRequest === request) { this.markdownBusy = false; cx.notify(); }
    });
  }
  rememberLocation() {
    this.history = [...this.history, { path: this.path, anchor: this.anchor, mode: this.mode, line: this.line }].slice(-HISTORY_LIMIT);
  }
  followMarkdown(href, cx) {
    let target;
    try { target = resolveMarkdownLink(this.root, this.path, href); }
    catch (error) { this.linkError = String(error.message || error); cx.notify(); return; }
    if (target.external) { cx.open_url(target.external); return; }
    if (target.path === this.path) {
      if (target.anchor && !this.headings.some(heading => heading.slug === target.anchor)) { this.linkError = 'This heading was not found in the available document.'; cx.notify(); return; }
      if (this.anchor !== target.anchor || this.mode !== 'preview') this.rememberLocation();
      this.anchor = target.anchor; this.mode = 'preview'; this.line = null; this.contents = false; this.linkError = null; cx.notify(); return;
    }
    this.navigateMarkdown(target, cx);
  }
  navigateMarkdown(target, cx, back = false) {
    const path = this.path, root = this.root, on = this.on, request = this.request;
    if (this.saving) { this.linkError = 'Wait for the current save to finish before navigating.'; cx.notify(); return; }
    this.linkError = null;
    cx.spawn(async cx => {
      try {
        if (this.dirty()) await keepDraft(root, path, this.code.value(), this.base);
        if (this.disposed || this.path !== path || this.request !== request) return;
        if (!back) this.rememberLocation();
        else this.history = this.history.slice(0, -1);
        this.open(root, target.path, on, cx, target.line || null, true);
        this.anchor = target.anchor || null; this.mode = target.mode || 'preview'; cx.notify();
      } catch (error) { if (this.path === path) { this.linkError = 'Cannot keep the current draft: ' + String(error.message || error); cx.notify(); } }
    });
  }
  backMarkdown(cx) {
    const target = this.history.at(-1); if (!target) return;
    if (target.path !== this.path) { this.navigateMarkdown(target, cx, true); return; }
    this.history = this.history.slice(0, -1); this.anchor = target.anchor; this.mode = target.mode; this.line = target.line; this.linkError = null; this.contents = false; cx.notify();
  }
  renderMarkdown(t) {
    const blocks = this.markdownBlocks || [{ text: this.data.text }];
    const found = this.anchor ? blocks.findIndex(block => block.heading?.slug === this.anchor) : 0, start = Math.max(0, found);
    const body = v_flex().id('markdown-navigation').flex_1().min_h(0).min_w(0);
    if (this.contents) body.child(v_flex().id('markdown-contents').h(Math.min(180, this.headings.length * 28)).flex_none().overflow_y_scrollbar().border_b(1).border_color(t.border)
      .children(this.headings.map(heading => div().id('markdown-heading-' + heading.slug).h(28).flex_none().pl(10 + (heading.level - 1) * 12).pr(8).text_size(TYPE.sm).truncate().tooltip(heading.title).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => this.followMarkdown('#' + encodeURIComponent(heading.slug), cx)).child(heading.title))));
    if (this.anchor) body.child(this.button('whole-document', '↑ Whole document', false, (_e, cx) => this.followMarkdown('#', cx), t).flex_none());
    if (this.headingsLimited || this.diagramsLimited) body.child(div().px(10).py(4).flex_none().text_size(TYPE.xs).text_color(t.dim).child(this.headingsLimited ? 'Contents limited to 200 headings.' : 'Only the first 24 Mermaid diagrams are rendered; later diagrams remain source.'));
    if (this.markdownBusy) body.child(div().px(10).py(4).flex_none().text_size(TYPE.xs).text_color(t.dim).child('Rendering diagrams…'));
    return body.child(v_flex().id('markdown-document-' + this.path + '-' + (this.anchor || 'top')).flex_1().min_h(0).min_w(0).overflow_y_scrollbar().p(12).gap(10)
      .children(blocks.slice(start).map((block, offset) => {
        const index = start + offset;
        if (block.diagram && block.media) return div().id('markdown-diagram-' + index).w_full().h(block.media.height).flex_none().overflow_x_scrollbar()
          .child(image(block.media.path).w(block.media.width).h(block.media.height).flex_none());
        const text = TextView.markdown('markdown-file-preview-' + index, markdownForPreview(block.text)).selectable(true).scrollable(false).w_full().flex_none().text_size(this.fontSize)
          .on_link_click((url, cx) => this.followMarkdown(url, cx));
        return block.error ? v_flex().flex_none().gap(4).child(div().text_size(TYPE.sm).text_color(t.blocked).child('Mermaid: ' + block.error)).child(text) : text;
      })));
  }
  button(id, label, active, action, t) { return div().id(`preview-${id}`).px(7).py(4).rounded(5).cursor_pointer().bg(active ? t.selected : t.surface).hover(s => s.bg(t.hover)).text_size(TYPE.sm).on_click(action).child(label); }
  render(cx) {
    if (!this.disposed && !this.fontSyncScheduled && previewFontSize(shared(PREVIEW_FONT_KEY)) !== this.fontSize) {
      this.fontSyncScheduled = true;
      cx.timer.after(0, cx => { this.fontSyncScheduled = false; if (!this.disposed) this.setFontSize(shared(PREVIEW_FONT_KEY), cx, false); });
    }
    const t = theme(), data = this.data, kind = data?.kind, loading = Boolean(this.loading);
    const body = v_flex().id('file-preview').flex_1().min_h(0).min_w(0).overflow_hidden().on_size_change((size, cx) => { if (Math.abs(this.width - size.width) > 1) { this.width = size.width; cx.notify(); } });
    if (this.find) body.track_focus(this.find.handle).on_key_down((e, cx) => {
      if (this.editing && e.key === 's' && (e.modifiers?.platform || e.modifiers?.control)) { cx.stop_propagation(); this.save(cx); return; }
      this.find.key(e, cx, !this.editing && !this.error && typeof this.data?.text === 'string');
    });
    if (this.error || !data) return body.when(Boolean(this.history.length), el => el.child(this.button('back-document', '← Back', false, (_e, cx) => this.backMarkdown(cx), t).flex_none())).child(div().p(12).text_size(TYPE.md).text_color(t.dim).child(this.error || 'Loading file…'));
    if (kind === 'markdown' && !this.editing && this.markdownLook !== JSON.stringify(diagramLook(t, settings().font_family)) && !this.markdownScheduled) {
      this.markdownScheduled = true;
      cx.timer.after(0, cx => { this.markdownScheduled = false; if (!this.disposed && this.data?.kind === 'markdown') { this.prepareMarkdown(cx); cx.notify(); } });
    }
    const switchable = !this.editing && ['markdown', 'json', 'csv', 'tsv'].includes(kind), dirty = this.dirty(), blocker = this.blocker();
    body.child(h_flex().flex_none().flex_wrap().min_h(30).px(8).gap(5).items_center()
      .when(Boolean(this.history.length), row => row.child(this.button('back-document', '← Back', false, (_e, cx) => this.backMarkdown(cx), t).tooltip('Return to the previous file or heading')))
      .when(kind === 'markdown' && !this.editing && Boolean(this.headings.length), row => row.child(this.button('contents', 'Contents', this.contents, (_e, cx) => { this.contents = !this.contents; cx.notify(); }, t).tooltip('Document headings')))
      .when(switchable, row => row.child(this.button('rendered', 'Preview', this.mode === 'preview', (_e, cx) => { this.mode = 'preview'; this.line = null; cx.notify(); }, t)).child(this.button('source', 'Source', this.mode === 'source', (_e, cx) => { this.mode = 'source'; cx.notify(); }, t)))
      .when(kind === 'image', row => row.child(this.button('zoom-out', '−', false, (_e, cx) => { this.zoom = Math.max(0.25, this.zoom / 1.5); cx.notify(); }, t)).child(this.button('fit', this.zoom === 1 ? 'Fit' : `${Math.round(this.zoom * 100)}%`, false, (_e, cx) => { this.zoom = 1; cx.notify(); }, t)).child(this.button('zoom-in', '+', false, (_e, cx) => { this.zoom = Math.min(4, this.zoom * 1.5); cx.notify(); }, t)))
      .child(div().flex_1())
      .when(typeof data.text === 'string', row => row.child(h_flex().flex_none().gap(2).items_center()
        .child(this.button('font-smaller', 'A−', false, (_e, cx) => this.setFontSize(this.fontSize - 1, cx), t).disabled(this.fontSize <= 10).tooltip('Decrease text size').accessibility_label('Decrease text size'))
        .child(this.button('font-reset', `${this.fontSize}px`, false, (_e, cx) => this.setFontSize(12, cx), t).tooltip('Reset text size to 12px').accessibility_label('Reset text size to 12px'))
        .child(this.button('font-larger', 'A+', false, (_e, cx) => this.setFontSize(this.fontSize + 1, cx), t).disabled(this.fontSize >= 24).tooltip('Increase text size').accessibility_label('Increase text size'))))
      .when(typeof data.text === 'string' && !this.editing, row => row.child(this.button('find', 'Find', this.find.visible, (_e, cx) => this.find.show(cx), t).tooltip('Find in file · ⌘F / Ctrl+F').accessibility_label('Find in file')))
      .when(this.editing, row => row
        .child(div().text_size(TYPE.xs).text_color(this.status === 'Saved' ? t.done : dirty ? t.working : t.dim).child(this.status || (dirty ? 'Unsaved changes' : 'Editing')))
        .child(this.button('edit-done', this.armed === 'discard' ? 'Discard changes?' : 'Done', false, (_e, cx) => this.finish(cx), t).when(this.armed === 'discard', el => el.text_color(t.blocked)).tooltip(dirty ? 'Stop editing (asks before discarding changes)' : 'Stop editing'))
        .child(div().id('preview-edit-save').px(9).py(4).rounded(5).text_size(TYPE.sm).font_medium().bg(t.solid).text_color(t.solid_foreground)
          .when(!dirty || this.saving, el => el.opacity(0.45).cursor_default()).when(dirty && !this.saving, el => el.cursor_pointer().hover(s => s.opacity(0.88)))
          .tooltip('Save · ⌘S / Ctrl+S').on_click((_e, cx) => this.save(cx)).child(this.saving ? 'Saving…' : 'Save')))
      .when(!this.editing && !blocker, row => row.child(this.button('edit', this.status || 'Edit', false, (_e, cx) => this.startEdit(cx), t).tooltip('Edit this file')))
      .when(!this.editing && Boolean(blocker), row => row.child(div().text_size(TYPE.xs).text_color(t.dim).tooltip(blocker === 'Read only' ? '' : blocker).child(this.loading ? 'Refreshing…' : data.truncated ? 'First 400 KB' : 'Read only')))
      .child(div().id('preview-refresh').w(24).h(24).p(0).flex_none().flex().items_center().justify_center().rounded(4)
        .text_color(loading ? t.accent : t.muted).disabled(loading).tooltip(loading ? 'Refreshing file…' : 'Refresh file preview').accessibility_label('Refresh file preview')
        .when(loading, el => el.cursor_default()).when(!loading, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
        .on_click((_e, cx) => { if (!this.loading) { this.refresh(cx); cx.notify(); } })
        .child(svg('mods/files-plus/refresh.svg').id('preview-refresh-icon').size(14).flex_none().when(loading, el => el.spin(850)))));
    if (this.draft && !this.editing) body.child(this.banner(t, t.working, `Unsaved edits from ${draftAge(this.draft.saved)}.`, [
      this.button('draft-restore', 'Restore', false, (_e, cx) => this.startEdit(cx, this.draft), t),
      this.button('draft-discard', this.armed === 'draft' ? 'Discard?' : 'Discard', false, (_e, cx) => this.confirm('draft', cx, () => { dropDraft(this.root, this.path); this.draft = null; cx.notify(); }), t)]));
    if (this.conflict) body.child(this.banner(t, t.blocked, this.conflict.disk === null ? 'Not saved: the file was deleted or moved while you edited it.' : 'Not saved: the file changed on disk since you started editing. Your edits are kept.', [
      this.button('conflict-copy', 'Copy my edits', false, (_e, cx) => { cx.write_to_clipboard(this.code.value()); this.status = 'Edits copied'; cx.notify(); }, t),
      this.button('conflict-reload', this.armed === 'reload' ? 'Discard my edits?' : 'Reload from disk', false, (_e, cx) => this.confirm('reload', cx, () => this.reload(cx)), t),
      this.button('conflict-overwrite', this.armed === 'overwrite' ? 'Overwrite?' : this.conflict.disk === null ? 'Save as new file' : 'Overwrite', false, (_e, cx) => this.confirm('overwrite', cx, () => this.save(cx, this.conflict.disk)), t)]));
    else if (this.external && this.editing) body.child(this.banner(t, t.working, 'This file changed on disk while you were editing.', [
      this.button('external-reload', this.armed === 'reload' ? 'Discard my edits?' : 'Reload from disk', false, (_e, cx) => this.confirm('reload', cx, () => this.reload(cx)), t),
      this.button('external-keep', 'Keep my version', false, (_e, cx) => { this.external = false; cx.notify(); }, t)]));
    if (this.linkError) body.child(div().px(10).py(4).text_size(TYPE.sm).text_color(t.blocked).child(this.linkError));
    if (this.parseError && !this.editing) body.child(div().px(10).py(4).text_size(TYPE.sm).text_color(t.blocked).child(this.parseError));
    if (this.find?.visible && typeof data.text === 'string' && !this.editing) {
      body.child(this.find.bar(t));
      if (this.find.result.matches.length) return body.child(this.find.content(t, this.width, this.fontSize));
    }
    if (kind === 'image') {
      const scale = Math.min(1, Math.max(40, this.width - 24) / data.width) * (this.zoom || 1);
      return body.child(div().id('image-preview-scroll').flex_1().min_h(0).overflow_scroll().p(10).child(image(data.image).w(data.width * scale).h(data.height * scale).flex_none()));
    }
    if (this.line && this.mode === 'source') {
      const excerpt = data.excerpt || lineExcerpt(data.text, this.line);
      if (excerpt.selected !== this.line) return body.child(div().p(12).text_color(t.blocked).child(`Line ${this.line} is outside the available preview; the file may have changed.`));
      return body.child(h_flex().px(10).gap(8).items_center().child(div().text_size(TYPE.sm).text_color(t.muted).child(`Line ${excerpt.selected}`)).child(this.button('whole-file', 'Whole file', false, (_e, cx) => { this.line = null; cx.notify(); }, t)))
        .child(v_flex().id('matched-line-preview').flex_1().min_h(0).overflow_scroll().children(excerpt.rows.map(row => h_flex().min_h(Math.ceil(this.fontSize * 1.8)).flex_none().px(8).gap(10).bg(row.line === excerpt.selected ? t.selected : t.background).child(div().w(44).flex_none().text_right().text_size(TYPE.sm).text_color(t.dim).child(String(row.line))).child(div().min_w(0).text_size(this.fontSize).child(row.text || ' ')))));
    }
    if (this.editing || this.mode === 'source' || kind === 'source' || this.parseError) return body.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(10).child('No text preview'));
    if (kind === 'markdown') return body.child(this.renderMarkdown(t));
    if (kind === 'json') {
      const result = jsonRows(this.json, this.expanded);
      return body.child(v_flex().id('json-file-preview').flex_1().min_h(0).overflow_scroll().p(6).text_size(this.fontSize).children(result.rows.map(row => h_flex().id(`json-${row.path}`).flex_none().min_h(Math.max(25, Math.ceil(this.fontSize * 1.8))).pl(6 + row.depth * 14).pr(8).gap(6).cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => { if (row.branch) { this.expanded.has(row.path) ? this.expanded.delete(row.path) : this.expanded.add(row.path); cx.notify(); } }).child(div().w(10).flex_none().text_color(t.dim).child(row.branch ? row.open ? '▾' : '▸' : '')).child(div().text_color(t.accent).child(`${row.key}:`)).child(div().text_size(this.fontSize).text_color(t.muted).child(String(row.value).slice(0, 2000))))).when(result.limited, el => el.child(div().p(8).text_size(TYPE.sm).text_color(t.dim).child('JSON tree limited to 1,000 visible nodes and 40 levels'))));
    }
    if (kind === 'csv' || kind === 'tsv') return body
      .when(Boolean(this.table.error || this.table.truncated), el => el.child(div().p(8).text_size(TYPE.sm).text_color(t.blocked).child(this.table.error || 'Table limited to 500 rows and 40 columns')))
      .child(v_flex().id('table-file-preview').flex_1().min_h(0).overflow_scroll().children(this.table.rows.map((row, i) => h_flex().id(`table-row-${i}`).min_h(28).flex_none().bg(i === 0 ? t.surface : t.background).border_b(1).border_color(t.border).child(div().w(40).flex_none().p(6).text_color(t.dim).text_size(TYPE.xs).child(String(i + 1))).children(row.map(cell => div().w(160).flex_none().p(6).border_r(1).border_color(t.border).text_size(this.fontSize).child(cell.slice(0, 3000)))))));
    return body.child(div().p(10).text_color(t.dim).child('No preview available'));
  }
}
