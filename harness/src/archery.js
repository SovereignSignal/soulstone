import {setTimeout as delay} from 'node:timers/promises'
import {Vec3} from 'vec3'
import {validateAttackGoal,nearestOfType,isProtectedBystander} from './primitives-world.js'
import {observedSightline} from './visibility.js'
import {fullCube} from './construction.js'
import {survivalObservation} from './survival.js'
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
// Security reviews of 6da6e6c, ae7e4aa and 1993aea (9 October): an arrow flies on
// past a miss, so the target's type is not enough. A protected bystander within a
// block and a half of the arrow's arc holds the shot, along the whole flight: until
// the arrow falls well below the target or meets a solid block, not a fixed
// distance past the target. The arc, not the straight line: a long shot rises.
export const LINE_OF_FIRE={clearance:1.5,fallBelow:8,overhead:6}
export function lineOfFireBlocker(bot,from,aimAt,target){
 const flat=new Vec3(aimAt.x-from.x,0,aimAt.z-from.z),d=flat.norm()
 // Straight up or down there is no horizontal line to follow, and the arrow comes
 // back down by the shooter: any protected bystander close by holds it.
 if(d<1)return Object.values(bot.entities||{}).find(e=>e?.position&&e!==bot.entity&&e.id!==target.id&&isProtectedBystander(e)&&Math.hypot(e.position.x-from.x,e.position.z-from.z)<=LINE_OF_FIRE.overhead)||null
 const unit=flat.scaled(1/d),pitch=aimPitch(from,aimAt),floor=aimAt.y-LINE_OF_FIRE.fallBelow
 const path=pitch===null?[from,aimAt]:arrowPath(pitch).map(p=>from.plus(unit.scaled(p.x)).offset(0,p.y,0))
 // Past the target the flight ends where it falls well below it, or in the first
 // solid block (anyone behind that is safe). A tick covers up to three blocks, so
 // each step is walked in half blocks to find a wall one block thick.
 const points=[path[0]],past=p=>Math.hypot(p.x-from.x,p.z-from.z)>d
 flight:for(let i=1;i<path.length;i++){
  const a=path[i-1],b=path[i],steps=Math.max(1,Math.ceil(b.minus(a).norm()/0.5))
  for(let k=1;k<=steps;k++){
   const p=a.plus(b.minus(a).scaled(k/steps))
   if(!past(p))continue
   // Only a full cube stops it: an arrow passes over a slab or beside a fence post or a pane.
   const block=bot.blockAt?.(p.floored())
   if(p.y<floor||block&&bot.registry&&fullCube(bot.registry,block.name)){points.push(p);break flight}
  }
  points.push(b)
 }
 const near=(c,a,b)=>{const ab=b.minus(a),t=Math.max(0,Math.min(1,c.minus(a).dot(ab)/(ab.dot(ab)||1)));return c.minus(a.plus(ab.scaled(t))).norm()}
 for(const e of Object.values(bot.entities||{})){
  if(!e?.position||e===bot.entity||e.id===target.id||!isProtectedBystander(e))continue
  const c=e.position.offset(0,(e.height??1.8)/2,0),reach=LINE_OF_FIRE.clearance+(e.width??0.6)/2
  for(let i=1;i<points.length;i++)if(near(c,points[i-1],points[i])<=reach)return e
 }
 return null
}
export async function shootTarget(bot,task,{check,stage,progress},options={}){
 const o={...SHOOT,...options}
 const goal=validateAttackGoal(task.goal,bot.registry)
 const bow=bot.inventory.items().find(i=>i.name==='bow')
 if(!bow)throw new Error('Shooting needs a bow (3 sticks and 3 string)')
 const arrows=()=>bot.inventory.items().filter(i=>i.name==='arrow').reduce((n,i)=>n+i.count,0)
 if(!arrows())throw new Error('Shooting needs arrows (flint, a stick and a feather make four)')
 const target=nearestOfType(bot,goal.type,bot.entity.position,o.radius)
 if(!target)throw new Error(`No ${goal.type} within ${o.radius} blocks`)
 let dead=false,shots=0,drawn=false
 const killed=e=>{if(e?.id===target.id)dead=true}
 bot.on('entityDead',killed)
 const eye=()=>bot.entity.position.offset(0,bot.entity.eyeHeight??1.62,0)
 const centre=()=>target.position.offset(0,(target.height??1.8)/2,0)
 const aim=()=>{
  const from=eye(),{aimAt,pitch}=aimPitch.lead(from,centre(),target.velocity??new Vec3(0,0,0))
  if(pitch===null)throw new Error(`The ${goal.type} is out of bow range`)
  return {yaw:Math.atan2(-(aimAt.x-from.x),-(aimAt.z-from.z)),pitch,aimAt}
 }
 const holdFire=e=>new Error(`Holding fire: a ${e.type==='player'?`player (${e.username||'someone'})`:e.name} is in the line of fire`)
 // Releasing a drawn bow always looses the arrow; changing the held slot cancels the draw.
 const standDown=()=>{try{bot.setQuickBarSlot?.(((bot.quickBarSlot??0)+1)%9)}catch{}}
 try{
  stage('arming');await bot.equip(bow,'hand');check()
  while(!dead&&shots<o.maxShots&&arrows()>0&&bot.entities?.[target.id]){
   const sight=observedSightline(bot,eye(),centre())
   if(sight.status==='blocked')throw new Error(`No clear shot at the ${goal.type}: ${sight.block||'a block'} is in the way`)
   let a=aim()
   const early=lineOfFireBlocker(bot,eye(),a.aimAt,target)
   if(early)throw holdFire(early)
   stage('drawing');bot.activateItem();drawn=true
   // Full draw takes a second; keep the aim on a moving target while it draws.
   const end=Date.now()+o.drawMs
   while(Date.now()<end){check();a=aim();await bot.look(a.yaw,a.pitch,true);await delay(Math.min(100,o.drawMs))}
   a=aim()
   // Checked at the moment of release, against where the arrow is going.
   const blocker=lineOfFireBlocker(bot,eye(),a.aimAt,target)
   if(blocker){standDown();drawn=false;throw holdFire(blocker)}
   await bot.look(a.yaw,a.pitch,true);bot.deactivateItem();drawn=false;shots++
   progress(`Shot ${shots} at the ${goal.type}`)
   const until=Date.now()+o.settleMs
   while(!dead&&Date.now()<until){check();await delay(20)}
  }
 }finally{
  // Never leave an arrow drawn: the runner's cleanup calls deactivateItem, which would loose it.
  if(drawn)standDown()
  bot.removeListener('entityDead',killed)
 }
 return {item:goal.type,count:dead?1:0,receipt:dead?'killed':'target_survived',shots,arrowsLeft:arrows()}
}

// Lab, 10 October: a blaze 18 blocks off set off the safety ladder, every shelter
// failed on open ground, and the bot burned to death with a bow and 55 arrows in
// hand. Melee declines what keeps its distance; a player shoots back. Asked only
// after the melee decision declines, so a zombie at arm's length is still a sword.
export const RANGED_DEFENSE=new Set(['blaze','ghast','skeleton','stray','bogged','pillager','witch'])
export function rangedDefenseDecision(bot,{healthFloor=10,foodFloor=6,minArrows=4,meleeClose=8}={}){
 const reject=reason=>({engage:false,reason})
 const s=survivalObservation(bot)
 if(s.gameMode!=='survival'||!['easy','normal','hard'].includes(s.difficulty))return reject('Combat requires observed hostile Survival difficulty')
 if(!Number.isFinite(s.health)||s.health<healthFloor||!Number.isFinite(s.food)||s.food<foodFloor)return reject('Health or food is too low to stand and shoot')
 if(!bot.inventory.items().some(i=>i.name==='bow'))return reject('No bow to answer a ranged threat')
 const arrows=bot.inventory.items().filter(i=>i.name==='arrow').reduce((n,i)=>n+i.count,0)
 if(arrows<minArrows)return reject(`Only ${arrows} arrows; ${minArrows} or more to stand and shoot`)
 if(!bot.entity?.onGround||bot.entity.isInWater||bot.entity.isInLava||bot.currentWindow)return reject('Not ready on stable ground with inventory closed')
 const threats=s.nearbyThreats.filter(t=>t.risk==='potential_hostile').sort((a,b)=>a.distance-b.distance)
 if(!threats.length)return reject('No hostile in sight to shoot')
 if(threats.some(t=>t.distance<=meleeClose&&!RANGED_DEFENSE.has(t.name)))return reject('A melee hostile is close; the bow waits')
 const nearest=threats[0]
 if(!RANGED_DEFENSE.has(nearest.name))return reject(`The nearest hostile, a ${nearest.name}, is not a ranged one`)
 if(nearest.distance>SHOOT.radius)return reject(`The ${nearest.name} is out of bow range`)
 const target=nearestOfType(bot,nearest.name,bot.entity.position,SHOOT.radius)
 if(!target)return reject('Target identity is unavailable')
 const eye=bot.entity.position.offset(0,bot.entity.eyeHeight??1.62,0),centre=target.position.offset(0,(target.height??1.8)/2,0)
 const sight=observedSightline(bot,eye,centre)
 if(sight.status==='blocked')return reject(`No clear shot at the ${nearest.name}: ${sight.block||'a block'} is in the way`)
 if(aimPitch(eye,centre)===null)return reject(`The ${nearest.name} is out of bow range`)
 const blocker=lineOfFireBlocker(bot,eye,centre,target)
 if(blocker)return reject(`A ${blocker.type==='player'?'player':blocker.name} is in the line of fire`)
 return {engage:true,ranged:true,target:{targetId:target.id,targetName:target.name}}
}
