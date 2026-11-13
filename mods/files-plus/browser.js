// Modified from Herdr Files (Apache-2.0): context menus, captured targets and immediate refresh.
// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { TYPE } from "./type-scale.js";
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Popover } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, window, openOverlay, shared, setShared } from "herdr";

import { openFileTab, projectContext } from "./file-tabs.js";
import { fileIcon, iconButton } from "./icons.js";
import { LIBRARY_KEY, LIBRARY_VIEW_KEY, libraryFor, libraryView, updateLibrary, remapLibrary, breadcrumbs, forgetRecent, pathTree, treeRows } from "./library-model.js";

import { CHANGE_KEY, SHOW_HIDDEN_KEY, visibleEntry, targetFor, menuHeight, applyPathChange, dirtyFolders, markColor, EXPAND_DEPTH, EXPAND_LIMIT, openBelow, childFolders } from "./model.js";

function location() { return projectContext(); }
const key = source => JSON.stringify(source || location());
const PER_FOLDER = 500, TOTAL = 5000;
const SIDEBAR_DENSITY_KEY = "project-spaces.density.v1";

async function directory(path, on, showHidden = false) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p,$showHidden) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object { $showHidden -or -not $_.Name.StartsWith('.') } | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "' " + (showHidden ? "$true" : "$false")], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return (Array.isArray(result) ? result : [result]).filter(entry => visibleEntry(entry.name, showHidden));
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; if [ "$2" != 1 ]; then case "$name" in .*) continue;; esac; fi; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path, showHidden ? "1" : "0"], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out.filter(entry => visibleEntry(entry.name, showHidden));
}

export default class Browser {
  init(_props, cx) {
    this.source = _props.source; this.width = 320; this.mode = "tree"; this.browseFolder = ""; this.libraryFolded = new Set(); this.clearArmed = false;
    this.handle = cx.focus_handle();
    this.filterQuery = ""; this.filterOpen = false; this.filterFocused = false; this.modeOpen = false; this.modeIndex = 0;
    this.filterInput = InputState.new({ placeholder: "Filter files…" });
    this.filterInput.on("change", (_event, cx) => { this.filterQuery = String(this.filterInput.value()).slice(0, 300); this.filterOpen = this.filterFocused || Boolean(this.filterQuery.trim()); cx.notify(); });
    this.filterInput.on("focus", () => { this.filterFocused = true; });
    this.filterInput.on("blur", (_event, cx) => { this.filterFocused = false; this.filterOpen = Boolean(this.filterQuery.trim()); cx.notify(); });
    this.lastChange = shared(CHANGE_KEY)?.revision;
    this.folderRequests = new Map();
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    this.refreshTimer = cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watchTask?.cancel?.(); this.watched = root;
    const context = this.context;
    this.watchTask = cx.spawn(async cx => {
      try { while (this.context === context && !this.paused) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return !this.disposed && !this.paused && this.context === context && key(this.source) === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root, showHidden } = context;
    if (!showHidden && path.split("/").some(part => !visibleEntry(part))) return;
    const request = {};
    this.folderRequests.set(path, request);
    const entries = await directory(path ? `${root}/${path}` : root, on, showHidden);
    if (!this.current(context) || this.folderRequests.get(path) !== request || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    if (this.disposed || this.paused) return;
    const { cwd, on } = this.source || location(), next = key(this.source), showHidden = shared(SHOW_HIDDEN_KEY) === true;
    if (next !== this.context?.key || showHidden !== this.context?.showHidden) {
      this.watchTask?.cancel?.();
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, showHidden }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false; this.browseFolder = ""; this.modeOpen = false;
      this.filterQuery = ""; this.filterOpen = false; this.filterFocused = false; this.filterInput?.set_value("");
      if (saved?.file) this.show(saved.file, cx, false);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          try { await this.loadFolder(path, context); }
          catch (error) {
            if (!path) throw error;
            if (this.current(context)) { this.folders.delete(path); this.entries.delete(path); }
          }
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) {
          this.loading = false;
          if (this.reloadAgain) { this.reloadAgain = false; this.refresh(cx); }
        }
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx, remember = true) {
    this.file = path;
    if (!path || !cx) return;
    if (remember) this.updateLibrary("open", path);
    cx.notify();
  }

  search(cx) {
    if (this.onWorkspaceSearch) return this.onWorkspaceSearch(cx);
    const viewport = globalThis.window.viewport_size(), zoom = settings().zoom || 1;
    openOverlay({ mod: "files-plus", kind: "dialog", frame: "none", width: Math.min(1050, viewport.width / zoom * 0.92), height: Math.min(800, viewport.height / zoom * 0.88), props: { role: "search", root: this.root, on: this.on } });
  }

  menu(relative, dir, cx, preferences = false) {
    cx.stop_propagation();
    const target = targetFor(this.root, relative, dir, this.on, window()?.platform);
    if (target) openOverlay({ mod: "files-plus", kind: "popup", width: 200, height: menuHeight(target, { preferences }, globalThis.window.viewport_size().height / (settings().zoom || 1) * 0.85), props: { role: "menu", target, preferences } });
  }

  consumeChange(cx) {
    const change = shared(CHANGE_KEY);
    if (!change || this.lastChange === change.revision) return;
    this.lastChange = change.revision;
    if (change.target.root !== this.root || (change.target.on ?? null) !== (this.on ?? null)) return;
    this.folders = new Set([...this.folders].map(path => applyPathChange(path, change)).filter(Boolean));
    this.browseFolder = applyPathChange(this.browseFolder, change) || "";
    const file = applyPathChange(this.file, change);
    // A new context invalidates reads still running against the old tree.
    this.watchTask?.cancel?.(); this.context = { ...this.context };
    this.entries = new Map(); this.pending = new Set(); this.folderRequests = new Map();
    this.loading = false; this.watched = null; this.reloadAgain = false;
    this.show(file, cx, false);
    this.refresh(cx);
  }


  updateLibrary(action, path) {
    const state = shared(LIBRARY_KEY), next = updateLibrary(state, this.root, this.on, action, path);
    if (next !== state) setShared(LIBRARY_KEY, next);
  }

  navigate(path, cx) {
    this.browseFolder = path; this.mode = "tree";
    this.show(null); if (path && !this.folders.has(path)) this.toggle(path, cx); else this.refresh(cx);
    cx.notify();
  }

  listEntries(prefix = this.browseFolder, depth = 0, out = []) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (!visibleEntry(entry.name, shared(SHOW_HIDDEN_KEY) === true) || out.length >= TOTAL) continue;
      const path = prefix ? prefix + "/" + entry.name : entry.name;
      out.push({ ...entry, path, depth });
      if (entry.dir && this.folders.has(path)) this.listEntries(path, depth + 1, out);
    }
    return out;
  }

  visibleEntries() {
    const query = String(this.filterQuery || "").slice(0, 300).trim().toLocaleLowerCase();
    let entries;
    if (this.mode === "tree") entries = this.listEntries();
    else {
      const paths = libraryFor(shared(LIBRARY_KEY), this.root, this.on)[this.mode];
      if (libraryView(shared(LIBRARY_VIEW_KEY)) === "tree") entries = treeRows(pathTree(paths), query ? new Set() : this.libraryFolded);
      // Flat keeps the list's own order; the folder follows the name, dimmed.
      else entries = paths.map(path => { const at = path.lastIndexOf("/"); return { path, name: path.slice(at + 1), hint: at > 0 ? path.slice(0, at) : "", dir: false, depth: 0 }; });
    }
    if (!query) return entries;
    const keep = new Set();
    for (const entry of entries) if (entry.path.toLocaleLowerCase().includes(query)) {
      keep.add(entry.path);
      let parent = entry.path;
      while (parent.includes("/")) { parent = parent.slice(0, parent.lastIndexOf("/")); keep.add(parent); }
    }
    return entries.filter(entry => keep.has(entry.path));
  }

  // The header's fold button: in the tree, collapse every open folder below the current one,
  // or open a few levels; in grouped Recent / Pinned, fold or unfold every group.
  foldState(local = false) {
    if (!local && this.onWorkspaceFoldState) return this.onWorkspaceFoldState();
    if (this.mode === "tree") return { usable: Boolean(this.root), open: openBelow(this.folders, this.browseFolder).length > 0 };
    if (libraryView(shared(LIBRARY_VIEW_KEY)) !== "tree") return { usable: false, open: false };
    const paths = libraryFor(shared(LIBRARY_KEY), this.root, this.on)[this.mode];
    const groups = treeRows(pathTree(paths)).filter(row => row.group).map(row => row.path);
    return { usable: groups.length > 0, open: groups.some(path => !this.libraryFolded.has(path)), groups };
  }

  foldAll(cx, local = false, budget = EXPAND_LIMIT) {
    if (!local && this.onWorkspaceFold) return this.onWorkspaceFold(cx);
    const state = this.foldState(true);
    if (!state.usable || this.expanding) return;
    if (this.mode !== "tree") {
      if (state.open) for (const path of state.groups) this.libraryFolded.add(path);
      else this.libraryFolded.clear();
    } else if (state.open) {
      for (const path of openBelow(this.folders, this.browseFolder)) { this.folders.delete(path); this.entries.delete(path); }
    } else this.expandAll(cx, budget);
    cx.notify();
  }

  expandAll(cx, budget = EXPAND_LIMIT) {
    const context = this.context;
    if (!context) return;
    this.expanding = true;
    cx.spawn(async cx => {
      try {
        let level = [this.browseFolder], opened = 0;
        for (let depth = 0; depth < EXPAND_DEPTH && level.length && opened < budget; depth++) {
          const next = childFolders(this.entries, level, context.showHidden).filter(path => !this.folders.has(path)).slice(0, budget - opened);
          for (const path of next) this.folders.add(path);
          opened += next.length;
          for (let i = 0; i < next.length; i += 8) {
            await Promise.all(next.slice(i, i + 8).map(path => this.entries.has(path) ? null : this.loadFolder(path, context).catch(() => {})));
            if (!this.current(context)) return;
          }
          cx.notify();
          if (this.limited) break;
          level = next;
        }
      } finally { this.expanding = false; if (!this.disposed) cx.notify(); }
    });
  }

  foldLibrary(path, cx) {
    if (this.libraryFolded.has(path)) this.libraryFolded.delete(path); else this.libraryFolded.add(path);
    cx.notify();
  }

  /** Forget recent files: a folder's at once, or all of them after a second click. Files are never touched. */
  forget(folder, cx) {
    if (!folder && !this.clearArmed) {
      const armed = this.clearArmed = Date.now();
      cx.timer.after(3000, cx => { if (this.clearArmed === armed) { this.clearArmed = false; cx.notify(); } });
      cx.notify();
      return;
    }
    this.clearArmed = false;
    const state = shared(LIBRARY_KEY), next = forgetRecent(state, this.root, this.on, folder);
    if (next !== state) setShared(LIBRARY_KEY, next);
    cx.notify();
  }

  libraryHeader(t, count, prefix = "") {
    const view = libraryView(shared(LIBRARY_VIEW_KEY)), set = next => (_e, cx) => { setShared(LIBRARY_VIEW_KEY, next); cx.notify(); };
    return h_flex().id(prefix + "library-header").h(30).flex_none().pl(14).pr(8).pt(4).gap(2).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(TYPE.xs).font_medium().text_color(t.dim).child(this.mode === "recent" ? "RECENT · THIS PROJECT" : "PINNED · THIS PROJECT"))
      .child(this.segment(prefix + "library-flat", "list", "Flat list", view === "flat", set("flat"), t))
      .child(this.segment(prefix + "library-tree", "nest", "Group by folder", view === "tree", set("tree"), t))
      .when(this.mode === "recent" && count > 0, el => el.child(div().id(prefix + "recent-clear").ml(4).px(7).h(22).flex_none().flex().items_center().rounded(5).cursor_pointer().text_size(TYPE.sm)
        .text_color(this.clearArmed ? t.blocked : t.dim).when(Boolean(this.clearArmed), el => el.bg(t.hover))
        .hover(s => s.bg(t.hover).text_color(this.clearArmed ? t.blocked : t.foreground))
        .tooltip(this.clearArmed ? "Click again to clear the recent list. Files are not deleted." : "Clear the recent list")
        .on_click((_e, cx) => { cx.stop_propagation(); this.forget("", cx); }).child(this.clearArmed ? "Clear all?" : "Clear")));
  }

  pick(entry, _e, cx) {
    this.handle.focus();
    if (entry.group) this.foldLibrary(entry.path, cx);
    else if (entry.dir) this.toggle(entry.path, cx);
    else {
      try { openFileTab({ root: this.root, path: entry.path, on: this.on }, cx); this.show(entry.path, cx); }
      catch (error) { this.error = String(error.message ?? error); cx.notify(); }
    }
  }

  pause(paused, cx) {
    if (Boolean(this.paused) === paused) return;
    this.watchTask?.cancel?.();
    this.paused = paused; this.context = this.context ? { ...this.context } : this.context;
    this.folderRequests = new Map(); this.pending = new Set(); this.loading = false; this.watched = null; this.reloadAgain = false;
    if (!paused) this.refresh(cx);
  }

  close() { this.disposed = true; this.context = null; this.refreshTimer?.cancel?.(); this.watchTask?.cancel?.(); this.filterInput?.release(); }

  dirtyFolders() {
    if (this.dirtyMarks !== this.marks) { this.dirtyMarks = this.marks; this.dirty = dirtyFolders(this.marks, this.root); }
    return this.dirty;
  }

  row(entry, t, idPrefix = "file") {
    const { path, name, dir, depth, group, hint } = entry, open = group ? !this.libraryFolded.has(path) : this.folders.has(path), mark = this.marks[this.root + "/" + path];
    const localId = kind => `${idPrefix === "file" ? "" : idPrefix + "-"}${kind}-${path}`;
    const inner = dir && !mark ? this.dirtyFolders().get(path) : null, active = this.file === path, tone = markColor(mark ?? inner, t);
    // One 14px lane per level, each with a hairline, so nested rows read as a tree.
    const guides = Array.from({ length: depth }, (_, i) => div().w(14).h_full().flex_none().flex().justify_center()
      .child(div().w(1).h_full().bg(t.border)).id(`${localId("guide")}-${i}`));
    return h_flex().id(idPrefix + "-" + path).h(this.rowHeight || 28).flex_none().min_w(0).pl(4).pr(8).items_center().rounded(6).cursor_pointer()
      .when(active, el => el.bg(t.selected)).when(!active, el => el.hover(s => s.bg(t.hover)))
      .on_click((e, cx) => this.pick(entry, e, cx)).on_mouse_down("right", (_e, cx) => this.menu(path, dir, cx))
      .children(guides)
      .child(dir ? div().id(localId("expand")).w(16).h(24).flex_none().flex().items_center().justify_center().on_click((_e, cx) => { cx.stop_propagation(); if (group) this.foldLibrary(path, cx); else this.toggle(path, cx); }).child(svg("mods/files-plus/chevron-" + (open ? "down" : "right") + ".svg").size(10).text_color(open ? t.muted : t.dim)) : div().w(16).flex_none())
      .child(div().w(16).mr(7).flex_none().flex().items_center().child(fileIcon(path, dir, open)))
      .child(div().when(!hint, el => el.flex_1()).min_w(0).truncate().text_size(TYPE.md).text_color(tone ?? t.foreground).when(active, el => el.font_medium()).tooltip(path).child(name))
      .when(Boolean(hint), el => el.child(div().flex_1().min_w(0).ml(8).truncate().text_size(TYPE.sm).text_color(t.dim).child(hint)))
      .when(Boolean(group), el => el.child(div().flex_none().mr(4).text_size(TYPE.sm).text_color(t.dim).child(String(entry.count))))
      .when(Boolean(inner), el => el.child(div().size(5).mr(4).rounded(3).flex_none().bg(tone).tooltip("Contains changes")))
      .when(Boolean(mark), el => el.child(div().w(14).flex_none().text_right().text_size(TYPE.xs).font_medium().text_color(tone).child(mark)))
      .when(this.mode === "recent" && !group, el => el.child(iconButton(localId("forget"), "close", "Remove from recent files", (_e, cx) => { this.updateLibrary("forget", path); cx.notify(); }, t)))
      .when(this.mode === "recent" && Boolean(group), el => el.child(iconButton(localId("forget"), "close", `Remove these ${entry.count} from recent files`, (_e, cx) => this.forget(path, cx), t)))
      .when(this.mode === "pinned" && !group, el => el.child(iconButton(localId("unpin"), "pin", "Unpin file", (_e, cx) => { this.updateLibrary("pin", path); cx.notify(); }, t, true)));
  }

  /** One button of the view switch: the active one is raised, the rest stay quiet. */
  segment(id, icon, label, active, click, t) {
    return div().id(id).w(26).h(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
      .tooltip(label).accessibility_label(label).text_color(active ? t.foreground : t.dim)
      // Selected and hover colors read right in every theme, whether it writes them opaque or translucent.
      .when(active, el => el.bg(t.selected)).when(!active, el => el.hover(s => s.bg(t.hover).text_color(t.muted)))
      .on_click((e, cx) => { cx.stop_propagation(); click(e, cx); })
      .child(svg(`mods/files-plus/icons/${icon}.svg`).size(13).flex_none());
  }

  openFilter(cx) {
    this.filterOpen = true; cx.notify();
    cx.timer.after(0, () => { if (!this.disposed && this.filterOpen) this.filterInput?.focus?.(); });
  }

  filterKey(event, cx) {
    const key = String(event.key || "").toLowerCase(), modifiers = event.modifiers || {};
    if (key === "f" && (modifiers.platform || modifiers.control) && !modifiers.alt && !modifiers.shift) {
      cx.stop_propagation(); this.openFilter(cx);
    } else if (key === "escape" && (this.filterOpen || this.filterQuery)) {
      cx.stop_propagation(); this.filterQuery = ""; this.filterInput.set_value(""); this.filterOpen = false; this.filterFocused = false; this.handle.focus(); cx.notify();
    }
  }

  modePicker(t) {
    const options = [["tree", "Explorer", "tree", "File tree"], ["recent", "Recent", "history", "Recent files"], ["pinned", "Pinned", "pin", "Pinned files"]];
    const current = options.find(option => option[0] === this.mode) || options[0];
    const choose = (mode, cx) => { this.mode = mode; this.modeOpen = false; this.show(null); cx.notify(); };
    const title = this.workspaceTitle || String(this.root || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || this.root || "Files";
    const trigger = h_flex().id("files-mode-picker").h(24).w_full().px(5).gap(4).min_w(0).items_center().rounded(4).cursor_pointer().text_size(TYPE.md).text_color(t.foreground)
      .tooltip([this.on ? "@" + this.on : "", this.root, "File view: " + current[1], "Explorer, recent and pinned files"].filter(Boolean).join("\n")).accessibility_label(title + ": " + current[1]).hover(el => el.bg(t.hover))
      .child(div().min_w(0).truncate().child(title)).child(svg("mods/files-plus/chevron-down.svg").size(10).flex_none().text_color(t.dim));
    const content = v_flex().id("files-view-menu").w(180).p(4).gap(2).rounded(6).border_1().border_color(t.border).bg(t.surface).text_size(TYPE.md).text_color(t.foreground)
      .on_key_down((event, cx) => {
        const key = String(event.key || "").toLowerCase();
        if (["up", "arrowup", "down", "arrowdown"].includes(key)) {
          cx.stop_propagation(); this.modeIndex = (this.modeIndex + (key === "up" || key === "arrowup" ? -1 : 1) + options.length) % options.length; cx.notify();
        } else if (key === "enter") { cx.stop_propagation(); choose(options[this.modeIndex || 0][0], cx); }
        else if (key === "escape") { cx.stop_propagation(); this.modeOpen = false; cx.notify(); }
      })
      .children(options.map(([mode, title, glyph, description], index) => h_flex().id(mode === "tree" ? "files-tree-mode" : "files-" + mode).h(29).px(7).gap(7).items_center().rounded(4).cursor_pointer().text_color(t.foreground)
        .when(Boolean(this.modeOpen && this.modeIndex === index), el => el.bg(t.selected)).hover(el => el.bg(t.hover)).tooltip(description).accessibility_label(description)
        .on_click((_event, cx) => { cx.stop_propagation(); choose(mode, cx); })
        .child(div().w(12).flex_none().text_color(t.accent).child(this.mode === mode ? "✓" : ""))
        .child(svg("mods/files-plus/icons/" + glyph + ".svg").size(14).flex_none()).child(title)));
    return div().flex_1().min_w(0).child(Popover.new("files-mode-popover").open(Boolean(this.modeOpen)).anchor("top_left")
      .on_open_change((open, cx) => { this.modeOpen = open; if (open) this.modeIndex = Math.max(0, options.findIndex(option => option[0] === this.mode)); cx.notify(); }).trigger(trigger).content(content));
  }

  rows(prefix, depth, out, t) { return [...out, ...this.listEntries(prefix, depth).map(entry => this.row(entry, t))]; }

  scheduleSync(cx) {
    const changed = (!this.paused && (key(this.source) !== this.context?.key || (shared(SHOW_HIDDEN_KEY) === true) !== this.context?.showHidden)) || shared(CHANGE_KEY)?.revision !== this.lastChange;
    if (!changed || this.syncScheduled) return;
    this.syncScheduled = true;
    cx.timer.after(0, cx => { this.syncScheduled = false; if (this.disposed) return; this.refresh(cx); this.consumeChange(cx); cx.notify(); });
  }

  render(cx, navigation = null) {
    this.scheduleSync(cx);
    const t = theme(), library = libraryFor(shared(LIBRARY_KEY), this.root, this.on), entries = this.visibleEntries();
    this.rowHeight = shared(SIDEBAR_DENSITY_KEY) === "compact" ? 26 : 28;
    const crumbPath = this.file || this.browseFolder, crumbs = breadcrumbs(this.root, crumbPath);
    if (!this.file && crumbs.length) crumbs[crumbs.length - 1].dir = true;
    const visibleCrumbs = this.width < 420 && crumbs.length > 3 ? [crumbs[0], { label: "…", path: crumbs[crumbs.length - 3].path, dir: true }, ...crumbs.slice(-2)] : crumbs;
    const crumbMax = Math.min(180, Math.max(24, (this.width - 24 - (this.file ? 28 : 0)) / visibleCrumbs.length - 4));
    const tree = navigation ? navigation(t, cx) : v_flex().id("files-navigation").flex_1().min_w(0).min_h(0)
      .when(this.mode !== "tree", el => el.child(this.libraryHeader(t, library[this.mode].length)))
      .child(v_flex().id("files-tree-" + this.mode + "-" + this.browseFolder).flex_1().min_h(0).overflow_y_scrollbar().px(6).py(4).on_mouse_down("right", (_e, cx) => this.menu(this.browseFolder, true, cx)).children(entries.map(entry => this.row(entry, t)))
        .when(!entries.length || Boolean(this.error && this.mode === "tree"), el => el.child(div().p(8).text_size(TYPE.md).text_color(t.dim).child(String(this.filterQuery || "").trim() && !entries.length ? "No matching files in this tree." : this.mode === "tree" ? this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder") : this.mode === "recent" ? "Files you open will appear here." : "Use the pin beside a preview path to keep a file here.")))
        .when(this.limited && this.mode === "tree", el => el.child(div().p(8).text_size(TYPE.sm).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))));
    return v_flex().id("files").size_full().min_h(0).min_w(0).overflow_hidden().bg(t.chrome).text_color(t.foreground).text_size(TYPE.md).track_focus(this.handle)
      .on_key_down((event, cx) => this.filterKey(event, cx))
      .on_size_change((size, cx) => { if (Math.abs(this.width - size.width) > 1) { this.width = size.width; cx.notify(); } })
      // The root shares the toolbar; only a deeper path or an open filter adds another row.
      .child(v_flex().id("files-header").flex_none().px(8).pt(5).pb(7).gap(4)
        .child(h_flex().h(26).gap(3).items_center()
          .child(this.modePicker(t))
          .child((fold => iconButton("files-fold-all", fold.open ? "collapse-all" : "expand-all", this.expanding ? "Expanding folders…" : fold.open ? "Collapse all folders" : this.mode === "tree" ? "Expand folders (4 levels; skips node_modules, .git and build folders)" : "Expand all groups", (_e, cx) => this.foldAll(cx), t, false, !fold.usable || this.expanding))(this.foldState()))
          .when(Boolean(this.onWorkspaceManage), el => el.child(iconButton("files-workspace-folders", "folder-plus", "Workspace folders", (_e, cx) => this.onWorkspaceManage(cx), t, false, !this.root)))
          .child(iconButton("files-filter", "filter", "Filter files (Cmd+F)", (_e, cx) => this.openFilter(cx), t, Boolean(this.filterOpen || this.filterQuery.trim()), !this.root))
          .child(iconButton("files-search", "search", "Search project", (_e, cx) => this.search(cx), t, false, !this.root))
          .child(iconButton("files-plus-root-menu", "more", "File actions", (_e, cx) => this.menu(this.file ?? this.browseFolder, !this.file, cx, true), t)))
        .when(Boolean(crumbPath), el => el.child(h_flex().id("files-breadcrumbs").h(20).flex_none().gap(4).min_w(0).overflow_hidden().items_center()
          // Each crumb is as wide as its name, up to an even share of the row; longer names truncate.
          .when(Boolean(this.on), el => el.child(div().flex_none().text_size(TYPE.xs).text_color(t.dim).tooltip("Machine: " + this.on).child("@" + this.on)))
          .children(visibleCrumbs.map((crumb, index) => h_flex().max_w(crumbMax).flex_none().min_w(0).gap(4).items_center()
            .when(index > 0, el => el.child(div().flex_none().text_size(TYPE.sm).text_color(t.dim).child("/")))
            .child(div().id("crumb-" + crumb.path).min_w(0).truncate().text_size(TYPE.sm).text_color(crumb.dir && index < visibleCrumbs.length - 1 ? t.dim : t.muted).tooltip((this.on ? this.on + ":" : "") + (crumb.path ? this.root + "/" + crumb.path : this.root || "Files"))
              .when(crumb.dir, el => el.cursor_pointer().hover(s => s.text_color(t.accent))).on_click((_e, cx) => { if (crumb.dir) this.navigate(crumb.path, cx); }).child(crumb.label))))
          .child(div().flex_1())
          .when(Boolean(this.file), el => el.child(iconButton("files-pin-current", "pin", library.pinned.includes(this.file) ? "Unpin file" : "Pin file", (_e, cx) => { this.updateLibrary("pin", this.file); cx.notify(); }, t, library.pinned.includes(this.file))))))
        .when(Boolean(this.filterOpen || this.filterQuery.trim()), el => el.child(div().id("files-local-filter").h(28).px(7).min_w(0).flex_none().rounded(5).border_1().border_color(t.input || t.border).bg(t.surface)
          .tooltip("Filter the current tree. Search project searches all folders.").child(Input.new(this.filterInput).w_full().h_full().text_size(TYPE.md)))))
      .child(div().id("files-header-divider").h(1).flex_none().mx(8).bg(t.border))
      .child(h_flex().id("files-content").flex_1().min_h(0).min_w(0).items_stretch().overflow_hidden()
        .child(tree));
  }
}
