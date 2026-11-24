import { TYPE } from "./type-scale.js";
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Input, Popover } from "gpui-base";
import { agents, terminals, spaces, panes, focused, theme, run, shared, setShared, setAgentOrder } from "herdr";
import { menuTooltipKey } from "./menu-tooltip.js";
import { FILTER_KEY, SIDEBAR_COLUMNS, spacePath, echoesName } from "./model.js";
import { DIRECTORY_PINS_KEY, normalizeDirectoryPins, setDirectoryPin } from "./directory-pins.js";
import { unifiedRows, validateUnifiedTarget, subagentRecords } from "./unified-model.js";
const chrome = name => `mods/workspace-chrome/${name}.svg`;
const label = (value, limit = 500) => String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, limit);
const TREE_STEP = 20, ROW_GAP = 2;
const CONTROL = { height: 24, radius: 4, glyph: 14 };
const treeDepth = row => Math.min(4, Math.max(0, Number.isFinite(row.displayDepth) ? row.displayDepth : row.depth || 0));
const countTooltip = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const statusName = status => ({ blocked: "Needs you", done: "Done", working: "Working", idle: "Idle" }[status] || "Unknown");

// Shared registry contract. Mods each keep their own formatter because imports are local.
function liveContext(entry, terminal, now) {
  if (!terminal || terminal.state !== "live" || terminal.address.includes("/") || !Number.isSafeInteger(terminal.foreground?.pid) ||
    entry?.pid !== terminal.foreground.pid || !Number.isFinite(entry.used) || entry.used < 0 || !Number.isFinite(entry.at) || now - entry.at > 120000) return null;
  const window = entry.window, percent = Number.isFinite(window) && window > 0 && entry.used <= window ? Math.floor(entry.used * 100 / window) : null;
  const tokens = n => n >= 1000000 ? `${+(n / 1000000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
  const s = Math.max(0, Math.floor((now - entry.asOf) / 1000));
  const ago = s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
  const tooltip = [`Context ${tokens(entry.used)}${window ? ` of ${tokens(window)}` : ""} tokens`, entry.model || "Unknown model",
    Number.isFinite(entry.asOf) ? `as of ${ago}` : "", "window table 2026-11-03"].filter(Boolean).join(" · ");
  return { label: percent === null ? tokens(entry.used) : `${percent}%`, tooltip, level: percent >= 90 ? "strong" : percent >= 80 ? "warn" : null };
}

export default class UnifiedSidebar {
  init(p, cx) { this.p = p; this.foldMode = null; this.opened = new Set(); this.folded = new Set(); this.page = 0; this.error = ""; this.handle = cx.focus_handle(); this.epoch = 0; this.nextCheck = 0; this.pending = false; }
  tooltipKey(id) { return this.popupTooltipState ? menuTooltipKey(id, this.popupTooltipState) : id; }
  snapshots(frame) { return frame.snapshots || { spaces: frame.spaces || [], agents: frame.agents || [], terminals: frame.terminals || [], panes: frame.panes || [], focus: frame.focus || null }; }
  fresh() { return { spaces: spaces(), agents: agents(), terminals: terminals(), panes: panes(), focus: focused() }; }
  heldDone(snapshot) {
    const agent = snapshot.agents.find(agent => agent.focused), terminal = agent && snapshot.terminals.find(terminal => terminal.address === agent.address);
    if (!agent || this.held?.address !== agent.address || this.held.created !== terminal?.created_ms || agent.status !== "idle") this.held = agent ? { address: agent.address, created: terminal?.created_ms, status: agent.status } : null;
    return this.held?.status === "done" && agent?.status === "idle" ? [agent.address] : [];
  }
  signature(groups, snapshot, options) {
    // Keep argv bodies out of per-frame cache work; actions revalidate the exact model target.
    return JSON.stringify([
      groups.map(group => [group.key, group.name, group.color, group.folder, group.machine, group.folded, group.status, group.custom, group.manual, group.header, group.fullCount, group.rows.map(row => [row.w.id, row.w.name, row.w.machine, row.w.active, row.w.status, row.place, row.g?.branch, row.g?.ahead, row.g?.behind, row.g?.name, row.g?.linked, (row.w.tabs || []).map(tab => [tab.id, tab.name, tab.named, tab.active, tab.settled, tab.status, tab.changed_at, tab.working_since])])]),
      snapshot.spaces.map(space => [space.id, space.name, space.machine, space.folder, space.status, space.active, (space.tabs || []).map(tab => [tab.id, tab.name, tab.named, tab.active, tab.settled, tab.status, tab.changed_at, tab.working_since])]),
      snapshot.agents.map(agent => [agent.address, agent.title, agent.status, agent.pinned, agent.focused, agent.seq, agent.space, agent.tab, agent.pane, agent.program?.key, agent.program?.name, agent.program?.agent, agent.program?.shell, agent.program?.icon, agent.program?.tint]),
      snapshot.terminals.map(terminal => [terminal.address, terminal.created_ms, terminal.pid, terminal.state, terminal.parent, terminal.cwd, terminal.name, terminal.title, terminal.template, terminal.status, terminal.argv?.[0], terminal.program?.key, terminal.program?.name, terminal.program?.agent, terminal.program?.shell, terminal.program?.icon, terminal.program?.tint, terminal.labels?.["herdr.pinned"], terminal.labels?.["herdr.space"], terminal.labels?.["herdr.tab"], terminal.records ? subagentRecords(terminal) : null]),
      snapshot.panes.map(pane => [pane.pane, pane.tab, pane.terminal, pane.cwd, pane.branch, pane.focused, pane.title]), snapshot.focus, options,
    ]);
  }
  request(frame, owner, cx) {
    frame = { ...frame, directoryPins: normalizeDirectoryPins(shared(DIRECTORY_PINS_KEY)) };
    this.latest = { frame, owner };
    const projectionTag = JSON.stringify([frame.state?.mode, String(frame.query || "").slice(0, 300), frame.filter]);
    if (this.projectionTag !== undefined && this.projectionTag !== projectionTag) this.page = 0;
    this.projectionTag = projectionTag;
    const tag = JSON.stringify([projectionTag, this.page, this.foldMode, [...this.opened], [...this.folded]]);
    if (tag !== this.requestTag) { this.requestTag = tag; this.epoch++; this.nextCheck = 0; }
    if (this.closed || this.pending) return;
    this.pending = true; const delay = Math.max(0, this.nextCheck - Date.now());
    // Signature, projection and native drawing each receive a separate execution budget.
    cx.timer.after(delay, cx => {
      if (this.closed) return;
      const epoch = this.epoch, { frame } = this.latest, snapshot = this.snapshots(frame), groups = frame.fullGroups || frame.groups || [];
      const options = { view: frame.state?.mode === "status" ? "status" : "project", query: String(frame.query || "").slice(0, 300), status: frame.filter || "all", expandAll: this.foldMode === "expand", collapseAll: this.foldMode === "collapse", openOverrides: [...this.opened], folded: [...this.folded], heldDone: this.heldDone(snapshot), directoryPins: frame.directoryPins, page: this.page, pageSize: 30 };
      let key;
      try { key = this.signature(groups, snapshot, options); }
      catch (error) { this.pending = false; this.nextCheck = Date.now() + 1000; this.error = label(error.message || error); cx.notify(); return; }
      if (key === this.cacheKey) { this.pending = false; this.nextCheck = Date.now() + 150; return; }
      cx.timer.after(0, cx => {
        if (this.closed) return;
        try {
          const result = unifiedRows({ groups, ...snapshot, options });
          if (this.epoch === epoch) { this.result = result; this.cacheKey = key; if (result.page !== undefined) this.page = result.page; this.error = ""; }
        } catch (error) { this.error = label(error.message || error); }
        this.pending = false; this.nextCheck = this.epoch === epoch ? Date.now() + 150 : 0; cx.notify();
      });
    });
  }
  fold(row, cx) {
    if (!row?.foldable) return;
    if (row.folded) { this.opened.add(row.id); this.folded.delete(row.id); }
    else { this.folded.add(row.id); this.opened.delete(row.id); }
    this.page = 0; this.cacheKey = null; cx.notify();
  }
  foldAll(mode, cx) { this.foldMode = mode; this.opened.clear(); this.folded.clear(); this.page = 0; this.cacheKey = null; cx.notify(); }
  navigate(row, cx) {
    try {
      const snapshot = this.fresh(), target = row.target;
      if (!target || !validateUnifiedTarget(target, snapshot)) throw new Error(target?.reason || "This workspace item changed or ended. Choose its current row.");
      if (["agent", "terminal"].includes(target.kind)) {
        if (row.kind !== "record" && row.status === "done") this.held = { address: target.address, created: target.created_ms, status: "done" };
        const pane = snapshot.panes.find(pane => pane.terminal === target.address);
        run(pane ? "pane.focus" : "terminal.peek", { terminal: target.address });
      } else if (target.kind === "tab") { run("space.select", { id: target.space }); run("tab.select", { id: target.tab }); }
      else if (target.kind === "space") run("space.select", { id: target.space });
      this.error = "";
    } catch (error) { this.error = label(error.message || error); }
    cx.notify();
  }
  pin(row, cx) {
    try {
      const snapshot = this.fresh(), target = row.target;
      if (!target || !["agent", "terminal"].includes(target.kind) || !validateUnifiedTarget(target, snapshot)) throw new Error("This agent changed or ended. Pin its current row instead.");
      const agent = snapshot.agents.find(agent => agent.address === target.address), terminal = snapshot.terminals.find(terminal => terminal.address === target.address);
      const pinned = agent?.pinned ?? Boolean(terminal?.labels?.["herdr.pinned"]);
      run("terminal.pin", { terminal: target.address, pinned: !pinned }); this.hovered = null; this.error = "";
    } catch (error) { this.error = label(error.message || error); }
    cx.notify();
  }
  unpinDirectory(row, owner, cx) {
    try {
      const snapshot = this.fresh(), pins = normalizeDirectoryPins(shared(DIRECTORY_PINS_KEY));
      const live = target => snapshot.spaces.filter(space => space.id === target.id).length === 1 && snapshot.spaces.some(space => space.id === target.id && (space.machine ?? null) === (target.machine ?? null));
      let kind, id;
      if (row.kind === "space") {
        if (!validateUnifiedTarget(row.target, snapshot)) throw new Error("This directory changed or closed. Choose its current row.");
        kind = "space"; id = row.spaceId;
      } else if (row.kind === "group") {
        const group = row.sourceGroup, state = owner.state();
        const current = owner.lastGroups?.find(item => item.key === row.groupKey);
        if (!group || !current || !group.rows.some(source => live(source.w) && current.rows.some(item => item.w.id === source.w.id) && (state.assign?.[source.w.id] ?? source.auto?.key) === row.groupKey)) throw new Error("This project changed or closed. Choose its current row.");
        kind = "group"; id = row.groupKey;
      } else throw new Error("Choose a directory or project pin.");
      const key = kind === "space" ? "spaces" : "groups";
      if (pins[key].includes(id)) setShared(DIRECTORY_PINS_KEY, setDirectoryPin(pins, kind, id, false));
      this.epoch++; this.cacheKey = null; this.nextCheck = 0; this.error = "";
    } catch (error) { this.error = label(error.message || error); }
    cx.notify();
  }
  directoryPin(row, owner, cx) {
    if (!["group", "space"].includes(row.kind) || row.section !== "pinned" || this.hovered !== row.id) return null;
    const t = theme(), pins = normalizeDirectoryPins(shared(DIRECTORY_PINS_KEY)), direct = Boolean(row.directoryPinned), disabled = Boolean(row.target?.disabled);
    const inherited = row.kind === "space" && (row.directoryInheritedPin || pins.groups.includes(row.groupKey));
    const title = direct ? (row.kind === "group" ? "Unpin project" : inherited ? "Unpin directory (project remains pinned)" : "Unpin directory") : inherited ? "Pinned with project" : row.kind === "group" ? "Pinned with its directories and tasks" : "Pinned with its tasks";
    return div().id("unified-directory-pin-" + row.id).size(19).flex_none().rounded(4).flex().items_center().justify_center().text_color(direct && !disabled ? t.accent : t.dim).when(!this.popupTooltipState?.open, el => el.tooltip(disabled ? row.target.reason || "Pin actions unavailable for this directory" : title)).accessibility_label(title)
      .when(direct && !disabled, el => el.cursor_pointer().hover(el => el.bg(t.hover))
        .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
        .on_mouse_up("left", (_event, cx) => { cx.stop_propagation(); owner.drag = owner.over = null; })
        .on_click((_event, cx) => { cx.stop_propagation(); this.unpinDirectory(row, owner, cx); }))
      .child(svg(chrome("pin")).size(12));
  }
  hoverRow(row, on, cx) {
    const next = on ? row.id : this.hovered === row.id ? null : this.hovered;
    if (next !== this.hovered) { this.hovered = next; cx.notify(); }
  }
  program(row) { return row.program || row.agent?.program || row.terminal?.program || null; }
  metadata(row, full = false, home = "") {
    if (!full && ["agent", "terminal"].includes(row.kind)) return "";
    if (!full && typeof row.inlineMetadata === "string") return label(row.inlineMetadata, 700);
    if (row.kind === "space" && row.sourceSpace?.w) {
      const group = row.sourceGroup || {}, nested = row.depth > 0 || group.custom || group.manual || group.rows?.length > 1;
      const location = spacePath(row.sourceSpace, group, home, Boolean(nested), group.displayLocation), git = row.sourceSpace.g, branch = git?.branch ?? "detached";
      if (full) return [location?.tooltip, git?.name, git ? branch : "", git?.ahead > 0 ? "Ahead: " + git.ahead : "", git?.behind > 0 ? "Behind: " + git.behind : ""].filter(Boolean).join("\n");
      return label([git && !["main", "master"].includes(branch) ? "⑂ " + branch : "", location && !location.repeat && !echoesName(location, row.sourceSpace.w.name) ? location.short : ""].filter(Boolean).join(" · "), 700);
    }
    if (Array.isArray(row.metadata)) return row.metadata.map(value => label(value, 200)).filter(Boolean).join(" · ");
    if (typeof row.metadata === "string") return label(row.metadata, 700);
    return [row.spaceName || row.agent?.space_name, row.tabName || row.agent?.tab_name, row.branch, row.on || row.target?.on ? `@${row.on || row.target.on}` : "local", row.cwd || row.terminal?.cwd].filter(Boolean).map(value => label(value, 220)).join(" · ");
  }
  activity(row) {
    const now = Date.now();
    if (!row.agent || !Number.isFinite(row.activityAt) || row.activityAt <= 0 || row.activityAt > now) return null;
    const minutes = Math.floor((now - row.activityAt) / 60000), duration = minutes < 1 ? "<1m" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
    // Working rows count elapsed time, others count since the last activity; the words keep them apart.
    return { label: row.activityKind === "working" ? "for " + duration : duration + " ago", tooltip: row.activityKind === "working" ? "Tab working for " + duration : "Tab activity " + duration + " ago" };
  }
  guides(row, t, index) {
    const depth = treeDepth(row), previous = this.result?.rows?.[index - 1];
    const previousDepth = previous ? treeDepth(previous) : 0;
    const gap = ROW_GAP + this.projectGap(row, index);
    // Join only guide levels present in both adjacent visible rows.
    return Array.from({ length: depth }, (_, level) => div().id(`unified-guide-${row.id}-${level}`).absolute().left(13 + level * TREE_STEP).top(previousDepth > level ? -gap : 0).bottom(0).w(0).border_l(1).border_color(t.dim).opacity(0.5));
  }
  entityRow(row, index, frame, cx, directoryPin = null, projectIcon = null) {
    const t = theme(), density = frame.density || "detailed", detailed = density !== "compact", target = row.target, disabled = Boolean(target?.disabled), program = this.program(row), depth = treeDepth(row);
    const task = label(row.title || row.taskTitle || row.agent?.title || row.terminal?.name || row.tabName || target?.address || "Workspace item", 2000), metadata = this.metadata(row, false, frame.home), agent = ["agent", "terminal"].includes(target?.kind), activity = this.activity(row);
    const terminalOnly = target?.kind === "terminal" && !row.agent;
    const usage = this.contextFor?.(target);
    const completeTask = label(row.taskTitle || task, 2048), ownStatus = terminalOnly ? "" : statusName(row.status), knownStatus = ["blocked", "done", "working", "idle", "unknown"].includes(row.status);
    const localMetadata = metadata.trim().toLocaleLowerCase() === task.trim().toLocaleLowerCase() || metadata.trim().toLocaleLowerCase() === "unknown" ? "" : metadata;
    const contextDetails = agent ? activity?.label || "" : localMetadata;
    const statusColor = disabled || row.status === "idle" ? t.dim : t[row.status] || t.accent;
    const hasDetails = detailed && Boolean(contextDetails), showAgentPin = agent && (this.hovered === row.id || row.pinned && row.section !== "pinned");
    const showStatus = !terminalOnly && knownStatus && (row.status !== "idle" || row.agent === true) && !["space", "group"].includes(row.kind), pinWidth = agent || row.kind === "space" || directoryPin ? SIDEBAR_COLUMNS.pin : 0;
    // Idle is the resting state: a dot marks a real agent, the word is kept for states that need a look.
    const statusText = detailed && row.status !== "idle", statusWidth = showStatus ? statusText ? 72 : 13 : 0, actionWidth = pinWidth + (pinWidth && statusWidth ? SIDEBAR_COLUMNS.gap : 0) + statusWidth;
    const fullDetails = [this.metadata(row, true), activity?.tooltip, ownStatus, !terminalOnly && row.branchStatus && row.branchStatus !== row.status ? "Child activity: " + statusName(row.branchStatus) : ""].filter(Boolean).join(" · ");
    const tooltip = [completeTask, fullDetails, row.parentId ? "Parent: " + label(row.parentId, 256) : "", target?.address, target?.reason].filter(Boolean).join("\n");
    const folding = div().id("unified-fold-" + row.id).w(18).h(16).flex_none().rounded(4).flex().items_center().justify_center().text_color(t.dim)
      .when(Boolean(row.foldable), el => el.cursor_pointer().hover(el => el.bg(t.hover)).on_click((_event, cx) => { cx.stop_propagation(); this.fold(row, cx); }).child(svg(chrome(row.folded ? "chevron-right" : "chevron-down")).size(10)))
      .when(!row.foldable, el => el.child(div().w(1)));
    let icon = row.kind === "tab" ? svg(chrome("layers")).size(12).flex_none().text_color(t.dim) : div().size(8).flex_none().rounded(4).bg(t[row.status] || t.dim);
    if (row.kind === "space") icon = projectIcon || svg(chrome("folder")).id("unified-directory-icon-" + row.id).size(14).text_color(t.muted || t.dim);
    if (program?.icon) icon = program.tint ? svg(program.icon).size(14).flex_none().text_color(t.foreground) : image(program.icon).size(14).flex_none();
    const statusGlyph = row.status === "working" ? svg(chrome("spinner")).size(11).text_color(t.working).spin(900) : div().size(row.status === "blocked" ? 8 : 7).rounded(4).bg(t[row.status] || t.dim);
    const statusControl = showStatus ? h_flex().id("unified-status-" + row.id).h(19).gap(4).items_center().justify_end().when(!this.popupTooltipState?.open, el => el.tooltip(ownStatus))
      .child(div().size(13).flex_none().flex().items_center().justify_center().child(statusGlyph))
      .when(statusText, el => el.child(div().id("unified-status-text-" + row.id).flex_none().text_size(TYPE.xs).font_medium().text_color(statusColor).child(ownStatus))) : null;
    const pinControl = !agent ? directoryPin : showAgentPin ? div().id("unified-pin-" + row.id).size(19).flex_none().rounded(4).flex().items_center().justify_center().text_color(row.pinned ? t.accent : t.dim).when(!this.popupTooltipState?.open, el => el.tooltip(row.pinned ? "Unpin agent" : "Pin agent"))
      .cursor_pointer().hover(el => el.bg(t.hover)).on_mouse_down("left", (_event, cx) => cx.stop_propagation()).on_mouse_up("left", (_event, cx) => cx.stop_propagation())
      .on_click((_event, cx) => { cx.stop_propagation(); this.pin(row, cx); }).child(svg(chrome(row.pinned ? "pin-off" : "pin")).size(12)) : null;
    const actions = h_flex().id("unified-actions-" + row.id).w(actionWidth).h(19).flex_none().gap(SIDEBAR_COLUMNS.gap).items_center()
      .when(pinWidth > 0, el => el.child(div().id((agent ? "unified-agent-pin-slot-" : "unified-directory-pin-slot-") + row.id).size(pinWidth).flex_none().when(Boolean(pinControl), el => el.child(pinControl))))
      .when(statusWidth > 0, el => el.child(div().id("unified-status-slot-" + row.id).w(statusWidth).h(19).flex_none().flex().items_center().justify_end().when(Boolean(statusControl), el => el.child(statusControl))));
    const metadataLine = hasDetails ? div().id("unified-meta-" + row.id).min_w(0).truncate().h(13).text_size(TYPE.xs).line_height("13px").text_color(t.dim).when(!this.popupTooltipState?.open, el => el.tooltip(activity?.tooltip || fullDetails)).child(contextDetails) : null;
    const body = h_flex().id(this.tooltipKey("unified-entity-" + row.id)).relative().min_w(0).min_h(detailed ? 26 : 28).py(detailed ? 3 : 0).when(!detailed, el => el.h(28)).flex_none().pl(4 + depth * TREE_STEP).pr(SIDEBAR_COLUMNS.inset).gap(5).items_start().when(!detailed, el => el.items_center()).rounded(7).when(!this.popupTooltipState?.open, el => el.tooltip(tooltip))
      .bg(row.focused ? t.selected : "#00000000").text_color(disabled ? t.dim : t.foreground).when(row.kind === "space", el => el.rounded(4)).cursor_pointer().hover(el => el.bg(row.focused ? t.selected : t.hover))
      .on_click((_event, cx) => this.navigate(row, cx))
      .on_hover((on, cx) => this.hoverRow(row, on, cx))
      .children(this.guides(row, t, index)).child(folding).child(div().id("unified-icon-" + row.id).w(18).h(16).mr(3).flex_none().flex().items_center().justify_center().child(icon))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().id("unified-task-" + row.id).min_w(0).truncate().line_height("16px").text_size(TYPE.md).font_weight(400).when(row.kind === "space", el => el.font_semibold().text_size(TYPE.md)).child(task))
        .when(Boolean(metadataLine), el => el.child(metadataLine)))
      .when(Boolean(usage), el => el.child(div().id("unified-context-" + row.id).h(19).line_height("19px").flex_none().text_size(TYPE.xs)
        .text_color(usage.level === "strong" ? t.blocked : usage.level === "warn" ? t.ansi3 : t.muted)
        .when(!this.popupTooltipState?.open, el => el.tooltip(usage.tooltip)).child(usage.label)))
      .child(actions);
    return body;
  }
  projectGap(row, index) {
    const previous = this.result?.rows?.[index - 1];
    if (!previous || !["group", "space"].includes(row.kind) || ["section", "statussection"].includes(previous.kind)) return 0;
    return row.groupKey && row.groupKey !== previous.groupKey ? 6 : 0;
  }
  recordRow(row, index, t) {
    const title = row.taskTitle || row.title, disabled = row.target.disabled;
    return h_flex().id(this.tooltipKey("unified-record-" + row.id)).relative().h(22).min_w(0).flex_none().pl(27 + treeDepth(row) * TREE_STEP).pr(SIDEBAR_COLUMNS.inset)
      .gap(6).items_center().rounded(4).text_size(TYPE.xs).text_color(t.muted).children(this.guides(row, t, index))
      .when(!this.popupTooltipState?.open, el => el.tooltip(title))
      .when(!disabled, el => el.cursor_pointer().hover(node => node.bg(t.hover)).on_click((_event, cx) => this.navigate(row, cx)))
      .child(div().flex_1().min_w(0).truncate().child(row.title))
      .when(Boolean(row.status), el => el.child(div().flex_none().text_color(t[row.status] || t.dim).child(statusName(row.status))));
  }
  draw(row, index, frame, owner, cx, canonical) {
    if (row.kind === "record") return this.recordRow(row, index, theme());
    const st = { ...frame.state, mode: "project" }, t = theme(), depth = treeDepth(row), pin = this.directoryPin(row, owner, cx), spacing = this.projectGap(row, index);
    if (row.kind === "group" && row.sourceGroup && canonical.groups.has(row.sourceGroup.key) && frame.state.mode !== "status") {
      const joining = owner.drag?.kind === "space" && owner.over?.kind === "group" && owner.over.id === row.sourceGroup.key;
      return v_flex().id(`unified-group-${row.id}`).relative().w_full().min_w(0).flex_none().bg(joining ? t.selected : "#00000000").rounded(4).when(joining, el => el.border_1().border_color(t.accent)).when(!joining, el => el.hover(el => el.bg(t.hover))).mt(spacing).pl(depth * TREE_STEP).on_hover((on, cx) => this.hoverRow(row, on, cx)).children(this.guides(row, t, index)).child(owner.groupHead({ ...row.sourceGroup, folded: row.folded, onFold: cx => this.fold(row, cx) }, st, t, index, frame.density, true, pin));
    }
    if (row.kind === "space" && row.sourceSpace?.auto?.key && row.sourceGroup && canonical.groups.has(row.sourceGroup.key) && canonical.spaces.has(row.sourceSpace.w?.id) && frame.state.mode !== "status") {
      return h_flex().id(`unified-space-${row.id}`).relative().w_full().min_w(0).flex_none().bg("#00000000").rounded(4).hover(el => el.bg(t.hover)).mt(spacing).pl(4 + depth * TREE_STEP).pr(SIDEBAR_COLUMNS.inset).gap(5).items_start().children(this.guides(row, t, index))
        .on_hover((on, cx) => this.hoverRow(row, on, cx))
        .child(div().w(18).h(18).mt(frame.density === "compact" ? 4 : 3).flex_none().rounded(4).flex().items_center().justify_center().text_color(t.dim).when(Boolean(row.foldable), el => el.cursor_pointer().hover(el => el.bg(t.hover)).on_click((_event, cx) => { cx.stop_propagation(); this.fold(row, cx); }).child(svg(chrome(row.folded ? "chevron-right" : "chevron-down")).size(10))))
        .child(div().flex_1().min_w(0).child(owner.row(row.sourceSpace, row.sourceGroup, st, t, frame.density, true, pin)));
    }
    if (["section", "statussection"].includes(row.kind)) return h_flex().id(`unified-section-${row.id}`).h(27).mt(index ? 6 : 0).pl(4 + depth * TREE_STEP).pr(SIDEBAR_COLUMNS.inset).gap(5).flex_none().items_center().when(index > 0, el => el.border_t(1).border_color(t.border)).text_size(TYPE.xs).text_color(t.muted || t.dim)
      .when(Boolean(row.foldable), el => el.cursor_pointer().hover(el => el.bg(t.hover)).on_click((_event, cx) => this.fold(row, cx)))
      .child(div().w(18).h(16).flex_none().flex().items_center().justify_center().when(Boolean(row.foldable), el => el.child(svg(chrome(row.folded ? "chevron-right" : "chevron-down")).size(9))))
      .child(div().w(18).h(16).mr(3).flex_none().flex().items_center().justify_center()
        .when(row.id === "section:pinned", el => el.child(svg(chrome("pin")).size(10)))
        .when(Boolean(row.status), el => el.child(div().size(5).rounded(3).bg(t[row.status] || t.dim))))
      .child(div().flex_1().font_semibold().child(row.title || row.name || "Workspaces"))
      .when(Boolean(row.count ?? row.childCount), el => el.child(div().id(`unified-section-count-${row.id}`).text_size(TYPE.xs).when(!this.popupTooltipState?.open, el => el.tooltip(countTooltip(row.count ?? row.childCount, "item"))).child(String(row.count ?? row.childCount))));
    if (row.kind === "group") return h_flex().id(this.tooltipKey(`unified-readonly-group-${row.id}`)).relative().w_full().min_w(0).min_h(28).mt(spacing).pl(4 + depth * TREE_STEP).pr(SIDEBAR_COLUMNS.inset).gap(5).flex_none().items_center().bg("#00000000").rounded(4).hover(el => el.bg(t.hover)).children(this.guides(row, t, index))
      .on_hover((on, cx) => this.hoverRow(row, on, cx))
      .when(Boolean(row.foldable), el => el.cursor_pointer().on_click((_event, cx) => this.fold(row, cx)))
      .when(Boolean(row.sourceGroup) && canonical.groups.has(row.groupKey), el => el.on_mouse_down("right", (_event, cx) => { cx.stop_propagation(); owner.groupMenu(row.sourceGroup); }))
      .child(div().w(18).h(18).flex_none().flex().items_center().justify_center().when(Boolean(row.foldable), el => el.child(svg(chrome(row.folded ? "chevron-right" : "chevron-down")).size(10))))
      .child(div().w(18).h(18).mr(3).flex_none().flex().items_center().justify_center().child(owner.projectIcon?.(row.sourceGroup) || svg(chrome("folder")).size(15)))
      .child(div().flex_1().min_w(0).truncate().text_size(TYPE.md).font_semibold().child(row.title || row.name || "Workspaces"))
      .child(h_flex().w(SIDEBAR_COLUMNS.pin * 2 + SIDEBAR_COLUMNS.gap).flex_none().gap(SIDEBAR_COLUMNS.gap).items_center()
        .child(div().size(SIDEBAR_COLUMNS.pin).flex_none().when(Boolean(pin), el => el.child(pin)))
        .child(div().w(SIDEBAR_COLUMNS.pin).min_w(0).flex_none().truncate().text_right().text_size(TYPE.sm).text_color(t.dim).when(row.folded && Boolean(row.count ?? row.childCount), el => el.when(!this.popupTooltipState?.open, el => el.tooltip(countTooltip(row.count ?? row.childCount, "item"))).child(String(row.count ?? row.childCount)))));
    const projectIcon = row.kind === "space" && row.sourceGroup?.rows?.length === 1 ? owner.projectIcon?.(row.sourceGroup, 16) : null;
    return this.entityRow(row, index, frame, cx, pin, projectIcon)
      .when(row.kind === "space", el => el.mt(spacing))
      .when(row.kind === "space" && Boolean(row.sourceSpace?.auto) && canonical.spaces.has(row.spaceId), el => el.on_mouse_down("right", (_event, cx) => { cx.stop_propagation(); owner.spaceMenu(row.sourceSpace); }));
  }
  railRow(row, selected, frame, owner) {
    const t = theme(), target = row.target, disabled = Boolean(target.disabled), program = this.program(row);
    const title = label(row.title || row.taskTitle || "Workspace item", 2048);
    const details = [title, this.metadata(row, true, frame.home), row.agent ? statusName(row.status) : "", target.reason, this.contextFor?.(target)?.tooltip].filter(Boolean).join("\n");
    let icon = svg(chrome(target.kind === "space" ? "folder" : target.kind === "tab" ? "layers" : "terminal")).size(16);
    if (row.kind === "space" && row.sourceGroup?.rows?.length === 1) icon = owner?.projectIcon?.(row.sourceGroup, 16) || icon;
    if (program?.icon) icon = program.tint ? svg(program.icon).size(16) : image(program.icon).size(16);
    return div().id(this.tooltipKey("unified-rail-" + row.id)).w_full().h(32).flex_none().flex().items_center().justify_center()
      .role("button").accessibility_label(details).selected(selected).disabled(disabled).text_color(disabled ? t.dim : selected ? t.foreground : t.muted)
      .when(!this.popupTooltipState?.open, el => el.tooltip(details))
      .when(disabled, el => el.opacity(0.4).cursor_default())
      .when(!disabled, el => el.cursor_pointer().on_click((_event, cx) => this.navigate(row, cx)))
      .child(div().id("unified-rail-tile-" + row.id).relative().size(28).flex_none().flex().items_center().justify_center().rounded(7)
        .bg(selected ? t.selected : "#00000000").border_1().border_color(selected ? t.border : "#00000000")
        .when(!disabled, el => el.hover(el => el.bg(selected ? t.selected : t.hover).text_color(t.foreground)))
        .child(icon)
        .when(selected, el => el.child(div().id("unified-rail-selected-" + row.id).absolute().left(-5).top(8).w(2).h(10).rounded(1).bg(t.accent)))
        .when(Boolean(row.agent), el => el.child(div().id("unified-rail-status-" + row.id).absolute().right(-1).bottom(-1).size(8).rounded(4).border_1().border_color(t.chrome).bg(t[row.status] || t.dim))));
  }
  render(frame, owner, cx) {
    this.popupTooltipState = frame.popupTooltipState || null;
    const registry = shared("sessions-plus.live.v1"), now = Date.now();
    const byAddress = new Map(registry ? this.snapshots(frame).terminals.map(term => [term.address, term]) : []);
    this.contextFor = target => {
      const terminal = byAddress.get(target?.address);
      return !target?.disabled && terminal && target.created_ms === terminal.created_ms
        ? liveContext(registry[`${terminal.address}@${terminal.created_ms}`], terminal, now) : null;
    };
    this.request(frame, owner, cx);
    const result = this.result || { rows: [], agentOrder: [], pages: 1 }, rows = result.rows || [], t = theme(), st = frame.state || {}, collapsed = frame.collapsed, view = st.mode === "status" ? "status" : "project";
    if (this.result) setAgentOrder(result.agentOrder || []);
    const canonical = { groups: new Set((owner.lastGroups || []).map(group => group.key)), spaces: new Set((owner.lastRows || []).map(row => row.w?.id)) };
    const normalButton = (id, text, action, disabled = false) => div().id(id).h(CONTROL.height).px(5).py(0).flex_none().rounded(CONTROL.radius).text_size(TYPE.sm).line_height("16px").flex().gap(4).items_center().justify_center().text_color(disabled ? t.dim : t.muted).disabled(disabled)
      .when(disabled, el => el.opacity(0.4).cursor_default()).when(!disabled, el => el.cursor_pointer().hover(el => el.bg(t.hover).text_color(t.foreground)))
      .when(Boolean(action), el => el.on_click((_event, cx) => { cx.stop_propagation(); if (!disabled) action(cx); })).child(text);
    const iconButton = (id, icon, title, action, disabled = false) => normalButton(id, svg(icon).size(CONTROL.glyph).flex_none(), action, disabled).w(CONTROL.height).min_w(CONTROL.height).p(0).text_color(t.muted).when(!this.popupTooltipState?.open, el => el.tooltip(title)).accessibility_label(title);
    const changeView = (mode, cx) => { owner.save({ ...owner.state(), mode }); this.page = 0; this.cacheKey = null; cx.notify(); };
    const changeFilter = (filter, cx) => { owner.projectFilter = filter; setShared(FILTER_KEY, filter); this.page = 0; this.cacheKey = null; cx.notify(); };
    const dropdown = (id, trigger, options, current, choose) => {
      const pick = (key, cx) => { this.toolbarMenu = null; choose(key, cx); };
      const menu = v_flex().id(id + "-items").w(184).p(5).gap(1).rounded(6).border_1().border_color(t.border).bg(t.popover || t.surface).text_size(TYPE.md).text_color(t.foreground)
        .on_key_down((event, cx) => {
          const key = String(event.key || "").toLowerCase();
          if (["up", "arrowup", "down", "arrowdown"].includes(key)) this.toolbarIndex = ((this.toolbarIndex || 0) + (key === "up" || key === "arrowup" ? -1 : 1) + options.length) % options.length;
          else if (key === "enter") { cx.stop_propagation(); pick(options[this.toolbarIndex || 0][0], cx); return; }
          else if (key === "escape") this.toolbarMenu = null;
          else return;
          cx.stop_propagation(); cx.notify();
        })
        .children(options.map(([key, title], index) => h_flex().id(id + "-" + key).h(29).px(7).gap(7).items_center().rounded(4).cursor_pointer().when(this.toolbarMenu === id && this.toolbarIndex === index, el => el.bg(t.selected)).hover(el => el.bg(t.hover))
          .on_click((_event, cx) => { cx.stop_propagation(); pick(key, cx); })
          .child(div().size(13).flex_none().when(key === current, el => el.child(svg(chrome("check")).size(13).text_color(t.accent))))
          .child(div().flex_1().child(title))));
      return Popover.new(id).open(this.toolbarMenu === id).anchor("top_left")
        .on_open_change((open, cx) => {
          if (open) { this.toolbarMenu = id; this.toolbarIndex = Math.max(0, options.findIndex(([key]) => key === current)); }
          else if (this.toolbarMenu === id) this.toolbarMenu = null;
          cx.notify();
        }).trigger(trigger).content(menu);
    };
    const viewControl = normalButton("unified-view", div().child(view === "status" ? "Status" : "Projects"), null).accessibility_label("Workspace view").child(svg(chrome("chevron-down")).size(10));
    const filterControl = normalButton("unified-filter", div().child("Filter"), null).accessibility_label("Filter workspaces and tasks").when(frame.filter !== "all", el => el.text_color(t.accent)).child(svg(chrome("chevron-down")).size(10));
    const allMode = this.foldMode === "collapse" ? "expand" : "collapse";
    const railRows = collapsed ? rows.filter(row => row.target && row.kind !== "record") : [], focus = this.snapshots(frame).focus;
    const selectable = row => !row.target.disabled;
    const selected = railRows.find(row => selectable(row) && row.target.address && row.target.address === focus?.terminal)
      || railRows.find(row => selectable(row) && row.focused)
      || railRows.find(row => selectable(row) && row.target.kind === "tab" && row.target.tab === focus?.tab)
      || railRows.find(row => selectable(row) && row.target.kind === "space" && (focus?.space ? row.target.space === focus.space : row.active));
    const body = collapsed ? railRows.map(row => this.railRow(row, row === selected, frame, owner)) : rows.map((row, index) => this.draw(row, index, frame, owner, cx, canonical));
    return v_flex().id("unified-sidebar").size_full().min_h(0).min_w(0).bg(t.chrome).text_color(t.foreground).text_size(TYPE.md).track_focus(this.handle)
      .when(collapsed, el => el.child(v_flex().id(this.tooltipKey("unified-rail-controls")).flex_none().pt(7).pb(5).items_center().gap(4)
        .child(iconButton("unified-expand-sidebar", chrome("panel-left"), "Expand sidebar", () => owner.expandSidebar()).size(28).rounded(7))
        .child(iconButton("unified-new-space", chrome("plus"), "New space", () => run("space.new")).size(28).rounded(7))
        .child(div().w(20).h(1).mt(3).bg(t.border))))
      .when(!collapsed, el => el.child(v_flex().id(this.tooltipKey("unified-controls")).flex_none().px(7).pt(8).pb(5).gap(4)
        .child(div().id("unified-search").h(28).min_w(0).flex_none().px(7).bg(t.surface).border_1().border_color(t.input).rounded(6).child(Input.new(owner.queryInput).w_full().h_full()))
        .child(h_flex().id("unified-toolbar").w_full().min_w(0).h(28).gap(3).items_center()
          .child(dropdown("unified-view-menu", viewControl, [["project", "Projects"], ["status", "Status"]], view, changeView))
          .child(div().flex_1())
          .child(dropdown("unified-filter-menu", filterControl, [["all", "All"], ["active", "Active"], ["attention", "Needs attention"]], frame.filter, changeFilter))
          .child(iconButton("unified-toggle-all", `mods/files-plus/icons/${allMode}-all.svg`, allMode === "expand" ? "Expand all" : "Collapse all", cx => this.foldAll(this.foldMode === "collapse" ? "expand" : "collapse", cx)))
          .child(iconButton("unified-new-space", chrome("plus"), "New space", () => run("space.new")))
          .child(iconButton("unified-settings", "mods/files-plus/icons/more.svg", "Workspace actions", () => owner.viewMenu())))
        .when(frame.filter !== "all", el => el.child(h_flex().id("unified-filter-chip").min_w(0).h(22).px(5).gap(4).items_center().text_size(TYPE.xs).text_color(t.accent)
          .child(div().truncate().child(frame.filter === "active" ? "Active" : "Needs attention"))
          .child(iconButton("unified-clear-filter", chrome("x"), "Clear filter", cx => changeFilter("all", cx)))))))
      .child(v_flex().id("unified-sidebar-rows").flex_1().min_h(0).min_w(0).px(collapsed ? 2 : 6).gap(ROW_GAP).overflow_y_scrollbar()
        .on_mouse_up("left", (_event, cx) => { if (owner.drag) { owner.drag = owner.over = null; cx.notify(); } }).children(body)
        .when(!rows.length && !collapsed, el => el.child(div().px(8).py(12).text_size(TYPE.sm).text_color(t.dim).child(this.result ? "No matching workspaces or agents" : "Preparing workspace…")))
        .when(collapsed && !railRows.length, el => el.child(div().id("unified-rail-empty").h(32).flex().items_center().justify_center().text_color(t.dim).accessibility_label(this.result ? "No matching workspaces or agents" : "Preparing workspace…")
          .when(!this.popupTooltipState?.open, el => el.tooltip(this.result ? "No matching workspaces or agents" : "Preparing workspace…"))
          .child(svg(chrome(this.result ? "folder" : "spinner")).size(16)))))
      .when((result.pages || 1) > 1, el => el.child((collapsed ? v_flex() : h_flex()).id(this.tooltipKey("unified-page-controls")).flex_none().px(collapsed ? 0 : 6).py(5).gap(4).items_center()
        .child(iconButton("unified-prev", chrome("chevron-left"), "Previous page", cx => { this.page = Math.max(0, this.page - 1); this.cacheKey = null; cx.notify(); }, this.page <= 0))
        .child(div().when(!collapsed, el => el.flex_1()).text_center().text_size(TYPE.xs).text_color(t.dim).child(`${this.page + 1}/${result.pages}`))
        .child(iconButton("unified-next", chrome("chevron-right"), "Next page", cx => { this.page++; this.cacheKey = null; cx.notify(); }, this.page + 1 >= result.pages))))
      .when(Boolean(this.error), el => el.child(div().px(8).py(5).max_h(70).overflow_y_scrollbar().text_size(TYPE.xs).text_color(t.ansi1).child(this.error)))
      .when(Boolean(result.warnings?.length) && !collapsed, el => el.child(div().px(8).py(5).max_h(60).overflow_y_scrollbar().text_size(TYPE.xs).text_color(t.dim).child(result.warnings.join("\n"))));
  }
  close() { this.closed = true; this.handle?.release?.(); }
}
