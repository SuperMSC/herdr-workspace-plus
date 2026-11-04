import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { appHome, exec, spaces, panes, terminals, focused, theme, run, props, window, shared, setShared, openOverlay } from "herdr";
import { NAMES, PENDING, PROVIDERS, sessionRows, filterRows, launchCommand } from "./model.js";
import Rename from "./rename.js";
import Quota from "./quota.js";
import { providerIcon } from "./icons.js";

function location() {
  const focus = focused(), space = spaces().find(s => s.active);
  return { cwd: focus?.cwd || space?.folder || "", remote: Boolean(space?.machine) || Boolean(focus?.terminal?.includes("/")) };
}

export default class SessionsPlus extends View {
  init(p, cx) {
    this.p = props() ?? p ?? {};
    if (this.p.role === "rename") { this.rename = new Rename(); this.rename.init(this.p, cx); return; }
    this.history = []; this.warnings = []; this.error = ""; this.query = ""; this.provider = "all";
    this.all = false; this.visible = 60; this.loading = false; this.busy = new Set();
    this.page = "sessions";
    this.input = InputState.new({ placeholder: "Search sessions…" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.visible = 60; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(30000, cx => { if (this.page === "sessions") this.refresh(cx); else cx.notify(); });
    cx.timer.every(300000, cx => { if (this.page === "status") this.quota?.refresh(cx, true); });
  }

  async read(action = "scan", key = "") {
    const result = await exec(this.p.node || "node", [appHome() + "/mods/sessions-plus/history.mjs", action, JSON.stringify({ stores: this.p.stores ?? {} }), key]);
    let data;
    try { data = JSON.parse(result.stdout); } catch { throw new Error("Session history needs Node.js 22+ on PATH. Set the mod's node prop to its executable if needed."); }
    if (result.code || data.error) throw new Error(data.error || "Could not read session history.");
    return data;
  }

  refresh(cx) {
    if (this.loading || window()?.platform !== "macos") return;
    this.loading = true; cx.notify();
    cx.spawn(async cx => {
      try { const data = await this.read(); this.history = data.rows; this.warnings = data.warnings; this.limited = data.limited; this.error = ""; }
      catch (error) { this.error = String(error.message ?? error); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  rows() { return sessionRows(this.history, terminals(), panes(), shared(NAMES) ?? {}); }

  open(row, cx) {
    const current = this.rows().find(r => r.key === row.key && r.live);
    if (current) { run("agent.focus", { terminal: current.address }); return; }
    if (row.live) { this.error = "This running session has ended. Refresh to find its history."; cx.notify(); return; }
    const pending = shared(PENDING) ?? {}, now = Date.now();
    if (this.busy.has(row.key) || now - (pending[row.key] ?? 0) < 15000) return;
    this.busy.add(row.key); setShared(PENDING, { ...pending, [row.key]: now }); this.error = ""; cx.notify();
    cx.spawn(async cx => {
      let launched = false;
      try {
        const result = await this.read("validate", row.key);
        const active = this.rows().find(r => r.key === row.key && r.live);
        if (active) run("agent.focus", { terminal: active.address });
        else {
          const target = { ...result.row, title: shared(NAMES)?.[row.key] || row.title };
          const [command, args] = launchCommand(target, result.command, spaces());
          run(command, args); launched = true;
        }
      } catch (error) { this.error = String(error.message ?? error); }
      finally {
        this.busy.delete(row.key);
        const clear = () => { const latest = { ...(shared(PENDING) ?? {}) }; if (latest[row.key] === now) { delete latest[row.key]; setShared(PENDING, latest); } };
        if (launched) cx.timer.after(15000, cx => { clear(); cx.notify(); }); else clear();
        cx.notify();
      }
    });
  }

  renameRow(row) {
    openOverlay({ mod: "sessions-plus", kind: "dialog", modal: true, width: 420, height: 240,
      props: { role: "rename", target: { key: row.key, title: row.title } } });
  }

  render(cx) {
    if (this.rename) return this.rename.render(cx);
    const t = theme();
    const tab = (page, label) => div().id(`sessions-page-${page}`).px(10).py(6).rounded(5).cursor_pointer()
      .text_color(this.page === page ? t.foreground : t.muted).bg(this.page === page ? t.selected : t.surface)
      .on_click((_e, cx) => {
        this.page = page;
        if (page === "status" && !this.quota) { this.quota = new Quota(); this.quota.init(this.p, cx); }
        cx.notify();
      }).child(label);
    return v_flex().size_full().min_h(0).bg(t.surface).text_size(12)
      .child(h_flex().p(5).gap(4).flex_none().child(tab("sessions", "Sessions")).child(tab("status", "Status")))
      .child(div().flex_1().min_h(0).child(this.page === "status" ? this.quota.render(cx) : this.renderSessions(cx)));
  }

  renderSessions(cx) {
    const t = theme(), context = location(), rows = filterRows(this.rows(), { ...context, all: this.all, provider: this.provider, query: this.query });
    const smallButton = (id, label, callback) => div().id(id).px(6).py(3).rounded(5).cursor_pointer().text_color(t.muted).hover(el => el.bg(t.hover)).on_click(callback).child(label);
    const rowView = row => {
      const pending = this.busy.has(row.key) || (!row.live && Date.now() - (shared(PENDING)?.[row.key] ?? 0) < 15000);
      const subtitle = `${PROVIDERS[row.provider] ?? "Agent"} · ${row.live ? row.status : "History"}${row.remote ? " · Remote" : ""}`;
      return v_flex().id(`session-${row.key}`).px(9).py(7).gap(3).rounded(7).bg(row.focused ? t.selected : t.surface)
        .hover(el => el.bg(t.hover)).cursor_pointer().on_click((_e, cx) => this.open(row, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.renameRow(row); })
        .child(h_flex().gap(6).items_center()
          .child(div().size(6).rounded(3).flex_none().bg(row.live ? t[row.status] || t.accent : t.dim))
          .child(providerIcon(row.provider, 17))
          .child(div().flex_1().min_w(0).truncate().child(row.title))
          .child(smallButton(`session-name-${row.key}`, "⋯", (_e, cx) => { cx.stop_propagation(); this.renameRow(row); })))
        .child(h_flex().gap(6).justify_between().text_size(11).text_color(t.muted)
          .child(div().truncate().child(subtitle)).child(div().flex_none().text_color(t.accent).child(pending ? "Opening…" : row.live ? "Switch →" : "Resume →")))
        .when(this.all, el => el.child(div().text_size(10.5).text_color(t.dim).truncate().child(row.cwd)));
    };
    return v_flex().id("sessions-plus").size_full().min_h(0).bg(t.surface).text_color(t.foreground).text_size(12.5)
      .child(h_flex().h(34).px(10).gap(5).items_center().flex_none()
        .child(div().font_semibold().child("Sessions")).child(div().flex_1().text_size(11).text_color(t.dim).child(String(rows.length)))
        .child(smallButton("sessions-refresh", this.loading ? "Loading…" : "Refresh", (_e, cx) => this.refresh(cx))))
      .child(h_flex().px(9).pb(7).gap(5).flex_none()
        .child(smallButton("sessions-scope", this.all ? "All folders" : "This folder", (_e, cx) => { this.all = !this.all; this.visible = 60; cx.notify(); }))
        .child(smallButton("sessions-provider", this.provider === "all" ? "All agents" : PROVIDERS[this.provider], (_e, cx) => { const keys = ["all", ...Object.keys(PROVIDERS)]; this.provider = keys[(keys.indexOf(this.provider) + 1) % keys.length]; cx.notify(); })))
      .child(div().mx(10).mb(8).px(8).h(29).flex_none().border_1().border_color(t.border).rounded(6).child(Input.new(this.input).w_full().h_full()))
      .child(v_flex().id("sessions-list").flex_1().min_h(0).px(6).gap(3).overflow_y_scrollbar()
        .children(rows.slice(0, this.visible).map(rowView))
        .when(!rows.length, el => el.child(div().p(12).text_color(t.muted).child(this.loading ? "Reading local session history…" : context.remote && !this.all ? "Choose All folders for local history and remote live sessions." : "No sessions here. Try All folders or another search.")))
        .when(rows.length > this.visible, el => el.child(smallButton("sessions-more", "Show more", (_e, cx) => { this.visible += 60; cx.notify(); }))))
      .when(Boolean(this.error), el => el.child(div().p(9).max_h(70).overflow_y_scrollbar().text_size(11).text_color(t.ansi1).child(this.error)))
      .when(this.warnings.length > 0 || this.limited, el => el.child(div().p(9).max_h(55).overflow_y_scrollbar().text_size(10.5).text_color(t.muted).child([...this.warnings, ...(this.limited ? ["Showing recent history; scan limit reached."] : [])].join(" "))))
      .child(div().px(10).py(6).flex_none().text_size(10.5).text_color(t.dim).child(window()?.platform === "macos" ? "Local history · Right-click to rename" : "Live sessions · Local history requires macOS"));
  }
}
