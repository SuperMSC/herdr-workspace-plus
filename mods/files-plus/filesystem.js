// Local macOS filesystem actions. Paths are passed as argv, never as source code.
const FILESYSTEM_SCRIPT = String.raw`
ObjC.import("Foundation");

function failure(message, path) {
  return JSON.stringify({ ok: false, error: message + ": " + path });
}

function run(argv) {
  var action = argv[0], path = argv[1];
  var manager = $.NSFileManager.defaultManager;
  // Avoid NSError out-pointers throughout: reading Ref()[0] can crash osascript.
  try {
    if (action === "createFile") {
      // WithoutOverwriting uses exclusive creation; Atomic would permit replacing a file.
      if (!$.NSData.data.writeToFileOptionsError(path, $.NSDataWritingWithoutOverwriting, $()))
        return failure("Cannot create this file", path);
    } else if (action === "createFolder") {
      if (!manager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path, false, $(), $()))
        return failure("Cannot create this folder", path);
    } else if (action === "copy" || action === "move") {
      var destination = argv[2];
      var sourceType = manager.attributesOfItemAtPathError(path, $());
      if (!sourceType) return failure("Source no longer exists", path);
      var parent = ObjC.unwrap($(destination).stringByDeletingLastPathComponent.stringByResolvingSymlinksInPath);
      var parentAttrs = manager.attributesOfItemAtPathError(parent, $());
      if (!parentAttrs || ObjC.unwrap(parentAttrs.objectForKey($.NSFileType)) !== "NSFileTypeDirectory")
        return failure("Destination must be an existing folder", parent);
      // A link is transferred as a link. For a directory, reject symlink aliases into itself.
      if (ObjC.unwrap(sourceType.objectForKey($.NSFileType)) === "NSFileTypeDirectory") {
        var realSource = ObjC.unwrap($(path).stringByResolvingSymlinksInPath);
        if (parent === realSource || parent.indexOf(realSource + "/") === 0)
          return failure("A folder cannot be transferred into itself", path);
      }
      if (action === "copy") {
        if (!manager.copyItemAtPathToPathError(path, destination, $()))
          return failure("Cannot copy; destination may exist or be inaccessible", destination);
      } else {
        ObjC.bindFunction("renamex_np", ["int", ["char *", "char *", "unsigned int"]]);
        if ($.renamex_np(path, destination, 4) !== 0)
          return failure("Cannot move; use an unused name on the same volume", destination);
      }
      path = destination;
    } else if (action === "rename") {
      // RENAME_EXCL is atomic and acts on a final symlink itself. Never fall back to rename().
      ObjC.bindFunction("renamex_np", ["int", ["char *", "char *", "unsigned int"]]);
      if ($.renamex_np(path, argv[2], 4) !== 0) {
        return failure("Cannot rename this item to " + argv[2], path);
      }
      path = argv[2];
    } else if (action === "trash") {
      // Pass nil for Foundation output pointers: JXA can crash when wrapping them.
      // The app needs only success; let the system choose the Trash destination.
      if (!manager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(path), $(), $()))
        return failure("Cannot move this item to the Trash", path);
    } else {
      return JSON.stringify({ ok: false, error: "Unknown filesystem action" });
    }
    return JSON.stringify({ ok: true, path: path });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error) });
  }
}
`;

/** Validate one new filename while preserving legitimate leading/trailing spaces. */
export function validateName(name) {
  if (typeof name !== "string" || name.length === 0 || name === "." || name === "..") {
    throw new Error("Enter a file or folder name.");
  }
  // Finder displays colons as slashes; reject both separators for predictable names.
  if (/[\x00-\x1f\x7f/\\:]/.test(name)) {
    throw new Error("Names cannot contain /, \\, :, or control characters.");
  }
  return name;
}

function absolutePath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path)) {
    throw new Error("An absolute local path is required.");
  }
  if (path.split("/").some(part => part === "." || part === "..")) {
    throw new Error("Paths cannot contain . or .. components.");
  }
  return path.replace(/\/+$/, "") || "/";
}

/** Return the final path component without resolving symbolic links. */
export function basename(path) {
  const value = absolutePath(path);
  return value.slice(value.lastIndexOf("/") + 1);
}

/** Return the parent folder without resolving symbolic links. */
export function parentPath(path) {
  const value = absolutePath(path);
  return value.slice(0, value.lastIndexOf("/")) || "/";
}

function childPath(folder, name) {
  const parent = absolutePath(folder);
  return `${parent === "/" ? "" : parent}/${validateName(name)}`;
}

function itemPath(path) {
  const value = absolutePath(path);
  if (value === "/") throw new Error("The filesystem root cannot be changed.");
  return value;
}

/** Bind the Herdr exec API to guarded filesystem actions for one captured location. */
export function createFilesystem(executor, { on = null, platform = "macos" } = {}) {
  function localMac() {
    if (on != null && on !== "") throw new Error("Filesystem actions are unavailable for remote spaces.");
    if (platform !== "macos") throw new Error("Filesystem actions currently require macOS.");
  }

  async function execute(command, args) {
    localMac();
    const result = await executor(command, args, { on: null });
    if (!result || result.code !== 0) {
      throw new Error(result?.stderr?.trim() || `Could not run ${command}.`);
    }
    return result.stdout;
  }

  async function filesystem(action, ...paths) {
    const output = await execute("/usr/bin/osascript", ["-l", "JavaScript", "-e", FILESYSTEM_SCRIPT, action, ...paths]);
    let result;
    try {
      result = JSON.parse(output.trim());
    } catch {
      throw new Error("The filesystem action returned an invalid response.");
    }
    if (!result.ok) throw new Error(result.error || "The filesystem action failed.");
    return result.path;
  }

  return {
    async createFile(folder, name) {
      localMac();
      return filesystem("createFile", childPath(folder, name));
    },
    async createFolder(folder, name) {
      localMac();
      return filesystem("createFolder", childPath(folder, name));
    },
    async rename(path, name) {
      localMac();
      const source = itemPath(path);
      return filesystem("rename", source, childPath(parentPath(source), name));
    },
    async copy(path, folder) {
      localMac();
      const source = itemPath(path), destination = childPath(folder, basename(source));
      if (source === destination) throw new Error("Source and destination are the same item.");
      return filesystem("copy", source, destination);
    },
    async move(path, folder) {
      localMac();
      const source = itemPath(path), destination = childPath(folder, basename(source));
      if (source === destination) throw new Error("Source and destination are the same item.");
      return filesystem("move", source, destination);
    },
    async trash(path) {
      localMac();
      const source = itemPath(path);
      await filesystem("trash", source);
      return source;
    },
    async open(path) {
      localMac();
      const source = absolutePath(path);
      await execute("/usr/bin/open", ["--", source]);
      return source;
    },
    async reveal(path) {
      localMac();
      const source = absolutePath(path);
      await execute("/usr/bin/open", ["-R", "--", source]);
      return source;
    },
  };
}
