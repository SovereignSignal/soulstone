import {bowCanAnswer} from './bow-readiness.js'
import {observedSightline} from './visibility.js'
import {scaffoldItems,fillCell,plainCube} from './scaffold.js'
import {claimPlaced} from './natural.js'
// Emergency burrow: the shelter of last resort for a spawn with no base and no
// weapon. Seal the verified shaft as soon as three cells give headroom,
// deepen under the cap, then watch protection and surface clearance.
import {setTimeout as delay} from 'node:timers/promises'
import pathfinding from 'mineflayer-pathfinder'
import {Vec3} from 'vec3'
import {DoorAwareMovements,SOFT_GROUND as SOFT,centreOn} from './navigation.js'
import {fullCube} from './construction.js'
import {assertNoHostileOccupants,inspectEmergencyShelter} from './shelter-occupants.js'
import {survivalObservation,RANGED,HEALTH_EMERGENCY_LINE,breachesRock,outOfReach,SHOOTERS_ONLY,threatRadius} from './survival.js'
import {threatReach,threatRoutes} from './threat-reach.js'
import {roofed} from './observations.js'
import {defenseDecision,armorPoints,HEAVY_ARMOR} from './combat.js'
import {walkOnThreat} from './nether-trip.js'
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
// The cap is the carried cube that best survives a blast. A creeper's blast in a cave
// passage took a dirt cap while the bot carried thirty cobblestone, and the next creeper
// dropped down the open shaft onto it. At three to five blocks a blast breaks dirt (0.5)
// for about half its rays, wood (2 to 3) for some and stone-class blocks (6) for none.
// Only the cap and its plug are chosen by strength; the climb out takes inventory order.
// Strength is ranked among plain cubes: ancient debris or crying obsidian resist any blast
// but are worth keeping and slow or impossible to dig back out. Carrying no plain cube,
// the first carried cube still caps, as before: a cap over the bot beats keeping a block.
const resistance=(bot,item)=>bot.registry.blocksByName[item.name]?.resistance??0
function capItem(bot){
 const cubes=scaffoldItems(bot),plain=cubes.filter(plainCube(bot))
 return plain.reduce((best,i)=>!best||resistance(bot,i)>resistance(bot,best)?i:best,null)||cubes[0]||null
}
// A plug in the cell under the cap leaves the bot its feet and head cells and nothing
// more. A mob that clears the cap then stands on the plug, three blocks from the feet
// with no sight of the bot, so a creeper there never fuses. A three-deep shaft has no
// cell between the head and the cap and gets none. Not having one is not a failure:
// the cap alone is verified protection. The plug never takes the last carried cube:
// that one recaps a blown shaft or starts the climb out. Counting cubes is simpler and
// surer than asking whether a carried pickaxe harvests the plug and the cap.
async function plugShaft(bot,cap,{check,progress}){
 const plug=bot.entity.position.floored().offset(0,2,0),item=capItem(bot)
 if(!item||climbBlocks(bot)<2||plug.y>=cap.y||solid(bot,bot.blockAt(plug)))return false
 const plugged=await fillCell(bot,plug,{check,progress,item})
 if(!plugged)progress('Plug under the cap unconfirmed; the cap alone holds')
 return plugged
}
async function settle(predicate,message,{check,ms=3000,poll=50}){
 const end=Date.now()+ms
 while(Date.now()<end){check();if(predicate())return;await delay(poll)}
 throw new Error(message)
}
async function placeCap(bot,cap,cells,{check,progress}){
 assertNoHostileOccupants(bot,cells)
 const item=capItem(bot)
 if(!item)return false
 // The block-update event can be missed through the version bridge; judge the
 // cap by the block being there, and try each solid side as the reference.
 const capped=()=>solid(bot,bot.blockAt(cap))
 await bot.equip(item,'hand');check()
 for(const ref of SIDES.map(([dx,dy,dz])=>bot.blockAt(cap.offset(dx,dy,dz))).filter(b=>solid(bot,b))){
  if(capped())break
  try{await bot.placeBlock(ref,cap.minus(ref.position))}catch(error){check();progress(`Cap placement unconfirmed: ${error.message.slice(0,60)}`)}
  check()
  try{await settle(capped,'cap',{check,ms:1500})}catch{}
  if(capped())break
 }
 if(!capped())return false
 claimPlaced(bot,cap);return true
}
// The last shaft each bot dug. Lab run 57, 5 October: a mob came back while
// the bot was digging out, and every fresh burrow started at the bottom of the
// last one, four deeper each time: y 55 to y 28 in twenty minutes, below the
// lava it was working toward. Still standing in its own shaft, the bot puts
// the cap back instead of digging another under it.
const shafts=new WeakMap()
async function reuseShaft(bot,{check,progress}){
 const shaft=shafts.get(bot),feet=bot.entity?.position?.floored()
 // The cap goes above the head, so the feet must be at least two under it.
 if(!shaft||!feet||feet.x!==shaft.cap.x||feet.z!==shaft.cap.z||feet.y<shaft.bottom||feet.y>shaft.cap.y-2)return null
 const cells=[];for(let y=shaft.cap.y;y>=feet.y;y--)cells.push(new Vec3(feet.x,y,feet.z))
 const open=!solid(bot,bot.blockAt(shaft.cap))
 if(open&&!await placeCap(bot,shaft.cap,cells,{check,progress}))return null
 await plugShaft(bot,shaft.cap,{check,progress})
 let protection
 try{protection=inspectEmergencyShelter(bot)}catch{return null}
 progress(open?'Put the cap back on my shaft; closed burrow verified':'Still in my capped shaft; closed burrow verified')
 const s=survivalObservation(bot),p=bot.entity.position
 return {item:'safety',count:1,receipt:open?'burrow_recapped':'burrow_reentered',protection,shelterName:'burrow',capped:true,position:{x:p.x,y:p.y,z:p.z},
  surface:{x:shaft.surface.x,y:shaft.surface.y,z:shaft.surface.z},cap:{x:shaft.cap.x,y:shaft.cap.y,z:shaft.cap.z},health:s.health,timeOfDay:s.timeOfDay}
}
export async function burrowIn(bot,task,{check,stage,progress,persist=()=>{}}){
 check()
 const reused=await reuseShaft(bot,{check,progress});if(reused)return reused
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
 const seal=()=>placeCap(bot,site.cap,site.cells,{check,progress})
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
 await plugShaft(bot,site.cap,{check,progress})
 const protection=inspectEmergencyShelter(bot),receipt='burrowed_capped'
 shafts.set(bot,{cap:site.cap.clone(),surface:site.surface.clone(),bottom:site.cells.at(-1).y})
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
// Strong enough to walk away from what holds the shelter: sixteen health, or eight
// when waiting cannot heal. The shelter wait's own relocation and the firing ports'
// (lab run 146, 15 October) both ask this.
export function strongEnoughToLeave(bot){
 const s=survivalObservation(bot),canHeal=(s.carriedFood||[]).length>0||Number.isFinite(s.food)&&s.food>=18
 return Number.isFinite(s.health)&&(s.health>=RELOCATE_HEALTH||!canHeal&&s.health>=RELOCATE_FLOOR)
}
// How far the melee mobs must be for a shooter at the wall to be answered from the opened wall.
export const SHOOTER_CONFRONT_STANDOFF=12
// How many shooters at the wall the bow takes on in turn; more is a wait or a relocation.
export const SHOOTERS_AT_WALL=3
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
export function burrowClearance(bot,{lingeredMs=0,patienceMs=CONFRONT_PATIENCE_MS,relocateAfterMs=RELOCATE_PATIENCE_MS,exits=null,trip=false,canPort=false}={}){
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
 // On a trip the margin is the alarm's own radius: the trip fights what comes, so a hostile
 // that would not interrupt the work does not hold the bot in (lab run 142, 14 October:
 // kitted, a portal room, hoglins at fifteen that the alarm ignores, and no way out).
 let near=(s.nearbyThreats||[]).filter(t=>t.risk==='potential_hostile'&&t.distance<=(trip?threatRadius(t.name):RANGED.has(t.name)?24:16))
 // A hostile the exits cannot reach is not waiting outside. The same floors as
 // the interruption rule still count, so leaving never walks into a re-trigger.
 if(exits&&near.length){
  // From the shelter's own exits, by the same test the alarm uses afterwards,
  // so a hostile it ignores is never the one that sends the bot back in.
  const routes=threatRoutes(bot,near,{origins:exits})
  near=near.filter((t,i)=>!outOfReach({...t,reach:routes[i].reach,routeSteps:routes[i].steps,routeAtLeast:routes[i].atLeast,sightline:t.sightline?.status?t.sightline:{status:'blocked'}}))
  // Run 86 (10 October): from inside, the shelter's own walls block every sightline,
  // so a shooter is judged at the exits: one that could not see the bot at any exit
  // is not waiting outside (a blaze behind the fortress's nether bricks).
  const eyeAt=c=>({x:c.x+.5,y:c.y+(bot.entity?.eyeHeight??1.62),z:c.z+.5})
  const hidden=t=>!!t.position&&exits.every(c=>observedSightline(bot,eyeAt(c),{x:t.position.x,y:t.position.y+1,z:t.position.z}).status==='blocked')
  // Only a hut answers a shooter from its exits. Out of a burrow the bot climbs and walks on past
  // where the shaft's column could see (lab run 150, 15 October: in a tunnel those eyes saw only
  // along it, three of four blazes off its walls were "hidden", and two met the bot in clear sight).
  if(canPort)near=near.filter(t=>!(SHOOTERS_ONLY.has(t.name)&&t.distance>4&&hidden(t)))
  // On a trip a mob the alarm walks on outside is not waiting outside either, judged by sight
  // at the exits, or the hut holds the bot over it for good (lab run 148, 15 October).
  if(trip){const seen=near.map(t=>({...t,sightline:{status:hidden(t)?'blocked':'clear'}}));near=near.filter((t,i)=>!walkOnThreat(bot,seen[i],seen))}
 }
 const scope='Loaded entities within 16 blocks and the world clock; not proof of a safe surface'
 if(!near.length)return {clear:true,health:s.health,timeOfDay:s.timeOfDay,scope}
 const lone=near.length===1?near[0]:null
 // Leaving cover to confront requires the executor's current capability
 // checks, including a serviceable weapon and an identified target.
 // Run 86 (10 October): a blaze outside the fortress portal room, a bow and 160 arrows
 // inside, and no exit because the sword could not answer it.
 // A group the fight rules engage (a split magma cube in the Nether kit) is confronted
 // too, nearest first; lab run 135 died beside the pieces of a cube it had already fought.
 const nearest=[...near].sort((a,b)=>a.distance-b.distance)[0]
 // A shooter parked at the wall is answered from the opened wall while the melee mobs
 // are still far (lab run 141, 14 October: a blaze at three blocks, hoglins at fifteen,
 // and "no clear area" for fourteen minutes with a bow and 79 arrows inside).
 // Several shooters are shot in turn, as the ranged chain does in the open (three blazes at
 // the wall by 18:10Z the same run).
 const shooters=near.filter(t=>SHOOTERS_ONLY.has(t.name))
 // A burrow has no port: on a trip, confronting a shooter from one is a climb out with no shot
 // planned (lab run 150, 15 October: a lone blaze confronted, four waiting, dead in ten seconds).
 // Off a trip the armour and bow gates below still open a burrow to a lone skeleton.
 const portless=!canPort&&trip&&shooters.length>0
 // At a spawner the count never falls: the bot in cover keeps the spawner active and the
 // blazes pile up at the wall (lab run 144, 14 October: six at four blocks through the
 // window). On a trip, with the kit, shooters are answered whatever their number; the
 // ranged chain takes four at a time and the cover is judged again between chains.
 const shooterAtWall=!lone&&shooters.length>0&&(trip||shooters.length<=SHOOTERS_AT_WALL)&&shooters.includes(nearest)&&shooters.every(t=>bowCanAnswer(bot,t.name))&&near.every(t=>SHOOTERS_ONLY.has(t.name)||t.distance>=SHOOTER_CONFRONT_STANDOFF)
 // A sword answers nothing past arm's reach: every shooter waiting outside gets its arrows
 // in while the bot climbs out and closes, and more arrive meanwhile. A measured death:
 // iron sword, no armour, no bow, a lone skeleton at 8.9 blocks; the bot opened up, and a
 // second skeleton and a creeper came. So a melee exit with a shooter near needs a bow that
 // answers it or the armour the heavy fights ask for, iron with golden boots or better
 // (14 points), which takes about half off each arrow; an iron chestplate alone, a sixth.
 const armoured=armorPoints(bot)>=HEAVY_ARMOR
 // The gate holds only while waiting can heal: hungry with no food, waiting is the slower
 // death (a blaze at the wall or a skeleton parked inside ten blocks never leaves, and
 // relocation needs ten blocks clear), so the sword confronts as it did before.
 const meleeReady=defenseDecision(bot).engage&&(!canHeal||near.every(t=>!SHOOTERS_ONLY.has(t.name)||armoured||bowCanAnswer(bot,t.name)))
 const ready=!portless&&(!!lone&&bowCanAnswer(bot,lone.name)||shooterAtWall||meleeReady)
 if(!ready){
  // Neither fight nor hide. Unarmed against numbers or a crossbow, healthy, in
  // daylight, with nothing in melee reach and the threat sat still past the
  // patience window: the judgement a player makes here is to leave.
  const closest=near.reduce((m,t)=>Math.min(m,t.distance),Infinity)
  if(lingeredMs>=relocateAfterMs&&strongEnoughToLeave(bot)&&closest>=RELOCATE_STANDOFF&&near.every(t=>t.position))
   return {clear:true,relocate:{threats:near,from:centre(near)},health:s.health,timeOfDay:s.timeOfDay,scope,
    reason:`${near.length===1?`A ${near[0].name}`:`${near.length} hostiles`} held station for ${Math.round(lingeredMs/1000)} seconds and will not disperse; surfacing to move away rather than wait them out`}
  return {clear:false,lingering:true,reason:portless?'A shooter waits outside and a burrow has no port; holding':'A potential hostile remains within 16 blocks',threats:near}
 }
 if(lingeredMs<patienceMs)return {clear:false,lingering:true,reason:`${lone?`A lone ${lone.name} lingers`:`${near.length} hostiles I can fight linger`} within 16 blocks in daylight; confronting after ${Math.round(patienceMs/1000)} seconds`,threats:near}
 return {clear:true,confront:lone||nearest,health:s.health,timeOfDay:s.timeOfDay,reason:lone?`A lone ${lone.name} has lingered ${Math.round(lingeredMs/1000)} seconds into daylight; surfacing to confront it`:`${near.length} hostiles I can fight have lingered ${Math.round(lingeredMs/1000)} seconds; surfacing to fight them, nearest first`,scope}
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
   if(bot.entity.position.y-feet.y>=0.9){try{await bot.placeBlock(floor,new Vec3(0,1,0))}catch{}placed=solid(bot,bot.blockAt(feet));if(placed)claimPlaced(bot,feet)}
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
