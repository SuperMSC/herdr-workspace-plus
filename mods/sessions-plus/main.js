import { TYPE } from "./type-scale.js";
import { privacyGuard } from "./privacy.js";
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Popover } from "gpui-base";
import { appHome, checking, exec, spaces, panes, terminals, agents, machines, focused, theme, run, props, window, settings, shared, setShared, openOverlay, layout } from "herdr";
import { NAMES, PENDING, OPERATIONS, CHANGE_KEY, OPERATION_TTL, LIVE_KEY, FORK_REQUEST, TERMINAL_SESSIONS_KEY, interruptedSessions, canFork, operationPending, PROVIDERS, ORIGINS, historyGroup, historyTime, sessionRows, filterRows, launchCommand, liveIdentity, sessionKey } from "./model.js";
import { currentInterruption, interruptionTitle, localLayoutReady, sameSession } from "./live-model.js";
import Rename from "./rename.js";
import Quota from "./quota.js";
import Toolbar from "./toolbar.js";
import StatusBar from "./statusbar.js";
import Footer from "./footer.js";
import SidebarFooter from "./sidebar-footer.js";
import Actions from "./actions.js";
import TrashDialog from "./trash-dialog.js";
import Preview from "./preview.js";
import PromptQueue from "./prompt-queue.js";
import Notes from "./notes.js";
import Commands from "./commands.js";
import WorkspacePresets from "./presets.js";
import WorkspaceTools from "./tools.js";
import Timeline from "./timeline.js";
import SessionGallery from "./gallery.js";
import Deliverables from "./deliverables.js";
import ScreenPicker from "./screen-picker.js";
import LiveAgents from "./live-agents.js";
import Launcher from "./launcher.js";
import GitOverview from "./git-overview.js";
import UsageStats from "./usage-stats.js";
import { promptTargets } from "./prompt-queue-model.js";
import { createTrashClient } from "./trash-client.js";
import { providerIcon } from "./icons.js";
import { projectContext } from "./project-context.js";
import { reconcileZen, zenFooter } from "./zen-model.js";

function location() {
  const context = projectContext();
  return { cwd: context.cwd || "", on: context.on ?? null, remote: Boolean(context.on) };
}

export default class SessionsPlus extends View {
  init(p, cx) {
    this.p = props() ?? p ?? {};
    const Role = this.p.role === "sidebar-footer" ? SidebarFooter : this.p.role === "live-agents" ? LiveAgents : this.p.role === "launcher" ? Launcher : this.p.role === "git-overview" ? GitOverview : this.p.role === "usage-stats" ? UsageStats : this.p.role === "timeline" ? Timeline : this.p.role === "gallery" ? SessionGallery : this.p.role === "deliverables" ? Deliverables : this.p.role === "screen-picker" ? ScreenPicker : this.p.role === "tools" ? WorkspaceTools : this.p.role === "presets" ? WorkspacePresets : this.p.role === "notes" ? Notes : this.p.role === "commands" ? Commands : this.p.role === "prompt-queue" ? PromptQueue : this.p.role === "preview" ? Preview : this.p.role === "rename" ? Rename : this.p.role === "actions" ? Actions : this.p.role === "trash-dialog" ? TrashDialog : this.p.role === "toolbar" ? Toolbar : this.p.role === "statusbar" ? StatusBar : this.p.role === "footer" ? Footer : null;
    if (Role) {
      this.role = new Role();
      if (this.p.role === "launcher") {
        this.role.resumeInterrupted = (entry, cx, finished) => this.resumeInterrupted([entry], cx, { finished });
        this.role.zenLayout = () => zenFooter(layout()) ? shared("layout") : null;
      }
      this.role.init(this.p, cx); return;
    }
    this.history = []; this.warnings = []; this.error = ""; this.query = ""; this.provider = "all"; this.source = "all";
    this.all = false; this.visible = 60; this.loading = false; this.busy = new Set();
    this.page = "sessions"; this.filterMenu = null; this.filterIndex = 0; this.panelMenu = null; this.toolIndex = 0;
    this.showingTrash = false; this.trashEntries = []; this.trashError = ""; this.trashLoading = false;
    this.revision = shared(CHANGE_KEY) ?? 0;
    this.trashRead = createTrashClient(exec, this.p, appHome());
    this.input = InputState.new({ placeholder: "Search sessions…" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.visible = 60; cx.notify(); });
    this.refresh(cx);
    if (!checking()) cx.timer.every(30000, cx => { if (this.page === "sessions") { this.refresh(cx); if (this.showingTrash) this.refreshTrash(cx); } else cx.notify(); });
    if (!checking()) cx.timer.every(300000, cx => { if (this.page === "status") this.quota?.refresh(cx, true); });
  }

  async read(action = "scan", key = "", stores = this.p.stores ?? {}, liveKeys) {
    const result = await exec(this.p.node || "node", [appHome() + "/mods/sessions-plus/history.mjs", action, JSON.stringify({ stores, liveKeys }), key], action === "search" ? { timeout: 11000 } : undefined);
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
    if (revision === this.revision || this.changeScheduled) return;
    this.changeScheduled = true;
    // Rendering cannot notify. Defer work to a task context after this frame.
    cx.timer.after(0, cx => {
      this.changeScheduled = false;
      const latest = shared(CHANGE_KEY) ?? 0;
      if (latest === this.revision) return;
      this.revision = latest;
      if (this.loading) this.refreshQueued = true;
      else this.refresh(cx);
      if (this.showingTrash) {
        if (this.trashLoading) this.trashRefreshQueued = true;
        else this.refreshTrash(cx);
      }
    });
  }

  scheduleZen(cx) {
    if (!cx.timer?.after || this.zenScheduled || !shared("layout")) return;
    this.zenScheduled = true;
    cx.timer.after(0, () => {
      this.zenScheduled = false;
      if (!this.closed) reconcileZen({ checking, layout, shared, setShared, run });
    });
  }

  rows() { return sessionRows(this.history, terminals(), panes(), shared(NAMES) ?? {}, shared(LIVE_KEY)); }

  open(row, cx, options = {}) {
    const launch = this.prepareLaunch(row, cx, options);
    if (launch) cx.spawn(cx => this.launchSession(launch, cx));
  }

  prepareLaunch(row, cx, { fork = false, recovery = null, background = false } = {}) {
    if (recovery) {
      if (!currentInterruption(shared(TERMINAL_SESSIONS_KEY), recovery) || !localLayoutReady(machines())) {
        this.error = "The interrupted session or local layout is unavailable."; cx.notify(); return;
      }
    } else if (fork) {
      if (!canFork(row)) { this.error = "Choose an exact local Claude Code or Codex session to fork."; cx.notify(); return; }
    } else {
      const current = this.rows().find(r => r.key === row.key && r.live);
      if (current) { run("agent.focus", { terminal: current.address }); return; }
      if (row.live) { this.error = "This running session has ended. Refresh to find its history."; cx.notify(); return; }
    }
    const pending = shared(PENDING) ?? {}, now = Date.now();
    if (operationPending(shared(OPERATIONS), row.key, now)) { this.error = "Another operation is using this session. Try again when it finishes."; cx.notify(); return; }
    if (this.busy.has(row.key) || now - (pending[row.key] ?? 0) < 15000) {
      if (recovery) { this.error = "This session is already opening."; cx.notify(); }
      return;
    }
    const stamp = `${now}-${Math.random()}`;
    setShared(OPERATIONS, { ...(shared(OPERATIONS) ?? {}), [row.key]: { stamp, expires: now + OPERATION_TTL, action: fork ? "fork" : "resume" } });
    this.busy.add(row.key); setShared(PENDING, { ...pending, [row.key]: now }); this.error = ""; cx.notify();
    return { row, fork, recovery, background, now, stamp };
  }

  async launchSession({ row, fork, recovery, background, now, stamp }, cx) {
    let launched = false;
    try {
      const stores = fork || recovery ? { ...this.p.stores, [row.provider]: row.store } : undefined;
      const result = await this.read("validate", row.key, stores);
      if (fork && (!canFork(result.row) || result.row.key !== row.key)) throw new Error("The source session identity could not be verified.");
      if (recovery) {
        if (this.closed || !currentInterruption(shared(TERMINAL_SESSIONS_KEY), recovery) || !localLayoutReady(machines())) throw new Error("The interrupted session or local layout changed.");
        if (result.row.ambiguous || result.row.key !== row.key || !sameSession(result.row, recovery)) throw new Error("The original session identity could not be verified.");
        const identities = shared(LIVE_KEY), foreground = terminals().filter(item => item.foreground?.argv?.length || liveIdentity(item, identities)?.provider === "claude");
        if (sessionRows([result.row], foreground, panes(), {}, identities).some(item => item.live && item.key === row.key)) throw new Error("This session is already running.");
      }
      const active = !fork && !recovery && this.rows().find(r => r.key === row.key && r.live);
      if (active) run("agent.focus", { terminal: active.address });
      else {
        const target = { ...result.row, title: shared(NAMES)?.[row.key] || (recovery ? result.row.title : row.title) }, localSpaces = spaces();
        let [command, args] = launchCommand(target, result.command, localSpaces, { fork });
        const preferred = recovery && localSpaces.find(space => space.machine == null && !space.id.includes("/") && space.id === recovery.space);
        if (preferred) {
          command = "tab.new";
          args = { name: args.name ?? args.tab, folder: args.folder, argv: args.argv, space: preferred.id };
        }
        if (background) args.focus = false;
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
    return launched;
  }

  resumeInterrupted(entries, cx, { background = false, finished } = {}) {
    if (this.restoring || !entries.length) return;
    this.busy ??= new Set();
    this.restoring = true; cx.notify();
    const captured = entries.map(entry => ({ ...entry })), errors = [];
    cx.spawn(async cx => {
      let opened = 0;
      try {
        for (const recovery of captured) {
          if (this.closed) break;
          const row = { ...recovery, key: sessionKey(recovery) };
          const launch = this.prepareLaunch(row, cx, { recovery, background });
          if (launch && await this.launchSession(launch, cx)) opened++;
          else errors.push(this.error);
        }
      } finally {
        this.restoring = false;
        if (!this.closed) {
          this.error = errors.length ? opened ? `${opened} resume requests sent. ${errors[0]}` : errors[0] : "";
          finished?.(opened === captured.length, this.error, cx);
          if (!this.closed) cx.notify();
        }
      }
    });
  }

  dismissInterrupted(entries, cx) {
    const registry = { ...(shared(TERMINAL_SESSIONS_KEY) ?? {}) };
    let changed = false;
    for (const entry of entries) if (currentInterruption(registry, entry)) { delete registry[entry.key]; changed = true; }
    if (changed) setShared(TERMINAL_SESSIONS_KEY, registry);
    cx.notify();
  }

  consumeFork(cx) {
    const target = this.forkTarget;
    if (!target || this.forkScheduled || shared(FORK_REQUEST) !== target.token) return;
    this.forkScheduled = true;
    cx.timer.after(0, cx => {
      this.forkScheduled = false;
      if (this.closed || this.forkTarget !== target || shared(FORK_REQUEST) !== target.token) return;
      this.forkTarget = null;
      setShared(FORK_REQUEST, null);
      this.open(target.row, cx, { fork: true });
    });
  }

  transcriptSearch(rows, context, cx) {
    const query = this.query.trim();
    if (query.length > 512 || [...query].length < 3 || window()?.platform !== "macos") { this.transcriptRequest = null; return null; }
    const keys = [], liveKeys = [], seen = new Set();
    let budget = 100000, limited = false;
    for (const row of rows) {
      if (!canFork(row) || seen.has(row.key)) continue;
      seen.add(row.key);
      if (limited) continue;
      budget -= JSON.stringify(row.key).length * 3 + 1;
      if (budget < 0) { limited = true; continue; }
      keys.push(row.key);
      if (row.live) liveKeys.push(row.key);
    }
    if (!keys.length) { this.transcriptRequest = null; return null; }
    const scope = JSON.stringify([this.all, this.provider, this.source, this.all ? null : context.cwd, this.all ? null : context.on]);
    const signature = JSON.stringify([query, scope, [...seen].sort()]);
    if (this.transcriptRequest?.signature === signature) return this.transcriptRequest.result;
    // Request identity is also the generation. A later render or input change supersedes it.
    const request = { signature, query, keys, liveKeys, limited, ready: false, result: null };
    this.transcriptRequest = request;
    cx.timer.after(600, cx => {
      if (this.closed || this.transcriptRequest !== request) return;
      request.ready = true; this.startTranscriptSearch(cx);
    });
    return null;
  }

  startTranscriptSearch(cx) {
    const request = this.transcriptRequest;
    if (this.transcriptPending || this.closed || !request?.ready) return;
    request.ready = false;
    this.transcriptPending = true;
    cx.spawn(async cx => {
      let result;
      try {
        const data = await this.read("search", JSON.stringify({ query: request.query, keys: request.keys }), undefined, request.liveKeys);
        const inScope = new Set(request.keys);
        result = { hits: new Set((Array.isArray(data.hits) ? data.hits : []).slice(0, 50).filter(key => inScope.has(key))), partial: request.limited || data.partial === true };
      } catch { result = { hits: new Set(), partial: true }; }
      finally { this.transcriptPending = false; }
      if (this.closed) return;
      if (this.transcriptRequest === request) { request.result = result; cx.notify(); }
      this.startTranscriptSearch(cx);
    });
  }

  openPrompts(row = null) {
    const focus = focused(), address = row?.address || focus?.shown || focus?.agent || focus?.terminal;
    const target = promptTargets(agents(), terminals(), panes()).find(target => target.address === address) || null;
    openOverlay({ mod: "sessions-plus", kind: "dialog", width: 660, height: 650,
      props: { role: "prompt-queue", target } });
  }

  openNotes(row = null) {
    const current = location(), on = row ? row.remote && row.address?.includes("/") ? row.address.slice(0, row.address.lastIndexOf("/")) : null : current.on;
    openOverlay({ mod: "sessions-plus", kind: "dialog", width: 800, height: 680,
      props: { role: "notes", project: { root: row?.cwd || current.cwd, on }, session: row || undefined, initial: row ? "session" : "project" } });
  }
  openCommands() {
    const current = location();
    openOverlay({ mod: "sessions-plus", kind: "dialog", width: 820, height: 680, props: { role: "commands", context: { root: current.cwd, on: current.on } } });
  }

  openWorkspaceTool(role) {
    if (!["presets", "tools"].includes(role)) return;
    const current = location(), viewport = globalThis.window.viewport_size();
    const zoom = Number(settings().zoom) || 1;
    const focus = focused(), address = focus?.shown || focus?.agent || focus?.terminal;
    const live = terminals().find(item => item.address === address && item.state === "live");
    const target = live ? { ...live, on: live.address.includes("/") ? live.address.slice(0, live.address.lastIndexOf("/")) : null } : null;
    openOverlay({ mod: "sessions-plus", kind: "dialog", width: Math.min(940, viewport.width / zoom * .93), height: Math.min(role === "presets" ? 780 : 730, viewport.height / zoom * .9), props: { role, context: { root: current.cwd, on: current.on }, target, node: this.p?.node, stores: this.p?.stores } });
  }

  actionsRow(row) {
    const on = row.remote && row.address?.includes("/") ? row.address.slice(0, row.address.lastIndexOf("/")) : null;
    const promptTarget = row.live ? promptTargets(agents(), terminals(), panes()).find(target => target.address === row.address && target.created === row.updated) : null;
    const forkToken = canFork(row) ? `${Date.now()}-${Math.random()}` : null;
    this.forkTarget = forkToken ? { token: forkToken, row: { ...row } } : null;
    openOverlay({ mod: "sessions-plus", kind: "popup", width: 230, height: 390,
      props: { role: "actions", target: { ...row }, project: { root: row.cwd, on }, promptTarget: promptTarget || null, forkToken, node: this.p.node, stores: this.p.stores } });
  }

  restoreRow(row) {
    if (row.restorable !== true) return;
    openOverlay({ mod: "sessions-plus", kind: "dialog", width: 460, height: 250,
      props: { role: "trash-dialog", action: "restore", target: { ...row }, node: this.p.node, stores: this.p.stores } });
  }

  render(cx) {
    this.scheduleZen(cx);
    const mask = privacyGuard("Sessions", this.p); if (mask) { this.transcriptRequest = null; return mask; }
    if (this.role) return this.role.render(cx);
    this.consumeChange(cx);
    this.consumeFork(cx);
    if (this.p.role === "sessions") {
      const content = this.renderSessions(cx);
      return Number.isFinite(this.p.panelRadius) ? content.rounded(this.p.panelRadius).overflow_hidden() : content;
    }
    if (this.page !== "sessions") this.transcriptRequest = null;
    const t = theme();
    const tab = (page, label) => div().id(`sessions-page-${page}`).px(10).py(6).rounded(5).cursor_pointer()
      .text_color(this.page === page ? t.foreground : t.muted).bg(this.page === page ? t.selected : t.surface)
      .on_click((_e, cx) => {
        this.page = page;
        if (page === "status" && !this.quota) { this.quota = new Quota(); this.quota.init(this.p, cx); }
        cx.notify();
      }).child(label);
    return v_flex().size_full().min_h(0).bg(t.surface).text_size(TYPE.md)
      .child(h_flex().p(5).gap(4).flex_none().child(tab("sessions", "Sessions")).child(tab("status", "Status")))
      .child(div().flex_1().min_h(0).child(this.page === "status" ? this.quota.render(cx) : this.renderSessions(cx)));
  }

  filterDropdown(id, value, options, choose, plain = false) {
    const t = theme(), open = this.filterMenu === id;
    const current = options.find(option => option.value === value) ?? options[0];
    const select = (option, cx) => {
      cx.stop_propagation();
      choose(option.value);
      this.visible = 60;
      this.filterMenu = null;
      cx.notify();
    };
    const trigger = h_flex().id(id).w_full().min_w(0).h(plain ? 24 : 28).px(plain ? 4 : 7).gap(4).items_center().rounded(4)
      .when(!plain, el => el.border_1().border_color(t.border).bg(t.surface)).when(open, el => el.bg(t.selected)).text_color(t.foreground).cursor_pointer().hover(el => el.bg(t.hover))
      .when(Boolean(current.provider), el => el.child(providerIcon(current.provider, 15)))
      .tooltip(current.label).accessibility_label(current.label)
      .child(div().flex_1().min_w(0).truncate().child(current.label)).child(div().flex_none().text_size(TYPE.xs).text_color(t.dim).child("▾"));
    const content = v_flex().id(`${id}-menu`).w(190).p(5).gap(2).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .text_size(TYPE.md).text_color(t.foreground)
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
    return div().flex_1().min_w(0).child(Popover.new(`${id}-popover`).open(open).anchor("top_left")
      .on_open_change((open, cx) => {
        if (open) { this.filterMenu = id; this.filterIndex = Math.max(0, options.findIndex(option => option.value === value)); }
        else if (this.filterMenu === id) this.filterMenu = null;
        cx.notify();
      }).trigger(trigger).content(content));
  }

  toolbarPopover(id, title, glyph, content, active = false) {
    const t = theme(), open = this.panelMenu === id;
    const trigger = div().id(id).size(24).p(0).rounded(4).flex_none().flex().items_center().justify_center()
      .text_color(open || active ? t.accent : t.muted).cursor_pointer().hover(el => el.bg(t.hover).text_color(t.foreground))
      .tooltip(title).accessibility_label(title).child(svg(glyph).size(14).flex_none());
    return div().flex_none().child(Popover.new(id + "-popover").open(open).anchor("top_right")
      .on_open_change((open, cx) => {
        if (open) { this.panelMenu = id; if (id === "sessions-more-actions") this.toolContext = { ...location() }; }
        else if (this.panelMenu === id) { this.panelMenu = null; if (id === "sessions-more-actions") this.toolContext = null; }
        cx.notify();
      }).trigger(trigger).content(content));
  }

  toolsMenu() {
    const t = theme(), menuContext = { ...(this.toolContext || location()) }, items = [
      { id: "sessions-notes", title: "Project and session notes", icon: "notes", action: () => this.openNotes() },
      { id: "sessions-commands", title: "Project commands", icon: "commands", action: () => this.openCommands() },
      { id: "sessions-prompts", title: "Pending prompts", icon: "prompt-queue", action: () => this.openPrompts() },
      ...(window()?.platform === "macos" ? [{ id: "sessions-trash", title: "Session Trash", icon: "trash", action: cx => { this.showingTrash = true; this.refreshTrash(cx); } }] : []),
      { id: "sessions-presets", title: "Projects", icon: "presets", action: () => this.openWorkspaceTool("presets") },
      { id: "sessions-tools", title: "Tools", icon: "terminal", action: () => this.openWorkspaceTool("tools") },
    ];
    const choose = (item, cx) => {
      const current = location(); this.panelMenu = null; this.toolContext = null;
      if (current.cwd !== menuContext.cwd || (current.on ?? null) !== (menuContext.on ?? null)) { this.error = "The project changed. Reopen Workspace tools for its current folder."; cx.notify(); return; }
      item.action(cx); cx.notify();
    };
    return v_flex().id("sessions-tools-menu").w(220).max_h(340).min_h(0).overflow_y_scrollbar().p(5).gap(2).rounded(6).border_1().border_color(t.border).bg(t.popover || t.surface).text_color(t.foreground).text_size(TYPE.md).pr(16)
      .on_key_down((event, cx) => {
        const key = String(event.key || "").toLowerCase();
        if (["down", "arrowdown", "up", "arrowup"].includes(key)) {
          this.toolIndex = ((this.toolIndex || 0) + (key === "up" || key === "arrowup" ? -1 : 1) + items.length) % items.length;
        } else if (key === "enter") choose(items[this.toolIndex || 0], cx);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .children(items.map((item, index) => h_flex().id(item.id).h(28).px(7).gap(8).items_center().rounded(4).cursor_pointer()
        .when(this.panelMenu === "sessions-more-actions" && this.toolIndex === index, el => el.bg(t.selected))
        .hover(el => el.bg(t.hover)).tooltip(item.title).accessibility_label(item.title)
        .on_click((_event, cx) => { cx.stop_propagation(); choose(item, cx); })
        .child(svg("mods/sessions-plus/" + item.icon + ".svg").size(14).flex_none()).child(item.title)));
  }

  interruptedStrip(entries, t) {
    const button = (id, label, action) => div().id(id).px(6).py(3).flex_none().rounded(4).text_size(TYPE.xs)
      .text_color(this.restoring ? t.dim : t.foreground)
      .when(!this.restoring, el => el.cursor_pointer().hover(el => el.bg(t.hover)).on_click((_event, cx) => action(cx))).child(label);
    const names = shared(NAMES);
    return v_flex().id("sessions-interrupted").flex_none().mx(8).mb(6).p(6).gap(4).rounded(6).bg(t.raised)
      .child(h_flex().min_w(0).gap(4).items_center()
        .child(div().flex_1().truncate().font_medium().text_size(TYPE.sm).child(`Interrupted · ${entries.length}`))
        .child(button("sessions-interrupted-resume-all", "Resume all", cx => this.resumeInterrupted(entries, cx, { background: true })))
        .child(button("sessions-interrupted-dismiss", "Dismiss", cx => this.dismissInterrupted(entries, cx))))
      .child(v_flex().id("sessions-interrupted-list").max_h(136).gap(3).overflow_y_scrollbar()
        .children(entries.map(entry => h_flex().id("sessions-interrupted-" + entry.key).h(25).flex_none().min_w(0).gap(5).items_center()
          .child(div().flex_1().truncate().text_size(TYPE.sm).text_color(t.muted).tooltip(entry.cwd).child(interruptionTitle(entry, names)))
          .child(button("sessions-interrupted-resume-" + entry.key, "Resume", cx => this.resumeInterrupted([entry], cx))))));
  }

  renderSessions(cx) {
    if (this.showingTrash) { this.transcriptRequest = null; return this.renderTrash(cx); }
    const t = theme(), context = location(), detailed = shared("project-spaces.density.v1") !== "compact";
    const interrupted = interruptedSessions(shared(TERMINAL_SESSIONS_KEY));
    const inScope = filterRows(this.rows(), { ...context, all: this.all, provider: this.provider, source: this.source });
    const transcript = this.transcriptSearch(inScope, context, cx);
    const textMatches = filterRows(inScope, { all: true, query: this.query });
    const matching = transcript?.hits.size ? new Set(textMatches) : null;
    const rows = matching ? inScope.flatMap(row => matching.has(row) ? [row] : transcript.hits.has(row.key) ? [{ ...row, inTranscript: true }] : []) : textMatches;
    const smallButton = (id, label, callback) => div().id(id).px(6).py(3).rounded(4).cursor_pointer().text_color(t.muted).hover(el => el.bg(t.hover)).on_click(callback).child(label);
    const folder = context.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || context.cwd || "No folder";
    const filters = v_flex().id("sessions-filter-content").w(220).p(8).gap(6).rounded(6).border_1().border_color(t.border).bg(t.popover || t.surface).text_color(t.foreground).text_size(TYPE.md)
      .child(div().px(1).text_size(TYPE.sm).text_color(t.muted).child("Agent"))
      .child(this.filterDropdown("sessions-provider", this.provider, [
        { value: "all", label: "All agents" }, ...Object.entries(PROVIDERS).map(([value, label]) => ({ value, label, provider: value })),
      ], value => { this.provider = value; }))
      .child(div().px(1).text_size(TYPE.sm).text_color(t.muted).child("Source"))
      .child(this.filterDropdown("sessions-source", this.source, [
        { value: "all", label: "All sources" }, ...Object.entries(ORIGINS).map(([value, label]) => ({ value, label })),
      ], value => { this.source = value; }));
    const chip = (id, title, action) => h_flex().id(id).gap(3).items_center().min_w(0).text_size(TYPE.xs).text_color(t.accent)
      .child(div().min_w(0).truncate().child(title))
      .child(div().id(id + "-clear").size(18).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer().hover(el => el.bg(t.hover))
        .tooltip("Clear " + title).accessibility_label("Clear " + title)
        .on_click((_event, cx) => { cx.stop_propagation(); action(); this.visible = 60; cx.notify(); })
        .child(svg("mods/workspace-chrome/x.svg").size(10)));
    const rowView = row => {
      const pending = this.busy.has(row.key) || (!row.live && Date.now() - (shared(PENDING)?.[row.key] ?? 0) < 15000);
      const history = historyTime(row), time = /^Updated /.test(history) ? history.split(" · ")[0].replace(/^Updated /, "").replace(/ ago$/, "") : "—";
      const status = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle" }[row.status] || "Live";
      const trailing = pending ? "Opening…" : row.live ? status : time;
      const usage = row.context;
      const subtitle = (PROVIDERS[row.provider] ?? "Agent") + " · " + (row.live ? "Live session" : ORIGINS[row.origin || "unknown"]) + (row.remote ? " · Remote" : "");
      const full = [row.title, subtitle, history, row.cwd, row.live ? "Switch to running session" : "Resume session"].filter(Boolean).join("\n");
      return v_flex().id("session-" + row.key).px(7).py(detailed ? 5 : 3).gap(2).min_w(0).rounded(4)
        .when(!detailed, el => el.h(30)).bg(row.focused ? t.selected : "#00000000").tooltip(full)
        .hover(el => el.bg(t.hover)).cursor_pointer().on_click((_e, cx) => this.open(row, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.actionsRow(row); })
        .child(h_flex().h(20).gap(6).items_center().min_w(0)
          .child(providerIcon(row.provider, 15))
          .child(div().id("session-title-" + row.key).flex_1().min_w(0).truncate().text_size(TYPE.md).child(row.title))
          .when(Boolean(row.inTranscript), el => el.child(div().flex_none().text_size(TYPE.xs).text_color(t.muted).child("in transcript")))
          .when(Boolean(usage), el => el.child(div().id("session-context-" + row.key).flex_none().text_size(TYPE.xs)
            .text_color(usage.level === "strong" ? t.blocked : usage.level === "warn" ? t.ansi3 : t.muted).tooltip(usage.tooltip).child(usage.label)))
          .child(div().id("session-state-" + row.key).w(67).flex_none().text_right().text_size(TYPE.xs).text_color(pending ? t.accent : row.live && row.status !== "idle" ? t[row.status] || t.muted : t.dim).child(trailing))
          .child(div().id("session-action-slot-" + row.key).w(24).h(24).flex_none()
            .child(div().id("session-name-" + row.key).size(24).p(0).flex().items_center().justify_center().rounded(4).text_color(t.muted).cursor_pointer().hover(el => el.bg(t.hover))
              .tooltip("Session actions").accessibility_label("Session actions")
              .on_click((_event, cx) => { cx.stop_propagation(); this.actionsRow(row); })
              .child(svg("mods/sessions-plus/more.svg").size(14)))))
        .when(detailed, el => el.child(div().id("session-detail-" + row.key).pl(21).pr(30).min_w(0).truncate().text_size(TYPE.xs).text_color(t.muted).child(subtitle)))
        .when(detailed && this.all && Boolean(row.cwd), el => el.child(div().pl(21).pr(30).min_w(0).truncate().text_size(TYPE.xs).text_color(t.dim).child(row.cwd)));
    };
    return v_flex().id("sessions-plus").size_full().min_h(0).min_w(0).bg(t.chrome || t.surface).text_color(t.foreground).text_size(TYPE.md)
      .when(!this.all, el => el.child(v_flex().id("sessions-context").px(10).pt(6).pb(4).gap(1).flex_none()
        .child(h_flex().h(18).line_height("18px").gap(6).items_center().min_w(0)
          .child(svg("mods/workspace-chrome/folder.svg").size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().font_medium().tooltip(context.cwd).child(folder))
          .when(Boolean(context.on), el => el.child(div().flex_none().text_size(TYPE.xs).text_color(t.dim).child("@" + context.on))))
        .when(detailed && Boolean(context.cwd), el => el.child(div().pl(20).min_w(0).truncate().text_size(TYPE.xs).text_color(t.dim).tooltip(context.cwd).child(context.cwd)))))
      .child(h_flex().id("sessions-toolbar").h(32).px(8).gap(4).items_center().min_w(0).flex_none()
        .child(this.filterDropdown("sessions-scope", this.all ? "all" : "current", [
          { value: "current", label: "This folder" }, { value: "all", label: "All folders" },
        ], value => { this.all = value === "all"; }, true))
        .child(div().flex_none().text_size(TYPE.xs).text_color(t.dim).child(String(rows.length)))
        .child(this.toolbarPopover("sessions-filter-toggle", "Filter sessions", "mods/sessions-plus/filter.svg", filters, this.provider !== "all" || this.source !== "all"))
        .child(div().id("sessions-refresh").size(24).p(0).rounded(4).flex_none().flex().items_center().justify_center()
          .text_color(this.loading ? t.accent : t.muted).disabled(this.loading)
          .when(this.loading, el => el.cursor_default()).when(!this.loading, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
          .tooltip(this.loading ? "Refreshing sessions…" : "Refresh sessions").accessibility_label("Refresh sessions")
          .on_click((_event, cx) => { cx.stop_propagation(); if (!this.loading) { this.transcriptRequest = null; this.refresh(cx); } })
          .child(svg("mods/sessions-plus/refresh.svg").size(14).flex_none().when(this.loading, el => el.spin(850))))
        .child(this.toolbarPopover("sessions-more-actions", "Workspace tools", "mods/sessions-plus/more.svg", this.toolsMenu())))
      .child(div().mx(8).mb(6).px(7).h(28).flex_none().border_1().border_color(t.input || t.border).rounded(5).bg(t.background).child(Input.new(this.input).w_full().h_full()))
      .when(interrupted.length > 0, el => el.child(this.interruptedStrip(interrupted, t)))
      .when(this.provider !== "all" || this.source !== "all", el => el.child(h_flex().id("sessions-active-filters").px(9).pb(5).gap(8).min_w(0).flex_none()
        .when(this.provider !== "all", el => el.child(chip("sessions-agent-filter", PROVIDERS[this.provider] || "Agent", () => { this.provider = "all"; })))
        .when(this.source !== "all", el => el.child(chip("sessions-source-filter", ORIGINS[this.source] || "Source", () => { this.source = "all"; })))))
      .child(v_flex().id("sessions-list").flex_1().min_h(0).min_w(0).px(6).gap(2).overflow_y_scrollbar().pr(16)
        .children(rows.slice(0, this.visible).flatMap((row, index, visibleRows) => {
          const group = historyGroup(row), first = index === 0 || historyGroup(visibleRows[index - 1]) !== group;
          return [...(first ? [div().px(7).pt(7).pb(3).font_medium().text_size(TYPE.xs).text_color(t.muted).child(group)] : []), rowView(row)];
        }))
        .when(!rows.length, el => el.child(div().p(12).text_color(t.muted).child(this.loading ? "Reading local session history…" : context.remote && !this.all ? "Choose All folders for local history and remote live sessions." : "No sessions here. Try All folders or another search.")))
        .when(rows.length > this.visible, el => el.child(smallButton("sessions-more", "Show more", (_e, cx) => { this.visible += 60; cx.notify(); }))))
      .when(Boolean(this.error), el => el.child(div().p(9).max_h(70).overflow_y_scrollbar().text_size(TYPE.sm).text_color(t.ansi1).pr(16).child(this.error)))
      .when(Boolean(transcript?.partial), el => el.child(div().px(9).text_size(TYPE.xs).text_color(t.muted).child("Transcript search was partial.")))
      .when(this.warnings.length > 0 || this.limited, el => el.child(div().p(9).max_h(55).overflow_y_scrollbar().text_size(TYPE.xs).text_color(t.muted).pr(16).child([...this.warnings, ...(this.limited ? ["Showing recent history; scan limit reached."] : [])].join(" "))))
      .when(!rows.length, el => el.child(div().id("sessions-empty-hint").px(9).py(5).flex_none().text_size(TYPE.xs).text_color(t.dim).child(window()?.platform === "macos" ? "Local history · Right-click for session actions" : "Live sessions · Local history requires macOS")));
  }

  renderTrash() {
    const t = theme();
    const button = (id, label, callback) => div().id(id).px(7).py(5).rounded(5).cursor_pointer().text_color(t.muted).hover(el => el.bg(t.hover)).on_click(callback).child(label);
    return v_flex().id("sessions-trash-view").size_full().min_h(0).bg(t.surface).text_color(t.foreground).text_size(TYPE.md)
      .child(h_flex().px(8).py(5).gap(5).items_center().flex_none()
        .child(button("sessions-trash-back", "← Sessions", (_event, cx) => { this.showingTrash = false; cx.notify(); }))
        .child(div().flex_1().font_semibold().tooltip("Only sessions moved by Sessions Plus appear here. Emptying the macOS Trash removes their history permanently.").child("Trash"))
        .child(button("sessions-trash-refresh", svg("mods/sessions-plus/refresh.svg").size(14).flex_none().when(this.trashLoading, el => el.spin(850)), (_event, cx) => this.refreshTrash(cx))
          .size(24).p(0).rounded(4).flex_none().flex().items_center().justify_center().text_color(this.trashLoading ? t.accent : t.muted).disabled(this.trashLoading).when(this.trashLoading, el => el.cursor_default())
          .tooltip(this.trashLoading ? "Refreshing Trash…" : this.trashError ? "Retry refreshing Trash" : "Refresh Trash").accessibility_label("Refresh Trash")))
      .child(v_flex().id("sessions-trash-list").flex_1().min_h(0).px(8).gap(5).overflow_y_scrollbar().pr(16)
        .children(this.trashEntries.map(row => v_flex().id(`session-trash-${row.token}`).px(9).py(8).gap(5).rounded(7).bg(t.raised)
          .child(div().truncate().child(shared(NAMES)?.[row.key] || row.title || row.id))
          .child(h_flex().gap(5).items_center()
            .child(providerIcon(row.provider, 17))
            .child(div().flex_1().text_size(TYPE.sm).text_color(t.muted).child(`${PROVIDERS[row.provider] ?? row.provider} · ${new Date(row.trashedAt).toLocaleString()}`))
            .child(row.restorable === true ? button(`session-restore-${row.token}`, "Restore…", () => this.restoreRow(row)) : div().px(7).py(5).text_color(t.dim).child("Unavailable")))
          .when(Boolean(row.message) || row.restorable !== true || row.status === "recovery", el => el.child(div().text_size(TYPE.sm).text_color(t.muted)
            .child(row.message || (row.location === "missing" ? "Session files are no longer in Trash." : row.restorable !== true ? "This session cannot currently be restored." : "An interrupted operation needs recovery. Restore will recover the remaining files."))))))
        .when(!this.trashEntries.length, el => el.child(div().p(12).text_color(t.muted).child(this.trashLoading ? "Reading Session Trash…" : this.trashError ? "Could not read Session Trash. Try again." : "No sessions in Trash."))))
      .when(Boolean(this.trashError), el => el.child(div().p(10).max_h(80).overflow_y_scrollbar().text_color(t.ansi1).pr(16).child(this.trashError)))
      .when(!this.trashEntries.length, el => el.child(div().px(10).py(8).text_size(TYPE.xs).text_color(t.dim).child("Only sessions moved by Sessions Plus appear here. Emptying the macOS Trash removes their history permanently.")));
  }
  async close(cx) {
    this.closed = true;
    this.input?.release();
    this.role?.stats?.close?.();
    this.role?.status?.stats?.close?.();
    await this.role?.close?.(cx);
  }

}
