import {departureThreatObservation} from './shelter-departure.js'
import {assertNoHostileOccupants} from './shelter-occupants.js'
import {Vec3} from 'vec3'
import pathfinding from 'mineflayer-pathfinder'
import {shelterLayout,shelterAccessLayout,inspectShelterSite} from './shelter.js'
import {shelterLightBounds} from './lighting.js'
import {survivalObservation,threatRadius,sealedOff,outOfReach} from './survival.js'
import {threatReach,threatRoutes} from './threat-reach.js'
import {fillCell,solidCube,scaffoldItems,plainCube} from './scaffold.js'
import {DoorAwareMovements} from './navigation.js'
import {inProtectedSite} from './primitives.js'
import {projectFootprints} from './site-survey.js'
import {climbOut} from './burrow.js'
import {projectDimension,sameDimension} from './dimension.js'
import {roofed} from './observations.js'
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
 if(leaving&&insideBase(bot,project)){const refusal=departureRefusal(bot,project);if(refusal)throw refusal}
 inspect();progress(leaving?(damage?`Leaving the base (it needs repair: ${damage})`:'Leaving the verified base'):'Retreating into the verified lit base')
 // From underground near an open back exit the base is entered by the shaft,
 // not the door: walk to the shaft's foot through the tunnels that lead there
 // (lab run 28, 3 October: one cell beside the column at y 57 the retreat took
 // the door path and the pathfinder could not walk to it). If the foot cannot
 // be reached, the door path below is tried as before.
 const shaft=project.backExit?.cell
 if(!leaving&&shaft&&Number.isFinite(project.backExit.bottom)&&!insideBase(bot,project)&&bot.entity.position.y<o.y&&Math.hypot(bot.entity.position.x-(shaft.x+.5),bot.entity.position.z-(shaft.z+.5))<=BACK_EXIT_ENTRANCE_REACH){
  progress('Heading for the back exit to enter the base from below')
  const foot=new Vec3(shaft.x,project.backExit.bottom,shaft.z)
  // Underground the way to the foot may need a few blocks dug or pillared
  // (a capped burrow has no open path anywhere), so this leg digs natural
  // rock and climbs one-wide, never the base's own footprint.
  const movement=new DoorAwareMovements(bot)
  Object.assign(movement,{allow1by1towers:true,allowParkour:false,allowSprinting:false,maxDropDown:1,
   scafoldingBlocks:[...new Set(scaffoldItems(bot).map(i=>bot.registry.itemsByName[i.name]?.id??i.type).filter(Number.isInteger))]})
  const sites=projectFootprints({base:project},projectDimension(project)),cube=plainCube(bot)
  movement.canDig=true;movement.digCost=2
  movement.exclusionAreasBreak.push(block=>!block?.position?0:inProtectedSite(block.position,sites)||!cube(block)?100:0)
  movement.exclusionAreasPlace.push(block=>block?.position&&inProtectedSite(block.position,sites)?100:0)
  bot.pathfinder.setMovements(movement)
  const timer=setTimeout(()=>bot.pathfinder.setGoal(null),40000)
  try{await bot.pathfinder.goto(new goals.GoalBlock(foot.x,foot.y,foot.z))}catch(error){progress(`Could not reach the back exit: ${String(error.message).slice(0,60)}`)}finally{clearTimeout(timer)}
  check()
 }
 if(!leaving&&insideBase(bot,project)){
  // Already behind the walls, or down the back exit under them: the door
  // stays shut (a creeper at it is why the bot is retreating). Come up to the
  // interior and put the floor back over the shaft, so the base reads whole.
  // The pathfinder does not climb a one-wide shaft under a burrow cap (lab
  // run 22: "Navigation ended" at once); the burrow's own climb does, digging
  // what is overhead and pillaring up, which also refills the shaft behind it.
  if(shaft&&bot.entity.position.y<o.y){progress('Climbing the back exit to the base floor');await climbOut(bot,new Vec3(shaft.x,shaft.y,shaft.z),{check,stage:()=>{},progress});check()}
  await walk(new goals.GoalBlock(target.x,target.y,target.z));check()
  await settle(()=>bot.entity.onGround&&bot.entity.position.distanceTo(target.offset(.5,0,.5))<.85,'Retreat did not reach the interior')
  await open(false)
  let capped=false
  if(shaft){
   const floor=new Vec3(shaft.x,shaft.y-1,shaft.z)
   if(!solidCube(bot,bot.blockAt(floor))){
    if(!await fillCell(bot,floor,{check,progress}))throw new Error(`Could not cap the back exit at ${floor.x},${floor.y},${floor.z}`)
    capped=true
   }
   delete project.backExit.bottom
  }
  const lighting=inspect()
  return {item:'shelter',count:1,receipt:'sheltered_door_closed',position:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z},door:{position:door,closed:true},lighting,...(capped?{capped:true}:{})}
 }
 await open(true);await walk(new goals.GoalBlock(target.x,target.y,target.z));check()
 await settle(()=>bot.entity.onGround&&bot.entity.position.distanceTo(target.offset(.5,0,.5))<.85,'Retreat did not reach the interior')
 await open(false);const lighting=inspect()
 if(!bot.entity.onGround||bot.entity.position.distanceTo(target.offset(.5,0,.5))>=.85)throw new Error('Door closure moved the bot away from the verified arrival point')
 return {item:'shelter',count:1,receipt:leaving?'left_base_door_closed':'sheltered_door_closed',position:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z},door:{position:door,closed:true},lighting,...(damage?{damage}:{})}
}

export function inspectRetreatShelter(bot,project,{occupants=true}={}){
 if(!sameDimension(bot,project))throw new Error(`The base is in the ${projectDimension(project)}; go back through the portal to reach it`)
 const build=project.build,o=new Vec3(build.origin.x,build.origin.y,build.origin.z),layout=shelterLayout(build.design)
  for(const b of build.design)if(bot.blockAt(o.offset(b.x,b.y,b.z))?.name!==(b.block==='wood_planks'?build.wood.replace('_log','_planks'):b.block))throw new Error('Retreat shelter structure is missing or changed at '+o.offset(b.x,b.y,b.z)+': '+(bot.blockAt(o.offset(b.x,b.y,b.z))?.name||'unloaded'))
  // Retreat needs the doorway and its two-cell centre approach; the
  // builder's wider construction clearance can overlap neighbouring builds.
  inspectShelterSite(bot,o,shelterAccessLayout(layout),{shaft:project.backExit?.cell||null})
  const t=project.stations?.torch?.position;if(!t)throw new Error('Retreat shelter has no recorded light')
  const lighting=shelterLightBounds(bot,new Vec3(t.x,t.y,t.z),layout.inside.flatMap(p=>[o.plus(p),o.plus(p).offset(0,1,0)]))
  if(lighting.some(c=>c.lowerBound<8))throw new Error('Retreat shelter lighting cannot be established')
  if(occupants)assertNoHostileOccupants(bot,[...layout.inside,layout.door].flatMap(p=>Array.from({length:layout.roof},(_,y)=>o.plus(p).offset(0,y,0))))
  return lighting
 }

export function shelteredObservation(bot,project){
 try{
  const lighting=inspectRetreatShelter(bot,project),build=project.build,o=new Vec3(build.origin.x,build.origin.y,build.origin.z),layout=shelterLayout(build.design),door=o.plus(layout.door),name=build.wood.replace('_log','_door')
  // Down the back exit the same walls and door stand between the bot and the
  // night; its shaft is sealed as it is dug. Being there is being inside.
  // The shaft is one cell wide, so a bot in it is in it, climbing or not.
  const position=bot.entity.position.floored(),inside=inBackExit(bot,project)||bot.entity.onGround&&layout.inside.some(p=>o.plus(p).equals(position)),closed=[0,1].every(y=>{const b=bot.blockAt(door.offset(0,y,0));return b?.name===name&&b.getProperties().open===false&&b.getProperties().half===(y?'upper':'lower')})
  return {inside,closed,lighting,passed:inside&&closed}
 }catch(error){return {passed:false,reason:error.message}}
}

// Occupancy is geometry, not a claim that a damaged/unlit base is safe. Its
// checked leave action can still open the door and verify an exterior arrival.
export function insideBase(bot,project){
 // The same x and z in another dimension is somewhere else.
 if(!sameDimension(bot,project))return false
 try{
  const build=project.build,o=new Vec3(build.origin.x,build.origin.y,build.origin.z),layout=shelterLayout(build.design),p=bot.entity.position.floored()
  if(p.y>=o.y&&p.y<o.y+layout.roof&&layout.inside.some(q=>q.x+o.x===p.x&&q.z+o.z===p.z))return true
  // The back exit's shaft is part of the base: a bot in it is behind the
  // base's walls, and a safety retreat from its bottom heads up, not out.
  return inBackExit(bot,project)
 }catch{return false}
}
// In the back exit's shaft, below the base floor. Inside the base for safety
// (a retreat heads up the shaft), but not behind the door for departure: work
// from here goes on through rock and never needs the door or the daylight.
// BACK_EXIT_DEPTH (9) plus a burrow's four cells.
export const BACK_EXIT_REACH=13
// How far underground the shaft counts as the way home (an expedition's starter bounds).
export const BACK_EXIT_ENTRANCE_REACH=32
export function inBackExit(bot,project){
 if(!sameDimension(bot,project))return false
 try{
  const shaft=project.backExit,o=project.build.origin,p=bot.entity.position.floored()
  // Bounded by what the exit and a burrow from its bottom can dig, not by the
  // recorded bottom: a safety burrow from the shaft (lab run 21) went four
  // cells past the record, and the bot was still under its own floor.
  return !!shaft?.cell&&p.x===shaft.cell.x&&p.z===shaft.cell.z&&p.y<o.y&&p.y>=o.y-BACK_EXIT_REACH
 }catch{return false}
}
// What the planner is told about the back exit: where it is, whether it is
// open, and whether the bot stands at its foot (lab run 26, 3 October: from
// nine under its base the planner's first step was to go back up to the base).
export function backExitObservation(bot,project){
 try{
  const shaft=project?.backExit;if(!shaft?.cell)return null
  const o=project.build.origin,p=bot.entity.position.floored(),within=inBackExit(bot,project)
  const open=Number.isFinite(shaft.bottom)
  return {cell:{...shaft.cell},...(open?{bottom:shaft.bottom}:{}),open,inShaft:within,atFoot:within&&open&&p.y<=shaft.bottom+1,depthBelowFloor:within?o.y-p.y:0}
 }catch{return null}
}

// The nearest hostile inside its own interruption radius that could meet the
// bot at the door, or null. The question is what the door opens on to, so a
// hostile behind something is judged by the reach flood from the door's
// outside cells, and one sealed off from there past the rock floors does not
// count (lab run 32, 3 October: skeletons sealed in caves under the base held
// the door shut by daylight after the camping creeper was gone).
export const pressingOutside=(bot,project=null)=>{
 try{
  const near=(survivalObservation(bot).nearbyThreats||[]).filter(t=>t.risk==='potential_hostile'&&t.distance<=threatRadius(t.name))
  const blocked=near.filter(t=>t.sightline?.status==='blocked'&&t.position)
  if(blocked.length&&project?.build?.origin){
   // Flood from the hostile toward the doorstep, not the other way: a sealed
   // cave exhausts in a few hundred cells, and a mob in the open finds the
   // doorstep at once, where a flood out from the door over open ground runs
   // past the cell limit and proves nothing.
   const o=new Vec3(project.build.origin.x,project.build.origin.y,project.build.origin.z),layout=shelterLayout(project.build.design),doorstep=o.plus(layout.door).plus(layout.out)
   for(const t of blocked){
    const from={entity:{position:new Vec3(t.position.x,t.position.y,t.position.z)},blockAt:p=>bot.blockAt(p),registry:bot.registry,game:bot.game}
    const route=threatRoutes(from,[{position:doorstep}])[0];t.reach=route.reach;t.routeSteps=route.steps
   }
  }
  return near.filter(t=>!outOfReach(t)).sort((a,b)=>a.distance-b.distance)[0]||null
 }catch{return null}
}
// Why the door stays shut, or null. One answer for every way out: the
// automatic exit before work, the planner's own leave_base step, and the
// skills that open the door themselves (lab run 30, 3 October: prepare's own
// departure walked out at night with a creeper eleven blocks off).
export const departureRefusal=(bot,project=null)=>{
 // Work that starts outside with dusk under a minute away ends outside in the
 // dark: a furnace trip at 12500 met a zombie and a skeleton eighteen blocks
 // from the door. Stay in until daylight; the night wait resumes the request.
 const tod=bot?.time?.timeOfDay
 if(Number.isFinite(tod)&&(tod>=11500||tod<1000))return new Error(`Dusk is ${tod>=11500&&tod<12500?'less than a minute away':'here'}; staying in the base until daylight rather than starting work outside. Work underground can go on through the back exit (tunnel_out)`)
 // Nor onto a hostile already inside its interruption radius: that is the
 // same loop as the wait, through the other door.
 const pressing=pressingOutside(bot,project)
 if(pressing)return new Error(`A ${pressing.name} is ${pressing.distance} blocks from the base, inside its interruption radius; staying in until it moves on. Work underground can go on through the back exit (tunnel_out)`)
 return null
}

// Away from the sky: under rock, or where the sky's light does not reach the bot's
// head (the foot of an open shaft has one roof block far overhead and is not
// "roofed"; lab run 34). The base's own interior is dark too, and is not underground.
// Gather and the food floor share this test (pi2, 10 October 22:33Z).
export function awayFromSky(bot,project){
 const head=bot.blockAt?.(bot.entity.position.floored().offset(0,1,0))
 const dark=head?.skyLight===0&&!(insideBase(bot,project)&&!inBackExit(bot,project))
 return roofed(bot)||dark
}
