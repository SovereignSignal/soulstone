// Sleep: the survival skill that removes the night entirely. A slept night sets
// the spawn point, skips the most dangerous hours, and clears the phantom timer
// that had been sending winged mobs at the bot every third day.
import {setTimeout as delay} from 'node:timers/promises'
import pathfinding from 'mineflayer-pathfinder'
import {Vec3} from 'vec3'
import {DoorAwareMovements} from './navigation.js'
import {shelterLayout} from './shelter.js'
import {survivalObservation} from './survival.js'
import {dimensionOf} from './dimension.js'
const {goals}=pathfinding
export const SLEEP_START=12541,SLEEP_END=23458
const isBed=b=>!!b&&/_bed$/.test(b.name)
const air=b=>!!b&&b.name==='air'
const solid=b=>!!b&&b.boundingBox==='block'
const point=p=>new Vec3(p.x,p.y,p.z)
export const sleepable=observation=>!!observation&&(observation.thunderstorm===true||Number.isFinite(observation.timeOfDay)&&observation.timeOfDay>=SLEEP_START&&observation.timeOfDay<=SLEEP_END)
// Two adjacent interior cells with a solid floor, clear headroom, away from the
// doorway approach and from any recorded station, so the bed blocks nothing.
export function bedSite(bot,project){
 const build=project?.build;if(!build?.origin||!build.design)return null
 const o=point(build.origin),layout=shelterLayout(build.design)
 const reserved=Object.values(project.stations||{}).map(s=>`${s.position.x},${s.position.y},${s.position.z}`)
 const free=p=>air(bot.blockAt(p))&&air(bot.blockAt(p.offset(0,1,0)))&&solid(bot.blockAt(p.offset(0,-1,0)))&&!reserved.includes(`${p.x},${p.y},${p.z}`)
 // The approach cells are outside the walls, so filtering on them excluded
 // nothing. What must stay clear is the doorway mouth inside the room and the
 // cell behind it, or the bed blocks the only way in and out.
 const mouth=layout.door.minus(layout.out)
 const doorway=new Set([mouth,mouth.minus(layout.out)].map(p=>`${o.x+p.x},${o.z+p.z}`))
 const inside=layout.inside.map(p=>o.plus(p))
 const pair=cells=>{
  for(const foot of cells)for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]){
   const head=foot.offset(dx,0,dz)
   if(!cells.some(c=>c.equals(head)))continue
   if(free(foot)&&free(head))return {foot,head,facing:new Vec3(dx,0,dz)}
  }
  return null
 }
 // Keep the doorway clear when the room allows it. A four-by-four starter hut
 // has four interior cells and one holds the torch, so insisting on it would
 // mean never sleeping at all; there, the doorway cells are used.
 return pair(inside.filter(p=>!doorway.has(`${p.x},${p.z}`)))||pair(inside)
}
export async function sleepThroughNight(bot,task,{check,stage,progress}){
 check()
 const here=dimensionOf(bot)
 if(here&&here!=='overworld')throw new Error(`A bed explodes in the ${here.replace('the_','')}; sleep only in the Overworld`)
 const observed=survivalObservation(bot)
 const thunderstorm=!!bot.isRaining&&bot.thunderState>0
 if(!sleepable({...observed,thunderstorm}))throw new Error('Not night; a bed can only be used after dusk or in a thunderstorm')
 const near=(observed.nearbyThreats||[]).filter(t=>t.risk==='potential_hostile'&&t.distance<=8)
 if(near.length)throw new Error(`Cannot sleep with a ${near[0].name} ${near[0].distance} blocks away`)
 const project=task.goal?.project
 let bed=bot.findBlock?.({matching:b=>isBed(b),maxDistance:16})||null
 if(!bed){
  const carried=bot.inventory.items().find(i=>/_bed$/.test(i.name))
  if(!carried)throw new Error('No bed here and none carried; craft one from three wool and three planks')
  const site=bedSite(bot,project)
  if(!site)throw new Error('No clear pair of interior cells at the base for a bed')
  stage('walking')
  const movement=new DoorAwareMovements(bot)
  Object.assign(movement,{canDig:false,allow1by1towers:false,allowParkour:false,allowSprinting:false,scafoldingBlocks:[],maxDropDown:1})
  bot.pathfinder.setMovements(movement)
  // GoalNear with range one is already satisfied while standing on the target
  // cell, and a bed cannot be placed into the block the bot occupies.
  const occupies=p=>bot.entity.position.floored().equals(p)
  if(occupies(site.foot)||occupies(site.head)){
   const stand=[site.foot.offset(-site.facing.x,0,-site.facing.z),site.head.offset(site.facing.x,0,site.facing.z)].find(p=>air(bot.blockAt(p))&&air(bot.blockAt(p.offset(0,1,0)))&&solid(bot.blockAt(p.offset(0,-1,0))))
   if(!stand)throw new Error('No cell to stand in while placing the bed')
   await bot.pathfinder.goto(new goals.GoalBlock(stand.x,stand.y,stand.z));check()
  }
  if(bot.entity.position.floored().equals(site.foot)||bot.entity.position.floored().equals(site.head))throw new Error('Still standing where the bed must go')
  await bot.pathfinder.goto(new goals.GoalNear(site.foot.x,site.foot.y,site.foot.z,2));check()
  await bot.equip(carried,'hand');check()
  // The head extends the way the bot looks, so face the second cell before placing.
  if(bot.lookAt)await bot.lookAt(site.head.offset(.5,.5,.5),true)
  check();stage('placing');progress(`Placing the bed at ${site.foot.x},${site.foot.y},${site.foot.z}`)
  await bot.placeBlock(bot.blockAt(site.foot.offset(0,-1,0)),new Vec3(0,1,0));check()
  for(let i=0;i<20&&!isBed(bot.blockAt(site.foot));i++)await delay(100)
  bed=bot.blockAt(site.foot)
  if(!isBed(bed))throw new Error('Bed placement was not confirmed')
 }
 if(bot.entity.position.distanceTo(bed.position)>2){
  stage('walking');await bot.pathfinder.goto(new goals.GoalNear(bed.position.x,bed.position.y,bed.position.z,1));check()
 }
 stage('sleeping');progress('Going to sleep until morning')
 await bot.sleep(bed);check()
 const sleptAt=bot.time?.timeOfDay
 // Waking is the server's call at dawn; watch the clock rather than a timer.
 for(let i=0;i<1200&&bot.isSleeping;i++){check();await delay(100)}
 if(bot.isSleeping){try{await bot.wake()}catch{}throw new Error('Still asleep after two minutes; the night did not pass')}
 const wokeAt=bot.time?.timeOfDay
 if(!(Number.isFinite(wokeAt)&&wokeAt<SLEEP_START))throw new Error(`Woke at ${wokeAt} without reaching morning`)
 progress('Morning; out of bed')
 return {item:'sleep',count:1,receipt:'slept_until_morning',bed:{x:bed.position.x,y:bed.position.y,z:bed.position.z},sleptAt,wokeAt,spawnSet:true}
}
