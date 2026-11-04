import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Popover } from "gpui-base";
import { appHome, exec, spaces, panes, terminals, focused, theme, run, props, window, shared, setShared, openOverlay } from "herdr";
import { NAMES, PENDING, OPERATIONS, CHANGE_KEY, OPERATION_TTL, operationPending, PROVIDERS, sessionRows, filterRows, launchCommand } from "./model.js";
import Rename from "./rename.js";
import Quota from "./quota.js";
import Toolbar from "./toolbar.js";
import StatusBar from "./statusbar.js";
import Footer from "./footer.js";
import Actions from "./actions.js";
import TrashDialog from "./trash-dialog.js";
import { createTrashClient } from "./trash-client.js";
import { providerIcon } from "./icons.js";

function location() {
  const focus = focused(), space = spaces().find(s => s.active);
  return { cwd: focus?.cwd || space?.folder || "", remote: Boolean(space?.machine) || Boolean(focus?.terminal?.includes("/")) };
}

export default class SessionsPlus extends View {
  init(p, cx) {
    this.p = props() ?? p ?? {};
    const Role = this.p.role === "rename" ? Rename : this.p.role === "actions" ? Actions : this.p.role === "trash-dialog" ? TrashDialog : this.p.role === "toolbar" ? Toolbar : this.p.role === "statusbar" ? StatusBar : this.p.role === "footer" ? Footer : null;
    if (Role) { this.role = new Role(); this.role.init(this.p, cx); return; }
    this.history = []; this.warnings = []; this.error = ""; this.query = ""; this.provider = "all";
    this.all = false; this.visible = 60; this.loading = false; this.busy = new Set();
    this.page = "sessions"; this.filterMenu = null; this.filterIndex = 0;
    this.showingTrash = false; this.trashEntries = []; this.trashError = ""; this.trashLoading = false;
    this.revision = shared(CHANGE_KEY) ?? 0;
    this.trashRead = createTrashClient(exec, this.p, appHome());
    this.input = InputState.new({ placeholder: "Search sessions…" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.visible = 60; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(30000, cx => { if (this.page === "sessions") { this.refresh(cx); if (this.showingTrash) this.refreshTrash(cx); } else cx.notify(); });
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
      finally { this.loading = false; if (this.refreshQueued) { this.refreshQueued = false; this.refresh(cx); } cx.notify(); }
    });
  }

  refreshTrash(cx) {
    if (this.trashLoading || window()?.platform !== "macos") return;
    this.trashLoading = true; this.trashError = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        const data = await this.trashRead("list");
        if (!Array.isArray(data.entries)) throw new Error("Session Trash returned an invalid list. Try again.");
        this.trashEntries = data.entries;
      }
      catch (error) { this.trashError = String(error.message ?? error); }
      finally { this.trashLoading = false; if (this.trashRefreshQueued) { this.trashRefreshQueued = false; this.refreshTrash(cx); } cx.notify(); }
    });
  }

  consumeChange(cx) {
    const revision = shared(CHANGE_KEY) ?? 0;
    if (revision === this.revision) return;
    this.revision = revision;
    if (this.loading) this.refreshQueued = true;
    else this.refresh(cx);
    if (this.showingTrash) {
      if (this.trashLoading) this.trashRefreshQueued = true;
      else this.refreshTrash(cx);
    }
  }

  rows() { return sessionRows(this.history, terminals(), panes(), shared(NAMES) ?? {}); }

  open(row, cx) {
    const current = this.rows().find(r => r.key === row.key && r.live);
    if (current) { run("agent.focus", { terminal: current.address }); return; }
    if (row.live) { this.error = "This running session has ended. Refresh to find its history."; cx.notify(); return; }
    const pending = shared(PENDING) ?? {}, now = Date.now();
    if (operationPending(shared(OPERATIONS), row.key, now)) { this.error = "Another operation is using this session. Try again when it finishes."; cx.notify(); return; }
    if (this.busy.has(row.key) || now - (pending[row.key] ?? 0) < 15000) return;
    const stamp = `${now}-${Math.random()}`;
    setShared(OPERATIONS, { ...(shared(OPERATIONS) ?? {}), [row.key]: { stamp, expires: now + OPERATION_TTL, action: "resume" } });
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
        const operations = { ...(shared(OPERATIONS) ?? {}) };
        if (operations[row.key]?.stamp === stamp) { delete operations[row.key]; setShared(OPERATIONS, operations); }
        const clear = () => { const latest = { ...(shared(PENDING) ?? {}) }; if (latest[row.key] === now) { delete latest[row.key]; setShared(PENDING, latest); } };
        if (launched) cx.timer.after(15000, cx => { clear(); cx.notify(); }); else clear();
        cx.notify();
      }
    });
  }

  actionsRow(row) {
    openOverlay({ mod: "sessions-plus", kind: "popup", width: 260, height: 170,
      props: { role: "actions", target: { ...row }, node: this.p.node, stores: this.p.stores } });
  }

  restoreRow(row) {
    if (row.restorable !== true) return;
    openOverlay({ mod: "sessions-plus", kind: "dialog", modal: true, width: 500, height: 390,
      props: { role: "trash-dialog", action: "restore", target: { ...row }, node: this.p.node, stores: this.p.stores } });
  }

  render(cx) {
    if (this.role) return this.role.render(cx);
    this.consumeChange(cx);
    if (this.p.role === "sessions") return this.renderSessions(cx);
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

  filterDropdown(id, value, options, choose) {
    const t = theme(), open = this.filterMenu === id;
    const current = options.find(option => option.value === value) ?? options[0];
    const select = (option, cx) => {
      cx.stop_propagation();
      choose(option.value);
      this.visible = 60;
      this.filterMenu = null;
      cx.notify();
    };
    const trigger = h_flex().id(id).h(28).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.border)
      .bg(open ? t.selected : t.surface).text_color(t.foreground).cursor_pointer().hover(el => el.bg(t.hover))
      .when(Boolean(current.provider), el => el.child(providerIcon(current.provider, 15)))
      .child(div().child(current.label)).child(div().text_size(10).text_color(t.dim).child("▾"));
    const content = v_flex().id(`${id}-menu`).w(190).p(5).gap(2).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .text_size(12).text_color(t.foreground)
      .on_key_down((event, cx) => {
        const key = String(event.key ?? "").toLowerCase();
        if (["up", "arrowup", "down", "arrowdown"].includes(key)) {
          cx.stop_propagation();
          this.filterIndex = (this.filterIndex + (key === "up" || key === "arrowup" ? -1 : 1) + options.length) % options.length;
          cx.notify();
        } else if (key === "enter") select(options[this.filterIndex] ?? current, cx);
      })
      .children(options.map((option, index) => h_flex().id(`${id}-option-${option.value}`).h(31).px(8).gap(7).items_center().rounded(5)
        .bg(open && this.filterIndex === index ? t.selected : t.surface).cursor_pointer().hover(el => el.bg(t.hover))
        .on_click((_event, cx) => select(option, cx))
        .child(div().w(14).text_color(t.accent).child(option.value === value ? "✓" : ""))
        .when(Boolean(option.provider), el => el.child(providerIcon(option.provider, 16)))
        .child(div().flex_1().child(option.label))));
    return Popover.new(`${id}-popover`).open(open).anchor("top_left")
      .on_open_change((open, cx) => {
        if (open) { this.filterMenu = id; this.filterIndex = Math.max(0, options.findIndex(option => option.value === value)); }
        else if (this.filterMenu === id) this.filterMenu = null;
        cx.notify();
      }).trigger(trigger).content(content);
  }

  renderSessions(cx) {
    if (this.showingTrash) return this.renderTrash(cx);
    const t = theme(), context = location(), rows = filterRows(this.rows(), { ...context, all: this.all, provider: this.provider, query: this.query });
    const smallButton = (id, label, callback) => div().id(id).px(6).py(3).rounded(5).cursor_pointer().text_color(t.muted).hover(el => el.bg(t.hover)).on_click(callback).child(label);
    const rowView = row => {
      const pending = this.busy.has(row.key) || (!row.live && Date.now() - (shared(PENDING)?.[row.key] ?? 0) < 15000);
      const subtitle = `${PROVIDERS[row.provider] ?? "Agent"} · ${row.live ? row.status : "History"}${row.remote ? " · Remote" : ""}`;
      return v_flex().id(`session-${row.key}`).px(9).py(7).gap(3).rounded(7).bg(row.focused ? t.selected : t.surface)
        .hover(el => el.bg(t.hover)).cursor_pointer().on_click((_e, cx) => this.open(row, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.actionsRow(row); })
        .child(h_flex().gap(6).items_center()
          .child(div().size(6).rounded(3).flex_none().bg(row.live ? t[row.status] || t.accent : t.dim))
          .child(providerIcon(row.provider, 17))
          .child(div().flex_1().min_w(0).truncate().child(row.title))
          .child(smallButton(`session-name-${row.key}`, "⋯", (_e, cx) => { cx.stop_propagation(); this.actionsRow(row); })))
        .child(h_flex().gap(6).justify_between().text_size(11).text_color(t.muted)
          .child(div().truncate().child(subtitle)).child(div().flex_none().text_color(t.accent).child(pending ? "Opening…" : row.live ? "Switch →" : "Resume →")))
        .when(this.all, el => el.child(div().text_size(10.5).text_color(t.dim).truncate().child(row.cwd)));
    };
    return v_flex().id("sessions-plus").size_full().min_h(0).bg(t.surface).text_color(t.foreground).text_size(12.5)
      .child(h_flex().h(34).px(10).gap(5).items_center().flex_none()
        .child(div().font_semibold().child("Sessions")).child(div().flex_1().text_size(11).text_color(t.dim).child(String(rows.length)))
        .when(window()?.platform === "macos", el => el.child(smallButton("sessions-trash", "Trash", (_e, cx) => { this.showingTrash = true; this.refreshTrash(cx); cx.notify(); })))
        .child(smallButton("sessions-refresh", this.loading ? "Loading…" : "Refresh", (_e, cx) => this.refresh(cx))))
      .child(h_flex().px(9).pb(7).gap(6).flex_none()
        .child(this.filterDropdown("sessions-scope", this.all ? "all" : "current", [
          { value: "current", label: "This folder" }, { value: "all", label: "All folders" },
        ], value => { this.all = value === "all"; }))
        .child(this.filterDropdown("sessions-provider", this.provider, [
          { value: "all", label: "All agents" }, ...Object.entries(PROVIDERS).map(([value, label]) => ({ value, label, provider: value })),
        ], value => { this.provider = value; })))
      .child(div().mx(10).mb(8).px(8).h(29).flex_none().border_1().border_color(t.border).rounded(6).child(Input.new(this.input).w_full().h_full()))
      .child(v_flex().id("sessions-list").flex_1().min_h(0).px(6).gap(3).overflow_y_scrollbar()
        .children(rows.slice(0, this.visible).map(rowView))
        .when(!rows.length, el => el.child(div().p(12).text_color(t.muted).child(this.loading ? "Reading local session history…" : context.remote && !this.all ? "Choose All folders for local history and remote live sessions." : "No sessions here. Try All folders or another search.")))
        .when(rows.length > this.visible, el => el.child(smallButton("sessions-more", "Show more", (_e, cx) => { this.visible += 60; cx.notify(); }))))
      .when(Boolean(this.error), el => el.child(div().p(9).max_h(70).overflow_y_scrollbar().text_size(11).text_color(t.ansi1).child(this.error)))
      .when(this.warnings.length > 0 || this.limited, el => el.child(div().p(9).max_h(55).overflow_y_scrollbar().text_size(10.5).text_color(t.muted).child([...this.warnings, ...(this.limited ? ["Showing recent history; scan limit reached."] : [])].join(" "))))
      .child(div().px(10).py(6).flex_none().text_size(10.5).text_color(t.dim).child(window()?.platform === "macos" ? "Local history · Right-click for session actions" : "Live sessions · Local history requires macOS"));
  }

  renderTrash() {
    const t = theme();
    const button = (id, label, callback) => div().id(id).px(7).py(5).rounded(5).cursor_pointer().text_color(t.muted).hover(el => el.bg(t.hover)).on_click(callback).child(label);
    return v_flex().id("sessions-trash-view").size_full().min_h(0).bg(t.surface).text_color(t.foreground).text_size(12.5)
      .child(h_flex().px(8).py(5).gap(5).items_center().flex_none()
        .child(button("sessions-trash-back", "← Sessions", (_event, cx) => { this.showingTrash = false; cx.notify(); }))
        .child(div().flex_1().font_semibold().child("Trash"))
        .child(button("sessions-trash-refresh", this.trashLoading ? "Loading…" : this.trashError ? "Retry" : "Refresh", (_event, cx) => this.refreshTrash(cx))))
      .child(v_flex().id("sessions-trash-list").flex_1().min_h(0).px(8).gap(5).overflow_y_scrollbar()
        .children(this.trashEntries.map(row => v_flex().id(`session-trash-${row.token}`).px(9).py(8).gap(5).rounded(7).bg(t.raised)
          .child(div().truncate().child(shared(NAMES)?.[row.key] || row.title || row.id))
          .child(h_flex().gap(5).items_center()
            .child(providerIcon(row.provider, 17))
            .child(div().flex_1().text_size(11).text_color(t.muted).child(`${PROVIDERS[row.provider] ?? row.provider} · ${new Date(row.trashedAt).toLocaleString()}`))
            .child(row.restorable === true ? button(`session-restore-${row.token}`, "Restore…", () => this.restoreRow(row)) : div().px(7).py(5).text_color(t.dim).child("Unavailable")))
          .when(Boolean(row.message) || row.restorable !== true || row.status === "recovery", el => el.child(div().text_size(11).text_color(t.muted)
            .child(row.message || (row.location === "missing" ? "Session files are no longer in Trash." : row.restorable !== true ? "This session cannot currently be restored." : "An interrupted operation needs recovery. Restore will recover the remaining files."))))))
        .when(!this.trashEntries.length, el => el.child(div().p(12).text_color(t.muted).child(this.trashLoading ? "Reading Session Trash…" : this.trashError ? "Could not read Session Trash. Try again." : "No sessions in Trash."))))
      .when(Boolean(this.trashError), el => el.child(div().p(10).max_h(80).overflow_y_scrollbar().text_color(t.ansi1).child(this.trashError)))
      .child(div().px(10).py(8).text_size(10.5).text_color(t.dim).child("Only sessions moved by Sessions Plus appear here. Emptying the macOS Trash removes their history permanently."));
  }
}
