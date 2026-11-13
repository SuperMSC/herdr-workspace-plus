import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const modsRoot = fileURLToPath(new URL("../mods/", import.meta.url));
const modNames = ["files-plus", "sessions-plus", "project-spaces", "agents-plus"];
const documentedException = /\/\/[ \t]*type-scale-allow:[ \t]*(?:glyph|native)[ \t]+\S[^\n]*/;

function scripts(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return scripts(path);
    return entry.isFile() && entry.name.endsWith(".js") && entry.name !== "mermaid.bundle.js" && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

test("each mod owns an identical four-step type scale", async () => {
  const paths = modNames.map(name => join(modsRoot, name, "type-scale.js"));
  const sources = paths.map(path => readFileSync(path, "utf8"));
  for (const source of sources) assert.equal(source, sources[0]);
  for (const path of paths) {
    const { TYPE } = await import(pathToFileURL(path).href);
    assert.deepEqual(TYPE, { xs: 10.5, sm: 11.5, md: 12.5, lg: 14 });
  }
});

test("mod text sizes use the shared scale unless glyph alignment or native parity is documented", () => {
  const violations = [];
  for (const path of scripts(modsRoot)) {
    const source = readFileSync(path, "utf8"), lines = source.split("\n");
    for (const match of source.matchAll(/\btext_size\s*\(\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*\)/gi)) {
      const line = source.slice(0, match.index).split("\n").length - 1;
      // A glyph/native exception must give its reason on this or the preceding line.
      const comment = [lines[line - 1] || "", lines[line]].join("\n");
      if (!documentedException.test(comment)) violations.push(`${relative(modsRoot, path)}:${line + 1}: ${match[0]}`);
    }
    if (/\bTYPE\./.test(source)) assert.match(source, /import\s*\{\s*TYPE\s*\}\s*from\s*["']\.\/type-scale\.js["']/, `${relative(modsRoot, path)} must import its own mod's scale`);
  }
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("type-scale exceptions require a known category and an explicit reason on the comment line", () => {
  for (const comment of ["// type-scale-allow: native tab parity", "// type-scale-allow: glyph icon baseline"]) assert(documentedException.test(comment), comment);
  for (const comment of ["// type-scale-allow: native", "// type-scale-allow: glyph   ", "// type-scale-allow: other reason", "// type-scale-allow: native\n.text_size(12)"]) assert(!documentedException.test(comment), comment);
});
