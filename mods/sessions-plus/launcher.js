import { TYPE } from "./type-scale.js";
import { div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, ScrollHandle } from "gpui-base";
import { theme, spaces, agents, terminals, focused, shared, run, knownAgents, openOverlay, closeOverlay } from "herdr";
import { COMMANDS_KEY } from "./commands-model.js";
import { PRESETS_KEY } from "./presets-model.js";
import { launcherRows, rankRows, sameLauncherTarget } from "./launcher-model.js";
import { projectContext } from "./project-context.js";

export default class Launcher {
  init(p, cx) {
    this.p = p; this.origin = focused()?.pane; this.context = projectContext(); this.query = ""; this.index = 0; this.stage = "main"; this.error = "";
    this.handle = cx.focus_handle(); this.scroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: "Search agents, projects and commands…" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.index = 0; this.scroll.scroll_to_item(0); cx.notify(); });
    this.input.on("submit", (_e, cx) => { const row = this.rows()[this.index]; if (row) this.activate(row, cx); });
    this.input.focus();
  }
  snapshot() { return { spaces: spaces(), agents: agents(), terminals: terminals(), commands: shared(COMMANDS_KEY), presets: shared(PRESETS_KEY) }; }
  rows() {
    if (this.stage === "spaces") return rankRows(spaces().map(s => ({ id: s.id, kind: "choose-space", title: s.name, detail: `${s.machine || "local"} · ${s.folder}`, priority: s.active ? 0 : 1 })), this.query);
    if (this.stage === "programs") return rankRows((this.programs || []).map(p => ({ id: p.key, kind: "program", title: p.name, detail: this.spaceName, priority: 0 })), this.query);
    return launcherRows(this.snapshot(), this.query);
  }
  reset(stage, cx) { this.stage = stage; this.query = ""; this.index = 0; this.error = ""; this.input.set_value(""); this.input.focus(); cx.notify(); }
  dismiss(restore = true) { if (restore && this.origin) run("pane.focus", { pane: this.origin }); closeOverlay(this.p.overlay); }
  open(role, extra = {}) {
    this.dismiss();
    openOverlay({ mod: "sessions-plus", kind: "dialog", width: 900, height: 680,
      props: { role, context: { root: this.context.root || this.context.cwd, on: this.context.on ?? null }, node: this.p.node, stores: this.p.stores, ...extra } });
  }
  activate(row, cx) {
    const fresh = this.rows().find(item => item.id === row.id);
    if (!sameLauncherTarget(row, fresh)) { this.error = "This item changed. Select its current entry."; cx.notify(); return; }
    if (row.kind === "choose-space") {
      const space = spaces().find(s => s.id === row.id); if (!space) return;
      this.spaceId = space.id; this.spaceMachine = space.machine; this.spaceName = space.name; this.programs = []; this.reset("programs", cx); this.loading = true;
      const request = this.request = {};
      cx.spawn(async cx => {
        try { const programs = await knownAgents({ on: space.machine }); if (this.request === request && !this.disposed) this.programs = programs.filter(p => p.installed && p.run?.length); }
        catch (error) { if (this.request === request) this.error = String(error.message || error); }
        finally { if (this.request === request) { this.loading = false; cx.notify(); } }
      }); return;
    }
    if (row.kind === "program") {
      const space = spaces().find(s => s.id === this.spaceId && s.machine === this.spaceMachine), program = this.programs.find(p => p.key === row.id);
      if (!space || !program) { this.error = "The selected space is no longer available."; cx.notify(); return; }
      this.dismiss(false); run("tab.new", { space: space.id, argv: program.run }); return;
    }
    if (row.kind === "agent") { this.dismiss(false); run("agent.focus", { terminal: row.address }); return; }
    if (row.kind === "space") { this.dismiss(false); run("space.select", { id: row.space }); return; }
    if (row.kind === "command") { this.open("commands", { context: row.context, commandId: row.commandId }); return; }
    if (row.kind === "preset") { this.open("presets", { presetId: row.presetId }); return; }
    if (row.action === "new-agent") { this.reset("spaces", cx); return; }
    if (row.action === "palette" || row.action === "settings") { this.dismiss(); run(row.action === "palette" ? "app.palette" : "app.settings"); return; }
    this.open(row.action);
  }
  close() { this.disposed = true; this.request = null; this.input?.release(); }
  render() {
    const t = theme(), rows = this.rows(); this.index = Math.min(this.index, Math.max(0, rows.length - 1));
    return v_flex().id("workspace-launcher").size_full().min_h(0).p(14).gap(10).bg(t.surface).text_color(t.foreground).text_size(TYPE.md)
      .track_focus(this.handle).on_key_down((e, cx) => {
        if (e.key === "escape") { cx.stop_propagation(); if (this.stage !== "main") { this.request = null; this.loading = false; this.reset("main", cx); } else this.dismiss(); }
        if (["up", "down"].includes(e.key)) { cx.stop_propagation(); this.index = Math.max(0, Math.min(rows.length - 1, this.index + (e.key === "down" ? 1 : -1))); this.scroll.scroll_to_item(this.index); cx.notify(); }
      })
      .child(div().font_semibold().text_size(TYPE.lg).child(this.stage === "main" ? "Quick launcher" : this.stage === "spaces" ? "Choose a space" : `Start an agent · ${this.spaceName}`))
      .child(Input.new(this.input).w_full())
      .when(Boolean(this.error), el => el.child(div().text_color(t.blocked).child(this.error)))
      .child(v_flex().id("launcher-results").flex_1().min_h(0).gap(3).overflow_y_scrollbar().track_scroll(this.scroll).pr(16)
        .children(rows.map((row, i) => v_flex().id(`launcher-row-${row.id}`).min_h(54).flex_none().p(8).gap(3).rounded(6).bg(i === this.index ? t.selected : t.surface).cursor_pointer().hover(el => el.bg(t.hover))
          .on_click((_e, cx) => this.activate(row, cx)).child(h_flex().gap(8).child(div().flex_1().truncate().child(row.title)).child(div().text_size(TYPE.xs).text_color(t.dim).child(row.kind)))
          .child(div().truncate().text_size(TYPE.sm).text_color(t.muted).tooltip(row.detail).child(row.detail))))
        .when(!rows.length, el => el.child(div().p(12).text_color(t.dim).child(this.loading ? "Finding installed agents…" : "No matches"))))
      .child(div().flex_none().text_size(TYPE.xs).text_color(t.dim).child("↑ ↓ Select · Enter Open · Esc Back / Close · Saved commands open for review before Run"));
  }
}
