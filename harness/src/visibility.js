import {Vec3} from 'vec3'
import {aimPitch} from './arrow.js'

// Geometry evidence only. It never changes a threat radius or authorizes travel.
// Live rehearsal, 16 October 22:21Z: the hut's port judge and the bow each walked their own line, and the port opened
// where the bow had none. open: cells read as air, a port not yet cut; the ray goes on from where it leaves each one.
// A clear line reports the open cells it passed through (through), a blocked one the cell that stopped it.
export function observedSightline(bot,from,to,{open=[]}={}){
 const unknown={status:'unknown'}
 if(![from,to].every(p=>p&&['x','y','z'].every(k=>Number.isFinite(p[k])))||!bot?.blockAt||!bot?.world?.raycast)return unknown
 const start=new Vec3(from.x,from.y,from.z),end=new Vec3(to.x,to.y,to.z),vector=end.minus(start),length=vector.norm()
 if(!length||length>48)return unknown
 const direction=vector.scaled(1/length),isOpen=c=>open.some(o=>o.x===c.x&&o.y===c.y&&o.z===c.z),through=[]
 try{
  // A null raycast can also mean unloaded terrain, so establish observation first.
  for(let d=0;d<length;d+=.25)if(!bot.blockAt(start.plus(direction.scaled(d)).floored()))return unknown
  if(!bot.blockAt(end.floored()))return unknown
  let at=start,left=length
  for(;;){
   const hit=bot.world.raycast(at,direction,left),cell=hit?.position
   if(!hit)return {status:'clear',...(through.length?{through}:{})}
   if(!cell||!isOpen(cell)||through.some(c=>c.x===cell.x&&c.y===cell.y&&c.z===cell.z))return {status:'blocked',block:hit.name??hit.block?.name??null,...(cell?{cell:{x:cell.x,y:cell.y,z:cell.z}}:{})}
   through.push({x:cell.x,y:cell.y,z:cell.z})
   // On past the open cell: from just beyond the face the ray leaves it by.
   const out=Math.min(...['x','y','z'].map(k=>direction[k]>0?(cell[k]+1-at[k])/direction[k]:direction[k]<0?(cell[k]-at[k])/direction[k]:Infinity))+1e-4
   at=at.plus(direction.scaled(out));left-=out
   if(left<=0)return {status:'clear',through}
  }
 }catch{return unknown}
}

// The bow's aim point: the target's middle, its height from the entity or the registry (a threat record has none).
export const aimPoint=(e,registry)=>{const h=e.height??registry?.entitiesByName?.[e.name]?.height??1.8;return new Vec3(e.position.x,e.position.y+h/2,e.position.z)}
// Live rehearsal, 16 October 22:21Z to 22:38Z: the hut opened its port toward blazes its own judge saw, and the bow, asking
// from the eye at the blaze's middle, found the wall every time. One question for both: the straight line from an eye to
// the aim point, with open cells (a port not yet cut) read as air, and in the bow's reach. The arc is not modelled: inside
// a port's sight (under fifteen blocks) the low arc stays within a few centimetres of the straight line.
export function shotLine(bot,from,target,{open=[]}={}){
 const to=aimPoint(target,bot.registry),sight=observedSightline(bot,from,to,{open})
 return sight.status!=='blocked'&&aimPitch(from,to)===null?{status:'out_of_range'}:sight
}
