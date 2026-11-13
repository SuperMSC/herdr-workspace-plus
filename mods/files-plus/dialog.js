import { TYPE } from "./type-scale.js";
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { closeOverlay, exec, theme } from "herdr";
import { createGitActions } from "./git-actions.js";
import { createFilesystem, validateName } from "./filesystem.js";
import { localActions, creationFolder } from "./model.js";
import { changed } from "./menu.js";
import { fileIcon } from "./icons.js";

const TITLES = { createFile: "New File", createFolder: "New Folder", rename: "Rename", trash: "Move to Trash?", stage: "Stage File", unstage: "Unstage File" };

export default class Dialog {
  init(p, cx) {
    this.p = p;
    this.target = p.target;
    this.action = p.action;
    this.immediate = ["stage", "unstage"].includes(p.action);
    this.text = p.action === "rename" ? p.target?.name ?? "" : "";
    this.error = "";
    this.busy = false;
    this.handle = cx.focus_handle();
    if (p.action === "trash" || this.immediate) this.handle.focus();
    else {
      this.input = InputState.new({ value: this.text, placeholder: p.action === "createFolder" ? "Folder name" : "File name" });
      this.input.on("change", (_event, cx) => { this.text = this.input.value(); this.error = ""; cx.notify(); });
      this.input.on("submit", (_event, cx) => this.submit(cx));
      this.input.focus();
    }
    if (this.immediate) this.submit(cx);
  }

  submit(cx) {
    if (this.busy) return;
    try {
      if (!localActions(this.target)) throw new Error("File actions require local macOS.");
      if (!TITLES[this.action]) throw new Error("Unknown file action.");
      if (this.target.isRoot && ["rename", "trash"].includes(this.action)) throw new Error("The browser root cannot be renamed or trashed.");
      if (["createFile", "createFolder", "rename"].includes(this.action)) validateName(this.text);
    } catch (error) { this.error = String(error.message ?? error); cx.notify(); return; }
    this.busy = true; this.error = ""; cx.notify();
    const { action, target, text } = this;
    cx.spawn(async cx => {
      try {
        const fs = createFilesystem(exec, target);
        if (action === "stage" || action === "unstage") await createGitActions(exec, target)[action](target.relative);
        else if (action === "createFile" || action === "createFolder") await fs[action](creationFolder(target), text);
        else if (action === "rename") await fs.rename(target.path, text);
        else await fs.trash(target.path);
        changed(target, action, text);
        closeOverlay(this.p.overlay);
      } catch (error) { this.error = String(error.message ?? error); }
      finally { this.busy = false; cx.notify(); }
    });
  }

  render() {
    const t = theme(), trash = this.action === "trash";
    const creating = ["createFile", "createFolder"].includes(this.action);
    const tone = trash ? t.blocked : t.accent;
    const path = creating && this.target ? creationFolder(this.target) : this.target?.path;
    const name = path ? path.split("/").filter(Boolean).pop() ?? path : "No file selected";
    const parent = path ? path.slice(0, Math.max(0, path.length - name.length - 1)) || "/" : "";
    const isFolder = creating || this.target?.dir;
    const icon = trash ? "trash" : isFolder ? "folder" : "file";
    const note = this.immediate ? "Updating this file’s Git index entry. Working files are kept."
      : trash ? (isFolder ? "The folder and everything in it go to the macOS Trash. You can put them back from there." : "It goes to the macOS Trash. You can put it back from there.")
      : "Existing items are never replaced.";
    const label = this.busy ? "Working…" : this.immediate ? "Retry" : trash ? "Move to Trash" : this.action === "rename" ? "Rename" : "Create";

    const button = (id, text, primary, click) => h_flex().id(id).h(32).px(14).gap(8).items_center().rounded(8).text_size(TYPE.md)
      .font_medium().border_1().cursor_pointer().hover(s => s.opacity(0.88)).when(this.busy, el => el.opacity(0.5))
      .border_color(primary ? (trash ? (t.danger || t.blocked) : t.solid) : t.input)
      .bg(primary ? (trash ? (t.danger || t.blocked) : t.solid) : t.raised)
      .text_color(primary ? (trash ? (t.danger_foreground || "#ffffff") : t.solid_foreground) : t.foreground)
      .on_click(click).child(text)
      .when(primary && !this.busy && (trash || this.immediate), el => el.child(div().text_size(TYPE.sm).opacity(0.7).child("↵")));

    const target = h_flex().flex_none().gap(10).items_center().px(12).py(9).rounded(8).border_1().border_color(t.border).bg(t.background)
      .child(fileIcon(path ?? "", Boolean(isFolder)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(TYPE.md).font_medium().text_color(t.foreground).truncate().child(name))
        .when(Boolean(parent), el => el.child(div().text_size(TYPE.sm).text_color(t.dim).truncate().text_ellipsis_start().child(parent))));

    return v_flex().id("files-plus-dialog").track_focus(this.handle).size_full().min_h(0).px(20).pt(20).pb(18).gap(14)
      .rounded(12).overflow_hidden().border_1().border_color(t.border).bg(t.popover).text_size(TYPE.md).text_color(t.foreground)
      .on_key_down((event, cx) => {
        if (event.key === "escape") { if (!this.busy) closeOverlay(this.p.overlay); }
        else if (event.key === "enter" && (trash || this.immediate)) this.submit(cx);
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().flex_none().gap(12).items_start()
        .child(h_flex().size(36).flex_none().items_center().justify_center().rounded(10).bg(tone + "1f")
          .child(svg(`mods/files-plus/${icon}.svg`).size(16).text_color(tone)))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().text_size(TYPE.lg).font_semibold().child(TITLES[this.action] ?? "File action"))
          .child(div().text_size(TYPE.md).text_color(t.muted).child(note)))
        .child(div().flex_none().px(6).h(20).flex().items_center().rounded(5).border_1().border_color(t.border)
          .text_size(TYPE.xs).text_color(t.dim).child("Esc")))
      .child(target)
      .when(!trash && !this.immediate, el => el.child(h_flex().h(36).px(10).flex_none().items_center().rounded(8).border_1()
        .border_color(t.input).bg(t.background).child(Input.new(this.input).w_full().h_full().text_color(t.foreground))))
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().text_size(TYPE.md).text_color(t.blocked).child(this.error || ""))
      .child(h_flex().flex_none().justify_end().gap(8)
        .when(!this.immediate, el => el.child(button("files-plus-cancel", "Cancel", false, () => { if (!this.busy) closeOverlay(this.p.overlay); })))
        .child(button("files-plus-confirm", label, true, (_event, cx) => this.submit(cx))));
  }
}
