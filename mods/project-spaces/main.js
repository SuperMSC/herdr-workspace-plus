import { TYPE } from "./type-scale.js";
import { privacyGuard } from "./privacy.js";
// Project Spaces: Herdr's Spaces sidebar, grouped by project.
//
// A project is a Git repository (its main checkout and linked worktrees together), else the
// folder a space is in. Drag a space onto another project, or use its menu, to move it there.
// The header's view menu switches grouping (Project / Status / None) and sorting (Manual /
// Recent). Folded groups, names, colors and order are kept in shared state.
// Git tracking, avatars and drag reordering derive from Herdr's shipped Spaces mod.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { spaces, machines, panes, agents, terminals, focused, run, exec, theme, shared, setShared, watchFolder, window, layout, props, home } from "herdr";
import {
  STATE_KEY, FILTER_KEY, DENSITY_KEY, SIDEBAR_COLUMNS, projectDensity, groupPath, spacePath, filterProjectGroups, projectMark, normalizeState, buildGroups, targetOrder, moves, assignSpace, moveGroup, toggleFold, prune, sameState,
} from "./model.js";
import { menuTooltipState, menuTooltipKey, endMenuTooltip } from "./menu-tooltip.js";
import { Menu, openMenu, menuRows } from "./menus.js";
import Prompt from "./prompt.js";
import UnifiedSidebar from "./unified.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map(c => c.id));
  return ps.find(p => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = path => path.replace(/\/+$/, "").split("/").pop();
const chrome = name => `mods/workspace-chrome/${name}.svg`;
// Changes made outside Herdr: looked for this often, in repos shown, while the window is in front.
const FALLBACK = 60000;

const glyph = status => (status === "blocked" || status === "done" ? "●" : "·");
const tone = (t, status) => t[status] ?? t.unknown;
const statusLabel = status => ({ blocked: "Needs you", done: "Done", working: "Working", idle: "Idle" }[status] || "Unknown");

export default class ProjectSpaces extends View {
  init(initial, cx) {
    this.p = props() ?? initial ?? {};
    const Role = this.p.role === "prompt" ? Prompt : ["space-menu", "group-menu", "view-menu"].includes(this.p.role) ? Menu : null;
    if (Role) {
      this.role = new Role();
      this.role.init(this.p, cx);
      return;
    }
    if (this.p.unified === true) {
      this.unifiedView = new UnifiedSidebar();
      this.unifiedView.init(this.p, cx);
      const state = this.state(); if (state.mode === "none") this.save({ ...state, mode: "project" });
    }
    this.queryText = ""; this.projectFilter = "all";
    this.queryInput = InputState.new({ placeholder: this.unifiedView ? "Search projects, tasks or folders…" : "Search projects, folders or branches…" });
    this.queryInput.on("change", (_event, cx) => { this.queryText = this.queryInput.value(); cx.notify(); });
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {};
    this.unsure = new Set();
    this.pending = new Set();
    this.busy = {};
    this.ready = {};
    this.at = {};
    this.watching = new Set();
    // New spaces wait a moment for their Git, so a worktree appears in its project at once.
    this.shown = new Set(spaces().map(s => s.id));
    this.born = {};
    this.drag = null; // { kind: "space" | "group", id }
    this.over = null; // the same shape, under the pointer
    this.hover = null; // the group header under the pointer
    this.ordering = null;
    this.home = home();
    cx.timer.every(250, cx => this.tick(cx));
    cx.timer.every(5000, () => this.tidy());
  }

  close(cx) {
    const popup = this.menuHoverScope ? menuTooltipState(this.menuHoverScope) : null;
    if (popup) endMenuTooltip(this.menuHoverScope, popup.token);
    this.role?.close?.(cx);
    this.unifiedView?.close?.(cx);
    this.queryInput?.release();
  }

  state() {
    return normalizeState(shared(STATE_KEY));
  }

  save(next) {
    if (!sameState(next, shared(STATE_KEY))) setShared(STATE_KEY, next);
  }

  tick(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    this.paint(sp);
    this.syncOrder(sp);
    if (sp.some(s => !this.shown.has(s.id))) cx.notify();
  }

  // Give every new space a color, as Herdr's Spaces does: the least used one.
  paint(sp) {
    const ids = new Set(sp.map(s => s.id));
    const stored = shared("space.colors") ?? {};
    const kept = Object.fromEntries(Object.entries(stored).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(stored).length;
    for (const s of sp) {
      if (kept[s.id] || s.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[s.id] = PALETTE.reduce((best, c) => (uses(c) < uses(best) ? c : best));
      changed = true;
    }
    if (changed && machines().every(m => m.layout === "ready")) setShared("space.colors", kept);
  }

  // Keep each project's spaces next to each other in Herdr's own order, so space.next/prev
  // and numbered selection follow the list. Only in Project + Manual, and only once settled.
  syncOrder(sp) {
    const st = this.state();
    if (st.mode !== "project" || st.sort !== "manual" || this.drag) return;
    if (sp.some(s => !this.shown.has(s.id)) || !machines().every(m => m.layout === "ready")) return;
    const target = targetOrder(buildGroups(this.rows(), st, { home: this.home }), st);
    const order = sp.map(s => s.id);
    const steps = moves(order, target ?? order);
    if (!steps.length) {
      this.ordering = null;
      return;
    }
    const key = JSON.stringify([order, target]);
    const now = Date.now();
    // A move can lose a sync race: let the echo settle, and stop after a few tries.
    if (this.ordering?.key === key && (now - this.ordering.at < 1000 || this.ordering.tries >= 3)) return;
    this.ordering = { key, at: now, tries: (this.ordering?.key === key ? this.ordering.tries : 0) + 1 };
    for (const step of steps) run("space.move", step);
  }

  // Forget moves of spaces that are gone, once every machine's spaces are known.
  tidy() {
    const sp = spaces();
    const st = this.state();
    if (!sp.length || !Object.keys(st.assign).length || !machines().every(m => m.layout === "ready")) return;
    this.save(prune(st, sp.map(s => s.id)));
  }

  // Places whose Git could have changed: new ones, where a command or an agent's turn just
  // ended, those on a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter(k => JSON.parse(k)[1]));
    const due = new Set([...keys].filter(k => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach(k => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) if ((this.git[k] || this.unsure.has(k)) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
    }
    return due;
  }

  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter(k => this.git[k]?.repo === repo) : [])];
  }

  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async cx => {
      while (this.pending.size) {
        const batch = [...this.pending];
        this.pending.clear();
        for (const key of batch) await this.check(key);
        cx.notify();
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map(g => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      for (const repo of used) this.watch(repo, cx);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's Git: branch, ahead/behind, its repository.
  async check(key) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks or fsmonitor: nothing written under .git wakes the watch again.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
    } catch {
      // The machine is away: keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async cx => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter(k => this.git[k]?.repo === mine), cx);
        }
      } catch {
        this.watching.delete(repo);
      }
    });
  }

  // Spaces with their Git and live folder; brand-new ones wait (at most 1.5 s) for Git.
  rows(sp = spaces(), ps = panes()) {
    const now = Date.now();
    const out = [];
    sp.forEach((w, i) => {
      const k = where(w, ps);
      if (!this.shown.has(w.id) && (k in this.git || now - (this.born[w.id] ??= now) > 1500)) this.shown.add(w.id);
      if (this.shown.has(w.id)) out.push({ w, i, g: this.git[k] ?? null, place: place(w, ps) });
    });
    return out;
  }

  // ---- pointer: click, drag a space or a project ----

  press(kind, id) {
    this.drag = { kind, id };
    this.over = { kind, id };
  }

  enter(kind, id, machine, cx) {
    if (!this.drag) return;
    // Herdr orders spaces per machine; a space can't land among another machine's.
    if (this.drag.kind === "space" && kind === "space") {
      const from = spaces().find(s => s.id === this.drag.id);
      if ((from?.machine ?? null) !== (machine ?? null)) return;
    }
    if (this.over?.kind !== kind || this.over.id !== id) {
      this.over = { kind, id };
      cx.notify();
    }
  }

  // A drop on a space: it moves there, and into that space's project.
  dropOnSpace(row, cx) {
    const drag = this.drag;
    this.drag = this.over = null;
    if (!drag) return;
    if (drag.kind === "space" && drag.id === row.w.id) run("space.select", { id: row.w.id });
    else if (drag.kind === "space") {
      const st = this.state();
      const source = this.lastRows?.find(r => r.w.id === drag.id);
      if (st.mode === "project" && source && row.key && source.key !== row.key) {
        this.save(assignSpace(st, drag.id, row.key, source.auto.key, this.lastGroups?.find(g => g.key === row.key)?.name));
      }
      const index = spaces().findIndex(s => s.id === row.w.id);
      if (index !== -1) run("space.move", { id: drag.id, index: index + 1 });
    }
    cx.notify();
  }

  // A drop on a project header: a space joins it; a project takes that place.
  dropOnGroup(group, cx) {
    const onFold = typeof group.onFold === "function" ? group.onFold : null;
    group = this.lastGroups?.find(row => row.key === group.key) || group;
    const drag = this.drag;
    this.drag = this.over = null;
    if (!drag) return;
    const st = this.state();
    if (drag.kind === "group" && drag.id === group.key) {
      if (onFold) onFold(cx);
      else this.save(toggleFold(st, group.key));
    }
    else if (drag.kind === "group" && st.mode === "project" && st.sort === "manual") {
      const shown = this.lastGroups.map(g => g.key);
      this.save(moveGroup(st, shown, drag.id, group.key, shown.indexOf(drag.id) < shown.indexOf(group.key)));
    } else if (drag.kind === "space" && st.mode === "project") {
      const source = this.lastRows?.find(r => r.w.id === drag.id);
      if (source && source.key !== group.key) {
        this.save(assignSpace(st, drag.id, group.key, source.auto.key, group.name));
        // Land after the project's last space.
        const sp = spaces();
        const last = Math.max(...group.rows.map(r => sp.findIndex(s => s.id === r.w.id)));
        const from = sp.findIndex(s => s.id === drag.id);
        if (last >= 0 && from >= 0) run("space.move", { id: drag.id, index: from < last ? last + 1 : last + 2 });
      }
    }
    cx.notify();
  }

  tooltipState() {
    if (!this.menuHoverScope) return null;
    return { token: `${this.menuHoverScope}:${this.menuHoverRevision}`, open: Boolean(menuTooltipState(this.menuHoverScope)) };
  }

  tooltipKey(id) {
    const state = this.tooltipState();
    return state ? menuTooltipKey(id, state) : id;
  }

  menuScope() {
    this.menuHoverScope ||= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.menuHoverRevision = (this.menuHoverRevision || 0) + 1;
    this.hover = null;
    if (this.unifiedView) this.unifiedView.hovered = null;
    return this.menuHoverScope;
  }

  // ---- menus ----

  spaceMenu(row) {
    const props = {
      space: { id: row.w.id, name: row.w.name, machine: row.w.machine ?? null, folder: row.place || row.w.folder },
      git: row.g ? (row.g.linked ? "linked" : "main") : null,
      auto: { key: row.auto.key, name: row.auto.name, folder: row.auto.folder },
      key: this.state().assign[row.w.id] ?? row.auto.key,
      groups: (this.lastProjects ?? []).map(g => ({ key: g.key, name: g.name })),
      ...(this.unifiedView ? { unified: true } : {}),
    };
    openMenu("space-menu", props, menuRows("space-menu", props), this.menuScope());
  }

  groupMenu(group) {
    const st = this.state();
    const props = {
      group: { key: group.key, name: group.name, folder: group.folder, machine: group.machine, custom: group.custom, manual: group.manual },
      shown: this.lastGroups.map(g => g.key),
      sort: st.sort,
      ...(this.unifiedView ? { unified: true, members: group.rows.map(row => ({ id: row.w.id, machine: row.w.machine ?? null, autoKey: row.auto.key })) } : {}),
    };
    openMenu("group-menu", props, menuRows("group-menu", props), this.menuScope());
  }

  viewMenu() {
    const props = { keys: (this.lastGroups ?? []).filter(g => g.header).map(g => g.key), ...(this.unifiedView ? { unified: true } : {}) };
    openMenu("view-menu", props, menuRows("view-menu", props), this.menuScope());
  }

  // ---- drawing ----

  // After the name: the branch (unless it repeats the name), the repository when it
  // isn't the project's own, and ahead/behind.
  gitTail(g, row, groupName, t) {
    const raw = g.branch ?? "detached";
    const same = a => a.toLowerCase() === row.w.name.toLowerCase();
    const branch = ["main", "master"].includes(raw) || same(raw) ? "" : raw;
    const repo = same(g.name) || g.name === groupName ? "" : g.name;
    const label = [repo, branch].filter(Boolean).join(" · ");
    return h_flex().flex_1().min_w(0).gap(5).justify_end().items_center().text_size(TYPE.sm).text_color(t.dim)
      .when(Boolean(label), el => el.child(div().min_w(0).truncate().child(label)))
      .when(g.ahead > 0, el => el.child(div().flex_none().text_color(t.ansi2).child(`↑${g.ahead}`)))
      .when(g.behind > 0, el => el.child(div().flex_none().text_color(t.ansi1).child(`↓${g.behind}`)));
  }

  trailingDock(id, pinControl, summary = null, tooltip = "", summaryWidth = 0) {
    const columns = SIDEBAR_COLUMNS, width = columns.pin + (summaryWidth ? columns.gap + summaryWidth : 0);
    return h_flex().id("sidebar-dock-" + id).w(width).min_w(width).flex_none().gap(columns.gap).items_center()
      .child(div().id("sidebar-pin-slot-" + id).size(columns.pin).flex_none().flex().items_center().justify_center().when(Boolean(pinControl), el => el.child(pinControl)))
      .when(summaryWidth > 0, el => el.child(h_flex().id("sidebar-summary-" + id).w(summaryWidth).min_w(0).h(columns.pin).flex_none().gap(4).items_center().justify_end().overflow_hidden().when(!this.tooltipState()?.open, el => el.tooltip(tooltip)).child(summary)));
  }

  line(t, before) {
    return div().absolute().left(0).right(0).h(2).bg(t.accent).when(before, l => l.top(0)).when(!before, l => l.bottom(0));
  }

  // Where a dragged space would land relative to `id`, in Herdr's order: above or below.
  before(id) {
    const sp = spaces();
    return sp.findIndex(s => s.id === this.drag?.id) > sp.findIndex(s => s.id === id);
  }

  groupHead(group, st, t, n, density = "detailed", tree = false, pinControl = null) {
    const project = st.mode === "project", location = project ? group.displayLocation === undefined ? groupPath(group, this.home) : group.displayLocation : null, details = density === "detailed" && location;
    const mark = projectMark(t, group.name, group.color);
    const target = this.drag && this.over?.kind === "group" && this.over.id === group.key && !(this.drag.kind === "group" && this.drag.id === group.key);
    const joining = target && this.drag.kind === "space" && project;
    const reordering = target && this.drag.kind === "group" && project && st.sort === "manual";
    const shown = (this.lastGroups ?? []).map(g => g.key);
    const above = shown.indexOf(this.drag?.id) > shown.indexOf(group.key);
    const hovered = this.hover === group.key;
    const loud = group.status === "blocked" || group.status === "done";
    const count = group.fullCount && group.fullCount !== group.rows.length ? String(group.rows.length) + "/" + String(group.fullCount) : String(group.rows.length);
    const newSpace = () => div().id("group-new-" + n).size(SIDEBAR_COLUMNS.pin).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(t.muted).hover(s => s.bg(t.selected).text_color(t.foreground)).when(!this.tooltipState()?.open, el => el.tooltip("New space in this project"))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => { cx.stop_propagation(); this.drag = this.over = null; })
      .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { folder: group.folder, machine: group.machine ?? "" }); })
      .child(svg(chrome("plus")).size(12));
    const treeTitle = tree ? h_flex().min_w(0).h(18).gap(5).items_center()
      .child(div().min_w(0).truncate().font_semibold().text_size(TYPE.md).line_height("18px").text_color(t.foreground).child(group.name))
      .when(group.folded && loud && project, el => el.child(div().size(5).flex_none().rounded(3).bg(tone(t, group.status)).when(!this.tooltipState()?.open, el => el.tooltip("Project activity: " + statusLabel(group.status))))) : null;
    const treeSummary = tree ? h_flex().w_full().min_w(0).gap(4).items_center().justify_end()
      .when(project && hovered && Boolean(group.folder), el => el.child(newSpace()))
      .when(!(project && hovered && group.folder), el => el.child(div().flex_1().min_w(0).truncate().text_size(TYPE.sm).text_color(t.dim).text_right().child(count))) : null;
    return h_flex().relative().id(this.tooltipKey(`group-${n}`)).h(details ? tree ? 40 : 46 : tree ? 28 : 30).when(!this.tooltipState()?.open, el => el.tooltip(location?.tooltip || group.name)).flex_none().mt(tree ? 0 : n ? 6 : 0).mb(0).pl(tree ? 4 : 6).pr(tree ? SIDEBAR_COLUMNS.inset : 4).gap(tree ? 5 : 7).items_center().when(tree, el => el.items_start().py(details ? 3 : 4)).rounded(tree ? 0 : 7)
      .when(joining && !tree, el => el.bg(t.selected).border_1().border_color(t.accent))
      .when(!joining && !tree, el => el.hover(s => s.bg(t.hover)))
      .when(group.active && group.folded && !tree, el => el.bg(t.raised))
      .when(this.drag?.kind === "group" && this.drag.id === group.key && this.over?.id !== group.key, el => el.opacity(0.5))
      .when(Boolean(reordering), el => el.child(this.line(t, above)))
      .on_hover((on, cx) => {
        const next = on ? group.key : this.hover === group.key ? null : this.hover;
        if (next !== this.hover) { this.hover = next; cx.notify(); }
      })
      .on_mouse_down("left", () => this.press("group", group.key))
      .on_mouse_move((_e, cx) => this.enter("group", group.key, group.machine, cx))
      .on_mouse_up("left", (_e, cx) => this.dropOnGroup(group, cx))
      .on_mouse_down("right", () => { if (project) this.groupMenu(group); })
      .child(h_flex().w(tree ? 18 : 11).when(tree, el => el.h(18)).flex_none().items_center().justify_center().child(svg(chrome(group.folded ? "chevron-right" : "chevron-down")).size(11).text_color(t.dim)))
      .when(project, el => el.child(h_flex().size(18).mr(tree ? 3 : 0).flex_none().rounded(5).bg(mark.background).items_center().justify_center()
        .text_size(TYPE.xs).font_bold().text_color(mark.foreground).child([...group.name][0]?.toUpperCase() ?? "?")))
      .when(!project, el => el.child(div().size(8).flex_none().rounded(4).bg(tone(t, group.statusGroup))))
      .child(v_flex().flex_shrink(1).when(tree, el => el.flex_1()).min_w(0).gap(2).child(tree ? treeTitle : div().truncate().font_medium().text_color(t.foreground).child(group.name))
        .when(Boolean(details), el => el.child(div().truncate().text_size(TYPE.xs).text_color(t.dim).when(tree, el => el.line_height("14px")).child(location.short))))
      .when(Boolean(project && (group.machine || location?.mixedMachines)), el => el.child(div().flex_none().text_size(TYPE.xs).text_color(t.dim).child(location?.mixedMachines ? "Mixed machines" : `@${group.machine}`)))
      .when(!tree, el => el.child(div().flex_1()))
      .when(!tree && group.folded && loud && project, el => el.child(div().flex_none().text_color(tone(t, group.status)).child("●")))
      .when(!tree && project && hovered && Boolean(group.folder), el => el.child(div().id(`group-new-${n}`).size(22).flex_none().flex().items_center().justify_center().rounded(5)
        .text_color(t.muted).hover(s => s.bg(t.selected).text_color(t.foreground)).when(!this.tooltipState()?.open, el => el.tooltip("New space in this project"))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_mouse_up("left", (_e, cx) => { cx.stop_propagation(); this.drag = this.over = null; })
        .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { folder: group.folder, machine: group.machine ?? "" }); })
        .child(svg(chrome("plus")).size(12))))
      .when(!tree && !(project && hovered && group.folder), el => el.child(div().flex_none().min_w(22).text_size(TYPE.sm).text_color(t.dim).text_right().pr(4).child(group.fullCount && group.fullCount !== group.rows.length ? `${group.rows.length}/${group.fullCount}` : String(group.rows.length))))
      .when(tree, el => el.child(this.trailingDock("group-" + n, pinControl, treeSummary, count + " spaces", SIDEBAR_COLUMNS.pin)))
      .when(!tree && Boolean(pinControl), el => el.child(pinControl));
  }

  // A project of one space it found on its own is drawn as that space's row, under the
  // project's color: a header over a single row would only repeat the name.
  solo(group, st) {
    return st.mode === "project" && (group.fullCount ?? group.rows.length) === 1 && !group.custom && !group.manual;
  }

  row(r, group, st, t, density = "detailed", tree = false, pinControl = null) {
    const w = r.w;
    const solo = this.solo(group, st);
    const nested = st.mode === "project" && group.header && !solo;
    const parentLocation = nested ? group.displayLocation === undefined ? groupPath(group, this.home) : group.displayLocation : null;
    const location = spacePath(r, group, this.home, nested, parentLocation), branch = r.g?.branch ?? "detached", showBranch = Boolean(r.g) && !["main", "master"].includes(branch);
    const details = density === "detailed" && (tree ? Boolean(location && !location.repeat || showBranch || solo && group.name !== w.name) : location && !location.repeat);
    const machineBadge = w.machine ? !nested || parentLocation?.mixed || (group.machine ?? null) !== w.machine ? `@${w.machine}` : "" : nested && (group.machine || parentLocation?.mixedMachines) ? "local" : "";
    const mark = projectMark(t, solo ? group.name : w.name, solo ? group.color : null);
    const target = this.drag?.kind === "space" && this.over?.kind === "space" && this.over.id === w.id && this.drag.id !== w.id;
    const loud = w.status === "blocked" || w.status === "done";
    const sourceMarker = nested
      ? r.g?.linked
        ? svg(chrome("branch")).size(13).flex_none().text_color(t.dim)
        : div().size(13).flex_none().flex().items_center().justify_center().when(Boolean(w.status) && w.status !== "idle", el => el.child(div().size(6).rounded(3).bg(tone(t, w.status)).when(!this.tooltipState()?.open, el => el.tooltip("Directory activity: " + statusLabel(w.status)))))
      : h_flex().size(18).flex_none().rounded(5).bg(mark.background).items_center().justify_center()
        .text_size(TYPE.xs).font_bold().text_color(mark.foreground).child([...w.name][0]?.toUpperCase() ?? "?");
    const treeMarker = nested ? svg(chrome(r.g?.linked ? "branch" : "folder")).size(14).text_color(t.muted || t.dim) : sourceMarker;
    const marker = tree ? h_flex().w(18).h(18).mr(3).flex_none().items_center().justify_center().child(treeMarker) : sourceMarker;
    const summaryTooltip = r.g ? [r.g.name, r.g.branch ?? "detached", r.g.ahead > 0 ? "Ahead: " + r.g.ahead : "", r.g.behind > 0 ? "Behind: " + r.g.behind : ""].filter(Boolean).join("\n") : solo && group.name !== w.name ? group.name : "";
    const relative = location && !location.repeat ? location.short : "";
    const treeDetails = tree && details ? h_flex().id("sidebar-details-space-" + w.id).min_w(0).h(12).gap(5).items_center().text_size(TYPE.xs).line_height("12px").text_color(t.dim).when(!this.tooltipState()?.open, el => el.tooltip([summaryTooltip, location?.tooltip].filter(Boolean).join("\n")))
      .when(showBranch, el => el.child(h_flex().min_w(0).flex_shrink(1).max_w(160).gap(3).items_center()
        .child(svg(chrome("branch")).size(10).flex_none())
        .child(div().min_w(0).truncate().child(branch))
        .when(r.g?.ahead > 0, el => el.child(div().flex_none().text_color(t.ansi2).child(`↑${r.g.ahead}`)))
        .when(r.g?.behind > 0, el => el.child(div().flex_none().text_color(t.ansi1).child(`↓${r.g.behind}`)))))
      .when(Boolean(showBranch && relative), el => el.child(div().flex_none().child("·")))
      .when(Boolean(relative), el => el.child(div().flex_1().min_w(0).truncate().child(relative)))
      .when(!r.g && !relative && solo && group.name !== w.name, el => el.child(div().flex_1().min_w(0).truncate().child(group.name))) : null;
    return h_flex().relative().id(this.tooltipKey(`space-${w.id}`)).h(details ? tree ? 38 : 46 : tree ? 28 : nested ? 28 : 30).when(!this.tooltipState()?.open, el => el.tooltip(tree ? [location?.tooltip || w.name, summaryTooltip, w.status].filter(Boolean).join("\n") : location?.tooltip || w.name)).flex_none().pl(tree ? 0 : nested ? 26 : 8).pr(tree ? 0 : 8).gap(tree ? 5 : 9).items_center().when(tree, el => el.items_start().py(details ? 3 : 4)).rounded(tree ? 0 : 8)
      .when(w.active && !tree, el => el.bg(t.selected))
      .when(!w.active && !tree, el => el.hover(s => s.bg(t.hover)))
      .when(this.drag?.kind === "space" && this.drag.id === w.id && this.over?.id !== w.id, el => el.opacity(0.5))
      .when(target, el => el.child(this.line(t, this.before(w.id))))
      .on_mouse_down("left", () => this.press("space", w.id))
      .on_mouse_move((_e, cx) => this.enter("space", w.id, w.machine, cx))
      .on_mouse_up("left", (_e, cx) => this.dropOnSpace(r, cx))
      .on_mouse_down("right", () => this.spaceMenu(r))
      .child(marker)
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().min_w(0).gap(6).items_center().when(tree, el => el.h(18).line_height("18px")).child(div().flex_shrink(0).when(!tree, el => el.max_w(nested ? 140 : 150)).when(tree, el => el.flex_shrink(1).min_w(0)).truncate().text_color(t.foreground).when(tree, el => el.font_medium().text_size(TYPE.md).when(!nested, el => el.font_semibold().text_size(TYPE.md))).child(w.name))
          .when(Boolean(machineBadge), el => el.child(div().flex_none().text_size(TYPE.xs).text_color(t.dim).child(machineBadge)))
          .when(tree && (nested && Boolean(w.status) && w.status !== "idle" || !nested && loud), el => el.child(div().size(5).flex_none().rounded(3).bg(tone(t, w.status)).when(!this.tooltipState()?.open, el => el.tooltip("Directory activity: " + statusLabel(w.status)))))
          .when(!tree, el => el.child(r.g ? this.gitTail(r.g, r, nested ? group.name : "", t)
            : solo && group.name !== w.name ? h_flex().flex_1().min_w(0).justify_end().text_size(TYPE.sm).text_color(t.dim).child(div().min_w(0).truncate().child(group.name))
            : div().flex_1())))
        .when(!tree && Boolean(details), el => el.child(div().truncate().text_size(TYPE.xs).text_color(t.dim).child(location.short)))
        .when(Boolean(treeDetails), el => el.child(treeDetails)))
      .when(!tree && !nested && loud, el => el.child(div().flex_none().text_color(tone(t, w.status)).child("●")))
      .when(tree, el => el.child(this.trailingDock("space-" + w.id, pinControl)))
      .when(!tree && Boolean(pinControl), el => el.child(pinControl));
  }

  compact(r, t) {
    const w = r.w;
    return h_flex().id(this.tooltipKey(`space-${w.id}`)).when(!this.tooltipState()?.open, el => el.tooltip(spacePath(r, {}, this.home)?.tooltip || w.name)).h(26).flex_none().justify_center().gap(4)
      .when(w.active, el => el.bg(t.raised))
      .hover(s => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(r.i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render(cx) {
    const mask = privacyGuard("Projects", this.p); if (mask) return mask;
    if (this.role) return this.role.render(cx);
    const filter = shared(FILTER_KEY);
    if (["all", "active", "attention"].includes(filter)) this.projectFilter = filter;
    const t = theme();
    const collapsed = narrow();
    const st = this.state();
    const snapshots = this.unifiedView ? { spaces: spaces(), agents: agents(), terminals: terminals(), panes: panes(), focus: focused() } : null;
    const grouping = this.unifiedView ? { ...st, mode: "project" } : st;
    const groups = buildGroups(snapshots ? this.rows(snapshots.spaces, snapshots.panes) : this.rows(), grouping, { home: this.home });
    for (const group of groups) group.displayLocation = grouping.mode === "project" ? groupPath(group, this.home) : null;
    this.lastGroups = groups;
    this.lastRows = groups.flatMap(g => g.rows);
    // Projects a space can move to, whatever is shown now.
    this.lastProjects = this.unifiedView || st.mode === "project" ? groups : buildGroups(this.lastRows, { ...st, mode: "project" }, { home: this.home });
    const title = st.mode === "project" ? "Projects" : "Spaces", density = projectDensity(shared(DENSITY_KEY));
    if (this.unifiedView) return this.unifiedView.render({ groups, fullGroups: groups, state: st, density, query: this.queryText, filter: this.projectFilter, collapsed, snapshots, home: this.home, popupTooltipState: this.tooltipState() }, this, cx);
    const filteredGroups = filterProjectGroups(groups, { query: this.queryText, filter: this.projectFilter });
    const button = (id, icon, tip, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).when(!this.tooltipState()?.open, el => el.tooltip(tip)).on_click(action).child(svg(chrome(icon)).size(14));
    const body = collapsed
      ? filteredGroups.flatMap(g => g.rows).map(r => this.compact(r, t))
      : filteredGroups.flatMap((g, n) => this.solo(g, st) ? [this.row(g.rows[0], g, st, t, density)] : [
        ...(g.header ? [this.groupHead(g, st, t, n, density)] : []),
        ...(g.folded ? [] : g.rows.map(r => this.row(r, g, st, t, density))),
      ]);
    if (!collapsed && !body.length && !this.queryText && this.projectFilter === "all") {
      body.push(h_flex().id("space-empty").h(28).flex_none().px(8).gap(7).items_center().rounded(7).text_size(TYPE.md).text_color(t.dim)
        .hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(() => run("space.new"))
        .child(svg(chrome("plus")).size(12)).child(machines().some(m => m.layout === "loading") ? "Loading…" : "New space"));
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(TYPE.md).text_color(t.dim)
      .child(h_flex().id(this.tooltipKey("space-toolbar")).h(31).pl(16).pr(10).gap(2).items_center().text_size(TYPE.sm)
        .when(!collapsed, el => el.child(div().flex_1().child(title)).child(button("space-view", "layers", "Group, sort and display", () => this.viewMenu())))
        .when(collapsed, el => el.justify_center())
        .child(button("space-new", "plus", "New space", () => run("space.new"))))
      .when(!collapsed, el => el.child(v_flex().flex_none().px(8).pb(6).gap(5)
        .child(Input.new(this.queryInput).h(28).px(7).bg(t.surface).border_1().border_color(t.input).rounded(5))
        .child(h_flex().gap(3).children([["all", "All"], ["active", "Active"], ["attention", "Needs attention"]].map(([key, label]) => div().id(`project-filter-${key}`).px(6).py(4).rounded(4).text_size(TYPE.xs).bg(this.projectFilter === key ? t.selected : t.raised).text_color(this.projectFilter === key ? t.foreground : t.dim).cursor_pointer().on_click((_event, cx) => { this.projectFilter = key; setShared(FILTER_KEY, key); cx.notify(); }).child(label))))))
      .when(!collapsed && !body.length, el => el.child(div().px(14).py(8).text_size(TYPE.sm).text_color(t.dim).child("No matching spaces")))
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => {
          if (this.drag) { this.drag = this.over = null; cx.notify(); }
        })
        .children(body));
  }
}

