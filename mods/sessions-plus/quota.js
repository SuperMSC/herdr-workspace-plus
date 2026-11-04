import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, exec, theme, shared, setShared, window } from "herdr";
import { PROVIDERS } from "./model.js";
import { providerIcon } from "./icons.js";
import { percentage, resetLabel } from "./quota-model.js";

export default class Quota {
  init(p, cx) {
    this.p = p; this.data = {}; this.pending = new Set(); this.started = {}; this.showAgents = false;
    this.refresh(cx);
  }

  hiddenProviders() {
    const saved = shared("sessions-plus.quota-hidden");
    return new Set(Array.isArray(saved) ? saved.filter(provider => Object.hasOwn(PROVIDERS, provider)) : []);
  }

  visibleProviders() {
    const hidden = this.hiddenProviders();
    return Object.keys(PROVIDERS).filter(provider => !hidden.has(provider));
  }

  toggleProvider(provider, cx) {
    if (!Object.hasOwn(PROVIDERS, provider)) return;
    const hidden = this.hiddenProviders(), showing = hidden.has(provider);
    if (showing) hidden.delete(provider); else hidden.add(provider);
    setShared("sessions-plus.quota-hidden", [...hidden]);
    if (showing) this.refresh(cx, false, provider);
    cx.notify();
  }

  refresh(cx, automatic = false, onlyProvider = null) {
    if (window()?.platform !== "macos") return;
    for (const provider of this.visibleProviders()) {
      if (onlyProvider && provider !== onlyProvider) continue;
      const previous = this.data[provider];
      const paused = ["missing-cli", "signed-out"].includes(previous?.reason) || Boolean(previous?.blockedVersion);
      if (this.pending.has(provider) || Date.now() - (this.started[provider] ?? 0) < 60000 || (automatic && paused)) continue;
      this.pending.add(provider);
      cx.spawn(async cx => {
        try {
          if (!this.visibleProviders().includes(provider)) return;
          this.started[provider] = Date.now();
          const options = { stores: this.p.stores ?? {}, blockedVersion: shared("sessions-plus.agy-usage-blocked") };
          const result = await exec(this.p.node || "node", [appHome() + "/mods/sessions-plus/quota.mjs", provider, JSON.stringify(options)]);
          const next = JSON.parse(result.stdout);
          if (result.code || next.provider !== provider || !Array.isArray(next.windows)) throw new Error("Invalid quota response");
          if (next.blockedVersion) setShared("sessions-plus.agy-usage-blocked", next.blockedVersion);
          const previous = this.data[provider];
          const removed = ["missing-cli", "signed-out"].includes(next.reason);
          this.data[provider] = !removed && next.state !== "ok" && previous?.windows.length ? { ...previous, state: "stale", message: next.message, ...(next.blockedVersion ? { blockedVersion: next.blockedVersion } : {}) } : next;
        } catch {
          const previous = this.data[provider];
          this.data[provider] = previous?.windows.length ? { ...previous, state: "stale", message: "Refresh failed; showing the previous reading." } : { provider, state: "unavailable", windows: [], message: "Quota reader unavailable. Check Node.js and CLI sign-in." };
        } finally { this.pending.delete(provider); cx.notify(); }
      });
    }
    cx.notify();
  }

  render() {
    const t = theme(), mode = shared("sessions-plus.quota-mode") === "used" ? "used" : "remaining";
    const visible = this.visibleProviders(), hidden = this.hiddenProviders();
    const available = visible.filter(provider => ["ok", "stale"].includes(this.data[provider]?.state) && this.data[provider]?.windows.length);
    const loading = visible.some(provider => this.pending.has(provider));
    const remaining = Math.max(0, Math.ceil((Math.max(0, ...visible.map(provider => this.started[provider] ?? 0)) + 60000 - Date.now()) / 1000));
    const refreshLabel = loading ? "Updating…" : remaining ? `Refresh · ${remaining}s` : "Refresh";
    const button = (id, text, selected, click) => div().id(id).px(7).py(4).rounded(5).bg(selected ? t.selected : t.surface).text_color(selected ? t.foreground : t.muted).cursor_pointer().hover(el => el.bg(t.hover)).on_click(click).child(text);
    const card = provider => {
      const data = this.data[provider], loading = this.pending.has(provider), stale = data?.state === "stale";
      const timestamp = data?.updatedAt ? new Date(data.updatedAt) : null;
      const updated = timestamp ? `${String(timestamp.getHours()).padStart(2, "0")}:${String(timestamp.getMinutes()).padStart(2, "0")}` : "";
      return v_flex().p(10).gap(9).rounded(8).border_1().border_color(t.border)
        .child(h_flex().items_center().gap(8).child(providerIcon(provider, 21)).child(div().font_semibold().child(PROVIDERS[provider]))
          .child(div().flex_1()).child(div().text_size(10.5).text_color(stale ? t.ansi3 : t.dim).child(loading ? "Updating…" : timestamp ? `${stale ? "Stale · " : "Updated "}${updated}` : "")))
        .children((data?.windows ?? []).map(row => {
          const value = row[mode], color = row.used >= 90 ? t.ansi1 : row.used >= 75 ? t.ansi3 : t.accent;
          return v_flex().gap(4)
            .child(h_flex().gap(6).justify_between().child(div().flex_1().min_w(0).truncate().text_size(11.5).child(row.label)).child(div().flex_none().font_semibold().child(percentage(row, mode))))
            .when(!row.unlimited, el => el.child(div().w_full().h(5).rounded(3).bg(t.raised)
              .child(div().w(`${Math.max(0, Math.min(100, value ?? 0))}%`).h(5).rounded(3).bg(color))))
            .when(!row.unlimited, el => el.child(div().text_size(10.5).text_color(t.dim).child(resetLabel(row.resetAt))));
        }))
        .when(Boolean(data?.message), el => el.child(div().text_size(11).text_color(stale ? t.ansi3 : t.muted).child(data.message)));
    };
    return v_flex().id("sessions-quota").size_full().min_h(0).bg(t.surface).text_color(t.foreground).text_size(12)
      .child(h_flex().px(8).py(7).gap(3).flex_none()
        .child(button("quota-remaining", "Remaining", mode === "remaining", () => setShared("sessions-plus.quota-mode", "remaining")))
        .child(button("quota-used", "Used", mode === "used", () => setShared("sessions-plus.quota-mode", "used")))
        .child(div().flex_1()).child(button("quota-refresh", refreshLabel, false, (_e, cx) => this.refresh(cx))))
      .child(h_flex().px(8).pb(4).flex_none().child(button("quota-agents", `Agents ${this.showAgents ? "▴" : "▾"}`, this.showAgents, (_e, cx) => { this.showAgents = !this.showAgents; cx.notify(); })))
      .when(this.showAgents, el => el.child(v_flex().px(8).pb(5).gap(4).flex_none()
        .child(div().text_size(10.5).text_color(t.dim).child("Show account quota for"))
        .child(h_flex().gap(4).children(Object.keys(PROVIDERS).map(provider => button(`quota-show-${provider}`,
          h_flex().items_center().gap(4).child(div().child(hidden.has(provider) ? "○" : "✓")).child(providerIcon(provider, 14)).child(div().min_w(0).truncate().child(provider === "claude" ? "Claude" : PROVIDERS[provider])),
          !hidden.has(provider), (_e, cx) => this.toggleProvider(provider, cx)).flex_1().min_w(0))))))
      .child(v_flex().id("quota-cards").flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(9).children(available.map(card))
        .when(!available.length, el => el.child(div().p(10).text_color(t.muted).child(!visible.length ? "All agents are hidden. Open Agents to show account quota." : loading ? "Reading account quota…" : "No account quota to show."))))
      .child(div().px(10).py(7).text_size(10.5).text_color(t.dim).flex_none().child(window()?.platform === "macos" ? this.p.statusbar ? "Local accounts · Refreshes every 5 min" : "Local accounts · Refreshes every 5 min while Status is shown" : "Account quota currently requires macOS"));
  }
}
