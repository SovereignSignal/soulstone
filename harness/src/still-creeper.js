import {CLOSE_FLOORS} from './survival.js'
import {dimensionOf} from './dimension.js'

// Live, the play world, 17 October 15:59Z and 16:39Z: a pile of six creepers stood still for over a day about
// 14 blocks from the base door, and a creeper never despawns within 32 blocks of a player, so it was there for
// good while the bot was home. Every morning the shelter watch refused the door on it ("A creeper is 14.2 blocks
// from the base, inside its interruption radius"), and the bot sat in its hut all day and night. The owner's
// rule: in daylight a creeper that has not moved and is 10 or more blocks off does not hold the door.
// Stillness is kept per entity id: an anchor where the creeper was first seen, moved to where it is whenever it
// strays more than STILL_DRIFT from it. A still creeper is one in Overworld daylight that has kept within
// STILL_DRIFT of its anchor for STILL_MS and is at least the creeper close floor (CLOSE_FLOORS.creeper) from the
// bot and from each cell the bot would leave by. At night, outside the Overworld, moving, or closer: it counts.
export const STILL_MS=60000,STILL_DRIFT=1
const anchors=new WeakMap()
// Brought up to date by the survival tick every second, and by every judgement below.
export function noteStill(bot,now=Date.now()){
 if(!bot||typeof bot!=='object')return new Map()
 let seen=anchors.get(bot);if(!seen)anchors.set(bot,seen=new Map())
 const live=new Set()
 for(const [key,e] of Object.entries(bot.entities||{})){
  if(e?.name!=='creeper'||!e.position||e===bot.entity)continue
  const id=e.id??key,p=e.position,a=seen.get(id);live.add(id)
  if(!a||Math.hypot(p.x-a.x,p.y-a.y,p.z-a.z)>STILL_DRIFT)seen.set(id,{x:p.x,y:p.y,z:p.z,since:now})
 }
 for(const id of seen.keys())if(!live.has(id))seen.delete(id)
 return seen
}
// The threat as the observation lists it ({name, distance from the bot, position}); cells are block cells.
export function stillCreeper(bot,t,{cells=[],now=Date.now()}={}){
 if(t?.name!=='creeper'||!t.position||!(t.distance>=CLOSE_FLOORS.creeper))return false
 const tod=bot?.time?.timeOfDay
 if(dimensionOf(bot)!=='overworld'||!(Number.isFinite(tod)&&tod>=1000&&tod<12000))return false
 const p=t.position,away=c=>Math.hypot(p.x-(c.x+.5),p.y-(c.y+.5),p.z-(c.z+.5))>=CLOSE_FLOORS.creeper
 if(!(cells||[]).every(away))return false
 const seen=noteStill(bot,now)
 // Every creeper standing where this one stands: a pile shares a spot, and one that has just walked onto it has not been still.
 const here=Object.entries(bot.entities||{}).filter(([,e])=>e?.name==='creeper'&&e.position&&Math.hypot(e.position.x-p.x,e.position.y-p.y,e.position.z-p.z)<.01)
 return here.length>0&&here.every(([key,e])=>now-(seen.get(e.id??key)?.since??now)>=STILL_MS)
}
