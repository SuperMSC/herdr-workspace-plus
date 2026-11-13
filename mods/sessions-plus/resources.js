// Herdr's resource use in the status bar, after Orca's resource manager: a memory badge and
// terminal count that open a panel with CPU and memory for Herdr and each terminal.
import { TYPE } from "./type-scale.js";
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Popover } from "gpui-base";
import { exec, theme, window } from "herdr";
import {
  PS_ARGS, SAMPLE_EVERY, OPEN_SAMPLE_EVERY, parsePs, usageSnapshot, formatCpu, formatMemory, badgeMemory, pressure, pushSample,
} from "./perf-model.js";

export default class Resources {
  init(_p, cx) {
    this.snapshot = null; this.history = []; this.open = false; this.busy = false; this.error = "";
    this.folded = new Set(); this.last = 0;
    this.enabled = window()?.platform !== "windows";
    if (!this.enabled) return;
    this.sample(cx);
    // Every 5 s in the bar, every 2 s while the panel is open.
    cx.timer.every(OPEN_SAMPLE_EVERY, cx => { if (this.open || Date.now() - this.last >= SAMPLE_EVERY - 100) this.sample(cx); });
  }

  sample(cx) {
    if (this.busy || this.disposed) return;
    this.busy = true; this.last = Date.now();
    cx.spawn(async cx => {
      try {
        const result = await exec("ps", PS_ARGS);
        if (result.code !== 0) throw new Error((result.stderr || "ps failed").trim());
        this.snapshot = usageSnapshot(parsePs(result.stdout));
        if (this.snapshot) this.history = pushSample(this.history, this.snapshot.cpu);
        this.error = this.snapshot ? "" : "No Herdr process found";
      } catch (error) { this.error = String(error.message ?? error); }
      finally { this.busy = false; if (!this.disposed) cx.notify(); }
    });
  }

  tooltip() {
    const s = this.snapshot;
    if (!s) return this.error || "Reading Herdr resource use…";
    return [
      `Herdr · ${formatCpu(s.herdr.cpu)} CPU · ${formatMemory(s.herdr.memory)}`,
      `Terminals · ${s.terminals.length} · ${formatCpu(s.terminalCpu)} CPU · ${formatMemory(s.terminalMemory)}`,
      "Click for details",
    ].join("\n");
  }

  trigger(t) {
    const s = this.snapshot, high = pressure(s) === "high";
    return h_flex().id("workspace-resources-trigger").h(24).line_height("16px").text_size(TYPE.sm).px(5).gap(5).flex_none().items_center().rounded(5).cursor_pointer()
      .hover(el => el.bg(t.hover)).tooltip(this.tooltip()).accessibility_label("Herdr resource use")
      .child(svg("mods/sessions-plus/memory.svg").size(13).flex_none().text_color(t.dim))
      .child(div().whitespace_nowrap().font_medium().text_color(high ? t.ansi3 : t.muted).child(s ? badgeMemory(s.herdr.memory) : "—"))
      .child(div().text_color(t.dim).opacity(0.6).child("·"))
      .child(svg("mods/sessions-plus/terminal.svg").size(13).flex_none().text_color(t.dim))
      .child(div().whitespace_nowrap().text_color(t.muted).child(s ? String(s.terminals.length) : "—"));
  }

  // Bars for the last samples of total CPU, scaled to the busiest one.
  spark(t) {
    const top = Math.max(1, ...this.history);
    return h_flex().h(16).gap(1).items_end().flex_none()
      .children(this.history.map(value => div().w(2).flex_none().rounded(1).bg(t.dim).opacity(0.7).h(Math.max(1, Math.round(value / top * 16)))));
  }

  metrics(t, cpu, memory, strong = false) {
    return h_flex().flex_none().items_center().text_color(strong ? t.foreground : t.muted)
      .child(div().w(46).text_right().child(formatCpu(cpu)))
      .child(div().w(64).text_right().child(formatMemory(memory)));
  }

  section(t, id, label, count, cpu, memory, rows) {
    const open = !this.folded.has(id);
    return v_flex().flex_none().border_t(1).border_color(t.border)
      .child(h_flex().id(`resources-${id}`).h(28).px(8).gap(5).items_center().cursor_pointer().hover(el => el.bg(t.hover))
        .on_click((_e, cx) => { open ? this.folded.add(id) : this.folded.delete(id); cx.notify(); })
        .child(svg(`mods/sessions-plus/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().font_medium().text_color(t.foreground).child(label))
        .when(count !== null, el => el.child(div().flex_none().text_color(t.dim).child(String(count))))
        .child(this.metrics(t, cpu, memory, true)))
      .when(open, el => el.children(rows.map(row => h_flex().h(24).pl(25).pr(8).gap(5).items_center()
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(row.label))
        .when(Boolean(row.note), el => el.child(div().flex_none().text_size(TYPE.xs).text_color(t.dim).child(row.note)))
        .child(this.metrics(t, row.cpu, row.memory)))));
  }

  panel(t) {
    const s = this.snapshot;
    const header = h_flex().h(32).flex_none().px(10).gap(7).items_center().border_b(1).border_color(t.border)
      .child(svg("mods/sessions-plus/memory.svg").size(13).flex_none().text_color(t.dim))
      .child(div().flex_1().font_medium().text_color(t.foreground).child("Resources"))
      .child(div().id("resources-refresh").size(24).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
        .text_color(this.busy ? t.accent : t.muted).hover(el => el.bg(t.hover).text_color(t.foreground)).tooltip("Refresh")
        .on_click((_e, cx) => this.sample(cx))
        .child(svg("mods/sessions-plus/refresh.svg").size(13).flex_none().when(this.busy, el => el.spin(850))));
    if (!s) return v_flex().size_full().child(header).child(div().p(12).text_color(this.error ? t.ansi1 : t.dim).child(this.error || "Reading…"));
    const summary = h_flex().flex_none().px(10).py(8).gap(6).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().text_size(TYPE.md).text_color(t.foreground).child(formatCpu(s.cpu)))
      .child(div().text_color(t.dim).opacity(0.6).child("·"))
      .child(div().font_semibold().text_size(TYPE.md).text_color(t.foreground).child(formatMemory(s.memory)))
      .child(div().text_color(t.dim).child("resident"))
      .child(div().flex_1())
      .child(this.spark(t));
    const columns = h_flex().h(22).flex_none().px(8).gap(5).items_center().bg(t.raised).text_size(TYPE.xs).text_color(t.dim)
      .child(div().flex_1().pl(18).child("NAME")).child(div().w(46).text_right().child("CPU")).child(div().w(64).text_right().child("MEMORY"));
    const herdr = [
      { label: "App", note: s.app.count > 1 ? `×${s.app.count}` : "", cpu: s.app.cpu, memory: s.app.memory },
      { label: "herdr-core", note: s.core.count > 1 ? `×${s.core.count}` : "", cpu: s.core.cpu, memory: s.core.memory },
    ].filter(row => row.label !== "App" || s.app.count);
    const terminals = s.terminals.map(row => ({ label: row.label, note: row.processes > 1 ? `×${row.processes}` : "", cpu: row.cpu, memory: row.memory }));
    return v_flex().size_full().min_h(0).text_size(TYPE.sm)
      .child(header).child(summary).child(columns)
      .child(v_flex().id("resources-list").flex_1().min_h(0).overflow_y_scrollbar()
        .child(this.section(t, "herdr", "Herdr", null, s.herdr.cpu, s.herdr.memory, herdr))
        .child(this.section(t, "terminals", "Terminals", s.terminals.length, s.terminalCpu, s.terminalMemory, terminals)))
      .child(div().flex_none().px(10).py(6).border_t(1).border_color(t.border).text_size(TYPE.xs).text_color(t.dim)
        .child("CPU: recent average, 100% = one core"));
  }

  render() {
    if (!this.enabled) return div();
    const t = theme();
    return Popover.new("workspace-resources-popover").open(this.open).anchor("bottom_right")
      .on_open_change((open, cx) => { this.open = open; if (open) this.sample(cx); cx.notify(); })
      .trigger(this.trigger(t))
      .content(div().w(300).h(380).rounded(9).border_1().border_color(t.border).bg(t.surface).overflow_hidden().child(this.panel(t)));
  }

  close() { this.disposed = true; }
}
