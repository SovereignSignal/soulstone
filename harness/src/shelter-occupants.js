import {fullCube} from './construction.js'
import {hostileNow,wearsGold,FIRE_BLOCKS} from './survival.js'

// Use all loaded entities, not the truncated nearby-threat summary. Bounding
// boxes catch mobs straddling the doorway or standing on furniture.
// Hostile to this bot, not by name alone: a gold-less bot's adult piglin and a screaming enderman count.
export function assertNoHostileOccupants(bot,cells){
 const gold=wearsGold(bot)
 for(const e of Object.values(bot.entities||{})){
  if(!e.position||!hostileNow(bot,e,gold))continue
  const p=e.position,w=(e.width||.6)/2,h=e.height||1.8
  if(cells.some(c=>p.x+w>c.x&&p.x-w<c.x+1&&p.z+w>c.z&&p.z-w<c.z+1&&p.y+h>c.y&&p.y<c.y+1))throw new Error('Shelter contains a potential hostile: '+e.name)
 }
}

// Emergency shelters are small closed cavities. Follow their actual connected
// air volume, including any alcove dug for material, instead of trusting a cap
// receipt. Unknown blocks, liquids, fire and open space cannot establish protection.
// limit: the cavity's cells; a covered route (covered-moves.js) passes COVERED_CELLS.
// The closed cavity's air cells from the bot's feet, without judging who is in it (a mob shut in with the bot, controller.js).
export function cavityCells(bot,{limit=32}={}){
 const p=bot.entity?.position
 if(!p||!bot.blockAt)throw new Error('Emergency shelter position or blocks unavailable')
 const feet=p.floored(),solid=b=>!!b&&fullCube(bot.registry,b.name)
 if(!solid(bot.blockAt(feet.offset(0,-1,0))))throw new Error('Emergency shelter has no solid floor')
 const queue=[feet],seen=new Set(),inside=[]
 while(queue.length){
  const c=queue.shift(),key=c.toString()
  if(seen.has(key))continue
  seen.add(key)
  const b=bot.blockAt(c)
  if(!b)throw new Error('Emergency shelter boundary is not observed')
  if(solid(b)){
   if(c.equals(feet)||c.equals(feet.offset(0,1,0)))throw new Error('Emergency shelter body space is obstructed')
   continue
  }
  if(['water','lava','bubble_column'].includes(b.name))throw new Error('Emergency shelter contains liquid')
  // A fireball can light the floor inside (review of lab run 156, 15 October): fire is no shelter.
  if(FIRE_BLOCKS.has(b.name))throw new Error('Emergency shelter contains fire')
  inside.push(c)
  if(inside.length>limit)throw new Error('Emergency shelter is open or exceeds the verified cavity limit')
  for(const [x,y,z] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]])queue.push(c.offset(x,y,z))
 }
 if(!inside.some(c=>c.equals(feet.offset(0,1,0))))throw new Error('Emergency shelter has no headroom')
 return inside
}
export function inspectEmergencyShelter(bot,{limit=32}={}){
 const inside=cavityCells(bot,{limit})
 assertNoHostileOccupants(bot,inside)
 return {verified:true,cells:inside.length,scope:'Observed closed cavity and loaded hostile occupants; rechecked while waiting'}
}
