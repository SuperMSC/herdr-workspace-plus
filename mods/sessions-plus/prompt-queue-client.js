import { promptTarget, promptStatus, samePromptTarget } from "./prompt-queue-model.js";

export async function deliverPrompts(prepared, { current, inspect, send }) {
  const target = prepared.target;
  if (!samePromptTarget(target, current())) throw new Error("The selected agent changed or ended. Choose it again before sending.");
  const result = await inspect(target.address);
  let terminal;
  try { terminal = JSON.parse(result.stdout); } catch { throw new Error("Could not verify the selected agent. Nothing was sent."); }
  const agent = current();
  if (result.code !== 0 || !samePromptTarget(target, agent) || !samePromptTarget(target, promptTarget({ ...agent, address: target.address }, { ...terminal, address: target.address }))) {
    throw new Error("The selected agent changed or ended. Nothing was sent.");
  }
  const status = promptStatus(terminal.status);
  if (!["idle", "working"].includes(status)) throw new Error("The agent needs a response to its current dialog. Return to it before sending instructions.");
  const reply = await send(["send", "--json", "--if", status, target.address, prepared.message]);
  if (reply.code !== 0) throw new Error("Delivery was not confirmed. Check the agent before allowing a retry.");
  let body;
  try { body = JSON.parse(reply.stdout); } catch { throw new Error("Delivery was not confirmed. Check the agent before allowing a retry."); }
  if (!body || typeof body !== "object" || body.error || body.ok === false || !Number.isSafeInteger(body.turn) || body.turn < 0) throw new Error("Delivery was not confirmed. Check the agent before allowing a retry.");
}
