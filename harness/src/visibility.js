import {Vec3} from 'vec3'

// Geometry evidence only. It never changes a threat radius or authorizes travel.
export function observedSightline(bot,from,to){
 const unknown={status:'unknown'}
 if(![from,to].every(p=>p&&['x','y','z'].every(k=>Number.isFinite(p[k])))||!bot?.blockAt||!bot?.world?.raycast)return unknown
 const start=new Vec3(from.x,from.y,from.z),end=new Vec3(to.x,to.y,to.z),vector=end.minus(start),length=vector.norm()
 if(!length||length>48)return unknown
 const direction=vector.scaled(1/length)
 try{
  // A null raycast can also mean unloaded terrain, so establish observation first.
  for(let d=0;d<length;d+=.25)if(!bot.blockAt(start.plus(direction.scaled(d)).floored()))return unknown
  if(!bot.blockAt(end.floored()))return unknown
  const hit=bot.world.raycast(start,direction,length)
  return hit?{status:'blocked',block:hit.name??hit.block?.name??null}:{status:'clear'}
 }catch{return unknown}
}
