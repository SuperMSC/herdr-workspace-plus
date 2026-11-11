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
 const deps={...model,View:class{},div:element,svg:element,h_flex:element,v_flex:element,shared:()=>({}),spaces:()=>[w],run:(...args)=>calls.push(args)},source=readFileSync(new URL("../mods/project-spaces/main.js",import.meta.url),"utf8").replace(/^import[\s\S]*?;\n/gm,"").replace("export default class","return class"),Main=new Function(...Object.keys(deps),source)(...Object.values(deps)),view=new Main();view.home="/Users/demo";view.lastGroups=[group];
 const t={dim:"dim",muted:"muted",foreground:"foreground",hover:"hover",selected:"selected",accent:"accent",border:"border",blocked:"blocked",ansi1:"behind",ansi2:"ahead"};return{view,group,row:group.rows[0],state,t,calls};
}
function dock(node,id) {
 const found=nodes(node).find(item=>item.attrs.id==="sidebar-dock-"+id);assert(found);assert.equal(found.attrs.w,78);assert.equal(found.attrs.min_w,78);assert.equal(found.attrs.gap,3);assert(Object.hasOwn(found.attrs,"items_center"));const[pin,summary]=found.childNodes;assert.equal(pin.attrs.size,19);assert.equal(summary.attrs.w,56);assert.equal(summary.attrs.h,19);assert(Object.hasOwn(summary.attrs,"justify_end"));assert(Object.hasOwn(summary.attrs,"overflow_hidden"));return{found,pin,summary};
}

test("tree project and directory rows reserve the same pin and summary columns without changing their title grid",()=>{
 assert.deepEqual(model.SIDEBAR_COLUMNS,{pin:19,gap:3,summary:56,width:78,inset:5});
 const f=fixture();for(const density of ["detailed","compact"]){let clicked=0;const pin=element().id("fixture-pin").on_click(()=>{clicked++;});const group=f.view.groupHead(f.group,f.state,f.t,0,density,true,pin),space=f.view.row(f.row,f.group,f.state,f.t,density,true,pin),groupDock=dock(group,"group-0"),spaceDock=dock(space,"space-s1");
  assert.equal(group.attrs.pr,5);assert.equal(space.attrs.pr,0);assert.equal(group.attrs.h,density==="detailed"?40:28);assert.equal(space.attrs.h,density==="detailed"?38:28);assert.equal(groupDock.pin.childNodes[0],pin);assert.equal(spaceDock.pin.childNodes[0],pin);groupDock.pin.childNodes[0].events.on_click();assert.equal(clicked,1);assert.equal(groupDock.summary.attrs.tooltip,"1/1234 spaces");assert(spaceDock.summary.attrs.tooltip.includes(f.row.g.branch));assert(spaceDock.summary.attrs.tooltip.includes("Ahead: 12"));assert(spaceDock.summary.attrs.tooltip.includes("Behind: 3"));const summaryText=strings(spaceDock.summary);assert(summaryText.includes("↑12"));assert(summaryText.includes("↓3"));assert(!strings(space.childNodes[1]).includes(f.row.g.branch));
  const titleX=group.attrs.pl+group.childNodes[0].attrs.w+group.attrs.gap+group.childNodes[1].attrs.size+group.childNodes[1].attrs.mr+group.attrs.gap;assert.equal(titleX,53);assert.equal(space.childNodes[0].attrs.w+space.childNodes[0].attrs.mr+space.attrs.gap,26);
  const empty=dock(f.view.row(f.row,f.group,f.state,f.t,density,true),"space-s1");assert.equal(empty.pin.childNodes.length,0);assert.equal(empty.found.attrs.w,spaceDock.found.attrs.w);
 }
});

test("tree group hover keeps its new-space action inside the fixed summary column and legacy rows retain their original geometry",()=>{
 const f=fixture();f.view.hover=f.group.key;f.view.drag={kind:"space",id:"s1"};f.view.over={kind:"group",id:f.group.key};const header=f.view.groupHead(f.group,f.state,f.t,0,"detailed",true),trailing=dock(header,"group-0"),buttons=nodes(header).filter(node=>node.attrs.id==="group-new-0");assert.equal(buttons.length,1);assert.equal(buttons[0].attrs.size,19);assert(nodes(trailing.summary).includes(buttons[0]));let stopped=0;const cx={stop_propagation(){stopped++;}};buttons[0].events.on_mouse_down({},cx);buttons[0].events.on_mouse_up({},cx);buttons[0].events.on_click({},cx);assert.equal(stopped,3);assert.equal(f.view.drag,null);assert.equal(f.view.over,null);assert.deepEqual(f.calls,[["space.new",{folder:f.group.folder,machine:""}]]);
 for(const density of ["detailed","compact"]){const group=f.view.groupHead(f.group,f.state,f.t,0,density),space=f.view.row(f.row,f.group,f.state,f.t,density);assert(!nodes(group).some(node=>String(node.attrs.id||"").startsWith("sidebar-dock-")));assert(!nodes(space).some(node=>String(node.attrs.id||"").startsWith("sidebar-dock-")));assert.equal(group.attrs.pr,4);assert.equal(space.attrs.pr,8);assert.equal(group.attrs.h,density==="detailed"?46:30);assert.equal(space.attrs.h,density==="detailed"?46:28);assert(strings(space.childNodes[1]).includes("↑12"));assert(strings(space.childNodes[1]).includes("↓3"));}
});


test("a tree directory with only a status dot keeps that dot at the summary right edge",()=>{
 const f=fixture(),row={...f.row,g:null};for(const nested of [false,true]){const group={...f.group,name:row.w.name,custom:nested,manual:0,fullCount:nested?1234:1,rows:[row]},space=f.view.row(row,group,f.state,f.t,"detailed",true),summary=dock(space,"space-s1").summary,content=summary.childNodes[0];assert(Object.hasOwn(content.attrs,"justify_end"));assert.equal(content.childNodes.length,1,"No empty flex child may occupy space after the dot");assert.equal(content.childNodes[0].attrs.size,6);assert.equal(content.childNodes[0].attrs.bg,"blocked");assert(Object.hasOwn(content.childNodes[0].attrs,"flex_none"));assert(!strings(summary).length);}
});
