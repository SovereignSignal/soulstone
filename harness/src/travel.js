// Travel: cross real distances by walking them in stages. The pathfinder
// searches a bounded region, so a single goto over a hundred blocks reports
// "no route" even where an easy walk exists. A respawn at world spawn left the
// agent stranded 130 blocks from its own base, unable to go home or find wood.
import {setTimeout as delay} from 'node:timers/promises'
import pathfinding from 'mineflayer-pathfinder'
import {Vec3} from 'vec3'
import {DoorAwareMovements} from './navigation.js'
const {goals}=pathfinding
export const LEG=32,ARRIVE=3
const point=p=>new Vec3(p.x,p.y,p.z)
export function validateTravelGoal(goal){
 if(!goal||!['x','y','z'].every(k=>Number.isFinite(goal[k])))throw new Error('Travel needs a finite x, y and z')
 return {x:Math.floor(goal.x),y:Math.floor(goal.y),z:Math.floor(goal.z)}
}
// Waypoints along the straight line, plus lateral alternatives for each, so a
// wall, lake or ravine across the line costs a detour rather than the journey.
export function legs(from,to,leg=LEG){
 const dx=to.x-from.x,dz=to.z-from.z,flat=Math.hypot(dx,dz)
 if(flat<=leg)return [{x:to.x,z:to.z}]
 const steps=Math.ceil(flat/leg),ux=dx/flat,uz=dz/flat,out=[]
 for(let i=1;i<=steps;i++){
  const reach=Math.min(flat,i*leg)
  out.push({x:Math.round(from.x+ux*reach),z:Math.round(from.z+uz*reach)})
 }
 return out
}
export async function travelTo(bot,task,{check,stage,progress,movements}){
 const target=validateTravelGoal(task.goal),start=bot.entity.position.clone()
 const movement=new DoorAwareMovements(bot)
 Object.assign(movement,{canDig:false,allow1by1towers:false,allowParkour:false,allowSprinting:false,scafoldingBlocks:[],maxDropDown:3})
 bot.pathfinder.setMovements(movement)
 const flat=()=>Math.hypot(bot.entity.position.x-target.x,bot.entity.position.z-target.z)
 const started=Date.now(),record=task.travel={legs:0,detours:0,startedAt:started}
 try{
  let stalls=0
  while(flat()>ARRIVE){
   check()
   if(Date.now()-started>8*60*1000)throw new Error(`Travel time limit reached ${Math.round(flat())} blocks short of ${target.x},${target.y},${target.z}`)
   const here=bot.entity.position.floored()
   const next=legs(here,target)[0]
   const before=flat()
   // The straight line first, then a lateral detour either side of it.
   const dx=target.x-here.x,dz=target.z-here.z,len=Math.hypot(dx,dz)||1
   const side=[{x:0,z:0},{x:Math.round(-dz/len*16),z:Math.round(dx/len*16)},{x:Math.round(dz/len*16),z:Math.round(-dx/len*16)}]
   let moved=false
   for(const [index,offset] of side.entries()){
    check()
    const to={x:next.x+offset.x,z:next.z+offset.z}
    if(index)record.detours++
    stage('walking');progress(`Travelling to ${target.x},${target.z}: ${Math.round(before)} blocks to go`)
    const timer=setTimeout(()=>bot.pathfinder.setGoal(null),25000)
    try{await bot.pathfinder.goto(new goals.GoalNear(to.x,bot.entity.position.y,to.z,ARRIVE))}catch{}finally{clearTimeout(timer);bot.pathfinder.setGoal(null)}
    check()
    if(before-flat()>=4||bot.entity.position.distanceTo(start)>=4&&index===0&&before-flat()>0){moved=true;break}
    if(before-flat()>0){moved=true;break}
   }
   record.legs++
   if(!moved){
    if(++stalls>=3)throw new Error(`No way forward ${Math.round(flat())} blocks short of ${target.x},${target.y},${target.z} after three detours`)
    await delay(400)
   }else stalls=0
  }
 }finally{bot.pathfinder.setGoal(null);bot.clearControlStates?.();if(movements)bot.pathfinder.setMovements(movements)}
 const p=bot.entity.position
 return {item:'travel',count:1,receipt:'arrived',target,legs:record.legs,detours:record.detours,
   covered:Math.round(start.distanceTo(p)),position:{x:p.x,y:p.y,z:p.z}}
}
