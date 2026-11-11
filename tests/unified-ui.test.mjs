import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as projectModel from "../mods/project-spaces/model.js";
import { buildGroups, DENSITY_KEY, normalizeState } from "../mods/project-spaces/model.js";
import { DIRECTORY_PINS_KEY, normalizeDirectoryPins } from "../mods/project-spaces/directory-pins.js";
import { unifiedRows, validateUnifiedTarget } from "../mods/project-spaces/unified-model.js";
const program={key:"codex",name:"Codex",agent:true,shell:false,icon:null};
function fixture(on=null){
 const q=id=>on?`${on}/${id}`:id,space={id:q('s1'),machine:on,name:'Workspace',folder:'/work/app',active:true,status:'working',tabs:[{id:q('b1'),name:'Task',named:false,active:true},{id:q('b2'),name:'Shell',named:true,active:false}]};
 const terminal={address:q('t1'),created_ms:10,state:'live',pid:100,argv:['codex'],cwd:'/work/app',parent:null,name:'Agent',title:'重构模块并补充关键功能测试直到全部通过验收',program,labels:{'herdr.space':'s1','herdr.tab':'b1'}};
 const child={...terminal,address:q('t2'),created_ms:20,pid:200,name:'Worker',title:'检查边界行为并处理子任务',parent:q('t1'),labels:{}};
 const shell={...terminal,address:q('t3'),created_ms:30,pid:300,argv:['zsh'],title:'Shell',name:'Shell',program:{key:'zsh',name:'zsh',shell:true,agent:false},labels:{'herdr.space':'s1','herdr.tab':'b2'}};
 const agent={address:q('t1'),pane:q('p1'),space:space.id,tab:q('b1'),space_name:'Workspace',tab_name:'Task',title:terminal.title,status:'working',pinned:false,focused:false,seq:1,program};
 const panes=[{pane:q('p1'),terminal:terminal.address,tab:q('b1'),cwd:terminal.cwd,title:terminal.title,focused:false,branch:'main'},{pane:q('p3'),terminal:shell.address,tab:q('b2'),cwd:shell.cwd,title:'Shell',focused:false}];
 const snapshots={spaces:[space],agents:[agent],terminals:[terminal,child,shell],panes,focus:{space:space.id,tab:q('b1'),pane:q('p1'),terminal:terminal.address}};
 const groups=buildGroups([{w:space,i:0,g:null,place:space.folder}],normalizeState({mode:'project'}));
 return{snapshots,groups,terminal,child,agent,space};
}
function element(){const node={attrs:{},events:{},childNodes:[]};const proxy=new Proxy(node,{get(object,key){if(key==='child')return value=>{object.childNodes.push(value);return proxy;};if(key==='children')return values=>{object.childNodes.push(...values);return proxy;};if(key==='when')return (value,callback)=>value?callback(proxy):proxy;if(String(key).startsWith('on_'))return (...args)=>{object.events[key]=args.at(-1);return proxy;};if(key in object)return object[key];return value=>{object.attrs[key]=value;return proxy;};}});return proxy;}
const flow=node=>node.childNodes.filter(child=>!child||typeof child!=='object'||!Object.hasOwn(child.attrs,'absolute'));
const nodes=node=>!node||typeof node!=='object'?[]:[node,...node.childNodes.flatMap(nodes)];
const source=readFileSync(new URL('../mods/project-spaces/unified.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export default class','return class');
function harness({on=null}={}){
 const f=fixture(on),calls=[],orders=[],storage=new Map(),notifications=[],timers=[];let rendering=false,modelCalls=0,clock=100000,state=normalizeState({mode:'project'});
 const cx={timer:{after(ms,callback){assert(ms>=0);timers.push({at:clock+ms,callback});}},focus_handle:()=>({release(){}}),notify(){assert(!rendering,'render must not notify');notifications.push(1);},stop_propagation(){}};
 class FixtureDate extends Date { static now(){return clock;} }
 const flush=()=>{for(let round=0;round<20;round++){const index=timers.findIndex(timer=>timer.at<=clock);if(index<0)return;timers.splice(index,1)[0].callback(cx);}throw new Error("Fixture timer loop");};
 const deps={Date:FixtureDate,div:element,svg:element,image:element,h_flex:element,v_flex:element,Input:{new:element},DENSITY_KEY,DIRECTORY_PINS_KEY,normalizeDirectoryPins,
  agents:()=>f.snapshots.agents,terminals:()=>f.snapshots.terminals,spaces:()=>f.snapshots.spaces,panes:()=>f.snapshots.panes,focused:()=>f.snapshots.focus,theme:()=>({working:'#147',dim:'#777',idle:'#666',raised:'#111',selected:'#225',border:'#333',hover:'#444',accent:'#5bf',background:'#050',muted:'#888',foreground:'#eee'}),shared:key=>storage.get(key),setShared(key,value){assert(!rendering);storage.set(key,value);},run(...args){assert(!rendering);calls.push(args);},setAgentOrder:value=>orders.push(value),validateUnifiedTarget,
  unifiedRows:input=>{modelCalls++;return unifiedRows(input);}};
 const Class=new Function(...Object.keys(deps),source)(...Object.values(deps)),view=new Class();view.init({},cx);
 const owner={lastGroups:f.groups,lastRows:f.groups.flatMap(group=>group.rows),queryInput:{},projectFilter:'all',drag:null,state:()=>state,save(value){assert(!rendering);state=value;},viewMenu(){calls.push(['menu']);},spaceMenu(row){calls.push(['space-menu',row.w.id]);},groupMenu(group){calls.push(['group-menu',group.key]);},groupHead(group){return element().id('owner-group-'+group.key).child(group.name);},row(row){return element().id('owner-space-'+row.w.id).child(row.w.name);}};
 const frame=()=>({state,density:storage.get(DENSITY_KEY)||'detailed',query:owner.queryText||'',filter:owner.projectFilter,collapsed:false,groups:f.groups,fullGroups:f.groups,snapshots:f.snapshots});
 return{...f,view,owner,cx,calls,orders,storage,notifications,frame,modelCalls:()=>modelCalls,advance(ms){clock+=ms;flush();},render(patch={},elapsed=200){clock+=elapsed;const current={...frame(),...patch};let tree;for(let round=0;round<4;round++){rendering=true;try{tree=view.render(current,owner,cx);}finally{rendering=false;}if(!timers.some(timer=>timer.at<=clock))break;flush();}return tree;},click(id,patch={}){const item=nodes(this.render(patch)).find(node=>node.attrs.id===id);assert(item,`missing ${id}`);item.events.on_click({},cx);}};
}
test('unified UI shares search/view/density controls and caches model work without side effects during render',()=>{
 const f=harness();f.render();f.render();assert.equal(f.modelCalls(),1);assert.equal(f.calls.length,0);assert(f.orders[0].includes('t1'));
 f.click('unified-density');assert.equal(f.storage.get(DENSITY_KEY),'compact');f.click('unified-view-status');assert.equal(f.owner.state().mode,'status');
 f.click('unified-view-project');f.click('unified-filter-attention');assert.equal(f.owner.projectFilter,'attention');assert.equal(f.calls.length,0);
 f.click('unified-new-space');assert.deepEqual(f.calls,[['space.new']]);
});
test('agent navigation and pin revalidate exact live identity, ownership and remote machine',()=>{
 const f=harness({on:'server'});f.render();const row=f.view.result.rows.find(row=>row.address==='server/t1');assert(row);
 f.view.navigate(row,f.cx);assert.deepEqual(f.calls[0],['pane.focus',{terminal:'server/t1'}]);
 f.agent.pinned=true;f.view.pin(row,f.cx);assert.deepEqual(f.calls[1],['terminal.pin',{terminal:'server/t1',pinned:false}]);
 f.terminal.created_ms=999;f.view.navigate(row,f.cx);f.view.pin(row,f.cx);assert.equal(f.calls.length,2);assert.match(f.view.error,/changed/);
});
test('explicit child nodes without panes peek, and changed parent identity blocks stale actions',()=>{
 const f=harness();f.render();const row=f.view.result.rows.find(row=>row.address==='t2');assert(row);
 f.view.navigate(row,f.cx);assert.deepEqual(f.calls[0],['terminal.peek',{terminal:'t2'}]);
 f.child.parent='t3';f.view.navigate(row,f.cx);assert.equal(f.calls.length,1);assert.match(f.view.error,/changed/);
});
test('Detailed tasks use two lines and full bounded tooltip, Compact stays single-line and pin appears on hover',()=>{
 const f=harness();const tree=f.render(),row=f.view.result.rows.find(row=>row.address==='t1'),task=nodes(tree).find(node=>node.attrs.id===`unified-task-${row.id}`);
 assert(!Object.hasOwn(task.attrs,"h"));assert.equal(task.attrs.max_h,32);assert.equal(task.attrs.line_height,"16px");assert(!Object.hasOwn(task.attrs,'truncate'));
 assert(!nodes(tree).some(node=>node.attrs.id===`unified-pin-${row.id}`));
 const entity=nodes(tree).find(node=>node.attrs.id===`unified-entity-${row.id}`);entity.events.on_hover(true,f.cx);
 assert(nodes(f.render()).some(node=>node.attrs.id===`unified-pin-${row.id}`));
 const compact=f.render({density:'compact'}),compactTask=nodes(compact).find(node=>node.attrs.id===`unified-task-${row.id}`),compactEntity=nodes(compact).find(node=>node.attrs.id===`unified-entity-${row.id}`);
 assert.equal(compactEntity.attrs.h,32);assert(Object.hasOwn(compactTask.attrs,'truncate'));assert(!Object.hasOwn(compactTask.attrs,'h'));
});
test('done stays in its status branch while focused until the user leaves, with no cross-incarnation hold',()=>{
 const f=harness();f.agent.status='done';f.agent.focused=true;f.render({state:{...f.owner.state(),mode:'status'}});
 f.agent.status='idle';f.render({state:{...f.owner.state(),mode:'status'}});assert.equal(f.view.result.rows.find(row=>row.address==='t1').status,'done');
 f.agent.focused=false;f.render({state:{...f.owner.state(),mode:'status'}});assert.equal(f.view.result.rows.find(row=>row.address==='t1').status,'idle');
 f.agent.status='done';f.agent.focused=true;f.render();f.agent.status='idle';f.terminal.created_ms=1000;f.render();assert.equal(f.view.result.rows.find(row=>row.address==='t1').status,'idle');
});
test('project source rows retain owner drawing while Status uses navigation and paged child folding',()=>{
 const f=harness();f.groups[0].custom=true;const tree=f.render();assert(nodes(tree).some(node=>String(node.attrs.id||'').startsWith('owner-group-')));assert(nodes(tree).some(node=>String(node.attrs.id||'').startsWith('owner-space-')));
 const row=f.view.result.rows.find(row=>row.address==='t1');f.view.fold(row,f.cx);f.render();assert(!f.view.result.rows.some(row=>row.address==='t2'));
 f.view.fold(f.view.result.rows.find(row=>row.address==='t1'),f.cx);f.render();assert(f.view.result.rows.some(row=>row.address==='t2'));
 const status=f.render({state:{...f.owner.state(),mode:'status'}});assert(!nodes(status).some(node=>String(node.attrs.id||'').startsWith('owner-space-')));
});


test('cache follows child raw pin, ownership labels, display program metadata and new empty workspaces',()=>{
 const f=harness();f.render();const initial=f.modelCalls();
 f.child.labels['herdr.pinned']='true';f.render();assert.equal(f.modelCalls(),initial+1);assert.equal(f.view.result.counts.pinned,1);
 const row=f.view.result.rows.find(row=>row.address==='t2');f.view.pin(row,f.cx);assert.deepEqual(f.calls.at(-1),['terminal.pin',{terminal:'t2',pinned:false}]);
 f.agent.program={...f.agent.program,name:'Renamed display program'};f.render();assert(f.view.result.rows.find(row=>row.address==='t1').metadata.includes('Renamed display program'));
 f.child.labels['herdr.space']='missing-space';f.child.labels['herdr.tab']='b1';f.render();assert(f.view.result.rows.find(row=>row.address==='t2').target.disabled);
 f.snapshots.spaces.push({id:'new-empty',machine:null,name:'New empty workspace',folder:'/new-empty',active:false,tabs:[]});f.render();assert(f.view.result.rows.some(row=>row.target?.space==='new-empty'));
});


test('partial Git-wait source rows use readonly navigation instead of production main drag/menu methods',()=>{
 const mainSource=readFileSync(new URL('../mods/project-spaces/main.js',import.meta.url),'utf8').replace(/^import[\s\S]*?;\n/gm,'').replace('export default class','return class');
 const Main=new Function('View',mainSource)(class{}),f=harness();let groupCalls=0,rowCalls=0;
 Object.setPrototypeOf(f.owner,Main.prototype);f.owner.groupHead=function(...args){groupCalls++;return Main.prototype.groupHead.apply(this,args);};f.owner.row=function(...args){rowCalls++;return Main.prototype.row.apply(this,args);};
 f.groups=[];f.owner.lastGroups=[];f.owner.lastRows=[];const tree=f.render();
 assert.equal(groupCalls,0);assert.equal(rowCalls,0);
 const row=f.view.result.rows.find(row=>row.kind==='space'),element=nodes(tree).find(node=>node.attrs.id===`unified-entity-${row.id}`);assert(element);
 assert(!element.events.on_mouse_down);assert(!element.events.on_mouse_move);assert(!element.events.on_mouse_up);
 element.events.on_click({},f.cx);assert.deepEqual(f.calls.at(-1),['space.select',{id:'s1'}]);
});


test('clicking Done retains its branch when the native focus update immediately reports Idle',()=>{
 const f=harness();f.agent.status='done';f.render({state:{...f.owner.state(),mode:'status'}});const row=f.view.result.rows.find(row=>row.address==='t1');
 f.view.navigate(row,f.cx);f.agent.status='idle';f.agent.focused=true;f.render({state:{...f.owner.state(),mode:'status'}});assert.equal(f.view.result.rows.find(row=>row.address==='t1').status,'done');
 f.agent.focused=false;f.render({state:{...f.owner.state(),mode:'status'}});assert.equal(f.view.result.rows.find(row=>row.address==='t1').status,'idle');
});


test('a single snapshot event inside the throttle window schedules a future projection without another redraw',()=>{
 const f=harness();f.render();f.advance(150);assert.equal(f.view.pending,false);const before=f.modelCalls();
 f.agent.title='Only event inside cooldown';f.render({},0);assert.equal(f.modelCalls(),before);assert.equal(f.view.pending,true);
 f.advance(149);assert.equal(f.modelCalls(),before);f.advance(1);assert.equal(f.modelCalls(),before+1);
 assert.equal(f.view.result.rows.find(row=>row.address==='t1').taskTitle,'Only event inside cooldown');assert.equal(f.view.pending,false);
});


test('the shared sidebar has one unambiguous density toggle',()=>{
 const f=harness(),tree=f.render(),controls=nodes(tree).filter(node=>node.attrs.id==='unified-density');
 assert.equal(controls.length,1);controls[0].events.on_click({},f.cx);assert.equal(f.storage.get(DENSITY_KEY),'compact');
});


test('canonical project, space and merged-agent title columns advance on the same 20px tree grid',()=>{
 const mainSource=readFileSync(new URL('../mods/project-spaces/main.js',import.meta.url),'utf8').replace(/^import[\s\S]*?;\n/gm,'').replace('export default class','return class');
 const deps={...projectModel,View:class{},div:element,svg:element,h_flex:element,v_flex:element,shared:()=>({})};
 const Main=new Function(...Object.keys(deps),mainSource)(...Object.values(deps)),f=harness();
 const extra={id:'s2',machine:null,name:'GPipline',folder:'/work/gpipline',active:false,tabs:[]};f.snapshots.spaces.push(extra);
 const other=buildGroups([{w:extra,i:1,g:null,place:extra.folder}],normalizeState({mode:'project'}))[0].rows[0];
 f.groups[0].name='OrbStack';f.groups[0].custom=true;f.groups[0].rows.push(other);f.owner.lastGroups=f.groups;f.owner.lastRows=f.groups.flatMap(group=>group.rows);f.owner.home='/Users/demo';
 Object.setPrototypeOf(f.owner,Main.prototype);delete f.owner.row;delete f.owner.groupHead;const tree=f.render(),all=nodes(tree);
 const group=f.view.result.rows.find(row=>row.kind==='group'),space=f.view.result.rows.find(row=>row.kind==='space'&&row.spaceId==='s1'),agent=f.view.result.rows.find(row=>row.address==='t1');
 assert.equal(group.depth,0);assert.equal(space.depth,1);assert.equal(agent.depth,2);
 const groupWrap=all.find(node=>node.attrs.id===`unified-group-${group.id}`),head=nodes(groupWrap).find(node=>String(node.attrs.id||'').startsWith('group-'));
 const groupX=groupWrap.attrs.pl+head.attrs.pl+head.childNodes[0].attrs.w+head.attrs.gap+(head.childNodes[1].attrs.w||head.childNodes[1].attrs.size)+(head.childNodes[1].attrs.mr||0)+head.attrs.gap;
 const spaceWrap=all.find(node=>node.attrs.id===`unified-space-${space.id}`),nativeSpace=nodes(spaceWrap).find(node=>node.attrs.id==='space-s1');
 const spaceX=spaceWrap.attrs.pl+flow(spaceWrap)[0].attrs.w+spaceWrap.attrs.gap+nativeSpace.attrs.pl+nativeSpace.childNodes[0].attrs.w+(nativeSpace.childNodes[0].attrs.mr||0)+nativeSpace.attrs.gap;
 const task=all.find(node=>node.attrs.id===`unified-entity-${agent.id}`),taskX=task.attrs.pl+flow(task)[0].attrs.w+task.attrs.gap+flow(task)[1].attrs.w+(flow(task)[1].attrs.mr||0)+task.attrs.gap;
 assert.deepEqual([groupX,spaceX,taskX],[53,73,93]);assert.equal(spaceX-groupX,20);assert.equal(taskX-spaceX,20);
 assert.equal(nativeSpace.attrs.h,42);assert.equal(flow(spaceWrap)[0].attrs.h,18);assert.equal(flow(spaceWrap)[0].attrs.mt,5);const compactTree=f.render({density:'compact'}),compact=nodes(compactTree).find(node=>node.attrs.id==='space-s1'),compactWrap=nodes(compactTree).find(node=>node.attrs.id===`unified-space-${space.id}`);assert.equal(compact.attrs.h,32);assert.equal(flow(compactWrap)[0].attrs.mt,7);
 const legacy=Main.prototype.row.call(f.owner,space.sourceSpace,space.sourceGroup,{...f.owner.state(),mode:'project'},{},'compact');assert.equal(legacy.attrs.pl,26);
});

test('project task metadata prefers even empty inline values while every tooltip retains full context',()=>{
 const f=harness();f.render();const row=f.view.result.rows.find(row=>row.address==='t1');assert.equal(typeof row.inlineMetadata,'string');
 assert.equal(f.view.metadata(row),row.inlineMetadata);assert.equal(f.view.metadata(row,true),row.metadata);
 const empty={...row,inlineMetadata:''};assert.equal(f.view.metadata(empty),'');
 const tree=f.view.entityRow(empty,0,f.frame(),f.cx),strings=nodes(tree).flatMap(node=>node.childNodes.filter(child=>typeof child==='string')).join(' ');
 assert(!strings.includes(row.metadata));assert(tree.attrs.tooltip.includes(row.metadata));
 const promoted={...row,inlineMetadata:undefined};assert.equal(f.view.metadata(promoted),[...new Set([row.sourceGroup.name,row.sourceSpace.w.name,'Codex'])].join(' · '));assert.equal(f.view.metadata(promoted,true),row.metadata);
});


test('visible tree guides are finite, per-row and event-free without changing captured actions',()=>{
 const f=harness();f.render();const original=f.view.result.rows.find(row=>row.address==='t1'),row={...original,depth:2,displayDepth:2},before=structuredClone(row);
 const tree=f.view.entityRow(row,0,f.frame(),f.cx),guides=nodes(tree).filter(node=>String(node.attrs.id||'').startsWith('unified-guide-'));
 assert.deepEqual(guides.map(node=>node.attrs.left),[13,33]);assert(guides.every(node=>node.attrs.w===0&&node.attrs.border_l===1&&Object.keys(node.events).length===0));
 assert.deepEqual(row,before);tree.events.on_click({},f.cx);assert.deepEqual(f.calls.at(-1),['pane.focus',{terminal:'t1'}]);
 const deep=f.view.entityRow({...row,depth:1000,displayDepth:1000},0,f.frame(),f.cx);assert.equal(nodes(deep).filter(node=>String(node.attrs.id||'').startsWith('unified-guide-')).length,4);
 f.view.page=9;const onAnotherPage=f.view.entityRow(row,0,f.frame(),f.cx);assert.deepEqual(nodes(onAnotherPage).filter(node=>String(node.attrs.id||'').startsWith('unified-guide-')).map(node=>node.attrs.left),[13,33]);
});

test('short shell titles shrink to one content line and Unknown stays only in tooltip',()=>{
 const f=harness();f.render();const original=f.view.result.rows.find(row=>row.address==='t1'),row={...original,title:'zsh',taskTitle:'zsh',agent:false,kind:'terminal',status:'unknown',actualStatus:'unknown',branchStatus:'unknown',inlineMetadata:'zsh',program:{name:'zsh',shell:true}};
 const tree=f.view.entityRow(row,0,f.frame(),f.cx),task=nodes(tree).find(node=>node.attrs.id===`unified-task-${row.id}`),allText=nodes(tree).flatMap(node=>node.childNodes.filter(value=>typeof value==='string')).join(' ');
 assert(!Object.hasOwn(tree.attrs,'h'));assert.equal(tree.attrs.min_h,28);assert(Object.hasOwn(tree.attrs,'items_start'));assert.equal(task.attrs.max_h,32);assert(!Object.hasOwn(task.attrs,'h'));
 assert(!nodes(tree).some(node=>node.attrs.id===`unified-meta-${row.id}`));assert(!allText.includes('Unknown'));assert(!allText.includes('Idle'));assert(tree.attrs.tooltip.includes('Unknown'));
 const icon=nodes(tree).find(node=>node.attrs.id===`unified-icon-${row.id}`);assert.equal(icon.attrs.h,16);assert.equal(icon.attrs.mr,3);
});

test('Pinned and attention sections are compact separated headings rather than workspace cards',()=>{
 const f=harness();f.agent.pinned=true;f.render();const section=f.view.result.rows.find(row=>row.kind==='section'&&row.title==='Pinned');assert(section);
 const tree=f.view.draw(section,0,f.frame(),f.owner,f.cx,{groups:new Set(f.groups.map(group=>group.key)),spaces:new Set(f.owner.lastRows.map(row=>row.w.id))});
 assert.equal(tree.attrs.h,27);assert.equal(tree.attrs.border_t,1);assert(!Object.hasOwn(tree.attrs,'bg'));assert.equal(tree.attrs.text_size,10.5);
});


test('promoted task metadata keeps distinct remote and manual context while suppressing provider defaults',()=>{
 const f=harness({on:'server'});f.render();const original=f.view.result.rows.find(row=>row.address==='server/t1'),row={...original,inlineMetadata:undefined};
 row.sourceGroup={...row.sourceGroup,name:'Workspace'};row.sourceSpace={...row.sourceSpace,w:{...row.sourceSpace.w,tabs:[{id:row.tabId,name:'Release review',named:true}]}};
 const before=structuredClone(row);assert.equal(f.view.metadata(row),'Workspace · Release review · @server · Codex');assert.equal(f.view.metadata(row,true),row.metadata);assert.deepEqual(row,before);
 for(const name of ['Codex','codex','1']){const generic={...row,sourceSpace:{...row.sourceSpace,w:{...row.sourceSpace.w,tabs:[{id:row.tabId,name,named:true}]}}};assert.equal(f.view.metadata(generic),'Workspace · @server · Codex');}
 const local={...row,on:null,target:{...row.target,on:null}};assert.equal(f.view.metadata(local),'Workspace · Release review · Codex');
 assert.equal(f.view.metadata({...row,inlineMetadata:''}),'');assert.equal(f.view.metadata({...row,sourceSpace:null}),row.metadata);
});

test('canonical space cards retain full-width backgrounds around the caret at every depth',()=>{
 const f=harness();f.render();const source=f.view.result.rows.find(row=>row.kind==='space'),canonical={groups:new Set(f.groups.map(group=>group.key)),spaces:new Set(f.owner.lastRows.map(row=>row.w.id))};
 const root=f.view.draw({...source,depth:0,displayDepth:0},0,f.frame(),f.owner,f.cx,canonical);assert.equal(root.attrs.rounded,6);assert.equal(root.attrs.border_b,1);assert(Object.hasOwn(root.attrs,'bg'));assert.equal(flow(root)[0].attrs.w,18);
 const nested=f.view.draw({...source,depth:1,displayDepth:1},0,f.frame(),f.owner,f.cx,canonical);assert.equal(nested.attrs.bg,'#225');assert.equal(nested.attrs.rounded,6);assert.equal(nested.attrs.border_b,1);assert(Object.hasOwn(nested.attrs,'w_full'));assert.equal(nested.attrs.pl-root.attrs.pl,20);assert.equal(nested.attrs.hover(element()).attrs.bg,'#225');
 const inactive={...source,depth:2,displayDepth:2,sourceSpace:{...source.sourceSpace,w:{...source.sourceSpace.w,active:false}}},card=f.view.draw(inactive,0,f.frame(),f.owner,f.cx,canonical);assert.equal(card.attrs.bg,'#111');assert.equal(card.attrs.hover(element()).attrs.bg,'#444');assert.equal(card.attrs.pl,44);
});


test('one global fold toggle resets exceptions and canonical groups keep manual row-state overrides',()=>{
 const f=harness();f.groups[0].custom=true;let drawnGroup;
 f.owner.groupHead=group=>{drawnGroup=group;return element().id('owner-group-'+group.key).on_click((_event,cx)=>group.onFold(cx));};
 const tree=f.render(),controls=nodes(tree);assert.equal(controls.filter(node=>node.attrs.id==='unified-toggle-all').length,1);assert.equal(controls.find(node=>node.attrs.id==='unified-toggle-all').attrs.tooltip,'Collapse all');assert(!controls.some(node=>['unified-expand-all','unified-collapse-all'].includes(node.attrs.id)));const toggle=controls.find(node=>node.attrs.id==='unified-toggle-all');toggle.events.on_click({},f.cx);assert.equal(f.view.foldMode,'collapse');toggle.events.on_click({},f.cx);assert.equal(f.view.foldMode,'expand');
 f.view.page=3;f.view.opened.add('old-open');f.view.folded.add('old-fold');f.click('unified-toggle-all');f.render();assert.equal(f.view.foldMode,'collapse');assert.equal(f.view.page,0);assert.equal(f.view.opened.size,0);assert.equal(f.view.folded.size,0);assert.equal(f.view.result.rows.length,1);assert.equal(drawnGroup.folded,true);assert.equal(nodes(f.render()).find(node=>node.attrs.id==='unified-toggle-all').attrs.tooltip,'Expand all');
 const groupRow=f.view.result.rows[0];drawnGroup.onFold(f.cx);f.render();assert(f.view.opened.has(groupRow.id));let space=f.view.result.rows.find(row=>row.kind==='space');assert(space?.folded);
 f.view.fold(space,f.cx);f.render();const parent=f.view.result.rows.find(row=>row.address==='t1');assert(parent?.folded);f.view.fold(parent,f.cx);f.render();assert(f.view.result.rows.some(row=>row.address==='t2'));
 f.click('unified-toggle-all');f.render();assert.equal(f.view.foldMode,'expand');assert.equal(f.view.opened.size,0);assert.equal(f.view.folded.size,0);const openParent=f.view.result.rows.find(row=>row.address==='t1');assert.equal(openParent.folded,false);f.view.fold(openParent,f.cx);f.render();assert(!f.view.result.rows.some(row=>row.address==='t2'));assert.equal(nodes(f.render()).find(node=>node.attrs.id==='unified-toggle-all').attrs.tooltip,'Collapse all');
 f.click('unified-toggle-all');f.render();assert.equal(f.view.foldMode,'collapse');f.click('unified-toggle-all');f.render();assert(f.view.result.rows.some(row=>row.address==='t2'));assert.equal(f.calls.length,0);assert.equal(f.storage.size,0);
});

test('global folding reaches later pages and search expands temporarily without losing collapse mode',()=>{
 const f=harness();for(let i=0;i<40;i++)f.snapshots.terminals.push({...f.child,address:'extra-'+i,created_ms:100+i,pid:1000+i,title:'Unique child needle-'+i,labels:{}});
 f.click('unified-toggle-all');f.render();f.click('unified-toggle-all');f.render();assert(f.view.result.pages>1);f.click('unified-next');f.render();assert.equal(f.view.page,1);assert(f.view.result.rows.some(row=>row.address==='extra-39'));
 f.click('unified-toggle-all');f.render();assert.equal(f.view.page,0);assert(!f.view.result.rows.some(row=>row.address==='extra-39'));assert.equal(f.view.result.pages,1);
 f.owner.queryText='needle-39';f.render();assert(f.view.result.rows.some(row=>row.address==='extra-39'));assert.equal(f.view.foldMode,'collapse');assert.equal(f.view.opened.size,0);assert.equal(f.view.folded.size,0);
 f.owner.queryText='';f.render();assert(!f.view.result.rows.some(row=>row.address==='extra-39'));f.click('unified-toggle-all');f.render();f.click('unified-next');f.render();assert(f.view.result.rows.some(row=>row.address==='extra-39'));
});

test('Pinned and Status sections participate in global folding with explicit reopen exceptions',()=>{
 const f=harness();f.agent.pinned=true;f.click('unified-toggle-all');f.render();let pinned=f.view.result.rows.find(row=>row.id==='section:pinned');assert(pinned?.folded);assert(!f.view.result.rows.some(row=>row.address==='t1'));
 f.view.fold(pinned,f.cx);f.render();assert(f.view.result.rows.length>1);f.click('unified-toggle-all');f.render();assert(f.view.result.rows.some(row=>row.address==='t1'));
 f.click('unified-view-status');f.click('unified-toggle-all');f.render();pinned=f.view.result.rows.find(row=>row.id==='section:pinned');assert(pinned?.folded);assert(!f.view.result.rows.some(row=>row.address==='t1'));
 f.click('unified-toggle-all');f.render();assert(f.view.result.rows.some(row=>row.address==='t1'));assert.equal(f.calls.length,0);
});

test('directories moved into Status retain a folder icon and heading style without gaining drag actions',()=>{
 const f=harness();const tree=f.render({state:{...f.owner.state(),mode:'status'}}),space=f.view.result.rows.find(row=>row.kind==='space');assert(space);const entity=nodes(tree).find(node=>node.attrs.id===`unified-entity-${space.id}`),title=nodes(entity).find(node=>node.attrs.id===`unified-task-${space.id}`);assert(nodes(entity).some(node=>node.attrs.id===`unified-directory-icon-${space.id}`));assert(Object.hasOwn(title.attrs,'font_semibold'));assert.equal(entity.attrs.rounded,6);assert(entity.events.on_mouse_down);assert(!entity.events.on_mouse_move);assert(!entity.events.on_mouse_up);
});


test('toolbar sizing follows Files production icon and segment helpers while text retains its own width',()=>{
 const f=harness();for(let i=0;i<40;i++)f.snapshots.terminals.push({...f.child,address:'toolbar-'+i,created_ms:100+i,pid:1000+i,labels:{}});const tree=f.render(),all=nodes(tree),t={background:'#050',muted:'#888',dim:'#777',selected:'#225',foreground:'#eee',border:'#333',hover:'#444'};
 const filesIcons=readFileSync(new URL('../mods/files-plus/icons.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/export function /g,'function '),filesIconButton=new Function('div','svg','image','iconName',filesIcons+';return iconButton;')(element,element,element,()=> 'file'),referenceIcon=filesIconButton('reference','more','Actions',()=>{},t);
 const iconIds=['unified-new-space','unified-toggle-all','unified-settings','unified-prev','unified-next'];for(const id of iconIds){const button=all.find(node=>node.attrs.id===id);assert(button,id);for(const key of ['h','w','p','rounded','bg','text_color'])assert.equal(button.attrs[key],referenceIcon.attrs[key],id+':'+key);assert.equal(button.attrs.min_w,24,id);assert.equal(button.childNodes[0].attrs.size,referenceIcon.childNodes[0].attrs.size,id);assert.equal(button.attrs.disabled,id==='unified-prev',id);assert(Object.hasOwn(button.attrs,'items_center'),id);assert(Object.hasOwn(button.attrs,'justify_center'),id);}
 const browser=readFileSync(new URL('../mods/files-plus/browser.js',import.meta.url),'utf8'),methodStart=browser.indexOf('  segment(id,'),method=browser.slice(methodStart,browser.indexOf('\n  rows(',methodStart)),filesSegment=new Function('div','svg','return ({'+method+'}).segment;')(element,element),containerSource=browser.match(/h_flex\(\)\.id\("files-modes"\).*?\.border_color\(t\.border\)/)[0],referenceContainer=new Function('h_flex','t','return '+containerSource)(element,t);
 const segmentIds=['unified-view-project','unified-view-status','unified-filter-all','unified-filter-active','unified-filter-attention'];for(const id of segmentIds){const button=all.find(node=>node.attrs.id===id),active=['unified-view-project','unified-filter-all'].includes(id),reference=filesSegment('reference','tree','Title',active,()=>{},t);for(const key of ['h','rounded','text_color'])assert.equal(button.attrs[key],reference.attrs[key],id+':'+key);assert.equal(button.attrs.min_w,64,id);assert(!Object.hasOwn(button.attrs,'w'),id);assert.equal(button.attrs.px,8,id);assert.equal(button.attrs.text_size,11.5,id);assert.equal(button.attrs.line_height,'16px',id);if(active)assert.equal(button.attrs.bg,reference.attrs.bg,id);else assert.deepEqual(button.attrs.hover(element()).attrs,reference.attrs.hover(element()).attrs,id);}
 for(const id of ['unified-view-segments','unified-filter-segments']){const container=all.find(node=>node.attrs.id===id);for(const key of ['p','gap','rounded','border_color'])assert.equal(container.attrs[key],referenceContainer.attrs[key],id+':'+key);assert(Object.hasOwn(container.attrs,'border_1'),id);}
 const density=all.find(node=>node.attrs.id==='unified-density');assert.equal(density.attrs.h,referenceIcon.attrs.h);assert.equal(density.attrs.rounded,referenceIcon.attrs.rounded);assert.equal(density.attrs.w,64);assert(Object.hasOwn(density.attrs,'justify_center'));assert.equal(tree.childNodes[0].attrs.h,32);assert(all.some(node=>node.attrs.h===28&&node.attrs.rounded===6&&Object.hasOwn(node.attrs,'border_1')));
 const fold=all.find(node=>String(node.attrs.id||'').startsWith('unified-fold-'));assert.equal(fold.attrs.w,18);assert.equal(fold.attrs.h,16);
});

test('canonical group cards wrap indentation and expose full-row joining feedback',()=>{
 const f=harness();f.groups[0].custom=true;f.render();const source=f.view.result.rows.find(row=>row.kind==='group'),row={...source,depth:2,displayDepth:2},canonical={groups:new Set(f.groups.map(group=>group.key)),spaces:new Set(f.owner.lastRows.map(row=>row.w.id))};assert(source);
 const card=f.view.draw(row,3,f.frame(),f.owner,f.cx,canonical);assert(Object.hasOwn(card.attrs,'w_full'));assert.equal(card.attrs.bg,'#111');assert.equal(card.attrs.rounded,6);assert.equal(card.attrs.border_b,1);assert.equal(card.attrs.mt,12);assert.equal(card.attrs.mb,4);assert.equal(card.attrs.pl,40);assert.equal(card.attrs.hover(element()).attrs.bg,'#444');
 f.owner.drag={kind:'space',id:'another-space'};f.owner.over={kind:'group',id:row.sourceGroup.key};const joining=f.view.draw(row,0,f.frame(),f.owner,f.cx,canonical);assert.equal(joining.attrs.bg,'#225');assert(Object.hasOwn(joining.attrs,'border_1'));assert.equal(joining.attrs.border_color,'#5bf');assert.equal(joining.attrs.mt,4);assert(!Object.hasOwn(joining.attrs,'hover'));
 const readonly=f.view.draw({...row,sourceGroup:null},0,f.frame(),f.owner,f.cx,canonical);assert(Object.hasOwn(readonly.attrs,'w_full'));assert.equal(readonly.attrs.min_w,0);
});


test("directory pin changes invalidate the asynchronous projection without writing task pins or group preferences",()=>{
 const f=harness();f.render();const initial=f.modelCalls(),before=JSON.stringify(f.owner.state());f.storage.set(DIRECTORY_PINS_KEY,{spaces:[f.space.id]});f.render();assert.equal(f.modelCalls(),initial+1);assert.equal(f.view.result.rows.find(r=>r.kind==="space").section,"pinned");assert.equal(f.view.result.rows.find(r=>r.kind==="space").directoryPinned,true);assert.equal(f.agent.pinned,false);assert.equal(f.calls.length,0);assert.equal(JSON.stringify(f.owner.state()),before);f.storage.set(DIRECTORY_PINS_KEY,{spaces:[]});f.render();assert.equal(f.view.result.rows.find(r=>r.kind==="space").section,null);
});

test("Status directory and project context menus expose directory pinning without gaining drag handlers",()=>{
 const f=harness();f.groups[0].custom=true;const tree=f.render({state:{...f.owner.state(),mode:"status"}}),group=f.view.result.rows.find(r=>r.kind==="group"),space=f.view.result.rows.find(r=>r.kind==="space");for(const row of [group,space]){const rendered=nodes(tree).find(node=>node.attrs.id===(row.kind==="group"?"unified-readonly-group-":"unified-entity-")+row.id);assert(rendered.events.on_mouse_down);assert(!rendered.events.on_mouse_move);assert(!rendered.events.on_mouse_up);rendered.events.on_mouse_down({},f.cx);}assert.deepEqual(f.calls,[['group-menu',group.groupKey],['space-menu',space.spaceId]]);
});


test("task hover keeps the original parent relationship visible when directory pinning separates display branches",()=>{
 const f=harness();f.render();const row=f.view.result.rows.find(r=>r.address==='t2'),tree=f.view.entityRow({...row,parentId:'original-parent'},0,f.frame(),f.cx);assert(tree.attrs.tooltip.includes('Parent: original-parent'));
});
