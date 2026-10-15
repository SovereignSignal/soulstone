// Throwing an eye of ender to find the stronghold (dragon roadmap stage 4, brief 2).
//
// Headings are compass bearings in whole degrees, clockwise from north: 0 is north (-z),
// 90 east (+x), 180 south (+z), 270 west (-x). Minecraft's own yaw starts at south and turns
// the other way; the planner reasons in x and z, and a compass bearing maps onto them with
// no sign to remember.
//
// One eye a step, one receipt. A receipt with a heading is only ever built from the flight
// the bot watched: an eye spent with nothing seen is partial and latches, as `use` does.
import {dimensionOf} from './dimension.js'
import {columnAbove} from './observations.js'
import {collectKillDrops} from './primitives-world.js'

// spawnTicks: wait for the eye after the click. flightTicks: vanilla's eye lives 80 ticks.
// dropTicks: wait for the dropped item, which spawns as the eye goes and gets its stack a packet later.
// baseline: a heading from less flight than this is rounding noise. fallbackMs stands in for a
// tick that never comes. timeoutMs is the step's limit: every wait at its fallback, plus the
// pickup's own bound, with room to spare (a test holds the sum to it).
export const EYE={reach:3,spawnTicks:20,flightTicks:80,dropTicks:20,dropRadius:3,overhead:6,baseline:3,keep:8,minSeparation:10,fallbackMs:500,timeoutMs:150000}
const round1=v=>Math.round(v*10)/10
const at=p=>({x:round1(p.x),y:round1(p.y),z:round1(p.z)})
const carried=bot=>(bot.inventory?.items?.()||[]).filter(i=>i.name==='ender_eye').reduce((n,i)=>n+i.count,0)

export function validateThrowEyeGoal(goal){
 if(goal&&Object.keys(goal).length)throw new Error('throw_eye takes no goal')
 return {}
}

// First sample to last: the eye flies straight toward its target, so the ends are the bearing.
// overhead is the near-stronghold case: vanilla aims the eye at the stronghold itself once it
// is within 12 blocks, so it sinks into the ground close by instead of rising and flying on.
export function bearingFromFlight(samples){
 if(!Array.isArray(samples)||samples.length<2)return {heading:null,travelled:0,overhead:false}
 const a=samples[0],b=samples.at(-1),dx=b.x-a.x,dz=b.z-a.z,travelled=round1(Math.hypot(dx,dz))
 const heading=travelled>=EYE.baseline?Math.round((Math.atan2(dx,-dz)*180/Math.PI+360)%360)%360:null
 return {heading,travelled,overhead:travelled<=EYE.overhead&&b.y<a.y-1}
}

const direction=h=>({x:Math.sin(h*Math.PI/180),z:-Math.cos(h*Math.PI/180)})
const cross=(u,v)=>u.x*v.z-u.z*v.x
// Two throws from different places: where their lines cross is the stronghold. Lines under
// ten degrees apart cross so loosely that a degree of error moves the point by hundreds of
// blocks; the planner is told to walk further sideways instead.
export function intersectBearings(a,b){
 const diff=Math.abs(((a.heading-b.heading)%360+540)%360-180),separation=Math.round(Math.min(diff,180-diff))
 if(separation<EYE.minSeparation)return {point:null,reason:`The two bearings are ${separation} degrees apart; under ${EYE.minSeparation} they do not cross usefully. Walk a few hundred blocks sideways and throw again.`}
 const u=direction(a.heading),v=direction(b.heading),w={x:b.x-a.x,z:b.z-a.z},d=cross(u,v)
 const t=cross(w,v)/d,s=cross(w,u)/d
 if(t<0||s<0)return {point:null,reason:'The bearings cross behind a throw, so one of them is misread. Throw again from either place.'}
 return {point:{x:Math.round(a.x+t*u.x),z:Math.round(a.z+t*u.z)},reason:null}
}

// places.stronghold_bearing: the last few throws, the newest carrying the estimate. An
// overhead drop is its own estimate; otherwise the newest earlier bearing that crosses it.
export function addBearing(list,result){
 const prior=(Array.isArray(list)?list:[]).filter(b=>Number.isFinite(b?.x)&&Number.isFinite(b?.z))
 const entry={x:result.from.x,y:result.from.y,z:result.from.z,heading:result.heading,overhead:!!result.overhead,dimension:'overworld'}
 if(entry.overhead)entry.estimate={x:Math.round(result.at.x),z:Math.round(result.at.z)}
 else if(prior.length){
  const tries=prior.filter(b=>!b.overhead&&Number.isFinite(b.heading)).reverse().map(b=>intersectBearings(b,entry))
  const hit=tries.find(t=>t.point)
  if(hit)entry.estimate=hit.point
  else entry.estimateRefused=tries[0]?.reason||'Every earlier bearing was an overhead drop.'
 }
 return [...prior,entry].slice(-EYE.keep)
}

// One physics tick, or half a second if the ticks stop (a stalled bridge or a lost
// connection must not hang the step), then the task's own interrupt check.
const nextTick=(bot,check)=>new Promise(resolve=>{
 const done=()=>{clearTimeout(timer);bot.off?.('physicsTick',done);resolve()}
 const timer=setTimeout(done,EYE.fallbackMs);bot.on?.('physicsTick',done)
}).then(check)

export async function throwEye(bot,task,context){
 const {check,stage,progress,persist}=context
 const here=dimensionOf(bot)
 if(here!=='overworld')throw new Error(`An eye of ender points to a stronghold only in the Overworld; the bot is in ${here||'an unknown dimension'}.`)
 // The task's own latch survives a restart that has no feedback at all.
 if(task.eye?.uncertain)throw new Error('An eye was already spent in this step and its flight was not seen. Re-observe the inventory and plan a fresh throw_eye step.')
 const before=carried(bot)
 if(!before)throw new Error('No eye of ender is carried. Craft one from an ender pearl and blaze powder first.')
 // The eye rises about eight blocks and is watched all the way; under cover the click
 // can hit a block instead, and the drop lands where the bot cannot follow.
 if(!columnAbove(bot).skyVisible)throw new Error('Throwing an eye needs open sky above the bot. Step out from under cover first.')
 const start=bot.entity.position.clone(),known=new Set(Object.keys(bot.entities||{}).map(Number))
 const ours=e=>e?.name==='eye_of_ender'&&!known.has(e.id)&&e.position&&e.position.distanceTo(start)<=EYE.reach
 let eye=null,gone=false
 const onSpawn=e=>{if(!eye&&ours(e))eye=e}
 const onGone=e=>{if(eye&&e?.id===eye.id)gone=true}
 bot.on('entitySpawn',onSpawn);bot.on('entityGone',onGone)
 let samples
 try{
  await bot.equip(bot.inventory.items().find(i=>i.name==='ender_eye'),'hand');check()
  // Straight up: an eye clicked at an end portal frame goes into the frame, not into the air.
  await bot.look(bot.entity.yaw,Math.PI/2,true);check()
  task.eye={uncertain:true,before};persist()
  stage('throwing');progress('Throwing an eye of ender')
  // Released at once, as every activate in the tree is: an eye is thrown on the press.
  try{bot.activateItem()}finally{bot.deactivateItem?.()}
  // The spawn event can be missed through a version bridge; the entity table is the second witness.
  for(let t=0;t<EYE.spawnTicks&&!eye;t++){await nextTick(bot,check);eye??=Object.values(bot.entities||{}).find(ours)??null}
  if(!eye){
   const spent=before-carried(bot)
   if(spent>0)return {receipt:'eye_unobserved',item:'ender_eye',partial:true,spent,heading:null,from:at(start),
    next:'An eye left the hand but no flight was seen, so it gave no bearing. Re-observe the inventory before another throw.'}
   task.eye.uncertain=false;persist()
   throw new Error('The click threw no eye: nothing left the hand and no eye of ender appeared. Check that open sky is above and nothing is in front, then try again.')
  }
  stage('watching');progress('Watching the eye fly')
  // Mineflayer moves an entity's position in place, so each sample is a copy.
  samples=[at(eye.position)]
  for(let t=0;t<EYE.flightTicks&&!gone&&bot.entities?.[eye.id];t++){await nextTick(bot,check);if(!gone&&bot.entities?.[eye.id])samples.push(at(eye.position))}
 }finally{bot.off?.('entitySpawn',onSpawn);bot.off?.('entityGone',onGone)}
 const flight=bearingFromFlight(samples),last=samples.at(-1)
 const base={item:'ender_eye',from:at(start),...flight,at:last,ticks:samples.length-1,dimension:'overworld'}
 task.eye.uncertain=false;persist()
 // Another player's eye beside the bot looks the same: only the bot's own spend makes it the
 // bot's throw. In creative the hand never empties, so there the count is no witness.
 if(carried(bot)>=before&&bot.game?.gameMode!=='creative')
  return {...base,heading:null,overhead:false,receipt:'eye_not_mine',partial:true,recovered:false,shattered:false,
   next:'An eye flew, but none left this bot\'s hand, so it was not this throw and gives no bearing. Throw again.'}
 const bearing=flight.heading!==null||flight.overhead
 const outcome=bearing?{receipt:'eye_bearing'}:{receipt:'eye_without_bearing',partial:true,
  next:'The eye was seen for too little of its flight to give a bearing. Throw again from here.'}
 // Most eyes drop as an item where they fell; about one in five shatters.
 const dropped=()=>Object.values(bot.entities||{}).find(e=>!known.has(e.id)&&e.getDroppedItem?.()?.name==='ender_eye'&&e.position&&Math.hypot(e.position.x-last.x,e.position.z-last.z)<=EYE.dropRadius)
 let drop=dropped()
 for(let t=0;t<EYE.dropTicks&&!drop;t++){await nextTick(bot,check);drop=dropped()}
 if(!drop)return {...base,...outcome,recovered:false,shattered:true}
 stage('collecting');progress('Picking up the eye where it fell')
 // Centred on the drop, not the eye: an eye that sank into the ground leaves its item pushed up out of the rock.
 const r=await collectKillDrops(bot,[drop.position.clone()],context,{items:['ender_eye'],radius:EYE.dropRadius})
 const recovered=(r.gained.ender_eye||0)>0
 return {...base,...outcome,recovered,shattered:false,...(recovered?{}:{missed:r.missed||['the dropped eye was not picked up']})}
}
