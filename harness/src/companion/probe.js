// Surroundings probe: what the bot's own client believes about the blocks and
// physics around its feet. Read-only; for diagnosing stalls from outside.
import {Vec3} from 'vec3'
export function surroundings(bot,{radius=1,below=1,above=2}={}){
 const p=bot?.entity?.position
 if(!p)return {connected:false}
 const feet=p.floored(),cells=[]
 for(let dy=-below;dy<=above;dy++)for(let dx=-radius;dx<=radius;dx++)for(let dz=-radius;dz<=radius;dz++){
  const c=feet.offset(dx,dy,dz),b=bot.blockAt?.(c)
  cells.push({dx,dy,dz,name:b?.name??null,box:b?.boundingBox??null})
 }
 const e=bot.entity
 return {position:{x:p.x,y:p.y,z:p.z},feet:{x:feet.x,y:feet.y,z:feet.z},onGround:e.onGround??null,isInWater:e.isInWater??null,isInLava:e.isInLava??null,velocity:e.velocity?{x:e.velocity.x,y:e.velocity.y,z:e.velocity.z}:null,
  standingOn:bot.blockAt?.(feet.offset(0,-1,0))?.name??null,inside:bot.blockAt?.(feet)?.name??null,head:bot.blockAt?.(feet.offset(0,1,0))?.name??null,cells}
}
