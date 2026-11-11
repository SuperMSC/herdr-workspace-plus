export function createDeliverablesClient(execute, home, node = "node") {
  return async request => {
    const result = await execute(node, [`${home}/mods/sessions-plus/deliverables-helper.mjs`, "request", JSON.stringify({ home, request })], { timeout: 10000 });
    let value; try { value = JSON.parse(result.stdout || "{}"); } catch { throw new Error("Delivery lists need the existing Node.js executable. No records were changed."); }
    if (result.code || value.error) { const error = new Error(value.error || "The delivery list could not be read."); error.code = value.code || "error"; throw error; }
    return value;
  };
}
