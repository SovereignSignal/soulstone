import {setTimeout as delay} from 'node:timers/promises'
import pathfinding from 'mineflayer-pathfinder'
import {WATER_BLOCKS,PORTAL_BLOCKS} from './survival.js'
const {Movements}=pathfinding
// Ground a traveller is allowed to break. The agent digs itself shelters and
// half-builds huts, then meets its own dirt wall as "no route" and stands in it:
// 138 blocks from home, nine pathfinder calls, zero displacement, every rejection
// swallowed. Soft ground and leaves are what actually wall a walker in, so those
// are breakable and nothing else is: never stone, never ore, never the base
// furniture, never a door it should be opening.
export const SOFT_GROUND=new Set(['grass_block','dirt','coarse_dirt','podzol','rooted_dirt','mud','sand','red_sand','gravel','clay','moss_block','snow_block','mycelium'])
export function breakableWhileTravelling(block){
 const name=block?.name||''
 return SOFT_GROUND.has(name)||name.endsWith('_leaves')||name==='snow'
}
// Priced, not free: digTime already reflects the tool carried, and this multiplier
// puts one dirt block at about sixteen walking steps, so any reasonable detour
// still wins and breaking ground stays the last resort it should be.
export const TRAVERSAL_DIG_COST=5
export function allowGroundBreaking(bot,movement,{digCost=TRAVERSAL_DIG_COST}={}){
 movement.canDig=true
 movement.digCost=digCost
 movement.exclusionAreasBreak.push(block=>breakableWhileTravelling(block)?0:100)
 return movement
}
// Stand in the middle of your own cell. A player is 0.6 blocks wide, so a bot a
// hand's breadth off centre has its hitbox inside the neighbouring cell, and the
// server refuses both to place a block there and to let it drop cleanly.
export async function centreOn(bot,cell,check,{tolerance=.15,pulses=12}={}){
 const centre=cell.offset(.5,0,.5)
 const off=()=>Math.hypot(bot.entity.position.x-centre.x,bot.entity.position.z-centre.z)
 for(let i=0;i<pulses&&off()>tolerance;i++){
  check()
  if(bot.lookAt)await bot.lookAt(centre.offset(0,bot.entity.eyeHeight||1.62,0),true)
  bot.setControlState?.('forward',true);await delay(Math.min(120,Math.max(40,off()*250)));bot.setControlState?.('forward',false)
  await delay(80)
 }
 return off()<=tolerance
}
export function requireReachedGoal(bot,goal) {
 // Pinned goto() resolves for an empty noPath result. Never equate the
 // promise resolving with arrival, especially before using a workstation.
 // Standing on a block whose collision top is under a full cube (dirt_path,
 // farmland, soul_sand, mud) floors the position one cell below the goal the
 // pathfinder just satisfied. Mirror its own arrival test rather than rejecting.
 const feet=bot.entity.position.floored()
 if(!goal.isEnd(feet)&&!goal.isEnd(feet.offset(0,1,0)))throw Object.assign(new Error('Navigation ended without reaching the target'),{code:'NAVIGATION_INCOMPLETE'})
}
export function supportsPlayer(target,position) {
 const feet=position.floored()
 return target.x===feet.x&&target.z===feet.z&&target.y<feet.y
}
export function openDoorHasCenterClearance(block) {
 return /_(door|fence_gate)$/.test(block.name||'')&&block.getProperties?.().open===true&&Array.isArray(block.shapes)&&
  !block.shapes.some(([x0,y0,z0,x1,y1,z1])=>x0<.8&&x1>.2&&z0<.8&&z1>.2&&y0<1&&y1>0)
}
// The pinned pathfinder treats every door as a full cube, including open
// wooden doors. Keep closed doors blocked and respect the actual open shape.
// A cell beside lava costs extra to walk through. The pathfinder refuses a lava
// cell and a dig that lets liquid in, but the cell next to lava cost nothing, and
// trial 21's last walk ended on a pool's edge with the bot burning. Priced, not
// forbidden: a shore route stays possible when it is the only one.
export const LAVA_EDGE_COST=4
const AROUND=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]
// The eight cells around p at its own height; the first lava found, or null.
// Runs for every node the search expands, so it reads state ids, not Blocks.
export function lavaBeside(bot,p){
 const lava=bot.registry.blocksByName.lava
 for(const [dx,dz] of AROUND){
  const q=p.offset(dx,0,dz),id=bot.world?.getBlockStateId?.(q)
  if(Number.isInteger(id)?id>=lava.minStateId&&id<=lava.maxStateId:bot.blockAt?.(q)?.name==='lava')return q
 }
 return null
}
export class DoorAwareMovements extends Movements {
 // shallowWaterOnly: wade water with air above and solid ground below, never a
 // deep pool's surface, where the bot sinks (trial 24 spent an hour that way).
 constructor(bot,{surfaceWaterOnly=false,shallowWaterOnly=false}={}){
  super(bot);this.surfaceWaterOnly=surfaceWaterOnly||shallowWaterOnly;this.shallowWaterOnly=shallowWaterOnly;this.waterIDs=new Set([...WATER_BLOCKS].map(n=>bot.registry.blocksByName[n]?.id).filter(Number.isInteger))
  if(!this.surfaceWaterOnly)for(const id of this.waterIDs)this.blocksToAvoid.add(id)
  this.exclusionAreasStep.push(block=>block?.position&&lavaBeside(bot,block.position)?LAVA_EDGE_COST:0)
  // Pathfinder treats lava as replaceable scaffold space, bypassing blocksToAvoid.
  // Its placement hook receives the feet cell for forward bridges, but the
  // support cell for jump-up scaffolds. Reject both before walking to an edge.
  this.exclusionAreasPlace.push(block=>!block?.position||[block.position,block.position.offset(0,-1,0)].some(p=>bot.blockAt(p)?.name==='lava')?100:0)
  // Sov's limit: never step through a portal. A lit nether portal is open air to
  // the pathfinder, so any route through a frame would end in the Nether.
  for(const name of PORTAL_BLOCKS){const id=bot.registry.blocksByName[name]?.id;if(Number.isInteger(id))this.blocksToAvoid.add(id)}
 }
 getLandingBlock(node,dir){
  // Shared walking and gathering allow checked short descents. Measure feet
  // height, and require clear headroom over a full solid, non-hazardous landing.
  if(this.maxDropDown===3){
   for(let drop=1;drop<=3;drop++){
    const floor=this.getBlock(node,dir.x,-drop-1,dir.z)
    if(!floor.position||floor.liquid||this.blocksToAvoid.has(floor.type))return null
    if(floor.physical){
     if(!floor.shapes.some(s=>JSON.stringify(s)==='[0,0,0,1,1,1]'))return null
     // A landing may be a cell this profile is already allowed to break. Ascent
     // through the graph is free and unlimited; descent had no edge at all from
     // a one-wide tower, because the only landing was the tower itself. At drop
     // 1 the mover's own safeOrBreak re-checks these exact cells and refuses
     // when the break is not permitted; at drops 2 and 3 the loop above has
     // already established both are non-physical and safe, so this cannot widen
     // anything there. Falling blocks stay excluded: soft ground includes sand,
     // and a sand shaft is one allow1by1towers=false cannot climb back out of.
     const falls=b=>b.canFall===true||/^(red_sand|suspicious_sand|suspicious_gravel)$/.test(b.name||'')
     const passable=b=>!!b.position&&!b.liquid&&!this.blocksToAvoid.has(b.type)&&(b.safe||(this.safeToBreak(b)&&!falls(b)))
     const feet=this.getBlock(node,dir.x,-drop,dir.z),head=this.getBlock(node,dir.x,1-drop,dir.z)
     return passable(feet)&&passable(head)?feet:null
    }
    if(!floor.safe)return null
   }
   return null
  }
  if(this.maxDropDown!==1)return super.getLandingBlock(node,dir)
  // Upstream measures the support block, rejecting a one-block stair as two.
  // Keep the physical drop limit at one and require solid landing support.
  const floor=this.getBlock(node,dir.x,-2,dir.z)
  if(!floor.physical||floor.liquid)return null
  return this.getBlock(node,dir.x,-1,dir.z)
 }
 getBlock(...args){
  const b=super.getBlock(...args)
  if(this.surfaceWaterOnly&&this.waterIDs.has(b.type)&&(!b.position||!this.bot.blockAt(b.position.offset(0,1,0))||this.waterIDs.has(this.bot.blockAt(b.position.offset(0,1,0))?.type)))return {...b,safe:false}
  if(this.shallowWaterOnly&&this.waterIDs.has(b.type)){const floor=b.position&&this.bot.blockAt(b.position.offset(0,-1,0));if(!floor||floor.boundingBox!=='block'||this.waterIDs.has(floor.type))return {...b,safe:false}}
  return openDoorHasCenterClearance(b)?{...b,safe:!this.blocksToAvoid.has(b.type),physical:false}:b
 }
}

export function correctDoorWaypoints(bot,path) {
 for(const point of path||[]) {
  if(point.toBreak?.length||point.toPlace?.length)continue
  const cell=point.floored(),block=bot.blockAt(cell)
  if(!openDoorHasCenterClearance(block||{}))continue
  const gate=block.name.endsWith('_fence_gate')
  const foot=block.getProperties().half==='upper'?cell.offset(0,-1,0):cell
  const lower=bot.blockAt(foot),upper=bot.blockAt(foot.offset(0,1,0))
  if(!openDoorHasCenterClearance(lower||{})||!(gate?upper?.boundingBox==='empty':openDoorHasCenterClearance(upper||{}))||bot.blockAt(foot.offset(0,-1,0))?.boundingBox!=='block')continue
  // pathfinder 2.4.5 post-processing moves waypoints onto the top of an open
  // door panel. Use the clear centre at floor height, retaining real collisions.
  point.x=foot.x+.5;point.y=foot.y;point.z=foot.z+.5
 }
}
