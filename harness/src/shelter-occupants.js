import {isPotentialHostile} from './survival.js'

// Use all loaded entities, not the truncated nearby-threat summary. Bounding
// boxes catch mobs straddling the doorway or standing on furniture.
export function assertNoHostileOccupants(bot,cells){
 for(const e of Object.values(bot.entities||{})){
  if(!e.position||!isPotentialHostile(e.name))continue
  const p=e.position,w=(e.width||.6)/2,h=e.height||1.8
  if(cells.some(c=>p.x+w>c.x&&p.x-w<c.x+1&&p.z+w>c.z&&p.z-w<c.z+1&&p.y+h>c.y&&p.y<c.y+1))throw new Error('Shelter contains a potential hostile: '+e.name)
 }
}
