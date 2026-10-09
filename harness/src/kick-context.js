// What the bot believed when the server kicked it. Twice on 9 October (pi2,
// pi3) the server kicked it for "floating too long" just after it climbed out
// of its burrow; its own view of the ground under it is the evidence that
// separates a block the server never had from anything else.
const round=v=>Math.round(v*10000)/10000
export function kickContext(bot,ownBlocks){
 const p=bot?.entity?.position
 const recentPlacements=[...(ownBlocks?.cells?.entries?.()||[])]
  .sort((a,b)=>b[1].at-a[1].at).slice(0,5)
  .map(([cell,e])=>({cell,name:e.name,ageMs:Date.now()-e.at}))
 if(!p)return {position:null,onGround:null,velocityY:null,column:null,recentPlacements}
 const feet=p.floored(),name=dy=>bot.blockAt?.(feet.offset(0,dy,0))?.name??null
 return {position:{x:round(p.x),y:round(p.y),z:round(p.z)},onGround:bot.entity.onGround??null,
  velocityY:Number.isFinite(bot.entity.velocity?.y)?round(bot.entity.velocity.y):null,
  column:{feet:name(0),below1:name(-1),below2:name(-2)},recentPlacements}
}
