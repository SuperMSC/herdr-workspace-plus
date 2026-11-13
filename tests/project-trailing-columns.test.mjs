import { uiFunction } from "./helpers/ui-function.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as model from "../mods/project-spaces/model.js";

function element() {
 const node={attrs:{},events:{},childNodes:[]};const proxy=new Proxy(node,{get(target,key){if(key==="child")return value=>{target.childNodes.push(value);return proxy;};if(key==="children")return values=>{target.childNodes.push(...values);return proxy;};if(key==="when")return(condition,fn)=>condition?fn(proxy):proxy;if(String(key).startsWith("on_"))return(...args)=>{target.events[key]=args.at(-1);return proxy;};if(key in target)return target[key];return value=>{target.attrs[key]=value;return proxy;};}});return proxy;
}
const nodes=node=>!node||typeof node!=="object"?[]:[node,...node.childNodes.flatMap(nodes)];
const strings=node=>!node||typeof node!=="object"?typeof node==="string"?[node]:[]:node.childNodes.flatMap(strings);
function fixture() {
 const calls=[],state=model.normalizeState({mode:"project"}),w={id:"s1",name:"Workspace",folder:"/work/repo/checkout",machine:null,active:false,status:"blocked",tabs:[]},g={name:"repo",repo:JSON.stringify([null,"/work/repo/.git"]),branch:"feature/a-very-long-branch-name",ahead:12,behind:3,linked:true};
 const group=model.buildGroups([{w,i:0,place:w.folder,g}],state)[0];group.custom=true;group.fullCount=1234;
 const deps={...model,View:class{},div:element,svg:element,h_flex:element,v_flex:element,shared:()=>({}),spaces:()=>[w],run:(...args)=>calls.push(args)},source=readFileSync(new URL("../mods/project-spaces/main.js",import.meta.url),"utf8").replace(/^import[\s\S]*?;\n/gm,"").replace("export default class","return class"),Main=uiFunction(...Object.keys(deps),source)(...Object.values(deps)),view=new Main();view.home="/Users/demo";view.lastGroups=[group];
 const t={dim:"dim",muted:"muted",foreground:"foreground",hover:"hover",selected:"selected",accent:"accent",border:"border",blocked:"blocked",ansi1:"behind",ansi2:"ahead"};return{view,group,row:group.rows[0],state,t,calls};
}
function dock(node,id,summaryWidth=0) {
 const found=nodes(node).find(item=>item.attrs.id==="sidebar-dock-"+id),width=19+(summaryWidth?3+summaryWidth:0);assert(found);assert.equal(found.attrs.w,width);assert.equal(found.attrs.min_w,width);assert.equal(found.attrs.gap,3);assert(Object.hasOwn(found.attrs,"items_center"));const[pin,summary]=found.childNodes;assert.equal(pin.attrs.size,19);if(summaryWidth){assert.equal(summary.attrs.w,summaryWidth);assert.equal(summary.attrs.h,19);assert(Object.hasOwn(summary.attrs,"justify_end"));assert(Object.hasOwn(summary.attrs,"overflow_hidden"));}else assert.equal(summary,undefined);return{found,pin,summary};
}

test("tree directories use a compact pin slot while branch and path share the secondary line",()=>{
 assert.deepEqual(model.SIDEBAR_COLUMNS,{pin:19,gap:3,summary:56,width:78,inset:5});
 const f=fixture();for(const density of ["detailed","compact"]){let clicked=0;const pin=element().id("fixture-pin").on_click(()=>{clicked++;});const group=f.view.groupHead(f.group,f.state,f.t,0,density,true,pin),space=f.view.row(f.row,f.group,f.state,f.t,density,true,pin),groupDock=dock(group,"group-0",19),spaceDock=dock(space,"space-s1");
  assert.equal(group.attrs.pr,5);assert.equal(space.attrs.pr,0);assert.equal(group.attrs.h,density==="detailed"?40:28);assert.equal(space.attrs.h,density==="detailed"?38:28);assert.equal(groupDock.pin.childNodes[0],pin);assert.equal(spaceDock.pin.childNodes[0],pin);groupDock.pin.childNodes[0].events.on_click();assert.equal(clicked,1);assert.equal(groupDock.summary.attrs.tooltip,"1/1234 spaces");assert(space.attrs.tooltip.includes(f.row.g.branch));assert(space.attrs.tooltip.includes("Ahead: 12"));assert(space.attrs.tooltip.includes("Behind: 3"));const details=nodes(space).find(n=>n.attrs.id==="sidebar-details-space-s1");if(density==="detailed"){assert(details);assert(strings(details).includes(f.row.g.branch));assert(strings(details).includes("↑12"));assert(strings(details).includes("↓3"));}else assert(!details);
  const titleX=group.attrs.pl+group.childNodes[0].attrs.w+group.attrs.gap+group.childNodes[1].attrs.size+group.childNodes[1].attrs.mr+group.attrs.gap;assert.equal(titleX,53);assert.equal(space.childNodes[0].attrs.w+space.childNodes[0].attrs.mr+space.attrs.gap,26);
  const empty=dock(f.view.row(f.row,f.group,f.state,f.t,density,true),"space-s1");assert.equal(empty.pin.childNodes.length,0);assert.equal(empty.found.attrs.w,spaceDock.found.attrs.w);
 }
});

test("tree group hover keeps its new-space action inside the fixed summary column and legacy rows retain their original geometry",()=>{
 const f=fixture();f.group.folded=true;f.view.hover=f.group.key;f.view.drag={kind:"space",id:"s1"};f.view.over={kind:"group",id:f.group.key};const header=f.view.groupHead(f.group,f.state,f.t,0,"detailed",true),trailing=dock(header,"group-0",19),buttons=nodes(header).filter(node=>node.attrs.id==="group-new-0");assert.equal(buttons.length,1);assert.equal(buttons[0].attrs.size,19);assert(nodes(trailing.summary).includes(buttons[0]));assert.equal(trailing.summary.childNodes[0].childNodes.length,1);assert(nodes(header).some(n=>n.attrs.size===5&&n.attrs.bg==="blocked"));let stopped=0;const cx={stop_propagation(){stopped++;}};buttons[0].events.on_mouse_down({},cx);buttons[0].events.on_mouse_up({},cx);buttons[0].events.on_click({},cx);assert.equal(stopped,3);assert.equal(f.view.drag,null);assert.equal(f.view.over,null);assert.deepEqual(f.calls,[["space.new",{folder:f.group.folder,machine:""}]]);
 for(const density of ["detailed","compact"]){const group=f.view.groupHead(f.group,f.state,f.t,0,density),space=f.view.row(f.row,f.group,f.state,f.t,density);assert(!nodes(group).some(node=>String(node.attrs.id||"").startsWith("sidebar-dock-")));assert(!nodes(space).some(node=>String(node.attrs.id||"").startsWith("sidebar-dock-")));assert.equal(group.attrs.pr,4);assert.equal(space.attrs.pr,8);assert.equal(group.attrs.h,density==="detailed"?46:30);assert.equal(space.attrs.h,density==="detailed"?46:28);assert(strings(space.childNodes[1]).includes("↑12"));assert(strings(space.childNodes[1]).includes("↓3"));}
});


test("directory activity uses a theme status color with an explanatory tooltip and hides Idle",()=>{
 const f=fixture(),row={...f.row,g:null};for(const nested of [false,true]){const group={...f.group,name:row.w.name,custom:nested,manual:0,fullCount:nested?1234:1,rows:[row]},space=f.view.row(row,group,f.state,f.t,"detailed",true);dock(space,"space-s1");const status=nodes(space.childNodes[1]).find(n=>n.attrs.size===5&&n.attrs.bg==="blocked");assert(status);assert(Object.hasOwn(status.attrs,"flex_none"));assert.equal(status.attrs.tooltip,"Directory activity: Needs you");const idle=f.view.row({...row,w:{...row.w,status:'idle'}},group,f.state,f.t,'detailed',true);assert(!nodes(idle).some(n=>n.attrs.size===5));}
});

test("default branches leave only the project-relative path while feature branches retain branch and full tooltip",()=>{
 const f=fixture();
 for(const branch of ['main','master','feature-x']){
  const row={...f.row,g:{...f.row.g,branch}},tree=f.view.row(row,f.group,f.state,f.t,'detailed',true),details=nodes(tree).find(node=>node.attrs.id==='sidebar-details-space-s1'),content=strings(details);
  assert(content.includes('checkout'));assert(tree.attrs.tooltip.includes('/work/repo/checkout'));assert(tree.attrs.tooltip.includes(branch));
  assert.equal(content.includes(branch),branch==='feature-x');assert.equal(content.includes('·'),branch==='feature-x');assert.equal(nodes(details).some(node=>node.attrs.size===10),branch==='feature-x');
 }
 const root={...f.row,place:'/work/repo',w:{...f.row.w,folder:'/work/repo'},g:{...f.row.g,branch:'main'}},flat=f.view.row(root,f.group,f.state,f.t,'detailed',true);assert.equal(flat.attrs.h,28);assert(!nodes(flat).some(node=>node.attrs.id==='sidebar-details-space-s1'));
});

test("project letter tiles use theme ANSI ink over a 20 percent tint in light and dark themes",()=>{
 const f=fixture();
 for(const ink of ['#4275be','#8ab4f8']){
  const t={...f.t,ansi4:ink},group={...f.group,color:'ansi4'},head=f.view.groupHead(group,f.state,t,0,'detailed',true),tile=nodes(head).find(node=>node.attrs.size===18&&node.childNodes.includes('R'));
  assert(tile);assert.equal(tile.attrs.text_color,ink);assert.equal(tile.attrs.bg,ink+'33');
 }
});

test("unified task trailing columns reserve status width only for visible states and keep the pin slot stable on hover",()=>{
 const t={dim:'#777777',foreground:'#eeeeee',hover:'#444444',selected:'#222255',accent:'#55bbff',working:'#33aa77',blocked:'#ddaa44',done:'#66bbcc',unknown:'#9977bb'};
 const deps={...model,div:element,svg:element,image:element,h_flex:element,v_flex:element,theme:()=>t},source=readFileSync(new URL('../mods/project-spaces/unified.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export default class','return class'),Unified=uiFunction(...Object.keys(deps),source)(...Object.values(deps)),view=new Unified();
 const row={id:'agent:t1',kind:'agent',agent:true,title:'herdr.app 最新版本与 agent 工作区',program:{name:'Codex',agent:true},metadata:'',target:{kind:'agent',address:'t1'}},cx={notify(){},stop_propagation(){}};
 const draw=(status,density,overrides={})=>view.entityRow({...row,status,branchStatus:status,...overrides},0,{density},cx),find=(tree,prefix)=>nodes(tree).find(node=>node.attrs.id===prefix+row.id);
 for(const density of ['detailed','compact'])for(const status of ['idle',null,'working','blocked','done','unknown']){
  view.hovered=null;const before=draw(status,density),actions=find(before,'unified-actions-'),pin=find(before,'unified-agent-pin-slot-'),slot=find(before,'unified-status-slot-'),statusWidth=['working','blocked','done','unknown'].includes(status)?density==='detailed'?72:13:0;
  assert.equal(actions.attrs.w,19+(statusWidth?3+statusWidth:0));assert.equal(slot?.attrs.w||0,statusWidth);assert.equal(actions.childNodes.length,statusWidth?2:1);assert.equal(pin.attrs.size,19);assert.equal(pin.childNodes.length,0);
  before.events.on_hover(true,cx);const hovered=draw(status,density);assert.equal(find(hovered,'unified-actions-').attrs.w,actions.attrs.w);assert.equal(find(hovered,'unified-agent-pin-slot-').attrs.size,19);assert.equal(find(hovered,'unified-agent-pin-slot-').childNodes.length,1);
  hovered.events.on_hover(false,cx);const after=draw(status,density);assert.equal(find(after,'unified-actions-').attrs.w,actions.attrs.w);assert.equal(find(after,'unified-agent-pin-slot-').childNodes.length,0);
 }
 for(const density of ['detailed','compact']){
  const shell=draw('unknown',density,{kind:'terminal',agent:false,program:{name:'zsh',shell:true,agent:false},target:{kind:'terminal',address:'t1'}});assert.equal(find(shell,'unified-status-slot-').attrs.w,density==='detailed'?72:13);assert(find(shell,'unified-status-'));if(density==='detailed')assert(strings(find(shell,'unified-status-')).includes('Unknown'));
 }
});
