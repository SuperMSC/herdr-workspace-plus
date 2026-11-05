import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, shared, setShared, theme, run, closeOverlay } from "herdr";
import { INBOX_DISMISSED, INBOX_GROUPS, inboxRows, dismissUpdate } from "./inbox-model.js";

export default class Inbox {
  init(p, cx) { this.p = p; this.showHandled = false; this.handle = cx.focus_handle(); this.handle.focus(); cx.timer.every(15000, cx => cx.notify()); }
  dismiss(row, restore, cx) {
    const next = dismissUpdate(row, agents(), terminals(), shared(INBOX_DISMISSED), restore);
    if (next) setShared(INBOX_DISMISSED, next);
    cx.notify();
  }
  open(row) {
    if (!inboxRows(agents(), terminals()).some(agent => agent.address === row.address)) return;
    run("agent.focus", { terminal: row.address }); closeOverlay(this.p.overlay);
  }
  render() {
    const t = theme(), rows = inboxRows(agents(), terminals(), shared(INBOX_DISMISSED));
    const visible = rows.filter(row => !row.dismissed || this.showHandled), handled = rows.filter(row => row.dismissed).length;
    const button = (id, label, callback) => div().id(id).px(8).py(5).flex_none().rounded(5).cursor_pointer().bg(t.raised).hover(el => el.bg(t.hover)).on_click(callback).child(label);
    return v_flex().id("agent-inbox").size_full().min_h(0).p(14).gap(10).rounded(10).overflow_hidden().border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(12)
      .track_focus(this.handle).on_key_down((event, cx) => { if (event.key === "escape") { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(h_flex().flex_none().gap(8).items_center().child(div().flex_1().min_w(0).truncate().font_semibold().text_size(15).child("Agent inbox")))
      .child(div().text_size(10.5).text_color(t.muted).child("Dismiss hides this update. Agents keep running; new updates return automatically."))
      .child(v_flex().id("inbox-groups").flex_1().min_h(0).gap(10).overflow_y_scrollbar()
        .children(INBOX_GROUPS.filter(group => visible.some(row => row.status === group.status)).map(group => v_flex().gap(5)
          .child(div().font_semibold().text_color(t[group.status] || t.muted).child(`${group.label} · ${visible.filter(row => row.status === group.status).length}`))
          .children(visible.filter(row => row.status === group.status).map(row => h_flex().id(`inbox-${row.address}`).gap(8).p(9).items_center().rounded(6).bg(t.raised).when(row.dismissed, el => el.opacity(0.6))
            .child(v_flex().flex_1().min_w(0).gap(3).cursor_pointer().on_click(() => this.open(row))
              .child(div().font_semibold().truncate().child(row.title || row.tab_name || row.program?.name || "Agent"))
              .child(div().text_size(10.5).text_color(t.muted).truncate().child([row.program?.name || row.app, row.space_name, row.address].filter(Boolean).join(" · "))))
            .child(button(`inbox-dismiss-${row.address}`, row.dismissed ? "Show" : row.temporaryDismiss ? "Snooze 1m" : "Dismiss", (_e, cx) => this.dismiss(row, row.dismissed, cx)))))))
        .when(!visible.length, el => el.child(div().p(12).text_color(t.muted).child("No pending agent updates."))))
      .child(button("inbox-show-handled", this.showHandled ? "Hide dismissed" : `Show dismissed (${handled})`, (_e, cx) => { this.showHandled = !this.showHandled; cx.notify(); }));
  }
}
