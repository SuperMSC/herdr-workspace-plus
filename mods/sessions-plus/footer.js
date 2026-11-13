import { TYPE } from "./type-scale.js";
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, terminals, shared, setShared, layout, theme, run, window, keys } from "herdr";
import StatusBar from "./statusbar.js";
import Resources from "./resources.js";
// The sidebar owns this preference; mods cannot import one another at runtime.
const FILTER_KEY = "project-spaces.filter.v1";
const find = (node, matches) => matches(node) ? node : (node?.children || []).map(child => find(child, matches)).find(Boolean);
const unifiedSidebar = tree => find(tree, node => node?.type === "block" && node.content?.mod === "project-spaces" && node.content.props?.unified === true && !node.content.props?.role);

export default class Footer {
  init(p, cx) {
    this.status = new StatusBar();
    this.status.init({ ...p, embedded: true }, cx);
    this.resources = new Resources();
    this.resources.init(p, cx);
  }

  commandLabel() {
    const binding = keys().find(item => item.section === "global" && item.action === "app.palette")?.keys;
    if (!binding) return "commands";
    const mac = window()?.platform === "macos";
    const names = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const parts = binding.endsWith("--") ? [...binding.slice(0, -2).split("-"), "-"] : binding.split("-");
    return `${parts.map(part => names[part.toLowerCase()] ?? part.toUpperCase()).join("")}  commands`;
  }

  showAttention() {
    const tree = layout();
    if (!unifiedSidebar(tree)) return;
    const sidebar = find(tree, node => node?.id === "sidebar");
    if (sidebar?.hidden) run("layout.show", { id: "sidebar" });
    if (Number.isFinite(sidebar?.size?.px) && sidebar.size.px < 160) {
      const saved = shared("sidebar.width");
      run("layout.resize", { id: "sidebar", px: Number.isFinite(saved) && saved >= 160 ? saved : 268 });
    }
    setShared(FILTER_KEY, "attention");
  }

  render() {
    const t = theme(), space = spaces().find(item => item.active), list = agents();
    const live = new Map(terminals().map(item => [item.address, item]));
    const blocked = list.filter(item => typeof item.address === "string" && item.status === "blocked" && (!live.get(item.address)?.state || live.get(item.address).state === "live")).length;
    const enabled = Boolean(unifiedSidebar(layout()));
    const label = (id, icon, text) => h_flex().id(id).h(24).line_height("16px").gap(6).items_center().flex_none()
      .child(svg(`mods/workspace-chrome/${icon}.svg`).size(13))
      .child(div().max_w(160).truncate().child(text));
    return h_flex().id("workspace-plus-footer").size_full().min_w(0).px(14).gap(16).items_center()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(TYPE.sm).line_height("16px").text_color(t.muted)
      .child(h_flex().id("workspace-status-context").h(24).line_height("16px").gap(16).items_center().flex_none()
        .child(label("workspace-device", space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
        .when(Boolean(space?.branch), el => el.child(label("workspace-branch", "branch", space.branch)))
        .child(h_flex().id("workspace-agents").h(24).line_height("16px").gap(6).items_center().when(enabled, el => el.cursor_pointer()).tooltip(enabled ? "Show agents that need attention" : "Enable the unified sidebar to show agents that need attention")
          .on_click(() => this.showAttention())
          .child(blocked > 0
            ? svg("mods/sessions-plus/warning.svg").size(13).flex_none().text_color(t.blocked)
            : svg("mods/workspace-chrome/circle-check.svg").size(13).flex_none())
          .child(`${list.length} agents`)
          .when(blocked > 0, el => el.child(div().text_color(t.blocked).child(`· ${blocked} needs you`)))))
      .child(div().id("workspace-quota-inline").flex_1().min_w(0).h_full().flex().items_center().child(this.status.render()))
      .child(div().id("workspace-resources").h(24).line_height("16px").flex_none().flex().items_center().child(this.resources.render()))
      .child(div().id("workspace-commands").h(24).line_height("16px").flex_none().flex().items_center().text_color(t.dim).cursor_pointer()
        .on_click(() => run("app.palette")).child(this.commandLabel()));
  }
}
