// Popup menus for Project Spaces: a space's menu, a project group's menu, and the view menu.
// Each is the same mod opened as an overlay with props.role; changes go through shared state.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, closeOverlay, openOverlay, theme, shared, setShared } from "herdr";
import { STATE_KEY, DENSITY_KEY, DENSITIES, projectDensity, MODES, SORTS, PALETTE, MARK, normalizeState, assignSpace, setGroupColor, stepGroup, ungroup, foldAll } from "./model.js";

export const MOD = "project-spaces";
// Projects listed under "Move to project"; the rest are reached by dragging.
const MAX_TARGETS = 8;
const icon = name => `mods/workspace-chrome/${name}.svg`;
const state = () => normalizeState(shared(STATE_KEY));
const save = next => setShared(STATE_KEY, next);

/** Open the rename / new-project dialog. */
export function openPrompt(props) {
  openOverlay({ mod: MOD, kind: "dialog", frame: "none", width: 400, height: 214, props: { role: "prompt", ...props } });
}

/** Open a menu role at the pointer, sized to its rows. */
export function openMenu(role, props, rows) {
  openOverlay({ mod: MOD, kind: "popup", width: 220, height: Math.min(460, 14 + rows * 31), props: { role, ...props } });
}

function spaceItems(p) {
  const s = p.space ?? {};
  const st = state();
  const items = [{ label: "Rename", icon: "square-pen", act: () => run("space.rename", { id: s.id }) }];
  const folder = p.auto?.folder || s.folder;
  if (folder) {
    items.push({ label: "Project notes", icon: "file-text", act: () => openOverlay({ mod: "sessions-plus", kind: "dialog", frame: "none", width: 800, height: 680, props: { role: "notes", project: { root: folder, on: s.machine ?? null }, initial: "project" } }) });
    items.push({ label: "Project commands", icon: "terminal", act: () => openOverlay({ mod: "sessions-plus", kind: "dialog", frame: "none", width: 820, height: 680, props: { role: "commands", context: { root: folder, on: s.machine ?? null } } }) });
  }
  if (p.git) {
    items.push({ label: "New worktree", icon: "git-branch", act: () => openOverlay({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { space: s.id, action: "new" } }) });
    items.push({ label: "Open worktree", icon: "git-branch", act: () => openOverlay({ mod: "worktree", kind: "dialog", width: 560, height: 480, props: { space: s.id, action: "open" } }) });
  }
  if (p.git === "linked") items.push({ label: "Remove worktree", icon: "git-branch", act: () => openOverlay({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { space: s.id, action: "remove" } }) });
  items.push({ section: "Move to project" });
  const targets = (p.groups ?? []).filter(g => g.key !== p.key);
  for (const g of targets.slice(0, MAX_TARGETS)) {
    items.push({ label: g.name, icon: "folder", act: () => save(assignSpace(state(), s.id, g.key, p.auto.key, g.name)) });
  }
  items.push({ label: "New project…", icon: "folder-plus", act: () => openPrompt({ action: "new-group", space: s.id, autoKey: p.auto.key, title: "New project" }) });
  if (p.key !== p.auto.key || st.assign[s.id]) {
    items.push({ label: `Back to ${p.auto.name}`, icon: "folder", hint: "auto", act: () => save(assignSpace(state(), s.id, p.auto.key, p.auto.key)) });
  }
  items.push({ separator: true }, { label: "Close space", icon: "x", danger: true, act: () => run("space.close", { id: s.id }) });
  return items;
}

function groupItems(p) {
  const g = p.group ?? {};
  const shown = p.shown ?? [];
  const at = shown.indexOf(g.key);
  const items = [];
  if (g.folder) items.push({ label: "New space here", icon: "plus", act: () => run("space.new", { folder: g.folder, machine: g.machine ?? "" }) });
  if (g.folder) {
    items.push({ label: "Project notes", icon: "file-text", act: () => openOverlay({ mod: "sessions-plus", kind: "dialog", frame: "none", width: 800, height: 680, props: { role: "notes", project: { root: g.folder, on: g.machine ?? null }, initial: "project" } }) });
    items.push({ label: "Project commands", icon: "terminal", act: () => openOverlay({ mod: "sessions-plus", kind: "dialog", frame: "none", width: 820, height: 680, props: { role: "commands", context: { root: g.folder, on: g.machine ?? null } } }) });
  }
  items.push({ label: "Rename project…", icon: "square-pen", act: () => openPrompt({ action: "rename-group", key: g.key, value: g.name, title: "Rename project" }) });
  items.push({ swatches: true, key: g.key });
  if (p.sort === "manual") {
    items.push({ separator: true });
    items.push({ label: "Move up", icon: "chevron-left", disabled: at <= 0, act: () => save(stepGroup(state(), shown, g.key, -1)) });
    items.push({ label: "Move down", icon: "chevron-right", disabled: at === -1 || at >= shown.length - 1, act: () => save(stepGroup(state(), shown, g.key, 1)) });
  }
  if (g.custom || g.manual) {
    items.push({ separator: true });
    items.push({ label: g.custom ? "Dissolve project" : `Release moved spaces (${g.manual})`, icon: "x", danger: Boolean(g.custom), act: () => save(ungroup(state(), g.key)) });
  }
  return items;
}

function viewItems(p) {
  const st = state();
  const keys = p.keys ?? [];
  const items = [{ section: "Display" }];
  for (const density of DENSITIES) items.push({ label: density.label, checked: projectDensity(shared(DENSITY_KEY)) === density.id, keep: true, act: () => setShared(DENSITY_KEY, density.id) });
  items.push({ section: "Group by" });
  for (const m of MODES) items.push({ label: m.label, checked: st.mode === m.id, keep: true, act: () => save({ ...state(), mode: m.id }) });
  items.push({ section: "Sort" });
  for (const s of SORTS) items.push({ label: s.label, hint: s.about, checked: st.sort === s.id, keep: true, act: () => save({ ...state(), sort: s.id }) });
  if (st.mode !== "none" && keys.length) {
    items.push({ separator: true });
    items.push({ label: "Collapse all", icon: "chevron-right", act: () => save(foldAll(state(), keys, true)) });
    items.push({ label: "Expand all", icon: "chevron-down", act: () => save(foldAll(state(), keys, false)) });
  }
  return items;
}

/** How many rows a menu needs, for its popup height. */
export function menuRows(role, p) {
  const list = role === "space-menu" ? spaceItems(p) : role === "group-menu" ? groupItems(p) : viewItems(p);
  return list.reduce((n, it) => n + (it.separator ? 0.3 : it.section ? 0.8 : 1), 0);
}

export class Menu {
  init(p, cx) {
    this.p = p;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.at = this.items().findIndex(it => it.act && !it.disabled);
  }

  items() {
    return this.p.role === "space-menu" ? spaceItems(this.p) : this.p.role === "group-menu" ? groupItems(this.p) : viewItems(this.p);
  }

  choose(i, cx) {
    const it = this.items()[i];
    if (!it?.act || it.disabled) return;
    if (!it.keep) closeOverlay(this.p.overlay);
    it.act();
    cx?.notify();
  }

  step(list, by) {
    const usable = list.map((it, i) => (it.act && !it.disabled ? i : -1)).filter(i => i !== -1);
    if (!usable.length) return;
    const now = usable.indexOf(this.at);
    this.at = usable[(now + by + usable.length) % usable.length];
  }

  swatches(key, t) {
    const current = state().groups[key]?.color ?? null;
    const dot = (color, n) => div().id(`swatch-${n}`).size(18).rounded(9).cursor_pointer()
      .bg(color ? MARK[color] ?? t[color] : t.raised).border_2().border_color(current === color ? t.foreground : t.popover)
      .when(!color, el => el.border_color(current === null ? t.foreground : t.border))
      .tooltip(color ? "Project color" : "Automatic color")
      .on_click((_e, cx) => { save(setGroupColor(state(), key, color)); cx.notify(); });
    return h_flex().h(31).px(9).gap(8).items_center()
      .children([...PALETTE.map((c, n) => dot(c, n)), dot(null, "auto")]);
  }

  render() {
    const t = theme();
    const list = this.items();
    // A popup is as tall as its content: no flex_1 or scroll wrapper, or it measures 0.
    return v_flex().id("project-spaces-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.step(list, 1);
        else if (e.key === "up") this.step(list, -1);
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(this.p.overlay);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .children(list.map((it, i) => {
        if (it.separator) return div().mx(7).my(4).h(1).flex_none().bg(t.border);
        if (it.section) return div().h(24).flex_none().px(9).pt(6).text_size(11).text_color(t.dim).child(it.section);
        if (it.swatches) return this.swatches(it.key, t);
        const tint = it.disabled ? t.dim : it.danger ? t.ansi1 : t.foreground;
        return h_flex().id(`pm-${i}`).h(31).flex_none().px(8).gap(9).rounded(7).items_center().text_color(tint)
          .when(!it.disabled, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
          .when(i === this.at && !it.disabled, el => el.bg(t.selected))
          .on_mouse_move((_e, cx) => { if (it.act && !it.disabled && this.at !== i) { this.at = i; cx.notify(); } })
          .on_click((_e, cx) => this.choose(i, cx))
          .child(it.checked !== undefined
            ? div().size(14).flex_none().child(it.checked ? svg(icon("check")).size(14).text_color(t.accent) : div())
            : svg(icon(it.icon ?? "terminal")).size(14).flex_none().text_color(it.danger ? t.ansi1 : t.muted))
          .child(div().flex_1().min_w(0).truncate().child(it.label))
          .when(Boolean(it.hint), el => el.child(div().flex_none().max_w(110).truncate().text_size(11).text_color(t.dim).child(it.hint)));
      }));
  }
}
