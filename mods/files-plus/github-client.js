import { GITHUB_LIMITS, githubContext, githubJson, githubRepo, githubPr, githubList, githubChecks, githubCounts, githubThreads, githubLogTarget, githubError } from "./github-model.js";

export const PR_FIELDS = "number,title,url,state,isDraft,headRefName,baseRefName,headRefOid,reviewDecision,updatedAt";
export const DETAIL_FIELDS = `${PR_FIELDS},body,mergeStateStatus,statusCheckRollup`;
export const DETAIL_JQ = '{number,title,url,state,isDraft,headRefName,baseRefName,headRefOid,reviewDecision,updatedAt,mergeStateStatus,body:(.body // "" | .[0:12000]),bodyTruncated:((.body // "" | length)>12000),statusCheckRollup:(.statusCheckRollup // [] | .[0:150]),checksLimited:((.statusCheckRollup // [] | length)>150)}';
export const THREAD_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number headRefOid reviewThreads(first:50){pageInfo{hasNextPage} nodes{isResolved isOutdated path line comments(first:1){nodes{bodyText url author{login}}}}}}}}';
export const THREAD_JQ = 'if (.errors | length) > 0 then {error:"GitHub could not read review threads."} else .data.repository.pullRequest | {number,headRefOid,hasNextPage:.reviewThreads.pageInfo.hasNextPage,threads:[.reviewThreads.nodes[] | {isResolved,isOutdated,path,line,body:(.comments.nodes[0].bodyText // "" | .[0:2000]),bodyTruncated:((.comments.nodes[0].bodyText // "" | length)>2000),url:.comments.nodes[0].url,author:.comments.nodes[0].author.login}]} end';

// Used by the bounded local helper and the remote Herdr transport; every command is read-only.
export async function readGithub(request, execute) {
  const context = githubContext(request.context), options = { cwd: context.root, on: context.on, timeout: 12000 };
  const command = async (program, args, log = false) => {
    let result;
    try { result = await execute(program, args, { ...options, log }); }
    catch (error) { throw new Error(githubError(error, program)); }
    if (result?.code !== 0) throw new Error(githubError(new Error(result?.stderr || `${program} read failed.`), program));
    if (typeof result.stdout !== "string" || !log && result.stdout.length > GITHUB_LIMITS.json) throw new Error("GitHub output exceeded the bounded preview limit.");
    return result;
  };
  const json = async args => {
    const value = githubJson((await command("gh", args)).stdout);
    if (value?.error || value?.errors?.length) throw new Error("GitHub could not read the requested data. Previous data was retained.");
    return value;
  };
  if (request.action === "list") {
    const repo = githubRepo(await json(["repo", "view", "--json", "nameWithOwner,url"]));
    if (request.repo && githubRepo(request.repo).spec.toLowerCase() !== repo.spec.toLowerCase()) throw new Error("The repository at the captured folder changed. Reopen Pull requests to choose its new repository.");
    const branch = (await command("git", ["--no-optional-locks", "branch", "--show-current"])).stdout.replace(/\r?\n$/, "");
    const base = ["pr", "list", "--repo", repo.spec, "--json", PR_FIELDS];
    const values = await json([...base, "--state", "open", "--limit", "40"]);
    const current = branch ? await json([...base, "--state", "all", "--head", branch, "--limit", "1"]) : [];
    return { repo, branch, prs: githubList(values, current, branch, repo), limited: Array.isArray(values) && values.length === 40, fetched: Date.now() };
  }
  const repo = githubRepo(request.repo);
  if (request.action === "detail") {
    if (!Number.isSafeInteger(request.number) || request.number < 1) throw new Error("Choose a captured pull request.");
    const value = await json(["pr", "view", String(request.number), "--repo", repo.spec, "--json", DETAIL_FIELDS, "--jq", DETAIL_JQ]);
    const pr = githubPr(value, repo);
    if (pr.number !== request.number) throw new Error("GitHub returned a different pull request.");
    const checks = githubChecks(value.statusCheckRollup, repo);
    const threadData = await json(["api", "graphql", "--hostname", repo.host, "-f", `query=${THREAD_QUERY}`, "-f", `owner=${repo.owner}`, "-f", `name=${repo.name}`, "-F", `number=${pr.number}`, "--jq", THREAD_JQ]);
    const threads = githubThreads(threadData, repo, pr);
    return { pr, checks, counts: githubCounts(checks), threads: threads.threads, threadsLimited: threads.limited, checksLimited: value.checksLimited === true, fetched: Date.now() };
  }
  if (request.action === "log") {
    const target = githubLogTarget(request.check, repo);
    if (!target || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(request.head || "")) throw new Error("Only a captured failed GitHub Actions check can load a log.");
    const run = await json(["run", "view", target.run, "--repo", repo.spec, "--json", "headSha"]);
    if (run?.headSha !== request.head) throw new Error("This workflow run belongs to another head commit. Refresh the PR before reading logs.");
    const output = await command("gh", ["run", "view", target.run, "--repo", repo.spec, ...(target.job ? ["--job", target.job] : []), "--log-failed"], true);
    return { text: output.stdout.slice(0, GITHUB_LIMITS.log), truncated: output.truncated === true || output.stdout.length > GITHUB_LIMITS.log, run: target.run, job: target.job, head: request.head };
  }
  throw new Error("Unsupported GitHub read action.");
}

export function createGithubClient({ execute, home, node = "node" }) {
  async function read(action, context, values = {}) {
    const captured = githubContext(context), request = { action, context: captured, ...values };
    if (captured.on) return readGithub(request, (program, args, options) => execute(program === "gh" ? "env" : program, program === "gh" ? ["-u", "GH_REPO", "gh", ...args] : args, { cwd: options.cwd, on: options.on, timeout: options.timeout }));
    if (typeof home !== "string" || !home.startsWith("/") || /[\x00-\x1f]/.test(home)) throw new Error("An absolute Herdr home is required.");
    let result;
    try { result = await execute(node, [`${home}/mods/files-plus/github-helper.mjs`, JSON.stringify(request)], { timeout: 28000 }); }
    catch (error) { throw new Error(githubError(error, "node")); }
    const value = githubJson(result?.stdout || "");
    if (result.code || value?.error) throw new Error(value?.error || "The GitHub helper did not confirm a read.");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The GitHub helper returned an invalid result.");
    return value;
  }
  return { list: (context, repo = null) => read("list", context, { repo }), detail: (context, repo, number) => read("detail", context, { repo, number }), log: (context, repo, check, head) => read("log", context, { repo, check, head }) };
}
