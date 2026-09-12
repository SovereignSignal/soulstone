// Emergency burrow: the shelter of last resort for a spawn with no base and no
// weapon. Dig three cells straight down through a verified column, cap the shaft
// with the dug earth, wait for daylight, then tunnel and pillar back out.
import {setTimeout as delay} from 'node:timers/promises'
import pathfinding from 'mineflayer-pathfinder'
import {DoorAwareMovements} from './navigation.js'
import {fullCube} from './construction.js'
import {survivalObservation} from './survival.js'
const {goals}=pathfinding
export const BURROW_DEPTH=3
const SOFT=new Set(['grass_block','dirt','coarse_dirt','podzol','rooted_dirt','mud','sand','red_sand','gravel','clay','moss_block','snow_block','mycelium'])
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
 const cells=[];for(let d=1;d<=BURROW_DEPTH;d++)cells.push(feet.offset(0,-d,0))
 for(const [index,c] of cells.entries()){
  const b=bot.blockAt(c);if(!b)return {ok:false,reason:'Ground below is not observed'}
  if(!(SOFT.has(b.name)||pickaxe&&HARD.has(b.name)))return {ok:false,reason:`Cannot dig ${b.name} quickly at ${key(c)}`}
  const walls=SIDES.map(([dx,dy,dz])=>({at:c.offset(dx,dy,dz),block:bot.blockAt(c.offset(dx,dy,dz))}))
  if(walls.some(w=>LIQUID.has(w.block?.name)))return {ok:false,reason:`Liquid beside the burrow at ${key(c)}`}
  // The top cell is refilled by the cap and only needs one wall to place against.
  if(index===0){if(!walls.some(w=>solid(bot,w.block)))return {ok:false,reason:`No solid wall to place the cap against at ${key(c)}`};continue}
  const open=walls.find(w=>!solid(bot,w.block));if(open)return {ok:false,reason:`Burrow wall at ${key(open.at)} is not solid`}
 }
 const floor=feet.offset(0,-BURROW_DEPTH-1,0)
 if(!solid(bot,bot.blockAt(floor)))return {ok:false,reason:'No solid floor below the burrow'}
 return {ok:true,surface:feet,cells,cap:cells[0]}
}
// Spawn points sit on uneven ground: when the column underfoot fails, try the
// eight neighbouring standable columns before giving up.
export function findBurrowColumn(bot){
 const here=burrowSite(bot);if(here.ok)return {site:here,move:null}
 const feet=bot.entity.position.floored(),reasons=[here.reason]
 for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]){
  const o=feet.offset(dx,0,dz)
  const standable=bot.blockAt(o)?.name==='air'&&bot.blockAt(o.offset(0,1,0))?.name==='air'&&solid(bot,bot.blockAt(o.offset(0,-1,0)))
  if(!standable)continue
  const site=burrowSite(bot,o);if(site.ok)return {site,move:o}
  reasons.push(site.reason)
 }
 return {site:null,reasons}
}
function capItem(bot){
 return bot.inventory.items().find(i=>fullCube(bot.registry,i.name)&&!GRAVITY.has(i.name))||null
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
  const timer=setTimeout(()=>bot.pathfinder.setGoal(null),6000)
  try{await bot.pathfinder.goto(new goals.GoalBlock(found.move.x,found.move.y,found.move.z))}finally{clearTimeout(timer)}
  check();site=burrowSite(bot,found.move);if(!site.ok)throw new Error('No safe burrow here: '+site.reason)
 }
 // Stand squarely over the column: a bot straddling the edge does not drop.
 const centre=site.surface.offset(.5,0,.5)
 if(Math.abs(bot.entity.position.x-centre.x)>.3||Math.abs(bot.entity.position.z-centre.z)>.3){
  const timer=setTimeout(()=>bot.pathfinder.setGoal(null),3000)
  try{await bot.pathfinder.goto(new goals.GoalBlock(site.surface.x,site.surface.y,site.surface.z))}catch{}finally{clearTimeout(timer)}
  check()
 }
 bot.pathfinder?.setGoal(null);bot.clearControlStates?.()
 stage('burrowing');progress('Digging in to wait out the danger')
 const inColumn=()=>{const p=bot.entity.position;return Math.floor(p.x)===site.surface.x&&Math.floor(p.z)===site.surface.z}
 for(const [index,c] of site.cells.entries()){
  check();const block=bot.blockAt(c)
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
  await settle(()=>Math.floor(bot.entity.position.y)<=c.y&&inColumn()&&bot.entity.onGround!==false,`Did not land in the dug cell at ${key(c)}`,{check})
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
 let receipt='burrowed_open'
 const cap=capItem(bot)
 if(cap){
  const ref=SIDES.map(([dx,dy,dz])=>bot.blockAt(site.cap.offset(dx,dy,dz))).find(b=>solid(bot,b))
  if(ref){
   await bot.equip(cap,'hand');check()
   await bot.placeBlock(ref,site.cap.minus(ref.position));check()
   await settle(()=>solid(bot,bot.blockAt(site.cap)),'Burrow cap placement was not confirmed',{check})
   receipt='burrowed_capped'
  }
 }
 progress(receipt==='burrowed_capped'?'Dug in and capped; waiting for daylight':'Dug in without a cap block; waiting for daylight')
 const s=survivalObservation(bot),p=bot.entity.position
 return {item:'safety',count:1,receipt,shelterName:'burrow',capped:receipt==='burrowed_capped',position:{x:p.x,y:p.y,z:p.z},
  surface:{x:site.surface.x,y:site.surface.y,z:site.surface.z},cap:{x:site.cap.x,y:site.cap.y,z:site.cap.z},health:s.health,timeOfDay:s.timeOfDay}
}
// Daylight is 1000–12000 ticks: undead burn and nothing new spawns on the surface.
export function burrowClearance(bot){
 const s=survivalObservation(bot)
 if(!Number.isFinite(s.timeOfDay))return {clear:false,reason:'Time of day is unknown'}
 if(s.timeOfDay<1000||s.timeOfDay>=12000)return {clear:false,reason:'Waiting for daylight'}
 // Without food there is no regeneration, so a low floor beats waiting forever.
 if(!Number.isFinite(s.health)||s.health<4)return {clear:false,reason:'Health is too low to leave the burrow'}
 const near=(s.nearbyThreats||[]).filter(t=>t.distance<=16)
 if(near.length)return {clear:false,reason:'A potential hostile remains within 16 blocks',threats:near}
 return {clear:true,health:s.health,timeOfDay:s.timeOfDay,scope:'Loaded entities within 16 blocks and the world clock; not proof of a safe surface'}
}
export async function unburrow(bot,task,{check,stage,progress}){
 check();const {surface}=task.goal
 const movement=new DoorAwareMovements(bot)
 Object.assign(movement,{canDig:true,allow1by1towers:true,allowParkour:false,allowSprinting:false,maxDropDown:1,
  scafoldingBlocks:[...new Set(bot.inventory.items().filter(i=>fullCube(bot.registry,i.name)&&!GRAVITY.has(i.name)).map(i=>bot.registry.blocksByName[i.name]?.id).filter(Number.isInteger))]})
 stage('surfacing');progress('Digging back out to the surface')
 bot.pathfinder.setMovements(movement)
 const goal=new goals.GoalBlock(surface.x,surface.y,surface.z)
 const timer=setTimeout(()=>bot.pathfinder.setGoal(null),60000)
 try{await bot.pathfinder.goto(goal)}finally{clearTimeout(timer)}
 check()
 const p=bot.entity.position.floored()
 if(p.y<surface.y||p.distanceTo(surface)>2)throw new Error(`Did not reach the surface cell at ${key(surface)}; now at ${key(p)}`)
 return {item:'safety',count:1,receipt:'surfaced',position:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z}}
}
