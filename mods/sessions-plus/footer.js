import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, terminals, shared, openOverlay, theme, run, window, keys } from "herdr";
import StatusBar from "./statusbar.js";
import { INBOX_DISMISSED, inboxRows } from "./inbox-model.js";

export default class Footer {
  init(p, cx) {
    this.status = new StatusBar();
    this.status.init({ ...p, embedded: true }, cx);
  }

  commandLabel() {
    const binding = keys().find(item => item.section === "global" && item.action === "app.palette")?.keys;
    if (!binding) return "commands";
    const mac = window()?.platform === "macos";
    const names = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const parts = binding.endsWith("--") ? [...binding.slice(0, -2).split("-"), "-"] : binding.split("-");
    return `${parts.map(part => names[part.toLowerCase()] ?? part.toUpperCase()).join("")}  commands`;
  }

  render() {
    const t = theme(), space = spaces().find(item => item.active), list = agents();
    const blocked = inboxRows(list, terminals(), shared(INBOX_DISMISSED)).filter(item => item.status === "blocked" && !item.dismissed).length;
    const label = (icon, text) => h_flex().gap(6).items_center().flex_none()
      .child(svg(`mods/workspace-chrome/${icon}.svg`).size(13))
      .child(div().max_w(160).truncate().child(text));
    return h_flex().id("workspace-plus-footer").size_full().min_w(0).px(14).gap(16).items_center()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(h_flex().id("workspace-status-context").gap(16).items_center().flex_none()
        .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
        .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
        .child(h_flex().id("workspace-inbox").gap(6).items_center().cursor_pointer().tooltip("Agent inbox · Needs you, finished, and working agents")
          .on_click(() => openOverlay({ mod: "sessions-plus", kind: "dialog", frame: "none", width: 560, height: 500, props: { role: "inbox" } }))
          .child(svg("mods/sessions-plus/inbox.svg").size(13).flex_none()).child(`${list.length} agents`)
          .when(blocked > 0, el => el.child(div().text_color(t.blocked).child(`· ${blocked} needs you`)))))
      .child(div().id("workspace-quota-inline").flex_1().min_w(0).h_full().child(this.status.render()))
      .child(div().id("workspace-commands").flex_none().text_color(t.dim).cursor_pointer()
        .on_click(() => run("app.palette")).child(this.commandLabel()));
  }
}
