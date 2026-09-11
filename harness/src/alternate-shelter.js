import {Vec3} from 'vec3'
import pathfinding from 'mineflayer-pathfinder'
import {compileArchitecture,fullCube} from './construction.js'
import {blockKind,matchesBuildingBlock,passagePoints,setPassageOpen} from './building-blocks.js'
import {assertNoHostileOccupants} from './shelter-occupants.js'
const {goals}=pathfinding
const directions=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
const air=b=>['air','cave_air','torch'].includes(b?.name)
const vec=p=>new Vec3(p.x,p.y,p.z)

export function alternativeShelters(bot,projects){
 return Object.entries(projects).filter(([,p])=>p.status==='completed'&&p.result?.partial===false&&p.construction?.origin)
  .map(([name,p])=>({name,construction:{origin:p.construction.origin,design:p.construction.design}}))
  .filter(s=>vec(s.construction.origin).distanceTo(bot.entity.position)<=48)
  .sort((a,b)=>vec(a.construction.origin).distanceTo(bot.entity.position)-vec(b.construction.origin).distanceTo(bot.entity.position))
}

// A bounded live flood checks enclosure, including holes not explicitly listed
// as blueprint air. One hand-operated entrance is supported for now.
export function inspectConstructionShelter(bot,shelter,{occupants=true}={}){
 const {origin,design}=shelter.construction,o=vec(origin),blueprint=compileArchitecture(design)
 const doors=blueprint.blocks.filter(b=>blockKind(b.block)==='door')
 if(doors.length!==1)throw new Error('Fallback shelter requires one hand-operated door')
 for(const b of blueprint.cells)if(!matchesBuildingBlock(bot.blockAt(o.offset(b.x,b.y,b.z)),b,{ignoreOpen:true}))throw new Error('Fallback structure missing or changed at '+o.offset(b.x,b.y,b.z))
 const door=doors[0],pos=o.offset(door.x,door.y,door.z),halves=[pos,pos.offset(0,1,0)]
 const xs=blueprint.cells.map(b=>b.x),ys=blueprint.cells.map(b=>b.y),zs=blueprint.cells.map(b=>b.z)
 const min=o.offset(Math.min(...xs),Math.min(...ys),Math.min(...zs)),max=o.offset(Math.max(...xs),Math.max(...ys),Math.max(...zs))
 const solid=p=>{const b=bot.blockAt(p);if(!b)throw new Error('Fallback terrain is unloaded');return fullCube(bot.registry,b.name)}
 const flood=start=>{
  const seen=new Map(),queue=[start]
  for(let i=0;i<queue.length;i++){
   const p=queue[i],k=p.toString();if(seen.has(k)||halves.some(q=>q.equals(p)))continue
   if(p.x<min.x||p.x>max.x||p.y<min.y||p.y>max.y||p.z<min.z||p.z>max.z)throw new Error('Fallback room is not enclosed')
   if(solid(p))continue
   const b=bot.blockAt(p);if(!air(b)&&!b.name.endsWith('_bed'))throw new Error('Unsupported or hazardous fallback interior: '+b.name)
   seen.set(k,p);if(seen.size>2048)throw new Error('Fallback room exceeds inspection bound')
   for(const d of directions)queue.push(p.offset(...d))
  }
  return [...seen.values()]
 }
 const sides=passagePoints(pos,door).filter(p=>!p.equals(pos)),rooms=[]
 for(const side of sides){try{const cells=flood(side);if(cells.some(p=>p.equals(side)))rooms.push({side,cells})}catch{}}
 if(rooms.length!==1)throw new Error('Fallback door must separate an enclosed room from outside')
 const {side:inside,cells}=rooms[0],outside=sides.find(p=>!p.equals(inside))
 const walkable=p=>air(bot.blockAt(p))&&air(bot.blockAt(p.offset(0,1,0)))&&solid(p.offset(0,-1,0))
 if(!walkable(inside)||!walkable(outside))throw new Error('Fallback entrance or exit is obstructed or unsupported')
 const feet=cells.filter(walkable);if(feet.length<2)throw new Error('Fallback lacks usable interior space')
 const levels=new Map(),queue=[]
 for(const b of blueprint.blocks.filter(b=>['torch','glowstone'].includes(b.block))){
  const p=o.offset(b.x,b.y,b.z),emission=bot.registry.blocksByName[b.block]?.emitLight
  if(!Number.isInteger(emission))throw new Error('Fallback light emission is unavailable')
  levels.set(p.toString(),emission);queue.push(p)
 }
 const room=new Set(cells.map(p=>p.toString()))
 for(let i=0;i<queue.length;i++){
  const p=queue[i],next=levels.get(p.toString())-1;if(next<=0)continue
  for(const d of directions){const q=p.offset(...d),k=q.toString();if(room.has(k)&&air(bot.blockAt(q))&&(levels.get(k)||0)<next){levels.set(k,next);queue.push(q)}}
 }
 const lighting=feet.flatMap(p=>[p,p.offset(0,1,0)]).map(position=>({position,lowerBound:levels.get(position.toString())||0,method:'observed_blocks_air_path_lower_bound'}))
 if(lighting.some(c=>c.lowerBound<8))throw new Error('Fallback lighting cannot be established')
 if(occupants)assertNoHostileOccupants(bot,[...cells,...halves])
 return {name:shelter.name,door:{position:pos,block:door},inside,outside,cells,feet,lighting}
}
export function occupiedAlternative(bot,projects){
 for(const shelter of alternativeShelters(bot,projects)){
  try{const r=inspectConstructionShelter(bot,shelter,{occupants:false});if(r.cells.some(p=>p.equals(bot.entity.position.floored())))return shelter}catch{}
 }
 return null
}
export async function retreatToConstruction(bot,task,api){
 const shelter=task.goal.shelter,leaving=task.kind==='leave_base'
 const inspect=()=>{api.check();return inspectConstructionShelter(bot,shelter,{occupants:!leaving})}
 let room=inspect();const target=leaving?room.outside:room.inside
 api.progress((leaving?'Leaving ':'Retreating to ')+shelter.name)
 // Avoid forcing a fresh navigation when already within door interaction reach.
 const doorApi={...api,walk:async g=>{if(bot.entity.position.distanceTo(room.door.position.offset(.5,0,.5))>2.5)await api.walk(g)}}
 await setPassageOpen(bot,room.door.position,room.door.block,true,doorApi);api.check();inspect()
 await api.walk(new goals.GoalBlock(target.x,target.y,target.z));api.check()
 await api.settle(()=>bot.entity.onGround&&bot.entity.position.distanceTo(target.offset(.5,0,.5))<.85,'Fallback arrival not confirmed')
 await setPassageOpen(bot,room.door.position,room.door.block,false,doorApi);room=inspect()
 if(!bot.entity.onGround||bot.entity.position.distanceTo(target.offset(.5,0,.5))>=.85)throw new Error('Fallback arrival changed during door closure')
 return {item:'shelter',count:1,receipt:leaving?'left_base_door_closed':'sheltered_door_closed',shelterName:shelter.name,position:vec(bot.entity.position),door:{position:room.door.position,closed:true},lighting:room.lighting}
}
