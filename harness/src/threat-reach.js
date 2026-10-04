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
// threatRoutes also says how long the route is: the flood is breadth first,
// so the step count at which a hostile's cell is reached is the length of the
// shortest open route to it (6-neighbour steps, which overstate a diagonal
// walk by up to about 1.4 in the plane). Test run 46, 3 October: one skeleton
// standing still 15.8 blocks away behind rock, joined to the bot only by a
// long winding cave, interrupted 30 cycles in 45 minutes because "open" was
// all the rule knew.
export function threatReach(bot,threats,options={}){return threatRoutes(bot,threats,options).map(r=>r.reach)}
export function threatRoutes(bot,threats,{radius=REACH_RADIUS,limit=REACH_CELLS,origins=null}={}){
 const p=bot?.entity?.position
 if(!p||!bot.blockAt||!threats.every(t=>t.position))return threats.map(()=>({reach:'unknown',steps:null}))
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
 const found=threats.map(()=>false),steps=threats.map(()=>null),seen=new Set(),queue=origins?[...origins]:[origin,origin.offset(0,1,0)]
 const depth=new Map(queue.map(c=>[c.toString(),0]))
 let inconclusive=false,cells=0
 for(let i=0;i<queue.length&&!found.every(Boolean);i++){
  const c=queue[i],key=c.toString(),d=depth.get(key)??0
  if(seen.has(key))continue
  seen.add(key)
  // Space that leaves the radius is a long way round, not an unknown.
  if(c.distanceTo(origin)>reach)continue
  const b=bot.blockAt(c)
  if(!b){inconclusive=true;continue}
  if(solid(b.name)||barrier(b))continue
  if(++cells>limit){inconclusive=true;break}
  for(const index of wanted.get(key)||[])if(!found[index]){found[index]=true;steps[index]=d}
  for(const [x,y,z] of NEIGHBOURS){const n=c.offset(x,y,z),k=n.toString();if(!depth.has(k))depth.set(k,d+1);queue.push(n)}
 }
 return found.map((hit,i)=>({reach:hit?'open':inconclusive?'unknown':'sealed',steps:hit?steps[i]:null}))
}
