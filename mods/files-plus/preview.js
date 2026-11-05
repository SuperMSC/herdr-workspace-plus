// Native, read-only type previews. Retained editors and view IDs survive refreshes.
import { div, image, svg } from 'gpui-kit';
import { h_flex, v_flex, Editor, EditorState, TextView } from 'gpui-base';
import { exec, appHome, readTextFile, theme, settings, shared, setShared } from 'herdr';
import { fileKind, parseDelimited, jsonRows, lineExcerpt, markdownForPreview, TEXT_LIMIT, PREVIEW_FONT_KEY, previewFontSize } from './preview-model.js';
import FileFind from './file-find.js';
const LANG = { ts: 'js', tsx: 'js', mts: 'js', cts: 'js', jsx: 'js', mjs: 'js', toml: 'yaml', jsonc: 'json', svelte: 'html', vue: 'html', md: 'markdown' };
export default class Preview {
  constructor() { this.expanded = new Set(['$']); this.width = 320; this.mode = 'preview'; this.fontSize = 12; }
  clear() { this.request = {}; this.code?.release(); this.code = null; this.path = null; this.data = null; this.error = null; this.loading = false; this.find?.clear(); }
  open(root, path, on, cx, line = null) {
    this.clear(); this.root = root; this.path = path; this.on = on; this.line = line; this.mode = line ? 'source' : 'preview'; this.expanded = new Set(['$']); this.zoom = 1;
    this.disposed = false; this.fontSize = previewFontSize(shared(PREVIEW_FONT_KEY));
    if (!this.find) this.find = new FileFind(cx);
    if (!line) cx.timer.after(0, () => this.find?.handle.focus());
    if (path) this.refresh(cx);
  }
  refresh(cx) {
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
        }
      } catch (error) { if (this.request === request) this.error = `Cannot preview this file: ${String(error)}`; }
      finally { if (this.request === request) this.loading = false; cx.notify(); }
    });
  }
  createEditor() {
    if (typeof this.data?.text !== 'string') return;
    const t = theme(), ext = this.path.split('.').pop().toLowerCase();
    this.code?.release();
    this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true, value: this.data.text, font_family: settings().font_family, font_size: this.fontSize, syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
  }
  setFontSize(size, cx, persist = true) {
    if (this.disposed) return;
    const next = previewFontSize(size);
    if (next !== this.fontSize) { this.fontSize = next; this.createEditor(); if (this.find?.visible) this.find.locate(); }
    if (persist) setShared(PREVIEW_FONT_KEY, next);
    cx.notify();
  }
  close() { this.disposed = true; this.clear(); this.find?.close(); this.find = null; }
  button(id, label, active, action, t) { return div().id(`preview-${id}`).px(7).py(4).rounded(5).cursor_pointer().bg(active ? t.selected : t.surface).hover(s => s.bg(t.hover)).text_size(11).on_click(action).child(label); }
  render(cx) {
    if (!this.disposed && !this.fontSyncScheduled && previewFontSize(shared(PREVIEW_FONT_KEY)) !== this.fontSize) {
      this.fontSyncScheduled = true;
      cx.timer.after(0, cx => { this.fontSyncScheduled = false; if (!this.disposed) this.setFontSize(shared(PREVIEW_FONT_KEY), cx, false); });
    }
    const t = theme(), data = this.data, kind = data?.kind, loading = Boolean(this.loading);
    const body = v_flex().id('file-preview').flex_1().min_h(0).min_w(0).overflow_hidden().on_size_change((size, cx) => { if (Math.abs(this.width - size.width) > 1) { this.width = size.width; cx.notify(); } });
    if (this.find) body.track_focus(this.find.handle).on_key_down((e, cx) => this.find.key(e, cx, !this.error && typeof this.data?.text === 'string'));
    if (this.error || !data) return body.child(div().p(12).text_size(12).text_color(t.dim).child(this.error || 'Loading file…'));
    const switchable = ['markdown', 'json', 'csv', 'tsv'].includes(kind);
    body.child(h_flex().flex_none().flex_wrap().min_h(30).px(8).gap(5).items_center()
      .when(switchable, row => row.child(this.button('rendered', 'Preview', this.mode === 'preview', (_e, cx) => { this.mode = 'preview'; this.line = null; cx.notify(); }, t)).child(this.button('source', 'Source', this.mode === 'source', (_e, cx) => { this.mode = 'source'; cx.notify(); }, t)))
      .when(kind === 'image', row => row.child(this.button('zoom-out', '−', false, (_e, cx) => { this.zoom = Math.max(0.25, this.zoom / 1.5); cx.notify(); }, t)).child(this.button('fit', this.zoom === 1 ? 'Fit' : `${Math.round(this.zoom * 100)}%`, false, (_e, cx) => { this.zoom = 1; cx.notify(); }, t)).child(this.button('zoom-in', '+', false, (_e, cx) => { this.zoom = Math.min(4, this.zoom * 1.5); cx.notify(); }, t)))
      .child(div().flex_1())
      .when(typeof data.text === 'string', row => row.child(h_flex().flex_none().gap(2).items_center()
        .child(this.button('font-smaller', 'A−', false, (_e, cx) => this.setFontSize(this.fontSize - 1, cx), t).disabled(this.fontSize <= 10).tooltip('Decrease text size').accessibility_label('Decrease text size'))
        .child(this.button('font-reset', `${this.fontSize}px`, false, (_e, cx) => this.setFontSize(12, cx), t).tooltip('Reset text size to 12px').accessibility_label('Reset text size to 12px'))
        .child(this.button('font-larger', 'A+', false, (_e, cx) => this.setFontSize(this.fontSize + 1, cx), t).disabled(this.fontSize >= 24).tooltip('Increase text size').accessibility_label('Increase text size'))))
      .when(typeof data.text === 'string', row => row.child(this.button('find', 'Find', this.find.visible, (_e, cx) => this.find.show(cx), t).tooltip('Find in file · ⌘F / Ctrl+F').accessibility_label('Find in file')))
      .child(div().text_size(10).text_color(t.dim).child(this.loading ? 'Refreshing…' : data.truncated ? 'First 400 KB' : 'Read only'))
      .child(div().id('preview-refresh').w(24).h(24).p(0).flex_none().flex().items_center().justify_center().rounded(4)
        .text_color(loading ? t.accent : t.muted).disabled(loading).tooltip(loading ? 'Refreshing file…' : 'Refresh file preview').accessibility_label('Refresh file preview')
        .when(loading, el => el.cursor_default()).when(!loading, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
        .on_click((_e, cx) => { if (!this.loading) { this.refresh(cx); cx.notify(); } })
        .child(svg('mods/files-plus/refresh.svg').id('preview-refresh-icon').size(14).flex_none().when(loading, el => el.spin(850)))));
    if (this.parseError) body.child(div().px(10).py(4).text_size(11).text_color(t.blocked).child(this.parseError));
    if (this.find?.visible && typeof data.text === 'string') {
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
      return body.child(h_flex().px(10).gap(8).items_center().child(div().text_size(11).text_color(t.muted).child(`Line ${excerpt.selected}`)).child(this.button('whole-file', 'Whole file', false, (_e, cx) => { this.line = null; cx.notify(); }, t)))
        .child(v_flex().id('matched-line-preview').flex_1().min_h(0).overflow_scroll().children(excerpt.rows.map(row => h_flex().min_h(Math.ceil(this.fontSize * 1.8)).flex_none().px(8).gap(10).bg(row.line === excerpt.selected ? t.selected : t.background).child(div().w(44).flex_none().text_right().text_size(11).text_color(t.dim).child(String(row.line))).child(div().min_w(0).text_size(this.fontSize).child(row.text || ' ')))));
    }
    if (this.mode === 'source' || kind === 'source' || this.parseError) return body.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(10).child('No text preview'));
    if (kind === 'markdown') return body.child(TextView.markdown('markdown-file-preview', markdownForPreview(data.text)).selectable(true).scrollable(true).flex_1().min_h(0).p(12).text_size(this.fontSize));
    if (kind === 'json') {
      const result = jsonRows(this.json, this.expanded);
      return body.child(v_flex().id('json-file-preview').flex_1().min_h(0).overflow_scroll().p(6).text_size(this.fontSize).children(result.rows.map(row => h_flex().id(`json-${row.path}`).flex_none().min_h(Math.max(25, Math.ceil(this.fontSize * 1.8))).pl(6 + row.depth * 14).pr(8).gap(6).cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => { if (row.branch) { this.expanded.has(row.path) ? this.expanded.delete(row.path) : this.expanded.add(row.path); cx.notify(); } }).child(div().w(10).flex_none().text_color(t.dim).child(row.branch ? row.open ? '▾' : '▸' : '')).child(div().text_color(t.accent).child(`${row.key}:`)).child(div().text_size(this.fontSize).text_color(t.muted).child(String(row.value).slice(0, 2000))))).when(result.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child('JSON tree limited to 1,000 visible nodes and 40 levels'))));
    }
    if (kind === 'csv' || kind === 'tsv') return body
      .when(Boolean(this.table.error || this.table.truncated), el => el.child(div().p(8).text_size(11).text_color(t.blocked).child(this.table.error || 'Table limited to 500 rows and 40 columns')))
      .child(v_flex().id('table-file-preview').flex_1().min_h(0).overflow_scroll().children(this.table.rows.map((row, i) => h_flex().id(`table-row-${i}`).min_h(28).flex_none().bg(i === 0 ? t.surface : t.background).border_b(1).border_color(t.border).child(div().w(40).flex_none().p(6).text_color(t.dim).text_size(10).child(String(i + 1))).children(row.map(cell => div().w(160).flex_none().p(6).border_r(1).border_color(t.border).text_size(this.fontSize).child(cell.slice(0, 3000)))))));
    return body.child(div().p(10).text_color(t.dim).child('No preview available'));
  }
}
