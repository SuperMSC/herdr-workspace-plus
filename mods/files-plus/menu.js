import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, openOverlay, theme, exec, shared, setShared, settings } from "herdr";
import { createFilesystem } from "./filesystem.js";
import { CHANGE_KEY, menuItems, copyValue, localActions, parentPath, menuHeight } from "./model.js";

export function changed(target, action, name) {
  setShared(CHANGE_KEY, { target, action, name, revision: (shared(CHANGE_KEY)?.revision ?? 0) + 1 });
}

export default class Menu {
  init(p, cx) {
    this.p = p;
    this.target = p.target;
    this.items = menuItems(this.target);
    this.at = 0;
    this.busy = false;
    this.error = "";
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(index, cx) {
    const item = this.items[index];
    if (!item || this.busy) return;
    const action = item.id, target = this.target;
    if (action.startsWith("copy")) {
      cx.write_to_clipboard(copyValue(action, target));
      closeOverlay(this.p.overlay);
    } else if (action === "refresh") {
      changed(target, action);
      closeOverlay(this.p.overlay);
    } else if (["createFile", "createFolder", "rename", "trash", "stage", "unstage"].includes(action)) {
      closeOverlay(this.p.overlay);
      openOverlay({ mod: "files-plus", kind: "dialog", modal: true, width: 460, height: 290,
        props: { role: "dialog", action, target } });
    } else {
      this.busy = true;
      this.error = "";
      cx.notify();
      cx.spawn(async cx => {
        try {
          await createFilesystem(exec, target)[action](action === "reveal" && target.deleted ? parentPath(target.path) : target.path);
          closeOverlay(this.p.overlay);
        } catch (error) { this.error = String(error.message ?? error); }
        finally { this.busy = false; cx.notify(); }
      });
    }
  }

  render() {
    const t = theme();
    const available = globalThis.window.viewport_size().height / (settings().zoom || 1) * 0.85;
    const height = Math.min(menuHeight(this.target), available);
    const hint = localActions(this.target) ? "↑ ↓ select · Enter run · Esc close" : "File actions require local macOS";
    return v_flex().id("files-plus-menu").w_full().h(height).min_h(0).p(5).bg(t.popover).text_size(12.8).text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((event, cx) => {
        if (this.busy || !this.items.length) return;
        if (event.key === "down") this.at = (this.at + 1) % this.items.length;
        else if (event.key === "up") this.at = (this.at + this.items.length - 1) % this.items.length;
        else if (event.key === "enter") this.choose(this.at, cx);
        else if (event.key === "escape") closeOverlay(this.p.overlay);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(div().h(28).flex_none().px(8).pt(5).truncate().text_size(11).text_color(t.dim).child(this.target?.name ?? "Files Plus"))
      .child(v_flex().id("files-plus-menu-items").flex_1().min_h(0).overflow_y_scrollbar().children(this.items.map((item, i) => v_flex().flex_none()
        .when(item.separator, el => el.child(div().mx(8).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`files-plus-${item.id}`).h(30).px(8).rounded(6).items_center().cursor_pointer()
          .text_color(item.danger ? t.ansi1 : t.foreground)
          .when(i === this.at, el => el.bg(t.selected))
          .on_mouse_move((_event, cx) => { if (!this.busy && this.at !== i) { this.at = i; cx.notify(); } })
          .on_click((_event, cx) => this.choose(i, cx)).child(item.label)))))
      .child(div().h(38).flex_none().overflow_y_scrollbar().px(8).pt(8).text_size(10.5)
        .text_color(this.error ? t.ansi1 : t.dim).child(this.error || (this.busy ? "Working…" : hint)));
  }
}
