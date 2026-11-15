import { TYPE } from "./type-scale.js";
import { div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";
import { theme, shared, setShared, spaces, exec, appHome, pickFolder, run, closeOverlay } from "herdr";
import { GIT_OVERVIEW_KEY, repositorySummary, overviewRows } from "./git-overview-model.js";
import { PRESETS_KEY, presetState } from "./presets-model.js";

export default class GitOverview {
  init(p, cx) {
    this.p = p; this.rows = []; this.query = ""; this.attention = true; this.error = ""; this.warnings = [];
    this.handle = cx.focus_handle(); this.handle.focus();
    const saved = shared(GIT_OVERVIEW_KEY);
    this.roots = Array.isArray(saved?.roots) ? saved.roots.filter(path => typeof path === "string" && path.startsWith("/")).slice(0, 12) :
      [...new Set([!p.context?.on && (p.context?.root || p.context?.cwd), ...spaces().filter(s => !s.machine).map(s => s.folder), ...presetState(shared(PRESETS_KEY)).presets.filter(p => !p.on).map(p => p.root)].filter(path => typeof path === "string" && path.startsWith("/")))].slice(0, 12);
    this.input = InputState.new({ placeholder: "Filter repositories, branches or status…" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); cx.notify(); });
    this.refresh(cx);
  }
  remember() { setShared(GIT_OVERVIEW_KEY, { roots: [...this.roots] }); }
  add(cx) {
    if (this.loading || this.roots.length >= 12 || this.picking) return;
    this.picking = true;
    cx.spawn(async cx => {
      try { const path = await pickFolder({ prompt: "Choose a folder containing Git repositories" }); if (path && !this.disposed && !this.roots.includes(path)) { this.roots.push(path); this.remember(); this.refresh(cx); } }
      catch (error) { this.error = String(error.message || error); }
      finally { this.picking = false; if (!this.disposed) cx.notify(); }
    });
  }
  remove(path, cx) { if (this.loading) return; this.roots = this.roots.filter(p => p !== path); this.remember(); this.refresh(cx); }
  refresh(cx) {
    if (this.loading || this.disposed) return;
    this.error = ""; this.loading = true; cx.notify();
    const roots = [...this.roots];
    cx.spawn(async cx => {
      try {
        const result = await exec(this.p.node || "node", [appHome() + "/mods/sessions-plus/git-overview.mjs", JSON.stringify({ roots })], { timeout: 25000 });
        const data = JSON.parse(result.stdout); if (result.code || data.error || !Array.isArray(data.rows)) throw new Error(data.error || "Repository scan failed");
        if (!this.disposed) { this.rows = data.rows; this.warnings = data.warnings; this.limited = data.limited; this.scannedAt = data.scannedAt; }
      } catch (error) { if (!this.disposed) this.error = String(error.message || error); }
      finally { this.loading = false; if (!this.disposed) cx.notify(); }
    });
  }
  open(row) {
    const space = spaces().find(s => !s.machine && s.folder?.replace(/\/+$/, "") === row.path.replace(/\/+$/, ""));
    closeOverlay(this.p.overlay);
    if (space) run("space.select", { id: space.id }); else run("space.new", { folder: row.path });
  }
  close() { this.disposed = true; this.input?.release(); }
  render() {
    const t = theme(), rows = overviewRows(this.rows, this.query, this.attention);
    const button = (id, label, action, disabled = false) => div().id(id).px(8).py(5).rounded(5).text_color(disabled ? t.dim : t.foreground).when(!disabled, el => el.cursor_pointer().hover(el => el.bg(t.hover)).on_click((_e, cx) => action(cx))).child(label);
    return v_flex().id("git-overview").size_full().min_h(0).p(14).gap(8).bg(t.surface).text_color(t.foreground).text_size(TYPE.md)
      .track_focus(this.handle).on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(h_flex().items_center().gap(6).child(div().flex_1().text_size(TYPE.lg).font_semibold().child("Git overview"))
        .child(button("overview-add", "Add folder", cx => this.add(cx), this.loading || this.roots.length >= 12))
        .child(button("overview-refresh", this.loading ? "Scanning…" : "Refresh", cx => this.refresh(cx), this.loading)))
      .child(h_flex().flex_none().flex_wrap().gap(4).children(this.roots.map(path => button(`overview-root-${path}`, `${path}  ×`, cx => this.remove(path, cx), this.loading).tooltip("Remove this scan folder"))))
      .child(Input.new(this.input).w_full())
      .child(h_flex().gap(8).items_center().child(button("overview-filter", this.attention ? "Needs attention" : "All repositories", cx => { this.attention = !this.attention; cx.notify(); }))
        .child(div().flex_1().text_size(TYPE.sm).text_color(t.dim).child(`${rows.length} / ${this.rows.length} repositories${this.scannedAt ? " · " + new Date(this.scannedAt).toLocaleTimeString() : ""}`)))
      .when(Boolean(this.error), el => el.child(div().text_color(t.blocked).child(this.error)))
      .when(this.limited, el => el.child(div().text_color(t.working).child("Partial scan · narrow the folders to include more repositories.")))
      .when(Boolean(this.warnings.length), el => el.child(div().text_size(TYPE.sm).text_color(t.working).child(this.warnings.join("\n"))))
      .child(v_flex().id("overview-repos").flex_1().min_h(0).gap(7).overflow_y_scrollbar().pr(16).children(rows.map(row => v_flex().id(`overview-repo-${row.path}`).flex_none().p(10).gap(5).rounded(6).bg(t.raised)
        .child(h_flex().gap(8).items_center().child(div().flex_1().truncate().font_semibold().child(row.path.split("/").pop() || row.path))
          .child(div().text_color(t.muted).child(row.branch || "—")).child(button(`overview-open-${row.path}`, "Open", () => this.open(row), Boolean(row.error))))
        .child(div().text_size(TYPE.sm).text_color(t.dim).truncate().tooltip(row.path).child(row.path))
        .child(div().text_size(TYPE.sm).text_color(row.error || row.conflicts ? t.blocked : t.muted).child(repositorySummary(row)))))
        .when(!rows.length && !this.loading, el => el.child(div().p(12).text_color(t.dim).child(!this.roots.length ? "Add a project folder to scan." : this.attention && this.rows.length ? "No repositories need attention." : "No matching repositories found."))))
      .child(div().text_size(TYPE.xs).text_color(t.dim).child("Local folders · depth 4 · up to 150 repositories · ahead/behind use local refs · no automatic fetch"));
  }
}
