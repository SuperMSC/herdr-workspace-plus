export const ZEN_KEY = "sessions-plus.zen.v1";
export const ZEN_FOOTER = "status";
export const ZEN_INTERVAL = 1000;

const surfaces = ["workspace-plus-toolbar", "panel", "sidebar"];

function visit(node, fn, shown = true) {
  if (!node || typeof node !== "object") return;
  const visible = shown && node.hidden !== true;
  fn(node, visible);
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      visit(child, fn, visible && (node.type !== "stack" || !node.active || child?.id === node.active));
    }
  }
}

function isZenFooter(node) {
  return node?.id === ZEN_FOOTER && node.type === "block" && node.content?.mod === "sessions-plus" && node.content.props?.role === "footer";
}

export function zenFooter(tree) {
  let footer;
  visit(tree, node => { if (isZenFooter(node)) footer = node; });
  return footer;
}

export function planZen(tree, current, now) {
  const nodes = new Map();
  visit(tree, (node, visible) => { if (node.id) nodes.set(node.id, { node, visible }); });
  const footer = nodes.get(ZEN_FOOTER)?.node;
  if (!isZenFooter(footer)) return { next: current };
  const showing = surfaces.filter(id => nodes.get(id)?.visible);
  const saved = surfaces.filter(id => current?.visible?.includes(id) && nodes.has(id));
  const waiting = now < current?.retryAt;

  if (footer.hidden === true) {
    if (!current?.on) {
      // A quick re-entry can precede the queued restores. Keep the original set.
      const visible = current ? saved : showing;
      const ids = surfaces.filter(id => showing.includes(id) || visible.includes(id));
      return { next: { on: true, visible, retryAt: ids.length ? now + ZEN_INTERVAL : 0 }, command: "layout.hide", ids };
    }
    if (!showing.length && current.retryAt) return { next: { ...current, retryAt: 0 } };
    if (!showing.length || waiting) return { next: current };
    return { next: { ...current, retryAt: now + ZEN_INTERVAL }, command: "layout.hide", ids: showing };
  }

  if (!current) return { next: current };
  if (current.on) {
    if (!saved.length) return { next: undefined };
    // Even a still-visible surface can have an earlier hide queued.
    return { next: { on: false, visible: saved, retryAt: now + ZEN_INTERVAL, waitForRestore: waiting }, command: "layout.show", ids: [...saved].reverse() };
  }
  const hidden = saved.filter(id => nodes.get(id).node.hidden === true).reverse();
  if (!hidden.length && !(waiting && current.waitForRestore)) return { next: undefined };
  if (waiting) return { next: current };
  return { next: { ...current, retryAt: now + ZEN_INTERVAL, waitForRestore: false }, command: "layout.show", ids: hidden };
}

export function reconcileZen({ checking, layout, shared, setShared, run }, now = Date.now()) {
  if (checking()) return;
  const name = shared("layout");
  if (typeof name !== "string" || !name) return;
  const registry = shared(ZEN_KEY) ?? {};
  const current = Object.hasOwn(registry, name) ? registry[name] : undefined;
  const { next, command, ids } = planZen(layout(), current, now);
  if (next === current) return;
  const updated = { ...registry, [name]: next };
  if (!next) delete updated[name];
  // Claim the transition synchronously before native commands can change the layout.
  setShared(ZEN_KEY, updated);
  for (const id of ids ?? []) run(command, { id });
}
