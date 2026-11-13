import { TYPE } from "./type-scale.js";
import { fileIcon, closeButton } from "./icons.js";
// Project search stays read-only and captures its folder when opened.
import { div, svg } from 'gpui-kit';
import { v_flex, h_flex, Input, InputState } from 'gpui-base';
import { exec, appHome, theme, spaces, panes, focused, shared, setShared, openOverlay, readTextFile } from 'herdr';
import { LIBRARY_KEY, updateLibrary } from "./library-model.js";
import { projectContext } from "./file-tabs.js";
import Preview from './preview.js';
import { searchArgs, parseSearchOutput, groupedMatches, combineWorkspaceResults } from './search-model.js';
export default class Search {
  init(props, cx) {
    const context = projectContext();
    this.root = props.root || context.cwd; this.on = Object.prototype.hasOwnProperty.call(props, "on") ? props.on : context.on; this.overlay = props.overlay; this.rg = props.rg;
    this.roots = (Array.isArray(props.roots) && props.roots.length ? props.roots : [{ root: this.root, on: this.on }]).slice(0, 8).filter(source => typeof source.root === 'string' && source.root && !/[\x00-\x1f\x7f]/.test(source.root)).map(source => ({ ...source, on: Object.hasOwn(source, 'on') ? source.on : this.on }));
    if (this.roots.length) { this.root = this.roots[0].root; this.on = this.roots[0].on ?? null; }
    this.mode = 'content'; this.options = { caseSensitive: false, wholeWord: false, regex: false, hidden: false };
    this.query = InputState.new({ placeholder: 'Search project…' }); this.include = InputState.new({ placeholder: 'Include: *.js, src/**' }); this.exclude = InputState.new({ placeholder: 'Exclude: vendor/**, *.lock' });
    this.preview = new Preview(); this.matches = []; this.collapsed = new Set(); this.revision = 0;
    for (const input of [this.query, this.include, this.exclude]) { input.on('change', (_e, cx) => this.schedule(cx)); input.on('submit', (_e, cx) => this.run(cx)); }
    this.refreshTimer = cx.timer.every(10000, cx => this.preview.refresh(cx));
    cx.timer.after(0, () => { if (!this.disposed) this.query.focus(); });
  }
  schedule(cx) {
    const revision = ++this.revision; this.loading = false;
    cx.timer.after(300, cx => { if (!this.disposed && revision === this.revision) this.run(cx); }); cx.notify();
  }
  run(cx) {
    if (this.disposed) return;
    const revision = ++this.revision, query = this.query.value();
    if (!query.trim() || !this.root) { this.matches = []; this.selected = null; this.preview.clear(); this.searched = ""; this.loading = false; this.error = null; this.warning = null; cx.notify(); return; }
    const options = { ...this.options, query, rg: this.rg, root: this.root, mode: this.mode, include: this.include.value(), exclude: this.exclude.value() };
    this.loading = true; this.error = null; this.warning = null; this.matches = []; this.selected = null; this.preview.clear();
    const sources = this.roots || [{ root: this.root, on: this.on }];
    cx.spawn(async cx => {
      try {
        const results = new Array(sources.length); let at = 0;
        const worker = async () => {
          while (at < sources.length && revision === this.revision) {
            const index = at++, source = sources[index], captured = { ...options, root: source.root };
            try {
              let result;
              if (source.on) {
                const output = await exec(this.rg || 'rg', searchArgs(captured), { cwd: source.root, on: source.on });
                if (output.code > 1) throw new Error(output.stderr || 'Search failed');
                result = parseSearchOutput(output.stdout, captured.mode, captured);
                if (result.limited) result.warning = 'Search limited to 500 matches';
              } else {
                const output = await exec('node', [`${appHome()}/mods/files-plus/search-helper.mjs`, JSON.stringify(captured)]);
                result = JSON.parse(output.stdout || '{}');
                if (output.code && !result.error) throw new Error(output.stderr || 'Search failed');
              }
              if (result.error) throw new Error(result.error);
              results[index] = { ...result, source };
            } catch (error) { results[index] = { source, error: String(error.message || error) }; }
          }
        };
        await Promise.all(Array.from({ length: Math.min(2, sources.length) }, worker));
        if (revision !== this.revision) return;
        const result = combineWorkspaceResults(results);
        this.matches = result.matches; this.warning = result.warning; this.searched = query;
      } catch (error) { if (revision === this.revision) this.error = String(error.message || error); }
      finally { if (revision === this.revision) this.loading = false; cx.notify(); }
    }); cx.notify();
  }
  choose(match, cx) {
    const root = match.root || this.root, on = Object.hasOwn(match, "on") ? match.on : this.on;
    setShared(LIBRARY_KEY, updateLibrary(shared(LIBRARY_KEY), root, on, "open", match.path)); this.selected = match; this.preview.open(root, match.path, on, cx, match.line); cx.notify();
  }
  reference(cx) {
    const match = this.selected;
    if (!match || this.referenceBusy) return;
    const reference = { root: match.root || this.root, relative: match.path, on: Object.hasOwn(match, "on") ? match.on : this.on, line: match.line };
    this.referenceBusy = true;
    cx.spawn(async cx => {
      try {
        if (await readTextFile(`${appHome()}/mods/sessions-plus/mod.json`) === null) throw new Error("Pending prompts requires the Sessions Plus companion. Run the full workspace updater first.");
        if (!this.disposed) openOverlay({ mod: "sessions-plus", kind: "dialog", frame: "none", width: 660, height: 540, props: { role: "prompt-queue", reference } });
      } catch (error) { if (!this.disposed) this.error = String(error.message || error); }
      finally { this.referenceBusy = false; if (!this.disposed) cx.notify(); }
    });
  }
  toggle(key, cx) { this.options[key] = !this.options[key]; this.schedule(cx); }
  close() { this.disposed = true; ++this.revision; this.refreshTimer?.cancel?.(); for (const state of [this.query, this.include, this.exclude]) state?.release(); this.preview.close(); }
  chip(id, label, active, action, t, tooltip) { return div().id(`search-${id}`).px(7).py(5).rounded(5).flex_none().cursor_pointer().bg(active ? t.selected : t.surface).hover(s => s.bg(t.hover)).tooltip(tooltip || label).on_click(action).child(label); }
  render(cx) {
    const t = theme(), groups = groupedMatches(this.matches), empty = !this.query.value().trim(), loading = Boolean(this.loading);
    return v_flex().id('project-search').size_full().min_h(0).min_w(0).rounded(10).overflow_hidden().border_1().border_color(t.border).bg(t.background).text_color(t.foreground).text_size(TYPE.md).p(12).gap(8)
      .child(h_flex().flex_none().gap(8).items_center().child(div().font_semibold().text_size(TYPE.lg).child(this.roots?.length > 1 ? 'Workspace search' : 'Project search')).child(div().flex_1().min_w(0).truncate().text_color(t.dim).tooltip(this.roots?.map(source => source.root).join(' · ') || this.root || '').child(this.roots?.length > 1 ? `${this.roots.length} folders` : this.root || 'No folder')))
      .child(h_flex().flex_none().gap(5).items_center().child(Input.new(this.query).h(32).flex_1().min_w(80).px(8).rounded(5).bg(t.surface).border_1().border_color(t.input))
        .child(this.chip('content', 'Content', this.mode === 'content', (_e, cx) => { this.mode = 'content'; this.schedule(cx); }, t))
        .child(this.chip('files', 'Files', this.mode === 'files', (_e, cx) => { this.mode = 'files'; this.schedule(cx); }, t))
        .child(div().id('search-refresh').w(24).h(24).p(0).flex_none().flex().items_center().justify_center().rounded(4)
          .text_color(loading ? t.accent : t.muted).disabled(loading).tooltip(`${loading ? 'Searching…' : 'Run search'}\nRead only · respects ignore rules · up to 500 matches / 30 per file · files up to 2 MiB`).accessibility_label('Run search')
          .when(loading, el => el.cursor_default()).when(!loading, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
          .on_click((_e, cx) => { if (!this.loading) this.run(cx); })
          .child(svg('mods/files-plus/refresh.svg').id('search-refresh-icon').size(14).flex_none().when(loading, el => el.spin(850)))))
      .child(h_flex().flex_none().gap(5).items_center()
        .child(this.chip('case', 'Aa', this.options.caseSensitive, (_e, cx) => this.toggle('caseSensitive', cx), t, 'Match case'))
        .child(this.chip('word', 'Word', this.options.wholeWord, (_e, cx) => this.toggle('wholeWord', cx), t, 'Match whole word'))
        .child(this.chip('regex', '.*', this.options.regex, (_e, cx) => this.toggle('regex', cx), t, 'Regular expression'))
        .child(this.chip('hidden', 'Hidden', this.options.hidden, (_e, cx) => this.toggle('hidden', cx), t, 'Include hidden files (ignore rules still apply)'))
        .child(div().flex_1().text_right().text_color(t.dim).child(this.loading ? 'Searching…' : `${this.matches.length} matches · ${groups.length} files`)))
      .child(h_flex().flex_none().gap(6).child(Input.new(this.include).h(28).flex_1().min_w(0).px(8).rounded(5).bg(t.surface)).child(Input.new(this.exclude).h(28).flex_1().min_w(0).px(8).rounded(5).bg(t.surface)))
      .when(Boolean(this.error || this.warning), el => el.child(div().flex_none().text_color(t.blocked).child(this.error || this.warning)))
      .child(h_flex().id('search-panes').flex_1().min_h(0).min_w(0).items_stretch().overflow_hidden().gap(10)
        .child(v_flex().id('search-results').flex_1().h_full().min_w(0).min_h(0).overflow_y_scrollbar()
          .when(Boolean(this.selected), el => el.max_w(350))
          .when(!groups.length, el => el.child(div().p(10).text_color(t.dim).child(empty ? 'Enter text to search this folder. File filters accept comma-separated globs.' : this.loading ? 'Searching…' : this.error ? '' : 'No matches')))
          .children(groups.map(group => v_flex().flex_none().min_w(0).mb(6)
            .child(h_flex().id(`search-file-${group.key || group.path}`).min_h(30).px(6).gap(6).items_center().cursor_pointer().bg(t.surface).on_click((_e, cx) => { if (this.mode === 'files') this.choose(group.matches[0], cx); else { this.collapsed.has(group.key || group.path) ? this.collapsed.delete(group.key || group.path) : this.collapsed.add(group.key || group.path); cx.notify(); } }).child(div().text_color(t.dim).child(this.mode === 'files' ? '•' : this.collapsed.has(group.key || group.path) ? '▸' : '▾')).child(fileIcon(group.path)).child(div().flex_1().min_w(0).truncate().tooltip(group.root ? `${group.root}/${group.path}` : group.path).child(group.root ? `${group.rootName} · ${group.path}` : group.path)).when(this.mode !== 'files', el => el.child(div().text_color(t.dim).child(String(group.matches.length)))))
            .when(this.mode !== 'files' && !this.collapsed.has(group.key || group.path), el => el.children(group.matches.map((match, i) => h_flex().id(`search-match-${group.key || group.path}-${i}`).min_h(28).px(8).gap(6).items_center().cursor_pointer().bg(this.selected === match ? t.selected : t.background).hover(s => s.bg(t.hover)).on_click((_e, cx) => this.choose(match, cx)).child(div().w(40).flex_none().text_right().text_color(t.dim).child(String(match.line))).child(div().flex_1().min_w(0).truncate().child(match.text))))))))
        .when(Boolean(this.selected), el => el.child(v_flex().id('search-preview-pane').flex_1().h_full().min_w(0).min_h(0).overflow_hidden().border_l(1).border_color(t.border)
          .child(h_flex().flex_none().px(8).gap(6).items_center().child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(this.selected.path)).child(this.chip('add-reference', 'Add reference', false, (_e, cx) => this.reference(cx), t, 'Add this file and line to pending prompts')).child(closeButton('search-close-preview', 'Close preview', (_e, cx) => { this.selected = null; this.preview.clear(); cx.notify(); }, t)))
          .child(this.preview.render(cx)))));
  }
}
