import { activityTarget, activityPage } from "./activity-model.js";
export function createActivityClient(execute, home, props = {}) {
  return async (mode, row, cursor = null) => {
    if (!["timeline", "gallery"].includes(mode)) throw new Error("Unsupported session activity view.");
    const target = activityTarget(row), request = { mode, target, cursor, appHome: home, options: { stores: { ...(props.stores || {}), [target.provider]: target.store } } };
    const result = await execute(props.node || "node", [`${home}/mods/sessions-plus/activity.mjs`, JSON.stringify(request)], { timeout: 12000 });
    if (typeof result?.stdout !== "string" || result.stdout.length > 600000) throw new Error("The session activity response exceeded its limit.");
    let value; try { value = JSON.parse(result.stdout); } catch { throw new Error("Session activity needs the existing Node.js executable. No transcript was changed."); }
    if (result.code || value?.error) throw new Error(value?.error || "Could not read the captured session activity.");
    return activityPage(value, target, mode);
  };
}
