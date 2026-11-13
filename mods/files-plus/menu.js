import { TYPE } from "./type-scale.js";
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, openOverlay, theme, exec, shared, setShared, settings, appHome, readTextFile } from "herdr";
import { createFilesystem } from "./filesystem.js";
import { CHANGE_KEY, SHOW_HIDDEN_KEY, menuItems, copyValue, localActions, parentPath, menuHeight } from "./model.js";

import { LIBRARY_KEY, remapLibrary } from "./library-model.js";
import { applyPathChange } from "./model.js";

export function changed(target, action, name) {
  if (["rename", "trash"].includes(action)) {
    const state = shared(LIBRARY_KEY), next = remapLibrary(state, target.root, target.on, path => applyPathChange(path, { target, action, name }));
    if (next !== state) setShared(LIBRARY_KEY, next);
  }
  setShared(CHANGE_KEY, { target, action, name, revision: (shared(CHANGE_KEY)?.revision ?? 0) + 1 });
}

export default class Menu {
  init(p, cx) {
    this.p = p;
    this.target = p.target;
    this.options = { preferences: p.preferences === true, showHidden: shared(SHOW_HIDDEN_KEY) === true };
    this.items = menuItems(this.target, this.options);
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
    } else if (action === "queueReference") {
      this.busy = true; this.error = ""; cx.notify();
      cx.spawn(async cx => {
        try {
          if (await readTextFile(`${appHome()}/mods/sessions-plus/mod.json`) === null) throw new Error("Pending prompts requires the Sessions Plus companion. Run the full workspace updater first.");
          closeOverlay(this.p.overlay);
          openOverlay({ mod: "sessions-plus", kind: "dialog", frame: "none", width: 660, height: 540, props: { role: "prompt-queue", reference: { root: target.root, relative: target.relative, dir: target.dir, on: target.on ?? null } } });
        } catch (error) { this.error = String(error.message || error); }
        finally { this.busy = false; cx.notify(); }
      });
    } else if (action === "toggleHidden") {
      setShared(SHOW_HIDDEN_KEY, shared(SHOW_HIDDEN_KEY) !== true);
      closeOverlay(this.p.overlay);
    } else if (action === "refresh") {
      changed(target, action);
      closeOverlay(this.p.overlay);
    } else if (["createFile", "createFolder", "rename", "trash", "stage", "unstage"].includes(action)) {
      closeOverlay(this.p.overlay);
      openOverlay({ mod: "files-plus", kind: "dialog", frame: "none", width: 440, height: ["trash", "stage", "unstage"].includes(action) ? 240 : 272,
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
    const height = menuHeight(this.target, this.options, available);
    const hint = localActions(this.target) ? "↑ ↓ select · Enter run · Esc close" : "File actions require local macOS";
    return v_flex().id("files-plus-menu").w_full().h(height).min_h(0).p(4).bg(t.popover).text_size(TYPE.md).text_color(t.foreground)
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
      .child(div().h(22).flex_none().px(8).pt(2).truncate().text_size(TYPE.sm).text_color(t.dim).child(this.target?.name ?? "Files"))
      .child(v_flex().id("files-plus-menu-items").flex_1().min_h(0).overflow_y_scrollbar().children(this.items.map((item, i) => v_flex().flex_none()
        .when(item.separator, el => el.child(div().mx(8).my(3).h(1).bg(t.border)))
        .child(h_flex().id(`files-plus-${item.id}`).h(30).px(8).rounded(6).items_center().cursor_pointer()
          .text_color(item.danger ? t.ansi1 : t.foreground)
          .when(i === this.at, el => el.bg(t.selected))
          .on_mouse_move((_event, cx) => { if (!this.busy && this.at !== i) { this.at = i; cx.notify(); } })
          .on_click((_event, cx) => this.choose(i, cx)).child(div().flex_1().child(item.label))
          .when(item.checked === true, el => el.child(div().flex_none().child("✓")))))))
      .child(div().h(22).flex_none().overflow_y_scrollbar().px(8).pt(3).text_size(TYPE.xs)
        .text_color(this.error ? t.ansi1 : t.dim).child(this.error || (this.busy ? "Working…" : hint)));
  }
}
