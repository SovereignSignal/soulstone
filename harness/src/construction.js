import {parseBuildingBlock,blockKind,matchesBuildingBlock,validateBuildingBlock,verifyPassage,setPassageOpen,passagePoints,companionCell,isFurniture,verifyFurniture} from './building-blocks.js'
import {Vec3} from 'vec3'
import pathfinding from 'mineflayer-pathfinder'
const {goals}=pathfinding
const key=p=>`${p.x},${p.y},${p.z}`
export function fullCube(registry,name) {
 const entry=registry.blocksByName[name],data=registry.blockCollisionShapes
 if(!entry||entry.boundingBox!=='block'||!data)return false
 const ids=data.blocks[name];return ids!==undefined&&[...new Set(Array.isArray(ids)?ids:[ids])].every(id=>JSON.stringify(data.shapes[id])==='[[0,0,0,1,1,1]]')
}
export const projectName=n=>typeof n==='string'&&/^[a-z][a-z0-9_-]{0,31}$/.test(n)&&!['base','__proto__','constructor','prototype'].includes(n)
// Ordered cuboids are a compact declarative language, never executable code.
// Air carves the BLUEPRINT only. It never authorizes removing world blocks.
export function architectureRegion(r) {
 const b={...r,x2:r?.x2??r?.x,y2:r?.y2??r?.y,z2:r?.z2??r?.z}
 for(const axis of ['x','y','z'])if(!Number.isInteger(b[axis])||!Number.isInteger(b[axis+'2'])||b[axis]>b[axis+'2']||b[axis]<(axis==='y'?0:-16)||b[axis+'2']>16)throw new Error('Architecture bounds: x/z -16..16, y 0..16; ordered integer corners')
 parseBuildingBlock(b.block)
 if(b.block==='checkpoint'&&(b.x!==b.x2||b.y!==b.y2||b.z!==b.z2))throw new Error('A checkpoint must be one feet position')
 return Object.fromEntries(['x','y','z','x2','y2','z2','block'].map(k=>[k,b[k]]))
}
export function validateArchitecturePatch(patch) {
 if(!Array.isArray(patch)||!patch.length||patch.length>32)throw new Error('Revision needs 1–32 patch regions')
 const regions=patch.map(architectureRegion)
 if(regions.reduce((n,b)=>n+(b.x2-b.x+1)*(b.y2-b.y+1)*(b.z2-b.z+1),0)>64)throw new Error('Revision patch exceeds 64 cells')
 return regions
}
export function architectureChanges(previous,next) {
 const before=compileArchitecture(previous),after=compileArchitecture(next),old=new Map(before.cells.map(b=>[key(b),b])),fresh=new Map(after.cells.map(b=>[key(b),b]))
 if(before.cells.some(b=>!fresh.has(key(b))))throw new Error('Revision must retain prior cells; use explicit air to remove a recorded structural block')
 if(JSON.stringify(after.checks.slice(0,before.checks.length))!==JSON.stringify(before.checks))throw new Error('Revision must preserve existing walk checkpoints')
 const changes=after.cells.filter(b=>{const a=old.get(key(b));return (a?.block||'air')!==b.block||JSON.stringify(a?.properties)!==JSON.stringify(b.properties)}).map(b=>({before:old.get(key(b))||{x:b.x,y:b.y,z:b.z,block:'air'},after:b}))
 if(changes.length>64)throw new Error('Revision changes more than 64 occupied cells')
 return changes
}
export function reviseArchitecture(previous,patch) {
 const design=compileArchitecture([...previous,...validateArchitecturePatch(patch)]).design
 architectureChanges(previous,design);return design
}
export const removableStructure=b=>/^(?:stone|cobblestone|cobbled_deepslate|smooth_stone|glowstone|glass|bricks|(?:[a-z_]+_(?:planks|log|wood|bricks|terracotta|concrete|wool|glass)))$/.test(b.block)
export async function applyArchitectureRevision(bot,previous,blueprint,origin,api) {
 const changes=architectureChanges(previous,blueprint.design),changed=new Map(changes.map(c=>[key(c.after),c]))
 // Inspect the whole saved footprint before the first destructive action.
 for(const b of blueprint.cells){
  const actual=bot.blockAt(origin.offset(b.x,b.y,b.z)),old=changed.get(key(b))?.before
  if(!actual||actual.name!=='air'&&!matchesBuildingBlock(actual,b,{ignoreOpen:true})&&!(old&&matchesBuildingBlock(actual,old,{ignoreOpen:true})))throw new Error('Revision world conflict at '+key(b)+'; existing content preserved')
 }
 for(const {before} of changes)if(before.block!=='air'&&(!removableStructure(before)||!fullCube(bot.registry,before.block)))throw new Error('Revision cannot dismantle furnishings, stateful blocks or unsupported materials: '+before.block)
 const removals=changes.filter(c=>c.before.block!=='air').sort((a,b)=>b.before.y-a.before.y),removed=[]
 for(const {before,after} of removals){
  api.check();const pos=origin.offset(before.x,before.y,before.z),actual=bot.blockAt(pos)
  if(actual?.name==='air'||matchesBuildingBlock(actual,after,{ignoreOpen:true}))continue
  const guard=()=>{
   if(!matchesBuildingBlock(bot.blockAt(pos),before,{ignoreOpen:true}))throw new Error('Revision target changed before removal')
   const entities=[bot.entity,...Object.values(bot.players||{}).map(p=>p.entity)].filter(Boolean)
   if(entities.some(e=>Math.abs(e.position.x-pos.x-.5)<.8&&Math.abs(e.position.z-pos.z-.5)<.8&&e.position.y>=pos.y+1&&e.position.y<pos.y+2.1))throw new Error('Revision would remove player support')
   if(api.movements?.gravityBlocks?.has(bot.blockAt(pos.offset(0,1,0))?.type))throw new Error('Revision would release a falling block')
  }
  guard();await api.walk(new goals.GoalLookAtBlock(pos,bot.world,{reach:3}));api.check();guard()
  await bot.tool.equipForBlock(bot.blockAt(pos),{requireHarvest:true,getFromChest:false});api.check();guard()
  api.progress('Revising recorded block at '+key(pos));api.stage('digging');api.check();await bot.dig(bot.blockAt(pos));api.check()
  await api.settle(()=>bot.blockAt(pos)?.name==='air','Revision removal was not confirmed')
  removed.push({position:pos,block:before.block});api.persist()
 }
 return {changedCells:changes.length,removed}
}
export function compileArchitecture(regions) {
 if(!Array.isArray(regions)||!regions.length||regions.length>128)throw new Error('Architecture needs 1–128 regions')
 const map=new Map(),checks=[];let volume=0
 const design=regions.map(r=>{
  const b=architectureRegion(r)
  const material=parseBuildingBlock(b.block)
  if(b.block==='checkpoint'){
   if(b.x!==b.x2||b.y!==b.y2||b.z!==b.z2)throw new Error('A checkpoint must be one feet position')
   checks.push(new Vec3(b.x,b.y,b.z))
  }else for(let x=b.x;x<=b.x2;x++)for(let y=b.y;y<=b.y2;y++)for(let z=b.z;z<=b.z2;z++){
   if(++volume>16000)throw new Error('Architecture expansion exceeds budget')
   map.set(key({x,y,z}),{x,y,z,...material})
  }
  return Object.fromEntries(['x','y','z','x2','y2','z2','block'].map(k=>[k,b[k]]))
 })
 const blocks=[...map.values()].filter(b=>b.block!=='air')
 for(const b of blocks){
  const upper=companionCell(b);if(!upper)continue
  if(upper.y>16||Math.abs(upper.x)>16||Math.abs(upper.z)>16||map.get(key(upper))?.block&&map.get(key(upper)).block!=='air')throw new Error('Door upper half or bed head overlaps the blueprint or exceeds its bounds')
  map.set(key(upper),upper)
 }
 for(const b of blocks.filter(b=>['door','gate'].includes(blockKind(b.block)))){
  for(const p of passagePoints(new Vec3(b.x,b.y,b.z),b).filter(p=>key(p)!==key(b)))for(let y=0;y<2;y++){
   const cell=map.get(key(p.offset(0,y,0)))
   if(cell&&cell.block!=='air')throw new Error('Door/gate passage needs two clear blocks on both sides along its facing axis')
  }
 }
 const cells=[...map.values()]
 if(!blocks.length||blocks.length>2048)throw new Error('Architecture needs 1–2048 placed blocks')
 if(checks.length<2||checks.length>32)throw new Error('Architecture needs 2–32 walk checkpoints including entry and upper levels')
 for(const p of checks)for(let y=0;y<2;y++)if(map.get(key(p.offset(0,y,0)))?.block&&map.get(key(p.offset(0,y,0))).block!=='air')throw new Error('Architecture obstructs checkpoint headroom')
 return {design,cells,blocks,checks,bounds:{minX:Math.min(...cells.map(p=>p.x)),maxX:Math.max(...cells.map(p=>p.x)),minZ:Math.min(...cells.map(p=>p.z)),maxZ:Math.max(...cells.map(p=>p.z)),height:Math.max(...cells.map(p=>p.y))}}
}
export function architectureMaterials(blocks,bot,origin) {
 const missing={}
 for(const b of blocks)if(!matchesBuildingBlock(bot.blockAt(origin.offset(b.x,b.y,b.z)),b))missing[b.block]=(missing[b.block]||0)+1
 return missing
}
export async function executeConstruction(bot,task,api) {
 const {check,progress,persist,place,walk,settle,chooseSite}=api
 let blueprint=compileArchitecture(task.goal.design),site=null
 if(!task.goal.origin){
  site=chooseSite(task.goal.near,blueprint)
  if(!site)throw new Error('No clear supported natural site within 24 blocks; try a smaller footprint or another meeting point. Existing builds and steep terrain are excluded.')
  blueprint=compileArchitecture(site.design)
 }
 const {blocks,cells,checks,bounds}=blueprint
 for(const b of blocks)validateBuildingBlock(bot.registry,b,fullCube)
 const review=reviewArchitecture(blueprint);if(review.unreachable.length)throw new Error('Blueprint has unreachable walk checkpoints: '+review.unreachable.map(key).join('; '))
 const at=site?.origin||task.goal.origin,origin=new Vec3(at.x,at.y,at.z)
 task.goal.design=blueprint.design;task.goal.origin={x:origin.x,y:origin.y,z:origin.z};persist()
 if(blocks.some(b=>blockKind(b.block)==='bed')&&!['overworld','minecraft:overworld'].includes(bot.game?.dimension))throw new Error('Bed furnishings require the Overworld')
 const changed=new Map((task.goal.previousDesign?architectureChanges(task.goal.previousDesign,blueprint.design):[]).map(c=>[key(c.after),c.before]))
 // Preflight the entire planned structure before the first placement.
 for(const b of cells){const existing=bot.blockAt(origin.offset(b.x,b.y,b.z));if(!existing||existing.name!=='air'&&!matchesBuildingBlock(existing,b,{ignoreOpen:true})&&!(changed.has(key(b))&&matchesBuildingBlock(existing,changed.get(key(b)),{ignoreOpen:true})))throw new Error(`Construction obstruction: ${existing?.name||'unloaded'} at ${key(origin.offset(b.x,b.y,b.z))}`)}
 const planned=new Map(cells.map(b=>[key(b),b]))
 const observedOrPlanned=p=>{const b=planned.get(key(p));return b?b.block:bot.blockAt(origin.plus(p))?.name}
 for(const b of cells.filter(b=>blockKind(b.block)&&b.properties?.half!=='upper')){
  const p=new Vec3(b.x,b.y,b.z)
  if(blockKind(b.block)==='bed'&&observedOrPlanned(p.offset(0,1,0))!=='air')throw new Error('Bed needs clear headroom before construction')
  if(!fullCube(bot.registry,observedOrPlanned(p.offset(0,-1,0))))throw new Error('Stateful construction needs full-block support below '+key(p))
  if(['door','gate'].includes(blockKind(b.block)))for(const side of passagePoints(p,b)){
   if(!fullCube(bot.registry,observedOrPlanned(side.offset(0,-1,0))))throw new Error('Passage needs a level supported approach')
   if(key(side)!==key(p))for(let y=0;y<2;y++)if(observedOrPlanned(side.offset(0,y,0))!=='air')throw new Error('Passage approach is obstructed')
  }
 }
 if(site){
  const missingMaterials=architectureMaterials(blocks,bot,origin)
  progress(`Reserved ${task.goal.name} at ${key(origin)}; ${site.foundationBlocks} foundation blocks; materials planned before placement`)
  return {item:'construction',name:task.goal.name,origin:task.goal.origin,partial:true,placed:0,verifiedBlocks:0,totalBlocks:blocks.length,missingMaterials,site:{foundationBlocks:site.foundationBlocks,elevationOffset:site.elevationOffset},next:'Site and terrain-fitted blueprint reserved without world writes. Acquire the needed inventory totals in bounded batches, then construct this name with empty design. Saved coordinates include the foundation.'}
 }
 if(task.goal.previousDesign){
  const targets=blocks.filter(b=>changed.has(key(b))&&!matchesBuildingBlock(bot.blockAt(origin.offset(b.x,b.y,b.z)),b,{ignoreOpen:true})),needed=architectureMaterials(targets,bot,origin)
  if(Object.entries(needed).some(([name,n])=>bot.inventory.items().filter(i=>i.name===name).reduce((sum,i)=>sum+i.count,0)<n))return {item:'construction',name:task.goal.name,origin:task.goal.origin,partial:true,placed:0,missingMaterials:needed,totalBlocks:blocks.length,next:'Acquire the revision materials before any structural removal'}
 }
 const revision=task.goal.previousDesign?await applyArchitectureRevision(bot,task.goal.previousDesign,blueprint,origin,api):null
 const remaining=blocks.filter(b=>!matchesBuildingBlock(bot.blockAt(origin.offset(b.x,b.y,b.z)),b,{ignoreOpen:true})).sort((a,b)=>a.y-b.y)
 // A closed installed passage can trap the builder inside its own unfinished
 // walls. Keep recorded passages open during placement, including after resume.
 if(remaining.length)for(const b of blocks.filter(b=>['door','gate'].includes(blockKind(b.block)))){
  if(matchesBuildingBlock(bot.blockAt(origin.offset(b.x,b.y,b.z)),b,{ignoreOpen:true}))await setPassageOpen(bot,origin.offset(b.x,b.y,b.z),b,true,api)
 }
 let placed=0,misses=0,lastFailure='',routeFailure=''
 while(remaining.length&&placed<64){
  check();const b=remaining.shift(),pos=origin.offset(b.x,b.y,b.z)
  const held=bot.inventory.items().some(i=>i.name===b.block&&i.count>0)
  if(!held){remaining.unshift(b);break}
  try{progress(`Constructing ${task.goal.name}: ${blocks.length-remaining.length-1}/${blocks.length}`);await place(pos,b.block,b.properties);placed++;misses=0;routeFailure='';task.progress={verifiedBlocks:blocks.length-remaining.length,totalBlocks:blocks.length,origin:task.goal.origin};persist();if(['door','gate'].includes(blockKind(b.block)))await setPassageOpen(bot,pos,b,true,api)}
  catch(e){
   check();const actual=bot.blockAt(pos)
   if(actual?.name===b.block&&!matchesBuildingBlock(actual,b,{ignoreOpen:true}))throw new Error('Placed block state mismatch; inspect before repair: '+e.message)
   remaining.push(b);lastFailure=e.message
   if(e.code!=='PLACEMENT_UNSUPPORTED')routeFailure=`${e.message} placing ${b.block} at ${key(pos)} (relative ${key(b)}). Check reachable working height and a visible adjacent face; walking onto the finished deck alone does not establish construction access.`
   // A roof's first supported cell can occur late in its cuboid expansion.
   // Stop only after a full pass with no placement, keeping the skill deadline
   // and operation budget as independent bounds.
   if(++misses>=remaining.length)throw new Error(`Construction paused: ${routeFailure||lastFailure}; no progress across ${remaining.length} remaining blocks`)
  }
 }
 const missing=architectureMaterials(blocks.filter(b=>!matchesBuildingBlock(bot.blockAt(origin.offset(b.x,b.y,b.z)),b,{ignoreOpen:true})),bot,origin),left=Object.values(missing).reduce((n,v)=>n+v,0)
 if(left)return {item:'construction',name:task.goal.name,origin:task.goal.origin,partial:true,revision,placed,verifiedBlocks:blocks.length-left,totalBlocks:blocks.length,missingMaterials:missing,next:placed?'Continue the exact saved blueprint at its saved origin':'Acquire missing materials in batches of at most 64, then continue this project'}
 const passages=blocks.filter(b=>['door','gate'].includes(blockKind(b.block))),interactions=[]
 for(const b of passages)interactions.push(await verifyPassage(bot,origin.offset(b.x,b.y,b.z),b,api))
 for(const b of passages)await setPassageOpen(bot,origin.offset(b.x,b.y,b.z),b,true,api)
 const furnishings=[]
 for(const b of blocks.filter(isFurniture)){progress('Checking furnishing '+b.block);furnishings.push(await verifyFurniture(bot,origin.offset(b.x,b.y,b.z),b,api))}
 const walkthrough=[]
 for(const p of checks){
  const feet=origin.plus(p)
  if(bot.blockAt(feet.offset(0,-1,0))?.boundingBox!=='block'||[feet,feet.offset(0,1,0)].some(q=>bot.blockAt(q)?.boundingBox!=='empty'))throw new Error('Architecture access check failed at '+key(feet))
  progress(`Checking ${task.goal.name} access ${walkthrough.length+1}/${checks.length}`)
  await walk(new goals.GoalBlock(feet.x,feet.y,feet.z));check()
  await settle(()=>bot.entity.onGround&&Math.abs(bot.entity.position.y-feet.y)<0.1,'Did not land on the checkpoint floor at '+key(feet))
  walkthrough.push({x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z})
 }
 for(const b of passages)await setPassageOpen(bot,origin.offset(b.x,b.y,b.z),b,false,api)
 // Walking and verification can reveal interference after placement.
 if(cells.some(b=>!matchesBuildingBlock(bot.blockAt(origin.offset(b.x,b.y,b.z)),b)))throw new Error('Architecture changed during walkthrough')
 return {item:'construction',name:task.goal.name,origin:task.goal.origin,verifiedBlocks:blocks.length,totalBlocks:blocks.length,walkthrough,interactions,furnishings,revision,partial:false}
}

// A cheap design review for builds on level pads. Stairs are conservative full cells;
// passages are reviewed open. Collision-aware walking is still required. Real walking is
// still required: this grid cannot establish live pathfinder reachability.
export function reviewArchitecture(blueprint) {
 const solid=new Set(blueprint.cells.filter(b=>b.block!=='air'&&!['door','gate','light'].includes(blockKind(b.block))).map(key)),b=blueprint.bounds
 const isSolid=p=>p.y===-1||solid.has(key(p))
 const open=p=>!isSolid(p)&&!isSolid(p.offset(0,1,0))
 const stand=p=>p.y>=0&&p.y<=17&&p.x>=b.minX-2&&p.x<=b.maxX+2&&p.z>=b.minZ-2&&p.z<=b.maxZ+2&&open(p)&&isSolid(p.offset(0,-1,0))
 const start=blueprint.checks[0],seen=new Set(),queue=[]
 if(stand(start)){queue.push(start);seen.add(key(start))}
 for(let i=0;i<queue.length;i++)for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]])for(const dy of [0,1,-1]){
  const p=queue[i],q=p.offset(dx,dy,dz)
  if(!stand(q)||seen.has(key(q))||dy===1&&isSolid(p.offset(0,2,0))||dy===-1&&isSolid(q.offset(0,2,0)))continue
  seen.add(key(q));queue.push(q)
 }
 return {reachable:blueprint.checks.filter(p=>seen.has(key(p))),unreachable:blueprint.checks.filter(p=>!seen.has(key(p)))}
}
