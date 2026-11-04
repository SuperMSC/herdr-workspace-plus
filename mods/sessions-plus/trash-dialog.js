import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, exec, terminals, panes, theme, window, shared, setShared, closeOverlay } from "herdr";
import { NAMES, PENDING, OPERATIONS, CHANGE_KEY, OPERATION_TTL, operationPending, sessionRows, PROVIDERS } from "./model.js";
import { createTrashClient } from "./trash-client.js";

export default class TrashDialog {
  init(p, cx) {
    this.p = p;
    this.target = { ...p.target };
    this.action = p.action;
    this.read = createTrashClient(exec, p, appHome());
    this.error = ""; this.busy = false; this.ready = this.action === "restore"; this.files = [];
    this.handle = cx.focus_handle(); this.handle.focus();
    if (this.action === "trash") this.prepare(cx);
  }

  check() {
    const target = this.target, now = Date.now();
    if (!["trash", "restore"].includes(this.action)) throw new Error("Unknown session action.");
    if (window()?.platform !== "macos" || target.live || target.remote) throw new Error("Only stopped local sessions can be moved or restored.");
    if (!target.key || (this.action === "restore" && !target.token)) throw new Error("No session selected.");
    if (this.action === "restore" && target.restorable !== true) throw new Error(target.message || "This session cannot currently be restored. Refresh Trash for its latest status.");
    if (sessionRows([target], terminals(), panes(), shared(NAMES) ?? {}).some(row => row.key === target.key && row.live)) throw new Error("This session is running. Stop it before trying again.");
    if (now - (shared(PENDING)?.[target.key] ?? 0) < 15000) throw new Error("This session is opening. Wait for it to finish before trying again.");
    if (operationPending(shared(OPERATIONS), target.key, now)) throw new Error("Another operation is using this session. Try again when it finishes.");
  }

  prepare(cx) {
    if (this.busy) return;
    this.ready = false; this.error = "";
    try { this.check(); }
    catch (error) { this.error = String(error.message ?? error); cx.notify(); return; }
    this.busy = true; cx.notify();
    const key = this.target.key;
    cx.spawn(async cx => {
      try {
        const data = await this.read("prepare", key);
        if (data.row?.key !== key || !Array.isArray(data.files)) throw new Error("The session changed. Close this dialog and select it again.");
        this.files = data.files; this.ready = true;
      } catch (error) { this.error = String(error.message ?? error); }
      finally { this.busy = false; cx.notify(); }
    });
  }

  submit(cx) {
    if (this.busy) return;
    if (!this.ready) { this.prepare(cx); return; }
    try { this.check(); }
    catch (error) { this.error = String(error.message ?? error); cx.notify(); return; }
    const { key, token } = this.target, action = this.action, stamp = `${Date.now()}-${Math.random()}`;
    setShared(OPERATIONS, { ...(shared(OPERATIONS) ?? {}), [key]: { stamp, expires: Date.now() + OPERATION_TTL, action } });
    this.busy = true; this.error = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        await this.read(action, action === "restore" ? token : key);
        setShared(CHANGE_KEY, (Number(shared(CHANGE_KEY)) || 0) + 1);
        closeOverlay(this.p.overlay);
      } catch (error) { this.error = String(error.message ?? error); }
      finally {
        const latest = { ...(shared(OPERATIONS) ?? {}) };
        if (latest[key]?.stamp === stamp) { delete latest[key]; setShared(OPERATIONS, latest); }
        this.busy = false; cx.notify();
      }
    });
  }

  render() {
    const t = theme(), trash = this.action === "trash";
    const button = (id, label, primary, callback) => div().id(id).px(12).py(7).rounded(7).cursor_pointer()
      .bg(primary ? (trash ? t.ansi1 : t.solid) : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .when(this.busy, el => el.opacity(0.5)).on_click(callback).child(label);
    return v_flex().id("session-trash-dialog").size_full().min_h(0).p(18).gap(12).bg(t.popover).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === "escape") { if (!this.busy) closeOverlay(this.p.overlay); }
        else if (event.key === "enter") this.submit(cx);
        else return;
        cx.stop_propagation();
      })
      .child(div().font_semibold().text_size(15).child(trash ? "Move Session to Trash?" : "Restore Session?"))
      .child(div().max_h(45).overflow_y_scrollbar().child(this.target.title || this.target.id || "Session"))
      .child(div().text_color(t.muted).child(trash ? "Move this session’s local history to Trash. You can restore it from Sessions → Trash until the Trash is emptied." : "Restore this session’s history to its original location. Existing files are never replaced."))
      .when(!trash && Boolean(this.target.message), el => el.child(div().text_size(11.5).text_color(t.muted).child(this.target.message)))
      .child(v_flex().flex_1().min_h(0).gap(4).overflow_y_scrollbar().text_size(11.5).text_color(t.muted)
        .children(trash ? this.files.map(file => div().child(file)) : [div().child(`${PROVIDERS[this.target.provider] ?? this.target.provider} · ${this.target.id}`)])
        .when(this.busy, el => el.child(div().child(this.ready ? "Working…" : "Checking session files…"))))
      .when(Boolean(this.error), el => el.child(div().max_h(70).overflow_y_scrollbar().text_color(t.ansi1).child(this.error)))
      .child(h_flex().gap(8).justify_end()
        .child(button("session-trash-cancel", "Cancel", false, () => { if (!this.busy) closeOverlay(this.p.overlay); }))
        .child(button("session-trash-confirm", this.busy ? "Working…" : this.error ? "Retry" : trash ? "Move to Trash" : "Restore", true, (_event, cx) => this.submit(cx))));
  }
}
