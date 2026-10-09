// Travel: cross real distances by walking them in stages. The pathfinder
// searches a bounded region, so a single goto over a hundred blocks reports
// "no route" even where an easy walk exists. A respawn at world spawn left the
// agent stranded 130 blocks from its own base, unable to go home or find wood.
import {setTimeout as delay} from 'node:timers/promises'
import {fullCube} from './construction.js'
import pathfinding from 'mineflayer-pathfinder'
import {Vec3} from 'vec3'
import {DoorAwareMovements,allowGroundBreaking,requireReachedGoal,breakableWhileTravelling} from './navigation.js'
const {goals}=pathfinding
export const LEG=32,ARRIVE=3,LEG_TIMEOUT_MS=25000,CLOSED_PER_LEG=1
const point=p=>new Vec3(p.x,p.y,p.z)
export function validateTravelGoal(goal){
 if(!goal||!['x','y','z'].every(k=>Number.isFinite(goal[k])))throw new Error('Travel needs a finite x, y and z')
 if(goal.player!==undefined&&(typeof goal.player!=='string'||!/^[A-Za-z0-9_]{1,16}$/.test(goal.player)))throw new Error('Travel player must be a Minecraft player name')
 return {x:Math.floor(goal.x),y:Math.floor(goal.y),z:Math.floor(goal.z),...(goal.player?{player:goal.player}:{})}
}
// Model-selected destinations must be nearby and supported by loaded evidence.
export function validateObservedTravelGoal(bot,goal){
 const target=validateTravelGoal(goal),p=point(target),here=bot?.entity?.position
 if(!here||p.distanceTo(here)>96)throw new Error('Choose an observed travel destination within 96 blocks')
 const floor=bot.blockAt(p.offset(0,-1,0)),feet=bot.blockAt(p),head=bot.blockAt(p.offset(0,1,0))
 const open=b=>b&&b.boundingBox==='empty'&&['air','cave_air','short_grass','tall_grass','fern','large_fern'].includes(b.name)
 if(!floor||!fullCube(bot.registry,floor.name)||floor.name==='magma_block'||!open(feet)||!open(head))throw new Error('Travel destination needs observed solid support and clear, dry headroom')
 return target
}
// What is on the straight line that this skill cannot dig through? travel breaks
// soft ground and leaves and never stone, so a stone wall across the line is not
// something a fourth detour solves: it is a fact for whoever chooses the next
// action. A refusal that names no alternative is the shape this codebase keeps
// paying for, and the live loop of 22 September was two accurate refusals,
// `No way forward` and `No pit exit judged from here`, neither of which
// mentioned that the target was behind rock.
//
// This reports an observation, never a verdict: the pathfinder searches in three
// dimensions and a clear line does not make a goal reachable.
export function lineObstruction(bot,from,to,{reach=24}={}) {
 const dx=to.x-from.x,dz=to.z-from.z,flat=Math.hypot(dx,dz)
 if(!flat||typeof bot?.blockAt!=='function'||!bot?.registry)return null
 // This only ever runs inside a refusal, where the message we already have is
 // the evidence. It may add to that and must never replace it, so anything
 // unexpected here is silence rather than a TypeError over the real reason.
 try {
  const ux=dx/flat,uz=dz/flat,steps=Math.min(reach,Math.max(1,Math.round(flat)))
  let first=null,solid=0,sampled=0
  for(let i=1;i<=steps;i++) {
   const y=Math.round(from.y+(to.y-from.y)*(i/steps))
   for(const dy of [0,1]) {
    const b=bot.blockAt(new Vec3(Math.round(from.x+ux*i),y+dy,Math.round(from.z+uz*i)))
    sampled++
    if(!b||b.boundingBox!=='block'||!fullCube(bot.registry,b.name)||breakableWhileTravelling(b,bot))continue
    solid++
    if(!first)first={name:b.name,away:i}
   }
  }
  return first?{...first,solid,sampled}:null
 }catch{return null}
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
 const saved=validateTravelGoal(task.goal),start=bot.entity.position.clone()
 const locate=()=>{
  const p=saved.player?bot.players?.[saved.player]?.entity?.position:saved
  if(!p)throw new Error(`Cannot currently see ${saved.player}. Ask the team leader to come into view or share a meeting point; I will not guess their location.`)
  return validateTravelGoal(p)
 }
 let target=locate()
 const movement=new DoorAwareMovements(bot)
 Object.assign(movement,{allow1by1towers:false,allowParkour:false,allowSprinting:false,scafoldingBlocks:[],maxDropDown:3})
 allowGroundBreaking(bot,movement)
 bot.pathfinder.setMovements(movement)
 const flat=()=>Math.hypot(bot.entity.position.x-target.x,bot.entity.position.z-target.z)
 // One arrival contract. The loop exited on flat(), a raw-float horizontal
 // distance, while the pathfinder satisfies GoalNear against the FLOORED cell.
 // Between them sat a band where goto() had arrived and the loop did not
 // believe it, so travel walked in place until the eight-minute deadline and
 // reported "N blocks short". Kept as a disjunct with flat(), not a
 // replacement: making the loop exit three-dimensional would make the vertical
 // final approach below unreachable dead code.
 const arrival=()=>new goals.GoalNear(target.x,target.y,target.z,ARRIVE)
 const arrived=()=>{const g=arrival(),f=bot.entity.position.floored();return g.isEnd(f)||g.isEnd(f.offset(0,1,0))}
 const started=Date.now(),record=task.travel={legs:0,detours:0,startedAt:started}
 // Said once, at the point of refusal: what the straight line holds that this
 // skill does not break, so the planner can reach for the verb that does.
 const onTheLine=()=>{
  const blocked=lineObstruction(bot,bot.entity.position.floored(),target)
  if(!blocked)return ' The straight line is clear, so whatever refused the route is above, below or beside it.'
  return ` The straight line runs into ${blocked.name} ${blocked.away} blocks ahead and travel does not break ${blocked.name}.`
 }
 try{
  let stalls=0
  while(true){
   check();target=locate();record.target={...target}
   if(flat()<=ARRIVE||arrived())break
   if(Date.now()-started>8*60*1000)throw new Error(`Travel time limit reached ${Math.round(flat())} blocks short of ${target.x},${target.y},${target.z}.${onTheLine()}`)
   const here=bot.entity.position.floored()
   const next=legs(here,target)[0]
   const before=flat()
   // The straight line first, then a lateral detour either side of it.
   const dx=target.x-here.x,dz=target.z-here.z,len=Math.hypot(dx,dz)||1
   // Scaled to the gap, not a flat 16 blocks: span <= len/2 keeps a detour
   // closer to the target than the bot already is. And below 2*ARRIVE there is
   // no room for one at all, because both goals have radius ARRIVE, so a
   // smaller offset just re-tries the region that has already refused. Saying
   // "after three detours" there claimed three attempts that never happened.
   const span=Math.max(2,Math.min(16,Math.round(len/2))),detourable=len>2*ARRIVE
   const side=[...(saved.player&&len<=128?[{x:target.x-next.x,z:target.z-next.z}]:[]),{x:0,z:0},
    ...(detourable?[{x:Math.round(-dz/len*span),z:Math.round(dx/len*span)},{x:Math.round(dz/len*span),z:Math.round(-dx/len*span)}]:[])]
   let moved=false,refusal=null
   for(const [index,offset] of side.entries()){
    check()
    const to={x:next.x+offset.x,z:next.z+offset.z}
    if(index)record.detours++
    stage('walking');progress(`Travelling to ${target.x},${target.z}: ${Math.round(before)} blocks to go`)
    // Clearing the goal is how a slow leg is abandoned, and the pathfinder
    // reports a replaced goal as "the goal was changed": our own stopwatch,
    // read back as if the world had moved. Say which it was.
    let abandoned=false
    const timer=setTimeout(()=>{abandoned=true;bot.pathfinder.setGoal(null)},LEG_TIMEOUT_MS)
    // Intermediate waypoints follow terrain, but the final destination already
    // has an observed height. Ignoring it first can descend below a ledge and
    // only then discover there is no ascent back to the intended landing.
    const waypoint=to.x===target.x&&to.z===target.z
      ?new goals.GoalNear(target.x,target.y,target.z,ARRIVE)
      :new goals.GoalNearXZ(to.x,to.z,ARRIVE)
    try{await bot.pathfinder.goto(waypoint);check();requireReachedGoal(bot,waypoint)}
    catch(error){refusal=abandoned?`this leg was still walking after ${Math.round(LEG_TIMEOUT_MS/1000)} seconds`
      :error?.name==='NoPath'?`no route to ${to.x},${to.z}`:error?.message||String(error)}
    finally{clearTimeout(timer);bot.pathfinder.setGoal(null)}
    check()
     // Closing ground is progress; moving is not. `>0` let a bot oscillating in
     // place buy a fresh stall budget with a few centimetres in the right
     // direction: live on 22 September, 4 legs and 9 detours over 343 seconds
     // with "12 blocks to go" on every progress line and the counter never
     // reaching 3. A leg is a 25 second walk, so a real approach closes far
     // more than one block and a dig through soft ground still clears it.
     if(before-flat()>=CLOSED_PER_LEG){moved=true;break}
   }
   record.legs++
   if(!moved){
    if(++stalls>=3)throw new Error(`No way forward ${Math.round(flat())} blocks short of ${target.x},${target.y},${target.z} ${detourable?'after three detours':'with no room to detour'}${refusal?`: ${refusal}`:''}.${onTheLine()}`)
    await delay(400)
   }else stalls=0
  }
  // Horizontal proximity alone is not arrival: the destination may be above us.
  if(!arrived()){
   check();stage('walking');progress(`Reaching the destination level at ${target.x},${target.y},${target.z}`)
   let expired=false
   const timer=setTimeout(()=>{expired=true;bot.pathfinder.setGoal(null)},LEG_TIMEOUT_MS)
   // The deadline clears the goal, which makes goto() REJECT, so an `if(expired)`
   // after the await is unreachable and the raw GoalChanged escapes into a
   // classifier that does not list it. Convert it here, as canopy.js does.
   try{await bot.pathfinder.goto(arrival())}
   catch(error){if(expired)throw Object.assign(new Error('Final approach exceeded its 25 second budget'),{name:'Timeout'});throw error}
   finally{clearTimeout(timer)}
   check()
  }
  check();requireReachedGoal(bot,arrival())
 }finally{bot.pathfinder.setGoal(null);bot.clearControlStates?.();if(movements)bot.pathfinder.setMovements(movements)}
 const p=bot.entity.position
 if(saved.player){target=locate();if(!arrived())throw new Error(`${saved.player} moved during the final approach; regroup again using their current position`)}
 return {item:'travel',count:1,receipt:'arrived',target,legs:record.legs,detours:record.detours,
   covered:Math.round(start.distanceTo(p)),position:{x:p.x,y:p.y,z:p.z}}
}
