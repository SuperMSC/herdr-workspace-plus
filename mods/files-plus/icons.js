import { div, svg, image } from "gpui-kit";
import { iconName } from "./icon-model.js";

export function fileIcon(path, directory = false) {
  return image(`mods/files-plus/icons/${iconName(path, directory)}.svg`).w(16).h(16).flex_none();
}

export function iconButton(id, icon, label, click, t, active = false, disabled = false) {
  return div().id(id).w(24).h(24).p(0).flex_none().flex().items_center().justify_center().rounded(4)
    .text_color(active ? t.accent : t.muted).bg(active ? t.selected : t.background).disabled(disabled)
    .tooltip(label).accessibility_label(label).when(disabled, el => el.opacity(0.4).cursor_default())
    .when(!disabled, el => el.cursor_pointer().hover(s => s.bg(t.hover)))
    .on_click((e, cx) => { cx.stop_propagation(); if (!disabled) click(e, cx); })
    .child(svg(`mods/files-plus/icons/${icon}.svg`).size(14).flex_none());
}

// Compact dialog dismiss controls retain a padded click target.
export function closeButton(id, label, click, t, disabled = false) {
  return div().id(id).w(24).h(24).p(0).flex_none().flex().items_center().justify_center().rounded(4)
    .text_color(t.muted).disabled(disabled)
    .when(disabled, el => el.opacity(0.4).cursor_default())
    .when(!disabled, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)))
    .tooltip(label).accessibility_label(label).on_click((e, cx) => { cx.stop_propagation(); if (!disabled) click(e, cx); })
    .child(svg("mods/files-plus/icons/close.svg").size(12).flex_none());
}
