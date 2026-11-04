// Modified from Herdr Changes (Apache-2.0): captured context menus, staged-only commits and guarded refreshes.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, openOverlay, shared, setShared } from "herdr";
import { CHANGE_KEY, targetFor, menuHeight } from "./model.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes {
  init(_props, cx) {
    this.lastChange = shared(CHANGE_KEY)?.revision;
    this.refreshRequest = 0; this.diffRequest = 0; this.reloadAgain = false; this.hasStaged = false;
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  current(context, request) {
    return this.context === context && key() === context && (request === undefined || this.refreshRequest === request);
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try {
        while (this.current(context) && this.watched === root) {
          await watchFolder(root);
          if (this.current(context) && this.watched === root) this.refresh(cx);
        }
      } catch { if (this.context === context && this.watched === root) this.watched = null; }
    });
  }

  refresh(cx) {
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.refreshRequest++; this.diffRequest++; this.loading = false; this.reloadAgain = false;
      this.context = context; this.root = null; this.on = on; this.files = []; this.open = null; this.hasStaged = false;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    if (this.loading || this.busy) { this.reloadAgain = true; return; }
    const request = ++this.refreshRequest;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const top = await exec("git", [...READ, "rev-parse", "--show-toplevel"], { cwd, on });
        if (!this.current(context, request)) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.hasStaged = false; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.replace(/\r?\n$/, ""), git = args => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (!this.current(context, request)) return;
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        if (!this.current(context, request)) return;
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [], entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          const deleted = xy[1] === "D" || (xy[0] === "D" && xy[1] === " ");
          files.push({ path, xy, deleted, status: s, fresh, ...stat });
        }
        if (!this.current(context, request)) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.hasStaged = entries.some(entry => ![" ", "?", "!"].includes(entry[0]));
        this.watch(root, cx);
        if (this.open && !files.some(f => f.path === this.open)) { this.open = null; this.diffRequest++; this.setLines([]); }
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) await this.load(this.open, context);
      } catch (error) { if (this.current(context, request)) this.error = String(error.message ?? error); }
      finally {
        if (this.context === context && this.refreshRequest === request) {
          this.loading = false;
          if (this.reloadAgain) { this.reloadAgain = false; this.refresh(cx); }
        }
        cx.notify();
      }
    });
  }

  async load(path, context) {
    const request = ++this.diffRequest;
    const file = this.files.find(f => f.path === path), root = this.root, on = this.on, hasHead = this.hasHead;
    const current = () => this.current(context) && this.open === path && this.diffRequest === request && this.root === root;
    if (!file) return;
    try {
      let lines, additions;
      if (file.fresh || (!hasHead && file.status === "A" && !file.deleted)) {
        const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
        if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
        else if (text.includes("\0")) lines = ["Binary file · no text diff"];
        else {
          additions = countLines(text);
          lines = [`@@ -0,0 +1,${additions} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(line => `+${line}`)];
        }
      } else {
        const result = await exec("git", [...READ, "--literal-pathspecs", "diff", ...(hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
        if (result.code !== 0) throw new Error(result.stderr);
        const all = result.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex(line => line.startsWith("@@"));
        lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
      }
      if (current()) {
        if (additions !== undefined) file.add = additions;
        this.note = null;
        this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
      }
    } catch (error) {
      if (current()) this.note = `Cannot preview this diff: ${error.message ?? error}`;
    }
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.diffRequest++; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async cx => { await this.load(path, context); cx.notify(); });
    cx.notify();
  }

  menu(file, cx) {
    cx.stop_propagation();
    const target = targetFor(this.root, file.path, false, this.on, window()?.platform);
    if (!target) return;
    Object.assign(target, { kind: "changes", xy: file.xy, deleted: file.deleted });
    openOverlay({ mod: "files-plus", kind: "popup", width: 252, height: menuHeight(target, undefined, globalThis.window.viewport_size().height / (settings().zoom || 1) * 0.85), props: { role: "menu", target } });
  }

  consumeChange(cx) {
    const change = shared(CHANGE_KEY);
    if (!change || change.revision === this.lastChange) return;
    this.lastChange = change.revision;
    if (change.target.root === this.root && (change.target.on ?? null) === (this.on ?? null)) this.refresh(cx);
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || !this.hasStaged || this.busy || this.loading || this.context !== key() || this.on || window()?.platform !== "macos") return;
    const root = this.root, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async cx => {
      try {
        // The button explicitly commits the index. It never stages working files.
        const result = await exec("git", ["commit", "-m", message], { cwd: root, on: null });
        if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim());
        setShared(CHANGE_KEY, { target: { root, on: null }, action: "commit", revision: (shared(CHANGE_KEY)?.revision ?? 0) + 1 });
        if (this.current(context)) { this.message = ""; this.input.set_value(""); }
      } catch (error) { if (this.current(context)) this.note = `Commit failed: ${error.message ?? error}`; }
      finally { this.busy = false; this.reloadAgain = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  close() { this.input?.release(); }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    this.consumeChange(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && this.hasStaged && !this.on && window()?.platform === "macos" && !this.busy && !this.loading);
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes Plus"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .child(v_flex().id("changes-list").flex_none().h(Math.min(200, Math.max(44, this.files.length * 28 + 12))).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.xy}-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .on_mouse_down("right", (_e, cx) => this.menu(f, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder")))))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(div().px(10).py(5).text_size(10.5).text_color(t.dim).child(this.on || window()?.platform !== "macos" ? "Index actions and commits require local macOS." : "Commits staged changes only. Right-click a file to stage or unstage it."))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit Staged")));
  }
}
