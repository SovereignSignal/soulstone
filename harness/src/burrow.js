import {scaffoldItems} from './scaffold.js'
// Emergency burrow: the shelter of last resort for a spawn with no base and no
// weapon. Seal the verified shaft as soon as three cells give headroom,
// deepen under the cap, then watch protection and surface clearance.
import {setTimeout as delay} from 'node:timers/promises'
import pathfinding from 'mineflayer-pathfinder'
import {Vec3} from 'vec3'
import {DoorAwareMovements,SOFT_GROUND as SOFT,centreOn} from './navigation.js'
import {fullCube} from './construction.js'
import {assertNoHostileOccupants,inspectEmergencyShelter} from './shelter-occupants.js'
import {survivalObservation,RANGED,HEALTH_EMERGENCY_LINE,breachesRock} from './survival.js'
import {threatReach} from './threat-reach.js'
import {roofed} from './observations.js'
import {defenseDecision} from './combat.js'
const {goals}=pathfinding
// Four deep keeps a creeper standing on the rim outside its three-block
// trigger distance; the cap goes on the top cell so nothing can drop in.
export const BURROW_DEPTH=4
export const BURROW_MIN_DEPTH=3
const HARD=new Set(['stone','andesite','diorite','granite','tuff','deepslate','sandstone','red_sandstone','cobblestone','cobbled_deepslate','terracotta','netherrack'])
const LIQUID=new Set(['water','lava','bubble_column'])
const GRAVITY=new Set(['sand','red_sand','gravel','suspicious_sand','suspicious_gravel'])
const SIDES=[[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]
const solid=(bot,b)=>!!b&&fullCube(bot.registry,b.name)&&!LIQUID.has(b.name)
const key=p=>`${p.x},${p.y},${p.z}`

export function burrowSite(bot,origin=bot.entity?.position?.floored()){
 const p=bot.entity?.position
 if(!p||!bot.entity.onGround)return {ok:false,reason:'Not standing on solid ground'}
 const feet=origin,pickaxe=bot.inventory.items().some(i=>/_pickaxe$/.test(i.name))
 if(!feet)return {ok:false,reason:'Position is unknown'}
 // Take four cells when the soft layer allows, three at least: a capped shaft
 // three deep already breaks a creeper's line of sight.
 const cells=[];let stopped=null
 for(let d=1;d<=BURROW_DEPTH;d++){
  const c=feet.offset(0,-d,0),b=bot.blockAt(c)
  if(!b)return {ok:false,reason:'Ground below is not observed'}
  if(!(SOFT.has(b.name)||pickaxe&&HARD.has(b.name))){stopped=`Cannot dig ${b.name} quickly at ${key(c)}`;break}
  cells.push(c)
 }
 if(cells.length<BURROW_MIN_DEPTH)return {ok:false,reason:`Only ${cells.length} diggable cells below; at least ${BURROW_MIN_DEPTH} needed (${stopped||'shallow'})`}
 for(const [index,c] of cells.entries()){
  const walls=SIDES.map(([dx,dy,dz])=>({at:c.offset(dx,dy,dz),block:bot.blockAt(c.offset(dx,dy,dz))}))
  if(walls.some(w=>LIQUID.has(w.block?.name)))return {ok:false,reason:`Liquid beside the burrow at ${key(c)}`}
  // The top cell is refilled by the cap and only needs one wall to place against.
  if(index===0){if(!walls.some(w=>solid(bot,w.block)))return {ok:false,reason:`No solid wall to place the cap against at ${key(c)}`};continue}
  const open=walls.find(w=>!solid(bot,w.block));if(open)return {ok:false,reason:`Burrow wall at ${key(open.at)} is not solid`}
 }
 const floor=feet.offset(0,-cells.length-1,0)
 if(!solid(bot,bot.blockAt(floor)))return {ok:false,reason:'No solid floor below the burrow'}
 // Sand and gravel are diggable but cannot be climbed on or capped with, so a
 // sand column entombs the bot in an open shaft: the entry approves material
 // every exit refuses. Require something to climb out on before digging in.
 const loose=cells.every(c=>GRAVITY.has(bot.blockAt(c)?.name))
 if(loose&&climbBlocks(bot)<cells.length)return {ok:false,reason:`Loose ${bot.blockAt(cells[0])?.name} column and only ${climbBlocks(bot)} solid blocks carried; ${cells.length} are needed to climb back out`}
 return {ok:true,surface:feet,cells,cap:cells[0]}
}
// Spawn points sit on uneven ground: when the column underfoot fails, try the
// eight neighbouring standable columns before giving up.
export function findBurrowColumn(bot){
 const here=burrowSite(bot);if(here.ok)return {site:here,move:null}
 const feet=bot.entity.position.floored(),reasons=[here.reason]
 for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]){
  const o=feet.offset(dx,0,dz)
  // Cave air, grass and flowers are all standable; demanding the literal name
  // 'air' rejected every cave and meadow cell the bot could have dug from.
  const passable=b=>!!b&&(b.name==='air'||b.name==='cave_air'||b.boundingBox==='empty'&&!LIQUID.has(b.name))
  const standable=passable(bot.blockAt(o))&&passable(bot.blockAt(o.offset(0,1,0)))&&solid(bot,bot.blockAt(o.offset(0,-1,0)))
  if(!standable)continue
  const site=burrowSite(bot,o);if(site.ok)return {site,move:o}
  reasons.push(site.reason)
 }
 return {site:null,reasons}
}
export const climbBlocks=bot=>scaffoldItems(bot).reduce((n,i)=>n+i.count,0)
function capItem(bot){
 return scaffoldItems(bot)[0]||null
}
async function settle(predicate,message,{check,ms=3000,poll=50}){
 const end=Date.now()+ms
 while(Date.now()<end){check();if(predicate())return;await delay(poll)}
 throw new Error(message)
}
export async function burrowIn(bot,task,{check,stage,progress,persist=()=>{}}){
 check();const found=findBurrowColumn(bot)
 if(!found.site)throw new Error('No safe burrow here: '+found.reasons[0])
 let site=found.site
 if(found.move){
  progress('Stepping to a sound column to dig in');stage('walking')
  // Our own deadline clears the goal, which rejects the in-flight goto as
  // GoalChanged. Name it Timeout: this is an emergency path and a stalled step
  // is worth retrying, not terminal.
  let expired=false
  const timer=setTimeout(()=>{expired=true;bot.pathfinder.setGoal(null)},6000)
  try{await bot.pathfinder.goto(new goals.GoalBlock(found.move.x,found.move.y,found.move.z))}
  catch(error){if(expired)throw Object.assign(new Error('Stepping to the burrow column timed out'),{name:'Timeout'});throw error}
  finally{clearTimeout(timer)}
  check();site=burrowSite(bot,found.move);if(!site.ok)throw new Error('No safe burrow here: '+site.reason)
 }
 // Stand squarely over the column: the body is 0.6 wide, so more than 0.2 off
 // centre leaves an edge on the neighbouring block and the bot never drops.
 // The pathfinder already considers the bot "at" its own cell, so nudge directly.
 bot.pathfinder?.setGoal(null);bot.clearControlStates?.()
 await centreOn(bot,site.surface,check)
 stage('burrowing');progress('Digging in to wait out the danger')
 const inColumn=()=>{const p=bot.entity.position;return Math.floor(p.x)===site.surface.x&&Math.floor(p.z)===site.surface.z}
 async function seal(){
  assertNoHostileOccupants(bot,site.cells)
  const cap=capItem(bot)
  if(cap){
   // The block-update event can be missed through the version bridge; judge the
   // cap by the block being there, and try each solid side as the reference.
   const capped=()=>solid(bot,bot.blockAt(site.cap))
   await bot.equip(cap,'hand');check()
   for(const ref of SIDES.map(([dx,dy,dz])=>bot.blockAt(site.cap.offset(dx,dy,dz))).filter(b=>solid(bot,b))){
    if(capped())break
    try{await bot.placeBlock(ref,site.cap.minus(ref.position))}catch(error){check();progress(`Cap placement unconfirmed: ${error.message.slice(0,60)}`)}
    check()
    try{await settle(capped,'cap',{check,ms:1500})}catch{}
    if(capped())break
   }
   if(capped())return true
  }
  return false
 }
 let sealed=false
 for(const [index,c] of site.cells.entries()){
  check();assertNoHostileOccupants(bot,site.cells);const block=bot.blockAt(c)
  if(block&&block.name!=='air'){
   if(bot.tool?.equipForBlock)await bot.tool.equipForBlock(block,{requireHarvest:false,getFromChest:false})
   check();await bot.dig(block);check()
  }
  // A hit can knock the bot off the shaft; step back over it before dropping.
  if(!inColumn()){
   const timer=setTimeout(()=>bot.pathfinder.setGoal(null),4000)
   try{await bot.pathfinder.goto(new goals.GoalBlock(c.x,c.y,c.z))}catch{}finally{clearTimeout(timer)}
   check()
  }
  // Mining while airborne is five times slower: land before the next dig.
  try{await settle(()=>Math.floor(bot.entity.position.y)<=c.y&&inColumn()&&bot.entity.onGround!==false,`Did not land in the dug cell at ${key(c)}`,{check})}
  catch(error){
   check();if(index>0)throw error
   // Still on the rim after the first dig: re-centre over the open cell and step in.
   progress('Re-centring over the shaft');await centreOn(bot,c,check);check()
   await settle(()=>Math.floor(bot.entity.position.y)<=c.y&&inColumn()&&bot.entity.onGround!==false,`Did not land in the dug cell at ${key(c)}`,{check})
  }
  // Close the entrance before spending another dig exposed to pursuit.
  if(index+1===BURROW_MIN_DEPTH&&capItem(bot)){
   sealed=await seal()
   if(!sealed)throw new Error('Burrow cap could not be verified; protection is not established')
  }
  task.progress={cells:index+1,of:site.cells.length,health:bot.health};persist()
  progress(`Dug ${index+1}/${site.cells.length}; health ${bot.health}`)
 }
 await delay(250);check()
 // An explosion can destroy the dug earth. Take one block from the bottom wall
 // where a solid block stands behind it; that level is out of any mob's reach.
 if(!capItem(bot)){
  const bottom=site.cells.at(-1)
  for(const [dx,dy,dz] of SIDES){
   const s=bottom.offset(dx,dy,dz),sb=bot.blockAt(s)
   if(!sb||!SOFT.has(sb.name)||GRAVITY.has(sb.name)||!solid(bot,bot.blockAt(s.offset(dx,0,dz)))||!solid(bot,bot.blockAt(s.offset(0,1,0))))continue
   check();await bot.dig(sb);check();await delay(400);check()
   if(capItem(bot))break
  }
 }
 if(!sealed)sealed=await seal()
 if(!sealed)throw new Error('Burrow cap could not be verified; protection is not established')
 const protection=inspectEmergencyShelter(bot),receipt='burrowed_capped'
 progress('Closed, unoccupied burrow verified; watching protection and the surface')
 const s=survivalObservation(bot),p=bot.entity.position
 return {item:'safety',count:1,receipt,protection,shelterName:'burrow',capped:receipt==='burrowed_capped',position:{x:p.x,y:p.y,z:p.z},
  surface:{x:site.surface.x,y:site.surface.y,z:site.surface.z},cap:{x:site.cap.x,y:site.cap.y,z:site.cap.z},health:s.health,timeOfDay:s.timeOfDay}
}
// Daylight is 1000–12000 ticks: undead burn and nothing new spawns on the surface.
// Daylight judgement: a lone zombie, husk, spider or skeleton that lingers
// near the shaft in full daylight, with the bot at fighting health and food,
// is confronted after a patience window rather than waited out. It may be
// roofed or stuck and would otherwise hold the bot underground all day.
export const CONFRONT_PATIENCE_MS=60000
// A threat that will not leave is not waited out. A pillager outpost never
// disperses, so a bot waiting for a clear area waits for ever: the observation
// window times out into "resume is required", which for an agent working
// unattended is a dead end. Found live, buried at y=62 with three pillagers
// holding station twelve blocks up the hill, on a run with nobody watching.
export const RELOCATE_PATIENCE_MS=240000
export const RELOCATE_HEALTH=16
// Waiting is only worth doing if waiting can improve something. Hurt, carrying no
// food and below the hunger regeneration needs, health does not come back under
// the cap, so sixteen is a number the agent can never reach and the judgement to
// leave never comes due. Found live: walled in at twelve health with two
// pillagers holding, it stayed buried for an hour, never surfaced, never planned
// and so never got the food that was the only way out. The low-health floor a few
// lines above already waives itself the same way when healing is impossible.
export const RELOCATE_FLOOR=8
export const RELOCATE_STANDOFF=10
const centre=threats=>({
 x:Math.round(threats.reduce((n,t)=>n+t.position.x,0)/threats.length),
 y:Math.round(threats.reduce((n,t)=>n+t.position.y,0)/threats.length),
 z:Math.round(threats.reduce((n,t)=>n+t.position.z,0)/threats.length)})
// The cells a shelter opens onto: beyond each wall of a hut at feet and head
// height, and the column above a burrow's cap.
export function shelterExits(retreat){
 const s=retreat?.surface
 if(!s)return null
 const at=new Vec3(s.x,s.y,s.z)
 if(retreat.shelterName==='hut')return [[1,0],[-1,0],[0,1],[0,-1]].flatMap(([dx,dz])=>[at.offset(dx*2,0,dz*2),at.offset(dx*2,1,dz*2)])
 return [at,at.offset(0,1,0),at.offset(0,2,0)]
}
export function burrowClearance(bot,{lingeredMs=0,patienceMs=CONFRONT_PATIENCE_MS,relocateAfterMs=RELOCATE_PATIENCE_MS,exits=null}={}){
 const s=survivalObservation(bot)
 if(!Number.isFinite(s.timeOfDay))return {clear:false,reason:'Time of day is unknown'}
 // Dawn is coming whatever we do, so waiting for it is not the window's business.
 // Daylight is a surface matter: under rock there is no sunrise to wait for.
 if((s.timeOfDay<1000||s.timeOfDay>=12000)&&!roofed(bot))return {clear:false,holding:true,reason:'Waiting for daylight'}
 // The floor only helps if waiting can actually heal: regeneration needs hunger
 // eighteen or carried food. Hurt, hungry and empty-handed, staying under the
 // cap is a slower death than surfacing in daylight with nothing in sight.
 const canHeal=(s.carriedFood||[]).length>0||Number.isFinite(s.food)&&s.food>=18
 if(!Number.isFinite(s.health))return {clear:false,reason:'Health is unknown'}
 // Leaving below the line that sent the bot in only walks it back into the
 // same emergency: hold while healing is possible and health is at or under it.
 if(s.health<=HEALTH_EMERGENCY_LINE&&canHeal)return {clear:false,reason:'Health is at or below the emergency line; healing before leaving the burrow'}
 // Leave a margin beyond a ranged mob's reach: surfacing with a pillager at
 // seventeen blocks is surfacing into its firing line.
 let near=(s.nearbyThreats||[]).filter(t=>t.risk==='potential_hostile'&&t.distance<=(RANGED.has(t.name)?24:16))
 // A hostile the exits cannot reach is not waiting outside. The same floors as
 // the interruption rule still count, so leaving never walks into a re-trigger.
 if(exits&&near.length){const reach=threatReach(bot,near,{origins:exits});near=near.filter((t,i)=>reach[i]!=='sealed'||breachesRock(t))}
 const scope='Loaded entities within 16 blocks and the world clock; not proof of a safe surface'
 if(!near.length)return {clear:true,health:s.health,timeOfDay:s.timeOfDay,scope}
 const lone=near.length===1?near[0]:null
 // Leaving cover to confront requires the executor's current capability
 // checks, including a serviceable weapon and an identified target.
 const ready=!!lone&&defenseDecision(bot).engage
 if(!ready){
  // Neither fight nor hide. Unarmed against numbers or a crossbow, healthy, in
  // daylight, with nothing in melee reach and the threat sat still past the
  // patience window: the judgement a player makes here is to leave.
  const closest=near.reduce((m,t)=>Math.min(m,t.distance),Infinity)
  const strongEnough=s.health>=RELOCATE_HEALTH||!canHeal&&s.health>=RELOCATE_FLOOR
  if(lingeredMs>=relocateAfterMs&&strongEnough&&closest>=RELOCATE_STANDOFF&&near.every(t=>t.position))
   return {clear:true,relocate:{threats:near,from:centre(near)},health:s.health,timeOfDay:s.timeOfDay,scope,
    reason:`${near.length===1?`A ${near[0].name}`:`${near.length} hostiles`} held station for ${Math.round(lingeredMs/1000)} seconds and will not disperse; surfacing to move away rather than wait them out`}
  return {clear:false,lingering:true,reason:'A potential hostile remains within 16 blocks',threats:near}
 }
 if(lingeredMs<patienceMs)return {clear:false,lingering:true,reason:`A lone ${lone.name} lingers within 16 blocks in daylight; confronting it after ${Math.round(patienceMs/1000)} seconds`,threats:near}
 return {clear:true,confront:lone,health:s.health,timeOfDay:s.timeOfDay,reason:`A lone ${lone.name} has lingered ${Math.round(lingeredMs/1000)} seconds into daylight; surfacing to confront it`,scope}
}
// Manual climb for when the pathfinder will not tower out of a capped shaft:
// dig whatever sits two above the feet, jump, place a carried full cube
// beneath at the apex, and repeat until standing at the surface level.
export async function climbOut(bot,surface,{check,stage,progress},{attempts=16}={}){
 const material=()=>scaffoldItems(bot)[0]
 stage('climbing');progress('Climbing out by jumping and placing blocks beneath')
 let stalls=0
 for(let tries=0;Math.floor(bot.entity.position.y)<surface.y&&tries<attempts;tries++){
  check();bot.pathfinder?.setGoal(null)
  const feet=bot.entity.position.floored()
  const above=bot.blockAt(feet.offset(0,2,0))
  if(above&&above.name!=='air'&&!LIQUID.has(above.name)){
   if(bot.tool?.equipForBlock)await bot.tool.equipForBlock(above,{requireHarvest:false,getFromChest:false})
   check();await bot.dig(above);check()
  }
  const block=material();if(!block)throw new Error('No carried block to climb with')
  await bot.equip(block,'hand');check()
  const floor=bot.blockAt(feet.offset(0,-1,0))
  if(bot.lookAt)await bot.lookAt(feet.offset(.5,-.5,.5),true)
  bot.setControlState('jump',true)
  const end=Date.now()+1500;let placed=false
  while(Date.now()<end&&!placed){
   check()
   if(bot.entity.position.y-feet.y>=0.9){try{await bot.placeBlock(floor,new Vec3(0,1,0))}catch{}placed=solid(bot,bot.blockAt(feet))}
   if(!placed)await delay(30)
  }
  bot.setControlState('jump',false)
  try{await settle(()=>Math.floor(bot.entity.position.y)>=feet.y+1&&bot.entity.onGround!==false,'Did not land on the placed block',{check,ms:2000})}catch{}
  // Two attempts in a row without rising means the jump or the placement is not working here.
  if(Math.floor(bot.entity.position.y)<feet.y+1){if(++stalls>=2)break;await delay(200)}else stalls=0
 }
 if(Math.floor(bot.entity.position.y)<surface.y)throw new Error(`Climb stalled at ${key(bot.entity.position.floored())}`)
}
export async function unburrow(bot,task,{check,stage,progress}){
 check();const {surface}=task.goal
 const movement=new DoorAwareMovements(bot)
 Object.assign(movement,{canDig:true,allow1by1towers:true,allowParkour:false,allowSprinting:false,maxDropDown:1,
  scafoldingBlocks:[...new Set(scaffoldItems(bot).map(i=>bot.registry.itemsByName[i.name]?.id??i.type).filter(Number.isInteger))]}) // item ids: the pathfinder matches item.type, not the block table
 stage('surfacing');progress('Digging back out to the surface')
 bot.pathfinder.setMovements(movement)
 const goal=new goals.GoalBlock(surface.x,surface.y,surface.z)
 // The pathfinder can reject after the bot is already out ("Took to long to
 // decide path"). Judge the exit by where the bot stands, not by the promise.
 const timer=setTimeout(()=>bot.pathfinder.setGoal(null),60000)
 let pathError=null
 try{await bot.pathfinder.goto(goal)}catch(error){pathError=error}finally{clearTimeout(timer)}
 check()
 let p=bot.entity.position.floored(),climbed=false
 if(p.y<surface.y){
  progress(`Pathfinder did not climb out${pathError?` (${pathError.message.slice(0,50)})`:''}; climbing manually`)
  await climbOut(bot,surface,{check,stage,progress});climbed=true;p=bot.entity.position.floored()
 }
 if(p.y<surface.y||p.distanceTo(surface)>2)throw new Error(`Did not reach the surface cell at ${key(surface)}; now at ${key(p)}${pathError?` (${pathError.message})`:''}`)
 return {item:'safety',count:1,receipt:'surfaced',climbed,position:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z}}
}
