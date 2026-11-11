// File references are plain text until the person explicitly adds them to a queue.
export function referencePayload(props = {}) {
  if (typeof props.text === "string") {
    if (props.text.length > 200000 || props.text.includes("\0")) throw new Error("The reference text is unavailable or too large.");
    return { text: props.text, title: String(props.title || "Add to pending prompts").slice(0, 120), machine: Object.hasOwn(props, "on") ? props.on || "" : null };
  }
  const value = props.reference;
  if (!value || typeof value.root !== "string" || !value.root || /[\x00-\x1f\x7f]/.test(value.root) || typeof value.relative !== "string" || /[\x00-\x1f\x7f]/.test(value.relative) || value.relative.startsWith("/") || value.relative.split("/").some(part => part === "." || part === "..")) throw new Error("A captured file reference is required.");
  const base = /^[A-Za-z]:[\\/]|^\\\\/.test(value.root) ? value.root.replace(/[\\/]+$/, "") : value.root.replace(/\/+$/, "");
  const path = value.relative ? `${base}/${value.relative}` : value.root;
  const line = Number.isSafeInteger(value.line) && value.line > 0 ? `:${value.line}` : "";
  const machine = value.on || "";
  return { title: "Add file reference", machine, text: `${value.dir ? "Folder" : "File"} reference${machine ? ` on ${machine}` : ""}:\n${JSON.stringify(path)}${line}\n\n` };
}
export const referenceMachineMatches = (payload, target) => payload.machine === null || payload.machine === (target.machine || "");
