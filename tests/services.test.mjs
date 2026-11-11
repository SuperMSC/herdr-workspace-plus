import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import * as model from "../mods/sessions-plus/services-model.js";
import { parseListeners, parseEndpoint } from "../mods/sessions-plus/ports-model.js";
import { runBounded, scanDocker, scanServices, containerAction, INSPECT_FORMAT } from "../mods/sessions-plus/services-helper.mjs";
import { createServicesClient, parseRemoteSnapshot } from "../mods/sessions-plus/services-client.js";
import { REMOTE_SCAN_SCRIPT, REMOTE_ACTION_SCRIPT } from "../mods/sessions-plus/services-remote.js";
const execute = promisify(execFile), id = "a".repeat(64), secondId = "b".repeat(64), created = "2026-11-11T01:02:03.123456789Z";
const rawContainer = (extra = {}) => ({ id, created, name: "/mysql", image: "mysql:latest", project: "database", service: "mysql", state: "running", health: "healthy", ports: { "3306/tcp": [{ HostIp: "127.0.0.1", HostPort: "3306" }] }, ...extra });
const container = (extra = {}) => ({ ...model.normalizeContainer(rawContainer()), daemon: "engine-fixture", ...extra });
const listener = { address: "127.0.0.1", port: 3306, pid: 123, name: "mysqld" };
const snapshot = () => ({ containers: [container()], ports: model.associatePorts([listener], [container()]), warnings: [], captured: 1 });
const reply = (stdout = "", code = 0, extra = {}) => ({ stdout, stderr: "", code, ...extra });

test("container snapshots group Compose projects, prioritize abnormalities, bound data and retain literal names", () => {
  const rows = [container(), container({ id: secondId, name: "name; $(echo x)", group: "gts", state: "exited" }), container({ id: "c".repeat(64), group: "ai", health: "unhealthy" })];
  assert.deepEqual(model.filteredContainers(rows).map(row => row.id), ["c".repeat(64), secondId, id]);
  assert.equal(model.filteredContainers(rows, "3306").length, 3);
  assert.equal(model.normalizeContainer(rawContainer({ project: "orbstack" })).group, "other");
  assert.equal(model.normalizeContainer(rawContainer({ name: "x\ncontrol" })).name, "x control");
  assert.throws(() => model.normalizeContainer(rawContainer({ id: "short" })), /complete container identity/);
  const parsed = model.parseContainers(JSON.stringify(rawContainer()) + "\n{invalid\n");
  assert.equal(parsed.containers.length, 1); assert.equal(parsed.warnings.length, 1);
  assert.throws(() => model.parseContainers("x".repeat(model.SERVICE_LIMITS.output + 1)), /too large/);
  assert.equal(model.sameContainer({ ...model.containerIdentity(container(), "remote"), daemon: "engine-fixture" }, container(), "other"), false);
});

test("TCP parser handles IPv4, IPv6, wildcard, hidden PID and duplicate records without treating UDP as listeners", () => {
  const lsof = "p123\ncmysqld\nn127.0.0.1:3306\nn127.0.0.1:3306\np42\ncnode\nn[::1]:3000\nn*:5000\n";
  const rows = parseListeners(lsof, "lsof"); assert.equal(rows.length, 3); assert.equal(rows[1].address, "::1");
  assert.equal(model.listenerURL(rows[1]), "http://[::1]:3000");
  assert.equal(model.listenerURL(rows[2]), null); assert.equal(model.listenerURL(rows[0], "remote"), null);
  assert.equal(model.listenerURL(rows[0], null, "file"), null);
  assert.equal(model.listenerURL({ ...listener, address: "127.999.0.1" }), null);
  const ss = parseListeners('LISTEN 0 128 127.0.0.1:8000 0.0.0.0:* users:(("python3",pid=7,fd=4))\nLISTEN 0 128 [::]:9000 [::]:*\n', "ss");
  assert.equal(ss[0].pid, 7); assert.equal(ss[1].pid, null);
  assert.equal(model.filteredPorts(model.associatePorts(rows, [container()]), "database 3306").length, 1);
  assert.equal(parseEndpoint("localhost:0"), null); assert.throws(() => parseListeners("x", "missing"), /supported listener/);
});

test("Docker and port probes return independent partial results, and only compact inspect fields are requested", async () => {
  const calls = [], run = async (command, args, options) => { calls.push({ command, args, options }); if (command === "docker") return reply("", 127, { error: "docker was not found." }); if (command === "lsof") return reply("p123\ncmysqld\nn127.0.0.1:3306\n"); return reply("", 127); };
  const value = await scanServices(run, "darwin"); assert.equal(value.containers.length, 0); assert.equal(value.ports.length, 1); assert(value.warnings.some(text => /not found/.test(text)));
  const docker = await scanDocker(async (_command, args) => args[0] === "info" ? reply('"engine-fixture"') : args[0] === "ps" ? reply(id + "\n") : reply(JSON.stringify(rawContainer()) + "\n"));
  assert.equal(docker.containers[0].daemon, "engine-fixture");
  assert(!INSPECT_FORMAT.includes("Env")); assert(!INSPECT_FORMAT.includes("Mounts")); assert(calls.every(call => call.options.timeout <= 10000));
  const invalid = await scanDocker(async (_command, args) => args[0] === "info" ? reply('"engine"') : reply("not-a-full-id\n"));
  assert.equal(invalid.containers.length, 0); assert.match(invalid.warnings.join(" "), /incomplete/);
});

test("container actions recheck full identity and daemon, use literal argv, and never retry a restart", async () => {
  const calls = []; let changed = false, engine = "engine-fixture";
  const run = async (command, args) => { calls.push([command, args]); if (args[0] === "info") return reply(JSON.stringify(engine)); if (args[0] === "inspect") return reply(`${id}\n${changed ? "new-created" : created}\n`); if (args[0] === "restart") return reply(id + "\n"); return reply("logs fixture"); };
  const expected = { ...container(), on: null };
  changed = true; await assert.rejects(() => containerAction("restart", expected, run), /changed/); assert(!calls.some(([,args]) => args[0] === "restart"));
  changed = false; engine = "other"; await assert.rejects(() => containerAction("restart", expected, run), /engine changed/);
  engine = "engine-fixture"; assert.deepEqual(await containerAction("restart", expected, run), { restarted: true });
  assert.deepEqual(calls.find(([, args]) => args[0] === "restart"), ["docker", ["restart", "--time", "10", "--", id]]);
  await containerAction("logs", expected, run); assert(calls.some(([, args]) => args[0] === "logs" && args.includes("300")));
  const failure = async (command,args) => args[0] === "restart" ? reply("", 1) : run(command,args);
  await assert.rejects(() => containerAction("restart", expected, failure), error => error.attempted === true);
  await assert.rejects(() => containerAction("restart", { ...expected, on: "remote" }, run), /engine identity/);
});

test("short-lived real probes kill their own timed-out or oversized fixture subprocesses", async () => {
  const large = await runBounded(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)"], { cap: 3000, timeout: 3000 });
  assert.equal(large.stdout.length, 3000); assert.equal(large.truncated, true);
  const slow = await runBounded(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 40, cap: 1000 }); assert.equal(slow.timedOut, true);
});

async function remoteFixture(t) {
  const root = await fs.mkdtemp('/private/tmp/herdr-services-fixture-'); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); await fs.mkdir(bin); const calls = path.join(root, 'calls.jsonl');
  const script = `#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');\nif(args[0]==='info')console.log(JSON.stringify('engine-fixture'));else if(args[0]==='ps')console.log(${JSON.stringify(id)});else if(args[0]==='inspect')console.log(args[2].includes('"id"')?${JSON.stringify(JSON.stringify(rawContainer()))}:${JSON.stringify(id+'\n'+created)});else if(args[0]==='restart')console.log(${JSON.stringify(id)});else if(args[0]==='logs')console.log('fixture logs');else process.exit(2);\n`;
  await fs.writeFile(path.join(bin, 'docker'), script, { mode: 0o700 });
  await fs.writeFile(path.join(bin, 'ss'), '#!/bin/sh\nprintf \'LISTEN 0 128 127.0.0.1:3306 0.0.0.0:* users:(("mysqld",pid=123,fd=4))\\n\'\n', { mode: 0o700 });
  await fs.writeFile(path.join(bin, 'lsof'), '#!/bin/sh\nprintf \'p123\\ncmysqld\\nn127.0.0.1:3306\\n\'\n', { mode: 0o700 });
  return { root, calls, env: { ...process.env, PATH: bin + ':' + process.env.PATH } };
}
test("fixed remote POSIX scripts parse real fixture programs and quoted identity cannot become shell syntax", async t => {
  const f = await remoteFixture(t);
  const scan = await execute('/bin/sh', ['-c', REMOTE_SCAN_SCRIPT, 'workspace-services', INSPECT_FORMAT], { env: f.env });
  const parsed = parseRemoteSnapshot(reply(scan.stdout)); assert.equal(parsed.containers.length, 1); assert.equal(parsed.ports[0].pid, 123);
  const action = await execute('/bin/sh', ['-c', REMOTE_ACTION_SCRIPT, 'workspace-services', 'restart', id, created, '"engine-fixture"'], { env: f.env }); assert.equal(action.stdout.trim(), id);
  const marker = path.join(f.root, 'must-not-exist');
  await assert.rejects(() => execute('/bin/sh', ['-c', REMOTE_ACTION_SCRIPT, 'workspace-services', 'restart', id, `$(touch ${marker})`, '"engine-fixture"'], { env: f.env }));
  await assert.rejects(() => fs.stat(marker), error => error.code === 'ENOENT');
  const calls = (await fs.readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse); assert.equal(calls.filter(args => args[0] === 'restart').length, 1);
});

test("native client executes the actual short-lived helper only against private fake executables", async t => {
  const f = await remoteFixture(t), home = path.resolve(new URL("../", import.meta.url).pathname);
  const client = createServicesClient({ home, node: process.execPath, context: { on: null }, execute: async (command,args,options) => {
    try { const result = await execute(command,args,{env:f.env,timeout:options.timeout,maxBuffer:2000000}); return reply(result.stdout,0,{stderr:result.stderr}); }
    catch(error) { return reply(error.stdout||"",error.code||1,{stderr:error.stderr||""}); }
  }});
  const value = await client.scan(); assert.equal(value.containers[0].id,id); assert.equal(value.ports[0].port,3306);
  assert.equal((await client.logs(value.containers[0])).text.trim(),"fixture logs");
  assert.deepEqual(await client.restart(value.containers[0]),{restarted:true});
  await assert.rejects(()=>client.restart({...value.containers[0],on:"wrong-machine"}),/another machine/);
});

test("client captures its machine, preserves partial remote data, and never falls back when offline", async () => {
  const calls = [], execute = async (command,args,options) => { calls.push({command,args,options}); return reply('\n__AW_ENGINE__\n\n__AW_CONTAINERS__\n__AW_DOCKER_MISSING__\n\n__AW_PORTS__\nss\nLISTEN 0 1 127.0.0.1:9000 0.0.0.0:*\n\n__AW_END__\n'); };
  const context = {on:'remote',root:'/fixture'}; let online = true;
  const client = createServicesClient({execute,home:'/app',context,connected:()=>online}); context.on = null;
  const value = await client.scan(); assert.equal(value.ports.length,1); assert(value.warnings.some(text=>/Docker/.test(text))); assert.equal(calls[0].options.on,'remote');
  online = false; await assert.rejects(()=>client.scan(),/No local fallback/); assert.equal(calls.length,1);
  assert.throws(()=>model.serviceContext({on:'bad/host'}),/invalid/);
});

function element() {
  const node={attributes:{},events:{},childNodes:[]}; const proxy=new Proxy(node,{get(object,key){
    if(key==='child')return value=>{object.childNodes.push(value);return proxy;}; if(key==='children')return values=>{object.childNodes.push(...values);return proxy;};
    if(key==='when')return (condition,callback)=>condition?callback(proxy):proxy;
    if(String(key).startsWith('on_'))return (...args)=>{object.events[key]=args.at(-1);return proxy;}; if(key in object)return object[key]; return value=>{object.attributes[key]=value;return proxy;};
  }});return proxy;
}
const descendants=node=>!node||typeof node!=='object'?[]:[node,...node.childNodes.flatMap(descendants)];
const source=readFileSync(new URL('../mods/sessions-plus/services.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export default class','return class');
function harness({context={root:'/captured',on:null},value=snapshot(),store=new Map(),scan,logs,restart,listeners}={}) {
  const tasks=[],inputs=[],calls=[],opened=[],copied=[]; let rendering=false;
  const cx={notify(){assert(!rendering);},stop_propagation(){},focus_handle:()=>({focus(){}}),spawn(task){tasks.push(task(cx));},open_url:url=>opened.push(url),write_to_clipboard:text=>copied.push(text)};
  const retained=options=>{let text=options.value||'';return {value:()=>text,set_value(value){text=value;},on(name,handler){this.handler=handler;},type(value){text=value;this.handler?.({},cx);},release(){this.released=true;}};};
  const client={scan:async()=>{calls.push('scan');return scan?scan():value;},logs:async row=>{calls.push(['logs',row]);return logs?logs(row):{text:'Fixture logs'};},restart:async row=>{calls.push(['restart',row]);return restart?restart(row):{restarted:true};},listeners:async()=>{calls.push('listeners');return listeners?listeners():value.ports;}};
  const deps={...model,div:element,svg:element,v_flex:element,h_flex:element,Input:{new:element},Editor:{new:element},InputState:{new(options){const input=retained(options);inputs.push(input);return input;}},EditorState:{new:retained},projectContext:()=>context,appHome:()=>'/app',exec(){throw new Error('No real process from UI fixture');},machines:()=>[],theme:()=>({}),shared:key=>store.get(key),setShared(key,value){assert(!rendering);store.set(key,value);},closeOverlay(){},createServicesClient:options=>{calls.push(['client',options.context]);return client;}};
  const Class=new Function(...Object.keys(deps),source)(...Object.values(deps)),view=new Class();view.init({},cx);
  return {view,cx,calls,inputs,opened,copied,store,async settle(){for(let i=0;i<8;i++)await Promise.all(tasks.splice(0));},render(){rendering=true;try{return view.render(cx);}finally{rendering=false;}},click(id){const node=descendants(this.render()).find(node=>node.attributes.id===id);assert(node,`missing ${id}`);node.events.on_click({},cx);}};
}
test("production services view captures machine, reads once and never probes from render, search or focus changes",async()=>{
  const context={root:'/remote',on:'machine-A'},f=harness({context});await f.settle();context.on='machine-B';context.root='/other';
  f.render();f.inputs[0].type('mysql');f.render();assert.equal(f.view.context.on,'machine-A');assert.equal(f.calls.filter(call=>call==='scan').length,1);
  f.view.close();assert(f.inputs[0].released);
});
test("production restart requires two explicit steps, coordinates views and ignores double clicks",async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),f=harness({restart:()=>gate});await f.settle();
  f.click(`service-restart-${id}`);assert.equal(f.calls.filter(call=>Array.isArray(call)&&call[0]==='restart').length,0);
  f.click('services-restart-confirm');f.view.restart(f.cx);
  const second=harness({store:f.store});await second.settle();second.view.arm(second.view.snapshot.containers[0],second.cx);second.view.restart(second.cx);assert.match(second.view.error,/already pending/);
  release({restarted:true});await f.settle();assert.equal(f.calls.filter(call=>Array.isArray(call)&&call[0]==='restart').length,1);assert(f.view.issued.has(id));assert.equal(f.view.confirm,null);
});
test("production stale selections, failed snapshots and replaced listeners cannot trigger mutations or URLs",async()=>{
  const f=harness({listeners:()=>[{...listener,pid:999}]});await f.settle();f.view.arm(container(),f.cx);f.view.snapshot.containers=[container({created:'replacement'})];f.view.restart(f.cx);assert.match(f.view.error,/selection changed/);
  f.view.selectedPort=listener;f.view.useURL(true,f.cx);await f.settle();assert.equal(f.opened.length,0);assert.match(f.view.error,/listener changed/);
  const denied=harness({scan:()=>{throw new Error('offline');}});await denied.settle();assert(denied.view.stale);denied.view.arm(container(),denied.cx);assert.equal(denied.view.confirm,null);
});
test("production loopback actions revalidate before copying or opening, remote and wildcard stay disabled",async()=>{
  const f=harness();await f.settle();f.click('services-ports-tab');f.view.selectedPort={...listener};f.click('services-copy-url');await f.settle();assert.deepEqual(f.copied,['http://127.0.0.1:3306']);
  f.view.scheme='https';f.view.useURL(true,f.cx);await f.settle();assert.deepEqual(f.opened,['https://127.0.0.1:3306']);
  f.view.context.on='remote';f.view.useURL(true,f.cx);f.view.context.on=null;f.view.selectedPort={...listener,address:'0.0.0.0'};f.view.useURL(true,f.cx);assert.equal(f.opened.length,1);
});
test("production on-demand log state rejects late results after close and releases retained editors",async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),f=harness({logs:()=>gate});await f.settle();f.view.logs(container(),f.cx);f.view.logs(container(),f.cx);f.view.close();release({text:'late'});await f.settle();assert.equal(f.view.log,undefined);
  const other=harness();await other.settle();other.view.logs(container(),other.cx);await other.settle();const editor=other.view.logEditor;assert.equal(editor.value(),'Fixture logs');other.view.closeLog(other.cx);assert(editor.released);
});


test("uncertain restart retains a bounded cross-view reservation instead of permitting immediate duplicate requests", async()=>{
  const f=harness({restart:()=>{const error=new Error("Restart result unconfirmed");error.attempted=true;throw error;}});await f.settle();
  f.view.arm(container(),f.cx);f.view.restart(f.cx);await f.settle();
  const other=harness({store:f.store});await other.settle();other.view.arm(container(),other.cx);other.view.restart(other.cx);
  assert.match(other.view.error,/already pending/);assert.equal(other.calls.filter(call=>Array.isArray(call)&&call[0]==="restart").length,0);
});


test("switching Services tabs rejects a late log result instead of covering the new tab",async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),f=harness({logs:()=>gate});await f.settle();
  f.view.logs(container(),f.cx);f.view.selectTab("ports",f.cx);release({text:"Old selected-container result"});await f.settle();
  assert.equal(f.view.tab,"ports");assert.equal(f.view.log,null);assert.equal(f.view.logEditor,null);
});


test("port associations select the TCP target for the matching host address and preserve wildcard semantics", () => {
  const row = container({ mappings: [
    { address: "127.0.0.2", port: 3000, target: 123, protocol: "tcp" },
    { address: "127.0.0.1", port: 3000, target: 456, protocol: "tcp" },
    { address: "127.0.0.1", port: 3000, target: 789, protocol: "udp" },
    { address: "::1", port: 3000, target: 900, protocol: "tcp" },
  ] });
  const wild = container({ id: secondId, mappings: [{ address: "0.0.0.0", port: 3000, target: 8080, protocol: "tcp" }] });
  const rows = model.associatePorts(["127.0.0.1", "127.0.0.2", "::1", "127.0.0.3"].map(address => ({ ...listener, address, port: 3000 })), [row, wild]);
  assert.equal(rows[0].containers.find(value => value.id === id).target, 456);
  assert.equal(rows[1].containers.find(value => value.id === id).target, 123);
  assert.equal(rows[2].containers.find(value => value.id === id).target, 900);
  assert.deepEqual(rows[3].containers.map(value => value.target), [8080]);
  assert(rows.every(row => row.containers.some(value => value.id === secondId && value.target === 8080)));
  assert.equal(model.associatePorts([{ ...listener, port: 3000 }], [{ ...row, state: "exited" }])[0].containers.length, 0);
});

test("listener associations index bounded container bindings once across a maximum-size listener snapshot", () => {
  let hostPortReads = 0;
  const containers = Array.from({ length: model.SERVICE_LIMITS.containers }, (_, index) => container({ id: index.toString(16).padStart(64, "0"), mappings: Array.from({ length: 16 }, (_, binding) => ({ address: "127.0.0.1", get port() { hostPortReads++; return 10000 + index * 16 + binding; }, target: binding + 1, protocol: "tcp" })) }));
  const ports = Array.from({ length: model.SERVICE_LIMITS.ports }, (_, index) => ({ ...listener, port: 10000 + index % 1920 }));
  const rows = model.associatePorts(ports, containers);
  assert.equal(rows.length, model.SERVICE_LIMITS.ports); assert(rows.every(row => row.containers.length === 1));
  assert(hostPortReads <= 120 * 16 * 2, `binding work unexpectedly grew with the listener count: ${hostPortReads}`);
  assert.equal(rows[1919].containers[0].target, 16);
});


test("production lists keep fixed render pages while searching every captured row", async () => {
  const containers = Array.from({ length: 120 }, (_, index) => container({ id: index.toString(16).padStart(64, "0"), name: `fixture-${index.toString().padStart(3, "0")}` }));
  const ports = Array.from({ length: 2000 }, (_, index) => ({ ...listener, port: 10000 + index }));
  const f = harness({ value: { containers, ports, warnings: [], captured: 1 } }); await f.settle();
  const count = prefix => descendants(f.render()).filter(node => typeof node.attributes.id === "string" && node.attributes.id.startsWith(prefix)).length;
  assert.equal(count("service-container-"), 40); assert.equal(count("service-port-"), 0);
  f.click("services-container-next"); f.click("services-container-next"); assert.equal(count("service-container-"), 40);
  f.inputs[0].type("fixture-119"); assert.equal(count("service-container-"), 1); assert.equal(f.view.containerPage, 0);
  f.inputs[0].type(""); f.click("services-ports-tab"); assert.equal(count("service-container-"), 0); assert.equal(count("service-port-"), 100);
  for (let page = 0; page < 19; page++) f.click("services-port-next");
  assert.equal(count("service-port-"), 100); assert.equal(f.view.portPage, 19);
  f.inputs[0].type("11999"); assert.equal(count("service-port-"), 1); assert.equal(f.view.portPage, 0);
});
