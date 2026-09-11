import pathfinding from 'mineflayer-pathfinder'
import {WATER_BLOCKS} from './survival.js'
const {Movements}=pathfinding
export function requireReachedGoal(bot,goal) {
 // Pinned goto() resolves for an empty noPath result. Never equate the
 // promise resolving with arrival, especially before using a workstation.
 if(!goal.isEnd(bot.entity.position.floored()))throw Object.assign(new Error('Navigation ended without reaching the target'),{code:'NAVIGATION_INCOMPLETE'})
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
export class DoorAwareMovements extends Movements {
 constructor(bot,{surfaceWaterOnly=false}={}){
  super(bot);this.surfaceWaterOnly=surfaceWaterOnly;this.waterIDs=new Set([...WATER_BLOCKS].map(n=>bot.registry.blocksByName[n]?.id).filter(Number.isInteger))
  if(!surfaceWaterOnly)for(const id of this.waterIDs)this.blocksToAvoid.add(id)
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
     const feet=this.getBlock(node,dir.x,-drop,dir.z),head=this.getBlock(node,dir.x,1-drop,dir.z)
     return feet.safe&&head.safe&&!feet.liquid&&!head.liquid?feet:null
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
