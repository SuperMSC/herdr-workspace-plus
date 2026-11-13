import { TYPE } from "./type-scale.js";
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { shared, setShared, theme, exec, pickFolder, spaces, closeOverlay } from "herdr";
import { WORKSPACES_KEY, ROOT_LIMIT, workspaceKey, workspaceRoots, normalizeWorkspaceRoot, addWorkspaceRoot, saveWorkspace, resetWorkspace } from "./workspace-model.js";

export default class WorkspaceRoots {
  init(p, cx) {
    this.p = p; this.context = { ...p.context }; this.expected = JSON.stringify(shared(WORKSPACES_KEY)?.workspaces?.[workspaceKey(this.context)] ?? null);
    this.roots = workspaceRoots(shared(WORKSPACES_KEY), this.context).map(root => ({ ...root }));
    this.input = InputState.new({ placeholder: this.context.on ? "Absolute folder on this machine…" : "Absolute folder path…" });
    this.input.on("submit", (_event, cx) => this.add(this.input.value(), cx));
    this.error = ""; this.busy = false; this.handle = cx.focus_handle(); this.handle.focus();
  }
  active() { return !this.context.space || spaces().some(space => space.id === this.context.space); }
  add(value, cx) {
    if (this.busy) return;
    let path;
    try { path = normalizeWorkspaceRoot(value); addWorkspaceRoot(this.roots, path); }
    catch (error) { this.error = String(error.message || error); cx.notify(); return; }
    this.busy = true; this.error = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await exec("sh", ["-c", 'test -d "$1"', "workspace-folder", path], { on: this.context.on ?? null, timeout: 8000 });
        if (result.code !== 0) throw new Error("The selected folder is unavailable on this machine.");
        if (this.disposed) return;
        if (!this.active()) throw new Error("The captured workspace has closed. No mapping was saved.");
        this.roots = addWorkspaceRoot(this.roots, path); this.input.set_value("");
      } catch (error) { if (!this.disposed) this.error = String(error.message || error); }
      finally { this.busy = false; if (!this.disposed) cx.notify(); }
    });
  }
  pick(cx) {
    if (this.busy || this.context.on) return;
    this.busy = true; cx.notify();
    cx.spawn(async cx => {
      let path;
      try { path = await pickFolder({ prompt: "Add workspace folder" }); }
      catch (error) { if (!this.disposed) this.error = String(error.message || error); }
      finally { this.busy = false; if (!this.disposed) { if (path) this.add(path, cx); else cx.notify(); } }
    });
  }
  move(index, step, cx) {
    if (this.busy || index + step < 0 || index + step >= this.roots.length) return;
    [this.roots[index], this.roots[index + step]] = [this.roots[index + step], this.roots[index]]; cx.notify();
  }
  save(cx, reset = false) {
    if (this.busy) return;
    try {
      if (!this.active()) throw new Error("The captured workspace has closed.");
      const state = shared(WORKSPACES_KEY), next = reset ? resetWorkspace(state, this.context, this.expected) : saveWorkspace(state, this.context, this.roots, this.expected);
      setShared(WORKSPACES_KEY, next); closeOverlay(this.p.overlay);
    } catch (error) { this.error = String(error.message || error); cx.notify(); }
  }
  close() { this.disposed = true; this.input?.release(); }
  render() {
    const t = theme(), button = (id, label, action, disabled = false) => div().id(id).h(28).px(8).rounded(5).bg(t.raised).text_color(disabled ? t.dim : t.foreground).flex().items_center().when(!disabled, el => el.cursor_pointer().hover(row => row.bg(t.hover))).on_click((_e, cx) => { if (!disabled) action(cx); }).child(label);
    return v_flex().id("workspace-folders").size_full().min_h(0).p(16).gap(9).rounded(10).border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(TYPE.md).track_focus(this.handle)
      .on_key_down((event, cx) => { if (event.key === "escape" && !this.busy) { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(div().font_semibold().text_size(TYPE.lg).child("Workspace folders"))
      .child(div().text_color(t.muted).child(`Folders stay attached to this workspace, including while a linked file is focused. Up to ${ROOT_LIMIT} folders on ${this.context.on || "this computer"}.`))
      .child(v_flex().id("workspace-folder-list").flex_1().min_h(0).gap(6).overflow_y_scrollbar().children(this.roots.map((root, index) => h_flex().id(`workspace-folder-${index}`).gap(6).py(5).items_center()
        .child(v_flex().flex_1().min_w(0).child(div().font_semibold().truncate().child(root.name)).child(div().text_size(TYPE.xs).text_color(t.dim).truncate().tooltip(root.path).child(root.path)))
        .child(button(`workspace-up-${index}`, "↑", cx => this.move(index, -1, cx), this.busy || index === 0))
        .child(button(`workspace-down-${index}`, "↓", cx => this.move(index, 1, cx), this.busy || index === this.roots.length - 1))
        .child(button(`workspace-remove-${index}`, "Remove", cx => { this.roots = this.roots.filter((_, at) => at !== index); cx.notify(); }, this.busy || this.roots.length < 2)))))
      .child(h_flex().flex_none().gap(6).child(Input.new(this.input).h(30).px(8).flex_1().min_w(0).bg(t.background).border_1().border_color(t.input).rounded(5))
        .child(button("workspace-add-path", this.busy ? "Checking…" : "Add", cx => this.add(this.input.value(), cx), this.busy)))
      .when(!this.context.on, el => el.child(button("workspace-pick-folder", "Choose folder…", cx => this.pick(cx), this.busy)))
      .when(Boolean(this.error), el => el.child(div().text_color(t.ansi1).child(this.error)))
      .child(div().text_size(TYPE.xs).text_color(t.dim).child("Remove and Reset change the workspace mapping only; files are never removed."))
      .child(h_flex().flex_none().gap(6).justify_end().child(button("workspace-reset", "Reset to current folder", cx => this.save(cx, true), this.busy))
        .child(button("workspace-cancel", "Cancel", () => closeOverlay(this.p.overlay), this.busy)).child(button("workspace-save", "Save folders", cx => this.save(cx), this.busy)));
  }
}
