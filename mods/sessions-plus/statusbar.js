import { privacyToggle } from "./privacy.js";
import { div, svg } from "gpui-kit";
import { h_flex, Popover } from "gpui-base";
import { theme, shared, setShared } from "herdr";
import { PROVIDERS } from "./model.js";
import { providerIcon } from "./icons.js";
import { durationLabel, percentage, resetLabel, quotaWarning } from "./quota-model.js";
import Quota from "./quota.js";

export default class StatusBar {
  init(p, cx) {
    this.open = false; this.embedded = Boolean(p.embedded);
    this.quota = new Quota();
    this.quota.init({ ...p, statusbar: true }, cx);
    cx.timer.every(300000, cx => this.quota.refresh(cx, true));
    cx.timer.every(30000, cx => cx.notify());
  }

  countdown(value, windowMinutes) {
    if (!Number.isFinite(value)) return windowMinutes === 300 ? "5h" : "—";
    const minutes = Math.ceil((value - Date.now()) / 60000);
    if (minutes <= 0) return "0m";
    const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
    return days ? `${days}d ${hours}h` : hours ? `${hours}h ${rest}m` : `${rest}m`;
  }

  summaries(mode) {
    return this.quota.visibleProviders().flatMap(provider => {
      const data = this.quota.data[provider], warning = quotaWarning(data);
      if (!["ok", "stale"].includes(data?.state) || !Array.isArray(data.windows)) return warning ? [{
        provider, row: null, text: "—", compact: "—", brief: "—", extra: 0, stale: false, warning,
        tooltip: `${PROVIDERS[provider]}\n${warning}`,
      }] : [];
      const metered = data.windows.filter(row => Number.isFinite(row?.remaining) && Number.isFinite(row?.used));
      const row = metered.reduce((lowest, row) => !lowest || row.remaining < lowest.remaining ? row : lowest, null)
        ?? data.windows.find(row => row?.unlimited);
      if (!row) return [];
      const windows = data.windows.filter(item => item?.unlimited || (Number.isFinite(item?.remaining) && Number.isFinite(item?.used)));
      const label = mode === "used" ? "Used" : "Remaining", stale = data.state === "stale";
      const details = windows.map(item => `${item.label}: ${percentage(item, mode)}${item.unlimited ? "" : ` · ${resetLabel(item.resetAt)}${!Number.isFinite(item.resetAt) && item.minutes === 300 ? " · Showing default 5h" : ""}`}`);
      const tooltip = [`${PROVIDERS[provider]} · ${label}${stale ? " · Stale" : ""}`, ...details, warning].filter(Boolean).join("\n");
      const format = withPercentage => windows.slice(0, 2).map(item => item.unlimited ? "∞" : [
        Number.isFinite(item.minutes) && item.minutes > 0 ? durationLabel(item.minutes) : "",
        withPercentage ? percentage(item, mode) : "", this.countdown(item.resetAt, item.minutes),
      ].filter(Boolean).join(" ")).join(" · ");
      return [{ provider, row, text: row.unlimited ? "∞" : percentage(row, mode), compact: format(true), brief: format(false), extra: Math.max(0, windows.length - 2), stale, warning, tooltip }];
    });
  }

  render() {
    const t = theme(), mode = shared("sessions-plus.quota-mode") === "used" ? "used" : "remaining";
    const summaries = this.summaries(mode);
    const visible = this.quota.visibleProviders();
    const loading = visible.some(provider => this.quota.pending.has(provider));
    const wait = visible.length ? Math.max(0, Math.ceil((Math.min(...visible.map(provider => this.quota.started[provider] ?? 0)) + 60000 - Date.now()) / 1000)) : 0;
    const refreshDisabled = loading || wait > 0 || !visible.length;
    const refreshHint = loading ? "Refreshing quota…" : !visible.length ? "Show an account in Agents to refresh" : wait ? `Refresh available in ${wait}s` : "Refresh quota";
    const refreshDetails = visible.flatMap(provider => {
      const data = this.quota.data[provider];
      if (!data) return [];
      if (data.state !== "ok") return [`${PROVIDERS[provider]}: ${data.message || "Quota refresh unavailable"}`];
      if (!Number.isFinite(data.updatedAt)) return [];
      const date = new Date(data.updatedAt);
      const clock = [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, "0")).join(":");
      return [`${PROVIDERS[provider]}: updated ${clock}`];
    });
    const stop = (_event, cx) => cx.stop_propagation();
    const quotaWidth = Math.max(0, (this.width ?? 1000) - (this.modeWidth ?? 68) - 46 - (this.privacyWidth ?? 60) - 4);
    const size = field => (value, cx) => {
      if (Number.isFinite(value.width) && Math.abs(value.width - (this[field] ?? -1)) > 0.5) {
        this[field] = value.width; cx.notify();
      }
    };
    const full = item => `${item.compact}${item.extra ? ` +${item.extra}` : ""}`;
    const brief = item => `${item.brief}${item.extra ? ` +${item.extra}` : ""}`;
    // Account for fixed icons and their gaps before choosing whole labels.
    const needed = (label, bars) => summaries.reduce((sum, item) => sum + label(item).length * 7 + 31 + (item.warning ? 19 : 0) + (bars && item.row && !item.row.unlimited ? 38 : 0), Math.max(0, summaries.length - 1) * 6);
    const warnings = summaries.filter(item => item.warning);
    // Hide bars, then percentages; retain per-agent warning icons when labels no longer fit.
    const bars = needed(full, true) <= quotaWidth;
    const label = bars || needed(full, false) <= quotaWidth ? full : brief;
    const minimal = needed(label, bars) > quotaWidth && warnings.length > 0 && needed(() => "", false) <= quotaWidth;
    const collapsed = !minimal && needed(label, bars) > quotaWidth;
    const refresh = div().id("quota-status-refresh").size(24).p(0).ml(2).flex_none().flex().items_center().justify_center().rounded(4)
      .text_color(loading ? t.accent : t.muted).disabled(refreshDisabled).accessibility_label("Refresh quota")
      .when(refreshDisabled, el => el.cursor_default().opacity(loading ? 1 : 0.45))
      .when(!refreshDisabled, el => el.cursor_pointer().hover(el => el.bg(t.hover).text_color(t.foreground)))
      .tooltip([refreshHint, ...refreshDetails].join("\n"))
      .on_mouse_down("left", stop).on_click((_event, cx) => { if (!refreshDisabled) this.quota.refresh(cx); })
      .child(svg("mods/sessions-plus/refresh.svg").id("quota-status-refresh-icon").size(14).flex_none().when(loading, el => el.spin(850)));
    const groups = h_flex().id("quota-status-trigger").h(25).min_w(0).max_w(quotaWidth).gap(6).items_center().cursor_pointer()
      .children((collapsed ? [] : summaries).map(item => h_flex().id(`quota-status-${item.provider}`).h(23).px(5).gap(6).flex_none().items_center().rounded(5)
        .hover(el => el.bg(t.hover)).tooltip(item.tooltip)
        .child(providerIcon(item.provider, 15))
        .when(bars && item.row && !item.row.unlimited, el => el.child(div().w(32).h(5).flex_none().rounded(3).bg(t.raised).overflow_hidden()
          .child(div().h_full().w(`${Math.max(0, Math.min(100, item.row[mode]))}%`).rounded(3).bg(item.stale ? t.ansi3 : t.dim))))
        .when(!minimal, el => el.child(div().whitespace_nowrap().text_color(item.stale ? t.ansi3 : t.muted).child(label(item))))
        .when(Boolean(item.warning), el => el.child(div().id(`quota-status-warning-${item.provider}`).size(13).flex_none().text_color(t.ansi3).tooltip(item.warning).accessibility_label(`${PROVIDERS[item.provider]}: ${item.warning}`).child(svg("mods/sessions-plus/warning.svg").size(13))))))
      .when(collapsed || (!summaries.length && !loading), el => el.child(div().text_color(t.muted).tooltip("Open quota details").child("Quota")))
      .when(collapsed && warnings.length > 0, el => el.child(div().id("quota-status-warning").size(13).flex_none().text_color(t.ansi3)
        .tooltip(warnings.map(item => `${PROVIDERS[item.provider]}: ${item.warning}`).join("\n")).accessibility_label("Quota refresh failed; open details").child(svg("mods/sessions-plus/warning.svg").size(13))))
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
      .child(refresh)
      .child(div().id("screenshot-mode-toggle").on_size_change(size("privacyWidth")).h(24).px(6).flex_none().rounded(4).cursor_pointer().text_color(t.muted).hover(el => el.bg(t.hover)).tooltip("Hide Agent Workspace panels for screenshots; terminal text remains visible").on_click(() => privacyToggle()).child("Privacy"));
  }
}
