import { div, svg } from "gpui-kit";
import { h_flex, Popover } from "gpui-base";
import { theme, shared, setShared } from "herdr";
import { PROVIDERS } from "./model.js";
import { providerIcon } from "./icons.js";
import { percentage, resetLabel } from "./quota-model.js";
import Quota from "./quota.js";

export default class StatusBar {
  init(p, cx) {
    this.open = false; this.embedded = Boolean(p.embedded);
    this.quota = new Quota();
    this.quota.init({ ...p, statusbar: true }, cx);
    cx.timer.every(300000, cx => this.quota.refresh(cx, true));
    cx.timer.every(30000, cx => cx.notify());
  }

  countdown(value) {
    if (!Number.isFinite(value)) return "";
    const minutes = Math.ceil((value - Date.now()) / 60000);
    if (minutes <= 0) return "↻";
    const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
    return days ? `${days}d ${hours}h` : hours ? `${hours}h ${rest}m` : `${rest}m`;
  }

  summaries(mode) {
    return this.quota.visibleProviders().flatMap(provider => {
      const data = this.quota.data[provider];
      if (!["ok", "stale"].includes(data?.state) || !Array.isArray(data.windows)) return [];
      const metered = data.windows.filter(row => Number.isFinite(row?.remaining) && Number.isFinite(row?.used));
      const row = metered.reduce((lowest, row) => !lowest || row.remaining < lowest.remaining ? row : lowest, null)
        ?? data.windows.find(row => row?.unlimited);
      if (!row) return [];
      const windows = data.windows.filter(item => item?.unlimited || (Number.isFinite(item?.remaining) && Number.isFinite(item?.used)));
      const label = mode === "used" ? "Used" : "Remaining", stale = data.state === "stale";
      const details = windows.map(item => `${item.label}: ${percentage(item, mode)}${item.unlimited ? "" : ` · ${resetLabel(item.resetAt)}`}`);
      const tooltip = [PROVIDERS[provider], `${label}${stale ? " · Stale reading" : ""}`,
        metered.length > 1 ? `Bar: lowest remaining window (${row.label}).` : row.label, ...details].filter(Boolean).join("\n");
      const compact = windows.slice(0, 2).map(item => item.unlimited ? "∞" : [percentage(item, mode), this.countdown(item.resetAt)].filter(Boolean).join(" ")).join(" · ");
      return [{ provider, row, text: row.unlimited ? "∞" : percentage(row, mode), compact, extra: Math.max(0, windows.length - 2), stale, tooltip }];
    });
  }

  render() {
    const t = theme(), mode = shared("sessions-plus.quota-mode") === "used" ? "used" : "remaining";
    const summaries = this.summaries(mode);
    const loading = this.quota.visibleProviders().some(provider => this.quota.pending.has(provider));
    const stop = (_event, cx) => cx.stop_propagation();
    const quotaWidth = Math.max(0, (this.width ?? 1000) - (this.modeWidth ?? 68) - 44);
    const size = field => (value, cx) => {
      if (Number.isFinite(value.width) && Math.abs(value.width - (this[field] ?? -1)) > 0.5) {
        this[field] = value.width; cx.notify();
      }
    };
    const full = item => `${item.compact}${item.extra ? ` +${item.extra}` : ""}${item.stale ? " *" : ""}`;
    const brief = item => `${item.text}${item.stale ? " *" : ""}`;
    // Reserve enough room for whole values instead of truncating a percentage.
    const needed = (label, bars) => summaries.reduce((sum, item) => sum + label(item).length * 7 + 31 + (bars && !item.row.unlimited ? 38 : 0), Math.max(0, summaries.length - 1) * 6);
    const compact = needed(full, true) > quotaWidth;
    const label = compact ? brief : full;
    const bars = needed(label, true) <= quotaWidth;
    const collapsed = needed(label, bars) > quotaWidth;
    const refresh = div().id("quota-status-refresh").size(22).ml(2).flex_none().flex().items_center().justify_center().rounded(4)
      .text_color(t.muted).cursor_pointer().hover(el => el.bg(t.hover).text_color(t.foreground))
      .tooltip(loading ? "Refreshing quota" : "Refresh quota")
      .on_mouse_down("left", stop).on_click((_event, cx) => this.quota.refresh(cx))
      .child(svg("mods/sessions-plus/refresh.svg").size(14));
    const groups = h_flex().id("quota-status-trigger").h(25).min_w(0).max_w(quotaWidth).gap(6).items_center().cursor_pointer()
      .children((collapsed ? [] : summaries).map(item => h_flex().id(`quota-status-${item.provider}`).h(23).px(5).gap(6).flex_none().items_center().rounded(5)
        .hover(el => el.bg(t.hover)).tooltip(item.tooltip)
        .child(providerIcon(item.provider, 15))
        .when(bars && !item.row.unlimited, el => el.child(div().w(32).h(5).flex_none().rounded(3).bg(t.raised).overflow_hidden()
          .child(div().h_full().w(`${Math.max(0, Math.min(100, item.row[mode]))}%`).rounded(3).bg(item.stale ? t.ansi3 : t.dim))))
        .child(div().whitespace_nowrap().text_color(item.stale ? t.ansi3 : t.muted).child(label(item)))))
      .when(collapsed || (!summaries.length && !loading), el => el.child(div().text_color(t.muted).tooltip("Open quota details").child("Quota")))
      .when(!summaries.length && loading, el => el.child(div().text_color(t.dim).child("…")));
    const details = Popover.new("quota-status-popover").open(this.open).anchor("bottom_right")
      .on_open_change((open, cx) => { this.open = open; cx.notify(); })
      .trigger(groups)
      .content(div().w(430).h(510).rounded(9).border_1().border_color(t.border).bg(t.surface).overflow_hidden().child(this.quota.render()));
    return h_flex().id("quota-statusbar").on_size_change(size("width")).size_full().min_w(0).px(6).gap(4).items_center().bg(t.chrome).when(!this.embedded, el => el.border_t(1).border_color(t.border)).text_size(11.5)
      .child(div().id("quota-status-mode").on_size_change(size("modeWidth")).h(24).px(4).flex_none().flex().items_center().rounded(5).text_color(t.dim)
        .cursor_pointer().hover(el => el.bg(t.hover)).tooltip("Click to switch between remaining and used quota")
        .on_mouse_down("left", stop).on_click(() => setShared("sessions-plus.quota-mode", mode === "remaining" ? "used" : "remaining"))
        .child(mode === "used" ? "Used" : "Remaining"))
      .child(div().flex_initial().min_w(0).overflow_hidden().child(details))
      .child(refresh);
  }
}
