import {departureThreatObservation} from './shelter-departure.js'
import {assertNoHostileOccupants} from './shelter-occupants.js'
import {Vec3} from 'vec3'
import pathfinding from 'mineflayer-pathfinder'
import {shelterLayout,shelterAccessLayout,inspectShelterSite} from './shelter.js'
import {shelterLightBounds} from './lighting.js'
const {goals}=pathfinding
export async function retreatToShelter(bot,task,{check,walk,settle,progress}){
 const project=task.goal.project,build=project.build,o=new Vec3(build.origin.x,build.origin.y,build.origin.z),layout=shelterLayout(build.design)
 const leaving=task.kind==='leave_base'
 // Walking out never depends on the shell being whole. A damaged or unlit base
 // is a reason to leave, not a reason to be stuck inside it: leaving verifies
 // only its own door and where the bot ends up, and reports the damage it saw.
 let damage=null
 const inspect=()=>{
  check()
  if(!leaving)return inspectRetreatShelter(bot,project,{occupants:true})
  try{return inspectRetreatShelter(bot,project,{occupants:false})}catch(error){damage=error.message;return null}
 }
 const door=o.plus(layout.door),inside=door.minus(layout.out),name=build.wood.replace('_log','_door')
 const halves=()=>[bot.blockAt(door),bot.blockAt(door.offset(0,1,0))]
 const valid=()=>halves().every(b=>b?.name===name)&&halves()[0].getProperties().half==='lower'&&halves()[1].getProperties().half==='upper'
 // An empty hand is required here: activating with an item held uses that item instead. When `use` lands, bare-hand becomes an explicit variant of this path, not an invariant of it.
 // Here specifically: a held item would be used on the door instead of opening it.
 const open=async value=>{check();if(!valid())throw new Error('Retreat door missing or changed');if(halves().every(b=>b.getProperties().open===value))return;if(bot.entity.position.distanceTo(door.offset(.5,0,.5))>2.5)await walk(new goals.GoalLookAtBlock(door,bot.world,{reach:3}));check();await bot.unequip('hand');check();if(value&&leaving&&shelteredObservation(bot,project).passed){const threats=departureThreatObservation(bot,{base:project});if(threats.blocking.length)throw new Error('Departure blocked: a potential threat is on or near the door corridor; re-observe before leaving')}await bot.activateBlock(bot.blockAt(door));check();await settle(()=>valid()&&halves().every(b=>b.getProperties().open===value),'Retreat door state not confirmed')}
 const target=leaving?door.plus(layout.out.scaled(2)):inside
 inspect();progress(leaving?(damage?`Leaving the base (it needs repair: ${damage})`:'Leaving the verified base'):'Retreating into the verified lit base')
 await open(true);await walk(new goals.GoalBlock(target.x,target.y,target.z));check()
 await settle(()=>bot.entity.onGround&&bot.entity.position.distanceTo(target.offset(.5,0,.5))<.85,'Retreat did not reach the interior')
 await open(false);const lighting=inspect()
 if(!bot.entity.onGround||bot.entity.position.distanceTo(target.offset(.5,0,.5))>=.85)throw new Error('Door closure moved the bot away from the verified arrival point')
 return {item:'shelter',count:1,receipt:leaving?'left_base_door_closed':'sheltered_door_closed',position:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z},door:{position:door,closed:true},lighting,...(damage?{damage}:{})}
}

export function inspectRetreatShelter(bot,project,{occupants=true}={}){
 const build=project.build,o=new Vec3(build.origin.x,build.origin.y,build.origin.z),layout=shelterLayout(build.design)
  for(const b of build.design)if(bot.blockAt(o.offset(b.x,b.y,b.z))?.name!==(b.block==='wood_planks'?build.wood.replace('_log','_planks'):b.block))throw new Error('Retreat shelter structure is missing or changed at '+o.offset(b.x,b.y,b.z)+': '+(bot.blockAt(o.offset(b.x,b.y,b.z))?.name||'unloaded'))
  // Retreat needs the doorway and its two-cell centre approach; the
  // builder's wider construction clearance can overlap neighbouring builds.
  inspectShelterSite(bot,o,shelterAccessLayout(layout))
  const t=project.stations?.torch?.position;if(!t)throw new Error('Retreat shelter has no recorded light')
  const lighting=shelterLightBounds(bot,new Vec3(t.x,t.y,t.z),layout.inside.flatMap(p=>[o.plus(p),o.plus(p).offset(0,1,0)]))
  if(lighting.some(c=>c.lowerBound<8))throw new Error('Retreat shelter lighting cannot be established')
  if(occupants)assertNoHostileOccupants(bot,[...layout.inside,layout.door].flatMap(p=>Array.from({length:layout.roof},(_,y)=>o.plus(p).offset(0,y,0))))
  return lighting
 }

export function shelteredObservation(bot,project){
 try{
  const lighting=inspectRetreatShelter(bot,project),build=project.build,o=new Vec3(build.origin.x,build.origin.y,build.origin.z),layout=shelterLayout(build.design),door=o.plus(layout.door),name=build.wood.replace('_log','_door')
  const position=bot.entity.position.floored(),inside=bot.entity.onGround&&layout.inside.some(p=>o.plus(p).equals(position)),closed=[0,1].every(y=>{const b=bot.blockAt(door.offset(0,y,0));return b?.name===name&&b.getProperties().open===false&&b.getProperties().half===(y?'upper':'lower')})
  return {inside,closed,lighting,passed:inside&&closed}
 }catch(error){return {passed:false,reason:error.message}}
}

// Occupancy is geometry, not a claim that a damaged/unlit base is safe. Its
// checked leave action can still open the door and verify an exterior arrival.
export function insideBase(bot,project){
 try{
  const build=project.build,o=new Vec3(build.origin.x,build.origin.y,build.origin.z),layout=shelterLayout(build.design),p=bot.entity.position.floored()
  return p.y>=o.y&&p.y<o.y+layout.roof&&layout.inside.some(q=>q.x+o.x===p.x&&q.z+o.z===p.z)
 }catch{return false}
}
