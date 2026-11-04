# Herdr Workspace Plus

[中文使用说明](使用说明.md)

A workspace enhancement pack for Herdr: Files and Changes context menus, plus Sessions and Status views for Claude Code, Codex, and agy. Copy paths, manage local files, stage individual Git changes, return to saved agent sessions, and check remaining or used account quota.

![Files Plus context menu](preview.png)

*Native component preview with sample data. Menus are displayed inline and actions are disabled; this is a rendering preview, not an end-to-end interaction capture.*

Herdr Workspace Plus is an independent mod pack. It does not modify Herdr's shipped Files or Changes mods or require a change to Herdr's core.

Previously released as **Files Plus**. The pack contains the **Files Plus** and **Sessions Plus** components. Their `files-plus` / `sessions-plus` mod identifiers, the `files-plus` layout, and shared-state keys are retained for compatibility with existing layouts and saved session names. The package and archive use the new **Herdr Workspace Plus** name.

## Sessions

The installer adds **Sessions** below Files / Changes in the right panel. Drag the divider to adjust their heights. Click **This folder / All folders**, cycle **All agents / Claude Code / Codex / agy**, or search by title, directory, provider, or session ID.

- A running Herdr agent offers **Switch**. A saved conversation offers **Resume**, opening the original directory in a local Herdr tab. If that directory has no local space, a new local space is created. Missing directories and unavailable CLIs produce an error.
- Right-click a row, or click **⋯**, and choose **Rename** to set a local display name. Names belong to Sessions Plus and are saved in Herdr's local shared state, keyed by provider, data directory, and session ID. Resuming that history entry preserves its name. An empty name restores its original title. Renaming leaves provider transcripts and provider-native names unchanged.
- History uses `claude --resume <id>`, `codex resume <id>`, and `agy --conversation <id>`. No prompt is automatically sent and no permission-bypass flags are added. The CLI's normal configuration, trust checks, and hooks still apply when you explicitly resume it.
- Claude and Codex history comes from their local JSONL records and title index. agy history comes from a temporary snapshot of `conversation_summaries.db`, including its WAL; only summary metadata is queried. The snapshot and any SQLite sidecars are removed in `finally`. The original database and conversation bodies are not written.
- History refreshes every 30 seconds and on Refresh. The history reader has no persistent transcript cache, hook installation, telemetry, or network requests. The scan is bounded to 6,000 directory entries and 500 recent records per provider; the panel reports when it reaches a limit. Large JSONL files are read at their beginning and end, so metadata stored only in the middle can be missed. Codex archived sessions and Claude subagents are excluded.
- A live session is associated with history only when its launch/foreground arguments identify the provider and exact resume ID. Ordinary manually started agents without a visible ID remain separate live rows; folder similarity is never used to guess. Their local names are terminal-specific. This version does not attach to agents running in another application or resume remote history.

![Sessions Plus native preview](sessions-preview.png)

*Native components with fictional sessions, captured before the session Trash controls were added. This preview does not open a real agent conversation.*

### Move a session to Trash and restore it

For a local history row, choose **Move to Trash…** from its context menu and review the confirmation. The operation moves the session's history and recognized session-specific attachments into one recovery bundle in the macOS Trash. It never deletes the working project or empties the Trash. Running Herdr sessions and sessions currently opening cannot be removed. The helper also checks for provider processes and open files; if it cannot rule out a writer, close the corresponding CLI or desktop service and retry.

Open **Trash** in Sessions to see this plugin's recovery records. Choose **Restore…** to return a session's files to their original locations. Existing destination files are never overwritten. Local display names and shared provider indexes are retained, so a successful restore can reuse them. These shared indexes may still show an old entry in the provider's own interface while its history is in the Trash; this plugin removes the history row immediately after refreshing.

Session Trash currently requires macOS and a data directory on the same volume as the user's home. Symbolic links and ambiguous session identities are rejected. The bundle contains the recognized Claude session transcript and its adjacent session folder, the Codex rollout, or the agy database with its WAL/SHM files and session brain folder. Shared logs, credentials, quota settings, and unrelated sessions are not part of the operation.

Recovery records live in `session-trash/` inside the Herdr app home, outside the installed mod directories. Preserve this directory when upgrading or uninstalling while recoverable sessions remain. Use the plugin's **Restore** action to unpack a recovery bundle; Finder's **Put Back** alone only returns the bundle. Emptying the macOS Trash permanently removes the bundled history. A failed move attempts rollback; if a conflicting path prevents rollback, the retained recovery record lets you retry restoration after resolving the conflict.

## Status quota

The **Status** tab beside Sessions shows Claude Code, Codex, and agy with their brand icons. **Remaining** and **Used** switch the same quota data between complementary percentages. Each supplied quota window or model pool keeps its own label, progress bar, reset countdown, local reset time, and last-update time. Tools with no usable quota data have no card, including missing CLIs and signed-out accounts. Unknown values are not invented. A past reset does not automatically restore 100% quota. Failed refreshes mark any previous reading **Stale**.

Opening Status queries the visible local logged-in accounts; it refreshes every five minutes while that tab is selected. Manual refresh has a one-minute cooldown. This is account quota, not per-project token counts or estimated monetary cost. Remote workspace selection does not change which local accounts are queried.

Open **Agents** in Status to show or hide Claude, Codex, and agy individually. A check mark means shown. The selection is saved locally and applies after reopening Herdr. Hidden tools are skipped on initial load, manual refresh, and automatic polling; a query already in progress may finish. Showing a tool again refreshes it subject to the normal cooldown. You can hide every tool and restore any of them from the same Agents control. This preference affects quota cards; the Sessions list has its own filters. After installing a CLI or signing in, use Refresh to check it again.

- Claude reads the existing OAuth login from its scoped macOS Keychain item or credentials file and sends it only to `https://api.anthropic.com/api/oauth/usage`. Redirects are rejected. The helper never prints or stores tokens, emails, account IDs, raw error bodies, or credential-bearing subprocess output. API-key-only setups may have no subscription quota to report. Expired access is handled by reopening Claude Code; the mod does not refresh or rewrite its credentials.
- Codex uses the official [`account/rateLimits/read` app-server method](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt). Codex handles its own authentication. The client only initializes and requests quota; it never starts a thread or sends a turn. Its temporary app-server and log directory are closed and removed after the query.
- agy uses its built-in `-p /usage --output-format json` command, with auto-updates disabled for that process. A version gate requires **1.1.11+** before the print command can run. The helper verifies a structured usage response; if it unexpectedly reports a model turn, further queries for that version are paused. The CLI may write its normal diagnostic logs. It uses the existing macOS login; without a usable login, its quota card is omitted.

Quota results stay in memory. The Remaining/Used preference, hidden-agent selection, and any agy unsupported-version guard are stored in Herdr shared state. Missing CLIs and signed-out accounts are omitted from the cards. Transient failures may retain an earlier valid reading marked **Stale**; if there is no reading, no card is shown. The Claude usage endpoint is also used by Orca, but it is not a guaranteed public API; provider updates may require an adapter update.

![Sessions and Status with fictional values](status-preview.png)

*Native preview captured before the Agents visibility control was added, with fictional sessions and quota values. No account credentials or real usage statistics are included.*

## Features

| Action | Local macOS | Remote spaces / other platforms |
| --- | --- | --- |
| Browse folders and read-only text previews | Yes | Uses Herdr's existing file-browser support |
| Copy absolute path, relative path, or name | Yes | Yes; copies the selected machine's path |
| Refresh the file tree | Yes | Yes |
| Reveal in Finder / open with the default app | Yes | Not offered |
| New file, new folder, rename | Yes | Not offered |
| Move to Trash, with confirmation | Yes | Not offered |
| Changes row: stage / unstage this file | Yes | Not offered |
| Commit the repository's staged changes | Yes | Not offered |
| Move a stopped session to Trash / restore it | Yes; data must be on the home volume | Not offered |

Right-click a file or folder to act on that item. Right-click empty tree space to act on the current folder. The header's **⋯** button opens the menu for the previewed file, or for the current folder while the tree is shown.

New items go inside the selected folder, or beside the selected file. **Copy Relative Path** is relative to the file browser's current folder; the folder itself copies as `.`. The browser root cannot be renamed or trashed. Existing destinations are never overwritten.

The menu captures the clicked path and machine before it opens. Changing focus does not redirect a pending operation to a different folder. Successful changes refresh matching file trees, including renamed expanded folders.

In **Changes**, right-click a changed file to copy its absolute path, repository-relative path, or name. Local macOS items also offer default-app opening, Finder reveal, and **Stage** or **Unstage** according to their Git status. A partially staged file can offer both actions. Selecting Stage or Unstage opens a modal progress dialog and starts the operation immediately. It closes on success; failures offer **Retry** and **Close**. While working, Escape and the buttons do not dismiss the operation. Stage updates the selected file's index entry from its current working-tree contents; Unstage leaves its working-tree contents intact. Deleted files cannot be opened; Finder reveal goes to their containing folder.

The Changes footer uses **Commit Staged**. It commits all currently staged changes in that repository, including changes staged elsewhere, and never implicitly stages other files. A commit message and staged changes are required. Git uses the repository's normal configuration and hooks.

## Requirements and access

- Herdr with the mod APIs available in version **0.1.12**.
- Local file actions require macOS and its built-in `/usr/bin/open` and `/usr/bin/osascript`.
- The installer requires **Node.js 22 or newer**; the SQLite WAL test requires **Node.js 22.13+**. Sessions history also uses Node.js at runtime; agy history uses macOS's `/usr/bin/sqlite3`. No npm packages are required. Files / Changes alone have no Node.js runtime dependency (`node install.mjs --files-only`).
- Folder listing uses `sh`, or PowerShell on Windows. Git status, diffs, staging, unstaging, and commits use `git`.

Herdr mods are trusted code. Review `mods/files-plus/` and `mods/sessions-plus/` before installing. This mod reads the current folder and file previews outside its own directory. It runs the programs listed above through Herdr's `exec` API. Its macOS helper uses Foundation filesystem APIs and an exclusive native rename; it does not script Finder or System Events. **Reveal in Finder** and **Open with Default App** invoke `open`.

Creation, rename, and Trash operations write to the item you explicitly select. Stage and Unstage update the selected path in the local repository's Git index. Commit Staged writes a commit only when explicitly invoked. The mod records changes in Herdr's shared state to refresh its views. Files / Changes make no direct network requests; browsing a remote space uses Herdr's remote file and command transport. Filesystem and Git mutations are disabled for remote spaces.

## Install

Start Herdr at least once so that its home contains `mods/` and `layouts/`. Open this repository, or the `workspace-plus/` folder from the installation archive, and run:

```sh
node install.mjs
```

The installer reads `HERDR_APP_HOME`, or defaults to `~/.config/herdr-app`. It copies `mods/files-plus/` and `mods/sessions-plus/`, adds Sessions below the right panel, and makes `layouts/files-plus.json` from your `main` layout. The copy replaces Files and Changes mod references while preserving other node properties. It initially reveals Files, or Changes if the source layout only contains Changes. It does not change your original layout, keybindings, shared state, or selected layout.

For another Herdr home or personal source layout:

```sh
node install.mjs --home /path/to/herdr-home --layout my-layout
```

If any destination already exists, installation stops without replacing it. Preserve or move that existing copy before installing again. The installer does not download dependencies or create a missing Herdr home.

Validate the installed mod, then select the personal layout:

```sh
app_home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
HERDR_APP_HOME="$app_home" herdr-app check "$app_home/mods/files-plus"
HERDR_APP_HOME="$app_home" herdr-app check "$app_home/mods/sessions-plus"
HERDR_APP_HOME="$app_home" herdr-app do layout.switch '{"name":"files-plus"}'
```

If you used `--home`, use that same path for `app_home`. Click Herdr's **Files** or **Changes** button if the panel is hidden: the shipped tabs mod remembers panel visibility separately for each space. If a panel was disabled during Herdr's setup, enable it in your workspace settings first.

You can also install manually: copy `mods/files-plus/` to your Herdr home without overwriting an existing name and duplicate your layout. For Files, change `"mod": "files"` to `"mod": "files-plus"` and remove any old `content.props.role` so that the default browser role is used. For Changes, change `"mod": "changes"` to `"mod": "files-plus"` and merge `"role": "changes"` into its `content.props`. Check the mod before selecting the copied layout. The recipe and screenshot stay in this repository.

To remove it, switch back to your previous layout and delete only the installed `mods/files-plus/`, `mods/sessions-plus/`, and `layouts/files-plus.json` after preserving any edits you made there. Your original Files and Changes mods and layout are unchanged.

## Behavior and limits

- Menu: **↑ / ↓** selects, **Enter** runs, **Esc** closes. Mouse hover selects a row. Menus fit within 85% of the viewport height after accounting for zoom; the action list scrolls when needed.
- New file, new folder, and rename dialogs show their target path. Existing names produce an error instead of replacing data.
- Trash requires confirmation. It uses the native macOS Trash, not permanent deletion.
- New names are one component: empty names, `.`, `..`, separators, colons, and control characters are rejected. Spaces and Unicode are supported.
- Renaming or trashing a symbolic link acts on the link itself. Creating inside an expanded directory link follows that directory, as ordinary folder navigation does.
- The tree retains the shipped limits: 500 entries per folder, 5,000 entries total, a depth limit, and a bounded read-only text preview. `.git` is hidden.
- Local filesystem watching and a 10-second refresh supplement explicit refresh. Remote file actions remain read-only.
- Changes preserves the bounded diff preview: up to 1,000 changed files and 1,500 displayed diff lines. Stage and Unstage operate on a whole file, not individual hunks.
- This is the first macOS-focused version. Linux/Windows OS file actions and remote mutations are not implemented.

## Validate and share

Validated on macOS with Herdr 0.1.12: all 133 automated tests passed, the browser, Changes, menus and dialogs passed native mod checks, and native sample renders were inspected. Sessions history parsing, WAL snapshots, identity matching, rename persistence, duplicate-launch guards, and installer integration have automated coverage. The Agents visibility controls have automated coverage for persistence, hidden-provider polling, pending requests, cooldowns, and restoring all-hidden views. Session Trash and Restore have fixture coverage for all three providers, WAL/SHM preservation, native macOS Trash, exclusive restoration, rollback, file conflicts, damaged records, and locks released after a killed process. Additional native component checks cover the session menus, confirmation dialogs, recovery list, and quota states. Actual agent conversations were not resumed or deleted during testing. Read-only quota queries were verified against existing Claude, Codex, and agy logins; only success states and window counts were recorded.

No dependency installation is needed:

```sh
node --test tests/*.test.mjs
```

Validation includes menu event-callback unit tests, real temporary files and Git repositories, and installer tests that preserve existing configuration. Native checks and a sample-data component rendering were also exercised. Tests that invoke macOS filesystem APIs need to run on macOS; see the test output for any skipped cases.

The included screenshot is that native component preview. Actual mouse-driven end-to-end interactions were not tested, and Finder/default applications were not launched for Open/Reveal validation. Live interaction can be checked in a running Herdr instance:

```sh
HERDR_APP_HOME=/path/to/herdr-home herdr-app check /path/to/herdr-home/mods/files-plus
HERDR_APP_HOME=/path/to/herdr-home herdr-app status
HERDR_APP_HOME=/path/to/herdr-home herdr-app shot /path/to/preview.png
```

Use an isolated Herdr home and core for development. Do not start a second test window on your real setup.

For publication, use the contents of this directory as a separate public GitHub repository, include the actual `preview.png` and `RECIPE.md`, and add the topic **herdr-mod**. This follows [Herdr's mod-sharing guide](https://github.com/herdrdev/herdr-app/blob/master/defaults/AGENTS.md#layouts-and-mods-other-people-made); no feature PR to the shipped Files mod is needed. This repository's scripts do not create commits or publish anything.

## License

Apache-2.0. The browser, Changes panel, and four SVG assets derive from [Herdr's shipped mods](https://github.com/herdrdev/herdr-app/tree/816d2057d83f0cbd3705926c0231fb12963ae0fb/defaults/mods). The three brand icons bundled with Sessions Plus use the MIT license in `mods/sessions-plus/icons/LICENSE`. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
