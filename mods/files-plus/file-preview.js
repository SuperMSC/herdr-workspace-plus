// A captured, read-only file in the center tab area; terminals keep their own tabs.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, shared, setShared, spaces, panes, run, openOverlay, settings, window } from "herdr";
import Preview from "./preview.js";
import { fileIcon, iconButton } from "./icons.js";
import { FILE_TABS_KEY } from "./file-tabs.js";
import { headerShown } from "./pane-header.js";
import { DIRTY_KEY } from "./editor-model.js";
import { LIBRARY_KEY, libraryFor, updateLibrary, validRelative } from "./library-model.js";
import { CHANGE_KEY, applyPathChange, targetFor, menuHeight } from "./model.js";

export default class FilePreview {
  init(p, cx) {
    this.p = p; this.root = p.root; this.on = p.on ?? null;
    this.preview = new Preview({ editable: true, id: p.previewId ?? null }); this.lastChange = shared(CHANGE_KEY)?.revision;
    this.path = this.record()?.path || p.path;
    if (typeof this.root !== "string" || !this.root || !validRelative(this.path)) { this.error = "No valid file selected."; return; }
    this.preview.open(this.root, this.path, this.on, cx);
    cx.timer.every(10000, cx => {
      const row = this.record(), active = spaces().find(space => space.active);
      if (!this.disposed && row && active?.tabs?.some(tab => tab.id === row.tab && tab.active)) this.preview.refresh(cx);
    });
  }
  record() {
    if (!this.p.previewId) return null;
    const row = Object.values(shared(FILE_TABS_KEY)?.tabs || {}).find(row => row.previewId === this.p.previewId && row.root === this.root && (row.on ?? null) === this.on);
    return row && panes().some(pane => pane.pane === row.pane && pane.tab === row.tab && pane.mod === "files-plus" && !pane.terminal) ? row : null;
  }
  sync(cx) {
    const change = shared(CHANGE_KEY);
    if (!change || change.revision === this.lastChange) return;
    this.lastChange = change.revision;
    if (change.target?.root !== this.root || (change.target?.on ?? null) !== this.on) return;
    const next = applyPathChange(this.path, change), row = this.record();
    if (next && next !== this.path) {
      const oldName = this.path.split("/").pop(); this.path = next;
      if (row) {
        const state = shared(FILE_TABS_KEY);
        setShared(FILE_TABS_KEY, { ...state, tabs: { ...state.tabs, [row.tab]: { ...row, path: next } } });
        const tab = spaces().flatMap(space => space.tabs).find(tab => tab.id === row.tab);
        if (tab?.name === oldName) run("tab.rename", { id: row.tab, name: next.split("/").pop() });
      }
      this.preview.open(this.root, next, this.on, cx);
    } else this.preview.refresh(cx);
    cx.notify();
  }
  menu(cx) {
    cx.stop_propagation();
    const target = targetFor(this.root, this.path, false, this.on, window()?.platform);
    if (target) openOverlay({ mod: "files-plus", kind: "popup", width: 220, height: menuHeight(target, {}, globalThis.window.viewport_size().height / (settings().zoom || 1) * 0.85), props: { role: "menu", target } });
  }
  close() { this.disposed = true; this.preview.close(); }
  render(cx) {
    if (!this.disposed && !this.syncScheduled && shared(CHANGE_KEY)?.revision !== this.lastChange) {
      this.syncScheduled = true;
      cx.timer.after(0, cx => { this.syncScheduled = false; if (!this.disposed) this.sync(cx); });
    }
    const t = theme(), pinned = libraryFor(shared(LIBRARY_KEY), this.root, this.on).pinned.includes(this.path);
    return v_flex().id("file-tab-preview").size_full().min_w(0).min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(12)
      // The workspace pane header already shows this file, its pin and its actions.
      .when(!headerShown(), el => el.child(h_flex().h(40).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(fileIcon(this.path || ""))
        .child(div().flex_1().min_w(0).truncate().tooltip(`${this.on ? this.on + ":" : ""}${this.root}/${this.path}`).child(this.path || "File preview"))
        .when(Boolean(shared(DIRTY_KEY)?.[this.p.previewId]), el => el.child(div().size(7).flex_none().rounded(4).bg(t.working).tooltip("Unsaved changes")))
        .when(!this.error, el => el
          .child(iconButton("file-tab-pin", "pin", pinned ? "Unpin file" : "Pin file", (_e, cx) => { setShared(LIBRARY_KEY, updateLibrary(shared(LIBRARY_KEY), this.root, this.on, "pin", this.path)); cx.notify(); }, t, pinned))
          .child(iconButton("file-tab-actions", "more", "File actions", (_e, cx) => this.menu(cx), t)))))
      .child(this.error ? div().p(12).text_color(t.dim).child(this.error) : this.preview.render(cx));
  }
}
