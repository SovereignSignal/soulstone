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
// An 'unknown' still says how far the flood got: atLeast is the depth at which
// it first could not go on, and no route it has not found is shorter. Lab run
// 145, 15 October: open Nether air ran the flood out of cells, and a wither
// skeleton below the netherrack, "unknown" for good, held the bot walled in at
// the portal until it went home.
export function threatReach(bot,threats,options={}){return threatRoutes(bot,threats,options).map(r=>r.reach)}
export function threatRoutes(bot,threats,{radius=REACH_RADIUS,limit=REACH_CELLS,origins=null}={}){
 const p=bot?.entity?.position
 if(!p||!bot.blockAt||!threats.every(t=>t.position))return threats.map(()=>({reach:'unknown',steps:null,atLeast:null}))
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
 const closed=cellLookup(bot,b=>solid(b.name)||barrier(b))
 // Cells are numbers, not strings or vectors: on a Raspberry Pi the flood took a
 // quarter of the bot's time in a fortress fight (lab run 123, 13 October).
 // Every cell the search can touch lies within H of the origin on each axis.
 const seeds=(origins?origins.map(c=>new Vec3(c.x,c.y,c.z).floored()):[origin,origin.offset(0,1,0)])
 const H=reach+2+Math.max(0,...seeds.map(c=>Math.max(Math.abs(c.x-origin.x),Math.abs(c.y-origin.y),Math.abs(c.z-origin.z)))),S=2*H+1
 const keyOf=(x,y,z)=>{const a=x-origin.x+H,b=y-origin.y+H,c=z-origin.z+H;return a<0||b<0||c<0||a>=S||b>=S||c>=S?-1:(a*S+b)*S+c}
 // Feet and head cell of each hostile; either one in the bot's space is contact.
 const wanted=new Map()
 threats.forEach((t,i)=>{const c=new Vec3(t.position.x,t.position.y,t.position.z).floored();for(const k of [keyOf(c.x,c.y,c.z),keyOf(c.x,c.y+1,c.z)])if(k>=0)wanted.set(k,[...(wanted.get(k)||[]),i])})
 // A shelter is judged from where it opens, not from inside its own walls.
 // Breadth first, each cell queued once at the depth it was first reached.
 const found=threats.map(()=>false),steps=threats.map(()=>null),depth=new Map(),qx=[],qy=[],qz=[]
 for(const c of seeds){const k=keyOf(c.x,c.y,c.z);if(!depth.has(k)){depth.set(k,0);qx.push(c.x);qy.push(c.y);qz.push(c.z)}}
 // The queue holds cells in order of depth, so the first time the flood cannot go
 // on, at depth d, every shallower cell has been judged and expanded. A route not
 // yet found leaves the judged open cells somewhere: at an unloaded cell, which
 // the queue reaches no earlier than this one, at a cell the limit left in the
 // queue (depth d or d+1), or at the hostile's own cell, which would have been
 // found had it been shallower. Each of those lies d or more steps out.
 let bound=null,cells=0,left=threats.length
 for(let i=0;i<qx.length&&left>0;i++){
  const x=qx[i],y=qy[i],z=qz[i],key=keyOf(x,y,z),d=depth.get(key)
  // Space that leaves the radius is a long way round, not an unknown.
  const dx=x-origin.x,dy=y-origin.y,dz=z-origin.z
  if(dx*dx+dy*dy+dz*dz>reach*reach)continue
  const shut=closed(x,y,z)
  if(shut===null){bound??=d;continue}
  if(shut)continue
  if(++cells>limit){bound??=d;break}
  for(const index of wanted.get(key)||[])if(!found[index]){found[index]=true;steps[index]=d;left--}
  for(const [ox,oy,oz] of NEIGHBOURS){const nx=x+ox,ny=y+oy,nz=z+oz,k=keyOf(nx,ny,nz);if(!depth.has(k)){depth.set(k,d+1);qx.push(nx);qy.push(ny);qz.push(nz)}}
 }
 return found.map((hit,i)=>hit?{reach:'open',steps:steps[i]}:bound===null?{reach:'sealed',steps:null}:{reach:'unknown',steps:null,atLeast:bound})
}
// Whether a cell closes the space: true, false, or null where the ground is not
// loaded. With the world's block states to hand, a block is built once per state
// (its name and door state are the state's), not once per cell; the chunk column
// says whether a cell is loaded, since an unloaded one reads as state 0, air.
function cellLookup(bot,closes){
 const slow=(x,y,z)=>{const b=bot.blockAt(new Vec3(x,y,z));return b?closes(b):null}
 const w=bot.world,minY=bot.game?.minY,top=minY+bot.game?.height
 if(typeof w?.getBlockStateId!=='function'||typeof w.getColumnAt!=='function'||!Number.isFinite(top))return slow
 const byState=new Map(),columns=new Map(),at=new Vec3(0,0,0)
 return (x,y,z)=>{
  if(y<minY||y>=top)return slow(x,y,z)
  const ck=`${x>>4},${z>>4}`
  let loaded=columns.get(ck);if(loaded===undefined)columns.set(ck,loaded=!!w.getColumnAt(at.set(x,y,z)))
  if(!loaded)return null
  const id=w.getBlockStateId(at.set(x,y,z))
  let v=byState.get(id);if(v===undefined){v=slow(x,y,z);if(v===null)return null;byState.set(id,v)}
  return v
 }
}
