// Wall-in hut: the emergency shelter when the ground cannot be dug. Eight wall
// blocks around the bot's own cell at feet and head level, one helper block and
// one roof block, all from carried full cubes. A closed hut breaks the line of
// sight a creeper needs and every melee reach. Exit by digging one side out.
import {setTimeout as delay} from 'node:timers/promises'
import {fullCube} from './construction.js'
import {scaffoldItems} from './scaffold.js'
import {assertNoHostileOccupants,inspectEmergencyShelter} from './shelter-occupants.js'
import {centreOn,DoorAwareMovements} from './navigation.js'
import pathfinding from 'mineflayer-pathfinder'
const {goals}=pathfinding
import {Vec3} from 'vec3'
export const HUT_BLOCKS=10
const REPLACEABLE=new Set(['air','cave_air','short_grass','tall_grass','fern','large_fern','dead_bush','pink_petals','snow','seagrass','vine'])
const SIDES=[[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]
const solid=(bot,b)=>!!b&&fullCube(bot.registry,b.name)
const key=p=>`${p.x},${p.y},${p.z}`
// The same blocks the burrow caps with and the pathfinder climbs on: never
// obsidian (lab run 57: the hut walled in with it and one wall's worth stayed
// behind in the cave when it opened a side to leave).
export const hutMaterials=scaffoldItems
// Run 84, 9 October: arriving in the Nether among hoglins, the bot beside the
// portal could not wall in ("Cannot wall through nether_portal") and the only
// shelter left was going home. Beside a portal the hut becomes a portal room:
// the portal's far side and its other columns are sealed as well as the bot's
// own walls, so nothing reaches the bot through the portal. The cavity is the
// bot's two cells and the portal's own, which the shelter inspection floods.
function portalRoom(bot,feet){
 for(const [dx,,dz] of SIDES){
  const n=new Vec3(dx,0,dz),front=feet.plus(n)
  if(bot.blockAt(front)?.name!=='nether_portal')continue
  // Level with the portal's bottom row only: a frame on the ground is entered by a jump, and walled from inside it.
  if(bot.blockAt(front.offset(0,-1,0))?.name==='nether_portal')return null
  const lateral=new Vec3(dz,0,dx),cols=[front]
  for(const s of [1,-1]){let c=front.plus(lateral.scaled(s));while(bot.blockAt(c)?.name==='nether_portal'){cols.push(c);c=c.plus(lateral.scaled(s))}}
  let h=0;while(h<23&&bot.blockAt(front.offset(0,h,0))?.name==='nether_portal')h++
  const cells=[],add=c=>{if(!cells.some(x=>x.equals(c)))cells.push(c)}
  for(const c of cols)for(let y=0;y<h;y++)add(c.plus(n).offset(0,y,0))
  for(const c of cols)if(!c.equals(front))for(let y=0;y<h;y++)add(c.minus(n).offset(0,y,0))
  for(const side of [lateral,lateral.scaled(-1),n.scaled(-1)])for(const y of [0,1])add(feet.plus(side).offset(0,y,0))
  add(feet.minus(n).offset(0,2,0));add(feet.offset(0,2,0))
  return cells.sort((a,b)=>a.y-b.y)
 }
 return null
}
export function hutSite(bot){
 const p=bot.entity?.position
 if(!p||!bot.entity.onGround)return {ok:false,reason:'Not standing on solid ground'}
 return hutSiteAt(bot,p.floored())
}
function hutSiteAt(bot,feet){
 if(!solid(bot,bot.blockAt(feet.offset(0,-1,0))))return {ok:false,reason:'No solid floor under the bot'}
 const room=portalRoom(bot,feet)
 if(room){
  for(const c of room){const b=bot.blockAt(c);if(!b)return {ok:false,reason:`Cell ${key(c)} is not observed`};if(!REPLACEABLE.has(b.name)&&!solid(bot,b))return {ok:false,reason:`Cannot wall through ${b.name} at ${key(c)}`}}
  // Every wall stands on the ground at foot level; the cells above hang off the ones below, and the roof off the helper.
  for(const c of room)if(c.y===feet.y&&!solid(bot,bot.blockAt(c))&&!solid(bot,bot.blockAt(c.offset(0,-1,0))))return {ok:false,reason:`No ground to build the wall on at ${key(c.offset(0,-1,0))}`}
  const needed=room.filter(c=>!solid(bot,bot.blockAt(c))).length
  const carried=hutMaterials(bot).reduce((n,i)=>n+i.count,0)
  if(carried<needed)return {ok:false,reason:`${needed} blocks needed to close this spot and ${carried} carried`}
  return {ok:true,feet,needed,portal:true,cells:room}
 }
 for(const [dx,dy,dz] of SIDES){
  for(const level of [0,1]){const c=feet.offset(dx,level,dz),b=bot.blockAt(c);if(!b)return {ok:false,reason:`Cell ${key(c)} is not observed`};if(!REPLACEABLE.has(b.name)&&!solid(bot,b))return {ok:false,reason:`Cannot wall through ${b.name} at ${key(c)}`}}
  // A wall that already stands (a shaft, a cave nook) needs no ground under it.
  const ground=bot.blockAt(feet.offset(dx,-1,dz));if(!solid(bot,bot.blockAt(feet.offset(dx,0,dz)))&&!solid(bot,ground))return {ok:false,reason:`No ground to build the wall on at ${key(feet.offset(dx,-1,dz))}`}
 }
 const roof=bot.blockAt(feet.offset(0,2,0)),helper=bot.blockAt(feet.offset(1,2,0))
 if(!roof||!helper||!(REPLACEABLE.has(roof.name)||solid(bot,roof))||!(REPLACEABLE.has(helper.name)||solid(bot,helper)))return {ok:false,reason:'No room for the roof'}
 // Count what this site actually needs rather than a fixed ten. Terrain, a
 // shaft or a cave nook often supplies several walls, and the bot was refused
 // with nine blocks in hand on a night it could have sealed itself in.
 const wanted=[]
 for(const [dx,dy,dz] of SIDES)for(const level of [0,1])wanted.push(feet.offset(dx,level,dz))
 wanted.push(feet.offset(1,2,0),feet.offset(0,2,0))
 const needed=wanted.filter(c=>!solid(bot,bot.blockAt(c))).length
 const carried=hutMaterials(bot).reduce((n,i)=>n+i.count,0)
 if(carried<needed)return {ok:false,reason:`${needed} blocks needed to close this spot and ${carried} carried`}
 return {ok:true,feet,needed}
}
// Lab run 101, 10 October: the bot had opened its portal room and stepped two
// blocks out to shoot; hoglins came round at ten blocks and, the room a step
// away, it went home through the portal and left the blaze and its rod. The
// nearest standing cell within a few blocks where a portal room closes.
export const PORTAL_ROOM_STEPS=3
export function portalRoomSpot(bot,radius=PORTAL_ROOM_STEPS){
 const p=bot.entity?.position;if(!p)return null
 const here=p.floored();let best=null
 for(let dx=-radius;dx<=radius;dx++)for(let dz=-radius;dz<=radius;dz++)for(const dy of [0,-1,1]){
  if(Math.hypot(dx,dz)>radius)continue
  const c=here.offset(dx,dy,dz)
  if(!REPLACEABLE.has(bot.blockAt(c)?.name)||!REPLACEABLE.has(bot.blockAt(c.offset(0,1,0))?.name))continue
  const site=hutSiteAt(bot,c);if(!site.ok||!site.portal)continue
  const d=Math.hypot(dx,dz)+Math.abs(dy);if(!best||d<best.d)best={cell:c,d}
 }
 return best?.cell??null
}
// Walk to that cell as the bow steps to a firing position: no digging, towering
// or placing on the way, and the runner's movement profile restored after.
async function stepToPortalRoom(bot,check,progress){
 const spot=portalRoomSpot(bot)
 if(!spot)throw new Error(`Cannot wall in at the portal: No spot beside a portal within ${PORTAL_ROOM_STEPS} blocks where a portal room closes`)
 progress(`Stepping back to ${key(spot)} beside the portal`)
 const previous=bot.pathfinder.movements,movement=new DoorAwareMovements(bot)
 Object.assign(movement,{canDig:false,allow1by1towers:false,allowParkour:false,allowSprinting:true,maxDropDown:1,scafoldingBlocks:[]})
 bot.pathfinder.setMovements(movement)
 const timer=setTimeout(()=>bot.pathfinder?.setGoal?.(null),8000)
 try{await bot.pathfinder.goto(new goals.GoalBlock(spot.x,spot.y,spot.z))}catch{check()}finally{clearTimeout(timer);if(previous)bot.pathfinder.setMovements(previous)}
 check()
 const at=bot.entity.position.floored()
 if(!at.equals(spot))throw new Error(`Cannot wall in at the portal: stopped at ${key(at)} short of ${key(spot)}`)
}
async function settle(predicate,{check,ms=1500,poll=50}){
 const end=Date.now()+ms
 while(Date.now()<end){check();if(predicate())return true;await delay(poll)}
 return predicate()
}
export async function wallIn(bot,task,{check,stage,progress}){
 check()
 if(task.goal?.portalRoom&&!hutSite(bot).portal){stage('walking');await stepToPortalRoom(bot,check,progress)}
 const site=hutSite(bot)
 if(!site.ok)throw new Error('Cannot wall in here: '+site.reason)
 bot.pathfinder?.setGoal(null);bot.clearControlStates?.()
 // A player is 0.6 blocks wide. Standing a hand's breadth off centre puts the
 // hitbox inside the next cell, and the server refuses to place a block inside
 // a player: the same two walls fail to close, in the same two cells, every
 // night, while the bot reports carrying enough to finish. Centre, then build.
 const centred=await centreOn(bot,site.feet,check)
 stage('walling');progress('Walling in with carried blocks')
 const {feet}=site
 const placements=[]
 if(site.portal)for(const target of site.cells)placements.push({target,ref:null})
 else{
  for(const [dx,dy,dz] of SIDES){
   placements.push({target:feet.offset(dx,0,dz),ref:feet.offset(dx,-1,dz)})
   placements.push({target:feet.offset(dx,1,dz),ref:feet.offset(dx,0,dz)})
  }
  placements.push({target:feet.offset(1,2,0),ref:feet.offset(1,1,0)})
  placements.push({target:feet.offset(0,2,0),ref:feet.offset(1,2,0)})
 }
 // A portal room's cells take whichever solid neighbour stands when their turn comes, lowest first.
 const anchor=target=>[[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0]].map(([x,y,z])=>target.offset(x,y,z)).find(c=>solid(bot,bot.blockAt(c)))
 let placed=0
 for(const {target,ref} of placements){
  check();assertNoHostileOccupants(bot,[feet,feet.offset(0,1,0)])
  if(solid(bot,bot.blockAt(target))){placed++;continue}
  const material=hutMaterials(bot)[0]
  if(!material)break
  await bot.equip(material,'hand');check()
  const at=ref??anchor(target),reference=at&&bot.blockAt(at)
  if(!solid(bot,reference))continue
  // The bridge can drop a placement or its update: try each block twice.
  for(let attempt=0;attempt<2&&!solid(bot,bot.blockAt(target));attempt++){
   try{await bot.placeBlock(reference,target.minus(at))}catch(error){check()}
   await settle(()=>solid(bot,bot.blockAt(target)),{check})
  }
  if(solid(bot,bot.blockAt(target)))placed++
 }
 const missing=placements.filter(({target})=>!solid(bot,bot.blockAt(target))).map(({target})=>key(target))
 if(missing.length)throw new Error(`Hut incomplete: ${missing.length} of ${placements.length} blocks missing (${missing.slice(0,3).join('; ')})${centred?'':'; could not stand clear of the wall line'}`)
 const protection=inspectEmergencyShelter(bot)
 progress('Closed, unoccupied hut verified; watching protection and the surface')
 const p=bot.entity.position
 return {item:'safety',count:1,receipt:'walled_in',protection,shelterName:'hut',capped:true,placed,...(site.portal?{portalRoom:true}:{}),position:{x:p.x,y:p.y,z:p.z},surface:{x:feet.x,y:feet.y,z:feet.z}}
}
export async function unwall(bot,task,{check,stage,progress}){
 check();const feet=bot.entity.position.floored()
 stage('surfacing');progress('Opening one wall of the hut')
 // Prefer a side whose outside cell is standable, so stepping out is safe.
 // Asked to face a place (the way to a portal in the Nether, run 73), the side
 // toward it opens first among the sides that are safe to step out of.
 const t=task.goal?.toward,facing=([dx,,dz])=>t?-(dx*(t.x-feet.x)+dz*(t.z-feet.z)):0
 const order=[...SIDES].sort((a,b)=>{const score=([dx,,dz])=>{const o=feet.offset(dx*2,0,dz*2);return (REPLACEABLE.has(bot.blockAt(o)?.name)&&REPLACEABLE.has(bot.blockAt(o.offset(0,1,0))?.name)&&solid(bot,bot.blockAt(o.offset(0,-1,0))))?0:1};return score(a)-score(b)||facing(a)-facing(b)})
 for(const [dx,dy,dz] of order){
  const cells=[feet.offset(dx,1,dz),feet.offset(dx,0,dz)]
  let opened=true
  for(const c of cells){
   check();const b=bot.blockAt(c)
   if(!b||REPLACEABLE.has(b.name))continue
   if(bot.tool?.equipForBlock)await bot.tool.equipForBlock(b,{requireHarvest:false,getFromChest:false})
   try{await bot.dig(b);check()}catch{check();opened=false;break}
  }
  if(opened&&cells.every(c=>REPLACEABLE.has(bot.blockAt(c)?.name||'air')))return {item:'safety',count:1,receipt:'unwalled',side:{dx,dz},position:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z}}
 }
 throw new Error('Could not open a wall of the hut')
}
