import { normalizeDirectoryPins } from "./directory-pins.js";
// Read-only sidebar projection. Ownership comes from explicit API/labels/parents, never cwd.
export const UNIFIED_PAGE_SIZE = 30;
const STATUS = ["blocked", "done", "working", "idle", "unknown"];
const RANK = { blocked: 4, done: 3, working: 2, idle: 1, unknown: 0 };
const text = (value, max = 160) => { const s = typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ") : ""; return s.length > max ? s.slice(0, max - 1) + "…" : s; };
const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value);
const list = value => Array.isArray(value) ? value : [];
const machine = address => typeof address === "string" && address.includes("/") ? address.slice(0, address.lastIndexOf("/")) : null;
const qualify = (id, on) => !identifier(id) ? null : id.includes("/") ? machine(id) === on ? id : null : on ? `${on}/${id}` : id;
const addressOf = value => identifier(value) && value.split("/").length <= 2 ? value : null;
const created = value => { const n = value?.created_ms ?? value?.created; return Number.isSafeInteger(n) && n > 0 ? n : null; };
const setOf = value => value instanceof Set ? value : new Set(list(value));
const rowId = (kind, id) => `${kind}:${id}`;
const statusOf = value => STATUS.includes(value) ? value : value === "error" ? "blocked" : "unknown";
const priority = (a, b) => RANK[b.branchStatus] - RANK[a.branchStatus] || a.order - b.order;
export const unifiedAliasKey = target => target?.address && target?.created_ms ? JSON.stringify([target.on ?? null, target.address, target.created_ms]) : null;

function snapshot(input) {
  const spaces = new Map(), tabs = new Map(), spaceRows = new Map(), groupOf = new Map(), duplicateSpaces = new Set(), duplicateTabs = new Set();
  for (const w of list(input.spaces)) {
    if (!identifier(w?.id)) continue;
    if (spaces.has(w.id)) duplicateSpaces.add(w.id); else spaces.set(w.id, w);
    for (const tab of list(w.tabs)) { if (!identifier(tab?.id)) continue; if (tabs.has(tab.id)) duplicateTabs.add(tab.id); else tabs.set(tab.id, { tab, w }); }
  }
  for (const g of list(input.groups)) for (const row of list(g.rows)) if (spaces.has(row?.w?.id) && !spaceRows.has(row.w.id)) { spaceRows.set(row.w.id, row); groupOf.set(row.w.id, g); }
  const cores = new Map(), agents = new Map(), duplicateCores = new Set(), duplicateAgents = new Set(), paneByTerminal = new Map();
  for (const t of list(input.terminals)) { if (!addressOf(t?.address) || t.state !== "live") continue; if (cores.has(t.address)) duplicateCores.add(t.address); else cores.set(t.address, t); }
  for (const a of list(input.agents)) { if (!addressOf(a?.address)) continue; if (agents.has(a.address)) duplicateAgents.add(a.address); else agents.set(a.address, a); }
  for (const p of list(input.panes)) if (addressOf(p?.terminal)) { if (!paneByTerminal.has(p.terminal)) paneByTerminal.set(p.terminal, []); paneByTerminal.get(p.terminal).push(p); }
  return { spaces, tabs, spaceRows, groupOf, duplicateSpaces, duplicateTabs, cores, agents, duplicateCores, duplicateAgents, paneByTerminal };
}
function ownership(address, core, api, s) {
  const on = machine(address), candidates = [], issues = [], constraints = [], ps = s.paneByTerminal.get(address) || [];
  const spaceOnly = (id, source) => {
    const w = s.spaces.get(id);
    if (!w || (w.machine ?? null) !== on || s.duplicateSpaces.has(w.id)) { issues.push("Unverified " + source + " space"); return null; }
    constraints.push(w.id); return w;
  };
  const take = (space, tab, pane, source) => {
    const item = tab ? s.tabs.get(tab) : null;
    if (space && !spaceOnly(space, source)) return;
    if (!tab) return; // A partial explicit space remains useful without inventing a tab.
    if (!item || s.duplicateTabs.has(tab) || (item.w.machine ?? null) !== on || space && item.w.id !== space) { issues.push("Unverified " + source + " space/tab"); return; }
    if (!space) spaceOnly(item.w.id, source);
    if (pane && ps.length && !ps.some(p => p.pane === pane && p.tab === tab)) { issues.push("Unverified " + source + " pane"); return; }
    candidates.push({ space: item.w.id, tab: item.tab.id, pane: pane || null });
  };
  if (api) take(api.space || null, api.tab || null, api.pane || null, "agent");
  for (const p of ps) { const item = s.tabs.get(p.tab); if (item) take(item.w.id, p.tab, p.pane, "pane"); else issues.push("Unverified pane tab"); }
  const ls = core?.labels?.["herdr.space"], lt = core?.labels?.["herdr.tab"];
  if (ls || lt) {
    const qspace = ls ? qualify(ls, on) : null, qtab = lt ? qualify(lt, on) : null;
    if (ls && !qspace || lt && !qtab) issues.push("Unverified terminal label machine"); else take(qspace, qtab, null, "terminal label");
  }
  const owners = new Set(candidates.map(o => JSON.stringify([o.space, o.tab]))), panes = new Set(candidates.map(o => o.pane).filter(Boolean)), spaces = new Set(constraints);
  if (owners.size > 1 || panes.size > 1 || spaces.size > 1) issues.push("Conflicting explicit ownership");
  const owner = !issues.length ? candidates.length && owners.size === 1 && panes.size <= 1 ? { ...candidates[0], pane: [...panes][0] || null } : spaces.size === 1 ? {space:[...spaces][0],tab:null,pane:null} : null : null;
  return { owner, issues };
}
function captured(node, s) {
  const owner = node.own, missing = !node.core || !created(node.core), ambiguous = s.duplicateCores.has(node.address) || s.duplicateAgents.has(node.address);
  return { kind: node.agent ? "agent" : "terminal", address: node.address, created_ms: created(node.core), on: node.on, space: owner?.space || null, tab: owner?.tab || null, pane: owner?.pane || null,
    apiIdentity: node.api ? JSON.stringify([node.api.space ?? null,node.api.tab ?? null,node.api.pane ?? null]) : null, parent: node.rawParent, parentCreated: node.parentNode ? created(node.parentNode.core) : null, agent: node.agent,
    disabled: Boolean(missing || ambiguous || node.issues.length), reason: missing ? "The terminal creation identity is unavailable." : ambiguous ? "The terminal identity is ambiguous." : node.issues.join("; ") };
}
function buildNodes(input, s, options) {
  const nodes = new Map(), held = setOf(options.heldDone); let order = 0;
  for (const address of new Set([...s.cores.keys(), ...s.agents.keys()])) {
    const core = s.cores.get(address), api = s.agents.get(address), on = machine(address), knownShell = core?.program?.shell === true && !api;
    const { owner, issues } = ownership(address, core, api, s), actualStatus = statusOf(api?.status ?? core?.status), status = held.has(address) && actualStatus === "idle" ? "done" : actualStatus;
    const raw = typeof core?.parent === "string" && core.parent ? core.parent : null, parent = raw ? qualify(raw, on) : null;
    if (raw && !parent) issues.push("Parent belongs to a different or unknown machine");
    const node = { address, on, core, api, own: owner, issues, order: order++, agent: Boolean(api || !knownShell && core?.program?.agent), actualStatus, status, rawParent: parent || raw,
      parent: null, parentNode: null, children: [], title: text(api?.title || core?.title || core?.name || core?.program?.name || api?.program?.name || address, 2000), program: api?.program || core?.program || null,
      pinned: api?.pinned ?? Boolean(core?.labels?.["herdr.pinned"]), focused: Boolean(api?.focused), child: Boolean(raw), cycle: false, missingParent: false };
    nodes.set(address, node);
  }
  for (const node of nodes.values()) if (node.rawParent) {
    const parent = nodes.get(node.rawParent);
    if (!parent || parent.on !== node.on || created(parent.core) && created(node.core) && created(parent.core) > created(node.core)) { node.missingParent = true; node.issues.push("The recorded parent is absent or has been replaced"); }
    else { node.parent = parent.address; node.parentNode = parent; }
  }
  const complete = new Set();
  for (const node of nodes.values()) {
    if (complete.has(node.address)) continue;
    const chain = [], seen = new Map(); let cur = node;
    while (cur && !complete.has(cur.address)) {
      if (seen.has(cur.address)) { for (const cyclic of chain.slice(seen.get(cur.address))) { cyclic.cycle = true; cyclic.issues.push("Explicit parent cycle"); } cur.parent = null; cur.parentNode = null; break; }
      seen.set(cur.address, chain.length); chain.push(cur); cur = nodes.get(cur.parent);
    }
    for (const item of chain) complete.add(item.address);
  }
  const roots = [];
  for (const node of nodes.values()) { const parent = nodes.get(node.parent); if (parent) parent.children.push(node); else roots.push(node); node.target = captured(node, s); }
  const stack = roots.map(node => [node, false]);
  while (stack.length) { const [node, visited] = stack.pop(); if (!visited) { stack.push([node, true]); for (const child of node.children) stack.push([child, false]); continue; }
    node.branchStatus = node.status; node.branchPinned = node.pinned; node.owner = node.own;
    for (const child of node.children) { if (RANK[child.branchStatus] > RANK[node.branchStatus]) node.branchStatus = child.branchStatus; node.branchPinned ||= child.branchPinned; node.owner ||= child.owner; }
    node.children.sort((a,b) => a.order - b.order);
  }
  // A child without its own layout labels inherits display context only through its explicit parent.
  const ancestry=roots.slice();while(ancestry.length){const node=ancestry.pop();for(const child of node.children){child.owner ||= node.owner;ancestry.push(child);}}
  return { nodes, roots };
}
function optionsOf(input, supplied) { return { ...(input.options || {}), ...(supplied || {}) }; }
function termsOf(options) { return text(options.query || "", 200).toLocaleLowerCase().trim().split(/\s+/).filter(Boolean); }
function groupFor(w, s) { return s.groupOf.get(w?.id) || null; }
function contextFor(node, s) {
  const own = node.own || node.owner, w = s.spaces.get(own?.space), source = s.spaceRows.get(w?.id), g = groupFor(w,s), tab = s.tabs.get(own?.tab)?.tab;
  return { w, source, g, tab };
}
function statusMatches(value, filter) { return !filter || filter === "all" || filter === "active" && ["working", "blocked", "done"].includes(value) || filter === "attention" && ["blocked", "done"].includes(value) || filter === value; }
function matchesNode(node, s, terms, filter) {
  if (!statusMatches(node.status, filter)) return false;
  const { w, source, g, tab } = contextFor(node,s), hay = [node.title,node.address,node.on,g?.name,g?.folder,w?.name,w?.folder,source?.place,source?.g?.branch,tab?.name,node.core?.cwd].map(v=>text(v,4096)).join(" ").toLocaleLowerCase();
  return terms.every(term => hay.includes(term));
}
function openRow(row, options, filtering) {
  if (!row.foldable || filtering) return true;
  const folded = options._folded; if (folded.has(row.id) || row.kind === "group" && folded.has(row.groupKey)) return false;
  if (options._opened?.has(row.id)) return true;
  if (options.collapseAll) return false;
  if (options.expandAll) return true;
  if (row.kind === "group") return options._expanded.has(row.id) || !row.sourceGroup?.folded;
  if (row.kind === "section" || row.kind === "statussection") return true;
  if (options.expanded !== undefined) return setOf(options.expanded).has(row.id);
  return true;
}
function baseRow(kind, id, title, depth, sourceGroup = null, sourceSpace = null) {
  return { kind,id,title:text(title,120),depth,displayDepth:Math.min(depth,8),sourceGroup,sourceSpace,groupKey:sourceGroup?.key || null,spaceId:sourceSpace?.w?.id || null,metadata:"",target:null,foldable:false,folded:false,childCount:0 };
}
function nodeRow(node, depth, s, options, group = null, source = null, merged = false) {
  const ctx = contextFor(node,s), g = ctx.g || group, r = ctx.source || source, alias = options.aliases?.[unifiedAliasKey(node.target)] || "";
  const candidate = text(ctx.tab?.name,2000).trim(), genericNames = [node.program?.name,node.program?.key].filter(value=>typeof value==="string").map(value=>value.trim().toLocaleLowerCase());
  const tabTitle = merged && ctx.tab?.named && candidate && !/^\d+$/.test(candidate) && !genericNames.includes(candidate.toLocaleLowerCase()) ? candidate : "", title = text(alias || tabTitle || node.title,120), row = baseRow(node.agent ? "agent" : "terminal", rowId("agent",node.address),title,depth,g,r);
  const contextNames = [...new Set([g?.name,ctx.w?.name,ctx.tab?.name].filter(Boolean))];
  const info = [...contextNames,node.on ? `@${node.on}` : "local",node.program?.name,...node.issues].filter(Boolean);
  return { ...row,address:node.address,spaceId:node.own?.space || row.spaceId,tabId:node.own?.tab || null,parentId:node.rawParent,agent:node.agent,child:node.child,pinned:node.pinned,focused:node.focused,status:node.status,actualStatus:node.actualStatus,branchStatus:node.branchStatus,program:node.program,
    inlineMetadata:group && source ? text([node.program?.name !== title ? node.program?.name : "",...node.issues].filter(Boolean).join(" · "),500) : undefined,
    taskTitle:text(node.title,2048),metadata:text(info.join(" · "),500),tooltip:text([node.title,node.address,node.core?.cwd,node.presentationDetached&&node.rawParent?`Parent: ${node.rawParent}`:"",...node.issues].filter(Boolean).join("\n"),3000),on:node.on,target:node.target,
    merged,cycle:node.cycle,missingParent:node.missingParent,foldable:node.children.length>0,childCount:node.children.length,rawAgent:node.api || null };
}

/** Project canonical groups into a finite current page; all source nodes remain reachable by paging/search. */
export function unifiedRows(input = {}, supplied = {}) {
  const options=optionsOf(input,supplied);
  options._folded=setOf(options.folded);options._expanded=setOf(options.expanded);options._opened=setOf(options.openOverrides);
  const s=snapshot(input),forest=buildNodes(input,s,options),terms=termsOf(options),filter=options.statusFilter||options.status||"all",filtering=terms.length>0||filter!=="all",mode=options.view==="status"?"status":"project";
  const directoryPins=normalizeDirectoryPins(options.directoryPins),explicitGroups=new Set(directoryPins.groups),explicitSpaces=new Set(directoryPins.spaces.filter(id=>s.spaces.has(id)));
  for(const [id,group]of s.groupOf)if(explicitGroups.has(group.key))explicitSpaces.add(id);
  const container=node=>node.owner?.space||node.own?.space||null;
  let detached=false;
  // Explicit directory placement splits only presentation edges; captured parent identities remain intact.
  for(const node of forest.nodes.values()){
    const parent=node.parentNode,own=container(node),above=parent&&container(parent);
    if(!node.parent||!own||!above||own===above||!explicitSpaces.has(own)&&!explicitSpaces.has(above))continue;
    parent.children=parent.children.filter(child=>child!==node);node.parent=null;node.presentationDetached=true;forest.roots.push(node);detached=true;
  }
  if(detached){
    const stack=forest.roots.map(node=>[node,false]);
    while(stack.length){const[node,visited]=stack.pop();if(!visited){stack.push([node,true]);for(const child of node.children)stack.push([child,false]);continue;}node.branchStatus=node.status;node.branchPinned=node.pinned;node.owner=node.own;for(const child of node.children){if(RANK[child.branchStatus]>RANK[node.branchStatus])node.branchStatus=child.branchStatus;node.branchPinned ||= child.branchPinned;node.owner ||= child.owner;}}
    const ancestry=forest.roots.slice();while(ancestry.length){const node=ancestry.pop();for(const child of node.children){child.owner ||= node.owner;ancestry.push(child);}}
  }
  const bucketOf=node=>node.branchPinned?"pinned":mode==="status"?`status-${node.branchStatus}`:["blocked","done"].includes(node.branchStatus)?"attention":null;
  const rootOf=new Map(),fullBucket=new Map(),scopeSafe=new Map(),rootHasTask=new Map();
  for(const root of forest.roots){
    fullBucket.set(root.address,bucketOf(root));
    let safe=Boolean(root.own?.space&&root.own?.tab&&!root.target.disabled),hasTask=root.branchPinned;
    const stack=[root];
    while(stack.length){const node=stack.pop();rootOf.set(node.address,root);if(node.agent||["blocked","done","working","idle"].includes(node.status))hasTask=true;if(node.target.disabled||node.on!==root.on||node.owner?.space&&node.owner.space!==root.own?.space)safe=false;for(const child of node.children)stack.push(child);}
    scopeSafe.set(root.address,safe);rootHasTask.set(root.address,hasTask);
  }
  const kept=new Set(),matched=new Set();
  for(const node of forest.nodes.values())if(matchesNode(node,s,terms,filter)){matched.add(node.address);let cur=node;while(cur&&!kept.has(cur.address)){kept.add(cur.address);cur=forest.nodes.get(cur.parent);}}
  const statusStack=forest.roots.map(node=>[node,false]);
  while(statusStack.length){const[node,visited]=statusStack.pop();if(!kept.has(node.address))continue;if(!visited){statusStack.push([node,true]);for(const child of node.children)statusStack.push([child,false]);continue;}node.branchStatus=node.status;node.branchPinned=node.pinned;for(const child of node.children)if(kept.has(child.address)){if(RANK[child.branchStatus]>RANK[node.branchStatus])node.branchStatus=child.branchStatus;node.branchPinned ||= child.branchPinned;}}
  const roots=forest.roots.filter(node=>kept.has(node.address)),bucketRoots=new Map(),rest=[];
  for(const root of roots){const bucket=bucketOf(root);if(bucket){if(!bucketRoots.has(bucket))bucketRoots.set(bucket,[]);bucketRoots.get(bucket).push(root);}else rest.push(root);}
  const visibleOwnRoots=new Map();for(const root of roots){const id=container(root);if(id){if(!visibleOwnRoots.has(id))visibleOwnRoots.set(id,[]);visibleOwnRoots.get(id).push(root);}}
  const matchingSpaces=new Set(),matchingTabs=new Set(),paneMembers=new Map(),directNodes=new Map(),spaceNodes=new Map();
  for(const node of forest.nodes.values()){
    if(node.own?.tab){if(!directNodes.has(node.own.tab))directNodes.set(node.own.tab,[]);directNodes.get(node.own.tab).push(node);}
    if(node.owner?.space){if(!spaceNodes.has(node.owner.space))spaceNodes.set(node.owner.space,[]);spaceNodes.get(node.owner.space).push(node);if(kept.has(node.address)){matchingSpaces.add(node.owner.space);if(node.owner.tab)matchingTabs.add(node.owner.tab);}}
  }
  for(const pane of list(input.panes)){if(!paneMembers.has(pane.tab))paneMembers.set(pane.tab,[]);paneMembers.get(pane.tab).push(pane);}
  const displayed=new Set(),canonical=[];
  for(const group of list(input.groups)){const members=list(group.rows).filter(r=>s.spaces.has(r?.w?.id)&&!displayed.has(r.w.id));for(const r of members)displayed.add(r.w.id);if(members.length)canonical.push({group,members});}
  const leftover=[...s.spaces.values()].filter(w=>!displayed.has(w.id));if(leftover.length)canonical.push({group:{key:"unified:unassigned",name:"Other workspaces",rows:[],custom:true},members:leftover.map((w,i)=>({w,i,place:w.folder}))});
  const wanted=(group,r)=>{if(filter!=="all"&&!matchingSpaces.has(r.w.id))return false;if(!terms.length)return true;const fields=[group.name,group.folder,r.w.name,r.place,r.w.folder,r.g?.branch,...list(r.w.tabs).map(t=>t?.name)].map(v=>text(v,4096)).join(" ").toLocaleLowerCase();return terms.every(term=>fields.includes(term))||matchingSpaces.has(r.w.id);};
  const visibleGroups=canonical.map(entry=>({...entry,wanted:entry.members.filter(r=>wanted(entry.group,r))}));
  const covered=(node,w,tab,bucket=null)=>Boolean(node&&!node.target.disabled&&node.target.space===w.id&&node.target.tab===tab.id&&node.target.on===(w.machine??null)&&(!bucket||fullBucket.get(rootOf.get(node.address)?.address)===bucket));
  const completeTab=(w,tab,bucket)=>{if(!identifier(tab?.id)||s.duplicateSpaces.has(w.id)||s.duplicateTabs.has(tab.id))return false;const members=paneMembers.get(tab.id)||[],direct=directNodes.get(tab.id)||[];return members.length>0&&direct.length>0&&direct.every(node=>covered(node,w,tab,bucket))&&members.every(p=>identifier(p.pane)&&p.terminal&&covered(forest.nodes.get(p.terminal),w,tab,bucket)&&forest.nodes.get(p.terminal).target.pane===p.pane);};
  const fullSpaceBucket=new Map(),movedSpaces=new Map(),completeSpaces=new Map(),fullGroupBucket=new Map();
  const commonBucket=owners=>{const taskRoots=owners.filter(root=>rootHasTask.get(root.address)),basis=taskRoots.length?taskRoots:owners,buckets=new Set(basis.map(root=>fullBucket.get(root.address)));return buckets.size===1?[...buckets][0]:null;};
  for(const w of s.spaces.values()){
    const nodes=spaceNodes.get(w.id)||[],tabList=list(w.tabs),owners=[...new Set(nodes.map(node=>rootOf.get(node.address)))];
    if(!nodes.length||!tabList.length||owners.some(root=>!root||root.own?.space!==w.id||!scopeSafe.get(root.address))||!tabList.every(tab=>completeTab(w,tab,null)))continue;
    completeSpaces.set(w.id,owners);const bucket=commonBucket(owners);if(bucket)fullSpaceBucket.set(w.id,bucket);
  }
  for(const entry of canonical){
    if(!entry.members.every(r=>completeSpaces.has(r.w.id)))continue;
    const owners=[...new Set(entry.members.flatMap(r=>completeSpaces.get(r.w.id)))],bucket=commonBucket(owners);
    if(bucket){fullGroupBucket.set(entry.group.key,bucket);for(const r of entry.members)fullSpaceBucket.set(r.w.id,bucket);}
  }
  for(const [id,bucket]of fullSpaceBucket){const visible=visibleOwnRoots.get(id)||[],tasks=visible.filter(root=>rootHasTask.get(root.address));if(visible.length&&tasks.every(root=>bucketOf(root)===bucket))movedSpaces.set(id,bucket);}
  for(const id of explicitSpaces)movedSpaces.set(id,"pinned");
  for(const entry of canonical)if(entry.members.every(r=>movedSpaces.get(r.w.id)==="pinned"))fullGroupBucket.set(entry.group.key,"pinned");
  bucketRoots.clear();rest.length=0;
  for(const root of roots){const bucket=movedSpaces.get(container(root))||bucketOf(root);if(bucket){if(!bucketRoots.has(bucket))bucketRoots.set(bucket,[]);bucketRoots.get(bucket).push(root);}else rest.push(root);}
  const promotedNodes=new Set();for(const node of forest.nodes.values()){const root=rootOf.get(node.address);if(kept.has(node.address)&&root&&bucketOf(root)&&!node.target.disabled)promotedNodes.add(node.address);}
  const coveredTab=(w,tab)=>mode==="project"&&completeTab(w,tab,null)&&(directNodes.get(tab.id)||[]).every(node=>promotedNodes.has(node.address))&&(paneMembers.get(tab.id)||[]).every(p=>promotedNodes.has(p.terminal));
  const rows=[],push=row=>{row.folded=!openRow(row,options,filtering);rows.push(row);return !row.folded;};
  const drawBranch=(root,depth,group=null,source=null,merged=false)=>{const stack=[{node:root,depth,merged}];while(stack.length){const item=stack.pop(),node=item.node;if(!kept.has(node.address))continue;const row=nodeRow(node,item.depth,s,options,group,source,item.merged);row.contextOnly=!matched.has(node.address);row.childCount=node.children.filter(n=>kept.has(n.address)).length;row.foldable=row.childCount>0;if(push(row))for(let i=node.children.length-1;i>=0;i--)stack.push({node:node.children[i],depth:item.depth+1,merged:false});}};
  const itemIndexes=new Map();
  const itemIndex=items=>{if(itemIndexes.has(items))return itemIndexes.get(items);const index={spaces:new Map(),tabs:new Map(),roots:new Set(items)};for(const root of items){for(const[key,value]of [["spaces",root.owner?.space],["tabs",root.owner?.tab]]){if(!index[key].has(value))index[key].set(value,[]);index[key].get(value).push(root);}}itemIndexes.set(items,index);return index;};
  const spaceItems=(items,id)=>itemIndex(items).spaces.get(id)||[];
  const drawSpace=(source,group,depth,items,section=null)=>{
    const w=source.w,index=itemIndex(items);
    const tabs=list(w.tabs).filter(tab=>{
      if(!identifier(tab?.id)||(filter!=="all"||section&&filtering)&&!matchingTabs.has(tab.id))return false;
      if(!section)return !coveredTab(w,tab);
      const nestedElsewhere=!(index.tabs.get(tab.id)||[]).length&&completeTab(w,tab,null)&&(directNodes.get(tab.id)||[]).every(node=>kept.has(node.address)&&index.roots.has(rootOf.get(node.address)));
      return !nestedElsewhere;
    });
    const tabIds=new Set(tabs.map(tab=>tab.id)),loose=items.filter(node=>!tabIds.has(node.owner?.tab));
    const row=baseRow("space",rowId("space",w.id),w.name,depth,group,source);Object.assign(row,{section,directoryPinned:directoryPins.spaces.includes(w.id),directoryInheritedPin:explicitSpaces.has(w.id)&&!directoryPins.spaces.includes(w.id),active:Boolean(w.active),on:w.machine??null,status:w.status,metadata:text(source.place||w.folder,300),spaceId:w.id,target:{kind:"space",space:w.id,on:w.machine??null,disabled:s.duplicateSpaces.has(w.id)},foldable:tabs.length>0||loose.length>0,childCount:tabs.length+loose.length,empty:!tabs.length&&!loose.length,newTabTarget:{space:w.id,on:w.machine??null}});if(!push(row))return;
    for(const tab of tabs){const tabItems=index.tabs.get(tab.id)||[],ps=paneMembers.get(tab.id)||[],direct=directNodes.get(tab.id)||[];
      if(tabItems.length===1&&!tabItems[0].target.disabled&&tabItems[0].target.space===w.id&&tabItems[0].target.tab===tab.id&&direct.length===1&&ps.length<=1&&!ps.some(p=>!p.terminal)){drawBranch(tabItems[0],depth+1,group,source,true);continue;}
      const tr=baseRow("tab",rowId("tab",JSON.stringify([w.id,tab.id])),tab.name||"Tab",depth+1,group,source);Object.assign(tr,{section,tabId:tab.id,on:w.machine??null,status:tab.status||null,metadata:ps.some(p=>!p.terminal)?"Includes a preview/mod pane":"",target:{kind:"tab",space:w.id,tab:tab.id,on:w.machine??null,disabled:s.duplicateSpaces.has(w.id)||s.duplicateTabs.has(tab.id)},foldable:tabItems.length>0,childCount:tabItems.length,empty:!tabItems.length});if(push(tr))for(const node of tabItems)drawBranch(node,depth+2,group,source);
    }
    for(const node of loose)drawBranch(node,depth+1,group,source);
  };
  const drawGroup=(entry,members,offset,items,section=null)=>{
    if(!members.length)return;const group=entry.group,solo=list(group.rows).length===1&&!group.custom&&!group.manual&&!explicitGroups.has(group.key),depth=offset+(solo?0:1);
    if(!solo){const row=baseRow("group",rowId("group",group.key),group.name,offset,group);Object.assign(row,{section,directoryPinned:explicitGroups.has(group.key),status:group.status,foldable:true,childCount:members.length,count:members.length});if(!push(row))return;}
    for(const source of members)drawSpace(source,group,depth,spaceItems(items,source.w.id),section);
  };
  const wholeGroupBucket=entry=>fullGroupBucket.get(entry.group.key)||null;
  const sectionOrder=mode==="project"?["pinned","attention"]:["pinned",...STATUS.map(status=>`status-${status}`)];
  const sectionName=bucket=>bucket==="pinned"?"Pinned":bucket==="attention"?"Needs attention":{blocked:"Needs you",done:"Done",working:"Working",idle:"Idle",unknown:"Unknown status"}[bucket.slice(7)];
  for(const bucket of sectionOrder){const items=bucketRoots.get(bucket)||[],hasDirectories=visibleGroups.some(entry=>entry.wanted.some(r=>movedSpaces.get(r.w.id)===bucket));if(!items.length&&!hasDirectories)continue;const header=baseRow("section",`section:${bucket}`,sectionName(bucket),0);Object.assign(header,{status:bucket.startsWith("status-")?bucket.slice(7):null,foldable:true,childCount:items.length,count:items.filter(root=>bucketOf(root)===bucket||bucket==="pinned"&&explicitSpaces.has(container(root))).length});if(!push(header))continue;
    for(const entry of visibleGroups){const members=entry.wanted.filter(r=>movedSpaces.get(r.w.id)===bucket);if(!members.length)continue;if(wholeGroupBucket(entry)===bucket)drawGroup(entry,members,1,items,bucket);else for(const source of members)drawSpace(source,entry.group,1,spaceItems(items,source.w.id),bucket);}
    for(const root of items.filter(root=>movedSpaces.get(container(root))!==bucket).sort(priority))drawBranch(root,1);
  }
  const mainGroups=visibleGroups.map(entry=>({...entry,remaining:entry.wanted.filter(r=>!movedSpaces.has(r.w.id))})).filter(entry=>entry.remaining.length);
  let navigationOpen=mode!=="status"||filter==="all";
  if(mode==="status"&&filter==="all"&&mainGroups.length){const nav=baseRow("section","section:navigation","Other workspaces",0);Object.assign(nav,{foldable:true,childCount:mainGroups.reduce((n,entry)=>n+entry.remaining.length,0)});navigationOpen=push(nav);}
  if(navigationOpen)for(const entry of mainGroups)drawGroup(entry,entry.remaining,mode==="status"?1:0,mode==="project"?rest:[]);
  const unplaced=mode==="project"?rest.filter(node=>!node.owner||!s.spaces.has(node.owner.space)):[];
  if(unplaced.length){const header=baseRow("section","section:unplaced","Other live terminals",0);Object.assign(header,{foldable:true,childCount:unplaced.length,count:unplaced.length});if(push(header))for(const node of unplaced.sort(priority))drawBranch(node,1);}
  const agentOrder=rows.filter(r=>r.agent).map(r=>r.address),size=Math.max(1,Math.min(UNIFIED_PAGE_SIZE,Number.isInteger(options.pageSize)?options.pageSize:UNIFIED_PAGE_SIZE)),pages=Math.max(1,Math.ceil(rows.length/size)),page=Math.max(0,Math.min(pages-1,Number.isInteger(options.page)?options.page:0));
  const counts={spaces:s.spaces.size,tabs:s.tabs.size,agents:[...forest.nodes.values()].filter(n=>n.agent).length,terminals:forest.nodes.size,pinned:[...forest.nodes.values()].filter(n=>n.pinned).length,blocked:[...forest.nodes.values()].filter(n=>n.agent&&n.status==="blocked").length,done:[...forest.nodes.values()].filter(n=>n.agent&&n.status==="done").length,working:[...forest.nodes.values()].filter(n=>n.agent&&n.status==="working").length,matchingAgents:[...matched].filter(id=>forest.nodes.get(id)?.agent).length,rows:rows.length};counts.attention=counts.blocked+counts.done;
  const warnings=[];if(s.duplicateCores.size||s.duplicateAgents.size||s.duplicateSpaces.size||s.duplicateTabs.size)warnings.push("Conflicting explicit identities remain visible; their actions are disabled.");if([...forest.nodes.values()].some(n=>n.missingParent||n.cycle||n.issues.length))warnings.push("Some terminals have incomplete or conflicting parent/ownership metadata; inspect their row details.");
  return {rows:rows.slice(page*size,(page+1)*size),page,pageSize:size,pages,total:rows.length,agentOrder:[...new Set(agentOrder)],counts,warnings,view:mode};
}

/** Re-read live host DTOs immediately before acting on a captured row. */
export function validateUnifiedTarget(target,input={}) {
  if(!target||target.disabled)return false;const s=snapshot(input),w=s.spaces.get(target.space);
  if(target.kind==="space"||target.kind==="tab")return Boolean(w&&!s.duplicateSpaces.has(w.id)&&(w.machine??null)===(target.on??null)&&(target.kind==="space"||s.tabs.get(target.tab)?.w.id===w.id&&!s.duplicateTabs.has(target.tab)));
  if(!["agent","terminal"].includes(target.kind)||!addressOf(target.address)||machine(target.address)!==(target.on??null)||!target.created_ms)return false;
  const core=s.cores.get(target.address),api=s.agents.get(target.address);if(!core||created(core)!==target.created_ms||s.duplicateCores.has(target.address)||s.duplicateAgents.has(target.address))return false;
  if ((api ? JSON.stringify([api.space ?? null,api.tab ?? null,api.pane ?? null]) : null) !== target.apiIdentity) return false;
  const actualParent=core.parent?qualify(core.parent,target.on??null)||core.parent:null;if(actualParent!==target.parent)return false;
  if(target.parentCreated&&(s.duplicateCores.has(actualParent)||created(s.cores.get(actualParent))!==target.parentCreated))return false;
  const actualAgent=Boolean(api||core.program?.agent&&!core.program?.shell);if(actualAgent!==target.agent)return false;
  const {owner,issues}=ownership(target.address,core,api,s);if(issues.length)return false;
  return (owner?.space||null)===target.space&&(owner?.tab||null)===target.tab&&(owner?.pane||null)===target.pane;
}
