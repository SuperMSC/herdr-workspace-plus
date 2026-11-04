# Files Plus for Herdr

[中文使用说明](使用说明.md)

A personal Files and Changes mod with right-click menus. Copy paths and names, reveal items in Finder, open them with the default app, manage local files, and stage or unstage individual Git changes.

![Files Plus context menu](preview.png)

*Native component preview with sample data. Menus are displayed inline and actions are disabled; this is a rendering preview, not an end-to-end interaction capture.*

Files Plus is an independent mod. It does not modify Herdr's shipped Files or Changes mods or require a change to Herdr's core.

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

Right-click a file or folder to act on that item. Right-click empty tree space to act on the current folder. The header's **⋯** button opens the menu for the previewed file, or for the current folder while the tree is shown.

New items go inside the selected folder, or beside the selected file. **Copy Relative Path** is relative to the file browser's current folder; the folder itself copies as `.`. The browser root cannot be renamed or trashed. Existing destinations are never overwritten.

The menu captures the clicked path and machine before it opens. Changing focus does not redirect a pending operation to a different folder. Successful changes refresh matching file trees, including renamed expanded folders.

In **Changes**, right-click a changed file to copy its absolute path, repository-relative path, or name. Local macOS items also offer default-app opening, Finder reveal, and **Stage** or **Unstage** according to their Git status. A partially staged file can offer both actions. Selecting Stage or Unstage opens a modal progress dialog and starts the operation immediately. It closes on success; failures offer **Retry** and **Close**. While working, Escape and the buttons do not dismiss the operation. Stage updates the selected file's index entry from its current working-tree contents; Unstage leaves its working-tree contents intact. Deleted files cannot be opened; Finder reveal goes to their containing folder.

The Changes footer uses **Commit Staged**. It commits all currently staged changes in that repository, including changes staged elsewhere, and never implicitly stages other files. A commit message and staged changes are required. Git uses the repository's normal configuration and hooks.

## Requirements and access

- Herdr with the mod APIs available in version **0.1.12**.
- Local file actions require macOS and its built-in `/usr/bin/open` and `/usr/bin/osascript`.
- The optional installer and automated tests require **Node.js 22 or newer**. The mod itself has no Node.js or npm dependency.
- Folder listing uses `sh`, or PowerShell on Windows. Git status, diffs, staging, unstaging, and commits use `git`.

Herdr mods are trusted code. Review `mods/files-plus/` before installing. This mod reads the current folder and file previews outside its own directory. It runs the programs listed above through Herdr's `exec` API. Its macOS helper uses Foundation filesystem APIs and an exclusive native rename; it does not script Finder or System Events. **Reveal in Finder** and **Open with Default App** invoke `open`.

Creation, rename, and Trash operations write to the item you explicitly select. Stage and Unstage update the selected path in the local repository's Git index. Commit Staged writes a commit only when explicitly invoked. The mod records changes in Herdr's shared state to refresh its views. It makes no direct network requests; browsing a remote space uses Herdr's remote file and command transport. Filesystem and Git mutations are disabled for remote spaces.

## Install

Start Herdr at least once so that its home contains `mods/` and `layouts/`. From this repository:

```sh
node install.mjs
```

The installer reads `HERDR_APP_HOME`, or defaults to `~/.config/herdr-app`. It copies the mod into `mods/files-plus/` and makes `layouts/files-plus.json` from your `main` layout. The copy replaces Files and Changes mod references while preserving other node properties. It initially reveals Files, or Changes if the source layout only contains Changes. It does not change your original layout, keybindings, shared state, or selected layout.

For another Herdr home or personal source layout:

```sh
node install.mjs --home /path/to/herdr-home --layout my-layout
```

If either destination already exists, installation stops without replacing it. Preserve or move that existing copy before installing again. The installer does not download dependencies or create a missing Herdr home.

Validate the installed mod, then select the personal layout:

```sh
app_home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
HERDR_APP_HOME="$app_home" herdr-app check "$app_home/mods/files-plus"
HERDR_APP_HOME="$app_home" herdr-app do layout.switch '{"name":"files-plus"}'
```

If you used `--home`, use that same path for `app_home`. Click Herdr's **Files** or **Changes** button if the panel is hidden: the shipped tabs mod remembers panel visibility separately for each space. If a panel was disabled during Herdr's setup, enable it in your workspace settings first.

You can also install manually: copy `mods/files-plus/` to your Herdr home without overwriting an existing name and duplicate your layout. For Files, change `"mod": "files"` to `"mod": "files-plus"` and remove any old `content.props.role` so that the default browser role is used. For Changes, change `"mod": "changes"` to `"mod": "files-plus"` and merge `"role": "changes"` into its `content.props`. Check the mod before selecting the copied layout. The recipe and screenshot stay in this repository.

To remove it, switch back to your previous layout and delete only the installed `mods/files-plus/` and `layouts/files-plus.json` after preserving any edits you made there. Your original Files and Changes mods and layout are unchanged.

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

Validated on macOS with Herdr 0.1.12: all 56 automated tests passed, the browser, Changes, menus and dialogs passed native mod checks, and native sample renders were inspected.

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

Apache-2.0. The browser, Changes panel, and four SVG assets derive from [Herdr's shipped mods](https://github.com/herdrdev/herdr-app/tree/816d2057d83f0cbd3705926c0231fb12963ae0fb/defaults/mods). See [LICENSE](LICENSE) and [NOTICE](NOTICE).
