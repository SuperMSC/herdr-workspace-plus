import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function element() {
  const state = { childNodes: [], attrs: {}, events: {} };
  const proxy = new Proxy(state, { get(target, key) {
    if (key === "child") return value => { target.childNodes.push(value); return proxy; };
    if (key === "children") return values => { target.childNodes.push(...values); return proxy; };
    if (key === "when") return (value, fn) => value ? fn(proxy) : proxy;
    if (key in target) return target[key];
    if (String(key).startsWith("on_")) return (...args) => { target.events[key] = args.at(-1); return proxy; };
    return value => { target.attrs[key] = value; return proxy; };
  } });
  return proxy;
}
const source = readFileSync(new URL("../mods/sessions-plus/privacy.js", import.meta.url), "utf8");
const flat = node => typeof node === "string" ? [node] : node && typeof node === "object" ? [node, ...node.childNodes.flatMap(flat)] : [];
test("privacy suppresses sensitive role content across all four owned mods without rewriting targets", () => {
  let enabled = false; const closed = [];
  const deps = { div: element, h_flex: element, v_flex: element, shared: () => enabled, setShared: (_key, value) => { enabled = value; }, theme: () => ({}), closeOverlay: id => closed.push(id) };
  const api = new Function(...Object.keys(deps), source.replace(/^import .*;\n/gm, "").replaceAll("export ", "") + "\nreturn {privacyGuard,privacyToggle};")(...Object.values(deps));
  const p = { role: "gallery", overlay: "o", target: { title: "private-title", cwd: "/private/customer", address: "secret-machine/t1" } }, before = structuredClone(p);
  assert.equal(api.privacyGuard("Sessions", p), null); api.privacyToggle();
  const tree = api.privacyGuard("Sessions", p), strings = flat(tree).filter(node => typeof node === "string").join(" ");
  assert(!strings.includes("private-title")); assert(!strings.includes("secret-machine")); assert(!strings.includes("/private/customer"));
  assert.match(strings, /Terminal text and other Herdr panels remain visible/); assert.deepEqual(p, before);
  flat(tree).find(node => node?.attrs?.id === "screenshot-mode-close").events.on_click(); assert.deepEqual(closed, ["o"]);
  flat(tree).find(node => node?.attrs?.id === "screenshot-mode-off").events.on_click(); assert.equal(enabled, false);
  enabled = true; assert.equal(api.privacyGuard("Sessions", { role: "statusbar" }).attrs.id, "screenshot-mode-compact");
  for (const mod of ["files-plus", "project-spaces", "agents-plus"]) assert.equal(readFileSync(new URL(`../mods/${mod}/privacy.js`, import.meta.url), "utf8"), source);
  for (const mod of ["files-plus", "sessions-plus", "project-spaces", "agents-plus"]) {
    const main = readFileSync(new URL(`../mods/${mod}/main.js`, import.meta.url), "utf8");
    const render = main.slice(main.indexOf("  render(cx) {"));
    assert(render.indexOf("privacyGuard(") >= 0); assert(render.indexOf("privacyGuard(") < render.indexOf(".role.render(cx)" ) || !render.includes(".role.render(cx)"));
  }
});


test("Tools places every feature in a bounded scrolling list without launching an operation", () => {
  let toggled=0;const overlays=[];
  const deps={div:element,h_flex:element,v_flex:element,theme:()=>({}),openOverlay:s=>overlays.push(s),closeOverlay(){},settings:()=>({zoom:1}),privacyToggle:()=>toggled++};
  const source=readFileSync(new URL("../mods/sessions-plus/tools.js",import.meta.url),"utf8").replace(/^import .*;\n/gm,"").replace("export default class","return class");
  const Tools=new Function(...Object.keys(deps),source)(...Object.values(deps)),view=new Tools();view.init({}, {focus_handle:()=>({focus(){}})});
  const tree=view.render(),nodes=flat(tree).filter(node=>typeof node==="object");
  const scroll=nodes.find(node=>Object.hasOwn(node.attrs,"overflow_y_scrollbar"));assert(scroll);assert.equal(scroll.childNodes.length,6);
  assert.equal(overlays.length,0);nodes.find(node=>node.attrs.id==="tool-privacy").events.on_click();assert.equal(toggled,1);assert.equal(overlays.length,0);
});
