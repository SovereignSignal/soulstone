import {setTimeout as delay} from 'node:timers/promises'
import {Vec3} from 'vec3'
import {validateAttackGoal,nearestOfType} from './primitives-world.js'
import {observedSightline} from './visibility.js'
// Bow aim for the dragon ladder: blazes keep their distance and the dragon's end
// crystals sit on towers. A fully drawn arrow leaves at 3 blocks a tick, falls
// 0.05 a tick to gravity and keeps 0.99 of its speed to drag each tick. The aim
// is the pitch whose simulated path passes through the target, low arc first.
export const ARROW={speed:3,gravity:0.05,drag:0.99,maxTicks:120}

// The path as (horizontal distance, height) points, one per tick, from the launch point.
export function arrowPath(pitch,{ticks=ARROW.maxTicks,speed=ARROW.speed}={}){
 let x=0,y=0,vx=Math.cos(pitch)*speed,vy=Math.sin(pitch)*speed
 const path=[{x,y}]
 for(let i=0;i<ticks;i++){x+=vx;y+=vy;vx*=ARROW.drag;vy=vy*ARROW.drag-ARROW.gravity;path.push({x,y})}
 return path
}
// Height of the path at horizontal distance d, and the ticks it took; null if it never gets there.
function heightAt(pitch,d){
 const path=arrowPath(pitch)
 for(let i=1;i<path.length;i++){const a=path[i-1],b=path[i];if(b.x>=d){const t=(d-a.x)/(b.x-a.x);return {y:a.y+(b.y-a.y)*t,ticks:i-1+t}}}
 return null
}
// The low-arc pitch (radians, up positive) that lands on `to` from `from`, or null past the bow's reach.
export function aimPitch(from,to){
 const d=Math.hypot(to.x-from.x,to.z-from.z),dy=to.y-from.y
 // Height reached at d rises with pitch up to the range-maximising angle; search below it.
 let best=-Math.PI/2+0.01,bestY=-Infinity
 for(let p=-Math.PI/2+0.01;p<Math.PI/2;p+=0.01){const h=heightAt(p,d);if(h&&h.y>bestY){bestY=h.y;best=p}}
 if(bestY<dy)return null
 let lo=-Math.PI/2+0.01,hi=best
 for(let i=0;i<60;i++){const mid=(lo+hi)/2,h=heightAt(mid,d);if(h&&h.y<dy)lo=mid;else hi=mid}
 return (lo+hi)/2
}
// Lead a moving target: aim where it will be when the arrow arrives (two refinements).
aimPitch.lead=function(from,to,velocity){
 let aimAt=to.clone?.()??to,pitch=aimPitch(from,aimAt)
 for(let i=0;i<2&&pitch!==null;i++){
  const flight=heightAt(pitch,Math.hypot(aimAt.x-from.x,aimAt.z-from.z))?.ticks??0
  aimAt=to.plus(velocity.scaled(flight));pitch=aimPitch(from,aimAt)
 }
 return {aimAt,pitch}
}

export const SHOOT={radius:32,drawMs:1100,maxShots:12,settleMs:900}
// Shoot the nearest creature of a type with a fully drawn bow until it dies or the
// arrows or the shot budget run out. The same refusals as attack (players, pets,
// villagers, piglins). Count is 1 only for a death seen by the client, never for
// a target that walked out of range or out of sight.
export async function shootTarget(bot,task,{check,stage,progress},options={}){
 const o={...SHOOT,...options}
 const goal=validateAttackGoal(task.goal,bot.registry)
 const bow=bot.inventory.items().find(i=>i.name==='bow')
 if(!bow)throw new Error('Shooting needs a bow (3 sticks and 3 string)')
 const arrows=()=>bot.inventory.items().filter(i=>i.name==='arrow').reduce((n,i)=>n+i.count,0)
 if(!arrows())throw new Error('Shooting needs arrows (flint, a stick and a feather make four)')
 const target=nearestOfType(bot,goal.type,bot.entity.position,o.radius)
 if(!target)throw new Error(`No ${goal.type} within ${o.radius} blocks`)
 let dead=false,shots=0
 const killed=e=>{if(e?.id===target.id)dead=true}
 bot.on('entityDead',killed)
 const eye=()=>bot.entity.position.offset(0,bot.entity.eyeHeight??1.62,0)
 const centre=()=>target.position.offset(0,(target.height??1.8)/2,0)
 const aim=()=>{
  const from=eye(),{aimAt,pitch}=aimPitch.lead(from,centre(),target.velocity??new Vec3(0,0,0))
  if(pitch===null)throw new Error(`The ${goal.type} is out of bow range`)
  return {yaw:Math.atan2(-(aimAt.x-from.x),-(aimAt.z-from.z)),pitch}
 }
 try{
  stage('arming');await bot.equip(bow,'hand');check()
  while(!dead&&shots<o.maxShots&&arrows()>0&&bot.entities?.[target.id]){
   const sight=observedSightline(bot,eye(),centre())
   if(sight.status==='blocked')throw new Error(`No clear shot at the ${goal.type}: ${sight.block||'a block'} is in the way`)
   let a=aim()
   stage('drawing');bot.activateItem()
   // Full draw takes a second; keep the aim on a moving target while it draws.
   const end=Date.now()+o.drawMs
   while(Date.now()<end){check();a=aim();await bot.look(a.yaw,a.pitch,true);await delay(Math.min(100,o.drawMs))}
   a=aim();await bot.look(a.yaw,a.pitch,true);bot.deactivateItem();shots++
   progress(`Shot ${shots} at the ${goal.type}`)
   const until=Date.now()+o.settleMs
   while(!dead&&Date.now()<until){check();await delay(20)}
  }
 }finally{bot.removeListener('entityDead',killed)}
 return {item:goal.type,count:dead?1:0,receipt:dead?'killed':'target_survived',shots,arrowsLeft:arrows()}
}
