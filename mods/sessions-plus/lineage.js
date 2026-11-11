import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { terminals, agents, spaces, theme, run, closeOverlay } from "herdr";
import { LINEAGE_LIMIT, lineageForest, lineageRows, lineageIdentity } from "./lineage-model.js";

export default class Lineage {
  init(p, cx) {
    this.p = p; this.folded = new Set(); this.query = ""; this.activeOnly = false; this.page = 0; this.error = "";
    this.handle = cx.focus_handle(); this.handle.focus(); this.input = InputState.new({ placeholder: "Search agent, terminal, project or machine…" });
    this.input.on("change", (_event, cx) => { this.query = this.input.value(); this.page = 0; this.updateRows(); cx.notify(); });
    this.capture(this.snapshot());
  }
  snapshot() { return { terminals: terminals(), agents: agents(), spaces: spaces() }; }
  signature(state) {
    const records = state.terminals.filter(row => row?.state === "live").slice(0, LINEAGE_LIMIT);
    return JSON.stringify([state.terminals.length, records.map(row => [row.address, row.parent, row.created_ms ?? row.created, row.status, row.title, row.name, row.cwd, row.labels?.["herdr.space"], row.program?.name]), state.agents.slice(0, LINEAGE_LIMIT * 2).map(row => [row.address, row.title, row.status, row.space, row.space_name]), state.spaces.slice(0, LINEAGE_LIMIT).map(row => [row.id, row.name])]);
  }
  capture(state) {
    this.forest = lineageForest(state.terminals, state.agents.slice(0, LINEAGE_LIMIT * 2), state.spaces.slice(0, LINEAGE_LIMIT));
    this.applied = this.signature(state); this.updateRows();
  }
  updateRows() { this.rows = lineageRows(this.forest, { query: this.query, activeOnly: this.activeOnly, folded: this.folded }); }
  schedule(cx) {
    if (!cx?.timer?.after || this.scheduled || this.closed) return;
    const state = this.snapshot(), signature = this.signature(state);
    if (signature === this.applied) return;
    this.scheduled = true;
    cx.timer.after(0, cx => { this.scheduled = false; if (!this.closed) { this.capture(this.snapshot()); cx.notify(); } });
  }
  open(row, cx) {
    const current = terminals().find(terminal => terminal.address === row.address && terminal.state === "live");
    if (!current || !row.identity || lineageIdentity(current) !== row.identity) { this.error = "This terminal has ended or been replaced. Select its current row."; cx.notify(); return; }
    run("terminal.peek", { terminal: current.address });
  }
  close() { this.closed = true; this.input?.release(); }
  render(cx) {
    this.schedule(cx);
    const t = theme(), forest = this.forest, rows = this.rows;
    const page = Math.min(this.page, Math.max(0, Math.ceil(rows.length / 50) - 1));
    const button = (id, title, action) => div().id(id).px(8).py(5).rounded(5).bg(t.raised).cursor_pointer().hover(el => el.bg(t.hover)).on_click((_event, cx) => action(cx)).child(title);
    return v_flex().id("agent-lineage").size_full().min_h(0).min_w(0).p(14).gap(9).rounded(10).border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(12).track_focus(this.handle)
      .on_key_down((event, cx) => { if (event.key === "escape") { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(h_flex().flex_none().gap(8).items_center().child(svg("mods/sessions-plus/lineage.svg").size(17).text_color(t.muted)).child(div().flex_1().font_semibold().text_size(15).child("Agent lineage"))
        .child(button("lineage-active", this.activeOnly ? "Working / blocked" : "All live terminals", cx => { this.activeOnly = !this.activeOnly; this.page = 0; this.updateRows(); cx.notify(); })))
      .child(div().text_size(10.5).text_color(t.dim).child("Core parent links · children include agents and commands · click a row to open its live terminal"))
      .child(Input.new(this.input).h(30).px(8).border_1().border_color(t.input).rounded(5).bg(t.background).flex_none())
      .child(v_flex().id("lineage-tree").flex_1().min_h(0).overflow_y_scrollbar().gap(4).children(rows.slice(page * 50, (page + 1) * 50).map(row => h_flex().id(`lineage-${row.address}`).min_h(53).flex_none().pl(6 + Math.min(row.depth, 8) * 16).pr(7).gap(7).items_center().rounded(6).bg(t.raised).when(row.contextOnly, el => el.opacity(.65))
        .child(div().id(`lineage-fold-${row.address}`).w(17).h(28).flex_none().flex().items_center().justify_center().when(row.children.length > 0, el => el.cursor_pointer().on_click((_event, cx) => { this.folded.has(row.address) ? this.folded.delete(row.address) : this.folded.add(row.address); this.updateRows(); cx.notify(); })).text_color(t.dim).child(row.children.length ? row.folded ? "▸" : "▾" : "·"))
        .child(div().size(7).rounded(4).flex_none().bg(t[row.status] || t.dim))
        .child(v_flex().flex_1().min_w(0).py(7).gap(3).cursor_pointer().on_click((_event, cx) => this.open(row, cx))
          .child(h_flex().gap(6).items_center().child(div().flex_1().truncate().font_semibold().child(row.title)).child(div().flex_none().text_size(10).text_color(t[row.status] || t.dim).child(row.status)))
          .child(div().truncate().text_size(10.5).text_color(t.dim).tooltip([row.folder, row.parent].filter(Boolean).join(" · ")).child([row.on || "This computer", row.project, row.address, row.parent ? `from ${row.parent}` : null, row.children.length ? `${row.children.length} children` : null, row.missingParent ? "parent not in live snapshot" : null, row.cycle ? "cycle detected" : null].filter(Boolean).join(" · "))))))
        .when(!rows.length, el => el.child(div().p(12).text_color(t.muted).child("No matching live terminals. Only relationships recorded by herdr-core are shown.")))
        .when(rows.length > 50, el => el.child(h_flex().gap(7).items_center().justify_end()
          .child(div().flex_1().text_size(10.5).text_color(t.dim).child(`${page * 50 + 1}–${Math.min(rows.length, (page + 1) * 50)} of ${rows.length} terminals`))
          .when(page > 0, row => row.child(button("lineage-previous", "Previous", cx => { this.page = page - 1; cx.notify(); })))
          .when((page + 1) * 50 < rows.length, row => row.child(button("lineage-next", "Next", cx => { this.page = page + 1; cx.notify(); }))))))
      .when(forest.limited, el => el.child(div().text_color(t.blocked).child(`Showing the first ${LINEAGE_LIMIT} live terminals. Narrow the connected workload for a complete view.`)))
      .when(Boolean(this.error), el => el.child(div().text_color(t.blocked).child(this.error)));
  }
}
