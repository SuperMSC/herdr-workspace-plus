import { TYPE } from "./type-scale.js";
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { exec, appHome, theme, settings, readTextFile, openOverlay, closeOverlay } from "herdr";
import { createGithubClient } from "./github-client.js";
import { GITHUB_LIMITS, githubContext, githubRepo, githubPr, githubCounts, githubUrl, githubLogTarget, githubSummary, githubError } from "./github-model.js";

export default class GithubPanel {
  init(p, cx) {
    this.p = p; this.width = 850; this.prs = []; this.details = new Map(); this.error = ""; this.detailError = "";
    this.generation = 0; this.detailGeneration = 0; this.logGeneration = 0;
    this.handle = cx.focus_handle(); this.handle.focus();
    this.client = createGithubClient({ execute: exec, home: appHome(), node: p.node || "node" });
    try { this.context = githubContext(p.context || p); this.refresh(cx); }
    catch (error) { this.error = githubError(error); }
  }
  refresh(cx) {
    if (!this.context || this.loading || this.disposed) return;
    const generation = ++this.generation; ++this.detailGeneration; ++this.logGeneration;
    this.loading = true; this.detailLoading = false; this.logLoading = false; this.error = ""; cx.notify();
    const context = { ...this.context }, repo = this.repo;
    cx.spawn(async cx => {
      try {
        const result = await this.client.list(context, repo);
        if (this.disposed || this.generation !== generation) return;
        const nextRepo = githubRepo(result.repo);
        if (repo && nextRepo.spec.toLowerCase() !== repo.spec.toLowerCase()) throw new Error("The captured repository changed. Reopen Pull requests to choose it again.");
        if (!Array.isArray(result.prs) || result.prs.length > GITHUB_LIMITS.prs || typeof result.branch !== "string" || !Number.isFinite(result.fetched)) throw new Error("GitHub returned an invalid list snapshot.");
        const prs = result.prs.map(pr => githubPr(pr, nextRepo));
        this.details = new Map([...this.details].filter(([number]) => prs.some(pr => pr.number === number)));
        this.repo = nextRepo; this.prs = prs; this.branch = result.branch; this.limited = result.limited === true; this.fetched = result.fetched; this.stale = false;
        const selected = prs.find(pr => pr.number === this.selected) || prs[0];
        if (selected) this.choose(selected.number, cx, true);
        else { this.selected = null; this.detail = null; this.clearLog(); }
      } catch (error) {
        if (!this.disposed && this.generation === generation) { this.error = githubError(error); this.stale = Boolean(this.repo); this.detailStale = Boolean(this.detail); }
      } finally { if (!this.disposed && this.generation === generation) { this.loading = false; cx.notify(); } }
    });
  }
  choose(number, cx, force = false) {
    if (this.disposed || !this.repo || !this.prs.some(pr => pr.number === number) || !force && this.selected === number && this.detail) return;
    const generation = ++this.detailGeneration, repo = this.repo, context = { ...this.context };
    ++this.logGeneration; this.clearLog(); this.selected = number; this.detail = this.details.get(number) || null;
    this.detailStale = Boolean(this.detail); this.detailLoading = true; this.detailError = ""; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await this.client.detail(context, repo, number);
        if (this.disposed || this.detailGeneration !== generation || this.selected !== number) return;
        const pr = githubPr(result.pr, repo);
        if (pr.number !== number || !Array.isArray(result.checks) || result.checks.length > GITHUB_LIMITS.checks || result.checks.some(check => !["passed", "failed", "pending", "skipped", "cancelled", "unknown"].includes(check?.status) || typeof check.name !== "string") || !Array.isArray(result.threads) || result.threads.length > GITHUB_LIMITS.threads || result.threads.some(thread => typeof thread?.path !== "string" || typeof thread.body !== "string") || !Number.isFinite(result.fetched)) throw new Error("GitHub returned an invalid detail snapshot.");
        const detail = { ...result, pr, counts: githubCounts(result.checks) };
        this.details.set(number, detail); this.detail = detail; this.detailStale = false;
      } catch (error) { if (!this.disposed && this.detailGeneration === generation) { this.detailError = githubError(error); this.detailStale = Boolean(this.detail); } }
      finally { if (!this.disposed && this.detailGeneration === generation) { this.detailLoading = false; cx.notify(); } }
    });
  }
  clearLog() { this.logEditor?.release(); this.logEditor = null; this.log = null; this.logError = ""; this.logLoading = false; }
  logs(check, cx) {
    const detail = this.detail, repo = this.repo;
    if (!detail || this.logLoading || !githubLogTarget(check, repo)) return;
    const generation = ++this.logGeneration, number = detail.pr.number, head = detail.pr.headRefOid;
    this.clearLog(); this.logLoading = true; cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await this.client.log({ ...this.context }, repo, check, head);
        if (this.disposed || this.logGeneration !== generation || this.selected !== number || this.detail?.pr.headRefOid !== head) return;
        if (typeof result.text !== "string" || result.text.length > GITHUB_LIMITS.log || result.head !== head) throw new Error("GitHub returned an invalid log snapshot.");
        this.logEditor = EditorState.new({ value: result.text || "No failed-step output is available for this run.", readonly: true, language: "text", line_numbers: false, soft_wrap: true, font_family: settings().font_family });
        this.log = { ...result, name: check.name };
      } catch (error) { if (!this.disposed && this.logGeneration === generation) this.logError = githubError(error); }
      finally { if (!this.disposed && this.logGeneration === generation) { this.logLoading = false; cx.notify(); } }
    });
  }
  open(url, cx) {
    const safe = this.repo && githubUrl(url, this.repo);
    if (!safe) { this.detailError = "This link is outside the verified repository host or repository."; cx.notify(); return; }
    cx.open_url(safe);
  }
  queue(cx) {
    if (!this.detail || this.referenceBusy || this.disposed) return;
    const text = githubSummary(this.repo, this.detail, this.stale || this.detailStale), title = `PR #${this.detail.pr.number}`, on = this.context.on;
    this.referenceBusy = true; cx.notify();
    cx.spawn(async cx => {
      try {
        if (await readTextFile(`${appHome()}/mods/sessions-plus/mod.json`) === null) throw new Error("Pending prompts requires the Sessions Plus companion. Run the full workspace updater first.");
        if (!this.disposed) openOverlay({ mod: "sessions-plus", kind: "dialog", frame: "none", width: 660, height: 640, props: { role: "prompt-queue", text, title, on } });
      } catch (error) { if (!this.disposed) this.detailError = githubError(error); }
      finally { if (!this.disposed) { this.referenceBusy = false; cx.notify(); } }
    });
  }
  close() { this.disposed = true; ++this.generation; ++this.detailGeneration; ++this.logGeneration; this.clearLog(); }
  render(cx) {
    const t = theme(), busy = this.loading;
    const button = (id, label, callback, disabled = false) => div().id(id).px(8).py(5).flex_none().rounded(5).bg(t.raised).text_color(disabled ? t.dim : t.foreground)
      .when(!disabled, el => el.cursor_pointer().hover(row => row.bg(t.hover))).on_click((_event, cx) => { cx.stop_propagation(); if (!disabled) callback(cx); }).child(label);
    const tone = status => status === "failed" ? t.ansi1 : status === "passed" ? t.ansi2 : status === "pending" ? t.working : t.muted;
    const statusText = pr => `${pr.isDraft ? "Draft" : pr.state === "MERGED" ? "Merged" : pr.state === "CLOSED" ? "Closed" : "Open"} · ${pr.reviewDecision.replace(/_/g, " ").toLowerCase() || "No review decision"}`;
    const list = v_flex().id("github-pr-list").min_h(0).gap(5).overflow_y_scrollbar().children(this.prs.map(pr => div().id(`github-pr-${pr.number}`).p(8).rounded(5).bg(this.selected === pr.number ? t.selected : t.raised).cursor_pointer().hover(row => row.bg(t.hover))
      .on_click((_event, cx) => this.choose(pr.number, cx)).child(div().font_semibold().child(`#${pr.number} ${pr.title}`))
      .child(div().text_size(TYPE.xs).text_color(t.muted).child(statusText(pr)))
      .child(div().text_size(TYPE.xs).text_color(t.dim).truncate().tooltip(pr.headRefName).child(`${pr.headRefName === this.branch ? "Branch name match · " : ""}${pr.headRefName}`))));
    const detail = this.detail;
    let preview = v_flex().id("github-pr-detail").flex_1().min_w(0).min_h(0).gap(8);
    if (detail) {
      const { pr, checks, counts, threads } = detail;
      preview = preview.child(h_flex().gap(6).items_center().flex_wrap()
        .child(button("github-open-pr", "Open GitHub", cx => this.open(pr.url, cx)))
        .child(button("github-copy-pr", "Copy link", cx => cx.write_to_clipboard(pr.url)))
        .child(button("github-copy-summary", "Copy summary", cx => cx.write_to_clipboard(githubSummary(this.repo, detail, this.stale || this.detailStale))))
        .child(button("github-queue", "Add to pending prompts…", cx => this.queue(cx), this.referenceBusy)))
        .child(div().font_semibold().text_size(TYPE.lg).child(`#${pr.number} ${pr.title}`))
        .child(div().text_size(TYPE.sm).text_color(t.muted).child(statusText(pr)))
        .child(div().text_size(TYPE.xs).text_color(t.dim).child(`${pr.headRefName} → ${pr.baseRefName}`))
        .child(div().text_size(TYPE.xs).text_color(t.dim).tooltip(pr.headRefOid).child(`Head ${pr.headRefOid.slice(0, 12)} · ${pr.mergeStateStatus || "Merge state unavailable"}`))
        .when(this.detailStale || this.stale, el => el.child(div().text_color(t.ansi3).child("Stale snapshot · refresh failed or newer data is loading")))
        .child(div().font_semibold().child(checks.length ? `${counts.passed} passed · ${counts.failed} failed · ${counts.pending} pending` : "No checks reported"))
        .when(Boolean(counts.skipped || counts.cancelled || counts.unknown), el => el.child(div().text_size(TYPE.xs).text_color(t.muted).child(`${counts.skipped} skipped · ${counts.cancelled} cancelled · ${counts.unknown} unknown`)));
      const contents = v_flex().id("github-detail-scroll").flex_1().min_h(0).gap(7).overflow_y_scrollbar()
        .children(checks.map(check => h_flex().id(`github-check-${check.index}`).gap(6).items_center().flex_none()
          .child(div().flex_1().min_w(0).text_color(tone(check.status)).child(`${check.name} · ${check.state}`))
          .when(Boolean(check.url), el => el.child(button(`github-check-open-${check.index}`, "Open", cx => this.open(check.url, cx))))
          .when(Boolean(githubLogTarget(check, this.repo)), el => el.child(button(`github-check-log-${check.index}`, "Failed log", cx => this.logs(check, cx), this.logLoading)))))
        .when(detail.checksLimited, el => el.child(div().text_size(TYPE.xs).text_color(t.ansi3).child("Only the first 150 checks are shown.")))
        .child(div().pt(8).font_semibold().child(`Unresolved review threads (${threads.length}${detail.threadsLimited ? "+" : ""})`))
        .when(detail.threadsLimited, el => el.child(div().text_size(TYPE.xs).text_color(t.ansi3).child("Only the first 50 review threads were inspected; more unresolved threads may exist.")))
        .children(threads.map(thread => v_flex().id(`github-thread-${thread.index}`).flex_none().gap(4).p(8).rounded(5).bg(t.raised)
          .child(div().text_size(TYPE.sm).font_semibold().child(`${thread.path}${thread.line ? ":" + thread.line : ""}${thread.outdated ? " · Outdated position" : ""}`))
          .child(div().text_size(TYPE.sm).child(thread.body || "No comment text available."))
          .when(thread.truncated, el => el.child(div().text_size(TYPE.xs).text_color(t.dim).child("Comment excerpt limited to 2,000 characters.")))
          .when(Boolean(thread.url), el => el.child(button(`github-thread-open-${thread.index}`, "Open thread", cx => this.open(thread.url, cx))))))
        .when(Boolean(pr.body), el => el.child(div().pt(8).font_semibold().child("Description")).child(div().text_size(TYPE.sm).child(pr.body.slice(0, 4000))))
        .when(pr.bodyTruncated || pr.body.length > 4000, el => el.child(div().text_size(TYPE.xs).text_color(t.dim).child("Description excerpt · open GitHub for the full text.")));
      preview = preview.child(contents);
    } else preview = preview.child(div().p(10).text_color(t.muted).child(this.detailLoading ? "Reading checks and review threads…" : this.repo && !this.prs.length ? "No pull requests found for this branch or the open list." : "Choose a pull request to read checks and review threads."));
    if (this.logEditor) preview = v_flex().flex_1().min_h(0).gap(7)
      .child(h_flex().gap(6).child(button("github-log-back", "Back to PR", cx => { ++this.logGeneration; this.clearLog(); cx.notify(); })).child(button("github-log-copy", "Copy log", cx => cx.write_to_clipboard(this.log.text))))
      .child(div().font_semibold().child(this.log.name)).when(this.log.truncated, el => el.child(div().text_color(t.ansi3).child("Failed log truncated to the first 64 KB.")))
      .child(div().flex_1().min_h(100).border_1().border_color(t.border).rounded(5).child(Editor.new(this.logEditor).size_full()));
    const body = this.width >= 680 ? h_flex().flex_1().min_h(0).min_w(0).gap(10).child(list.w(260).flex_none()).child(preview) : v_flex().flex_1().min_h(0).gap(8).child(list.max_h(175).flex_none()).child(preview);
    return v_flex().id("github-panel").size_full().min_h(0).min_w(0).p(12).gap(8).rounded(10).bg(t.background).text_color(t.foreground).text_size(TYPE.md).track_focus(this.handle)
      .on_size_change((size, cx) => { if (Math.abs(this.width - size.width) > 1) { this.width = size.width; cx.notify(); } })
      .on_key_down((event, cx) => { if (event.key === "escape" && this.p.overlay) { closeOverlay(this.p.overlay); cx.stop_propagation(); } })
      .child(h_flex().gap(7).items_center().flex_none().child(svg("mods/files-plus/github.svg").size(16).text_color(t.muted)).child(div().flex_1().font_semibold().text_size(TYPE.lg).child("Pull requests / CI"))
        .child(div().id("github-refresh").w(26).h(26).flex_none().rounded(5).flex().items_center().justify_center().text_color(t.muted).tooltip([busy ? "Reading GitHub…" : "Refresh captured repository", `Read only · manual refresh · ${this.fetched ? new Date(this.fetched).toLocaleString() : "No successful read yet"}`].join("\n")).accessibility_label("Refresh pull requests")
          .when(!busy && Boolean(this.context), el => el.cursor_pointer().hover(row => row.bg(t.hover))).on_click((_event, cx) => { if (!busy) this.refresh(cx); }).child(svg("mods/files-plus/refresh.svg").size(14).when(busy, el => el.spin(850)))))
      .child(div().flex_none().text_size(TYPE.xs).text_color(t.dim).truncate().tooltip(this.context ? `${this.context.on || "This computer"} · ${this.context.root}` : "").child(this.repo ? `${this.repo.nameWithOwner} · ${this.context.on || "This computer"}` : this.context ? `${this.context.on || "This computer"} · ${this.context.root}` : "No captured repository"))
      .when(Boolean(this.error), el => el.child(div().text_color(t.ansi1).child(this.error)))
      .when(this.stale, el => el.child(div().text_color(t.ansi3).child("The previous repository data is retained as stale.")))
      .when(busy, el => el.child(div().text_size(TYPE.sm).text_color(t.muted).child("Reading repository and pull requests…")))
      .child(body)
      .when(this.detailLoading && Boolean(detail), el => el.child(div().text_size(TYPE.xs).text_color(t.muted).child("Refreshing PR details…")))
      .when(this.logLoading, el => el.child(div().text_size(TYPE.xs).text_color(t.muted).child("Reading failed-step log…")))
      .when(Boolean(this.detailError || this.logError), el => el.child(div().max_h(75).overflow_y_scrollbar().text_size(TYPE.sm).text_color(t.ansi1).child(this.detailError || this.logError)))
      .when(this.limited, el => el.child(div().text_size(TYPE.xs).text_color(t.ansi3).child("List limited to 40 pull requests, with the current branch first.")));
  }
}
