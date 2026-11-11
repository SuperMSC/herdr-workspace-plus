import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, window, openOverlay, closeOverlay, terminals, settings } from "herdr";

export default class Actions {
  init(p, cx) {
    this.p = p;
    this.target = { ...p.target };
    const live = terminals().find(item => item.address === this.target.address && item.state === "live" && this.target.live && Number.isSafeInteger(this.target.updated) && item.created_ms === this.target.updated);
    this.pickerTarget = live ? { ...live, on: live.address.includes("/") ? live.address.slice(0, live.address.lastIndexOf("/")) : null } : null;
    this.canTrash = !this.target.live && !this.target.remote && window()?.platform === "macos";
    this.items = [{ id: "rename", label: "Rename" }, { id: "trash", label: "Move to Trash…", disabled: !this.canTrash },
      { id: "preview", label: "Preview recent messages", disabled: this.target.remote || !this.target.id || !this.target.key },
      { id: "timeline", label: "Work timeline", disabled: this.target.remote || !this.target.id || !this.target.store },
      { id: "gallery", label: "Session images", disabled: this.target.remote || !this.target.id || !this.target.store },
      { id: "screen-picker", label: "Screen picker", disabled: !this.pickerTarget }];
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(index) {
    const item = this.items[index];
    if (!item || item.disabled) return;
    closeOverlay(this.p.overlay);
    const role = ["timeline", "gallery", "screen-picker"].includes(item.id) ? item.id : item.id === "preview" ? "preview" : item.id === "rename" ? "rename" : "trash-dialog";
    if (["timeline", "gallery", "screen-picker"].includes(item.id)) {
      const viewport = globalThis.window.viewport_size(), zoom = Number(settings().zoom) || 1;
      openOverlay({ mod: "sessions-plus", kind: "dialog", frame: "none", width: Math.min(940, viewport.width / zoom * .93), height: Math.min(760, viewport.height / zoom * .9),
        props: { role, target: item.id === "screen-picker" ? this.pickerTarget : { ...this.target }, node: this.p.node, stores: this.p.stores } });
      return;
    }
    openOverlay({ mod: "sessions-plus", kind: "dialog", frame: "none", width: item.id === "preview" ? 600 : item.id === "rename" ? 420 : 460, height: item.id === "preview" ? 460 : item.id === "rename" ? 240 : 360,
      props: { role, action: "trash", target: { ...this.target }, node: this.p.node, stores: this.p.stores } });
  }

  render() {
    const t = theme();
    return v_flex().id("sessions-actions").size_full().p(6).gap(4).bg(t.popover).text_color(t.foreground).text_size(12.5)
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === "escape") closeOverlay(this.p.overlay);
        else if (event.key === "down" || event.key === "up") {
          const step = event.key === "down" ? 1 : -1;
          do { this.at = (this.at + step + this.items.length) % this.items.length; } while (this.items[this.at].disabled);
        }
        else if (event.key === "enter") this.choose(this.at);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(div().px(8).py(4).truncate().text_color(t.muted).child(this.target.title || "Session"))
      .children(this.items.map((item, index) => div().id(`session-action-${item.id}`).px(8).py(7).rounded(5).cursor_pointer()
        .text_color(item.disabled ? t.dim : item.id === "trash" ? t.ansi1 : t.foreground)
        .when(this.at === index, el => el.bg(t.selected))
        .on_mouse_move((_event, cx) => { if (!item.disabled) { this.at = index; cx.notify(); } })
        .on_click(() => this.choose(index)).child(item.label)))
      .when(!this.canTrash, el => el.child(div().px(8).text_size(10.5).text_color(t.muted).child("Only stopped local sessions can be moved to Trash.")));
  }
}
