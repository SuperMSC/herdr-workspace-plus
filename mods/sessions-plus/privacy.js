// Identical private copy in each mod: Herdr keeps module imports inside a mod.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { shared, setShared, theme, closeOverlay } from "herdr";
export const PRIVACY_KEY = "agent-workspace.screenshot-mode.v1";
export function privacyEnabled() { return shared(PRIVACY_KEY) === true; }
export function privacyToggle() { setShared(PRIVACY_KEY, !privacyEnabled()); }
export function privacyGuard(panel, p = {}) {
  if (!privacyEnabled()) return null;
  const t = theme(), compact = ["statusbar", "footer", "toolbar", "pane-header"].includes(p.role);
  const restore = div().id("screenshot-mode-off").px(8).py(4).rounded(5).cursor_pointer().text_color(t.accent).hover(el => el.bg(t.hover))
    .tooltip("Reveal Agent Workspace panels").on_click(() => privacyToggle()).child("Reveal");
  if (compact) return h_flex().id("screenshot-mode-compact").size_full().min_w(0).px(8).gap(8).items_center().bg(t.chrome).text_size(11).text_color(t.muted)
    .child(div().truncate().child("Screenshot mode · terminal visible")).child(restore);
  return v_flex().id("screenshot-mode-mask").size_full().min_h(0).p(12).gap(10).bg(t.surface).text_color(t.foreground).text_size(12)
    .child(h_flex().min_w(0).gap(5).items_center().child(div().flex_1().truncate().font_semibold().child(panel)).child(restore)
      .when(Boolean(p.overlay), el => el.child(div().id("screenshot-mode-close").px(5).py(3).cursor_pointer().child("Close").on_click(() => closeOverlay(p.overlay)))))
    .child(div().text_size(11).text_color(t.muted).child("Screenshot mode"))
    .child(div().text_size(11).text_color(t.muted).child("Panel content hidden. Terminal text and other Herdr panels remain visible."))
    .children([74, 92, 60, 83, 68].map((width, i) => div().id("screenshot-mask-" + i).h(17).w(width + "%").rounded(4).bg(t.raised)));
}
