import { SCREEN_LIMITS, validScreenTarget, sameScreenTerminal } from "./screen-picker-model.js";
export function createScreenPickerClient({ execute, home, node = "node", target, current }) {
  if (!validScreenTarget(target) || typeof home !== "string" || !home.startsWith("/") || /[\x00-\x1f\x7f]/.test(home)) throw new Error("An exact captured terminal and absolute Herdr home are required.");
  const captured = { ...target };
  function guard() { if (!sameScreenTerminal(captured, current())) throw new Error("The captured terminal ended or changed. Reopen Screen picker instead of reading the current focus."); }
  async function read(action, history = SCREEN_LIMITS.history) {
    guard();
    const result = await execute(node, [`${home}/mods/sessions-plus/screen-picker-helper.mjs`, JSON.stringify({ action, target: captured, history })], { timeout: action === "scan" ? 25000 : 10000 });
    if (!result || typeof result.stdout !== "string" || result.stdout.length > 4500000) throw new Error("Screen picker returned an oversized response.");
    let data; try { data = JSON.parse(result.stdout); } catch { throw new Error("Screen picker needs the existing Node.js executable and hc on PATH."); }
    if (result.code || data?.error) throw new Error(data?.error || "The captured terminal read failed.");
    guard();
    if (data?.identity?.address !== captured.address || data.identity.created_ms !== captured.created_ms || data.identity.stamp !== captured.stamp) throw new Error("The screen result belongs to a different terminal identity.");
    if (action === "scan" && (!Array.isArray(data.candidates) || data.candidates.length > SCREEN_LIMITS.candidates || data.candidates.some(item => !["url", "path"].includes(item.kind) || !/^pick-(?:[1-9]\d?|1\d\d|200)$/.test(item.id || "") || item.searchText !== undefined && (typeof item.searchText !== "string" || item.searchText.length > 7500) || typeof item.value !== "string" || item.value.length > SCREEN_LIMITS.value || /[\x00-\x1f\x7f]/.test(item.value) || typeof item.excerpt !== "string" || item.excerpt.length > 500))) throw new Error("Screen picker returned invalid captured candidates.");
    return data;
  }
  return { scan: history => read("scan", history), verify: () => read("verify"), guard, target: captured };
}
