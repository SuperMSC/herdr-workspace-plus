import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as model from "../mods/project-spaces/model.js";
import { projectIcons } from "../mods/project-spaces/icons-helper.mjs";
import { uiFunction } from "./helpers/ui-function.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z0sAAAAASUVORK5CYII=", "base64");
const jpeg = Buffer.from("ffd8ffc0000b080001000101011100ffd9", "hex");
const webp = Buffer.from("5249464612000000574542505650384c050000002f0000000000", "hex");
const svg = body => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' + body + '</svg>';
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const put = (file, bytes) => { fs.mkdirSync(dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const local = root => ({ root, on: null });

function fixture(t) {
  const temp = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "project-icons-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = join(temp, "herdr"), root = join(temp, "project"), cache = join(home, "data", "project-icons");
  fs.mkdirSync(home);
  return { temp, home, root, cache, read: (roots = [local(root)]) => projectIcons({ home, roots }) };
}

test("project icon candidates use fixed directory, name and extension order and produce private copies", t => {
  const f = fixture(t), svgText = svg("<circle cx='12' cy='12' r='5'/>");
  const first = join(f.root, "favicon.png"), second = join(f.root, "favicon.svg"), third = join(f.root, "icon.jpg");
  put(join(f.root, "public", "favicon.png"), png);
  put(third, jpeg);
  put(second, svgText);
  put(first, png);
  const input = JSON.stringify({ home: f.home, roots: [local(f.root)] });
  const helper = fileURLToPath(new URL("../mods/project-spaces/icons-helper.mjs", import.meta.url));
  const chosen = JSON.parse(execFileSync(process.execPath, [helper, input], { encoding: "utf8" }))[f.root];
  assert.equal(chosen, digest(png) + ".png");
  assert.equal(fs.statSync(f.cache).mode & 0o777, 0o700);
  assert.equal(fs.statSync(join(f.cache, chosen)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(join(f.cache, chosen)), png);
  assert.equal(fs.statSync(join(f.cache, chosen)).nlink, 1);
  assert.equal(f.read()[f.root], chosen);
  fs.unlinkSync(first);
  assert.equal(f.read()[f.root], digest(svgText) + ".svg");
  fs.unlinkSync(second);
  assert.equal(f.read()[f.root], digest(jpeg) + ".jpg");
  fs.unlinkSync(third);
  assert.equal(f.read()[f.root], chosen);
  assert(fs.readdirSync(f.cache).every(name => !name.startsWith(".pending-")));
});

test("symlink files, candidate directories, project roots and cache directories are rejected", t => {
  const f = fixture(t), outside = join(f.temp, "outside");
  put(join(outside, "favicon.png"), png);
  fs.mkdirSync(f.root);
  fs.symlinkSync(join(outside, "favicon.png"), join(f.root, "favicon.png"));
  fs.symlinkSync(outside, join(f.root, "public"));
  const alias = join(f.temp, "symlink");
  fs.symlinkSync(outside, alias);
  assert.deepEqual(Object.keys(f.read([local(f.root), local(alias)])), []);
  assert.equal(fs.existsSync(f.cache), false);
  fs.symlinkSync(outside, join(f.home, "data"));
  put(join(f.root, "logo.png"), png);
  assert.deepEqual(Object.keys(f.read()), []);
  assert.deepEqual(fs.readdirSync(outside), ["favicon.png"]);
});

test("oversized, mismatched, animated and out-of-bounds raster files are skipped", t => {
  const f = fixture(t);
  const tooWide = Buffer.from(png);
  tooWide.writeUInt32BE(1025, 16);
  put(join(f.root, "favicon.png"), tooWide);
  put(join(f.root, "icon.png"), Buffer.alloc(256 * 1024 + 1));
  put(join(f.root, "favicon.jpg"), png);
  put(join(f.root, "logo.webp"), "RIFFWEBP forgeries");
  const extended = Buffer.concat([webp.subarray(0, 12), Buffer.from("565038580a00000000000000000000000000", "hex"), webp.subarray(12)]);
  extended.writeUInt32LE(extended.length - 8, 4);
  const animated = Buffer.from(extended), animationChunk = Buffer.from(extended);
  animated[20] = 2;
  animationChunk.write("ANIM", 30);
  for (const candidate of [animated, animationChunk]) {
    put(join(f.root, "favicon.webp"), candidate);
    assert.deepEqual(Object.keys(f.read()), []);
  }
  put(join(f.root, "src", "app", "icon.webp"), webp);
  assert.equal(f.read()[f.root], digest(webp) + ".webp");
  put(join(f.root, "favicon.webp"), extended);
  assert.equal(f.read()[f.root], digest(extended) + ".webp");
});

test("SVG permits local fragments and rejects external references, active content and oversized documents", t => {
  const f = fixture(t), file = join(f.root, "icon.svg");
  const rejected = [
    svg("<ScRiPt/>"), svg("<foreignObject/>"), svg("<image href='#local'/>"), svg("<feImage href='#local'/>"),
    '<!DOCTYPE svg><svg/>', '<!ENTITY x SYSTEM "file:///fixture"><svg/>',
    svg("<use href='https://example.invalid/logo.svg#x'/>"), svg("<use xlink:href='outside.svg#x'/>"),
    svg("<rect fill='url(https://example.invalid/icon)'/>"), svg("<rect style='fill:URL(  &#35;logo )'/>"),
    svg("<rect style='fill:u/**/rl(outer.svg)'/>"), svg("<style>@import 'outer.css';</style>"),
    svg("<use href='#local' xml:base='https://example.invalid/icons.svg'/>"), svg("<g onload='ignored()'/>"),
    svg("<desc>" + "x".repeat(64 * 1024) + "</desc>"), "<svg><path></svg>",
  ];
  for (const source of rejected) {
    put(file, source);
    assert.deepEqual(Object.keys(f.read()), [], source.slice(0, 110));
  }
  const allowed = '<?xml version="1.0"?>\n' + svg('<defs><path id="shape" d="M0 0h1"/></defs><use href="#shape" fill="url( \'#local\' )"/>');
  put(file, allowed);
  assert.equal(f.read()[f.root], digest(allowed) + ".svg");
});

test("owned cache is capped at 200 copies and evicts an older icon when a new one is cached", t => {
  const f = fixture(t);
  fs.mkdirSync(f.cache, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 200; i++) {
    const before = join(f.cache, i.toString(16).padStart(64, "0") + ".png");
    fs.writeFileSync(before, png, { mode: 0o600 });
    fs.utimesSync(before, i + 1, i + 1);
  }
  const name = digest(png) + ".png";
  put(join(f.root, "logo.png"), png);
  assert.equal(f.read()[f.root], name);
  const files = fs.readdirSync(f.cache);
  assert.equal(files.length, 200);
  assert(!files.includes("0".repeat(64) + ".png"));
  assert(files.includes(name));
});

test("remote and mixed projects never provide a local icon root", t => {
  const f = fixture(t);
  put(join(f.root, "logo.png"), png);
  const [localGroup, remoteGroup] = model.buildGroups([
    { w: { id: "s1", folder: f.root }, i: 0 }, { w: { id: "box/s2", folder: f.root, machine: "box" }, i: 1 },
  ], {});
  assert.equal(model.projectIconRoot(localGroup), f.root);
  assert.equal(model.projectIconRoot(remoteGroup), null);
  assert.equal(model.projectIconRoot({ ...localGroup, sourceRows: [...localGroup.rows, ...remoteGroup.rows] }), null);
  assert.deepEqual(Object.keys(f.read([{ root: f.root, on: "box" }])), []);
  assert.equal(fs.existsSync(f.cache), false);
});

test("the sidebar probes changed roots and refresh requests, keeping stale replies out of the view", async () => {
  const shared = new Map(), calls = [], scheduled = [], tasks = [], resolutions = [], drawn = [];
  const deps = { ...model, View: class {}, shared: key => shared.get(key), checking: () => false, appHome: () => "/herdr",
    image: name => { drawn.push(name); return { size() { return this; }, flex_none() { return this; } }; },
    exec: (_node, args, options) => { calls.push([JSON.parse(args[1]), options]); return new Promise(resolve => resolutions.push(resolve)); },
  };
  const source = fs.readFileSync(new URL("../mods/project-spaces/main.js", import.meta.url), "utf8").replace(/^import[\s\S]*?;\n/gm, "").replace("export default class", "return class");
  const Sidebar = uiFunction(...Object.keys(deps), source)(...Object.values(deps)), sidebar = new Sidebar();
  const cx = { timer: { after(_ms, fn) { scheduled.push(fn); } }, spawn(fn) { tasks.push(fn(cx)); }, notify() {} };
  const [first, second] = model.buildGroups(["/first", "/second"].map((folder, i) => ({ w: { id: String(i), folder }, i })), {});
  const complete = (path, hex) => resolutions.shift()({ code: 0, stdout: JSON.stringify({ [path]: hex.repeat(64) + ".svg" }) });
  sidebar.p = {}; sidebar.requestIcons([first], cx);
  assert.equal(calls.length, 0);
  scheduled.shift()(cx);
  sidebar.requestIcons([second], cx); scheduled.shift()(cx);
  assert.equal(calls.length, 1);
  complete("/first", "a"); await tasks[0];
  assert.equal(sidebar.projectIcon(first), null);
  assert.deepEqual(calls.map(([data]) => data.roots), [[local("/first")], [local("/second")]]);
  complete("/second", "b"); await tasks[1];
  assert(sidebar.projectIcon(second));
  assert.deepEqual(drawn, ["data/project-icons/" + "b".repeat(64) + ".svg"]);
  sidebar.requestIcons([second], cx);
  assert.equal(scheduled.length, 0);
  shared.set(model.ICONS_REFRESH_KEY, 1);
  sidebar.requestIcons([second], cx); scheduled.shift()(cx);
  assert.equal(calls.length, 3);
  shared.set(model.ICONS_KEY, false);
  complete("/second", "c"); await tasks[2];
  assert.equal(sidebar.projectIcon(second), null);
});

test("Display defaults to project icons and refresh changes only the icon revision", () => {
  const values = new Map(), deps = { ...model, shared: key => values.get(key), setShared: (key, value) => values.set(key, value) };
  const source = fs.readFileSync(new URL("../mods/project-spaces/menus.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replaceAll("export ", "");
  const Menu = uiFunction(...Object.keys(deps), source + "\nreturn Menu;")(...Object.values(deps)), menu = new Menu();
  menu.p = { role: "view-menu", keys: [] };
  const option = label => menu.items().find(item => item.label === label);
  assert.equal(option("Project icons").checked, true);
  option("Project icons").act();
  assert.equal(option("Project icons").checked, false);
  assert.equal(option("Refresh project icons"), undefined);
  option("Project icons").act();
  option("Refresh project icons").act();
  assert.deepEqual([...values], [[model.ICONS_KEY, true], [model.ICONS_REFRESH_KEY, 1]]);
});
