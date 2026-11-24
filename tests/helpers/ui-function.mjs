import { TYPE } from "../../mods/files-plus/type-scale.js";

// UI fixtures strip module imports; provide the same scale to their evaluated source.
// Mods skip periodic timers during `herdr-app check`; fixtures run as a live window unless they pass their own `checking`.
export function uiFunction(...parameters) {
  if (parameters.slice(0, -1).includes("checking")) return new Function("TYPE", ...parameters).bind(undefined, TYPE);
  return new Function("TYPE", "checking", ...parameters).bind(undefined, TYPE, () => false);
}
