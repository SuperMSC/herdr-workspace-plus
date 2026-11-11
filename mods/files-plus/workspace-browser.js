// Compose existing bounded browsers; every row keeps its original machine/root identity.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { shared, setShared, theme, openOverlay, settings } from "herdr";
import Browser from "./browser.js";
import { projectContext } from "./file-tabs.js";
import { WORKSPACES_KEY, WORKSPACE_FOLDS_KEY, workspaceKey, workspaceRecord, workspaceRoots, rootKey } from "./workspace-model.js";
import { EXPAND_LIMIT } from "./model.js";
import { iconButton, fileIcon } from "./icons.js";

export default class WorkspaceBrowser {
  init(p, cx) { this.p = p; this.children = new Map(); this.sync(cx); }
  raw() { return this.p.source || projectContext(); }
  signature() {
    const context = this.raw(), record = workspaceRecord(shared(WORKSPACES_KEY), context);
    return JSON.stringify([workspaceKey(context), record || context, [...this.folded(context)]]);
  }
  sync(cx) {
    if (this.disposed) return;
    this.context = { ...this.raw() }; this.applied = this.signature();
    this.record = workspaceRecord(shared(WORKSPACES_KEY), this.context);
    this.roots = workspaceRoots(shared(WORKSPACES_KEY), this.context);
    if (!this.roots.length) this.roots = [{ path: "", name: "No folder" }];
    const previous = this.children, next = new Map();
    for (const root of this.roots) {
      const key = rootKey(root.path, this.context.on), source = { cwd: root.path, on: this.context.on ?? null, space: this.context.space };
      let browser = previous.get(key);
      if (!browser) { browser = new Browser(); browser.init({ source }, cx); }
      else if (JSON.stringify(browser.source) !== JSON.stringify(source)) { browser.source = source; browser.refresh(cx); }
      next.set(key, browser);
    }
    for (const [key, browser] of previous) if (!next.has(key)) browser.close();
    this.children = next; this.main = next.values().next().value;
    this.main.onWorkspaceManage = cx => this.manage(cx);
    this.main.onWorkspaceSearch = cx => this.search(cx);
    this.main.onWorkspaceFold = cx => this.fold(cx);
    this.main.onWorkspaceFoldState = () => this.foldState();
    this.applyPaused(cx);
  }
  folded(context = this.context) {
    const value = shared(WORKSPACE_FOLDS_KEY)?.[workspaceKey(context)];
    const current = new Set(workspaceRoots(shared(WORKSPACES_KEY), context).map(root => rootKey(root.path, context.on)));
    return new Set(Array.isArray(value) ? value.filter(key => typeof key === "string" && current.has(key)).slice(0, 8) : []);
  }
  applyPaused(cx) {
    const folded = this.folded();
    for (const [key, browser] of this.children) browser.pause?.(this.roots.length > 1 && folded.has(key), cx);
  }
  manage() {
    openOverlay({ mod: "files-plus", kind: "dialog", frame: "none", width: 620, height: 460, props: { role: "workspace-roots", context: { ...this.context } } });
  }
  search() {
    const viewport = globalThis.window.viewport_size(), zoom = settings().zoom || 1;
    openOverlay({ mod: "files-plus", kind: "dialog", frame: "none", width: Math.min(1050, viewport.width / zoom * .92), height: Math.min(800, viewport.height / zoom * .88),
      props: { role: "search", root: this.roots[0]?.path, on: this.context.on ?? null, roots: this.roots.map(root => ({ root: root.path, name: root.name, on: this.context.on ?? null })) } });
  }
  foldState() {
    const states = [...this.children.values()].map(browser => { browser.mode = this.main.mode; return browser.foldState(true); });
    return { usable: states.some(state => state.usable), open: states.some(state => state.open) };
  }
  fold(cx) {
    const open = this.foldState().open, budget = Math.max(1, Math.floor(EXPAND_LIMIT / this.children.size));
    for (const browser of this.children.values()) {
      browser.mode = this.main.mode;
      if (open) { if (browser.foldState(true).open) browser.foldAll(cx, true, budget); }
      else browser.foldAll(cx, true, budget);
    }
  }
  toggle(key, cx) {
    const current = { ...(shared(WORKSPACE_FOLDS_KEY) || {}) }, identity = workspaceKey(this.context), folded = this.folded();
    if (folded.has(key)) folded.delete(key); else folded.add(key);
    current[identity] = [...folded];
    const keys = Object.keys(current); for (const stale of keys.slice(0, Math.max(0, keys.length - 40))) if (stale !== identity) delete current[stale];
    setShared(WORKSPACE_FOLDS_KEY, current); this.applyPaused(cx); this.applied = this.signature(); cx.notify();
  }
  navigation(t) {
    const folded = this.folded(); let remaining = 5000;
    return v_flex().id("workspace-navigation").flex_1().min_h(0).min_w(0).overflow_y_scrollbar().px(6).py(4).children(this.roots.map((root, index) => {
      const key = rootKey(root.path, this.context.on), browser = this.children.get(key), closed = folded.has(key);
      browser.mode = this.main.mode;
      const entries = closed ? [] : browser.visibleEntries(), visible = entries.slice(0, remaining); remaining -= visible.length;
      return v_flex().id(`workspace-root-tree-${index}`).flex_none().min_w(0)
        .child(h_flex().id(`workspace-root-${index}`).h(30).flex_none().gap(6).px(5).items_center().rounded(5).bg(t.raised).cursor_pointer()
          .on_click((_e, cx) => this.toggle(key, cx)).on_mouse_down("right", (_e, cx) => browser.menu("", true, cx, true))
          .child(svg(`mods/files-plus/chevron-${closed ? "right" : "down"}.svg`).size(10).text_color(t.dim)).child(fileIcon(root.path, true, !closed))
          .child(div().flex_1().min_w(0).truncate().font_semibold().tooltip(`${this.context.on ? this.context.on + ":" : ""}${root.path}`).child(root.name))
          .child(iconButton(`workspace-root-search-${index}`, "search", "Search this folder", (_e, cx) => Browser.prototype.search.call({ ...browser, onWorkspaceSearch: null }, cx), t)))
        .when(!closed, el => el.when(browser.mode !== "tree", child => child.child(browser.libraryHeader(t, entries.length, `workspace-${index}-`))).children(visible.map(entry => browser.row(entry, t, `workspace-${index}`)))
          .when(!visible.length, child => child.child(div().px(10).py(6).text_color(t.dim).text_size(11).child(browser.error || (browser.loading ? "Loading files…" : browser.mode === "tree" ? "No files" : "No saved files in this folder"))))
          .when(visible.length < entries.length || browser.limited, child => child.child(div().px(10).py(5).text_color(t.dim).text_size(10.5).child("Workspace display limit reached; use Search to find more files."))));
    }));
  }
  close() { this.disposed = true; for (const browser of this.children.values()) browser.close(); }
  render(cx) {
    for (const browser of this.children.values()) browser.scheduleSync(cx);
    if (this.signature() !== this.applied && !this.scheduled) {
      this.scheduled = true; cx.timer.after(0, cx => { this.scheduled = false; if (!this.disposed) { this.sync(cx); cx.notify(); } });
    }
    return this.main.render(cx, this.roots.length > 1 ? t => this.navigation(t) : null);
  }
}
