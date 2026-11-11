import { GRAPH_LIMIT, GRAPH_REF_LIMIT, graphHash, parseGraphLog, parseGraphRefs } from "./graph-model.js";
export const GRAPH_GIT = ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false"];
const checked = result => { if (result.code !== 0) throw new Error((result.stderr || "Git graph could not read this checkout.").trim().slice(0, 500)); if (typeof result.stdout !== "string" || result.stdout.length > 700000) throw new Error("Git graph output exceeded its preview limit."); return result.stdout; };
export async function readGraphRepository(execute, context, selection = "all") {
  const cwd = context?.cwd || context?.root, on = context?.on ?? null;
  if (typeof cwd !== "string" || !cwd || cwd.includes("\0")) throw new Error("Choose a captured project folder first.");
  const git = (args, root = cwd) => execute("git", [...GRAPH_GIT, ...args], { cwd: root, on, timeout: 8000 });
  const root = checked(await git(["rev-parse", "--show-toplevel"])).replace(/\r?\n$/, "");
  const [heads, refText] = await Promise.all([git(["rev-parse", "--verify", "--quiet", "HEAD"], root), git(["for-each-ref", `--count=${GRAPH_REF_LIMIT + 1}`, "--sort=refname", "--format=%(refname)%00%(objectname)%00%(*objectname)", "refs/heads", "refs/remotes", "refs/tags"], root)]);
  const head = heads.code === 0 ? checked(heads).trim() : null;
  if (head && !graphHash(head)) throw new Error("Git returned an invalid HEAD.");
  const parsed = parseGraphRefs(checked(refText)); let targets;
  if (selection === "all") targets = ["--branches", "--remotes", "--tags", ...(head ? [head] : [])];
  else if (selection === "HEAD") targets = head ? [head] : [];
  else {
    if (!parsed.refs.some(ref => ref.name === selection)) throw new Error("This branch is no longer available. Refresh the branch list.");
    const resolved = checked(await git(["rev-parse", "--verify", "--end-of-options", `${selection}^{commit}`], root)).trim();
    if (!graphHash(resolved)) throw new Error("The selected reference is not a commit.");
    targets = [resolved];
  }
  if (!head && !parsed.refs.length || !targets.length) return { root, head, refs: parsed.refs, commits: [], limited: false, refsLimited: parsed.limited, selection };
  const history = parseGraphLog(checked(await git(["log", "--topo-order", `--max-count=${GRAPH_LIMIT + 1}`, "--no-show-signature", "--format=%H%x00%P%x00%an%x00%at%x00%s%x00", ...targets, "--"], root)));
  return { root, head, refs: parsed.refs, ...history, refsLimited: parsed.limited, selection };
}
export function createGraphClient(execute, home, node = "node") {
  return async (context, selection) => {
    if (context.on) return readGraphRepository(execute, context, selection);
    const result = await execute(node, [`${home}/mods/files-plus/graph-helper.mjs`, JSON.stringify({ context, selection })], { timeout: 20000 });
    let data; try { data = JSON.parse(result.stdout); } catch { throw new Error("Git graph needs the existing Node.js executable."); }
    if (result.code || data.error) throw new Error(data.error || "Git graph could not read this checkout.");
    return data;
  };
}
