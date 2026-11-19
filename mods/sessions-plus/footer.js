import { TYPE } from "./type-scale.js";
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, terminals, theme, run, window, keys, nextCommand, openOverlay } from "herdr";
import StatusBar from "./statusbar.js";
import Resources from "./resources.js";

export default class Footer {
  init(p, cx) {
    this.p = p;
    this.status = new StatusBar();
    this.status.init({ ...p, embedded: true }, cx);
    this.resources = new Resources();
    this.resources.init(p, cx);
    cx.spawn(async () => { for (;;) { const command = await nextCommand(); if (this.disposed) return; if (command === "launcher") this.launcher(); } });
  }

  launcher() { openOverlay({ mod: "sessions-plus", kind: "dialog", width: 760, height: 620, props: { role: "launcher", node: this.p.node } }); }
  close() { this.disposed = true; }

  /** A key binding in the platform's own notation, modifiers in its usual order (⌃⌥⇧⌘ on macOS). */
  keyLabel(binding) {
    if (typeof binding !== "string" || !binding) return "";
    const mac = window()?.platform === "macos";
    const names = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const order = mac ? ["ctrl", "alt", "option", "shift", "cmd"] : ["ctrl", "cmd", "alt", "option", "shift"];
    const parts = binding.endsWith("--") ? [...binding.slice(0, -2).split("-"), "-"] : binding.split("-");
    const key = parts.pop(), modifiers = parts.map(part => part.toLowerCase()).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return [...new Set(modifiers.map(part => names[part] ?? part.toUpperCase()))].join("") + (names[key.toLowerCase()] ?? key.toUpperCase());
  }

  commandLabel() { return this.keyLabel(keys().find(item => item.section === "global" && item.action === "app.palette")?.keys); }
  launcherLabel() { return this.keyLabel(keys().find(item => item.action === "sessions-plus.launcher")?.keys); }

  showAgents() { openOverlay({ mod: "sessions-plus", kind: "dialog", width: 680, height: 560, props: { role: "live-agents" } }); }

  render() {
    const t = theme(), space = spaces().find(item => item.active), list = agents();
    const live = new Map(terminals().map(item => [item.address, item]));
    const blocked = list.filter(item => typeof item.address === "string" && item.status === "blocked" && (!live.get(item.address)?.state || live.get(item.address).state === "live")).length;
    const label = (id, icon, text) => h_flex().id(id).h(24).line_height("16px").gap(6).items_center().flex_none()
      .child(svg(`mods/workspace-chrome/${icon}.svg`).size(13))
      .child(div().max_w(160).truncate().child(text));
    // Footer actions share one form: a capitalized name, then its shortcut in the dim color when bound.
    const shortcut = (id, text, keyText) => h_flex().id(id).h(24).line_height("16px").gap(6).flex_none().items_center().cursor_pointer().hover(el => el.text_color(t.foreground))
      .child(div().child(text))
      .when(Boolean(keyText), el => el.child(div().id(id + "-key").text_color(t.dim).child(keyText)));
    return h_flex().id("workspace-plus-footer").size_full().min_w(0).px(14).gap(16).items_center()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(TYPE.sm).line_height("16px").text_color(t.muted)
      .child(h_flex().id("workspace-status-context").h(24).line_height("16px").gap(16).items_center().flex_none()
        .child(label("workspace-device", space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
        .when(Boolean(space?.branch), el => el.child(label("workspace-branch", "branch", space.branch)))
        .child(h_flex().id("workspace-agents").h(24).line_height("16px").gap(6).items_center().cursor_pointer().hover(el => el.text_color(t.foreground)).tooltip("Open agents in a dialog")
          .on_click(() => this.showAgents())
          .child(blocked > 0
            ? svg("mods/sessions-plus/warning.svg").size(13).flex_none().text_color(t.blocked)
            : svg("mods/workspace-chrome/circle-check.svg").size(13).flex_none())
          .child(`${list.length} agents`)
          .when(blocked > 0, el => el.child(div().text_color(t.blocked).child(`· ${blocked} needs you`)))))
      .child(div().id("workspace-quota-inline").flex_1().min_w(0).h_full().flex().items_center().child(this.status.render()))
      .child(div().id("workspace-resources").h(24).line_height("16px").flex_none().flex().items_center().child(this.resources.render()))
      .child(shortcut("workspace-launcher-button", "Launch", this.launcherLabel()).tooltip("Quick launcher · Search agents, projects and commands").on_click(() => this.launcher()))
      .child(shortcut("workspace-commands", "Commands", this.commandLabel()).tooltip("Command palette").on_click(() => run("app.palette")));
  }
}
