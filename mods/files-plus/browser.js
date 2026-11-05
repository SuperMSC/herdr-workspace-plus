// Modified from Herdr Files (Apache-2.0): context menus, captured targets and immediate refresh.
// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, window, openOverlay, shared, setShared } from "herdr";

import { openFileTab, projectContext } from "./file-tabs.js";
import { fileIcon, iconButton } from "./icons.js";
import { LIBRARY_KEY, libraryFor, updateLibrary, remapLibrary, breadcrumbs } from "./library-model.js";

import { CHANGE_KEY, SHOW_HIDDEN_KEY, visibleEntry, targetFor, menuHeight, applyPathChange } from "./model.js";

function location() { return projectContext(); }
const key = source => JSON.stringify(source || location());
const PER_FOLDER = 500, TOTAL = 5000;

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
    this.source = _props.source; this.width = 320; this.mode = "tree"; this.browseFolder = "";
    this.handle = cx.focus_handle();
    this.lastChange = shared(CHANGE_KEY)?.revision;
    this.folderRequests = new Map();
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return !this.disposed && this.context === context && key(this.source) === context.key;
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
    if (this.disposed) return;
    const { cwd, on } = this.source || location(), next = key(this.source), showHidden = shared(SHOW_HIDDEN_KEY) === true;
    if (next !== this.context?.key || showHidden !== this.context?.showHidden) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, showHidden }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false; this.browseFolder = "";
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
    const viewport = globalThis.window.viewport_size(), zoom = settings().zoom || 1;
    openOverlay({ mod: "files-plus", kind: "dialog", frame: "none", width: Math.min(1050, viewport.width / zoom * 0.92), height: Math.min(800, viewport.height / zoom * 0.88), props: { role: "search", root: this.root, on: this.on } });
  }

  menu(relative, dir, cx, preferences = false) {
    cx.stop_propagation();
    const target = targetFor(this.root, relative, dir, this.on, window()?.platform);
    if (target) openOverlay({ mod: "files-plus", kind: "popup", width: 252, height: menuHeight(target, { preferences }, globalThis.window.viewport_size().height / (settings().zoom || 1) * 0.85), props: { role: "menu", target, preferences } });
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
    this.context = { ...this.context };
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
    if (this.mode === "tree") return this.listEntries();
    return libraryFor(shared(LIBRARY_KEY), this.root, this.on)[this.mode].map(path => ({ path, name: path, dir: false, depth: 0 }));
  }

  pick(entry, _e, cx) {
    this.handle.focus();
    if (entry.dir) this.toggle(entry.path, cx);
    else {
      try { openFileTab({ root: this.root, path: entry.path, on: this.on }, cx); this.show(entry.path, cx); }
      catch (error) { this.error = String(error.message ?? error); cx.notify(); }
    }
  }

  close() { this.disposed = true; this.context = null; }

  row(entry, t, idPrefix = "file") {
    const { path, name, dir, depth } = entry, open = this.folders.has(path), mark = this.marks[this.root + "/" + path];
    return h_flex().id(idPrefix + "-" + path).h(28).flex_none().min_w(0).pl(8 + depth * 18).pr(8).gap(6).items_center().rounded(5).cursor_pointer()
      .when(this.file === path, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
      .on_click((e, cx) => this.pick(entry, e, cx)).on_mouse_down("right", (_e, cx) => this.menu(path, dir, cx))
      .child(dir ? div().id("expand-" + path).w(14).h(24).flex_none().flex().items_center().on_click((_e, cx) => { cx.stop_propagation(); this.toggle(path, cx); }).child(svg("mods/files-plus/chevron-" + (open ? "down" : "right") + ".svg").size(12).text_color(t.dim)) : div().w(14).flex_none())
      .child(fileIcon(path, dir)).child(div().flex_1().min_w(0).truncate().tooltip(path).child(name))
      .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)))
      .when(this.mode === "recent", el => el.child(iconButton("forget-" + path, "close", "Remove from recent files", (_e, cx) => { this.updateLibrary("forget", path); cx.notify(); }, t)))
      .when(this.mode === "pinned", el => el.child(iconButton("unpin-" + path, "pin", "Unpin file", (_e, cx) => { this.updateLibrary("pin", path); cx.notify(); }, t, true)));
  }

  rows(prefix, depth, out, t) { return [...out, ...this.listEntries(prefix, depth).map(entry => this.row(entry, t))]; }

  scheduleSync(cx) {
    const changed = key(this.source) !== this.context?.key || (shared(SHOW_HIDDEN_KEY) === true) !== this.context?.showHidden || shared(CHANGE_KEY)?.revision !== this.lastChange;
    if (!changed || this.syncScheduled) return;
    this.syncScheduled = true;
    cx.timer.after(0, cx => { this.syncScheduled = false; if (this.disposed) return; this.refresh(cx); this.consumeChange(cx); cx.notify(); });
  }

  render(cx) {
    this.scheduleSync(cx);
    const t = theme(), library = libraryFor(shared(LIBRARY_KEY), this.root, this.on);
    const crumbPath = this.file || this.browseFolder, crumbs = breadcrumbs(this.root, crumbPath);
    if (!this.file && crumbs.length) crumbs[crumbs.length - 1].dir = true;
    const visibleCrumbs = this.width < 420 && crumbs.length > 3 ? [crumbs[0], { label: "…", path: crumbs[crumbs.length - 3].path, dir: true }, ...crumbs.slice(-2)] : crumbs;
    const crumbMax = Math.min(180, Math.max(24, (this.width - 24 - (this.file ? 28 : 0)) / visibleCrumbs.length - 4));
    const tree = v_flex().id("files-navigation").flex_1().min_w(0).min_h(0)
      .when(this.mode !== "tree", el => el.child(div().px(10).py(5).flex_none().text_size(11).text_color(t.dim).child(this.mode === "recent" ? "Recently opened · this project" : "Pinned files · this project")))
      .child(v_flex().id("files-tree-" + this.mode + "-" + this.browseFolder).flex_1().min_h(0).overflow_y_scrollbar().p(6).on_mouse_down("right", (_e, cx) => this.menu(this.browseFolder, true, cx)).children(this.visibleEntries().map(entry => this.row(entry, t)))
        .when(!this.visibleEntries().length || Boolean(this.error && this.mode === "tree"), el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.mode === "tree" ? this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder") : this.mode === "recent" ? "Files you open will appear here." : "Use the pin beside a preview path to keep a file here.")))
        .when(this.limited && this.mode === "tree", el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))));
    return v_flex().id("files").size_full().min_h(0).min_w(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_size_change((size, cx) => { if (Math.abs(this.width - size.width) > 1) { this.width = size.width; cx.notify(); } })
      .child(h_flex().h(42).flex_none().px(10).gap(3).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().flex_1().min_w(0).truncate().child("Files"))
        .child(iconButton("files-tree-mode", "tree", "File tree", (_e, cx) => { this.mode = "tree"; this.show(null); cx.notify(); }, t, this.mode === "tree"))
        .child(iconButton("files-recent", "history", "Recent files", (_e, cx) => { this.mode = "recent"; this.show(null); cx.notify(); }, t, this.mode === "recent"))
        .child(iconButton("files-pinned", "pin", "Pinned files", (_e, cx) => { this.mode = "pinned"; this.show(null); cx.notify(); }, t, this.mode === "pinned"))
        .child(iconButton("files-search", "search", "Search project", (_e, cx) => this.search(cx), t, false, !this.root))
        .child(iconButton("files-plus-root-menu", "more", "File actions", (_e, cx) => this.menu(this.file ?? this.browseFolder, !this.file, cx, true), t)))
      .child(h_flex().id("files-breadcrumbs").h(30).flex_none().px(8).gap(4).min_w(0).overflow_hidden().border_b(1).border_color(t.border)
        .children(visibleCrumbs.map((crumb, index) => h_flex().w(Math.min(crumbMax, [...crumb.label].length * 7 + 12 + (index ? 12 : 0))).flex_none().min_w(0).gap(4).items_center()
          .when(index > 0, el => el.child(div().flex_none().text_color(t.dim).child("›")))
          .child(div().id("crumb-" + crumb.path).min_w(0).flex_1().truncate().text_size(11).text_color(crumb.dir ? t.muted : t.foreground).tooltip(crumb.path || this.root || "Files")
            .when(crumb.dir, el => el.cursor_pointer().hover(s => s.text_color(t.accent))).on_click((_e, cx) => { if (crumb.dir) this.navigate(crumb.path, cx); }).child(crumb.label))))
        .child(div().flex_1())
        .when(Boolean(this.file), el => el.child(iconButton("files-pin-current", "pin", library.pinned.includes(this.file) ? "Unpin file" : "Pin file", (_e, cx) => { this.updateLibrary("pin", this.file); cx.notify(); }, t, library.pinned.includes(this.file)))))
      .child(h_flex().id("files-content").flex_1().min_h(0).min_w(0).items_stretch().overflow_hidden()
        .child(tree));
  }
}
