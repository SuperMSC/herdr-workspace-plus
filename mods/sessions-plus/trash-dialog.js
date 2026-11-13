import { TYPE } from "./type-scale.js";
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, exec, terminals, panes, theme, window, shared, setShared, closeOverlay } from "herdr";
import { NAMES, PENDING, OPERATIONS, CHANGE_KEY, OPERATION_TTL, operationPending, sessionRows, PROVIDERS } from "./model.js";
import { createTrashClient } from "./trash-client.js";
import { providerIcon } from "./icons.js";

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

  handleError(error) {
    if (this.action === "trash" && error.code === "SESSION_MISSING") {
      setShared(CHANGE_KEY, (Number(shared(CHANGE_KEY)) || 0) + 1);
      closeOverlay(this.p.overlay);
      return;
    }
    this.error = String(error.message ?? error);
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
      } catch (error) { this.handleError(error); }
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
      } catch (error) { this.handleError(error); }
      finally {
        const latest = { ...(shared(OPERATIONS) ?? {}) };
        if (latest[key]?.stamp === stamp) { delete latest[key]; setShared(OPERATIONS, latest); }
        this.busy = false; cx.notify();
      }
    });
  }

  render() {
    const t = theme(), trash = this.action === "trash";
    const tone = trash ? t.blocked : t.accent;
    const provider = PROVIDERS[this.target.provider] ?? this.target.provider ?? "Session";
    const note = trash ? "Its local history goes to the Trash. You can restore it from Sessions → Trash until the Trash is emptied."
      : "Its history goes back to where it was. Existing files are never replaced.";
    const label = this.busy ? "Working…" : this.error ? "Retry" : trash ? "Move to Trash" : "Restore";
    const status = this.busy ? (this.ready ? "Working…" : "Checking session files…") : "";

    const button = (id, text, primary, callback) => h_flex().id(id).h(32).px(14).gap(8).items_center().rounded(8).text_size(TYPE.md)
      .font_medium().border_1().cursor_pointer().hover(s => s.opacity(0.88)).when(this.busy, el => el.opacity(0.5))
      .border_color(primary ? (trash ? (t.danger || t.blocked) : t.solid) : t.input)
      .bg(primary ? (trash ? (t.danger || t.blocked) : t.solid) : t.raised)
      .text_color(primary ? (trash ? (t.danger_foreground || "#ffffff") : t.solid_foreground) : t.foreground)
      .on_click(callback).child(text)
      .when(primary && !this.busy, el => el.child(div().text_size(TYPE.sm).opacity(0.7).child("↵")));

    const session = h_flex().flex_none().gap(10).items_center().px(12).py(9).rounded(8).border_1().border_color(t.border).bg(t.background)
      .child(providerIcon(this.target.provider, 16))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(TYPE.md).font_medium().text_color(t.foreground).truncate().child(this.target.title || this.target.id || "Session"))
        .child(div().text_size(TYPE.sm).text_color(t.dim).truncate().child(this.target.id ? `${provider} · ${this.target.id}` : provider)));

    const files = v_flex().flex_1().min_h(0).rounded(8).border_1().border_color(t.border).overflow_hidden()
      .child(h_flex().flex_none().h(26).px(12).items_center().border_b_1().border_color(t.border).bg(t.surface)
        .text_size(TYPE.sm).text_color(t.dim).child(status || `${this.files.length} file${this.files.length === 1 ? "" : "s"}`))
      .child(v_flex().id("session-trash-files").flex_1().min_h(0).px(12).py(6).gap(3).overflow_y_scrollbar().text_size(TYPE.sm).text_color(t.muted)
        .children(this.files.map(file => div().truncate().text_ellipsis_start().child(file))));

    return v_flex().id("session-trash-dialog").size_full().min_h(0).px(20).pt(20).pb(18).gap(14).rounded(12).overflow_hidden()
      .border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(TYPE.md)
      .track_focus(this.handle).on_key_down((event, cx) => {
        if (event.key === "escape") { if (!this.busy) closeOverlay(this.p.overlay); }
        else if (event.key === "enter") this.submit(cx);
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().flex_none().gap(12).items_start()
        .child(h_flex().size(36).flex_none().items_center().justify_center().rounded(10).bg(tone + "1f")
          .child(svg(`mods/sessions-plus/${trash ? "trash" : "refresh"}.svg`).size(16).text_color(tone)))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().text_size(TYPE.lg).font_semibold().truncate().child(trash ? "Move Session to Trash?" : "Restore Session?"))
          .child(div().text_size(TYPE.md).text_color(t.muted).child(note)))
        .child(div().flex_none().px(6).h(20).flex().items_center().rounded(5).border_1().border_color(t.border)
          .text_size(TYPE.xs).text_color(t.dim).child("Esc")))
      .child(session)
      .when(!trash && Boolean(this.target.message), el => el.child(div().flex_none().text_size(TYPE.sm).text_color(t.muted).child(this.target.message)))
      .when(trash, el => el.child(files))
      .when(!trash, el => el.child(div().flex_1().min_h(0).text_size(TYPE.sm).text_color(t.dim).child(status)))
      .when(Boolean(this.error), el => el.child(div().flex_none().max_h(54).overflow_y_scrollbar().text_size(TYPE.md).text_color(t.blocked).child(this.error)))
      .child(h_flex().flex_none().gap(8).justify_end()
        .child(button("session-trash-cancel", "Cancel", false, () => { if (!this.busy) closeOverlay(this.p.overlay); }))
        .child(button("session-trash-confirm", label, true, (_event, cx) => this.submit(cx))));
  }
}
