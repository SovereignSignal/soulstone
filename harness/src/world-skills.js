import {harvestBerries} from './foraging.js'
import {fitConstructionSite} from './construction-site.js'
import {surveyGround,candidateSites} from './site-survey.js'
import {placeBuildingBlock} from './building-blocks.js'
import {executeConstruction,fullCube} from './construction.js'
import {prepareTools} from './supplies.js'
import {executeExpedition,EXPEDITION_ACTIONS} from './prospecting.js'
import {executeStationSkill,STATION_ACTIONS} from './stations.js'
import {nearbyResources} from './observations.js'
import {Vec3} from 'vec3'
import pathfinding from 'mineflayer-pathfinder'
import {setTimeout as delay} from 'node:timers/promises'
import {LOG_ITEMS,isLog} from './resources.js'
import {shelterLayout,inspectShelterSite,finishShelter} from './shelter.js'
import {craftWithWindowState} from './crafting.js'
import {supportsPlayer} from './navigation.js'
import {WATER_BLOCKS} from './survival.js'
import {walkWithTerrainRecovery} from './route-recovery.js'
const {goals}=pathfinding
const key=p=>`${p.x},${p.y},${p.z}`
export function validateDesign(design) {
 if(!Array.isArray(design)||!design.length||design.length>128)throw new Error('A design needs 1–128 blocks')
 const seen=new Set()
 return design.map(b=>{
  if(!b||!['x','y','z'].every(k=>Number.isInteger(b[k]))||Math.abs(b.x)>8||Math.abs(b.z)>8||b.y<0||b.y>4||!(/^[a-z0-9_]{1,64}$/.test(b.block)))throw new Error('Invalid design block; use relative x/z within 8, y 0–4')
  const id=key(b);if(seen.has(id))throw new Error('Duplicate design position');seen.add(id)
  return {x:b.x,y:b.y,z:b.z,block:b.block}
 })
}
export function playerIntersectsSite(position,origin,bounds) {
 return position.x>origin.x+bounds.minX-1 && position.x<origin.x+bounds.maxX+2 &&
  position.z>origin.z+bounds.minZ-1 && position.z<origin.z+bounds.maxZ+2 &&
  position.y+1.8>origin.y && position.y<origin.y+bounds.height+1
}
export function findBuildSite(bot,design,near,{layout=null,protectedSites=[]}={}) {
 const bounds={minX:Math.min(...design.map(b=>b.x)),maxX:Math.max(...design.map(b=>b.x)),minZ:Math.min(...design.map(b=>b.z)),maxZ:Math.max(...design.map(b=>b.z)),height:Math.max(...design.map(b=>b.y))}
 const survey=surveyGround(bot,near,{protectedSites})
 const players=Object.values(bot.players||{}).map(p=>p.entity?.position).filter(Boolean)
 // Reuse the ground survey rather than treating the owner's feet as ground
 // level. Inspect every candidate: a closer pad may lack a usable doorway.
 for(const site of candidateSites(survey,bounds,{maxRise:0,limit:Infinity,players})){
  const p=new Vec3(site.origin.x,site.origin.y,site.origin.z)
  if(Math.hypot(p.x-near.x,p.z-near.z)<4)continue
  if(layout){try{inspectShelterSite(bot,p,layout)}catch{continue}}
  return p
 }
 return null
}
export async function approachPlacement(bot,goal,walk,check) {
 check()
 // Without a neighbouring face no walking route can enable this placement.
 // Let the construction queue build its supports before trying this cell again.
 if(goal.facesPos?.length===0)throw Object.assign(new Error(`No adjacent placement face at ${key(goal.pos)}`),{code:'PLACEMENT_UNSUPPORTED'})
 const approach=new goals.GoalCompositeAll([goal])
 for(let attempt=0;attempt<3;attempt++){
  try{await walk(approach)}catch(e){if(e.code!=='NAVIGATION_INCOMPLETE')throw e}
  check()
  const face=goal.getFaceAndRef(bot.entity.position.offset(0,1.6,0))
  const feet=bot.entity.position,target=goal.pos
  const occupied=feet.x+.3>target.x&&feet.x-.3<target.x+1&&feet.z+.3>target.z&&feet.z-.3<target.z+1&&feet.y+1.8>target.y&&feet.y<target.y+1
  if(face&&!occupied)return face
  // The pathfinder checks an ideal cell-centre viewpoint. Arrival can stop
  // off-centre behind an edge, or at a bed's fractional height. Actual eye
  // visibility and body clearance establish placement, not an ideal voxel.
  // Reject the whole column so a fractional-height stance isn't selected again.
  const p=bot.entity.position.floored()
  approach.push(new goals.GoalInvert(new goals.GoalXZ(p.x,p.z)))
 }
 throw new Error(`No reachable placement face at ${key(goal.pos)}`)
}
const navigationFailure=e=>['NoPath','Timeout'].includes(e.name)||e.code==='NAVIGATION_INCOMPLETE'||e.message.startsWith('No reachable placement face')
export async function jumpPlacement(bot,goal,{walk,check,place}) {
 const target=goal.pos,candidates=[]
 const clear=p=>fullCube(bot.registry,bot.blockAt(p.offset(0,-1,0))?.name)&&[0,1,2].every(y=>bot.blockAt(p.offset(0,y,0))?.name==='air')
 for(let dx=-3;dx<=3;dx++)for(let dz=-3;dz<=3;dz++){
  if(dx===0&&dz===0)continue
  const p=target.offset(dx,-2,dz)
  if(clear(p)&&goal.getFaceAndRef(p.offset(.5,2.45,.5)))candidates.push(p)
 }
 candidates.sort((a,b)=>a.distanceTo(bot.entity.position)-b.distanceTo(bot.entity.position))
 for(const p of candidates.slice(0,8)){
  check()
  try{await walk(new goals.GoalBlock(p.x,p.y,p.z))}catch(e){check();if(navigationFailure(e))continue;throw e}
  check()
  const feet=bot.entity.position
  if(!bot.entity.onGround||Math.abs(feet.y-p.y)>.1||Math.hypot(feet.x-p.x-.5,feet.z-p.z-.5)>.3||!clear(p))continue
  if(Object.values(bot.players||{}).some(v=>v.entity&&v.entity!==bot.entity&&v.entity.position.distanceTo(feet)<1.5))continue
  // One bounded jump from solid, clear ground. The predicted face only picks
  // a stance; actual eye visibility must authorize the in-air placement.
  try{
   bot.clearControlStates()
   bot.setControlState('jump',true)
   for(let tick=0;tick<16;tick++){
    await bot.waitForTicks(1);check()
    if(!bot.entity.onGround)bot.setControlState('jump',false)
    const face=goal.getFaceAndRef(bot.entity.position.offset(0,1.6,0))
    if(bot.entity.position.y>p.y+.3&&face){await place(face);return true}
   }
   return false
  }finally{bot.setControlState('jump',false)}
 }
 return false
}
export async function executeWorldSkill(bot,task,context,gather) {
 const {check,progress,stage,movements}=context
 const walking=movements
 const count=name=>bot.inventory.items().filter(i=>i.name===name).reduce((n,i)=>n+i.count,0)
 let operations=0
 const budget=()=>{check();if(++operations>256)throw new Error('Action budget exhausted; inspect progress before continuing')}
 async function walk(goal,recover=true) {
  await walkWithTerrainRecovery(bot,goal,{movements:walking,check,stage,progress,allowRecovery:recover&&task.kind!=='retreat',onRecovery:record=>{task.navigationRecovery=record;context.persist?.()}})
 }

 async function settle(predicate,message) {
  let stable=0
  for(let i=0;i<60;i++){check();if(predicate())stable++;else stable=0;if(stable>=5)return;await delay(100)}
  throw new Error(message)
 }
 async function place(pos,name,properties) {
  budget()
  if(properties||name==='torch')return placeBuildingBlock(bot,pos,{block:name,properties},{walk,check,stage,settle,approach:approachPlacement})
  const existing=bot.blockAt(pos)
  if(existing?.name===name)return
  if(existing?.name!=='air')throw new Error(`Build site obstructed by ${existing?.name||'unloaded terrain'} at ${key(pos)}`)
  if(!count(name))throw new Error(`Missing ${name}`)
  const goal=new goals.GoalPlaceBlock(pos,bot.world,{range:4.5})
  const send=async face=>{check();stage('placing');await bot.placeBlock(bot.blockAt(face.ref),face.face.scaled(-1));check()}
  let face
  try{face=await approachPlacement(bot,goal,g=>walk(g,false),check)}
  catch(e){
   check();if(!navigationFailure(e))throw e
   progress(`Finding a safe jump placement for ${name}`)
   await bot.equip(bot.inventory.items().find(i=>i.name===name),'hand');check()
   if(!await jumpPlacement(bot,goal,{walk:g=>walk(g,false),check,place:send}))throw e
  }
  if(face){await bot.equip(bot.inventory.items().find(i=>i.name===name),'hand');await send(face)}
  await settle(()=>bot.blockAt(pos)?.name===name,`Server did not confirm ${name} at ${key(pos)}`)
 }
 async function craft(recipe,table) {
  budget();const name=bot.registry.items[recipe.result.id].name
  const before=count(name);let lastPacket=0,sawServer=false
  const onPacket=(p,m)=>{if(['set_slot','window_items','set_player_inventory'].includes(m.name)){lastPacket=Date.now();sawServer=true}}
  bot._client.on('packet',onPacket)
  try {
   progress(`Crafting ${name.replaceAll('_',' ')}`);stage('crafting')
   await craftWithWindowState(bot,recipe,1,table,check);check()
   // craft() mutates inventory optimistically. Require a server sync and a
   // quiet inventory window before consuming the result in the next recipe.
   await settle(()=>sawServer&&Date.now()-lastPacket>=250&&count(name)>=before+recipe.result.count,`Craft result not confirmed: ${name}`)
  }finally{bot._client.off('packet',onPacket)}
 }
 async function tableFor(path) {
  let table=bot.findBlock({matching:bot.registry.blocksByName.crafting_table.id,maxDistance:32})
  if(table){await walk(new goals.GoalLookAtBlock(table.position,bot.world,{reach:3}));return table}
  await acquire('crafting_table',1,path)
  const p=bot.entity.position.floored()
  for(const [x,z] of [[2,0],[-2,0],[0,2],[0,-2],[1,1],[-1,-1]]){
   const pos=p.offset(x,0,z)
   if(bot.blockAt(pos)?.name==='air'&&bot.blockAt(pos.offset(0,-1,0))?.boundingBox==='block') {await place(pos,'crafting_table');return bot.blockAt(pos)}
  }
  throw new Error('No clear place for a crafting table')
 }
 const sources={cobblestone:['stone'],cobbled_deepslate:['deepslate'],coal:['coal_ore','deepslate_coal_ore'],raw_iron:['iron_ore','deepslate_iron_ore'],raw_copper:['copper_ore','deepslate_copper_ore'],diamond:['diamond_ore','deepslate_diamond_ore']}
 async function mine(name,total,path) {
  const names=sources[name]||[name],ids=names.map(n=>bot.registry.blocksByName[n]?.id).filter(Number.isInteger)
  if(!ids.length)throw new Error(`No mining source for ${name}`)
  const skipped=new Set()
  while(count(name)<total){
   budget()
   const exposed=b=>{
    const adjacent=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].map(([x,y,z])=>bot.blockAt(b.position.offset(x,y,z)))
    return adjacent.every(n=>n&&!WATER_BLOCKS.has(n.name)&&n.name!=='lava'&&n.getProperties?.().waterlogged!==true)&&adjacent.some(n=>n.name==='air')
   }
   const candidates=bot.findBlocks({matching:ids,maxDistance:32,count:128,useExtraInfo:b=>exposed(b)&&!skipped.has(key(b.position))&&!supportsPlayer(b.position,bot.entity.position)}).map(p=>bot.blockAt(p)).filter(Boolean)
   candidates.sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position))
   const block=candidates[0]
   if(!block)throw new Error(`No reachable ${names.join(' or ')} observed within 32 blocks`)
   try {
    // Stand beside a seam before digging so drops stay within pickup range;
    // a visible block at the bottom of a pit is not an accessible resource.
    await walk(new goals.GoalCompositeAll([new goals.GoalLookAtBlock(block.position,bot.world),new goals.GoalNear(block.position.x,block.position.y,block.position.z,1.5)]))
    if(bot.canSeeBlock?.(block)===false)throw new Error('Mining target has no clear line of sight')
   }catch(e){check();skipped.add(key(block.position));if(skipped.size>=12)throw new Error(`No accessible ${name} after 12 targets: ${e.message}`);progress(`Skipping inaccessible ${block.name}; inspecting another source`);continue}

   const harvest=Object.keys(block.harvestTools||{}).map(Number)
   if(harvest.length&&!bot.inventory.items().some(i=>harvest.includes(i.type))) {
    const tool=['wooden_pickaxe','stone_pickaxe','iron_pickaxe','diamond_pickaxe'].find(n=>harvest.includes(bot.registry.itemsByName[n]?.id))
    if(!tool)throw new Error(`No supported tool recipe for ${block.name}`)
    await acquire(tool,1,path)
   }
   progress(`Mining ${name}: ${count(name)}/${total}`)
   await walk(new goals.GoalCompositeAll([new goals.GoalLookAtBlock(block.position,bot.world),new goals.GoalNear(block.position.x,block.position.y,block.position.z,1.5)]))
   if(supportsPlayer(block.position,bot.entity.position)){skipped.add(key(block.position));continue}
   const before=count(name)
   check();await bot.tool.equipForBlock(block,{requireHarvest:true,getFromChest:false});check();stage('gathering');await bot.dig(block);check()
   await delay(500);check()
   if(count(name)<=before){
    // Drops can land on the far side or below the mined cell. Freeze a nearby
    // matching drop's position, then enter that cell instead of stopping one
    // block away. Never chase an entity after it disappears.
    const drop=Object.values(bot.entities||{}).filter(e=>e.getDroppedItem?.()?.name===name&&e.position.distanceTo(block.position)<3).sort((a,b)=>a.position.distanceTo(block.position)-b.position.distanceTo(block.position))[0]
    const pickup=(drop?.position||block.position).floored()
    try{await walk(new goals.GoalNear(pickup.x,pickup.y,pickup.z,0.5))}
    catch(error){check();if(count(name)<=before)throw error}
   }
   await settle(()=>count(name)>before,`Mined ${name} but pickup was not confirmed`)
  }
 }
 const visibleSources=new Set(nearbyResources(bot,[...LOG_ITEMS,...Object.values(sources).flat()],{maxDistance:48,countPerKind:1}).map(b=>b.name))
 const findSource=name=>(sources[name]||[name]).some(n=>visibleSources.has(n))
 function supplyCost(name,needed,trail,memo) {
  const missing=Math.max(0,needed-count(name));if(!missing)return 0
  if(trail.includes(name)||trail.length>3)return 100000
  if(findSource(name))return missing+(isLog(name)?1:2)
  const cacheKey=name+':'+missing+':'+trail.join(',');if(memo.has(cacheKey))return memo.get(cacheKey)
  const item=bot.registry.itemsByName[name];if(!item)return 100000
  const recipes=bot.recipesAll(item.id,null,true).filter(r=>r.delta.some(d=>d.count<0))
  const cost=recipes.length?1+Math.min(...recipes.map(r=>r.delta.filter(d=>d.count<0).reduce((sum,d)=>sum+supplyCost(bot.registry.items[d.id].name,-d.count*Math.ceil(missing/r.result.count),[...trail,name],memo),0))):100000
  memo.set(cacheKey,cost);return cost
 }
 async function acquire(name,total,path=[]) {
  budget()
  if(count(name)>=total)return
  if(total>128)throw new Error('Inventory target exceeds 128 items')
  if(path.includes(name)||path.length>10)throw new Error(`Recipe dependency cycle for ${name}`)
  const next=[...path,name]
  const item=bot.registry.itemsByName[name]
  if(!item)throw new Error(`This Minecraft version has no item ${name}`)
  if(isLog(name)){if(total>32)throw new Error('Gather at most 32 logs at once');await gather(total,name);return}
  if(sources[name]&&findSource(name)){await mine(name,total,next);return}
  const recipes=bot.recipesAll(item.id,null,true).filter(r=>r.delta.some(d=>d.count<0))
  const memo=new Map(),scores=new Map(recipes.map(r=>[r,score(r)]))
  recipes.sort((a,b)=>scores.get(a)-scores.get(b))
  function score(r){return r.delta.filter(d=>d.count<0).reduce((n,d)=>n+supplyCost(bot.registry.items[d.id]?.name,-d.count,[name],memo),0)}
  const recipe=recipes[0]
  if(!recipe){await mine(name,total,next);return}
  let table=recipe.requiresTable?await tableFor(next):null
  while(count(name)<total){
   const rounds=Math.ceil((total-count(name))/recipe.result.count)
   for(const d of recipe.delta.filter(d=>d.count<0))await acquire(bot.registry.items[d.id].name,-d.count*rounds,next)
   if(table)await walk(new goals.GoalLookAtBlock(table.position,bot.world,{reach:3}))
   const available=bot.recipesFor(item.id,null,1,table).find(r=>JSON.stringify(r.delta)===JSON.stringify(recipe.delta))
   if(!available){progress(`Rechecking ${name} ingredients after prerequisite crafting`);continue}
   await craft(available,table)
  }
 }
 if(task.kind==='harvest')return harvestBerries(bot,task,{check,progress,stage,persist:context.persist,walk,settle})
 if(EXPEDITION_ACTIONS.includes(task.kind))return executeExpedition(bot,task,{check,progress,stage,persist:context.persist,walk,settle})
 if(STATION_ACTIONS.includes(task.kind))return executeStationSkill(bot,task,{check,progress,stage,persist:context.persist,walk,settle,acquire})
 if(task.kind==='construct')return executeConstruction(bot,task,{check,progress,stage,movements,persist:context.persist,place,walk,settle,chooseSite:(point,blueprint)=>fitConstructionSite(bot,blueprint,point,task.goal.protectedSites||[],task.goal.constructionLimits||{})})
 if(task.kind==='prepare')return prepareTools(bot,task.goal,{acquire,settle,check,progress})
 if(task.kind==='acquire'){await acquire(task.goal.item,task.goal.count);return {item:task.goal.item,count:count(task.goal.item)}}
 const design=validateDesign(task.goal.design)
 const layout=task.goal.purpose==='shelter'?shelterLayout(design):null
 const logs=LOG_ITEMS.filter(n=>bot.registry.itemsByName[n])
 const nearest=bot.findBlock({matching:logs.map(n=>bot.registry.blocksByName[n]?.id).filter(Number.isInteger),maxDistance:48})
 const wood=logs.sort((a,b)=>count(b)-count(a))[0]
 const chosen=task.goal.wood || (count(wood)>0?wood:nearest?.name||'oak_log')
 task.goal.wood=chosen;context.persist()
 const resolved=design.map(b=>({...b,block:b.block==='wood_planks'?chosen.replace('_log','_planks'):b.block}))
 for(const b of resolved){const entry=bot.registry.blocksByName[b.block];if(!fullCube(bot.registry,b.block)||!bot.registry.itemsByName[b.block])throw new Error(`Build supports full solid blocks; unavailable or unsupported: ${b.block}`)}
 const near=new Vec3(task.goal.near.x,task.goal.near.y,task.goal.near.z).floored()
 let origin=task.goal.origin?new Vec3(task.goal.origin.x,task.goal.origin.y,task.goal.origin.z):null
 if(!origin){
  origin=findBuildSite(bot,design,near,{layout,protectedSites:task.goal.protectedSites||[]})
  if(!origin)throw new Error('No clear supported natural building site within 24 horizontal blocks, including lower ground and doorway access; choose another footprint or meeting point')
  task.goal.origin={x:origin.x,y:origin.y,z:origin.z};context.persist()
 }
 if(layout)inspectShelterSite(bot,origin,layout,{repair:true})
 const needed={}
 for(const b of resolved){if(bot.blockAt(origin.offset(b.x,b.y,b.z))?.name!==b.block)needed[b.block]=(needed[b.block]||0)+1}
 progress(`Build site ${key(origin)}; sourcing ${Object.values(needed).reduce((a,b)=>a+b,0)} blocks`)
 for(const [name,total] of Object.entries(needed))await acquire(name,total)
 const remaining=resolved.slice()
 // Lower supported blocks first; defer unsupported placements until their
 // neighbours exist. This handles arbitrary connected designs, not house text.
 remaining.sort((a,b)=>a.y-b.y)
 let misses=0,verified=0
 while(remaining.length){
  const b=remaining.shift(),pos=origin.offset(b.x,b.y,b.z)
  try{progress(`Building ${resolved.length-remaining.length}/${resolved.length}: ${b.block}`);await place(pos,b.block);misses=0;task.progress={verifiedBlocks:++verified,origin:task.goal.origin};context.persist()}
  catch(e){check();remaining.push(b);if(++misses>=remaining.length)throw new Error(`Build blocked with ${remaining.length} blocks remaining: ${e.message}`)}
 }
 const missing=resolved.filter(b=>bot.blockAt(origin.offset(b.x,b.y,b.z))?.name!==b.block)
 if(missing.length)throw new Error(`Build verification failed: ${missing.length} blocks differ`)
 const usability=layout?await finishShelter(bot,origin,layout,chosen,{check,walk,settle,acquire,progress,stage,persist:context.persist}):null
 return {item:'build',count:resolved.length,origin:task.goal.origin,verifiedBlocks:resolved.length,...(usability?{usability}:{})}
}
