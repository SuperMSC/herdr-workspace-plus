import { projectContext } from "./file-tabs.js";
import { fileIcon } from "./icons.js";
// Modified from Herdr Changes (Apache-2.0). Git reads and UI extensions are independent of Git write actions.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, VirtualListScrollHandle, v_resizable, resizable_panel } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, openOverlay, shared, setShared } from "herdr";
import { CHANGE_KEY, targetFor, menuHeight } from "./model.js";
import { fileKey, fileTree, diffRows, splitRows, splitDisplay, inlineDisplay, diffCounts, treeFolders } from "./git-model.js";
import { createGitReader, READ } from "./git-reader.js";
import { diffView, splitHeader } from "./git-diff.js";

function location() { const { cwd, on } = projectContext(); return { cwd, on }; }
const button = (id, label, selected, action, t) => div().id(id).px(7).py(4).rounded(5).text_size(11).flex_none().cursor_pointer().bg(selected ? t.selected : t.background).text_color(selected ? t.foreground : t.muted).hover(e => e.bg(t.hover)).tooltip(id === "git-expand" ? "Open larger diff preview" : id === "git-refresh" ? "Refresh Git data" : label).accessibility_label(id === "git-expand" ? "Open larger diff preview" : id === "git-refresh" ? "Refresh Git data" : label).on_click((_e, cx) => action(cx)).child(label);

export default class Changes {
  init(props, cx) {
    this.props = props || {}; this.source = this.props.source;
    this.page = this.props.selection?.commit ? "history" : "changes";
    this.listMode = this.props.listMode || "tree"; this.diffMode = this.props.diffMode || "inline"; this.collapsed = new Set();
    this.lastChange = shared(CHANGE_KEY)?.revision;
    this.refreshRequest = 0; this.diffRequest = 0; this.historyRequest = 0; this.commitRequest = 0;
    this.reloadAgain = false; this.hasStaged = false; this.files = []; this.historyFiles = []; this.commits = [];
    this.rows = []; this.split = []; this.diffWidth = 0; this.message = ""; this.branch = {};
    this.handle = cx.focus_handle(); this.diffScroll = VirtualListScrollHandle.new(); this.showFiles = Boolean(this.props.showFiles);
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim()); this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, cx => { if (!this.disposed) this.refresh(cx); });
  }

  sourceLocation() { return this.source ? { cwd: this.source.cwd, on: this.source.on ?? null } : location(); }
  contextKey() { return JSON.stringify(this.sourceLocation()); }
  current(context, request) { return !this.disposed && this.context === context && this.contextKey() === context && (request === undefined || this.refreshRequest === request); }
  reader() { return createGitReader(exec, readTextFile, { root: this.root, on: this.on }); }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root; const context = this.context;
    cx.spawn(async cx => {
      try {
        while (this.current(context) && this.watched === root) {
          await watchFolder(root);
          if (this.current(context) && this.watched === root) this.refresh(cx);
        }
      } catch { if (this.context === context && this.watched === root) this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.disposed) return;
    const { cwd, on } = this.sourceLocation(), context = this.contextKey();
    if (context !== this.context) {
      this.refreshRequest++; this.diffRequest++; this.historyRequest++; this.commitRequest++;
      this.loading = false; this.historyLoading = false; this.commitLoading = false; this.reloadAgain = false;
      this.context = context; this.root = null; this.on = on; this.files = []; this.open = null; this.section = null; this.hasStaged = false;
      this.commits = []; this.historyFiles = []; this.selectedCommit = null; this.historyLoaded = false; this.branch = {};
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    if (this.loading || this.busy) { this.reloadAgain = true; return; }
    const request = ++this.refreshRequest; this.loading = true;
    cx.spawn(async cx => {
      try {
        const top = await exec("git", [...READ, "rev-parse", "--show-toplevel"], { cwd, on });
        if (!this.current(context, request)) return;
        if (top.code !== 0) {
          this.root = null; this.files = []; this.hasStaged = false; this.open = null; this.setLines([]); this.error = "Not a git repository"; return;
        }
        const root = top.stdout.replace(/\r?\n$/, ""), reader = createGitReader(exec, readTextFile, { root, on });
        const snapshot = await reader.snapshot();
        if (!this.current(context, request)) return;
        const headChanged = this.branch.oid !== snapshot.branch.oid;
        this.root = root; this.on = on; this.files = snapshot.files; this.limited = snapshot.limited; this.fileCount = snapshot.count; this.branch = snapshot.branch; this.error = null;
        this.hasStaged = this.files.some(file => file.section === "staged"); this.watch(root, cx);
        const initial = this.props?.selection;
        if (!this.initialSelectionApplied && initial && this.root) {
          this.initialSelectionApplied = true;
          if (initial.commit) {
            const commit = { hash: initial.commit, parents: initial.parents || [], subject: initial.subject || initial.commit.slice(0, 8) };
            if (this.props.expanded) this.selectCommit(commit, cx, initial.path); else this.showCommit(commit, cx);
          }
          else { this.open = initial.path; this.section = initial.section; }
        }
        if (this.page === "history") {
          if (!this.historyLoaded || headChanged) this.loadHistory(cx, true);
        } else {
          if (this.open && !this.selectedFile()) { this.open = null; this.diffRequest++; this.setLines([]); }
          if (!this.open && !this.closed && this.files.length) { this.open = this.files[0].path; this.section = this.files[0].section; }
          if (this.open) await this.load(this.open, context);
        }
      } catch (error) { if (this.current(context, request)) this.error = String(error.message ?? error); }
      finally {
        if (this.context === context && this.refreshRequest === request) {
          this.loading = false;
          if (this.reloadAgain) { this.reloadAgain = false; this.refresh(cx); }
        }
        if (!this.disposed) cx.notify();
      }
    });
  }

  selectedFile() {
    return (this.page === "history" ? this.historyFiles : this.files).find(file => file.path === this.open && (!this.section || file.section === this.section));
  }

  async load(path, context) {
    const request = ++this.diffRequest, file = this.selectedFile() || this.files.find(file => file.path === path);
    const root = this.root, section = this.section;
    const current = () => this.current(context) && this.open === path && this.section === section && this.diffRequest === request && this.root === root;
    if (!file) return;
    this.diffLoading = true;
    try {
      const result = await this.reader().diff(file);
      if (current()) { if (result.additions !== undefined) file.add = result.additions; this.note = null; this.setLines(result.lines); }
    } catch (error) { if (current()) { this.setLines([]); this.note = `Cannot preview this diff: ${error.message ?? error}`; } }
    finally { if (current()) this.diffLoading = false; }
  }

  setLines(lines) {
    const rows = diffRows(lines); this.rows = inlineDisplay(rows); this.split = splitDisplay(splitRows(rows)); this.counts = diffCounts(rows);
    this.diffWidth = Math.max(300, ...this.rows.map(row => Math.min(row.text.length, 4000) * 7 + 130));
  }

  pick(file, cx) {
    if (typeof file === "string") file = this.files.find(item => item.path === file);
    if (!file) return;
    const selected = this.selectedFile(); this.open = selected && fileKey(selected) === fileKey(file) ? null : file.path;
    this.section = file.section; this.diffRequest++; this.setLines([]); this.note = null; this.diffLoading = false; this.closed = !this.open;
    this.diffScroll?.scroll_to_item(0);
    const context = this.context;
    if (this.open) cx.spawn(async cx => { await this.load(file.path, context); if (!this.disposed) cx.notify(); });
    cx.notify();
  }

  setPage(page, cx) {
    if (this.page === page) return;
    this.page = page; if (this.props.expanded) this.showFiles = true; this.open = null; this.section = null; this.diffRequest++; this.setLines([]); this.note = null; this.diffLoading = false;
    if (page === "history") {
      if (!this.historyLoaded) this.loadHistory(cx, true);
      else if (!this.props.expanded) { const commit = this.selectedCommit || this.commits[0]; if (commit) this.showCommit(commit, cx); }
      else if (this.historyFiles.length) this.pick(this.historyFiles[0], cx);
    } else { this.closed = false; if (this.files.length) this.pick(this.files[0], cx); }
    cx.notify();
  }

  loadHistory(cx, reset = false) {
    if (!this.root || (this.historyLoading && !reset)) return;
    const context = this.context, root = this.root, request = ++this.historyRequest, offset = reset ? 0 : this.commits.length;
    this.historyLoading = true; this.historyError = null;
    cx.spawn(async cx => {
      try {
        const page = await this.reader().history(offset);
        if (!this.current(context) || this.root !== root || this.historyRequest !== request) return;
        this.commits = reset ? page.commits : [...this.commits, ...page.commits.filter(commit => !this.commits.some(old => old.hash === commit.hash))];
        this.historyMore = page.more; this.historyLoaded = true;
        if (!this.selectedCommit && this.page === "history" && this.commits.length) {
          if (this.props.expanded) this.selectCommit(this.commits[0], cx); else this.showCommit(this.commits[0], cx);
        }
      } catch (error) { if (this.current(context) && this.historyRequest === request) this.historyError = String(error.message ?? error); }
      finally { if (this.current(context) && this.historyRequest === request) this.historyLoading = false; if (!this.disposed) cx.notify(); }
    });
  }

  selectCommit(commit, cx, selectedPath) {
    this.selectedCommit = commit; this.historyFiles = []; this.open = null; this.section = "history"; this.setLines([]); this.diffRequest++; this.note = null; this.commitLoading = true;
    const context = this.context, request = ++this.commitRequest;
    cx.spawn(async cx => {
      try {
        const files = await this.reader().files(commit);
        if (!this.current(context) || this.commitRequest !== request || this.selectedCommit?.hash !== commit.hash) return;
        this.historyFiles = files;
        if (this.page === "history" && files.length) {
          this.open = files.find(file => file.path === selectedPath)?.path || files[0].path;
          this.diffScroll?.scroll_to_item(0); await this.load(this.open, context);
        }
      } catch (error) { if (this.current(context) && this.commitRequest === request) this.note = `Cannot load this commit: ${error.message ?? error}`; }
      finally { if (this.current(context) && this.commitRequest === request) this.commitLoading = false; if (!this.disposed) cx.notify(); }
    });
    cx.notify();
  }

  // The sidebar's History: the selected commit's whole diff under the commit list.
  showCommit(commit, cx) {
    this.selectedCommit = commit; this.open = null; this.section = "history"; this.note = null; this.setLines([]); this.diffLoading = true;
    const context = this.context, request = ++this.diffRequest;
    this.diffScroll?.scroll_to_item(0);
    cx.spawn(async cx => {
      const current = () => this.current(context) && this.diffRequest === request && this.selectedCommit?.hash === commit.hash;
      try { const result = await this.reader().commitDiff(commit); if (current()) this.setLines(result.lines); }
      catch (error) { if (current()) this.note = `Cannot load this commit: ${error.message ?? error}`; }
      finally { if (current()) this.diffLoading = false; if (!this.disposed) cx.notify(); }
    });
    cx.notify();
  }

  openCommit(commit) {
    if (!this.root) return;
    openOverlay({ mod: "files-plus", kind: "dialog", frame: "none", width: 1100, height: 760, props: { role: "changes", source: { cwd: this.root, on: this.on }, expanded: true, showFiles: true, listMode: this.listMode, diffMode: this.diffMode, selection: { commit: commit.hash, parents: commit.parents, subject: commit.subject } } });
  }

  expand() {
    if (this.page === "history" && !this.props.expanded) { if (this.selectedCommit) this.openCommit(this.selectedCommit); return; }
    const file = this.selectedFile(); if (!file || !this.root) return;
    openOverlay({ mod: "files-plus", kind: "dialog", frame: "none", width: 1100, height: 760, props: { role: "changes", source: { cwd: this.root, on: this.on }, expanded: true, listMode: this.listMode, diffMode: this.diffMode, selection: { path: file.path, section: file.section, commit: file.commit, parents: file.parents, subject: this.selectedCommit?.subject } } });
  }

  menu(file, cx) {
    cx.stop_propagation(); if (file.section === "history") return;
    const target = targetFor(this.root, file.path, false, this.on, window()?.platform); if (!target) return;
    Object.assign(target, { kind: "changes", xy: file.xy, deleted: file.deleted });
    openOverlay({ mod: "files-plus", kind: "popup", width: 200, height: menuHeight(target, undefined, globalThis.window.viewport_size().height / (settings().zoom || 1) * 0.85), props: { role: "menu", target } });
  }

  consumeChange(cx) {
    const change = shared(CHANGE_KEY); if (!change || change.revision === this.lastChange) return;
    this.lastChange = change.revision;
    if (change.target.root === this.root && (change.target.on ?? null) === (this.on ?? null)) this.refresh(cx);
  }

  // Rendering is read-only. Context/shared invalidation runs on the next host turn.
  scheduleSync(cx) {
    if (this.syncScheduled || (this.contextKey() === this.context && shared(CHANGE_KEY)?.revision === this.lastChange)) return;
    this.syncScheduled = true;
    cx.timer.after(0, cx => {
      this.syncScheduled = false; if (this.disposed) return;
      if (this.contextKey() !== this.context) this.refresh(cx); else this.consumeChange(cx);
      cx.notify();
    });
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || !this.hasStaged || this.busy || this.loading || this.context !== this.contextKey() || this.on || window()?.platform !== "macos") return;
    const root = this.root, context = this.context, message = this.message.trim(); this.busy = true; this.note = null;
    cx.spawn(async cx => {
      try {
        // Explicit action commits the existing index; it never stages working files.
        const result = await exec("git", ["commit", "-m", message], { cwd: root, on: null });
        if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim());
        setShared(CHANGE_KEY, { target: { root, on: null }, action: "commit", revision: (shared(CHANGE_KEY)?.revision ?? 0) + 1 });
        if (this.current(context)) { this.message = ""; this.input.set_value(""); }
      } catch (error) { if (this.current(context)) this.note = `Commit failed: ${error.message ?? error}`; }
      finally { this.busy = false; this.reloadAgain = false; this.refresh(cx); if (!this.disposed) cx.notify(); }
    });
    cx.notify();
  }

  close() { this.disposed = true; this.input?.release(); this.diffScroll?.release(); }

  fileRow(file, t) {
    if (file.directory) return h_flex().id(`git-dir-${file.key}`).h(26).flex_none().pl(8 + file.depth * 12).gap(6).items_center().cursor_pointer().hover(e => e.bg(t.hover))
      .on_click((_e, cx) => { if (this.collapsed.has(file.key)) this.collapsed.delete(file.key); else this.collapsed.add(file.key); cx.notify(); })
      .child(svg(`mods/files-plus/chevron-${file.collapsed ? "right" : "down"}.svg`).size(12).flex_none().text_color(t.dim)).child(fileIcon(file.name, true)).child(div().truncate().text_color(t.muted).child(file.name));
    const selected = this.selectedFile(), name = this.listMode === "tree" ? file.path.split("/").pop() : file.path;
    return h_flex().id(`change-${fileKey(file)}`).h(28).flex_none().pl(8 + (file.depth || 0) * 12).pr(8).gap(6).items_center().rounded(5).cursor_pointer()
      .when(selected && fileKey(selected) === fileKey(file), e => e.bg(t.selected)).hover(e => e.bg(t.hover)).on_click((_e, cx) => this.pick(file, cx)).on_mouse_down("right", (_e, cx) => this.menu(file, cx))
      .child(div().w(14).flex_none().text_size(11).text_color(file.status === "A" ? t.ansi2 : ["D", "U"].includes(file.status) ? t.ansi1 : t.blocked).child(file.status))
      .child(fileIcon(file.path)).child(div().flex_1().min_w(0).truncate().tooltip(file.path).child(name))
      .when(file.binary, e => e.child(div().text_size(10).text_color(t.dim).child("binary")))
      .when(file.add > 0, e => e.child(div().flex_none().text_size(10).text_color(t.ansi2).child(`+${file.add}`)))
      .when(file.del > 0, e => e.child(div().flex_none().text_size(10).text_color(t.ansi1).child(`−${file.del}`)));
  }

  // Every folder of the listed sections: any open folds them all, else all open.
  folders() {
    const files = this.page === "history" ? this.historyFiles : this.files, sections = this.page === "history" ? ["history"] : ["staged", "unstaged"];
    return sections.flatMap(section => treeFolders(files.filter(file => file.section === section)));
  }

  foldAllButton(t) {
    const folders = this.folders(), open = folders.some(key => !this.collapsed.has(key)), label = open ? "Collapse all folders" : "Expand all folders";
    return div().id("git-fold-all").w(24).h(24).p(0).flex_none().flex().items_center().justify_center().rounded(4)
      .text_color(t.muted).tooltip(label).accessibility_label(label)
      .when(!folders.length, el => el.cursor_default().opacity(0.45))
      .when(folders.length > 0, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => {
        if (!folders.length) return;
        for (const key of folders) open ? this.collapsed.add(key) : this.collapsed.delete(key);
        cx.notify();
      })
      .child(svg(`mods/files-plus/${open ? "collapse" : "expand"}-all.svg`).size(14).flex_none());
  }

  fileList(t) {
    const files = this.page === "history" ? this.historyFiles : this.files, sections = this.page === "history" ? ["history"] : ["staged", "unstaged"];
    const rows = [];
    for (const section of sections) {
      const group = files.filter(file => file.section === section);
      const title = section === "staged" ? "Staged" : section === "unstaged" ? "Unstaged" : "Commit files";
      rows.push(div().h(25).flex_none().px(8).py(4).font_semibold().text_size(11).text_color(t.muted).child(`${title} · ${group.length}`));
      const visible = this.listMode === "tree" ? fileTree(group, this.collapsed) : group;
      rows.push(...visible.map(file => this.fileRow(file, t)));
    }
    return v_flex().id("changes-list").flex_1().min_h(0).overflow_y_scrollbar().p(5).border_b(1).border_color(t.border).children(rows)
      .when(!files.length, e => e.child(div().px(8).py(5).text_color(t.dim).child(this.error || (this.page === "history" ? this.commitLoading ? "Loading commit files…" : this.selectedCommit ? "No file changes in this commit" : "Select a commit" : this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder"))));
  }

  historyList(t) {
    const full = !this.props.expanded;
    return v_flex().id("git-history").when(full, e => e.flex_1().min_h(0)).when(!full, e => e.flex_none().h(165).border_b(1).border_color(t.border)).overflow_y_scrollbar().p(5)
      .children(this.commits.map(commit => v_flex().id(`git-commit-${commit.hash}`).flex_none().px(7).py(5).rounded(5).cursor_pointer()
        .when(this.selectedCommit?.hash === commit.hash, e => e.bg(t.selected)).hover(e => e.bg(t.hover))
        .on_click((_e, cx) => { if (full) this.showCommit(commit, cx); else this.selectCommit(commit, cx); }).child(div().truncate().child(commit.subject || "(no subject)"))
        .child(div().truncate().text_size(10).text_color(t.dim).child(`${commit.hash.slice(0, 8)} · ${commit.author} · ${new Date(commit.time * 1000).toLocaleDateString()}`))))
      .when(this.historyMore && !this.historyLoading, e => e.child(button("history-more", "Load 50 more", false, cx => this.loadHistory(cx), t)))
      .when(this.historyLoading || this.historyError || !this.commits.length, e => e.child(div().p(7).text_size(11).text_color(this.historyError ? t.ansi1 : t.dim).child(this.historyError || (this.historyLoading ? "Loading commits…" : "No commits yet"))));
  }

  panes(t) {
    const selected = this.selectedFile(), commitsOnly = this.page === "history" && !this.props.expanded;
    const commit = commitsOnly ? this.selectedCommit : null;
    const navigation = commitsOnly ? v_flex().size_full().min_h(0).min_w(0).child(this.historyList(t)) : v_flex().size_full().min_h(0).min_w(0)
      .when(this.page === "history", e => e.child(this.historyList(t)))
      .child(h_flex().h(29).flex_none().px(6).gap(3).items_center()
        .child(button("git-tree", "Tree", this.listMode === "tree", cx => { this.listMode = "tree"; cx.notify(); }, t))
        .child(button("git-flat", "Flat", this.listMode === "flat", cx => { this.listMode = "flat"; cx.notify(); }, t))
        .child(div().flex_1()).child(div().text_size(10).text_color(t.dim).child(this.page === "history" ? `${this.historyFiles.length} files` : `${this.fileCount || 0} files`))
        .when(this.listMode === "tree", e => e.child(this.foldAllButton(t))))
      .child(this.fileList(t))
      .when(this.limited && this.page === "changes", e => e.child(div().px(10).py(3).text_size(10).text_color(t.dim).child("Showing the first 1,000 changed files")));
    const preview = v_flex().size_full().min_h(0).min_w(0)
      .child(h_flex().h(32).flex_none().px(6).gap(3).items_center().border_b(1).border_color(t.border)
        .child(button("git-inline", "Inline", this.diffMode === "inline", cx => { this.diffMode = "inline"; this.diffScroll.scroll_to_item(0); cx.notify(); }, t))
        .child(button("git-split", "Side by side", this.diffMode === "split", cx => { this.diffMode = "split"; this.diffScroll.scroll_to_item(0); cx.notify(); }, t))
        .child(div().flex_1()).when((Boolean(selected) || Boolean(commit)) && !this.props.expanded, e => e.child(button("git-expand", "↗", false, () => this.expand(), t))))
      .when(Boolean(selected), e => e.child(div().h(23).flex_none().px(10).py(3).truncate().text_size(10).text_color(t.dim).child(`${selected.section === "staged" ? "HEAD → Index" : selected.section === "history" ? `${selected.commit.slice(0, 8)} · ${selected.parents?.length > 1 ? "first parent" : "parent"}` : "Index → Working tree"} · ${selected.path}`)))
      .when(Boolean(commit), e => e.child(div().h(23).flex_none().px(10).py(3).truncate().text_size(10).text_color(t.dim).child(`${commit.hash.slice(0, 8)} · ${commit.parents?.length > 1 ? "first parent" : "parent"} · ${commit.subject || "(no subject)"}`)))
      .when(this.diffMode === "split", e => e.child(splitHeader(this.counts ?? { removed: 0, added: 0 }, t)))
      .child(diffView(this, t, settings().font_family ?? "JetBrains Mono"))
      .child(this.footer(t));
    if (this.props.expanded && !this.showFiles) return div().flex_1().min_h(0).min_w(0).child(preview);
    // The sidebar shares one split between Changes and History so switching keeps the diff's height.
    const id = this.props.expanded ? "git-vertical-expanded-" + this.page : "git-vertical-sidebar";
    const stored = shared("files-plus.git-pane-sizes.v1")?.[id];
    const size = Number.isFinite(stored) ? stored : shared("files-plus.git-pane-sizes.v1")?.["git-vertical-sidebar-changes"];
    const initial = Number.isFinite(size) ? Math.max(100, Math.min(600, size)) : this.props.expanded && this.page === "history" ? 340 : 210;
    return div().id("git-resizable-content").flex_1().min_h(0).min_w(0).child(v_resizable(id).size_full()
      .on_resize((sizes, cx) => {
        if (Number.isFinite(sizes[0])) setShared("files-plus.git-pane-sizes.v1", { ...(shared("files-plus.git-pane-sizes.v1") || {}), [id]: sizes[0] });
        cx.notify();
      })
      .child(resizable_panel().size(initial).size_range(this.props.expanded && this.page === "history" ? 220 : 90).child(navigation))
      .child(resizable_panel().size_range(140).child(preview)));
  }

  // Notes, the commit box or History's note. They sit in the diff's half so the divider
  // stays put when the page changes: the split's total height is the same for both pages.
  footer(t) {
    const enabled = Boolean(this.message.trim() && this.root && this.hasStaged && !this.on && window()?.platform === "macos" && !this.busy && !this.loading);
    return v_flex().flex_none()
      .when(Boolean(this.note || this.error), e => e.child(div().px(10).py(5).text_size(11).text_color(t.ansi1).child(this.note || this.error)))
      .when(this.page === "changes", e => e
        .child(div().px(10).py(5).text_size(10).text_color(t.dim).child(this.on || window()?.platform !== "macos" ? "Index actions and commits require local macOS." : "Commit uses staged changes. Right-click a file to stage or unstage."))
        .child(h_flex().flex_none().p(8).gap(6).border_t(1).border_color(t.border)
          .child(div().id("commit-message").flex_1().min_w(0).h(32).px(8).flex().items_center().rounded(7).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
          .child(div().id("commit").h(32).px(10).flex_none().flex().items_center().rounded(7).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(11).when(enabled, e => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit Staged"))))
      .when(this.page === "history", e => e.child(div().px(10).py(5).text_size(10).text_color(t.dim).child("History is read-only · upstream counts use the last fetched refs.")));
  }

  render(cx) {
    this.scheduleSync(cx);
    const t = theme();
    const loading = Boolean(this.loading || this.historyLoading);
    const branch = this.branch.name || (this.root ? "Branch unavailable" : "No repository"), counts = this.branch.upstream ? `↑${this.branch.ahead} ↓${this.branch.behind}` : "No upstream";
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12).track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); } })
      .child(h_flex().h(38).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border)
        .child(button("git-changes-tab", "Changes", this.page === "changes", cx => this.setPage("changes", cx), t))
        .child(button("git-history-tab", "History", this.page === "history", cx => this.setPage("history", cx), t))
        .child(div().flex_1()).when(this.props.expanded, e => e.child(button("git-preview-files", "Files", Boolean(this.showFiles), cx => { this.showFiles = !this.showFiles; cx.notify(); }, t))).child(div().id("git-refresh").w(24).h(24).p(0).flex_none().flex().items_center().justify_center().rounded(4)
          .text_color(loading ? t.accent : t.muted).disabled(loading).tooltip(loading ? "Refreshing Git data…" : "Refresh Git data").accessibility_label("Refresh Git data")
          .when(loading, el => el.cursor_default()).when(!loading, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
          .on_click((_e, cx) => { if (!this.loading && !this.historyLoading) { this.refresh(cx); if (this.page === "history") this.loadHistory(cx, true); cx.notify(); } })
          .child(svg("mods/files-plus/refresh.svg").id("git-refresh-icon").size(14).flex_none().when(loading, el => el.spin(850)))))
      .child(h_flex().h(26).flex_none().px(10).gap(8).items_center().text_size(10).text_color(t.dim).child(div().flex_1().min_w(0).truncate().tooltip(this.branch.upstream ? `${branch} → ${this.branch.upstream}` : branch).child(branch)).child(div().flex_none().tooltip("Ahead/behind the last fetched upstream refs").child(counts)))
      .child(this.panes(t));
  }
}
