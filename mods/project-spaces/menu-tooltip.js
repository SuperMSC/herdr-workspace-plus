// Popup lifecycle state is scoped to its owning sidebar, never to a workspace target.
import { shared, setShared } from "herdr";

export const MENU_TOOLTIP_KEY = "project-spaces.menu-tooltip.v1";
let serial = 0;

export function menuTooltipState(scope) {
  if (!scope) return null;
  const current = shared(MENU_TOOLTIP_KEY);
  return current && current.scope === scope && typeof current.token === "string" ? current : null;
}

export function beginMenuTooltip(scope) {
  const token = `${Date.now().toString(36)}-${++serial}-${Math.random().toString(36).slice(2)}`;
  setShared(MENU_TOOLTIP_KEY, { scope, token });
  return token;
}

export function endMenuTooltip(scope, token) {
  const current = menuTooltipState(scope);
  if (!current || current.token !== token) return false;
  setShared(MENU_TOOLTIP_KEY, null);
  return true;
}

export function menuTooltipKey(id, state) {
  return state ? `${id}:tooltip-${state.token}-${state.open ? "popup" : "ready"}` : id;
}
