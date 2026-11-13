import { TYPE } from "../../mods/files-plus/type-scale.js";

// UI fixtures strip module imports; provide the same scale to their evaluated source.
export function uiFunction(...parameters) {
  return new Function("TYPE", ...parameters).bind(undefined, TYPE);
}
