// Files Plus: an independent browser with context menus and local macOS file actions.
import { View } from "gpui-kit";
import { props } from "herdr";
import Changes from "./changes.js";
import Browser from "./browser.js";
import Search from "./search.js";
import Menu from "./menu.js";
import Dialog from "./dialog.js";
import Batch from "./batch.js";
import FilePreview from "./file-preview.js";

export default class FilesPlus extends View {
  init(p, cx) {
    const pr = props() ?? p ?? {};
    const Role = pr.role === "file-preview" ? FilePreview : pr.role === "batch" ? Batch : pr.role === "changes" ? Changes : pr.role === "search" ? Search : pr.role === "menu" ? Menu : pr.role === "dialog" ? Dialog : Browser;
    this.role = new Role();
    this.role.init(pr, cx);
  }

  render(cx) { return this.role.render(cx); }
  close(cx) { this.role?.close?.(cx); }
}
