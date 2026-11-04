import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { closeOverlay, exec, theme } from "herdr";
import { createGitActions } from "./git-actions.js";
import { createFilesystem, validateName } from "./filesystem.js";
import { localActions, creationFolder } from "./model.js";
import { changed } from "./menu.js";

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
    const button = (id, label, primary, click) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .bg(primary ? (trash ? t.ansi1 : t.solid) : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .when(this.busy, el => el.opacity(0.5)).cursor_pointer().on_click(click).child(label);
    const path = ["createFile", "createFolder"].includes(this.action) && this.target ? creationFolder(this.target) : this.target?.path;
    return v_flex().id("files-plus-dialog").track_focus(this.handle).size_full().min_h(0).p(18).gap(12)
      .bg(t.popover).text_size(13).text_color(t.foreground)
      .on_key_down((event, cx) => {
        if (event.key === "escape") { if (!this.busy) closeOverlay(this.p.overlay); }
        else if (event.key === "enter" && (trash || this.immediate)) this.submit(cx);
        else return;
        cx.stop_propagation();
      })
      .child(div().text_size(15).font_semibold().child(TITLES[this.action] ?? "File action"))
      .child(div().max_h(48).overflow_y_scrollbar().text_size(12).text_color(t.muted).child(path ?? "No file selected"))
      .child(this.immediate ? div().text_color(t.muted).child("Updating this file’s Git index entry. Working files are kept.") : trash ? div().text_color(t.muted).child("Move this item and its contents to the macOS Trash. You can restore it from there.") : div().h(36).px(10).flex_none().flex().items_center().rounded(7).border_1().border_color(t.border).child(Input.new(this.input).w_full().h_full().text_color(t.foreground)))
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().text_size(12).text_color(this.error ? t.ansi1 : t.dim)
        .child(this.error || (this.busy ? "Working…" : trash || this.immediate ? "" : "Existing items are never replaced.")))
      .child(h_flex().justify_end().gap(8)
        .child(button("files-plus-cancel", this.immediate ? "Close" : "Cancel", false, () => { if (!this.busy) closeOverlay(this.p.overlay); }))
        .child(button("files-plus-confirm", this.busy ? "Working…" : this.immediate ? "Retry" : trash ? "Move to Trash" : this.action === "rename" ? "Rename" : "Create", true, (_event, cx) => this.submit(cx))));
  }
}
