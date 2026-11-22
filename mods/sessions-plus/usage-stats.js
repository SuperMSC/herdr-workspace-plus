import { TYPE } from "./type-scale.js";
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, exec, theme, shared, setShared, window, settings, openOverlay, closeOverlay } from "herdr";
import { PROVIDERS, UUID, sessionKey } from "./model.js";
import { providerIcon } from "./icons.js";
import { RANGES, TOKEN_PROVIDERS, usageResult, formatTokens, formatUsd, formatCount, shortModel, folderName } from "./usage-model.js";

export const USAGE_RANGE_KEY = "sessions-plus.usage-range";
const STALE_AFTER = 300000;

/**
 * Per-agent usage for the last 7 days and this month, estimated at API list prices.
 * `compact` is the Stats page of the footer quota popover; otherwise it is the full dialog.
 */
export default class UsageStats {
  init(p, cx) {
    this.p = p; this.compact = Boolean(p.compact); this.data = null; this.error = ""; this.loading = false; this.loadedAt = 0; this.metric = "cost";
    if (!this.compact) { this.handle = cx.focus_handle(); this.handle.focus(); }
    this.load(cx);
  }

  range() { return shared(USAGE_RANGE_KEY) === "month" ? "month" : "7d"; }

  /** Reads again only when asked or when the last reading is over five minutes old. */
  load(cx, force = false) {
    if (this.loading || this.closed || window()?.platform !== "macos") return;
    if (!force && this.data && Date.now() - this.loadedAt < STALE_AFTER) return;
    this.loading = true; this.error = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        const options = { stores: this.p.stores ?? {}, appHome: appHome() };
        const result = await exec(this.p.node || "node", [appHome() + "/mods/sessions-plus/usage-stats.mjs", JSON.stringify(options)], { timeout: 90000 });
        let data;
        try { data = JSON.parse(result.stdout); } catch { throw new Error("Usage statistics need Node.js 22+ on PATH. Set the mod's node prop to its executable if needed."); }
        if (result.code || data.error) throw new Error(data.error || "Could not read usage statistics.");
        if (!this.closed) { this.data = usageResult(data); this.loadedAt = Date.now(); }
      } catch (error) { if (!this.closed) this.error = String(error.message ?? error); }
      finally { this.loading = false; if (!this.closed) cx.notify(); }
    });
  }

  /** Called when the popover's Stats page is shown again. */
  shown(cx) { this.load(cx); }

  close() { this.closed = true; }

  colors(t) { return { claude: t.accent, codex: t.ansi6 || t.done || t.muted }; }

  openDetails(cx) {
    const viewport = globalThis.window?.viewport_size?.() ?? { width: 1100, height: 860 }, zoom = Number(settings()?.zoom) || 1;
    this.p.onOpenDetails?.(cx);
    openOverlay({ mod: "sessions-plus", kind: "dialog", width: Math.min(980, viewport.width / zoom * .93), height: Math.min(800, viewport.height / zoom * .9),
      props: { role: "usage-stats", node: this.p.node, stores: this.p.stores } });
  }

  openSession(session) {
    if (!session.store?.startsWith("/") || !UUID.test(session.id ?? "")) return;
    const target = { provider: session.provider, store: session.store, id: session.id, title: session.title, cwd: session.cwd };
    target.key = sessionKey(target);
    const viewport = globalThis.window?.viewport_size?.() ?? { width: 1100, height: 860 }, zoom = Number(settings()?.zoom) || 1;
    closeOverlay(this.p.overlay);
    openOverlay({ mod: "sessions-plus", kind: "dialog", width: Math.min(940, viewport.width / zoom * .93), height: Math.min(760, viewport.height / zoom * .9),
      props: { role: "timeline", target, node: this.p.node, stores: this.p.stores } });
  }

  button(t, id, label, selected, action, disabled = false) {
    return div().id(id).px(7).py(4).rounded(5).flex_none().bg(selected ? t.selected : t.surface).text_color(disabled ? t.dim : selected ? t.foreground : t.muted)
      .when(!disabled, el => el.cursor_pointer().hover(el => el.bg(t.hover)).on_click((_e, cx) => action(cx))).child(label);
  }

  /** Daily bars for one provider (sparkline) or all of them stacked (chart). */
  bars(t, days, providers, height, metric, from, id) {
    const value = (day, provider) => day.providers[provider]?.[metric === "tokens" ? "tokens" : "cost"] ?? 0;
    const max = Math.max(0, ...days.map(day => providers.reduce((sum, provider) => sum + value(day, provider), 0)));
    const colors = this.colors(t), measure = metric === "tokens" ? formatTokens : formatUsd;
    return h_flex().id(id).h(height).w_full().min_w(0).gap(2).items_end().children(days.map(day => {
      const inRange = Date.parse(day.date + "T00:00:00") >= from - 3600000;
      const total = providers.reduce((sum, provider) => sum + value(day, provider), 0);
      const tooltip = [day.date, ...providers.map(provider => `${PROVIDERS[provider]}: ${formatUsd(day.providers[provider]?.cost ?? 0)} · ${formatTokens(day.providers[provider]?.tokens ?? 0)} tokens · ${formatCount(day.providers[provider]?.requests ?? 0)} requests`)].join("\n");
      return v_flex().id(`${id}-${day.date}`).flex_1().min_w(0).h_full().justify_end().opacity(inRange ? 1 : 0.4).tooltip(tooltip)
        .when(total === 0, el => el.child(div().w_full().h(1).bg(t.border)))
        .children(total === 0 ? [] : providers.slice().reverse().filter(provider => value(day, provider) > 0).map(provider =>
          div().w_full().h(Math.max(1, Math.round(value(day, provider) / (max || 1) * height))).bg(colors[provider]).rounded(1)))
        .accessibility_label(`${day.date}: ${measure(total)}`);
    }));
  }

  card(t, provider, totals, days, from) {
    const name = provider === "claude" ? "Claude Code" : PROVIDERS[provider];
    const top = totals.models[0], tokens = totals.tokens;
    return v_flex().id(`usage-card-${provider}`).when(this.compact, el => el.flex_none()).when(!this.compact, el => el.flex_1()).min_w(0).p(10).gap(6).rounded(8).border_1().border_color(t.border)
      .child(h_flex().min_w(0).items_center().gap(8).child(providerIcon(provider, 21).flex_none())
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(name))
        .child(div().id(`usage-cost-${provider}`).flex_none().text_size(TYPE.lg).font_semibold().tooltip("Estimated at API list prices; not what a subscription bills").child(formatUsd(totals.cost))))
      .child(div().text_size(TYPE.sm).text_color(t.muted).child(`${formatTokens(tokens.total)} tokens · ${formatCount(totals.requests)} requests · ${formatCount(totals.sessions)} sessions`))
      .child(div().id(`usage-fresh-${provider}`).text_size(TYPE.sm).text_color(t.muted).truncate()
        .tooltip("Input + output + cache write. Cache reads re-use earlier context and cost far less per token.")
        .child(`${formatTokens(tokens.input + tokens.output + tokens.cacheWrite)} tokens excluding cache reads`))
      .child(div().id(`usage-tokens-${provider}`).text_size(TYPE.xs).text_color(t.dim).truncate()
        .tooltip(`Input ${formatCount(tokens.input)}\nOutput ${formatCount(tokens.output)}\nCache read ${formatCount(tokens.cacheRead)}\nCache write ${formatCount(tokens.cacheWrite)}`)
        .child(`In ${formatTokens(tokens.input)} · Out ${formatTokens(tokens.output)} · Cache read ${formatTokens(tokens.cacheRead)} · Cache write ${formatTokens(tokens.cacheWrite)}`))
      .when(this.compact && Boolean(top), el => el.child(div().text_size(TYPE.xs).text_color(t.dim).truncate().child(`Top model ${shortModel(top.model)} · ${formatUsd(top.cost)}`)))
      // Always one price line, so Claude Code and Codex cards keep the same rows.
      .child(div().id(`usage-priced-${provider}`).text_size(TYPE.xs).text_color(totals.unpricedTokens > 0 ? t.ansi3 : t.dim).truncate()
        .child(totals.unpricedTokens > 0 ? `${formatTokens(totals.unpricedTokens)} tokens from models without a listed price` : "All models priced"))
      .when(this.compact, el => el.child(this.bars(t, days, [provider], 22, "cost", from, `usage-spark-${provider}`)));
  }

  header(t, range) {
    const refresh = this.button(t, "usage-refresh", svg("mods/sessions-plus/refresh.svg").id("usage-refresh-icon").size(14).flex_none().when(this.loading, el => el.spin(850)), false, cx => this.load(cx, true), this.loading)
      .size(24).p(0).rounded(4).flex().items_center().justify_center().tooltip(this.loading ? "Reading local logs…" : "Read usage again").accessibility_label("Refresh usage");
    const updated = this.loadedAt ? new Date(this.loadedAt) : null;
    return h_flex().flex_none().items_center().gap(3).when(this.compact, el => el.pr(8))
      .when(!this.compact, el => el.child(div().text_size(TYPE.lg).font_semibold().mr(8).child("Usage stats")))
      .children(Object.entries(RANGES).map(([key, label]) => this.button(t, `usage-range-${key}`, label, range === key, cx => { setShared(USAGE_RANGE_KEY, key); cx.notify(); })))
      .child(div().flex_1())
      .when(Boolean(updated), el => el.child(div().text_size(TYPE.xs).text_color(t.dim).mr(4).child(`Updated ${String(updated.getHours()).padStart(2, "0")}:${String(updated.getMinutes()).padStart(2, "0")}`)))
      .when(this.compact, el => el.child(this.button(t, "usage-details", "Details", false, cx => this.openDetails(cx)).tooltip("Daily chart, models, projects and sessions")))
      .child(refresh);
  }

  footer(t) {
    const unpriced = this.data?.unpriced ?? [];
    return div().flex_none().when(this.compact, el => el.pl(2).pr(10)).text_size(TYPE.xs).text_color(t.dim)
      .tooltip(["Claude Code and Codex logs on this Mac. Cost is an estimate at API list prices, including cache reads and writes, fast mode and long-context rates.", "Subscription plans are not billed this way.", unpriced.length ? `No listed price: ${unpriced.join(", ")}` : ""].filter(Boolean).join("\n"))
      .child(`Estimated at API list prices (${this.data?.pricingDate ?? "—"}) · local logs · not a bill`);
  }

  table(t, title, rows) { return v_flex().flex_none().gap(5).child(div().font_semibold().child(title)).children(rows); }

  render() {
    const t = theme(), range = this.range(), view = this.data?.ranges?.[range], days = this.data?.days ?? [];
    const content = v_flex().id(this.compact ? "usage-stats-compact" : "usage-stats").size_full().min_h(0).when(this.compact, el => el.pl(8).pt(7).pb(8)).when(!this.compact, el => el.p(14)).gap(8).bg(t.surface).text_color(t.foreground).text_size(TYPE.md)
      .when(!this.compact, el => el.track_focus(this.handle).on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(this.p.overlay); cx.stop_propagation(); } }))
      .child(this.header(t, range))
      // In the popover the right edge belongs to the scrollbar, as on the Quota page.
      .when(Boolean(this.error), el => el.child(div().flex_none().when(this.compact, el => el.pr(8)).text_size(TYPE.sm).text_color(t.blocked || t.ansi1).child(this.error)))
      .when(Boolean(this.data?.warnings?.length), el => el.child(div().flex_none().when(this.compact, el => el.pr(8)).text_size(TYPE.xs).text_color(t.ansi3).child(this.data.warnings.join("\n"))));
    if (window()?.platform !== "macos") return content.child(div().p(10).text_color(t.muted).child("Usage statistics currently require macOS."));
    if (!view) return content.child(div().p(10).text_color(t.muted).child(this.loading ? "Reading local Claude Code and Codex logs…" : "No usage data yet."));
    const cards = TOKEN_PROVIDERS.map(provider => this.card(t, provider, view.providers[provider], days.filter(day => Date.parse(day.date + "T00:00:00") >= view.from - 3600000), view.from));
    if (this.compact) return content
      .child(v_flex().id("usage-cards").flex_1().min_h(0).gap(9).overflow_y_scrollbar().pr(16)
        .child(h_flex().flex_none().items_center().gap(6).px(2).child(div().flex_1().text_color(t.muted).child(`${view.label} · all agents`)).child(div().font_semibold().child(formatUsd(view.cost))))
        .children(cards))
      .child(this.footer(t));
    const colors = this.colors(t), maxProject = Math.max(0, ...view.projects.map(project => project.cost));
    const models = TOKEN_PROVIDERS.flatMap(provider => view.providers[provider].models.map(model => ({ provider, ...model })));
    const right = (width, value, color = t.muted) => h_flex().w(width).flex_none().justify_end().text_size(TYPE.sm).text_color(color).child(value);
    return content
      .child(v_flex().id("usage-sections").flex_1().min_h(0).gap(14).overflow_y_scrollbar().pr(16)
        .child(h_flex().id("usage-card-row").flex_none().items_stretch().gap(8).child(v_flex().id("usage-card-total").w(150).flex_none().p(10).gap(4).rounded(8).bg(t.raised)
          .child(div().text_size(TYPE.sm).text_color(t.muted).child(view.label)).child(div().text_size(TYPE.lg).font_semibold().child(formatUsd(view.cost)))
          .child(div().text_size(TYPE.xs).text_color(t.dim).child("All agents · estimated"))).children(cards))
        .child(v_flex().id("usage-chart").flex_none().gap(6)
          .child(h_flex().items_center().gap(3).child(div().flex_1().font_semibold().child("Last 30 days"))
            .children(TOKEN_PROVIDERS.map(provider => h_flex().items_center().gap(4).mr(6).child(div().size(8).rounded(2).bg(colors[provider])).child(div().text_size(TYPE.xs).text_color(t.muted).child(PROVIDERS[provider]))))
            .child(this.button(t, "usage-metric-cost", "Cost", this.metric === "cost", cx => { this.metric = "cost"; cx.notify(); }))
            .child(this.button(t, "usage-metric-tokens", "Tokens", this.metric === "tokens", cx => { this.metric = "tokens"; cx.notify(); })))
          .child(this.bars(t, days, TOKEN_PROVIDERS, 110, this.metric, view.from, "usage-days"))
          .child(h_flex().text_size(TYPE.xs).text_color(t.dim).child(div().flex_1().child(days[0]?.date ?? "")).child(div().child(days.at(-1)?.date ?? ""))))
        .child(this.table(t, "Models", [
          h_flex().gap(8).text_size(TYPE.xs).text_color(t.dim).child(div().flex_1().child("Model")).child(right(70, "Requests", t.dim)).child(right(70, "Input", t.dim)).child(right(70, "Output", t.dim)).child(right(80, "Cache read", t.dim)).child(right(80, "Cache write", t.dim)).child(right(80, "Total", t.dim)).child(right(80, "Cost", t.dim)),
          ...models.map(model => h_flex().id(`usage-model-${model.provider}-${model.model}`).gap(8).items_center().py(3)
            .child(h_flex().flex_1().min_w(0).gap(6).items_center().child(providerIcon(model.provider, 14).flex_none()).child(div().min_w(0).truncate().child(model.model)))
            .child(right(70, formatCount(model.requests))).child(right(70, formatTokens(model.tokens.input))).child(right(70, formatTokens(model.tokens.output))).child(right(80, formatTokens(model.tokens.cacheRead))).child(right(80, formatTokens(model.tokens.cacheWrite))).child(right(80, formatTokens(model.tokens.total)))
            .child(right(80, model.priced ? formatUsd(model.cost) : "Unpriced", model.priced ? t.foreground : t.ansi3))),
          ...(models.length ? [] : [div().text_color(t.dim).child("No model usage in this period.")]),
        ]))
        .child(this.table(t, "Projects", [
          ...view.projects.map(project => h_flex().id(`usage-project-${project.cwd}`).gap(8).items_center().py(3).tooltip(project.cwd)
            .child(div().w(190).flex_none().min_w(0).truncate().child(folderName(project.cwd)))
            .child(h_flex().flex_1().min_w(0).h(6).rounded(3).overflow_hidden().bg(t.raised)
              .children(TOKEN_PROVIDERS.filter(provider => project.providers[provider] > 0).map(provider => div().h_full().w(`${Math.max(0.5, project.providers[provider] / (maxProject || 1) * 100)}%`).bg(colors[provider]))))
            .child(right(80, `${formatCount(project.sessions)} sessions`)).child(right(70, formatTokens(project.tokens))).child(right(80, formatUsd(project.cost), t.foreground))),
          ...(view.projects.length ? [] : [div().text_color(t.dim).child("No project usage in this period.")]),
        ]))
        .child(this.table(t, "Largest sessions", [
          ...view.sessions.map(session => {
            const openable = session.store?.startsWith("/") && UUID.test(session.id ?? "");
            return h_flex().id(`usage-session-${session.provider}-${session.id}`).gap(8).items_center().p(6).rounded(6)
              .when(openable, el => el.cursor_pointer().hover(el => el.bg(t.hover)).on_click(() => this.openSession(session)))
              .tooltip(`${session.title}\n${session.cwd}\n${session.provider} ${session.id}${openable ? "\nClick to open its work timeline" : ""}`)
              .child(providerIcon(session.provider, 15).flex_none())
              .child(v_flex().flex_1().min_w(0).child(div().truncate().child(session.title))
                .child(div().truncate().text_size(TYPE.xs).text_color(t.dim).child(`${folderName(session.cwd)}${session.origin && session.origin !== "main" ? ` · ${session.origin}` : ""} · ${formatCount(session.requests)} requests`)))
              .child(right(70, formatTokens(session.tokens))).child(right(80, formatUsd(session.cost), t.foreground));
          }),
          ...(view.sessions.length ? [] : [div().text_color(t.dim).child("No sessions in this period.")]),
        ])))
      .child(this.footer(t));
  }
}
