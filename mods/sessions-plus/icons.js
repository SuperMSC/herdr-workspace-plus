import { div, image, svg } from "gpui-kit";

// Use Herdr's own assets so its agent icons stay consistent after app updates.
export function providerIcon(provider, size = 18) {
  const name = { claude: "claude", codex: "codex", agy: "antigravity" }[provider];
  if (!name) return div().w(size).h(size).text_center().child("●");
  return image(`icons/${name}.svg`).w(size).h(size).flex_none();
}

// Dialog dismiss controls share one size and preserve operation locks.
export function closeButton(id, label, click, t, disabled = false) {
  return div().id(id).w(24).h(24).p(0).flex_none().flex().items_center().justify_center().rounded(4)
    .text_color(t.muted).disabled(disabled).tooltip(label).accessibility_label(label)
    .when(disabled, el => el.opacity(0.4).cursor_default())
    .when(!disabled, el => el.cursor_pointer().hover(el => el.bg(t.hover).text_color(t.foreground)))
    .on_click((e, cx) => { cx.stop_propagation(); if (!disabled) click(e, cx); })
    .child(svg("mods/sessions-plus/close.svg").size(12).flex_none());
}
