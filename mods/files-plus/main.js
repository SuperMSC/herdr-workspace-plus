import { privacyGuard } from "./privacy.js";
// Files Plus: an independent browser with context menus and local macOS file actions.
import { View } from "gpui-kit";
import { props } from "herdr";
import Changes from "./changes.js";
import WorkspaceBrowser from "./workspace-browser.js";
import WorkspaceRoots from "./workspace-roots.js";
import Search from "./search.js";
import Menu from "./menu.js";
import Dialog from "./dialog.js";
import FilePreview from "./file-preview.js";
import PaneHeader, { HEADER_ROLE } from "./pane-header.js";
import Review from "./review.js";
import HunkDialog from "./hunk-dialog.js";
import ReviewComment from "./review-comment.js";
import GitGraph from "./graph.js";
import GithubPanel from "./github.js";

export default class FilesPlus extends View {
  init(p, cx) {
    const pr = props() ?? p ?? {}; this.p = pr;
    const Role = pr.role === "graph" ? GitGraph : pr.role === "github" ? GithubPanel : pr.role === "hunk" ? HunkDialog : pr.role === "workspace-roots" ? WorkspaceRoots : pr.role === "review" ? Review : pr.role === "review-comment" ? ReviewComment : pr.role === HEADER_ROLE ? PaneHeader : pr.role === "file-preview" ? FilePreview : pr.role === "changes" ? Changes : pr.role === "search" ? Search : pr.role === "menu" ? Menu : pr.role === "dialog" ? Dialog : WorkspaceBrowser;
    this.role = new Role();
    this.role.init(pr, cx);
  }

  render(cx) { return privacyGuard("Files & Changes", this.p) || this.role.render(cx); }
  close(cx) { this.role?.close?.(cx); }
}
