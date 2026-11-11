import assert from "node:assert/strict";
import test from "node:test";
import { buildGroups, assignSpace } from "../mods/project-spaces/model.js";
import { unifiedRows, validateUnifiedTarget, unifiedAliasKey, UNIFIED_PAGE_SIZE } from "../mods/project-spaces/unified-model.js";
const program = { key: "codex", name: "Codex", agent: true, shell: false };
const tab = (id, extra={}) => ({id,name:id,named:false,active:false,...extra});
const space = (id, tabs=[], extra={}) => ({id,name:id,folder:"/same",machine:null,tabs,active:false,status:null,...extra});
const terminal = (address,extra={}) => ({address,state:"live",created_ms:1,title:address,cwd:"/same",program,...extra});
const agent = (address,space,tab,pane,extra={}) => ({address,space,tab,pane,title:`Long task for ${address}`,status:"working",program,pinned:false,focused:false,...extra});
const pane = (terminal,tab,pane,extra={}) => ({terminal,tab,pane,program,...extra});
function fixture({sp=null,ts=null,as=null,ps=null,state={}}={}) {
 const spaces=sp||[space("s1",[tab("tab1")])],terminals=ts||[terminal("t1")],agents=as||[agent("t1","s1","tab1","p1")],panes=ps||[pane("t1","tab1","p1")];
 const groups=buildGroups(spaces.map((w,i)=>({w,i,g:null,place:w.folder})),state);return {spaces,terminals,agents,panes,groups};
}
function all(input,options={}) { const first=unifiedRows(input,{...options,page:0}),rows=[...first.rows];for(let page=1;page<first.pages;page++)rows.push(...unifiedRows(input,{...options,page}).rows);return {...first,rows}; }
const entities=result=>result.rows.filter(row=>row.address);
const byAddress=(result,address)=>entities(result).find(row=>row.address===address);
function freeze(value) {if(value&&typeof value==="object"){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}

test("canonical project assignment, ordering and source references survive the unified projection without mutations",()=>{
 const sp=[space("s1",[tab("tab1")],{folder:"/one"}),space("s2",[tab("tab2")],{folder:"/two"})],base=fixture({sp,ts:[terminal("t1"),terminal("t2")],as:[agent("t1","s1","tab1","p1"),agent("t2","s2","tab2","p2")],ps:[pane("t1","tab1","p1"),pane("t2","tab2","p2")]});
 const original=base.groups,st=assignSpace({},"s2",original[0].key,original[1].key,"One");base.groups=buildGroups(sp.map((w,i)=>({w,i,g:null,place:w.folder})),st);const before=JSON.stringify(base);freeze(base);const result=all(base);
 assert.equal(JSON.stringify(base),before);assert.equal(result.rows.filter(r=>r.kind==="group").length,1);assert.equal(result.rows.find(r=>r.kind==="group").sourceGroup,base.groups[0]);assert.equal(result.rows.find(r=>r.kind==="space"&&r.spaceId==="s2").sourceSpace,base.groups[0].rows[1]);assert.equal(result.counts.agents,2);assert.deepEqual(result.agentOrder,["t1","t2"]);
});

test("one agent can share a tab row; multiple agents, shells and preview tabs preserve navigation",()=>{
 const one=all(fixture());assert(byAddress(one,"t1").merged);assert(!one.rows.some(r=>r.kind==="tab"));
 const f=fixture({sp:[space("s1",[tab("tab1"),tab("shell"),tab("preview"),tab("empty")])],ts:[terminal("t1"),terminal("t2"),terminal("sh",{program:{name:"zsh",shell:true,agent:false}})],as:[agent("t1","s1","tab1","p1"),agent("t2","s1","tab1","p2")],ps:[pane("t1","tab1","p1"),pane("t2","tab1","p2"),pane("sh","shell","p3"),{pane:"mod-pane",terminal:null,tab:"preview",mod:"files-plus"}]});
 const result=all(f);for(const id of ["tab1","preview","empty"])assert(result.rows.some(r=>r.kind==="tab"&&r.tabId===id));assert.equal(byAddress(result,"sh").agent,false);assert.equal(byAddress(result,"sh").kind,"terminal");assert(byAddress(result,"sh").merged);assert.equal(byAddress(result,"sh").target.tab,"shell");assert(result.rows.find(r=>r.tabId==="preview").metadata.includes("preview"));assert.equal(result.counts.agents,2);assert(validateUnifiedTarget(result.rows.find(r=>r.kind==="tab"&&r.tabId==="empty").target,f));
});

test("empty spaces and spaces absent from Git groups always retain valid selection and new-tab context",()=>{
 const f=fixture({sp:[space("s1",[]),space("s2",[tab("preview")])],ts:[],as:[],ps:[]});f.groups=[];const result=all(f);const empty=result.rows.find(r=>r.kind==="space"&&r.spaceId==="s1");assert(empty.empty);assert.deepEqual(empty.newTabTarget,{space:"s1",on:null});assert(validateUnifiedTarget(empty.target,f));assert(result.rows.some(r=>r.kind==="tab"&&r.tabId==="preview"));
});

test("explicit parents nest kept children once and parent context stays with a blocked child branch",()=>{
 const f=fixture({sp:[space("s1",[tab("tab1"),tab("tab2")])],ts:[terminal("t1"),terminal("t2",{parent:"t1",created_ms:2}),terminal("tool",{parent:"t2",created_ms:3,program:{name:"bash",shell:true,agent:false}})],as:[agent("t1","s1","tab1","p1"),agent("t2","s1","tab2","p2",{status:"blocked"})],ps:[pane("t1","tab1","p1"),pane("t2","tab2","p2")]});
 const result=all(f);assert.deepEqual(entities(result).map(r=>r.address),["t1","t2","tool"]);assert.equal(byAddress(result,"t1").status,"working");assert.equal(byAddress(result,"t1").branchStatus,"blocked");assert.equal(byAddress(result,"t2").parentId,"t1");assert.equal(byAddress(result,"t2").target.tab,"tab2");assert.equal(byAddress(result,"tool").agent,false);assert(result.rows.some(r=>r.title==="Needs attention"));for(const t of ["tab1","tab2"])assert(!result.rows.some(r=>r.kind==="tab"&&r.tabId===t));assert.equal(new Set(entities(result).map(r=>r.address)).size,3);
});

test("Pinned takes branch precedence over attention, raw official pin labels work, and row statuses stay distinct",()=>{
 const f=fixture({ts:[terminal("t1"),terminal("kid",{parent:"t1",created_ms:2,labels:{"herdr.pinned":"true"},status:"done"})]});const result=all(f);assert.equal(result.rows[0].title,"Pinned");assert(!result.rows.some(r=>r.title==="Needs attention"));assert(byAddress(result,"kid").pinned);assert.equal(byAddress(result,"kid").status,"done");assert.equal(byAddress(result,"t1").status,"working");assert.equal(result.counts.done,1);assert.equal(result.counts.blocked,0);
 f.terminals[0].labels={"herdr.pinned":"true"};assert.equal(byAddress(all(f),"t1").pinned,false,"AgentInfo false wins over an older raw label");
});

test("Status classifies independent branches in the same space separately and preserves every workspace/tab",()=>{
 const f=fixture({sp:[space("s1",[tab("tab1")]),space("quiet",[tab("shell")])],ts:[terminal("t1"),terminal("t2")],as:[agent("t1","s1","tab1","p1"),agent("t2","s1","tab1","p2",{status:"blocked"})],ps:[pane("t1","tab1","p1"),pane("t2","tab1","p2")]});const result=all(f,{view:"status"});const addrRows=entities(result);assert.equal(addrRows.length,2);assert(result.rows.findIndex(r=>r.title==="Needs you")<result.rows.findIndex(r=>r.address==="t2"));assert(result.rows.findIndex(r=>r.title==="Working")<result.rows.findIndex(r=>r.address==="t1"));assert(result.rows.some(r=>r.title==="Other workspaces"));for(const id of ["s1","quiet"])assert(result.rows.some(r=>r.kind==="space"&&r.spaceId===id));assert(result.rows.some(r=>r.kind==="tab"&&r.tabId==="shell"));
});

test("remote bare parents stay remote; identical cwd, names and bare suffixes cannot establish ownership",()=>{
 const f=fixture({sp:[space("s1",[tab("tab1")]),space("box/s1",[tab("box/tab1")],{machine:"box",folder:"/same"})],ts:[terminal("t1"),terminal("box/t1"),terminal("box/t2",{parent:"t1",created_ms:2,labels:{"herdr.space":"s1","herdr.tab":"tab1"}}),terminal("unowned",{program:{name:"mystery"}})],as:[agent("t1","s1","tab1","p1"),agent("box/t1","box/s1","box/tab1","box/p1")],ps:[pane("t1","tab1","p1"),pane("box/t1","box/tab1","box/p1")]});const result=all(f);assert.equal(byAddress(result,"box/t2").parentId,"box/t1");assert.equal(byAddress(result,"box/t2").target.space,"box/s1");assert.equal(byAddress(result,"box/t2").target.on,"box");assert.equal(byAddress(result,"unowned").target.space,null);assert.equal(byAddress(result,"unowned").agent,false);assert(result.rows.some(r=>r.title==="Other live terminals"));assert(validateUnifiedTarget(byAddress(result,"box/t2").target,f));
});

test("cycles, replaced/missing parents, cross-machine links and missing metadata remain visible and bounded",()=>{
 const f=fixture({sp:[],ts:[terminal("a",{parent:"b"}),terminal("b",{parent:"a"}),terminal("missing",{parent:"absent"}),terminal("box/cross",{parent:"a"}),terminal("old-child",{parent:"new-parent",created_ms:1}),terminal("new-parent",{created_ms:9}),terminal("unknown",{created_ms:undefined})],as:[],ps:[]});const result=all(f);assert.equal(entities(result).length,7);assert(entities(result).some(r=>r.cycle));assert(byAddress(result,"missing").missingParent);assert(byAddress(result,"old-child").missingParent);assert(byAddress(result,"box/cross").missingParent);assert(byAddress(result,"unknown").target.disabled);assert(result.warnings.length);
});

test("stale/recycled/retargeted agent rows refuse actions while ordinary title/status changes do not",()=>{
 const f=fixture(),target=byAddress(all(f),"t1").target;assert(validateUnifiedTarget(target,f));
 for(const mutate of [g=>g.terminals[0].state="exited",g=>g.terminals[0].created_ms=2,g=>g.terminals[0].parent="other",g=>g.panes[0].pane="changed",g=>{g.agents[0].tab="absent";},g=>{g.agents=[];g.terminals[0].program={shell:true,agent:false};}]){const fresh=structuredClone(f);mutate(fresh);assert.equal(validateUnifiedTarget(target,fresh),false);}
 const renamed=structuredClone(f);renamed.agents[0].title="A new title";renamed.agents[0].status="done";assert(validateUnifiedTarget(target,renamed));
});

test("conflicting API/pane/label ownership and duplicate identities are visible with disabled actions",()=>{
 const f=fixture();f.terminals[0].labels={"herdr.space":"wrong","herdr.tab":"tab1"};const row=byAddress(all(f),"t1");assert(row.target.disabled);assert.equal(row.target.space,null);assert(!validateUnifiedTarget(row.target,f));
 const duplicate=fixture();duplicate.terminals.push({...duplicate.terminals[0],created_ms:4});const result=all(duplicate);assert.equal(entities(result).length,1);assert(byAddress(result,"t1").target.disabled);assert(result.warnings.length);
});

test("search and status filters retain parent context, expand folds temporarily and do not rewrite groups",()=>{
 const f=fixture({ts:[terminal("t1"),terminal("kid",{parent:"t1",created_ms:2,status:"blocked",title:"needle"})]});f.groups[0].folded=true;const before=JSON.stringify(f),result=all(f,{query:"needle",statusFilter:"attention",folded:["agent:t1"]});assert.deepEqual(entities(result).map(r=>r.address),["t1","kid"]);assert(byAddress(result,"t1").contextOnly);assert(!byAddress(result,"t1").folded);assert.equal(JSON.stringify(f),before);
 const quiet=all(f,{query:"nothing matches"});assert.equal(quiet.total,0);const status=all(f,{view:"status",statusFilter:"working"});assert(!status.rows.some(r=>r.kind==="space"));
});

test("field limits, per-lifecycle aliases and held Done do not guess unknown agent state",()=>{
 const f=fixture({ts:[terminal("t1"),terminal("raw",{program:{shell:true,agent:false},status:"working"})],as:[agent("t1","s1","tab1","p1",{title:"word ".repeat(2000),status:"idle"})]});const first=byAddress(all(f),"t1"),key=unifiedAliasKey(first.target),result=all(f,{aliases:{[key]:"Short task"},heldDone:["t1"]});assert.equal(byAddress(result,"t1").title,"Short task");assert.equal(byAddress(result,"t1").status,"done");assert(byAddress(result,"t1").taskTitle.length<=2048);assert(byAddress(result,"t1").metadata.length<=500);assert.equal(byAddress(result,"raw").agent,false);f.terminals[0].created_ms=2;assert.notEqual(byAddress(all(f,{aliases:{[key]:"Short task"}}),"t1").title,"Short task");
});

test("all large/deep input nodes remain reachable by true pages and search, without cumulative native rows",()=>{
 const ts=Array.from({length:240},(_,i)=>terminal(`t${i}`,{created_ms:i+1,parent:i?`t${i-1}`:null,status:"idle",title:i===239?"last needle":"task"})),f=fixture({ts,as:[],ps:[],sp:[]});const result=all(f,{pageSize:1000});assert.equal(result.pageSize,UNIFIED_PAGE_SIZE);assert.equal(entities(result).length,240);assert.equal(new Set(result.rows.map(r=>r.id)).size,result.rows.length);assert(entities(result).at(-1).depth>100);assert(entities(result).every(r=>r.displayDepth<=8));assert(entities(all(f,{query:"last needle"})).some(r=>r.address==="t239"));for(let p=0;p<result.pages;p++)assert(unifiedRows(f,{page:p}).rows.length<=30);
});


test("status filters classify the retained branch instead of an invisible blocked sibling",()=>{
 const f=fixture({ts:[terminal("t1"),terminal("kid",{parent:"t1",created_ms:2,status:"blocked"})]});const result=all(f,{view:"status",statusFilter:"working"});assert.deepEqual(entities(result).map(r=>r.address),["t1"]);assert(result.rows.some(r=>r.title==="Working"));assert(!result.rows.some(r=>r.title==="Needs attention"));
});


test("partial explicit metadata stays navigable without inventing ownership or weakening creation checks",()=>{
 const onlyApi=fixture({ps:[]});const a=byAddress(all(onlyApi),"t1");assert.equal(a.target.pane,"p1");assert(!a.target.disabled);assert(validateUnifiedTarget(a.target,onlyApi));
 const partial=fixture({as:[{address:"t1",title:"Partial agent",status:"working",program,pinned:false}],ps:[]});partial.terminals[0].labels={"herdr.space":"s1"};const row=byAddress(all(partial),"t1");assert.equal(row.target.space,"s1");assert.equal(row.target.tab,null);assert(!row.target.disabled);assert(validateUnifiedTarget(row.target,partial));
 const changed=structuredClone(partial);changed.agents[0].pane="new-explicit-pane";assert(!validateUnifiedTarget(row.target,changed));
 const raw=fixture({as:[],ps:[]});const loose=byAddress(all(raw),"t1");assert.equal(loose.target.space,null);assert(!loose.target.disabled);assert(validateUnifiedTarget(loose.target,raw));
});


test("project-name search preserves explicit unlabeled descendants without inventing action ownership",()=>{
 const f=fixture({ts:[terminal("t1"),terminal("kid",{parent:"t1",created_ms:2,title:"helper",cwd:"/unrelated-folder"})]});f.groups[0].name="Manual Release";const result=all(f,{query:"Manual Release"});assert.deepEqual(entities(result).map(r=>r.address),["t1","kid"]);assert(byAddress(result,"kid").metadata.includes("Manual Release"));assert.equal(byAddress(result,"kid").target.space,null);assert(validateUnifiedTarget(byAddress(result,"kid").target,f));
});


test("one-space automatic projects collapse the redundant header while custom/manual projects retain theirs",()=>{
 const automatic=fixture(),auto=all(automatic);assert(!auto.rows.some(r=>r.kind==="group"));const srow=auto.rows.find(r=>r.kind==="space");assert.equal(srow.depth,0);assert.equal(srow.sourceGroup,automatic.groups[0]);assert.equal(byAddress(auto,"t1").depth,1);
 for(const meta of [{custom:true},{manual:1}]){const manual=fixture();Object.assign(manual.groups[0],meta);const rows=all(manual).rows;assert(rows.some(r=>r.kind==="group"));assert.equal(rows.find(r=>r.kind==="space").depth,1);}
});


test("Project filters remove unrelated idle workspace/tab shells and intersect search with reported status",()=>{
 const f=fixture({sp:[space("s1",[tab("work"),tab("quiet-tab"),tab("preview")],{folder:"/active"}),space("quiet",[tab("shell")],{folder:"/quiet"}),space("empty",[],{folder:"/empty"})],ts:[terminal("t1"),terminal("idle")],as:[agent("t1","s1","work","p1"),agent("idle","quiet","shell","p2",{status:"idle"})],ps:[pane("t1","work","p1"),pane("idle","shell","p2"),{terminal:null,tab:"preview",pane:"mod"}]});
 const active=all(f,{statusFilter:"active"});assert.deepEqual(active.rows.filter(r=>r.kind==="space").map(r=>r.spaceId),["s1"]);assert(!active.rows.some(r=>["quiet-tab","preview","shell"].includes(r.tabId)));assert.equal(all(f,{query:"quiet",statusFilter:"active"}).total,0);assert.equal(all(f,{statusFilter:"attention"}).total,0);
 const every=all(f);assert.deepEqual(every.rows.filter(r=>r.kind==="space").map(r=>r.spaceId),["s1","quiet","empty"]);for(const id of ["quiet-tab","preview"])assert(every.rows.some(r=>r.tabId===id));const status=all(f,{view:"status",statusFilter:"active"});assert(!status.rows.some(r=>r.title==="Other workspaces"));
});


test("Status keeps Blocked, Done and held Done as distinct branch sections in one space",()=>{
 const f=fixture({sp:[space("s1",[tab("tab1")])],ts:[terminal("blocked"),terminal("done"),terminal("held")],as:[agent("blocked","s1","tab1","p1",{status:"blocked"}),agent("done","s1","tab1","p2",{status:"done"}),agent("held","s1","tab1","p3",{status:"idle"})],ps:[pane("blocked","tab1","p1"),pane("done","tab1","p2"),pane("held","tab1","p3")]});const result=all(f,{view:"status",heldDone:["held"]});const sections=result.rows.filter(r=>r.kind==="section");assert(sections.some(r=>r.title==="Needs you"&&r.status==="blocked"));assert(sections.some(r=>r.title==="Done"&&r.status==="done"&&r.childCount===2));assert(!sections.some(r=>r.title==="Needs attention"));assert.equal(byAddress(result,"held").status,"done");assert.equal(entities(result).length,3);assert.equal(new Set(entities(result).map(r=>r.address)).size,3);
});


test("merged generic program and numbered tab names retain the actual agent task title",()=>{
 for(const name of ["Codex","codex"," CODEX ","1","001"]){const f=fixture({sp:[space("s1",[tab("tab1",{name,named:true})])],as:[agent("t1","s1","tab1","p1",{title:"Investigate the queue timeout"})]});const row=byAddress(all(f),"t1");assert(row.merged);assert.equal(row.title,"Investigate the queue timeout");}
 const claude={...program,key:"claude",name:"Claude Code"},f=fixture({sp:[space("s1",[tab("tab1",{name:"Claude Code",named:true})])],as:[agent("t1","s1","tab1","p1",{program:claude,title:"Review the schema change"})]});assert.equal(byAddress(all(f),"t1").title,"Review the schema change");
});


test("meaningful manual merged-tab names win over the task while lifecycle aliases keep first priority",()=>{
 const f=fixture({sp:[space("s1",[tab("tab1",{name:"Release review",named:true})])],as:[agent("t1","s1","tab1","p1",{title:"Inspect the deployment diff"})]});const row=byAddress(all(f),"t1");assert.equal(row.title,"Release review");assert.equal(row.taskTitle,"Inspect the deployment diff");assert.equal(byAddress(all(f,{aliases:{[unifiedAliasKey(row.target)]:"My short label"}}),"t1").title,"My short label");f.spaces[0].tabs[0].named=false;assert.equal(byAddress(all(f),"t1").title,"Inspect the deployment diff");
});


test("single shell and non-agent process tabs merge safely, preserve manual names and deduplicate only context names",()=>{
 for(const process of [{key:"shell",name:"zsh",shell:true,agent:false},{key:"vim",name:"Vim",shell:false,agent:false}]){const f=fixture({sp:[space("s1",[tab("tab1",{name:"Bash",named:true})],{name:"Bash"})],ts:[terminal("t1",{title:process.name,program:process})],as:[],ps:[pane("t1","tab1","p1",{program:process})]});f.groups[0].name="Bash";const result=all(f),row=byAddress(result,"t1");assert(row.merged);assert.equal(row.kind,"terminal");assert.equal(row.agent,false);assert.equal(row.title,"Bash");assert.equal(row.target.tab,"tab1");assert(row.metadata.includes(process.name));assert(!row.metadata.includes("Tab +"));assert.equal(row.metadata.split(" · ").filter(v=>v==="Bash").length,1);assert(!result.rows.some(r=>r.kind==="tab"));assert(validateUnifiedTarget(row.target,f));const replaced=structuredClone(f);replaced.terminals[0].created_ms=99;assert(!validateUnifiedTarget(row.target,replaced));}
});


test("multiple shells and shell/mod mixtures retain explicit tab hierarchy",()=>{
 const shell={name:"zsh",key:"shell",shell:true,agent:false},sp=[space("s1",[tab("tab1",{name:"Bash",named:true})])];
 const multiple=fixture({sp,ts:[terminal("t1",{program:shell}),terminal("t2",{program:shell})],as:[],ps:[pane("t1","tab1","p1"),pane("t2","tab1","p2")]});const many=all(multiple);assert(many.rows.some(r=>r.kind==="tab"));assert(entities(many).every(r=>!r.merged));
 for(const onlyMod of [false,true]){const ps=onlyMod?[]:[pane("t1","tab1","p1")];ps.push({terminal:null,pane:"mod-preview",tab:"tab1",mod:"files-plus"});const mixed=fixture({sp,ts:[terminal("t1",{program:shell,labels:{"herdr.space":"s1","herdr.tab":"tab1"}})],as:[],ps});const result=all(mixed);assert(result.rows.some(r=>r.kind==="tab"));assert(!byAddress(result,"t1").merged);}
});


test("remote single-shell merge preserves qualified ownership and incomplete identities never replace their tab",()=>{
 const shell={name:"zsh",key:"shell",shell:true,agent:false},f=fixture({sp:[space("box/s1",[tab("box/tab1",{name:"Bash",named:true})],{machine:"box"})],ts:[terminal("box/t1",{program:shell,labels:{"herdr.space":"s1","herdr.tab":"tab1"}})],as:[],ps:[pane("box/t1","box/tab1","box/p1")]});const row=byAddress(all(f),"box/t1");assert(row.merged);assert.equal(row.title,"Bash");assert.equal(row.target.on,"box");assert.equal(row.target.tab,"box/tab1");assert(validateUnifiedTarget(row.target,f));f.terminals[0].created_ms=undefined;const unknown=all(f);assert(unknown.rows.some(r=>r.kind==="tab"));assert(byAddress(unknown,"box/t1").target.disabled);assert(!byAddress(unknown,"box/t1").merged);
});


test("promoted siblings prevent a false single-terminal merge and each terminal is rendered only once",()=>{
 const shell={name:"zsh",key:"shell",shell:true,agent:false};
 for(const promote of ["shell-pin","agent-attention"]){const f=fixture({sp:[space("s1",[tab("tab1",{name:"Bash",named:true})])],ts:[terminal("a"),terminal("sh",{program:shell,labels:promote==="shell-pin"?{"herdr.pinned":"true"}:{}})],as:[agent("a","s1","tab1","p1",{status:promote==="agent-attention"?"blocked":"working"})],ps:[pane("a","tab1","p1"),pane("sh","tab1","p2")]});const result=all(f);assert(result.rows.some(r=>r.kind==="tab"));assert(entities(result).every(r=>!r.merged));assert.equal(entities(result).filter(r=>r.address==="a").length,1);assert.equal(entities(result).filter(r=>r.address==="sh").length,1);}
 const only=fixture({ts:[terminal("t1",{program:shell,labels:{"herdr.pinned":"true"}})],as:[]});const pinned=all(only);assert.equal(entities(pinned).length,1);assert(!pinned.rows.some(r=>r.kind==="tab"));assert(pinned.rows.some(r=>r.kind==="space"&&r.foldable&&r.section==="pinned"));
});

test("nested project tasks show only local details while promoted and status rows retain their standalone context",()=>{
 const f=fixture({sp:[space("s1",[tab("tab1",{name:"Review",named:true})],{name:"GDP"})]});f.groups[0].name="OrbStack";f.groups[0].custom=true;
 const nested=byAddress(all(f),"t1");assert.equal(nested.depth,2);assert.equal(nested.inlineMetadata,"Codex");for(const name of ["OrbStack","GDP","Review"])assert(nested.metadata.includes(name));assert(!nested.inlineMetadata.includes("GDP"));
 const status=byAddress(all(f,{view:"status"}),"t1");assert.equal(status.inlineMetadata,"Codex");assert(status.metadata.includes("OrbStack"));
 f.agents[0].pinned=true;const pinned=byAddress(all(f),"t1");assert.equal(pinned.inlineMetadata,"Codex");assert(pinned.metadata.includes("GDP"));
});

test("pinning all agents removes duplicate tab shells, preserves the workspace, and unpin restores tree tasks",()=>{
 const f=fixture({sp:[space("s1",[tab("a",{name:"Codex",named:true}),tab("b",{name:"Claude Code",named:true})])],ts:[terminal("t1"),terminal("t2")],as:[agent("t1","s1","a","p1",{pinned:true}),agent("t2","s1","b","p2",{pinned:true})],ps:[pane("t1","a","p1"),pane("t2","b","p2")]});const before=JSON.stringify(f),result=all(f),entry=result.rows.find(r=>r.kind==="space");
 assert.equal(JSON.stringify(f),before);assert.equal(entities(result).length,2);assert(!result.rows.some(r=>r.kind==="tab"));assert.equal(entry.foldable,true);assert.equal(entry.childCount,2);assert.equal(entry.section,"pinned");assert.equal(result.rows.filter(r=>r.kind==="space").length,1);assert(result.rows.findIndex(r=>r.kind==="space")<result.rows.findIndex(r=>r.address==="t1"));assert.deepEqual(entry.newTabTarget,{space:"s1",on:null});assert(validateUnifiedTarget(entry.target,f));
 f.agents[0].pinned=false;const partial=all(f),spaceIndex=partial.rows.findIndex(r=>r.kind==="space");assert(partial.rows.findIndex(r=>r.address==="t1")>spaceIndex);assert(partial.rows.findIndex(r=>r.address==="t2")<spaceIndex);assert.equal(partial.rows.find(r=>r.kind==="space").childCount,1);
 f.agents[1].pinned=false;const restored=all(f);assert(!restored.rows.some(r=>r.title==="Pinned"));assert(entities(restored).every(r=>r.merged));assert.equal(restored.rows.find(r=>r.kind==="space").childCount,2);
});

test("a promoted agent cannot hide a tab containing another shell, a preview, or an unknown pane",()=>{
 const base=()=>fixture({as:[agent("t1","s1","tab1","p1",{pinned:true})]});
 const shell=base();shell.terminals.push(terminal("sh",{program:{name:"zsh",key:"shell",shell:true,agent:false}}));shell.panes.push(pane("sh","tab1","p2"));const mixed=all(shell);assert(mixed.rows.some(r=>r.kind==="tab"));assert.equal(entities(mixed).filter(r=>r.address==="sh").length,1);assert.equal(entities(mixed).filter(r=>r.address==="t1").length,1);
 for(const extra of [{pane:"preview",terminal:null,tab:"tab1",mod:"files-plus"},{pane:"unknown",terminal:"missing",tab:"tab1"}]){const f=base();f.panes.push(extra);assert(all(f).rows.some(r=>r.kind==="tab"));}
 const empty=base();empty.spaces[0].tabs.push(tab("empty"));const result=all(empty);assert(result.rows.some(r=>r.kind==="tab"&&r.tabId==="empty"));assert(!result.rows.some(r=>r.kind==="tab"&&r.tabId==="tab1"));assert.equal(result.rows.find(r=>r.kind==="space").childCount,1);
});

test("incomplete or conflicting promoted targets preserve their independent tab navigation",()=>{
 for(const mutate of [f=>{f.terminals[0].created_ms=undefined;},f=>{f.panes=[];},f=>{f.panes.push(pane("t1","tab1","other"));},f=>{f.terminals[0].labels={"herdr.space":"wrong","herdr.tab":"tab1"};},f=>{f.panes[0].pane=undefined;}]){
  const f=fixture({as:[agent("t1","s1","tab1","p1",{pinned:true})]});mutate(f);const result=all(f),navigation=result.rows.find(r=>r.kind==="tab");assert(navigation);assert(validateUnifiedTarget(navigation.target,f));assert.equal(entities(result).filter(r=>r.address==="t1").length,1);
 }
});

test("remote promoted tabs are omitted only for their exact qualified machine and workspace",()=>{
 const f=fixture({sp:[space("s1",[tab("tab1")]),space("box/s1",[tab("box/tab1")],{machine:"box"})],ts:[terminal("t1"),terminal("box/t1")],as:[agent("t1","s1","tab1","p1"),agent("box/t1","box/s1","box/tab1","box/p1",{pinned:true})],ps:[pane("t1","tab1","p1"),pane("box/t1","box/tab1","box/p1")]});const result=all(f);
 assert(!result.rows.some(r=>r.kind==="tab"&&r.tabId==="box/tab1"));assert(result.rows.some(r=>r.kind==="space"&&r.spaceId==="box/s1"&&r.section==="pinned"));assert(byAddress(result,"t1").merged);assert(validateUnifiedTarget(byAddress(result,"box/t1").target,f));assert.equal(entities(result).length,2);
});

test("attention promotion removes its duplicate tab and settling back to Idle restores the local task",()=>{
 const f=fixture({as:[agent("t1","s1","tab1","p1",{status:"done"})]});const done=all(f);assert(done.rows.some(r=>r.title==="Needs attention"));assert(!done.rows.some(r=>r.kind==="tab"));assert.equal(done.rows.find(r=>r.kind==="space").childCount,1);assert.equal(done.rows.find(r=>r.kind==="space").section,"attention");
 f.agents[0].status="idle";const idle=all(f);assert(!idle.rows.some(r=>r.title==="Needs attention"));assert(byAddress(idle,"t1").merged);assert(idle.rows.findIndex(r=>r.address==="t1")>idle.rows.findIndex(r=>r.kind==="space"));
});

test("whole promoted spaces and complete custom projects precede their tasks and disappear from the main tree",()=>{
 const f=fixture({sp:[space("s1",[tab("a")]),space("s2",[tab("b")])],ts:[terminal("t1"),terminal("t2")],as:[agent("t1","s1","a","p1",{pinned:true}),agent("t2","s2","b","p2",{pinned:true})],ps:[pane("t1","a","p1"),pane("t2","b","p2")]});f.groups[0].custom=true;f.groups[0].name="Suite";const before=JSON.stringify(f),result=all(f);
 assert.equal(JSON.stringify(f),before);const group=result.rows.find(r=>r.kind==="group");assert.equal(group.section,"pinned");assert.equal(group.depth,1);assert.equal(result.rows.filter(r=>r.kind==="group").length,1);assert(result.rows.filter(r=>r.kind==="space").every(r=>r.section==="pinned"&&r.depth===2));assert.equal(result.rows.find(r=>r.id==="section:pinned").count,2);assert.equal(new Set(result.rows.map(r=>r.id)).size,result.rows.length);
 f.agents[1].pinned=false;const partial=all(f);assert.equal(partial.rows.find(r=>r.kind==="group").section,null);assert.equal(partial.rows.find(r=>r.spaceId==="s1"&&r.kind==="space").section,"pinned");assert.equal(partial.rows.find(r=>r.spaceId==="s2"&&r.kind==="space").section,null);assert.equal(entities(partial).length,2);
});

test("attention and every status bucket carry a complete directory above its own tasks",()=>{
 for(const status of ["blocked","done","working","idle","unknown"]){const f=fixture({as:[agent("t1","s1","tab1","p1",{status})]});const result=all(f,{view:"status"}),spaceRow=result.rows.find(r=>r.kind==="space");assert.equal(spaceRow.section,"status-"+status);assert(result.rows.indexOf(spaceRow)<result.rows.findIndex(r=>r.address==="t1"));assert(!result.rows.some(r=>r.id==="section:navigation"));assert.equal(entities(result).length,1);}
 const mixedAttention=fixture({sp:[space("s1",[tab("a"),tab("b")])],ts:[terminal("t1"),terminal("t2")],as:[agent("t1","s1","a","p1",{status:"blocked"}),agent("t2","s1","b","p2",{status:"done"})],ps:[pane("t1","a","p1"),pane("t2","b","p2")]});assert.equal(all(mixedAttention).rows.find(r=>r.kind==="space").section,"attention");const status=all(mixedAttention,{view:"status"});assert.equal(status.rows.find(r=>r.kind==="space").section,null);assert(status.rows.some(r=>r.id==="section:navigation"));assert.equal(entities(status).length,2);
});

test("mixed bucket and cross-space parent branches retain their original directory navigation",()=>{
 const f=fixture({sp:[space("s1",[tab("a")]),space("s2",[tab("b")])],ts:[terminal("t1"),terminal("t2",{parent:"t1",created_ms:2})],as:[agent("t1","s1","a","p1",{pinned:true}),agent("t2","s2","b","p2")],ps:[pane("t1","a","p1"),pane("t2","b","p2")]});const result=all(f);assert(result.rows.filter(r=>r.kind==="space").every(r=>r.section===null));assert.equal(entities(result).length,2);assert.equal(new Set(result.rows.map(r=>r.id)).size,result.rows.length);
 const preview=fixture({as:[agent("t1","s1","tab1","p1",{pinned:true})]});preview.spaces[0].tabs.push(tab("preview"));preview.panes.push({pane:"preview-pane",tab:"preview",terminal:null,mod:"files-plus"});assert.equal(all(preview).rows.find(r=>r.kind==="space").section,null);
});

test("promoted directory search keeps only matching task paths and does not depend on the filtered subset",()=>{
 const f=fixture({sp:[space("s1",[tab("a"),tab("b")])],ts:[terminal("t1"),terminal("t2")],as:[agent("t1","s1","a","p1",{pinned:true,title:"unique needle"}),agent("t2","s1","b","p2",{pinned:true,title:"other task"})],ps:[pane("t1","a","p1"),pane("t2","b","p2")]});const result=all(f,{query:"unique needle"});assert.equal(result.rows.find(r=>r.kind==="space").section,"pinned");assert.deepEqual(entities(result).map(r=>r.address),["t1"]);assert(!result.rows.some(r=>r.kind==="tab"&&r.tabId==="b"));
 f.agents[1].pinned=false;const partial=all(f,{query:"unique needle"});assert.equal(partial.rows.find(r=>r.kind==="space").section,null);assert.equal(entities(partial).length,1);
});

test("whole-tree folding overrides saved group folds, supports manual reopen and preserves temporary search",()=>{
 const f=fixture({ts:[terminal("t1"),terminal("kid",{parent:"t1",created_ms:2,title:"unique child"})]});f.groups[0].custom=true;f.groups[0].folded=true;const before=JSON.stringify(f),open=all(f,{expandAll:true});assert(byAddress(open,"kid"));const closed=all(f,{collapseAll:true});assert.equal(closed.rows.length,1);const group=closed.rows[0],spaceRow=open.rows.find(r=>r.kind==="space"),parent=byAddress(open,"t1");
 const manual=all(f,{collapseAll:true,openOverrides:[group.id,spaceRow.id,parent.id]});assert(byAddress(manual,"kid"));assert(!byAddress(all(f,{expandAll:true,folded:[parent.id]}),"kid"));assert(byAddress(all(f,{collapseAll:true,query:"unique child"}),"kid"));assert.equal(JSON.stringify(f),before);
 const pinned=fixture({as:[agent("t1","s1","tab1","p1",{pinned:true})]});const p=all(pinned,{expandAll:true}),container=p.rows.find(r=>r.kind==="space");assert.equal(entities(all(pinned,{folded:[container.id]})).length,0);assert.equal(entities(all(pinned,{collapseAll:true})).length,0);assert.equal(entities(all(pinned,{collapseAll:true,openOverrides:["section:pinned",container.id]})).length,1);
});


function taskWithAuxiliaryShell(status="done",pinned=false) {
 const shell={name:"zsh",key:"shell",shell:true,agent:false};
 return fixture({sp:[space("s1",[tab("task"),tab("shell")],{name:"Bash",folder:"/bash"})],ts:[terminal("task"),terminal("sh",{title:"plain zsh",program:shell})],as:[agent("task","s1","task","p1",{title:"Check PDF compatibility",status,pinned})],ps:[pane("task","task","p1"),pane("sh","shell","p2",{program:shell})]});
}

test("attention and pinned directories carry auxiliary shells without changing their own state or count",()=>{
 for(const [status,pinned,bucket]of [["done",false,"attention"],["blocked",false,"attention"],["working",true,"pinned"]]){
  const f=taskWithAuxiliaryShell(status,pinned),before=JSON.stringify(f);freeze(f);const result=all(f),directory=result.rows.find(r=>r.kind==="space"),header=result.rows.find(r=>r.id==="section:"+bucket),shell=byAddress(result,"sh");
  assert.equal(directory.section,bucket);assert.equal(result.rows.filter(r=>r.kind==="space").length,1);assert(result.rows.indexOf(directory)<result.rows.findIndex(r=>r.address==="task"));assert(result.rows.indexOf(directory)<result.rows.indexOf(shell));assert.equal(header.count,1);assert.equal(header.childCount,2);assert.equal(shell.status,"unknown");assert.equal(shell.pinned,false);assert.equal(shell.agent,false);assert(!result.rows.some(r=>r.kind==="tab"));assert.equal(new Set(result.rows.map(r=>r.id)).size,result.rows.length);assert.equal(entities(result).length,2);for(const row of entities(result))assert(validateUnifiedTarget(row.target,f));assert.equal(JSON.stringify(f),before);
 }
});

test("every Status task bucket carries its auxiliary shell and suppresses a duplicate Unknown section",()=>{
 for(const status of ["blocked","done","working","idle","unknown"]){const f=taskWithAuxiliaryShell(status),result=all(f,{view:"status"}),directory=result.rows.find(r=>r.kind==="space");assert.equal(directory.section,"status-"+status);assert.equal(result.rows.filter(r=>r.kind==="section").length,1);assert.equal(byAddress(result,"sh").status,"unknown");assert.equal(entities(result).length,2);assert(!result.rows.some(r=>r.id==="section:navigation"));}
});

test("auxiliary terminals never conceal a second Agent task in a different bucket",()=>{
 for(const otherStatus of ["working","idle","unknown"]){const f=taskWithAuxiliaryShell();f.spaces[0].tabs.push(tab("other"));f.terminals.push(terminal("other"));f.agents.push(agent("other","s1","other","p3",{status:otherStatus}));f.panes.push(pane("other","other","p3"));const result=all(f);assert.equal(result.rows.find(r=>r.kind==="space").section,null);assert.equal(entities(result).length,3);assert(result.rows.findIndex(r=>r.address==="task")<result.rows.findIndex(r=>r.kind==="space"));assert(result.rows.findIndex(r=>r.address==="sh")>result.rows.findIndex(r=>r.kind==="space"));}
 const f=taskWithAuxiliaryShell("working",true);f.terminals[1].status="working";const result=all(f);assert.equal(result.rows.find(r=>r.kind==="space").section,null,"A terminal with an explicit task status is not an auxiliary shell");
});

test("a complete manual project can carry a shell-only space with its one task directory",()=>{
 const f=taskWithAuxiliaryShell();f.spaces.push(space("s2",[tab("extra-shell")],{name:"Tools",folder:"/bash"}));const shell={name:"zsh",key:"shell",shell:true,agent:false};f.terminals.push(terminal("tools",{program:shell}));f.panes.push(pane("tools","extra-shell","p3",{program:shell}));f.groups=buildGroups(f.spaces.map((w,i)=>({w,i,g:null,place:w.folder})),{});f.groups[0].custom=true;f.groups[0].name="Manual tools";const before=JSON.stringify(f);freeze(f);const result=all(f),group=result.rows.find(r=>r.kind==="group");assert.equal(group.section,"attention");assert.equal(result.rows.filter(r=>r.kind==="group").length,1);assert(result.rows.filter(r=>r.kind==="space").every(r=>r.section==="attention"));assert.equal(result.rows.find(r=>r.id==="section:attention").count,1);assert.equal(entities(result).length,3);assert.equal(new Set(result.rows.map(r=>r.id)).size,result.rows.length);assert.equal(JSON.stringify(f),before);
});

test("auxiliary-shell grouping retains unknown panes, previews, empty tabs and incomplete target navigation",()=>{
 for(const mutate of [f=>f.spaces[0].tabs.push(tab("empty")),f=>f.panes.push({pane:"preview",tab:"shell",terminal:null,mod:"files-plus"}),f=>f.panes.push({pane:"unknown",tab:"shell",terminal:"missing"}),f=>{f.terminals[1].created_ms=undefined;},f=>{f.panes[1].pane=undefined;}]){const f=taskWithAuxiliaryShell();mutate(f);const result=all(f);assert.equal(result.rows.find(r=>r.kind==="space").section,null);assert.equal(entities(result).length,2);assert(result.rows.some(r=>r.kind==="tab")||byAddress(result,"sh").merged&&validateUnifiedTarget(byAddress(result,"sh").target,f),"The shell retains either explicit tab navigation or a verified merged target");assert.equal(new Set(result.rows.map(r=>r.id)).size,result.rows.length);}
});

test("auxiliary-shell directory grouping survives filters, paging, folds and task settlement",()=>{
 const f=taskWithAuxiliaryShell(),result=all(f,{pageSize:1});assert.equal(entities(result).length,2);assert.equal(result.rows.find(r=>r.kind==="space").section,"attention");const active=all(f,{statusFilter:"active"});assert.deepEqual(entities(active).map(r=>r.address),["task"]);assert.equal(active.rows.find(r=>r.kind==="space").section,"attention");const search=all(f,{query:"plain zsh",collapseAll:true});assert.deepEqual(entities(search).map(r=>r.address),["sh"]);assert.equal(search.rows.find(r=>r.kind==="space").section,"attention");assert.equal(search.rows.find(r=>r.id==="section:attention").count,0);assert.equal(entities(all(f,{folded:["space:s1"]})).length,0);assert.equal(all(f,{collapseAll:true}).total,1);assert.equal(entities(all(f,{collapseAll:true,openOverrides:["section:attention","space:s1"]})).length,2);
 f.agents[0].status="idle";const idle=all(f);assert.equal(idle.rows.find(r=>r.kind==="space").section,null);assert(!idle.rows.some(r=>r.id==="section:attention"));assert.equal(entities(idle).length,2);f.agents[0].pinned=true;assert.equal(all(f).rows.find(r=>r.kind==="space").section,"pinned");f.agents[0].pinned=false;assert.equal(all(f).rows.find(r=>r.kind==="space").section,null);
});


test("an explicitly pinned directory contains mixed tasks, ordinary shells, preview and empty tabs once",()=>{
 const f=taskWithAuxiliaryShell();f.spaces[0].tabs.push(tab("working"),tab("preview"),tab("empty"));f.terminals.push(terminal("work"));f.agents.push(agent("work","s1","working","p3",{status:"working"}));f.panes.push(pane("work","working","p3"),{pane:"preview-pane",terminal:null,tab:"preview",mod:"files-plus"});const before=JSON.stringify(f);freeze(f);const result=all(f,{directoryPins:{spaces:["s1"]}}),directory=result.rows.find(r=>r.kind==="space");assert.equal(directory.section,"pinned");assert.equal(directory.directoryPinned,true);assert.equal(result.rows.filter(r=>r.kind==="space").length,1);assert.deepEqual(result.rows.filter(r=>r.kind==="section").map(r=>r.id),["section:pinned"]);assert(result.rows.some(r=>r.kind==="tab"&&r.tabId==="preview"));assert(result.rows.some(r=>r.kind==="tab"&&r.tabId==="empty"));assert.equal(entities(result).length,3);assert(entities(result).every(r=>!r.pinned));assert.equal(byAddress(result,"task").status,"done");assert.equal(byAddress(result,"work").status,"working");assert.equal(byAddress(result,"sh").status,"unknown");assert.equal(new Set(result.rows.map(r=>r.id)).size,result.rows.length);for(const row of result.rows.filter(r=>r.target))assert(validateUnifiedTarget(row.target,f));assert.equal(JSON.stringify(f),before);
});

test("explicitly pinned empty and preview-only directories remain selectable in both views",()=>{
 const f=fixture({sp:[space("empty",[]),space("preview",[tab("preview-tab")])],ts:[],as:[],ps:[{tab:"preview-tab",pane:"preview-pane",terminal:null,mod:"files-plus"}]});for(const view of ["project","status"]){const result=all(f,{view,directoryPins:{spaces:["empty","preview"]}});assert.equal(result.rows[0].id,"section:pinned");assert.equal(result.rows.filter(r=>r.kind==="space").length,2);assert(result.rows.filter(r=>r.kind==="space").every(r=>r.section==="pinned"&&r.directoryPinned&&validateUnifiedTarget(r.target,f)));assert(result.rows.find(r=>r.spaceId==="empty").empty);assert(result.rows.some(r=>r.kind==="tab"&&r.tabId==="preview-tab"));assert(!result.rows.some(r=>r.id==="section:navigation"));}
});

test("pinning a complete project moves all its directories regardless of contents or task states",()=>{
 const f=taskWithAuxiliaryShell();f.spaces.push(space("empty",[]),space("preview",[tab("preview-tab")]));f.panes.push({tab:"preview-tab",pane:"preview-pane",terminal:null,mod:"files-plus"});f.groups=buildGroups(f.spaces.map((w,i)=>({w,i,g:null,place:w.folder})),{});const key=f.groups[0].key;f.groups[0].rows.push(...f.groups.slice(1).flatMap(g=>g.rows));f.groups=f.groups.slice(0,1);f.groups[0].custom=true;for(const view of ["project","status"]){const result=all(f,{view,directoryPins:{groups:[key]}}),group=result.rows.find(r=>r.kind==="group");assert.equal(group.section,"pinned");assert(group.directoryPinned);assert.equal(result.rows.filter(r=>r.kind==="space").length,3);assert(result.rows.filter(r=>r.kind==="space").every(r=>r.section==="pinned"&&r.directoryInheritedPin));assert.equal(entities(result).length,2);assert.equal(new Set(result.rows.map(r=>r.id)).size,result.rows.length);}
});

test("removing an explicit directory pin restores automatic attention and keeps terminal pins intact",()=>{
 const f=taskWithAuxiliaryShell();const pinned=all(f,{directoryPins:{spaces:["s1"]}});assert.equal(pinned.rows.find(r=>r.kind==="space").section,"pinned");assert.equal(all(f,{directoryPins:{spaces:[]}}).rows.find(r=>r.kind==="space").section,"attention");f.agents[0].pinned=true;assert.equal(all(f,{directoryPins:{spaces:[]}}).rows.find(r=>r.kind==="space").section,"pinned");f.agents[0].status="working";f.agents[0].pinned=false;assert.equal(all(f,{directoryPins:{spaces:[]}}).rows.find(r=>r.kind==="space").section,null);
});

test("directory pins split cross-space display branches without weakening original parent identity checks",()=>{
 const f=fixture({sp:[space("s1",[tab("a")],{folder:"/one"}),space("s2",[tab("b")],{folder:"/two"})],ts:[terminal("parent"),terminal("child",{parent:"parent",created_ms:2})],as:[agent("parent","s1","a","p1"),agent("child","s2","b","p2")],ps:[pane("parent","a","p1"),pane("child","b","p2")]});const before=JSON.stringify(f);freeze(f);for(const ids of [["s1"],["s2"],["s1","s2"]]){const result=all(f,{directoryPins:{spaces:ids}});assert.equal(entities(result).length,2);assert.equal(new Set(result.rows.map(r=>r.id)).size,result.rows.length);for(const id of ids)assert.equal(result.rows.find(r=>r.kind==="space"&&r.spaceId===id).section,"pinned");const child=byAddress(result,"child");assert.equal(child.parentId,"parent");assert.equal(child.target.parent,"parent");assert.equal(child.target.parentCreated,1);assert(child.tooltip.includes("Parent: parent"));assert(validateUnifiedTarget(child.target,f));const replaced=structuredClone(f);replaced.terminals[0].created_ms=3;assert(!validateUnifiedTarget(child.target,replaced));}assert.equal(JSON.stringify(f),before);const restored=all(f);assert.equal(byAddress(restored,"child").depth,byAddress(restored,"parent").depth+1);
});

test("a pinned directory renders inherited parent context once and keeps incomplete targets disabled",()=>{
 const f=fixture({ts:[terminal("context"),terminal("t1",{parent:"context",created_ms:2})]});const result=all(f,{directoryPins:{spaces:["s1"]}});assert.equal(entities(result).length,2);assert.equal(new Set(result.rows.map(r=>r.id)).size,result.rows.length);assert.equal(byAddress(result,"context").target.space,null);assert.equal(byAddress(result,"t1").parentId,"context");assert.equal(result.rows.find(r=>r.kind==="space").section,"pinned");assert(validateUnifiedTarget(byAddress(result,"context").target,f));
 const broken=taskWithAuxiliaryShell();broken.terminals[0].created_ms=undefined;const b=all(broken,{directoryPins:{spaces:["s1"]}});assert.equal(b.rows.find(r=>r.kind==="space").section,"pinned");assert(b.rows.some(r=>r.kind==="tab"&&r.tabId==="task"));assert(byAddress(b,"task").target.disabled);assert.equal(entities(b).length,2);
});

test("directory pins respect qualified remote identities and preserve filtered, paged and folded navigation",()=>{
 const f=fixture({sp:[space("s1",[tab("a")],{folder:"/one"}),space("box/s1",[tab("box/a")],{folder:"/one",machine:"box"})],ts:[terminal("t1"),terminal("box/t1")],as:[agent("t1","s1","a","p1"),agent("box/t1","box/s1","box/a","box/p1")],ps:[pane("t1","a","p1"),pane("box/t1","box/a","box/p1")]});const result=all(f,{pageSize:1,directoryPins:{spaces:["box/s1"]}});assert.equal(result.rows.find(r=>r.kind==="space"&&r.spaceId==="box/s1").section,"pinned");assert.equal(result.rows.find(r=>r.kind==="space"&&r.spaceId==="s1").section,null);assert.equal(entities(result).length,2);assert(validateUnifiedTarget(byAddress(result,"box/t1").target,f));
 const b=taskWithAuxiliaryShell(),options={directoryPins:{spaces:["s1"]}};assert.equal(entities(all(b,{...options,statusFilter:"active"})).length,1);assert.deepEqual(entities(all(b,{...options,query:"plain zsh",collapseAll:true})).map(r=>r.address),["sh"]);assert.equal(all(b,{...options,collapseAll:true}).total,1);assert.equal(entities(all(b,{...options,collapseAll:true,openOverrides:["section:pinned","space:s1"]})).length,2);assert.equal(entities(all(b,{...options,folded:["space:s1"]})).length,0);
});


test("pinning every child directory carries its parent project, including empty members, while partial pinning retains it",()=>{
 const f=fixture({sp:[space("s1",[tab("a")]),space("s2",[tab("b")]),space("empty",[])],ts:[terminal("a"),terminal("b")],as:[agent("a","s1","a","p1"),agent("b","s2","b","p2",{status:"idle"})],ps:[pane("a","a","p1"),pane("b","b","p2")]});f.groups[0].custom=true;const result=all(f,{directoryPins:{spaces:["s1","s2","empty"]}}),group=result.rows.find(r=>r.kind==="group");assert.equal(group.section,"pinned");assert.equal(result.rows.filter(r=>r.kind==="group").length,1);assert(result.rows.filter(r=>r.kind==="space").every(r=>r.section==="pinned"));const partial=all(f,{directoryPins:{spaces:["s1","s2"]}});assert.equal(partial.rows.find(r=>r.kind==="group").section,null);assert.equal(partial.rows.find(r=>r.kind==="space"&&r.spaceId==="empty").section,null);
});

test("an explicitly pinned project retains its actionable heading after shrinking to one remaining space",()=>{
 const f=fixture(),key=f.groups[0].key;assert(!all(f).rows.some(r=>r.kind==="group"));for(const view of ["project","status"]){const result=all(f,{view,directoryPins:{groups:[key]}}),heading=result.rows.find(r=>r.kind==="group");assert(heading.directoryPinned);assert.equal(heading.section,"pinned");assert.equal(heading.sourceGroup.key,key);assert.equal(result.rows.filter(r=>r.kind==="group").length,1);}
});
