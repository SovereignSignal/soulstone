// Whether a hostile can get to the bot at all. A mob reaches it through open
// cells or not at all, so straight-line distance through rock is not danger:
// trial 42 spent 24 of 30 minutes re-sheltering from a cave thirteen blocks
// below a bot that nothing could path to, see or shoot. This follows the open
// space the bot stands in, out to a little past the widest threat radius, and
// says for each hostile whether that space contains it.
import {Vec3} from 'vec3'
import {fullCube} from './construction.js'
export const REACH_RADIUS=20
export const REACH_CELLS=12000
const NEIGHBOURS=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
// 'open': the hostile stands in space connected to the bot. 'sealed': the whole
// connected space within the radius was observed and it is not in it. 'unknown':
// unloaded cells or more space than the limit, which proves nothing.
export function threatReach(bot,threats,{radius=REACH_RADIUS,limit=REACH_CELLS,origins=null}={}){
 const p=bot?.entity?.position
 if(!p||!bot.blockAt||!threats.every(t=>t.position))return threats.map(()=>'unknown')
 const origin=p.floored(),solids=new Map()
 // The search has to cover wherever the hostiles asked about are standing: a
 // skeleton at twenty-two blocks is not sealed off just for being past twenty.
 const reach=Math.max(radius,...threats.map(t=>Math.ceil(Math.hypot(t.position.x-p.x,t.position.y-p.y,t.position.z-p.z))+2))
 const solid=name=>{let v=solids.get(name);if(v===undefined)solids.set(name,v=fullCube(bot.registry,name));return v}
 // A shut door, trapdoor or fence gate is not a full cube, but below Hard no
 // mob opens or breaks one, so it closes the space like a wall (lab run 24,
 // 3 October: from one cell under its own floor every hostile outside the hut
 // read as reachable, through the closed door above).
 const hard=bot.game?.difficulty==='hard'
 const barrier=b=>!hard&&/_door$|_trapdoor$|_fence_gate$/.test(b.name)&&b.getProperties?.().open===false
 // Feet and head cell of each hostile; either one in the bot's space is contact.
 const wanted=new Map()
 threats.forEach((t,i)=>{const c=new Vec3(t.position.x,t.position.y,t.position.z).floored();for(const k of [c.toString(),c.offset(0,1,0).toString()])wanted.set(k,[...(wanted.get(k)||[]),i])})
 // A shelter is judged from where it opens, not from inside its own walls.
 const found=threats.map(()=>false),seen=new Set(),queue=origins?[...origins]:[origin,origin.offset(0,1,0)]
 let inconclusive=false,cells=0
 for(let i=0;i<queue.length&&!found.every(Boolean);i++){
  const c=queue[i],key=c.toString()
  if(seen.has(key))continue
  seen.add(key)
  // Space that leaves the radius is a long way round, not an unknown.
  if(c.distanceTo(origin)>reach)continue
  const b=bot.blockAt(c)
  if(!b){inconclusive=true;continue}
  if(solid(b.name)||barrier(b))continue
  if(++cells>limit){inconclusive=true;break}
  for(const index of wanted.get(key)||[])found[index]=true
  for(const [x,y,z] of NEIGHBOURS)queue.push(c.offset(x,y,z))
 }
 return found.map(hit=>hit?'open':inconclusive?'unknown':'sealed')
}
