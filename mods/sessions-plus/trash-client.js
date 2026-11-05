// Keep filesystem access in the helper; identities are separate argv values.
export function createTrashClient(exec, p, home) {
  const config = JSON.stringify({ stores: p.stores ?? {}, stateDir: home + "/session-trash" });
  return async (action, identity = "") => {
    const result = await exec(p.node || "node", [home + "/mods/sessions-plus/trash.mjs", action, config, identity]);
    let data;
    try { data = JSON.parse(result.stdout); }
    catch { throw new Error("Session Trash needs Node.js 22+ on PATH. Set the mod's node prop to its executable if needed."); }
    if (result.code || data.error) {
      const error = new Error(data.error || "Could not update Session Trash.");
      if (data.code === "SESSION_MISSING") error.code = data.code;
      throw error;
    }
    return data;
  };
}
