import { commandState, commandRevision } from "./commands-model.js";
import { presetState, presetRevision } from "./presets-model.js";

export function searchScore(text, query) {
  text = String(text).toLocaleLowerCase(); query = String(query).trim().toLocaleLowerCase();
  if (!query) return 0;
  let score = 0;
  for (const word of query.split(/\s+/)) {
    const exact = text.indexOf(word);
    if (exact >= 0) { score += exact + (exact && /[\p{L}\p{N}]/u.test(text[exact - 1]) ? 10 : 0); continue; }
    let at = -1, first = -1;
    for (const char of word) { at = text.indexOf(char, at + 1); if (at < 0) return null; if (first < 0) first = at; }
    score += 80 + at - first;
  }
  return score;
}

export function launcherRows(snapshot, query = "") {
  const live = new Map(snapshot.terminals.filter(t => t.state === "live").map(t => [t.address, t]));
  const rows = snapshot.agents.filter(a => live.has(a.address)).map(a => {
    const terminal = live.get(a.address);
    return { id: `agent:${a.address}:${terminal.created_ms}`, kind: "agent", title: a.title || a.tab_name || a.program?.name || a.address,
      detail: `${a.status} · ${a.space_name || ""} · ${a.address}`, priority: a.status === "blocked" ? 0 : a.status === "done" ? 1 : 3, address: a.address, created: terminal.created_ms };
  });
  rows.push(...snapshot.spaces.map(s => ({ id: `space:${s.id}`, kind: "space", title: s.name, detail: `${s.machine || "local"} · ${s.folder}`, space: s.id, priority: s.active ? 4 : 5 })));
  for (const project of commandState(snapshot.commands).projects) for (const c of project.commands) rows.push({
    id: `command:${project.key}:${c.id}`, kind: "command", title: c.title, detail: `${project.context.on || "local"} · ${c.cwd}`,
    context: project.context, commandId: c.id, revision: commandRevision(c), priority: c.favorite ? 2 : 6,
  });
  for (const p of presetState(snapshot.presets).presets) rows.push({ id: `preset:${p.id}`, kind: "preset", title: p.name,
    detail: `${p.on || "local"} · ${p.root}`, presetId: p.id, revision: presetRevision(p), priority: p.favorite ? 2 : 7 });
  rows.push(...[
    ["new-agent", "Start an agent…", "Choose a space and an installed agent"],
    ["git-overview", "Git overview", "Pending work across local repositories"],
    ["commands", "Project commands", "Saved commands and run output"],
    ["presets", "Project presets", "Saved workspaces"],
    ["notes", "Notes", "Project, session and global notes"],
    ["prompt-queue", "Pending prompts", "Drafts and queued instructions"],
    ["palette", "All Herdr commands", "Open the command palette"],
    ["settings", "Settings", "Herdr preferences"],
  ].map(([action, title, detail]) => ({ id: `action:${action}`, kind: "action", action, title, detail, priority: 8 })));
  return rankRows(rows, query);
}
export function rankRows(rows, query) {
  return rows.map(row => ({ ...row, score: searchScore(`${row.title} ${row.detail || ""}`, query) }))
    .filter(row => row.score !== null).sort((a, b) => a.score - b.score || a.priority - b.priority || a.title.localeCompare(b.title)).slice(0, 100);
}
export function sameLauncherTarget(captured, current) {
  return Boolean(current && captured.id === current.id && captured.revision === current.revision && captured.created === current.created);
}
