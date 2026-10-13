import {digStaircase} from './staircase.js'
import {remainingDurability} from './supplies.js'
import {PRECIOUS,TOOL_RESERVE} from './tool-choice.js'
import {roofed} from './observations.js'
import {projectFootprints} from './site-survey.js'
import {inProtectedSite} from './primitives.js'
import {plainCube} from './scaffold.js'
import {insideBase,inBackExit,retreatToShelter} from './retreat.js'
import {harvestBerries} from './foraging.js'
import {useHeldItem,dimensionOf} from './use-item.js'
import {makeObsidian,fillableWaterSources,takeableObsidian} from './obsidian.js'
import {walkNear} from './primitives.js'
import {fitConstructionSite} from './construction-site.js'
import {surveyGround,candidateSites} from './site-survey.js'
import {placeBuildingBlock} from './building-blocks.js'
import {executeConstruction,fullCube} from './construction.js'
import {prepareTools,stockTunnelPickaxes} from './supplies.js'
import {executeExpedition,EXPEDITION_ACTIONS} from './prospecting.js'
import {executeStationSkill,STATION_ACTIONS,SMELTING} from './stations.js'
import {nearbyResources} from './observations.js'
import {Vec3} from 'vec3'
import pathfinding from 'mineflayer-pathfinder'
import {setTimeout as delay} from 'node:timers/promises'
import {LOG_ITEMS,isLog} from './resources.js'
import {quarryStone} from './quarry.js'
import {shelterLayout,inspectShelterSite,finishShelter} from './shelter.js'
import {craftWithWindowState} from './crafting.js'
import {supportsPlayer} from './navigation.js'
import {WATER_BLOCKS} from './survival.js'
import {walkWithTerrainRecovery} from './route-recovery.js'
import {travelTo} from './travel.js'
import {huntFor,HUNTABLE} from './hunt.js'
import {meleeWeapon} from './combat.js'
import {calmDaylight} from './survival.js'
const {goals}=pathfinding
const key=p=>`${p.x},${p.y},${p.z}`
const FALLING=/^(gravel|sand|red_sand|suspicious_sand|suspicious_gravel)$|_concrete_powder$/
export function validateDesign(design) {
 if(!Array.isArray(design)||!design.length||design.length>128)throw new Error('A design needs 1–128 blocks')
 const seen=new Set()
 return design.map(b=>{
  if(!b||!['x','y','z'].every(k=>Number.isInteger(b[k]))||Math.abs(b.x)>8||Math.abs(b.z)>8||b.y<0||b.y>4||!(/^[a-z0-9_]{1,64}$/.test(b.block)))throw new Error('Invalid design block; use relative x/z within 8, y 0–4')
  const id=key(b);if(seen.has(id))throw new Error('Duplicate design position');seen.add(id)
  return {x:b.x,y:b.y,z:b.z,block:b.block}
 })
}
// Where is this goal, for staging purposes? A goal that names a block keeps its
// position in `pos`, not as x and z, so reading only x/z skipped staging for
// every walk to one however far away it was: the walk home ends at the base
// crafting table, eighty five blocks in a single hop on a fifteen second budget,
// failing as "Walking attempt timed out" while travel made the same journey.
// And `approachPlacement` wraps EVERY placement in a GoalCompositeAll, which has
// neither x/z nor pos, only `goals` — so no build walk was staged at all. The run
// that motivated this was 39, 76 and 87 blocks from its site at its three build
// failures and verified zero blocks.
export function goalTarget(goal) {
 const named=g=>['x','z'].every(k=>Number.isFinite(g?.[k]))?g:['x','z'].every(k=>Number.isFinite(g?.pos?.[k]))?g.pos:null
 return named(goal)||(Array.isArray(goal?.goals)?goal.goals.map(named).find(Boolean)||null:null)
}
export function playerIntersectsSite(position,origin,bounds) {
 return position.x>origin.x+bounds.minX-1 && position.x<origin.x+bounds.maxX+2 &&
  position.z>origin.z+bounds.minZ-1 && position.z<origin.z+bounds.maxZ+2 &&
  position.y+1.8>origin.y && position.y<origin.y+bounds.height+1
}
export function findBuildSite(bot,design,near,{layout=null,protectedSites=[]}={}) {
 const bounds={minX:Math.min(...design.map(b=>b.x)),maxX:Math.max(...design.map(b=>b.x)),minZ:Math.min(...design.map(b=>b.z)),maxZ:Math.max(...design.map(b=>b.z)),height:Math.max(...design.map(b=>b.y))}
 const players=Object.values(bot.players||{}).map(p=>p.entity?.position).filter(Boolean)
 // Reuse the ground survey rather than treating the owner's feet as ground
 // level. Inspect every candidate: a closer pad may lack a usable doorway.
 // Forests and hills rarely offer a flat pad close by, so widen once.
 for(const radius of [24,48]){
  const survey=surveyGround(bot,near,{radius,protectedSites})
  for(const site of candidateSites(survey,bounds,{maxRise:0,limit:Infinity,players})){
   const p=new Vec3(site.origin.x,site.origin.y,site.origin.z)
   if(Math.hypot(p.x-near.x,p.z-near.z)<4)continue
   if(layout){try{inspectShelterSite(bot,p,layout)}catch{continue}}
   return p
  }
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
// A crafting table needs air on a full solid block within placing reach. Forest
// floors and slopes rarely offer that on the bot's own level, so scan a small
// volume nearest-first instead of six fixed cells.
export function tableSite(bot,{radius=3}={}){
 const p=bot.entity.position.floored(),found=[]
 for(let dx=-radius;dx<=radius;dx++)for(let dz=-radius;dz<=radius;dz++)for(let dy=-1;dy<=1;dy++){
  if(!dx&&!dz)continue
  const pos=p.offset(dx,dy,dz)
  if(bot.blockAt(pos)?.name!=='air'||bot.blockAt(pos.offset(0,1,0))?.name!=='air'||bot.blockAt(pos.offset(0,-1,0))?.boundingBox!=='block')continue
  found.push(pos)
 }
 return found.sort((a,b)=>a.distanceSquared(p)-b.distanceSquared(p))[0]||null
}
// Plants have no collision face for GoalLookAtBlock to find. Approach within
// pickup range; mineExposed still checks line of sight before digging.
export function miningGoal(block,world){
 const near=new goals.GoalNear(block.position.x,block.position.y,block.position.z,1.5)
 return block.shapes?.length===0?near:new goals.GoalCompositeAll([new goals.GoalLookAtBlock(block.position,world),near])
}
const SEARCH_TUNNEL_USES=64
export async function executeWorldSkill(bot,task,context,gather) {
 const {check,progress,stage,movements}=context
 const walking=movements
 const count=name=>bot.inventory.items().filter(i=>i.name===name).reduce((n,i)=>n+i.count,0)
 let operations=0
 const budget=()=>{check();if(++operations>256)throw new Error('Action budget exhausted; inspect progress before continuing')}
 // The pathfinder searches a bounded region, so one attempt across a hundred
 // blocks reports no route where an easy walk exists. Close most of the gap in
 // staged legs first, then let the ordinary walk finish and verify arrival.
 async function approach(goal){
  const to=goalTarget(goal)
  if(!to)return
  const here=bot.entity.position
  if(Math.hypot(to.x-here.x,to.z-here.z)<=64)return
  progress(`Walking the long way to ${Math.round(to.x)},${Math.round(to.z)}`)
  try{await travelTo(bot,{kind:'travel',goal:{x:to.x,y:Number.isFinite(to.y)?to.y:here.y,z:to.z}},{check,stage,progress,movements:walking})}
  catch(error){check();progress(`Long walk stopped short: ${error.message}`)}
 }
 async function leaveForWork(){
  // Down the back exit there is no door to leave by: the work starts there
  // (lab run 31, 3 October: prepare and acquire were refused at the shaft's foot).
  if(!['acquire','prepare'].includes(task.kind)||!insideBase(bot,context.shelterProject)||inBackExit(bot,context.shelterProject))return
  check()
  task.departure=await retreatToShelter(bot,{kind:'leave_base',goal:{project:context.shelterProject}},{check,progress,settle,walk:walkOutside})
  context.persist?.();check()
 }
 async function walk(goal,recover=true){
  if(['acquire','prepare'].includes(task.kind)&&insideBase(bot,context.shelterProject)){
   // Crafting within reach does not need to open the room. Resource work and
   // movement beyond the current stance use the same checked door departure.
   if(goal.isEnd(bot.entity.position.floored())){check();return}
   await leaveForWork()
  }
  return walkOutside(goal,recover)
 }
 async function walkOutside(goal,recover=true) {
  await approach(goal)
  // A retreat walk to the lit base may cross thirty blocks of night terrain: give it the task's own window.
  await walkWithTerrainRecovery(bot,goal,{movements:walking,check,stage,progress,protectedSites:[...(task.goal?.protectedSites||[]),...(context.shelterProject?projectFootprints({base:context.shelterProject},dimensionOf(bot)):[])],attemptMs:task.kind==='retreat'?40000:15000,allowRecovery:recover&&task.kind!=='retreat',onRecovery:record=>{task.navigationRecovery=record;context.persist?.()}})
 }

 async function settle(predicate,message) {
  let stable=0
  for(let i=0;i<60;i++){check();if(predicate())stable++;else stable=0;if(stable>=5)return;await delay(100)}
  throw new Error(message)
 }
 async function place(pos,name,properties) {
  budget()
  if(properties||name==='torch')return placeBuildingBlock(bot,pos,{block:name,properties},{walk,check,stage,settle,approach:approachPlacement})
  let existing=bot.blockAt(pos)
  if(existing?.name===name)return
  // Repairing the saved base (its own origin, its own design cells): a plain cube
  // standing where the design says something else is a patch, not an
  // obstruction. The family base's roof had cobblestone where a plank belongs
  // after a pit escape, and every repair refused it as "obstructed".
  const ownBase=task.goal?.purpose==='shelter'&&task.goal?.origin&&['x','y','z'].every(k=>context.shelterProject?.build?.origin?.[k]===task.goal.origin[k])
  if(ownBase&&existing&&existing.name!=='air'&&plainCube(bot)(existing)&&count(name)){
   progress(`Replacing ${existing.name} with ${name} at ${key(pos)}`);stage('digging')
   if(bot.entity.position.distanceTo(pos.offset(.5,.5,.5))>4)await walk(new goals.GoalLookAtBlock(pos,bot.world,{reach:4}),false)
   if(bot.tool?.equipForBlock)await bot.tool.equipForBlock(existing,{requireHarvest:false,getFromChest:false})
   check();await bot.dig(existing);check()
   await settle(()=>bot.blockAt(pos)?.name==='air','patch not removed').catch(()=>{})
   existing=bot.blockAt(pos)
  }
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
  // A table up and out of a pit is a failed walk, not a missing table. One
  // carried, or four planks, beats a terrain watch toward the far one.
  if(table){
   try{await walk(new goals.GoalLookAtBlock(table.position,bot.world,{reach:3}),!count('crafting_table'));return table}
   catch(error){check();if(!navigationFailure(error))throw error;progress(`Table at ${key(table.position)} is out of reach (${error.message}); placing one here`)}
  }
  await acquire('crafting_table',1,path)
  const pos=tableSite(bot)||await carveTableNook()
  if(!pos)throw new Error('No clear place for a crafting table within three blocks')
  await place(pos,'crafting_table');ownTables.push(pos);return bot.blockAt(pos)
 }
 // In a one-wide shaft there is no room for a table: cut a two-high nook in a
 // wall of plain rock with a floor under it, outside any saved build.
 async function carveTableNook(){
  const feet=bot.entity.position.floored(),cube=plainCube(bot),sites=task.goal.protectedSites||[]
  for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]){
   const low=feet.offset(dx,0,dz),high=low.offset(0,1,0),floor=bot.blockAt(low.offset(0,-1,0))
   if(![low,high].every(c=>{const b=bot.blockAt(c);return b&&cube(b)&&!inProtectedSite(c,sites)})||floor?.boundingBox!=='block')continue
   progress(`Cutting a nook for the crafting table at ${key(low)}`);stage('digging')
   for(const c of [high,low]){const b=bot.blockAt(c);if(bot.tool?.equipForBlock)await bot.tool.equipForBlock(b,{requireHarvest:false,getFromChest:false});check();await bot.dig(b);check()}
   if(bot.blockAt(low)?.name==='air'&&bot.blockAt(high)?.name==='air')return low
  }
  return null
 }
 // A table this job put down away from the base comes back with the bot, so
 // the next craft at night or underground needs no trip to the surface (lab
 // run 32: the base table stood outside the wall, and the pickaxe that mines
 // iron could not be made). Best effort: a table left behind is litter, not a failure.
 const ownTables=[]
 async function reclaimTables(){
  for(const pos of ownTables.splice(0)){
   try{
    const b=bot.blockAt(pos);if(b?.name!=='crafting_table')continue
    const before=count('crafting_table')
    progress('Picking the crafting table back up');stage('digging')
    if(bot.entity.position.distanceTo(pos.offset(.5,.5,.5))>4)await walk(new goals.GoalLookAtBlock(pos,bot.world,{reach:3}),false)
    if(bot.tool?.equipForBlock)await bot.tool.equipForBlock(b,{requireHarvest:false,getFromChest:false})
    check();await bot.dig(b);check()
    await walk(new goals.GoalBlock(pos.x,pos.y,pos.z),false).catch(()=>{})
    await settle(()=>count('crafting_table')>before,'table not picked up').catch(()=>{})
   }catch(error){check();progress(`Left the crafting table at ${key(pos)}: ${String(error.message).slice(0,60)}`)}
  }
 }
 const sources={flint:['gravel'],cobblestone:['stone'],cobbled_deepslate:['deepslate'],coal:['coal_ore','deepslate_coal_ore'],raw_iron:['iron_ore','deepslate_iron_ore'],raw_copper:['copper_ore','deepslate_copper_ore'],diamond:['diamond_ore','deepslate_diamond_ore']}
 async function mine(name,total,path) {
  await leaveForWork()
  if(name==='flint')return mineFlint(total,path)
  try{await mineExposed(name,total,path)}
  catch(error){
   check()
   // Surface stone can be absent, unreachable, or lost to a failed walk: quarry for it.
   if(name!=='cobblestone')throw error
   progress(error.message)
   await quarryStone(bot,{name,total,path},{check,stage,progress,persist:context.persist,acquire,count})
   if(count(name)<total)throw new Error(`Quarry ended with ${count(name)}/${total} ${name}: ${error.message}`)
  }
 }
 // Never inside a saved build, and only what `accept` allows: obsidian is
 // taken from pools and ruined portals, never from a frame somebody built.
 // Gravel drops flint about one time in ten and itself otherwise, so eight flint
 // is about eighty digs. Dig exposed gravel until some is carried, then put it
 // down beside the bot on solid ground and dig it again, as a player does.
 const REDIG_ROUND=30
 function gravelSite(){
  const p=bot.entity.position,feet=p.floored()
  const sites=[...(task.goal?.protectedSites||[]),...(context.shelterProject?projectFootprints({base:context.shelterProject},dimensionOf(bot)):[])]
  // A player is 0.6 wide: a cell its box overlaps cannot take a block.
  const clearOfBot=c=>!(p.x+0.3>c.x&&p.x-0.3<c.x+1&&p.z+0.3>c.z&&p.z-0.3<c.z+1)
  return [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]].map(([dx,dz])=>feet.offset(dx,0,dz))
   .find(c=>bot.blockAt(c)?.name==='air'&&bot.blockAt(c.offset(0,-1,0))?.boundingBox==='block'&&clearOfBot(c)&&!inProtectedSite(c,sites))||null
 }
 async function mineFlint(total,path){
  while(count('flint')<total){
   budget()
   if(!count('gravel')){await mineExposed('flint',total,path,{until:()=>count('flint')>=total||count('gravel')>0});continue}
   const site=gravelSite()
   if(!site){progress('No solid ground beside me for the carried gravel; digging gravel where it lies');await mineExposed('flint',total,path);return}
   for(let round=0;round<REDIG_ROUND&&count('flint')<total&&count('gravel');round++){
    check();stage('placing');progress(`Flint from carried gravel: ${count('flint')}/${total} (${count('gravel')} gravel left)`)
    await bot.equip(bot.inventory.items().find(i=>i.name==='gravel'),'hand');check()
    await bot.placeBlock(bot.blockAt(site.offset(0,-1,0)),new Vec3(0,1,0));check()
    await settle(()=>bot.blockAt(site)?.name==='gravel',`Server did not confirm gravel at ${key(site)}`)
    const held=count('flint')+count('gravel'),block=bot.blockAt(site)
    await bot.tool.equipForBlock(block,{requireHarvest:true,getFromChest:false});check();stage('gathering');await bot.dig(block);check()
    const back=()=>count('flint')+count('gravel')>held
    try{await settle(back,'drop not picked up')}
    catch{check();await walk(new goals.GoalNear(site.x,site.y,site.z,0.5),false).catch(()=>{});await settle(back,`Dug the gravel at ${key(site)} but its drop was not picked up`)}
   }
  }
 }
 async function mineExposed(name,total,path,{accept=null,until=null}={}) {
  const names=sources[name]||[name],ids=names.map(n=>bot.registry.blocksByName[n]?.id).filter(Number.isInteger)
  const sites=[...(task.goal?.protectedSites||[]),...(context.shelterProject?projectFootprints({base:context.shelterProject},dimensionOf(bot)):[])]
  if(!ids.length)throw new Error(`No mining source for ${name}`)
  const skipped=new Set()
  while(until?!until():count(name)<total){
   budget()
   const exposed=b=>{
    const adjacent=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].map(([x,y,z])=>bot.blockAt(b.position.offset(x,y,z)))
    return adjacent.every(n=>n&&!WATER_BLOCKS.has(n.name)&&n.name!=='lava'&&n.getProperties?.().waterlogged!==true)&&adjacent.some(n=>n.name==='air')
   }
   const candidates=bot.findBlocks({matching:ids,maxDistance:32,count:128,useExtraInfo:b=>exposed(b)&&!skipped.has(key(b.position))&&!supportsPlayer(b.position,bot.entity.position)&&!inProtectedSite(b.position,sites)}).map(p=>bot.blockAt(p)).filter(Boolean)
   candidates.sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position))
   const block=candidates.find(b=>!accept||accept(b))
   if(!block)throw new Error(candidates.length?`No ${names.join(' or ')} within 32 blocks is safe to take: ${candidates.length} look${candidates.length===1?'s':''} like part of a build`:`No reachable ${names.join(' or ')} observed within 32 blocks`)
   try {
    // Stand beside a seam before digging so drops stay within pickup range;
    // a visible block at the bottom of a pit is not an accessible resource.
    await walk(miningGoal(block,bot.world))
    if(bot.canSeeBlock&&!bot.canSeeBlock(block))throw new Error('Mining target has no clear line of sight')
   }catch(e){check();skipped.add(key(block.position));if(skipped.size>=12)throw new Error(`No accessible ${name} after 12 targets: ${e.message}`);progress(`Skipping inaccessible ${block.name} at ${key(block.position)} (${String(e.message).slice(0,80)}); inspecting another source`);continue}

   const harvest=Object.keys(block.harvestTools||{}).map(Number)
   if(harvest.length&&!bot.inventory.items().some(i=>harvest.includes(i.type))) {
    const tool=['wooden_pickaxe','stone_pickaxe','iron_pickaxe','diamond_pickaxe'].find(n=>harvest.includes(bot.registry.itemsByName[n]?.id))
    if(!tool)throw new Error(`No supported tool recipe for ${block.name}`)
    await acquire(tool,1,path)
   }
   progress(`Mining ${name}: ${count(name)}/${total}`)
   await walk(miningGoal(block,bot.world))
   if(bot.canSeeBlock&&!bot.canSeeBlock(block))throw new Error('Mining target has no clear line of sight')
   if(supportsPlayer(block.position,bot.entity.position)){skipped.add(key(block.position));continue}
   // Gravel and sand straight above the bot's own column fall onto its head.
   {const feet=bot.entity.position.floored(),p=block.position
    if(FALLING.test(block.name)&&p.x===feet.x&&p.z===feet.z&&p.y>feet.y){skipped.add(key(p));continue}}
   // A source that can drop itself (gravel gives flint about one time in ten)
   // counts that drop as a dig done; the loop keeps going until the item arrives.
   const before=count(name),own=block.name!==name&&bot.registry.itemsByName[block.name]?block.name:null,ownBefore=own?count(own):0
   const collected=()=>count(name)>before||!!own&&count(own)>ownBefore
   check();await bot.tool.equipForBlock(block,{requireHarvest:true,getFromChest:false});check();stage('gathering');await bot.dig(block);check()
   await delay(500);check()
   if(!collected()){
    // Drops can land on the far side or below the mined cell. Freeze a nearby
    // matching drop's position, then enter that cell instead of stopping one
    // block away. Never chase an entity after it disappears.
    const drop=Object.values(bot.entities||{}).filter(e=>[name,own].includes(e.getDroppedItem?.()?.name)&&e.position.distanceTo(block.position)<3).sort((a,b)=>a.position.distanceTo(block.position)-b.position.distanceTo(block.position))[0]
    const pickup=(drop?.position||block.position).floored()
    try{await walk(new goals.GoalNear(pickup.x,pickup.y,pickup.z,0.5))}
    catch(error){check();if(!collected())throw error}
   }
   await settle(collected,`Mined ${name} but pickup was not confirmed`)
  }
 }
 // Scanned on the first lookup, not at every skill's start: a retreat never looks, and
 // on a Raspberry Pi this scan froze the bot 12 to 15 s with a zombie beside it (lab run 124).
 let visibleSources=null
 const findSource=name=>{
  visibleSources??=new Set(nearbyResources(bot,[...LOG_ITEMS,...Object.values(sources).flat()],{maxDistance:48,countPerKind:1}).map(b=>b.name))
  return (sources[name]||[name]).some(n=>visibleSources.has(n))
 }
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
 // An animal drop is hunted, a few hunts at most, each one bounded by the hunt's
 // own time, search legs and safety guards. A hunt that gains nothing ends it.
 async function hunted(name,total,path){
  await leaveForWork()
  const animals=HUNTABLE[name]
  // A spider bites back: arm first, but only when the hunt could start at all.
  if(animals.includes('spider')&&calmDaylight(bot)&&!meleeWeapon(bot))await acquire('stone_sword',1,path)
  for(let hunt=1;count(name)<total;hunt++){
   budget()
   const before=count(name)
   try{await huntFor(bot,{kind:'hunt',goal:{item:name,count:total}},{check,stage,progress,persist:context.persist||(()=>{}),movements,max:128})}
   catch(error){
    check()
    const why=String(error.message)
    if(count(name)<=before)throw new Error(/comes from/.test(why)?why:`${name} comes from ${animals.join(' or ')} (no recipe or block gives it), and the hunt failed: ${why}`)
    progress(`Hunt ${hunt} ended with ${count(name)}/${total} ${name}: ${String(error.message).slice(0,80)}`)
   }
   if(count(name)<=before)throw new Error(`A hunt for ${name} gained nothing; carrying ${count(name)}/${total}`)
   if(hunt>=4&&count(name)<total)throw new Error(`Four hunts brought ${count(name)}/${total} ${name}; ${animals.join(' or ')} are scarce here`)
  }
 }
 async function acquire(name,total,path=[]) {
  budget()
  if(count(name)>=total)return
  if(total>128)throw new Error('Inventory target exceeds 128 items')
  if(path.includes(name)||path.length>10)throw new Error(`Recipe dependency cycle for ${name}`)
  const next=[...path,name]
  const item=bot.registry.itemsByName[name]
  if(!item)throw new Error(`This Minecraft version has no item ${name}`)
  // The per-trip bound applies to the shortfall, never the carry target: a
  // request to hold 40 logs while carrying 32 is an eight-log trip.
  if(isLog(name)){const missing=total-count(name);if(missing>32)throw new Error(`Gather at most 32 logs per trip: carrying ${count(name)} ${name}, ${missing} more needed`);await leaveForWork();await gather(total,name);return}
  if(sources[name]&&findSource(name)){await mine(name,total,next);return}
  const recipes=bot.recipesAll(item.id,null,true).filter(r=>r.delta.some(d=>d.count<0))
  const memo=new Map(),scores=new Map(recipes.map(r=>[r,score(r)]))
  recipes.sort((a,b)=>scores.get(a)-scores.get(b))
  function score(r){return r.delta.filter(d=>d.count<0).reduce((n,d)=>n+supplyCost(bot.registry.items[d.id]?.name,-d.count,[name],memo),0)}
  const recipe=recipes[0]
  // Crafting alone loops for a furnace product (iron ingots from nuggets or a block,
  // both made of ingots): name the furnace step instead (lab run 94).
  // Feathers and string have no recipe and no block: an animal drops them.
  if(Object.hasOwn(HUNTABLE,name)&&(!recipe||scores.get(recipe)>=100000)){await hunted(name,total,next);return}
  if(Object.hasOwn(SMELTING,name)&&(!recipe||scores.get(recipe)>=100000))
   throw new Error(`${name} comes from a furnace: smelt ${SMELTING[name]} into ${name} first, then ask again`)
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
 if(task.kind==='use')return useHeldItem(bot,task,{check,stage,persist:context.persist,walk,settle,approach:approachPlacement})
 if(EXPEDITION_ACTIONS.includes(task.kind))return executeExpedition(bot,task,{check,progress,stage,persist:context.persist,walk,settle})
 if(STATION_ACTIONS.includes(task.kind))return executeStationSkill(bot,task,{check,progress,stage,persist:context.persist,walk,settle,acquire})
 if(task.kind==='construct')return executeConstruction(bot,task,{check,progress,stage,movements,persist:context.persist,place,walk,settle,chooseSite:(point,blueprint)=>fitConstructionSite(bot,blueprint,point,task.goal.protectedSites||[],task.goal.constructionLimits||{})})
 if(task.kind==='prepare'){try{return await prepareTools(bot,task.goal,{acquire,settle,check,progress})}finally{await reclaimTables()}}
 if(task.kind==='make_obsidian'){
  // The bucket fills only from a source cell, and `use` owns the aim and the receipt.
  // goto's digging walk: bounded legs, and it refuses to break anything beside a liquid.
  const dig=(p,range,wade=false)=>walkNear(bot,p,{dig:true,wade,protectedSites:task.goal.protectedSites||[],check,stage,progress,movements,timeoutMs:120000,range})
  const fill=async()=>{
   const fillFrom=async source=>{
    progress(`Filling the bucket at ${key(source)}`)
    // The bucket's own walk cannot tunnel, so close to its range of two with one
    // that can, wading: the cells within reach of a lake are often flowing water.
    await dig(source,2,true);check()
    await useHeldItem(bot,{goal:{item:'bucket',count:1,expect:'',target:{x:source.x,y:source.y,z:source.z,how:'point',dimension:dimensionOf(bot)||'overworld'}}},{check,stage,persist:context.persist,walk,settle,approach:approachPlacement})
   }
   let failure=null
   for(const source of fillableWaterSources(bot).slice(0,3)){
    try{await fillFrom(source);return}catch(error){check();failure=error;progress(`Could not fill at ${key(source)}: ${error.message}`)}
   }
   // Sealed water stays sealed: opening a lake flooded the tunnel twice live.
   throw failure||new Error('No water source a bucket can reach within 32 blocks; bring water from a surface lake or river, or a cave pool open to the air')
  }
  // The stance walk wades too: it usually starts in the pool the bucket was filled from
  // (trial 24's seven stance walks each failed at once from inside that water).
  // Under rock a search leg tunnels at its own depth; the surface walk cannot
  // start from a tunnel (test run 45, 3 October: six legs failed in a minute).
  // A tunnelled leg costs a pickaxe use per block. Only plain pickaxes pay for
  // it: the diamond one wore out this way in the family world (4 October).
  const plainPickUses=()=>bot.inventory.items().filter(i=>/_pickaxe$/.test(i.name)&&!PRECIOUS.test(i.name)).reduce((n,i)=>n+Math.max(0,remainingDurability(i)-TOOL_RESERVE),0)
  const staircase=to=>digStaircase(bot,to,{check,progress,stage,protectedSites:task.goal.protectedSites||[]})
  // Under rock, short of plain pickaxes, make more from what is carried before a leg refuses.
  const travel=async to=>{
   if(!roofed(bot))return travelTo(bot,{kind:'travel',goal:{x:to.x,y:Math.floor(bot.entity.position.y),z:to.z}},{check,stage,progress,movements:walking})
   if(plainPickUses()<SEARCH_TUNNEL_USES)try{await stockTunnelPickaxes(bot,{plainUses:plainPickUses,needed:SEARCH_TUNNEL_USES,underRock:true,acquire,settle,check,progress})}finally{await reclaimTables()}
   if(plainPickUses()<SEARCH_TUNNEL_USES)throw new Error(`plain pickaxes have ${plainPickUses()} uses left, too few to tunnel a search leg; craft a stone pickaxe first`)
   return staircase(new Vec3(to.x,Math.floor(bot.entity.position.y),to.z))
  }
  try{await stockTunnelPickaxes(bot,{plainUses:plainPickUses,needed:SEARCH_TUNNEL_USES,underRock:roofed(bot),acquire,settle,check,progress})}finally{await reclaimTables()}
  return makeObsidian(bot,task,{check,progress,stage,walk,settle,count,persist:context.persist,fill,travel,staircase,mine:(name,total)=>mineExposed(name,total,[task.kind],{accept:b=>takeableObsidian(bot,b.position)}),approach:(p,range)=>dig(p,range,true)})
 }
 if(task.kind==='acquire'){try{await acquire(task.goal.item,task.goal.count)}finally{await reclaimTables()}return {item:task.goal.item,count:count(task.goal.item)}}
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
  if(!origin)throw new Error('No clear supported natural building site within 48 horizontal blocks, including lower ground and doorway access; choose another footprint or meeting point')
  task.goal.origin={x:origin.x,y:origin.y,z:origin.z};context.persist()
 }
 // A creeper at the door takes the ground with it. Put back what is missing
 // under the shelter and its approach before judging the site, nearest solid
 // neighbour first; a block with nothing to stand against waits its turn.
 const gaps=[]
 // The saved base's back-exit cell is its own way down, not a crater (lab
 // run 22: the repair tried to fill the shaft from below and failed).
 const sp=context.shelterProject,shaft=sp?.backExit?.cell&&sp.build?.origin&&['x','y','z'].every(k=>sp.build.origin[k]===origin[k])?sp.backExit.cell:null
 const ownBaseBuild=task.goal?.purpose==='shelter'&&['x','y','z'].every(k=>sp?.build?.origin?.[k]===origin[k])
 const foreign=layout?inspectShelterSite(bot,origin,layout,{repair:true,support:gaps,shaft,clear:ownBaseBuild?plainCube(bot):null}).filter(c=>plainCube(bot)(bot.blockAt(c)||{})):[]
 if(foreign.length&&ownBaseBuild){
  progress(`Clearing ${foreign.length} foreign blocks from inside the base`)
  for(const c of foreign.sort((a,b)=>b.y-a.y)){
   const blk=bot.blockAt(c);if(!blk||blk.name==='air')continue
   if(bot.entity.position.distanceTo(c.offset(.5,.5,.5))>4)await walk(new goals.GoalLookAtBlock(c,bot.world,{reach:4}),false)
   if(bot.tool?.equipForBlock)await bot.tool.equipForBlock(blk,{requireHarvest:false,getFromChest:false})
   check();stage('digging');await bot.dig(blk);check()
  }
  gaps.length=0;inspectShelterSite(bot,origin,layout,{repair:true,support:gaps,shaft})
 }
 if(gaps.length){
  const carried=name=>bot.inventory.items().filter(i=>i.name===name).reduce((n,i)=>n+i.count,0)
  const filler=['cobblestone','dirt','cobbled_deepslate'].find(name=>carried(name)>=gaps.length)||'dirt'
  progress(`Restoring ${gaps.length} missing ground blocks under the shelter with ${filler}`)
  await acquire(filler,gaps.length)
  const pending=gaps.slice().sort((a,b)=>a.y-b.y);let stuck=0
  while(pending.length){
   const gap=pending.shift()
   try{await place(gap,filler);stuck=0}
   catch(e){check();pending.push(gap);if(++stuck>=pending.length)throw new Error(`Could not restore the ground under the shelter at ${key(gap)}: ${e.message}`)}
  }
  inspectShelterSite(bot,origin,layout,{repair:true,shaft})
 }
 const needed={}
 for(const b of resolved){if(bot.blockAt(origin.offset(b.x,b.y,b.z))?.name!==b.block)needed[b.block]=(needed[b.block]||0)+1}
 progress(`Build site ${key(origin)}; sourcing ${Object.values(needed).reduce((a,b)=>a+b,0)} blocks`)
 for(const [name,total] of Object.entries(needed))await acquire(name,total)
 const remaining=resolved.slice()
 // Lower supported blocks first; defer unsupported placements until their
 // neighbours exist. This handles arbitrary connected designs, not house text.
 remaining.sort((a,b)=>a.y-b.y)
 // Report the FIRST failure of a no-progress pass, not the last. The queue is
 // y-ascending and deferred blocks go to the back, so the last error is
 // structurally always a top-layer PLACEMENT_UNSUPPORTED deferral: every build
 // failure in the six-hour run said "No adjacent placement face" and none of
 // them said what actually went wrong.
 let misses=0,verified=0,firstMiss=null
 while(remaining.length){
  const b=remaining.shift(),pos=origin.offset(b.x,b.y,b.z)
  try{progress(`Building ${resolved.length-remaining.length}/${resolved.length}: ${b.block}`);await place(pos,b.block);misses=0;firstMiss=null;task.progress={verifiedBlocks:++verified,origin:task.goal.origin};context.persist()}
  catch(e){check();remaining.push(b);firstMiss??=e.message;if(++misses>=remaining.length)throw new Error(`Build blocked with ${remaining.length} blocks remaining: ${firstMiss}`)}
 }
 const missing=resolved.filter(b=>bot.blockAt(origin.offset(b.x,b.y,b.z))?.name!==b.block)
 if(missing.length)throw new Error(`Build verification failed: ${missing.length} blocks differ`)
 const usability=layout?await finishShelter(bot,origin,layout,chosen,{check,walk,settle,acquire,progress,stage,persist:context.persist,shaft}):null
 return {item:'build',count:resolved.length,origin:task.goal.origin,verifiedBlocks:resolved.length,...(usability?{usability}:{})}
}
