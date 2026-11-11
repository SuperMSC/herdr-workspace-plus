import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Editor, EditorState } from "gpui-base";
import { appHome, exec, machines, theme, shared, setShared, closeOverlay } from "herdr";
import { projectContext } from "./project-context.js";
import { createServicesClient } from "./services-client.js";
import { serviceContext, containerIdentity, sameContainer, containerPriority, filteredContainers, filteredPorts, listenerURL, sameListener } from "./services-model.js";
const RESTARTS = "sessions-plus.services-restarts.v1";
const message = error => String(error.message || error).slice(0, 600);

export default class Services {
  init(p, cx) {
    this.p = p; this.handle = cx.focus_handle(); this.handle.focus(); this.tab = p.initial === "ports" ? "ports" : "containers";
    this.snapshot = { containers: [], ports: [], warnings: [], captured: null }; this.generation = 0; this.loading = false; this.busy = false; this.error = ""; this.status = ""; this.queryText = ""; this.containerPage = 0; this.portPage = 0; this.scheme = "http"; this.issued = new Set();
    this.input = InputState.new({ placeholder: "Search names, ports, PID or Compose project…" });
    this.input.on("change", (_event, cx) => { this.queryText = this.input.value(); this.containerPage = 0; this.portPage = 0; this.confirm = null; cx.notify(); });
    try {
      this.context = serviceContext(p.context || projectContext());
      this.client = createServicesClient({ execute: exec, home: appHome(), node: p.node || "node", context: this.context, connected: on => machines().some(machine => machine.name === on && machine.layout === "ready") });
      this.refresh(cx);
    } catch (error) { this.error = message(error); }
  }
  refresh(cx) {
    if (this.disposed || !this.client || this.loading || this.busy) return;
    const generation = ++this.generation; this.loading = true; this.confirm = null; this.error = ""; this.status = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        const snapshot = await this.client.scan();
        if (this.disposed || generation !== this.generation) return;
        this.snapshot = snapshot; this.stale = false; this.issued.clear(); this.containerPage = 0; this.portPage = 0;
        if (this.selectedPort && !snapshot.ports.some(row => sameListener(this.selectedPort, row))) this.selectedPort = null;
      } catch (error) { if (!this.disposed && generation === this.generation) { this.error = message(error); this.stale = true; } }
      finally { if (!this.disposed && generation === this.generation) { this.loading = false; cx.notify(); } }
    });
  }
  selectTab(tab, cx) { this.tab = tab; this.confirm = null; this.containerPage = 0; this.portPage = 0; this.closeLog(cx); }
  logs(row, cx) {
    if (this.busy || this.loading || this.disposed) return;
    this.busy = true; this.error = ""; this.confirm = null; const generation = this.generation, logVersion = this.logVersion = (this.logVersion || 0) + 1; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await this.client.logs(row);
        if (this.disposed || generation !== this.generation || logVersion !== this.logVersion) return;
        this.logEditor?.release(); this.logEditor = EditorState.new({ value: result.text || "No log lines returned.", readonly: true, language: "text", line_numbers: false, soft_wrap: true });
        this.log = { name: row.name, truncated: result.truncated, warning: result.warning || "" };
      } catch (error) { if (!this.disposed && generation === this.generation) this.error = message(error); }
      finally { this.busy = false; if (!this.disposed) cx.notify(); }
    });
  }
  arm(row, cx) {
    if (this.loading || this.busy || this.stale || this.disposed || this.issued.has(row.id)) return;
    try {
      if (!row.daemon) throw new Error("Docker engine identity is unavailable. Refresh first.");
      this.confirm = { ...containerIdentity(row, this.context.on), daemon: row.daemon, name: row.name, generation: this.generation }; this.error = "";
    } catch (error) { this.error = message(error); }
    cx.notify();
  }
  restart(cx) {
    if (!this.confirm || this.loading || this.busy || this.stale || this.disposed) return;
    const captured = this.confirm, row = this.snapshot.containers.find(row => sameContainer(captured, row, this.context.on) && row.daemon === captured.daemon);
    if (!row || captured.generation !== this.generation || this.issued.has(row.id)) { this.error = "This selection changed. Refresh and confirm again."; this.confirm = null; cx.notify(); return; }
    const leaseKey = JSON.stringify([this.context.on, row.id]), token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const leases = Object.fromEntries(Object.entries(shared(RESTARTS) || {}).filter(([, lease]) => lease?.until > Date.now()));
    if (leases[leaseKey]?.until > Date.now()) { this.error = "A restart is already pending in another view. Refresh after it completes."; cx.notify(); return; }
    if (Object.keys(leases).length >= 200) { this.error = "Too many pending restarts. Wait for the current requests to finish."; cx.notify(); return; }
    setShared(RESTARTS, { ...leases, [leaseKey]: { token, until: Date.now() + 60000 } });
    this.confirm = null; this.busy = true; this.issued.add(row.id); this.error = ""; this.status = `Restarting only ${row.name}…`; cx.notify();
    cx.spawn(async cx => {
      let uncertain = false;
      try { await this.client.restart({ ...row, on: this.context.on }); if (!this.disposed) this.status = "Restart acknowledged. Use Refresh to check its current state."; }
      catch (error) { uncertain = error.attempted === true; if (!this.disposed) { this.error = message(error); this.status = uncertain ? "Result unconfirmed. Refresh before another request; other views wait one minute." : "Refresh before another request."; } }
      finally {
        const current = { ...(shared(RESTARTS) || {}) }; if (!uncertain && current[leaseKey]?.token === token) { delete current[leaseKey]; setShared(RESTARTS, current); }
        this.busy = false; if (!this.disposed) cx.notify();
      }
    });
  }
  useURL(open, cx) {
    const selected = this.selectedPort, url = listenerURL(selected, this.context?.on ?? null, this.scheme);
    if (!url || this.busy || this.loading || this.stale || this.disposed) return;
    this.busy = true; this.error = ""; const generation = this.generation; cx.notify();
    cx.spawn(async cx => {
      try {
        const listeners = await this.client.listeners();
        if (this.disposed || generation !== this.generation) return;
        if (!listeners.some(row => sameListener(row, selected))) throw new Error("This listener changed or stopped. Refresh and select it again.");
        if (open) cx.open_url(url); else cx.write_to_clipboard(url);
        this.status = open ? `Opened ${url}` : `Copied ${url}`;
      } catch (error) { if (!this.disposed && generation === this.generation) this.error = message(error); }
      finally { this.busy = false; if (!this.disposed) cx.notify(); }
    });
  }
  closeLog(cx) { this.logVersion = (this.logVersion || 0) + 1; this.log = null; this.logEditor?.release(); this.logEditor = null; cx.notify(); }
  close() { this.disposed = true; this.generation++; this.input?.release(); this.logEditor?.release(); }
  render(cx) {
    const t = theme(), disabled = this.loading || this.busy, containers = filteredContainers(this.snapshot.containers, this.queryText), ports = filteredPorts(this.snapshot.ports, this.queryText);
    const button = (id, label, action, off = false, selected = false) => div().id(id).px(8).py(5).flex_none().rounded(5).bg(selected ? t.selected : t.raised).text_color(off ? t.dim : t.foreground)
      .when(!off, el => el.cursor_pointer().hover(row => row.bg(t.hover))).on_click((_event, cx) => { cx.stop_propagation(); if (!off) action(cx); }).child(label);
    const card = row => v_flex().id(`service-container-${row.id}`).gap(4).p(9).rounded(6).bg(t.raised)
      .child(h_flex().gap(7).items_center().child(div().flex_1().font_semibold().truncate().tooltip(row.id).child(row.name))
        .child(div().text_size(10.5).text_color(containerPriority(row) < 2 ? t.blocked : t.muted).child(`${row.state}${row.health ? " · " + row.health : ""}`))
        .child(button(`service-logs-${row.id}`, "Logs", cx => this.logs(row, cx), disabled))
        .child(button(`service-restart-${row.id}`, "Restart…", cx => this.arm(row, cx), disabled || this.stale || !row.daemon || this.issued.has(row.id))))
      .child(div().text_size(10.5).text_color(t.muted).truncate().tooltip(row.image).child(`${row.project || "No Compose project"}${row.service ? " / " + row.service : ""} · ${row.image}`))
      .child(div().text_size(10.5).text_color(t.dim).truncate().tooltip(row.mappings.map(port => `${port.address}:${port.port} → ${port.target}/${port.protocol}`).join("\n")).child(row.mappings.length ? row.mappings.slice(0, 10).map(port => `${port.address}:${port.port} → ${port.target}/${port.protocol}`).join(" · ") : "No published ports"));
    const shownContainers = containers.slice(this.containerPage * 40, (this.containerPage + 1) * 40);
    const attention = shownContainers.filter(row => containerPriority(row) < 2), healthy = shownContainers.filter(row => containerPriority(row) >= 2);
    const containerList = !this.log && this.tab === "containers" ? v_flex().id("services-containers").flex_1().min_h(0).gap(7).overflow_y_scrollbar()
      .when(attention.length > 0, el => el.child(div().text_color(t.blocked).font_semibold().child("Needs attention")).children(attention.map(card)))
      .children(["database", "gts", "ai", "other"].flatMap(group => { const rows = healthy.filter(row => row.group === group); return rows.length ? [div().pt(5).font_semibold().child(group), ...rows.map(card)] : []; }))
      .when(containers.length > 40, el => el.child(h_flex().gap(6).items_center().justify_end()
        .child(div().flex_1().text_size(10.5).text_color(t.dim).child(`${this.containerPage * 40 + 1}–${Math.min(containers.length, (this.containerPage + 1) * 40)} of ${containers.length} containers`))
        .child(button("services-container-prev", "Previous", cx => { this.containerPage--; this.confirm = null; cx.notify(); }, this.containerPage === 0))
        .child(button("services-container-next", "Next", cx => { this.containerPage++; this.confirm = null; cx.notify(); }, (this.containerPage + 1) * 40 >= containers.length))))
      .when(!containers.length, el => el.child(div().p(12).text_color(t.muted).child(this.loading ? "Reading containers…" : "No containers match. Docker errors appear below; port results remain independent."))) : null;
    const url = listenerURL(this.selectedPort, this.context?.on ?? null, this.scheme);
    const portCards = !this.log && this.tab === "ports" ? ports.slice(this.portPage * 100, (this.portPage + 1) * 100).map(row => div().id(`service-port-${row.address}-${row.port}-${row.pid}-${row.name}`).p(8).rounded(5).bg(sameListener(row, this.selectedPort) ? t.selected : t.raised).cursor_pointer().hover(el => el.bg(t.hover))
      .on_click((_event, cx) => { this.selectedPort = { ...row }; this.error = ""; cx.notify(); })
      .child(h_flex().gap(8)
        .child(div().w(170).truncate().font_semibold().child(`${row.address}:${row.port}`))
        .child(div().flex_1().truncate().child(`${row.name} · PID ${row.pid ?? "hidden"}`)))) : [];
    const portList = v_flex().id("services-ports").flex_1().min_h(0).gap(6)
      .child(div().text_size(10.5).text_color(t.muted).child("TCP LISTEN · select a row to use its URL · Docker mappings describe published ports"))
      .child(v_flex().flex_1().min_h(0).gap(5).overflow_y_scrollbar().children(portCards)
        .when(ports.length > 100, el => el.child(h_flex().gap(6).items_center().justify_end()
          .child(div().flex_1().text_size(10.5).text_color(t.dim).child(`${this.portPage * 100 + 1}–${Math.min(ports.length, (this.portPage + 1) * 100)} of ${ports.length} listeners`))
          .child(button("services-port-prev", "Previous", cx => { this.portPage--; cx.notify(); }, this.portPage === 0))
          .child(button("services-port-next", "Next", cx => { this.portPage++; cx.notify(); }, (this.portPage + 1) * 100 >= ports.length))))
        .when(!ports.length, el => el.child(div().p(12).text_color(t.muted).child("No listeners match this search. Missing tools or permissions are listed below."))))
      .when(Boolean(this.selectedPort), el => el.child(v_flex().flex_none().gap(5)
        .when(Boolean(this.selectedPort?.containers?.length), row => row.child(div().text_size(10.5).text_color(t.muted).child("Docker mapping: " + this.selectedPort.containers.map(container => `${container.name}:${container.target}`).join(" · "))))
        .child(h_flex().gap(6).items_center().child(button("services-scheme", this.scheme.toUpperCase(), cx => { this.scheme = this.scheme === "http" ? "https" : "http"; cx.notify(); }))
          .child(div().flex_1().truncate().text_size(10.5).text_color(t.dim).child(url || (this.context?.on ? "Remote loopback belongs to the remote machine; no tunnel is created." : "Only an explicit loopback binding can open a local URL.")))
          .child(button("services-copy-url", "Copy URL", cx => this.useURL(false, cx), !url || disabled || this.stale))
          .child(button("services-open-url", "Open URL", cx => this.useURL(true, cx), !url || disabled || this.stale)))));
    return v_flex().id("workspace-services").size_full().min_h(0).min_w(0).p(14).gap(8).rounded(10).border_1().border_color(t.border).bg(t.popover).text_color(t.foreground).text_size(12).track_focus(this.handle)
      .on_key_down((event, cx) => { if (event.key === "escape") { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(h_flex().gap(7).items_center().child(svg("mods/sessions-plus/services.svg").size(16)).child(div().flex_1().font_semibold().text_size(15).child("Containers & Ports"))
        .child(button("services-refresh", this.loading ? "Refreshing…" : "Refresh", cx => this.refresh(cx), disabled)))
      .child(div().text_size(10.5).text_color(t.muted).truncate().tooltip(`${this.context?.root || ""}\nContainers follow the selected machine\'s Docker CLI context. Ports belong to the machine itself.`).child(`${this.context?.on || "This computer"} · ${this.snapshot.captured ? new Date(this.snapshot.captured).toLocaleTimeString() : "Not yet read"}${this.stale ? " · Previous snapshot · refresh failed" : ""}`))
      .child(h_flex().gap(6).child(button("services-containers-tab", `Containers (${this.snapshot.containers.length})`, cx => this.selectTab("containers", cx), false, this.tab === "containers"))
        .child(button("services-ports-tab", `Ports (${this.snapshot.ports.length})`, cx => this.selectTab("ports", cx), false, this.tab === "ports")))
      .child(Input.new(this.input).h(32).flex_none())
      .child(this.log ? v_flex().flex_1().min_h(0).gap(7).child(h_flex().gap(8).items_center().child(button("services-log-back", "Back", cx => this.closeLog(cx))).child(div().flex_1().truncate().child(`${this.log.name} · last 300 log lines`)))
        .when(this.log.truncated, el => el.child(div().text_size(10.5).text_color(t.blocked).child(this.log.warning || "Log output reached its byte or time limit; partial text is shown.")))
        .child(div().flex_1().min_h(0).border_1().border_color(t.border).rounded(5).child(Editor.new(this.logEditor).size_full())) : this.tab === "containers" ? containerList : portList)
      .when(Boolean(this.confirm), el => el.child(v_flex().flex_none().gap(6).p(9).rounded(5).bg(t.raised)
        .child(div().text_color(t.blocked).child(`Restart only ${this.confirm?.name} on ${this.context?.on || "this computer"}? Active connections may be interrupted.`))
        .child(div().text_size(10).text_color(t.dim).truncate().tooltip(this.confirm?.id).child(`${this.confirm?.id} · created ${this.confirm?.created}`))
        .child(h_flex().gap(6).justify_end().child(button("services-restart-cancel", "Keep running", cx => { this.confirm = null; cx.notify(); })).child(button("services-restart-confirm", "Restart this container", cx => this.restart(cx), disabled)))))
      .when(Boolean(this.status), el => el.child(div().text_size(10.5).text_color(t.muted).child(this.status)))
      .when(Boolean(this.error), el => el.child(div().text_size(11).text_color(t.ansi1).child(this.error)))
      .when(this.snapshot.warnings.length > 0, el => el.child(div().max_h(75).flex_none().overflow_y_scrollbar().text_size(10.5).text_color(t.muted).child(this.snapshot.warnings.join("\n"))))
      .child(div().text_size(10).text_color(t.dim).child("Read on open and Refresh. Restart acts on one confirmed container."));
  }
}
