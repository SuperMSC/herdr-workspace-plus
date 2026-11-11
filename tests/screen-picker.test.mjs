import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import * as model from "../mods/sessions-plus/screen-picker-model.js";
import { readScreen, screenProcess } from "../mods/sessions-plus/screen-picker-helper.mjs";
import { createScreenPickerClient } from "../mods/sessions-plus/screen-picker-client.js";
const execute = promisify(execFile);
const terminal = (extra = {}) => ({ address: "remote/t7", created_ms: 1234, state: "live", argv: ["/bin/zsh"], pid: 42, cwd: "/work/project", on: "remote", ...extra });
const context = { root: "/work/project", on: "remote" };
const target = model.capturedScreenTarget(terminal(), context);
const identity = { address: target.address, created_ms: target.created_ms, stamp: target.stamp };
const reply = body => ({ code: 0, stdout: typeof body === "string" ? body : JSON.stringify(body), stderr: "" });
const source = 'URL (https://example.invalid/a(b)?x=1).\n"/work/project/path with spaces.js:12:3" src/main.ts:9:2 ./other.js\n"C:\\Users\\name\\file test.js:5" \\\\server\\share\\file.txt ~/unknown.js\n../secret.js /work/project-other/no.js\n!touch /work/project/literal-only\n';
const candidates = () => model.extractScreenCandidates(source, target).candidates;

test("screen target captures exact machine, terminal incarnation and launch folder instead of following focus", () => {
  assert(model.validScreenTarget(target)); assert.equal(target.on, "remote"); assert(!Object.hasOwn(target, "argv"));
  for (const extra of [{ created_ms: 999 }, { cwd: "/other" }, { pid: 43 }, { argv: ["/bin/bash"] }, { state: "finished" }, { address: "other/t7", on: "other" }]) assert.equal(model.sameScreenTerminal(target, terminal(extra)), false);
  assert(model.sameScreenTerminal(target, terminal({ address: "t7", on: undefined }), true));
  assert.throws(() => model.capturedScreenTarget(terminal(), { root: context.root, on: null }), /machine/);
  assert.throws(() => model.capturedScreenTarget(terminal({ address: "--bad id" })), /exact live/);
  assert.throws(() => model.capturedScreenTarget(terminal({ argv: ["x".repeat(17000)] })), /too large/);
});

test("literal parser handles URLs, quoted Unix/Windows paths, line suffixes and captured-root boundaries", () => {
  const values = candidates();
  assert(values.some(row => row.kind === "url" && row.value === "https://example.invalid/a(b)?x=1"));
  const spaced = values.find(row => row.path === "/work/project/path with spaces.js"); assert.equal(spaced.line, 12); assert.equal(spaced.column, 3); assert.equal(spaced.previewable, true);
  const relative = values.find(row => row.path === "src/main.ts"); assert.equal(relative.resolved, "/work/project/src/main.ts"); assert.equal(relative.line, 9);
  const windows = values.find(row => row.value.startsWith("C:\\Users")); assert.equal(windows.previewable, false); assert.equal(windows.line, 5); assert.equal(windows.resolved, null);
  assert(values.some(row => row.value.startsWith("\\\\server\\share")));
  for (const value of ["../secret.js", "/work/project-other/no.js", "~/unknown.js"]) assert.equal(values.find(row => row.value === value).previewable, false);
  assert(values.every(row => ["url", "path"].includes(row.kind)));
  assert(values.every(row => typeof row.searchText === "string"));
  const text = model.screenReference(relative, target); assert(text.includes('"src/main.ts:9:2"')); assert(text.includes("remote/t7"));
});

test("escape/control sequences and unsupported or credentialed URL schemes never become open actions", () => {
  const text = '\x1b]8;;https://hidden.invalid\x07visible label\x1b]8;;\x07\n\x1b[31mhttps://shown.invalid/a\x1b[0m\nfile:///etc/passwd ssh://host/path https://user:pass@example.invalid/x javascript:alert(1)\n';
  const values = model.extractScreenCandidates(text, target).candidates;
  assert(!values.some(row => row.value.includes("hidden.invalid")));
  assert(values.some(row => row.value === "https://shown.invalid/a" && row.openable));
  assert.equal(values.find(row => row.value.startsWith("file://")).openable, false);
  assert.equal(values.find(row => row.value.includes("user:pass")).openable, false);
  assert(!values.some(row => row.value.startsWith("javascript:")));
});

test("large screen output deduplicates and explicitly bounds candidates and oversized lines", () => {
  const text = Array.from({ length: 220 }, (_, index) => `https://example.invalid/${index}`).join("\n");
  const value = model.extractScreenCandidates(text, target); assert.equal(value.candidates.length, 200); assert.equal(value.limited, true);
  assert.equal(model.extractScreenCandidates("./same.js\n./same.js\n", target).candidates.length, 1);
  assert.equal(model.extractScreenCandidates("x".repeat(13000), target).lineLimited, true);
  assert.throws(() => model.extractScreenCandidates("x".repeat(model.SCREEN_LIMITS.bytes + 1), target), /read limit/);
});

test("screen reads verify before and after fixed literal hc reads and reject replacement results", async () => {
  const calls = []; let gets = 0, replaced = false;
  const run = async (args, options) => { calls.push({args,options}); if (args[0] === "get") { gets++; return reply(terminal(replaced && gets > 1 ? { created_ms: 999 } : {})); } return reply(source); };
  const value = await readScreen({ action: "scan", target, history: 200 }, run); assert(value.candidates.length > 3);
  assert.deepEqual(calls.map(call => call.args[0]), ["get", "read", "get"]); assert.deepEqual(calls[1].args, ["read", "--lines", "200", "remote/t7"]);
  assert(calls.every(call => !call.args.some(arg => arg.includes("literal-only") || arg.includes("!touch"))));
  gets = 0; replaced = true; await assert.rejects(() => readScreen({action:"scan",target},run),/ended, changed/);
  const before = calls.length; await assert.rejects(() => readScreen({action:"scan",target:{...target,created_ms:0}},run),/valid captured/); assert.equal(calls.length,before);
});

test("truncated reads expose complete lines only and identity failure prevents the screen read", async () => {
  const value = await readScreen({action:"scan",target},async args=>args[0]==="get"?reply(terminal()):{...reply("https://complete.invalid/a\nhttps://incomplete.invalid/part"),code:1,truncated:true});
  assert.equal(value.truncated,true); assert.deepEqual(value.candidates.map(row=>row.value),["https://complete.invalid/a"]);
  const calls=[];await assert.rejects(()=>readScreen({action:"scan",target},async args=>{calls.push(args);return reply(terminal({state:"finished"}));}),/ended/);assert.equal(calls.length,1);
});

async function fixture(t,{screen=source,replace=false}={}) {
  const root=await fs.mkdtemp('/private/tmp/herdr-screen-fixture-');t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bin=path.join(root,'bin'),mod=path.join(root,'mods/sessions-plus'),config=path.join(root,'fixture.json'),calls=path.join(root,'calls.jsonl');await fs.mkdir(bin);await fs.mkdir(mod,{recursive:true});
  for(const name of ['screen-picker-model.js','screen-picker-client.js','screen-picker-helper.mjs','package.json'])await fs.copyFile(new URL('../mods/sessions-plus/'+name,import.meta.url),path.join(mod,name));
  await fs.writeFile(config,JSON.stringify({terminal:terminal(),screen,replace,read:false}));
  const script=`#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2),file=${JSON.stringify(config)},data=JSON.parse(fs.readFileSync(file,'utf8'));fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args[0]==='get')console.log(JSON.stringify(data.replace&&data.read?{...data.terminal,created_ms:999}:data.terminal));else if(args[0]==='read'){data.read=true;fs.writeFileSync(file,JSON.stringify(data));process.stdout.write(data.screen);}else process.exit(9);\n`;
  await fs.writeFile(path.join(bin,'hc'),script,{mode:0o700});
  const env={...process.env,PATH:bin+':'+process.env.PATH},executions=[];
  const run=async(command,args,options)=>{executions.push({command,args,options});try{const value=await execute(command,args,{env,timeout:options.timeout,maxBuffer:5000000});return {...value,code:0};}catch(error){return {code:error.code||1,stdout:error.stdout||'',stderr:error.stderr||''};}};
  return {root,config,calls,executions,env,run};
}
test("actual helper reads only private fake hc programs, emits no raw launch argv and handles symlink entry paths",async t=>{
  const f=await fixture(t), client=createScreenPickerClient({execute:f.run,home:f.root,node:process.execPath,target,current:()=>terminal()});
  const result=await client.scan(0);assert(result.candidates.length>3);assert.equal(result.history,0);assert(!f.executions[0].args[1].includes('/bin/zsh'));assert(!f.executions[0].args[1].includes('!touch'));
  const link=path.join(f.root,'linked-helper.mjs');await fs.symlink(path.join(f.root,'mods/sessions-plus/screen-picker-helper.mjs'),link);
  const output=await f.run(process.execPath,[link,JSON.stringify({action:'verify',target})],{timeout:10000});assert.equal(JSON.parse(output.stdout).verified,true);
  const calls=(await fs.readFile(f.calls,'utf8')).trim().split('\n').map(JSON.parse);assert(calls.every(args=>['get','read'].includes(args[0])));
});
test("actual helper rejects read-time replacement and caps long output without reading real terminals",async t=>{
  const f=await fixture(t,{replace:true});const client=createScreenPickerClient({execute:f.run,home:f.root,node:process.execPath,target,current:()=>terminal()});await assert.rejects(()=>client.scan(200),/ended, changed/);
  const large=await fixture(t,{screen:'https://complete.invalid/a\n'+'x'.repeat(1200000)}),other=createScreenPickerClient({execute:large.run,home:large.root,node:process.execPath,target,current:()=>terminal()});
  const result=await other.scan(200);assert.equal(result.truncated,true);assert.deepEqual(result.candidates.map(row=>row.value),['https://complete.invalid/a']);
});
test("client checks both current snapshots and returned identity without reading a newly focused terminal",async()=>{
  let current=terminal(),calls=0;const client=createScreenPickerClient({home:'/app',target,current:()=>current,execute:async()=>{calls++;return reply({identity,candidates:[]});}});
  await client.scan(200);current=terminal({address:'other/t9',on:'other'});await assert.rejects(()=>client.scan(200),/captured terminal ended/);assert.equal(calls,1);
  const wrong=createScreenPickerClient({home:'/app',target,current:()=>terminal(),execute:async()=>reply({identity:{...identity,created_ms:99},candidates:[]})});await assert.rejects(()=>wrong.scan(200),/different terminal identity/);
});

function element(){const node={attrs:{},events:{},childNodes:[]};const proxy=new Proxy(node,{get(object,key){if(key==='child')return value=>{object.childNodes.push(value);return proxy;};if(key==='children')return values=>{object.childNodes.push(...values);return proxy;};if(key==='when')return (condition,callback)=>condition?callback(proxy):proxy;if(String(key).startsWith('on_'))return (...args)=>{object.events[key]=args.at(-1);return proxy;};if(key in object)return object[key];return value=>{object.attrs[key]=value;return proxy;};}});return proxy;}
const nodes=node=>!node||typeof node!=='object'?[]:[node,...node.childNodes.flatMap(nodes)];
const viewSource=readFileSync(new URL('../mods/sessions-plus/screen-picker.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export default class','return class');
function harness({rows=candidates(),scan,verify,file}={}){
  const tasks=[],calls=[],overlays=[],copied=[],opened=[],retained=[];let focused=true,rendering=false;
  const cx={notify(){assert(!rendering);},stop_propagation(){},focus_handle:()=>({focus(){focused=true;},is_focused:()=>focused}),spawn(callback){tasks.push(callback(cx));},write_to_clipboard:text=>copied.push(text),open_url:url=>opened.push(url)};
  const state=options=>{let text=options.value||'';const events={};const object={value:()=>text,set_value(value){text=value;},on(name,callback){events[name]=callback;},type(value){text=value;events.change?.({},cx);},focus(){focused=false;},release(){object.released=true;}};retained.push(object);return object;};
  const deps={...model,div:element,h_flex:element,v_flex:element,Input:{new:element},Editor:{new:element},InputState:{new:state},EditorState:{new:state},terminals:()=>[terminal()],theme:()=>({}),appHome:()=>'/app',exec(){throw new Error('No real commands from UI fixture');},readTextFile:async(path,options)=>{calls.push(['file',path,options]);return file?file(path):'fixture text';},openOverlay:props=>overlays.push(props),closeOverlay(){},createScreenPickerClient:options=>({scan:async history=>{calls.push(['scan',options.target,history]);return scan?scan():{candidates:rows,captured:1};},verify:async()=>{calls.push(['verify']);return verify?verify():{};}})};
  const Class=new Function(...Object.keys(deps),viewSource)(...Object.values(deps)),view=new Class();view.init({target:terminal(),context},cx);
  return {view,cx,calls,overlays,copied,opened,retained,async settle(){for(let i=0;i<8;i++)await Promise.all(tasks.splice(0));},render(){rendering=true;try{return view.render(cx);}finally{rendering=false;}},click(id){const node=nodes(this.render()).find(node=>node.attrs.id===id);assert(node,id);node.events.on_click({},cx);}};
}
test("production letter selection previews literal data, Enter copies, search focus suppresses shortcuts and no command executes",async()=>{
  const f=harness();await f.settle();f.view.key({key:'a'},f.cx);assert(f.view.selected());assert(f.retained[1].value().includes('Captured screen line'));
  f.view.key({key:'enter'},f.cx);assert.equal(f.copied[0],f.view.selected().value);f.view.key({key:'/'},f.cx);const old=f.view.selectedId;f.view.key({key:'b'},f.cx);assert.equal(f.view.selectedId,old);
  f.render();f.render();assert.equal(f.calls.filter(call=>call[0]==='scan').length,1);assert.equal(f.overlays.length,0);assert.equal(f.calls.filter(call=>call[0]==='file').length,0);
});
test("production references capture machine and text, and file reads require an explicit reliable selected path",async()=>{
  const f=harness();await f.settle();const row=f.view.rows.find(row=>row.path==='src/main.ts');f.view.choose(row,f.cx);f.click('screen-picker-reference');await f.settle();
  assert.equal(f.overlays[0].props.role,'reference');assert.equal(f.overlays[0].props.on,'remote');assert(f.overlays[0].props.text.includes('src/main.ts:9:2'));assert.equal(f.calls.filter(call=>call[0]==='file').length,0);
  f.click('screen-picker-file');await f.settle();assert.deepEqual(f.calls.find(call=>call[0]==='file').slice(1),['/work/project/src/main.ts',{on:'remote'}]);assert.equal(f.retained[1].value(),'fixture text');
  const outside=f.view.rows.find(row=>row.value==='../secret.js');f.view.choose(outside,f.cx);f.view.action('file',f.cx);await f.settle();assert.equal(f.calls.filter(call=>call[0]==='file').length,1);assert.match(f.view.error,/captured filesystem root/);
});
test("production stale identity and late file previews never redirect selection or open a URL/reference",async()=>{
  const denied=harness({verify:()=>{throw new Error('terminal changed');}});await denied.settle();denied.view.choose(denied.view.rows[0],denied.cx);denied.view.action('url',denied.cx);await denied.settle();assert.equal(denied.opened.length,0);assert.match(denied.view.error,/changed/);
  let release;const gate=new Promise(resolve=>release=resolve),f=harness({file:()=>gate});await f.settle();f.view.choose(f.view.rows.find(row=>row.previewable),f.cx);f.view.action('file',f.cx);await Promise.resolve();await Promise.resolve();f.view.choose(f.view.rows[0],f.cx);release('Late old file');await f.settle();assert(!f.retained[1].value().includes('Late old file'));
});
test("production 200 long candidates keep 20-row pages, cached search and last-page letters",async()=>{
  const rows=model.extractScreenCandidates(Array.from({length:200},(_,index)=>`https://example.invalid/${index}/`+'x'.repeat(1900)).join('\n'),target).candidates;
  const f=harness({rows});await f.settle();for(let page=0;page<9;page++)f.click('screen-picker-next');assert.equal(f.view.page,9);f.view.key({key:'t'},f.cx);assert.equal(f.view.selectedId,'pick-200');
  assert.equal(nodes(f.render()).filter(node=>String(node.attrs.id||'').startsWith('screen-picker-row-')).length,20);
  f.retained[0].type('199/');const a=f.view.filtered(),b=f.view.filtered();assert.equal(a,b);assert.equal(a.length,1);assert.equal(f.view.page,0);
  f.view.close();assert(f.retained.every(state=>state.released));
});
test("closing during a read rejects late snapshots and releases retained inputs",async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),f=harness({scan:()=>gate});f.view.close();release({candidates:candidates()});await f.settle();assert.deepEqual(f.view.rows,[]);assert(f.retained.every(state=>state.released));
});

test("hc 0.1.20 full get DTO remains compatible with enriched Herdr terminal records", async () => {
  // Shape captured from this task's isolated real core; CLI ls summaries are intentionally excluded.
  const full = { address: "t1", argv: ["/bin/sh", "/fixture/screen.sh"], cols: 200, created_ms: 1794377336027, cwd: "/fixture", die_with_parent: false, exit_code: null, finished_ms: null,
    foreground: { argv: ["/bin/sh", "/fixture/screen.sh"], cwd: "/fixture", name: "bash", pid: 46357 }, identity: "ghostty", keep: false, labels: {}, name: "screen-picker-fixture", notify: false, parent: null, pid: 46357, reason: null, reported: false, rm: false, rows: 120, screen: "exact", signal: null, state: "live", status: null, status_ms: null, template: null, title: "", turn: 0 };
  const enriched = { ...full, program: { key: "sh", agent: false } }, captured = model.capturedScreenTarget(enriched, { root: "/fixture", on: null });
  assert(model.sameScreenTerminal(captured, full));
  const value = await readScreen({ action: "scan", target: captured, history: 0 }, async args => args[0] === "get" ? reply(full) : reply("/fixture/result.txt:3:1\nhttps://example.invalid/compat\n"));
  assert.equal(value.candidates[0].resolved, "/fixture/result.txt"); assert.equal(value.candidates[0].line, 3); assert.equal(value.candidates[1].openable, true);
});
