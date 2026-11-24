import { TYPE } from "./type-scale.js";
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { appHome, home, checking, exec, shared, setShared, spaces, agents, terminals, panes, machines, theme, run, window, keys, nextCommand, openOverlay, layout } from "herdr";
import StatusBar from "./statusbar.js";
import Resources from "./resources.js";
import { argvIdentity, liveKey, NAMES } from "./model.js";
import { privacyEnabled } from "./privacy.js";
import { LIVE_KEY, LIVE_LIMITS, updateLive } from "./live-model.js";
import { TERMINAL_SESSIONS_KEY, AUTO_TITLES_KEY, AUTO_TITLES_ENABLED, AUTO_TITLE_INTERVAL, workspaceTerminals, localLayoutReady, updateTerminalSessions, planAutoTitles } from "./live-model.js";
import { reconcileZen, ZEN_INTERVAL } from "./zen-model.js";

function liveCandidates(items, stores) {
  const candidates = new Map();
  for (const term of items) {
    if (term.state !== "live" || typeof term.address !== "string" || term.address.includes("/") || !Number.isSafeInteger(term.created_ms) ||
      !Number.isSafeInteger(term.pid) || term.pid <= 0 || !Number.isSafeInteger(term.foreground?.pid) || term.foreground.pid <= 0) continue;
    const identity = argvIdentity(term);
    if (!(identity?.provider === "claude" || identity?.provider === "codex" && identity.id)) continue;
    candidates.set(liveKey(term), { provider: identity.provider, pid: term.foreground.pid, root: term.pid, argvId: identity.id, store: identity.store ?? stores?.[identity.provider] ?? null });
  }
  return candidates;
}

const sameProcess = (a, b) => a && b && a.root === b.root && a.pid === b.pid && a.provider === b.provider && a.argvId === b.argvId && a.store === b.store;

class LiveSessions {
  constructor(onTick) { this.onTick = onTick; }

  init(p, cx) {
    if (this.closed || checking()) return;
    this.p = p; this.cache = new Map();
    this.tick(cx);
    cx.timer.every(20000, cx => this.tick(cx));
  }

  tick(cx) {
    if (this.closed || this.pending || !this.p || !window()?.active) return;
    const items = terminals(), captured = liveCandidates(items, this.p.stores);
    const requests = [...captured].slice(0, LIVE_LIMITS.agents).map(([key, terminal]) => {
      const old = this.cache.get(key), { root, ...input } = terminal;
      return { key, ...input, prev: sameProcess(old?.terminal, terminal) ? old.entry.stamp : undefined };
    });
    if (!requests.length) {
      this.publish({}); this.cache.clear();
      this.onTick?.(items, {}, new Set());
      return;
    }
    this.pending = true;
    cx.spawn(async () => {
      let observation;
      try {
        const reply = await exec(this.p.node || "node", [appHome() + "/mods/sessions-plus/live.mjs", JSON.stringify(requests)], { timeout: 10000 });
        if (this.closed || !window()?.active) return;
        if (reply.code !== 0) throw new Error("Could not read live sessions.");
        const data = JSON.parse(reply.stdout), items = terminals(), current = liveCandidates(items, this.p.stores), observed = {}, next = {}, cache = new Map();
        for (const { key, provider, pid } of requests) {
          const terminal = captured.get(key), entry = data?.[key], old = this.cache.get(key);
          if (!sameProcess(terminal, current.get(key)) || entry?.provider !== provider || entry.pid !== pid || !entry.id || !entry.store) continue;
          const previous = sameProcess(old?.terminal, terminal) && old.entry.id === entry.id && old.entry.store === entry.store ? old.entry : null;
          if (entry.unchanged && previous) {
            entry.context = previous.context;
            entry.transcriptTitle = previous.transcriptTitle;
            entry.title ||= previous.transcriptTitle;
          }
          if (entry.deferred && previous) cache.set(key, old);
          else cache.set(key, { terminal, entry });
          observed[key] = next[key] = entry;
        }
        const uncertain = new Set();
        for (const [key, terminal] of current) {
          if (Object.hasOwn(observed, key)) continue;
          uncertain.add(key);
          const old = this.cache.get(key);
          if (!sameProcess(old?.terminal, terminal)) continue;
          cache.set(key, old);
          next[key] = { ...old.entry, deferred: true };
        }
        this.cache = cache; this.publish(next);
        observation = [items, observed, uncertain];
      } catch { /* A failed probe leaves the previous reading to expire. */ }
      finally { this.pending = false; }
      if (!this.onTick || this.closed || !window()?.active) return;
      if (!observation) {
        const items = terminals();
        observation = [items, {}, new Set(liveCandidates(items, this.p.stores).keys())];
      }
      this.onTick(...observation);
    });
  }

  publish(results) {
    const next = updateLive(shared(LIVE_KEY), results);
    if (next) setShared(LIVE_KEY, next);
  }

  close() { this.closed = true; }
}

export default class Footer {
  init(p, cx) {
    this.p = p;
    this.status = new StatusBar();
    this.status.init({ ...p, embedded: true }, cx);
    this.resources = new Resources();
    this.resources.init(p, cx);
    this.live = new LiveSessions((items, identities, uncertain) => this.updateWorkspaces(items, identities, uncertain));
    cx.spawn(async cx => this.live.init(p, cx));
    cx.spawn(async cx => {
      if (!this.disposed && !checking()) cx.timer.every(ZEN_INTERVAL, cx => {
        if (this.disposed) return;
        // Readings pause while the window is inactive; refresh at once when it is active again.
        const active = Boolean(window()?.active);
        if (active && this.wasActive === false) this.live.tick(cx);
        this.wasActive = active;
        reconcileZen({ checking, layout, shared, setShared, run });
        const titles = shared(AUTO_TITLES_KEY), screenshot = privacyEnabled();
        if (titles && Object.values(titles).some(entry => entry && (screenshot ? !entry.user : entry.hidden)) && localLayoutReady(machines())) {
          this.updateTitles(titles, spaces(), [], screenshot);
        }
      });
    });
    cx.spawn(async () => { for (;;) { const command = await nextCommand(); if (this.disposed) return; if (command === "launcher") this.launcher(); } });
  }

  launcher() { openOverlay({ mod: "sessions-plus", kind: "dialog", width: 760, height: 620, props: { role: "launcher", node: this.p.node } }); }
  close() { this.disposed = true; this.live.close(); }

  updateWorkspaces(items, probed, uncertain) {
    const ready = localLayoutReady(machines());
    if (!ready) { this.restoreMisses = new Map(); return; }
    const visibleSpaces = spaces(), now = Date.now(), knownAgents = new Set(), identities = { ...probed };
    for (const item of items) {
      if (item.state !== "live" || typeof item.address !== "string" || item.address.includes("/")) continue;
      const key = liveKey(item);
      const argv = item.foreground?.argv?.length ? argvIdentity(item) : null;
      if (!argv) continue;
      knownAgents.add(item.address);
      if (identities[key] || !argv.id) continue;
      if (argv.provider === "agy") {
        const store = home() + "/.gemini/antigravity-cli";
        if (!this.p.stores?.agy || this.p.stores.agy === store) identities[key] = { ...argv, store };
      }
    }
    const observed = workspaceTerminals(items, { identities, spaces: visibleSpaces, panes: panes(), agents: agents(), knownAgents });
    const previous = shared(TERMINAL_SESSIONS_KEY) ?? {};
    const unresolved = new Set([...uncertain].filter(key => !identities[key]));
    const recovery = updateTerminalSessions(previous, this.restoreMisses, { terminals: observed, ready, uncertain: unresolved, now });
    this.restoreMisses = recovery.misses;
    if (JSON.stringify(recovery.registry) !== JSON.stringify(previous)) setShared(TERMINAL_SESSIONS_KEY, recovery.registry);

    this.updateTitles(shared(AUTO_TITLES_KEY) ?? {}, visibleSpaces, observed, privacyEnabled(), now);
  }

  updateTitles(titles, visibleSpaces, terminals, screenshot, now = Date.now()) {
    this.titleTimes ??= new Map(Object.keys(titles).map(id => [id, now]));
    for (const [id, at] of this.titleTimes) if (now - at >= AUTO_TITLE_INTERVAL) this.titleTimes.delete(id);
    const plan = planAutoTitles(titles, { terminals, spaces: visibleSpaces, names: shared(NAMES), ready: true,
      screenshot, enabled: shared(AUTO_TITLES_ENABLED) !== false, renamedAt: this.titleTimes, now });
    for (const action of plan.actions) {
      try { run("tab.rename", action); this.titleTimes.set(action.id, now); }
      catch {
        if (Object.hasOwn(titles, action.id)) plan.registry[action.id] = titles[action.id];
        else delete plan.registry[action.id];
      }
    }
    if (JSON.stringify(plan.registry) !== JSON.stringify(titles)) setShared(AUTO_TITLES_KEY, plan.registry);
  }

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
