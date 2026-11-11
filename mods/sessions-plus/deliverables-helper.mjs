// Explicit local metadata CLI. Example: node deliverables-helper.mjs add --root /repo --file reports/result.md
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { deliverableRequest } from "./deliverables-store.mjs";
export async function deliverablesMain(argv) {
  if (argv[0] === "request") { const payload = JSON.parse(argv[1] || "null"); if (!payload || !payload.home || !payload.request) throw new Error("A captured storage request is required."); return deliverableRequest(payload.home, payload.request); }
  if (argv[0] !== "add") throw new Error("Usage: add --root <folder> [--on <machine>] (--file <path> | --url <http(s)>) [--title <title>] [--note <text>] [--home <Herdr app home>]");
  const flags = {}; for (let index = 1; index < argv.length; index += 2) { if (!["--root", "--on", "--file", "--url", "--title", "--note", "--home"].includes(argv[index]) || argv[index + 1] === undefined || Object.hasOwn(flags, argv[index])) throw new Error("Invalid or duplicate CLI option."); flags[argv[index]] = argv[index + 1]; }
  if (!flags["--root"] || Boolean(flags["--file"]) === Boolean(flags["--url"])) throw new Error("Specify --root and exactly one of --file or --url.");
  return deliverableRequest(flags["--home"] || process.env.HERDR_APP_HOME || path.join(os.homedir(), ".config", "herdr-app"), { action: "add", scope: { root: flags["--root"], on: flags["--on"] || null }, value: { kind: flags["--file"] ? "file" : "url", location: flags["--file"] || flags["--url"], title: flags["--title"] || "", note: flags["--note"] || "" } });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) deliverablesMain(process.argv.slice(2)).then(value => console.log(JSON.stringify(value)), error => { console.log(JSON.stringify({ error: String(error.message || error), code: error.code || "error" })); process.exitCode = 1; });
