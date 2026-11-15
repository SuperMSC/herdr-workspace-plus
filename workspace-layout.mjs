// Integrates Sessions and quota controls into a known Herdr workspace layout.
import { createHash } from "node:crypto";

function nodes(root) {
  const result = [];
  function visit(node, parent = null) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    result.push({ node, parent });
    if (Array.isArray(node.children)) for (const child of node.children) visit(child, node);
  }
  visit(root);
  return result;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sessionBlock(node) {
  const role = node?.content?.props?.role;
  return node?.type === "block" && node.content?.mod === "sessions-plus" && (role === undefined || role === "sessions");
}

function barShape(record, original, role, all) {
  const { node, parent } = record;
  if (node.type !== "block" || node.content?.mod !== original || node.children?.length) return null;
  if (parent?.type === "column") return { native: node, wrapper: null, owner: parent, button: null };
  if (parent?.type !== "row" || !Array.isArray(parent.children)) return null;
  const native = parent.children.filter(child => child?.type === "block" && child.content?.mod === original);
  const additions = parent.children.filter(child => child?.type === "block" && child.content?.mod === "sessions-plus" && child.content.props?.role === role);
  const wrapperRecord = all.find(item => item.node === parent);
  return native.length === 1 && additions.length === 1 && wrapperRecord?.parent?.type === "column"
    ? { native: node, wrapper: parent, owner: wrapperRecord.parent, button: additions[0] } : null;
}

function footerShape(record, all) {
  const { node, parent } = record;
  if (node.type === "block" && node.content?.mod === "sessions-plus" && node.content.props?.role === "footer" && !node.children?.length) {
    if (parent?.type === "column") return { native: node, wrapper: null, owner: parent, button: null, integrated: true };
    const wrapperRecord = all.find(item => item.node === parent);
    if (parent?.type === "row" && wrapperRecord?.parent?.type === "column" &&
      !parent.children.some(child => child?.content?.mod === "sessions-plus" && child.content.props?.role === "statusbar")) {
      return { native: node, wrapper: parent, owner: wrapperRecord.parent, button: null, integrated: true };
    }
    return null;
  }
  const previous = barShape(record, "workspace-status", "statusbar", all);
  return previous ? { ...previous, integrated: false } : null;
}

/** Return a copy with toolbar Sessions and footer quota controls where the known structure is present. */
export function integrateWorkspace(source) {
  const layout = structuredClone(source);
  const unchanged = () => ({ layout, changed: false, integrated: false });
  if (!object(layout)) return unchanged();
  const all = nodes(layout);
  const named = id => {
    const matches = all.filter(item => item.node.id === id);
    return matches.length === 1 ? matches[0] : null;
  };
  const headerEntry = named("tabs"), footerEntry = named("status"), panelEntry = named("panel"), bodyEntry = named("panel-body");
  if (!headerEntry || !footerEntry || !panelEntry || !bodyEntry) return unchanged();
  const header = barShape(headerEntry, "tabs", "toolbar", all), footer = footerShape(footerEntry, all);
  if (!header || !footer) return unchanged();
  const fullWidth = layout.type === "column" && footer.owner === layout &&
    layout.children?.some(child => child.type === "row" && child.children?.includes(header.owner) && child.children?.some(node => node.id === "sidebar"));
  if (header.owner !== footer.owner && !fullWidth) return unchanged();
  const panel = panelEntry.node, body = bodyEntry.node;
  if (panel.type !== "column" || body.type !== "stack" || bodyEntry.parent !== panel) return unchanged();
  if (!nodes(header.owner).some(item => item.node === panel) || !Array.isArray(panel.children) || !Array.isArray(body.children)) return unchanged();
  const candidates = [...panel.children, ...body.children].filter(sessionBlock);
  if (candidates.length !== 1) return unchanged();
  const session = candidates[0];
  if (typeof session.id !== "string" || !session.id || all.filter(item => item.node.id === session.id).length !== 1) return unchanged();
  if (session.content.props != null && !object(session.content.props)) return unchanged();
  // A toolbar from another integration may target different nodes; leave that layout alone.
  if (header.button) {
    const p = header.button.content.props;
    if (p.panel !== panel.id || p.stack !== body.id || p.child !== session.id) return unchanged();
  }

  const ids = new Set(all.map(item => item.node.id));
  const unique = base => {
    let id = base, suffix = 1;
    while (ids.has(id)) id = `${base}-${suffix++}`;
    ids.add(id);
    return id;
  };
  const settings = { ...(session.content.props ?? {}) };
  let changed = false;
  if (panel.children.includes(session)) {
    panel.children = panel.children.filter(child => child !== session);
    body.children.push(session);
    changed = true;
  }
  if (session.content.props?.role !== "sessions") {
    session.content.props = { ...settings, role: "sessions" };
    changed = true;
  }
  function wrap(bar, base, extra) {
    const native = bar.native;
    const wrapper = { ...native, id: unique(base), type: "row", resizable: false,
      divider: { ...(object(native.divider) ? native.divider : {}), width: 0 }, children: [native, extra] };
    delete wrapper.content;
    // Keep the original block identity for its per-copy localStorage. Geometry and
    // paint stay on the outer row; do not apply borders or padding a second time.
    for (const key of Object.keys(native)) if (!["id", "type", "content"].includes(key)) delete native[key];
    native.size = { weight: 1 };
    native.min = 0;
    bar.owner.children[bar.owner.children.indexOf(native)] = wrapper;
    changed = true;
  }
  if (!header.wrapper) wrap(header, "workspace-plus-toolbar", {
    id: unique("workspace-plus-sessions-button"), type: "block", size: { px: 102 },
    content: { mod: "sessions-plus", props: { ...settings, role: "toolbar", panel: panel.id, stack: body.id, child: session.id } },
  });
  if (!footer.integrated) {
    const native = footer.native;
    const content = { ...native.content, mod: "sessions-plus", props: {
      ...(native.content.props ?? {}), ...settings, ...(footer.button?.content.props ?? {}), role: "footer",
    } };
    if (footer.wrapper && footer.wrapper.children.length === 2) {
      // Restore the original status identity at full width and retain the outer
      // row's height and appearance. Obsolete quota/wrapper IDs no longer apply.
      const combined = { ...native, ...footer.wrapper, id: native.id, type: "block", content };
      delete combined.children;
      footer.owner.children[footer.owner.children.indexOf(footer.wrapper)] = combined;
    } else {
      native.content = content;
      if (footer.wrapper) {
        // Extra user blocks need their wrapper; remove only our former quota slot.
        footer.wrapper.children = footer.wrapper.children.filter(child => child !== footer.button);
        native.size = { weight: 1 };
        native.min = 0;
      }
    }
    changed = true;
  }
  return { layout, changed, integrated: true };
}

/** Move a recognized workspace footer below both columns, preserving every block identity. */
export function useFullWidthFooter(source) {
  const layout = structuredClone(source), unchanged = () => ({ layout, changed: false });
  if (!object(layout) || layout.type !== "row" || layout.children?.length !== 2) return unchanged();
  const sidebar = layout.children.find(node => node.id === "sidebar" && node.type === "column");
  const work = layout.children.find(node => node.id === "work" && node.type === "column");
  if (!sidebar || !work) return unchanged();
  const all = nodes(layout), entries = all.filter(({ node }) => node.id === "status");
  if (entries.length !== 1) return unchanged();
  const footer = footerShape(entries[0], all), bar = footer?.wrapper ?? footer?.native;
  if (!footer?.integrated || footer.owner !== work || work.children.at(-1) !== bar) return unchanged();
  const ids = new Set(all.map(({ node }) => node.id));
  let id = "workspace-body", suffix = 1;
  while (ids.has(id)) id = `workspace-body-${suffix++}`;
  const body = { id, type: "row", size: { weight: 1 }, min: 0, children: layout.children };
  for (const key of ["divider", "resizable", "gap"]) if (Object.hasOwn(layout, key)) body[key] = layout[key];
  work.children = work.children.slice(0, -1);
  layout.type = "column"; layout.children = [body, bar]; layout.divider = { width: 0 }; layout.resizable = false; layout.gap = 0;
  return { layout, changed: true };
}

const SIDEBAR_BODY = "workspace-sidebar-body", SIDEBAR_SURFACE = "workspace-sidebar-surface", SIDEBAR_INSET = "workspace-sidebar-inset";

function framedSidebar(all, sidebar, lists) {
  const body = all.filter(({ node }) => node.id === SIDEBAR_BODY);
  const surface = all.filter(({ node }) => node.id === SIDEBAR_SURFACE);
  return body.length === 1 && surface.length === 1 && body[0].parent === sidebar &&
    (body[0].node.type === "column" && body[0].node.children?.length === 1 ||
      body[0].node.type === "row" && body[0].node.children?.length === 2 && body[0].node.children[0].id === SIDEBAR_INSET) &&
    surface[0].parent === body[0].node && surface[0].node.type === "column" &&
    surface[0].node.children?.includes(lists);
}

/** Give the known sidebar and panel the terminal pane's radius and body spacing. */
export function usePanelFrames(source) {
  const layout = structuredClone(source), unchanged = () => ({ layout, changed: false });
  if (!object(layout)) return unchanged();
  const ids = nodes(layout).map(({ node }) => node.id).filter(id => typeof id === "string");
  if (new Set(ids).size !== ids.length) return unchanged();
  const all = nodes(layout), named = id => {
    const found = all.filter(({ node }) => node.id === id);
    return found.length === 1 ? found[0] : null;
  };
  const sidebar = named("sidebar"), lists = named("sidebar-lists"), brand = named("brand"), footer = named("sidebar-footer");
  const body = named("work-body"), panel = named("panel"), main = named("main"), tabs = named("tabs");
  const radius = main?.node.content?.pane?.radius;
  if (!sidebar || !lists || !brand || !footer || !body || !panel || !tabs ||
      sidebar.node.type !== "column" || lists.node.type !== "column" || body.node.type !== "row" ||
      panel.node.type !== "column" || panel.parent !== body.node || main?.parent !== body.node ||
      !Number.isFinite(radius) || radius < 0 || brand.parent !== sidebar.node ||
      brand.node.content?.mod !== "workspace-chrome" ||
      !(footer.node.content?.mod === "workspace-chrome" && footer.node.content.props?.footer === true ||
        footer.node.content?.mod === "sessions-plus" && footer.node.content.props?.role === "sidebar-footer")) return unchanged();
  const wrapped = framedSidebar(all, sidebar.node, lists.node);
  if (wrapped ? sidebar.node.children?.length !== 2 || lists.parent?.children?.length !== 2 || footer.parent !== lists.parent
      : sidebar.node.children?.length !== 3 || lists.parent !== sidebar.node || footer.parent !== sidebar.node ||
        all.some(({ node }) => [SIDEBAR_BODY, SIDEBAR_SURFACE, SIDEBAR_INSET].includes(node.id))) return unchanged();
  const header = tabs.parent?.type === "row" ? tabs.parent : tabs.node;
  if (header === tabs.parent && !header.children?.some(node => node.content?.mod === "sessions-plus" && node.content.props?.role === "toolbar")) return unchanged();
  const before = JSON.stringify(layout), padding = body.node.padding ?? 0;
  const [vertical, horizontal] = Array.isArray(padding) ? padding : [padding, padding];
  let inset, surface;
  if (wrapped) { inset = named(SIDEBAR_BODY).node; surface = named(SIDEBAR_SURFACE).node; }
  else {
    surface = { id: SIDEBAR_SURFACE, type: "column", size: { weight: 1 }, min: 0,
      background: sidebar.node.background ?? "chrome", divider: { width: 0 }, resizable: false, children: [lists.node, footer.node] };
    inset = { id: SIDEBAR_BODY, type: "column", size: { weight: 1 }, min: 0, divider: { width: 0 }, resizable: false, children: [surface] };
    sidebar.node.children = [brand.node, inset];
  }
  // The work body's left padding already supplies the gutter beside the terminal.
  inset.type = "row"; inset.padding = [vertical, 0];
  inset.children = [{ id: SIDEBAR_INSET, type: "column", size: { px: horizontal }, min: 0, max: horizontal, children: [] }, surface];
  surface.radius = radius;
  footer.node.content = { ...footer.node.content, mod: "sessions-plus", props: { ...footer.node.content.props, role: "sidebar-footer", panelRadius: radius } };
  sidebar.node.background = layout.background ?? "canvas";
  // Match the native Tabs bottom rule without shifting either body downward.
  sidebar.node.divider = { width: 1, color: "border" };
  sidebar.node.resizable = false;
  if (Number.isFinite(header.size?.px)) brand.node.size = { ...brand.node.size, px: Math.max(0, header.size.px - 1) };
  panel.node.radius = radius;
  panel.node.background ??= surface.background;
  for (const { node } of nodes(panel.node)) if (node.type === "block" && ["files-plus", "sessions-plus"].includes(node.content?.mod)) {
    node.content.props = { ...node.content.props, panelRadius: radius };
  }
  if (sidebar.parent?.type === "row") sidebar.parent.divider = { ...sidebar.parent.divider, width: 0 };
  return { layout, changed: JSON.stringify(layout) !== before };
}

/** Restore native Spaces after the retired addon; preserve IDs, props, geometry and custom mods. */
export function restoreNativeSpaces(source) {
  const layout = structuredClone(source);
  let changed = false;
  for (const { node } of nodes(layout)) {
    if (node.type === "block" && node.content?.mod === "spaces-plus") {
      node.content = { ...node.content, mod: "spaces" };
      changed = true;
    }
  }
  return { layout, changed };
}

/**
 * Point Spaces blocks at Project Spaces (`on`), or back at Herdr's Spaces. IDs, props and
 * geometry stay. `found`: the layout has a Spaces block of either kind.
 */
export function useProjectSpaces(source, on = true) {
  return swapMod(source, "spaces", "project-spaces", on);
}

/**
 * Point Agents blocks at Agents Plus (`on`), or back at Herdr's Agents. IDs, props and
 * geometry stay. `found`: the layout has an Agents block of either kind.
 */
export function useAgentsPlus(source, on = true) {
  return swapMod(source, "agents", "agents-plus", on);
}

function swapMod(source, native, plus, on) {
  const layout = structuredClone(source);
  const from = on ? native : plus, to = on ? plus : native;
  let changed = false, found = false;
  for (const { node } of nodes(layout)) {
    if (node.type !== "block" || (node.content?.mod !== from && node.content?.mod !== to)) continue;
    found = true;
    if (node.content.mod === from) {
      node.content = { ...node.content, mod: to };
      changed = true;
    }
  }
  return { layout, changed, found };
}

/**
 * Frame tab panes with the Files Plus pane header: terminals look as before, and a file
 * preview shows its file there instead of a second toolbar. Only Herdr's own `pane`
 * header is replaced; other header mods and every header setting stay.
 */
export function usePaneHeader(source) {
  const layout = structuredClone(source);
  let changed = false;
  for (const { node } of nodes(layout)) {
    const header = node.content?.pane?.header;
    if (node.type !== "block" || node.content?.tab !== "active" || !object(header?.content) || header.content.mod !== "pane") continue;
    header.content = { ...header.content, mod: "files-plus", props: { ...(object(header.content.props) ? header.content.props : {}), role: "pane-header" } };
    changed = true;
  }
  return { layout, changed };
}

// This owned layout metadata is outside `children`, so backup block IDs never become live UI nodes.
export const UNIFIED_SIDEBAR_META = "agent_workspace_unified_sidebar";
export function hasUnifiedSidebar(source) {
  return object(source) && (Object.hasOwn(source, UNIFIED_SIDEBAR_META) || nodes(source).some(({ node, parent }) => parent?.id === "sidebar-lists" && node.type === "block" && node.content?.mod === "project-spaces" && node.content.props?.unified === true));
}
function sidebarBlock(node, mod) {
  return object(node) && node.type === "block" && typeof node.id === "string" && node.id && object(node.content) && node.content.mod === mod &&
    (node.content.props == null || object(node.content.props)) && !["tab", "terminal", "pane", "layout"].some(key => Object.hasOwn(node.content, key)) &&
    (node.children === undefined || Array.isArray(node.children) && node.children.length === 0);
}
function sidebarPair(children) {
  if (!Array.isArray(children) || children.length !== 2) return null;
  const spaces = children.filter(node => sidebarBlock(node, "project-spaces")), agents = children.filter(node => sidebarBlock(node, "agents-plus"));
  return spaces.length === 1 && agents.length === 1 && spaces[0].id !== agents[0].id ? { spaces: spaces[0], agents: agents[0] } : null;
}
function unifiedBlock(original) {
  const result = structuredClone(original);
  result.content.props = { ...(result.content.props ?? {}), unified: true };
  result.size = { weight: 1 }; result.min = 0; delete result.max;
  return result;
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sidebarDigest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/**
 * Merge only our recognized two-block sidebar, preserving the Spaces block's identity.
 * Unknown/edited structures are refused before mutation. Off restores the exact saved blocks.
 */
export function useUnifiedSidebar(source, on = true) {
  if (typeof on !== "boolean" || !object(source)) throw new Error("Unified sidebar requires a layout object and a boolean choice.");
  const layout = structuredClone(source), all = nodes(layout), matches = id => all.filter(row => row.node.id === id);
  const lists = matches("sidebar-lists"), sidebars = matches("sidebar");
  if (lists.length !== 1 || sidebars.length !== 1 ||
      (lists[0].parent !== sidebars[0].node && !framedSidebar(all, sidebars[0].node, lists[0].node)) ||
      lists[0].node.type !== "column" || sidebars[0].node.type !== "column") throw new Error("This layout has no unique recognized sidebar/sidebar-lists column. No sidebar was changed.");
  const container = lists[0].node, backup = layout[UNIFIED_SIDEBAR_META];
  const result = (changed, unified, restorable = false) => ({ layout, changed, found: true, unified, restorable });
  if (Object.hasOwn(layout, UNIFIED_SIDEBAR_META)) {
    const keys = ["version", "containerId", "originalChildren", "originalDigest", "unifiedBlock"];
    const original = sidebarPair(backup?.originalChildren);
    if (!object(backup) || Object.keys(backup).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(backup, key)) || backup.version !== 1 || backup.containerId !== container.id || !original || original.spaces.content.props?.unified === true || backup.originalDigest !== sidebarDigest(backup.originalChildren) || !sameJson(backup.unifiedBlock, unifiedBlock(original.spaces))) throw new Error("Unified sidebar metadata is unknown or damaged. It was not replaced.");
    if (!Array.isArray(container.children) || container.children.length !== 1 || !sameJson(container.children[0], backup.unifiedBlock) || matches(original.spaces.id).length !== 1) throw new Error("The unified sidebar was edited or gained extra components. Preserve those edits before restoring; nothing was discarded.");
    if (on) return result(false, true, true);
    if (matches(original.agents.id).length) throw new Error("Restoring the original Agents block would collide with an existing block ID. No sidebar was changed.");
    container.children = structuredClone(backup.originalChildren);
    delete layout[UNIFIED_SIDEBAR_META];
    return result(true, false);
  }
  const children = container.children;
  if (Array.isArray(children) && children.length === 1 && sidebarBlock(children[0], "project-spaces") && children[0].content.props?.unified === true && matches(children[0].id).length === 1) {
    if (!on) throw new Error("This unified sidebar has no original-block metadata, so a precise separate-sidebar restore is unavailable.");
    return result(false, true);
  }
  const pair = sidebarPair(children);
  if (!pair || matches(pair.spaces.id).length !== 1 || matches(pair.agents.id).length !== 1) throw new Error("Unified sidebar supports exactly one Project Spaces and one Agents Plus block in sidebar-lists, without extra components or duplicate IDs. No sidebar was changed.");
  if (pair.spaces.content.props?.unified === true) throw new Error("The separate Agents block conflicts with an already unified Projects flag. No sidebar was changed.");
  if (!on) return result(false, false);
  const originalChildren = structuredClone(children), merged = unifiedBlock(pair.spaces);
  layout[UNIFIED_SIDEBAR_META] = { version: 1, containerId: container.id, originalChildren, originalDigest: sidebarDigest(originalChildren), unifiedBlock: structuredClone(merged) };
  container.children = [merged];
  return result(true, true, true);
}
