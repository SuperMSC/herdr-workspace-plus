import { div, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, VirtualListScrollHandle, Input, InputState } from "gpui-base";
import { exec, appHome, theme, settings, openOverlay, closeOverlay } from "herdr";
import { projectContext } from "./file-tabs.js";
import { createGraphClient } from "./graph-reader.js";
import { validateGraphData } from "./graph-model.js";

const tones = ["ansi4", "ansi2", "ansi5", "ansi3", "ansi6", "ansi1"];
export default class GitGraph {
  init(p, cx) {
    this.p = p; const source = p.context || p.source || projectContext(); this.context = { cwd: p.root || source.root || source.cwd, on: Object.hasOwn(p, "on") ? p.on : source.on ?? null };
    this.read = createGraphClient(exec, appHome(), p.node || "node"); this.selection = "all"; this.revision = 0; this.rows = []; this.refs = []; this.lanes = 1; this.error = ""; this.branchQuery = "";
    this.handle = cx.focus_handle(); this.handle.focus(); this.scroll = VirtualListScrollHandle.new(); this.branchInput = InputState.new({ placeholder: "Filter branch names…" });
    this.branchInput.on("change", (_event, cx) => { this.branchQuery = this.branchInput.value(); cx.notify(); }); this.refresh(cx);
  }
  refresh(cx) {
    const revision = ++this.revision, selection = this.selection; this.loading = true; this.error = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        const data = validateGraphData(await this.read({ ...this.context }, selection)); if (this.closed || revision !== this.revision) return;
        this.data = data; this.rows = data.rows; this.refs = data.refs; this.lanes = data.lanes; this.selected = this.rows.find(row => row.hash === this.selected?.hash) || this.rows[0] || null; this.stale = false;
      } catch (error) { if (!this.closed && revision === this.revision) { this.error = String(error.message || error); this.stale = Boolean(this.data); } }
      finally { if (!this.closed && revision === this.revision) { this.loading = false; cx.notify(); } }
    });
  }
  chooseBranch(name, cx) { if (this.loading) return; this.selection = name; this.branchMenu = false; this.selected = null; this.scroll.scroll_to_item(0); this.refresh(cx); }
  pick(key, cx, revision) {
    if (this.closed || this.loading || revision !== this.revision) return;
    const row = this.rows.find(row => row.hash === key); if (row) { this.selected = row; cx.notify(); }
  }
  diff(row = this.selected) {
    if (!row || this.loading || this.stale || !this.rows.some(item => item.hash === row.hash)) return;
    const viewport = globalThis.window.viewport_size(), zoom = settings().zoom || 1;
    openOverlay({ mod: "files-plus", kind: "dialog", frame: "none", width: Math.min(1150, viewport.width / zoom * .94), height: Math.min(850, viewport.height / zoom * .90), props: { role: "changes", expanded: true, showFiles: true, source: { cwd: this.data.root, on: this.context.on }, selection: { commit: row.hash, parents: row.parents, subject: row.subject } } });
  }
  lane(row, t) {
    const x = lane => 10 + lane * 15, color = lane => t[tones[lane % tones.length]] || t.accent;
    return div().w(this.lanes * 15 + 20).h(32).flex_none().relative().children(row.edges.map(edge => {
      const path = PathBuilder.stroke(1.6), top = edge.kind === "out" ? 16 : 0, bottom = edge.kind === "in" ? 16 : 32;
      path.move_to(x(edge.from), top);
      if (edge.from === edge.to) path.line_to(x(edge.to), bottom); else path.cubic_bezier_to(x(edge.to), bottom, x(edge.from), (top + bottom) / 2, x(edge.to), (top + bottom) / 2);
      return globalThis.window.paint_path(path.build(), color(edge.from));
    })).child(div().absolute().left(x(row.lane) - 4).top(12).size(8).rounded(4).bg(row.head ? t.foreground : color(row.lane)).border_1().border_color(t.background));
  }
  row(row, t) {
    return h_flex().h(32).w_full().min_w(0).items_center().gap(8).bg(this.selected?.hash === row.hash ? t.selected : t.background)
      .child(this.lane(row, t)).child(div().w(68).flex_none().text_size(10.5).text_color(row.head ? t.accent : t.dim).child(row.hash.slice(0, 8)))
      .child(div().flex_1().min_w(0).truncate().tooltip(row.subject).child(`${row.head ? "HEAD · " : ""}${row.refs.length ? row.refs.join(" · ") + "  │  " : ""}${row.subject || "(no subject)"}`))
      .child(div().w(110).flex_none().truncate().text_size(10.5).text_color(t.dim).child(row.author))
      .child(div().w(78).flex_none().text_size(10).text_color(t.dim).child(new Date(row.time * 1000).toLocaleDateString()));
  }
  close() { this.closed = true; ++this.revision; this.branchInput?.release(); this.scroll?.release(); }
  render() {
    const t = theme(), revision = this.revision, rows = this.rows, choices = [{ name: "all", label: "All branches" }, { name: "HEAD", label: "Current HEAD" }, ...this.refs].filter(ref => ref.label.toLocaleLowerCase().includes(this.branchQuery.toLocaleLowerCase())).slice(0, 100);
    const button = (id, title, action, disabled = false) => div().id(id).px(8).py(5).flex_none().rounded(5).bg(t.raised).text_color(disabled ? t.dim : t.foreground).when(!disabled, el => el.cursor_pointer().hover(el => el.bg(t.hover))).on_click((_event, cx) => { if (!disabled) action(cx); }).child(title);
    return v_flex().id("git-graph").size_full().min_h(0).min_w(0).p(13).gap(8).rounded(10).border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(12).track_focus(this.handle)
      .on_key_down((event, cx) => { if (event.key === "escape") { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(h_flex().flex_none().gap(7).items_center().child(div().flex_1().font_semibold().text_size(15).child("Git graph"))
        .child(button("graph-branches", this.selection === "all" ? "All branches ▾" : this.selection === "HEAD" ? "Current HEAD ▾" : this.selection.replace(/^refs\/(heads|remotes|tags)\//, "") + " ▾", cx => { this.branchMenu = !this.branchMenu; cx.notify(); }, this.loading))
        .child(button("graph-refresh", this.loading ? "Reading…" : "Refresh", cx => this.refresh(cx), this.loading)))
      .child(div().flex_none().truncate().text_size(10.5).text_color(t.dim).tooltip(this.data?.root || this.context.cwd || "").child(`${this.context.on || "This computer"} · ${this.data?.root || this.context.cwd || "No folder"}`))
      .when(this.branchMenu, el => el.child(v_flex().id("graph-branch-picker").max_h(220).flex_none().gap(3).overflow_y_scrollbar().child(Input.new(this.branchInput).h(30).px(7).bg(t.background).border_1().border_color(t.border)).children(choices.map(ref => button(`graph-branch-${ref.name}`, ref.label, cx => this.chooseBranch(ref.name, cx))))))
      .when(Boolean(this.error), el => el.child(div().flex_none().text_color(t.blocked).child(`${this.stale ? "Stale graph · " : ""}${this.error}`)))
      .child(div().id("graph-list-wrap").flex_1().min_h(0).min_w(0).overflow_hidden().child(v_virtual_list("graph-commits", rows.length, 32, index => `${revision}:${rows[index].hash}`, range => rows.slice(range.start, range.end).map(row => this.row(row, t))).track_scroll(this.scroll).size_full().on_item_click((key, cx) => { const prefix = `${revision}:`; if (typeof key === "string" && key.startsWith(prefix)) this.pick(key.slice(prefix.length), cx, revision); })))
      .when(!rows.length && !this.loading && !this.error, el => el.child(div().p(12).text_color(t.dim).child("This checkout has no commits in the selected view.")))
      .when(Boolean(this.selected), el => el.child(h_flex().flex_none().gap(7).items_center().child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(`${this.selected.hash.slice(0, 8)} · ${this.selected.subject}`))
        .child(button("graph-copy", "Copy SHA", cx => cx.write_to_clipboard(this.selected.hash))).child(button("graph-diff", "Open commit diff", () => this.diff(), this.loading || this.stale))))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`Read only · ${rows.length} commits${this.data?.limited ? " · first 200, choose a branch to narrow history" : ""}${this.data?.refsLimited ? " · branch list limited to 500" : ""} · refs are from the last fetch`));
  }
}
