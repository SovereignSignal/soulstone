// Wall-in hut: the emergency shelter when the ground cannot be dug. Eight wall
// blocks around the bot's own cell at feet and head level, one helper block and
// one roof block, all from carried full cubes. A closed hut breaks the line of
// sight a creeper needs and every melee reach. Exit by digging one side out.
import {setTimeout as delay} from 'node:timers/promises'
import {fullCube} from './construction.js'
import {scaffoldItems} from './scaffold.js'
import {assertNoHostileOccupants,inspectEmergencyShelter} from './shelter-occupants.js'
import {centreOn,DoorAwareMovements} from './navigation.js'
import {SHOOTERS_ONLY,FIRE_BLOCKS} from './survival.js'
import {hop} from './portal-guard.js'
import {inNether} from './dimension.js'
import {claimPlaced,breakable,ownedNow} from './natural.js'
import {plainFirst,holdToPlace} from './placement.js'
import pathfinding from 'mineflayer-pathfinder'
const {goals}=pathfinding
import {Vec3} from 'vec3'
export const HUT_BLOCKS=10
const REPLACEABLE=new Set(['air','cave_air','short_grass','tall_grass','fern','large_fern','dead_bush','pink_petals','snow','seagrass','vine'])
const SIDES=[[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]
const solid=(bot,b)=>!!b&&fullCube(bot.registry,b.name)
const key=p=>`${p.x},${p.y},${p.z}`
const xyz=p=>({x:p.x,y:p.y,z:p.z})
// The same blocks the burrow caps with and the pathfinder climbs on: never
// obsidian (lab run 57: the hut walled in with it and one wall's worth stayed
// behind in the cave when it opened a side to leave).
// Lab run 165, 15 October: in slot order the hut spent a single dirt block ahead of a
// stack of cobblestone, and the cell after it was clicked with the spent dirt. The
// biggest stack goes first, so a ten-block hut rarely empties a stack mid-build.
// Plain ground blocks go before anything built or bought, so a hut never spends logs,
// planks or iron blocks while cobblestone is carried (review of run 165, 16 October).
// An explicit list: isNatural (natural.js) also admits ores and ancient debris, and breakable glowstone in the Nether.
// The burrow, fillCell and the pathfinder keep slot order.
const PLAIN=new Set(['cobblestone','cobbled_deepslate','netherrack','dirt','stone','deepslate','blackstone','basalt'])
export const hutMaterials=bot=>scaffoldItems(bot).sort((a,b)=>PLAIN.has(b.name)-PLAIN.has(a.name)||b.count-a.count)
// Run 84, 9 October: arriving in the Nether among hoglins, the bot beside the
// portal could not wall in ("Cannot wall through nether_portal") and the only
// shelter left was going home. Beside a portal the hut becomes a portal room:
// the portal's far side and its other columns are sealed as well as the bot's
// own walls, so nothing reaches the bot through the portal. The cavity is the
// bot's two cells and the portal's own, which the shelter inspection floods.
// facesOnly: only the portal's own faces, the far side of every column and the near side of the others (seal_portal).
function portalRoom(bot,feet,{facesOnly=false}={}){
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
  if(facesOnly)return cells.sort((a,b)=>a.y-b.y)
  for(const side of [lateral,lateral.scaled(-1),n.scaled(-1)])for(const y of [0,1])add(feet.plus(side).offset(0,y,0))
  add(feet.minus(n).offset(0,2,0));add(feet.offset(0,2,0))
  return cells.sort((a,b)=>a.y-b.y)
 }
 return null
}
export function hutSite(bot,opts={}){
 const p=bot.entity?.position
 if(!p||!bot.entity.onGround)return {ok:false,reason:'Not standing on solid ground'}
 return hutSiteAt(bot,p.floored(),opts)
}
// Live rehearsal, 16 October (18:18Z): an alarm in the fifth bore column along the fortress bridge stepped
// back to the portal to wall in, leaving the tunnel's far end open on the bridge. A bot standing in a
// covered column (floor, roof and both sides at feet and head full cubes, only its front and back open)
// walls in where it stands. The open cells it would close, or null.
// cell: judge that standing cell instead of the bot's own (leavePortal, 19:25Z).
export function coveredColumn(bot,cell=null){
 const p=bot.entity?.position;if(!p&&!cell)return null
 const feet=cell??p.floored(),at=c=>bot.blockAt(feet.offset(...c))
 if(!solid(bot,at([0,-1,0]))||!solid(bot,at([0,2,0])))return null
 for(const [ax,az] of [[1,0],[0,1]]){
  if(![1,-1].every(s=>[0,1].every(y=>solid(bot,at([s*az,y,s*ax])))))continue
  const open=[1,-1].flatMap(s=>[0,1].map(y=>feet.offset(s*ax,y,s*az))).filter(c=>!solid(bot,bot.blockAt(c)))
  if(open.length)return {feet,open}
 }
 return null
}
function hutSiteAt(bot,feet,{facesOnly=false}={}){
 if(!solid(bot,bot.blockAt(feet.offset(0,-1,0))))return {ok:false,reason:'No solid floor under the bot'}
 const room=portalRoom(bot,feet,{facesOnly})
 if(facesOnly&&!room)return {ok:false,reason:"Stand beside the portal's bottom row to seal it"}
 if(room){
  for(const c of room){const b=bot.blockAt(c);if(!b)return {ok:false,reason:`Cell ${key(c)} is not observed`};if(!REPLACEABLE.has(b.name)&&!solid(bot,b))return {ok:false,reason:`Cannot wall through ${b.name} at ${key(c)}`}}
  // Every wall stands on the ground at foot level; the cells above hang off the ones below, and the roof off the helper.
  for(const c of room)if(c.y===feet.y&&!solid(bot,bot.blockAt(c))&&!solid(bot,bot.blockAt(c.offset(0,-1,0))))return {ok:false,reason:`No ground to build the wall on at ${key(c.offset(0,-1,0))}`}
  const needed=room.filter(c=>!solid(bot,bot.blockAt(c))).length
  const carried=hutMaterials(bot).reduce((n,i)=>n+i.count,0)
  if(carried<needed)return {ok:false,reason:`${needed} blocks needed to close this spot and ${carried} carried`}
  return {ok:true,feet,needed,portal:true,cells:room}
 }
 // A wall cell with nothing under it gets footing first: a carried block placed off the
 // bot's own floor block, which every side cell's ground touches (lab run 142, 14 October:
 // kitted, a hoglin at ten on a fortress walkway, "no ground to build the wall on", home).
 const footing=[]
 for(const [dx,dy,dz] of SIDES){
  for(const level of [0,1]){const c=feet.offset(dx,level,dz),b=bot.blockAt(c);if(!b)return {ok:false,reason:`Cell ${key(c)} is not observed`};if(!REPLACEABLE.has(b.name)&&!solid(bot,b))return {ok:false,reason:`Cannot wall through ${b.name} at ${key(c)}`}}
  // A wall that already stands (a shaft, a cave nook) needs no ground under it.
  const under=feet.offset(dx,-1,dz),ground=bot.blockAt(under)
  if(!solid(bot,bot.blockAt(feet.offset(dx,0,dz)))&&!solid(bot,ground)){
   if(!ground||!REPLACEABLE.has(ground.name))return {ok:false,reason:`No ground to build the wall on at ${key(under)}${ground?` (${ground.name})`:''}`}
   footing.push(under)
  }
 }
 const roof=bot.blockAt(feet.offset(0,2,0)),helper=bot.blockAt(feet.offset(1,2,0))
 if(!roof||!helper||!(REPLACEABLE.has(roof.name)||solid(bot,roof))||!(REPLACEABLE.has(helper.name)||solid(bot,helper)))return {ok:false,reason:'No room for the roof'}
 // Count what this site actually needs rather than a fixed ten. Terrain, a
 // shaft or a cave nook often supplies several walls, and the bot was refused
 // with nine blocks in hand on a night it could have sealed itself in.
 const wanted=[]
 for(const [dx,dy,dz] of SIDES)for(const level of [0,1])wanted.push(feet.offset(dx,level,dz))
 wanted.push(feet.offset(1,2,0),feet.offset(0,2,0))
 const needed=wanted.filter(c=>!solid(bot,bot.blockAt(c))).length+footing.length
 const carried=hutMaterials(bot).reduce((n,i)=>n+i.count,0)
 if(carried<needed)return {ok:false,reason:`${needed} blocks needed to close this spot and ${carried} carried`}
 return {ok:true,feet,needed,footing}
}
// Lab run 101, 10 October: the bot had opened its portal room and stepped two
// blocks out to shoot; hoglins came round at ten blocks and, the room a step
// away, it went home through the portal and left the blaze and its rod. The
// nearest standing cell within a few blocks where a portal room closes.
export const PORTAL_ROOM_STEPS=5
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
// Place each target from carried blocks: the planned reference or any solid neighbour, two clicks a cell, one hop when
// the Nether ignores a placement, each placed block claimed as the bot's own. Shared by the hut and seal_portal.
// Returns how many targets stand solid.
async function placeCells(bot,placements,{check,progress,feet,materials=()=>hutMaterials(bot)}){
 // A portal room's cells take whichever solid neighbour stands when their turn comes, lowest first.
 const around=target=>[[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0]].map(([x,y,z])=>target.offset(x,y,z))
 let placed=0,hopped=false
 for(const {target,ref} of placements){
  check();assertNoHostileOccupants(bot,[feet,feet.offset(0,1,0)])
  if(solid(bot,bot.blockAt(target))){placed++;continue}
  if(!materials().length)break
  // A planned reference that is gone (a fireball, a mob) gives way to any solid neighbour,
  // and one with a use (a chest, a dropper) to a plain one (lab run 163, placement.js).
  const reference=plainFirst([...(ref?[ref]:[]),...around(target)].map(c=>bot.blockAt(c)).filter(b=>solid(bot,b)))[0],at=reference?.position
  if(!reference){progress(`Nothing solid to place against at ${key(target)}`);continue}
  // The bridge can drop a placement or its update: try each block twice.
  // Lab run 165, 15 October: the block update lands before the inventory update, so a
  // stack the last click emptied still reads one; the material is picked right before
  // each click, and a kind found gone gives way to the next.
  for(let attempt=0;attempt<2&&!solid(bot,bot.blockAt(target));attempt++){
   const material=materials()[0]
   if(!material)break
   try{await holdToPlace(bot,material.name,check);await bot.placeBlock(reference,target.minus(at))}catch(error){check();progress(`Placement at ${key(target)} unconfirmed: ${String(error.message).slice(0,60)}`)}
   await settle(()=>solid(bot,bot.blockAt(target)),{check})
   // Lab run 147, 15 October: the alarm cancelled a crossing before its arrival hop, and
   // until the bot jumps the server ignores its placements. One hop, then the retry.
   if(!hopped&&inNether(bot)&&!solid(bot,bot.blockAt(target))){hopped=true;await hop(bot,{check});check()}
  }
  if(solid(bot,bot.blockAt(target))){placed++;claimPlaced(bot,target)}
 }
 return placed
}
export async function wallIn(bot,task,{check,stage,progress}){
 check()
 if(task.goal?.portalRoom&&!hutSite(bot).portal){stage('walking');await stepToPortalRoom(bot,check,progress)}
 // A walk or a knockback can leave the bot a moment off the ground; judge the site once it lands.
 if(!bot.entity.onGround)await settle(()=>bot.entity.onGround,{check})
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
  for(const under of site.footing||[])placements.push({target:under,ref:feet.offset(0,-1,0)})
  for(const [dx,dy,dz] of SIDES){
   placements.push({target:feet.offset(dx,0,dz),ref:feet.offset(dx,-1,dz)})
   placements.push({target:feet.offset(dx,1,dz),ref:feet.offset(dx,0,dz)})
  }
  placements.push({target:feet.offset(1,2,0),ref:feet.offset(1,1,0)})
  placements.push({target:feet.offset(0,2,0),ref:feet.offset(1,2,0)})
 }
 const placed=await placeCells(bot,placements,{check,progress,feet})
 const missing=placements.filter(({target})=>!solid(bot,bot.blockAt(target))).map(({target})=>key(target))
 if(missing.length)throw new Error(`Hut incomplete: ${missing.length} of ${placements.length} blocks missing (${missing.slice(0,3).join('; ')})${centred?'':'; could not stand clear of the wall line'}`)
 const protection=inspectEmergencyShelter(bot)
 progress('Closed, unoccupied hut verified; watching protection and the surface')
 const p=bot.entity.position
 return {item:'safety',count:1,receipt:'walled_in',protection,shelterName:'hut',capped:true,placed,...(site.portal?{portalRoom:true}:{}),position:{x:p.x,y:p.y,z:p.z},surface:{x:feet.x,y:feet.y,z:feet.z}}
}
// Lab run 146, 15 October: walled in inside a one-wide netherrack tunnel with
// blazes outside its walls, the only sides with standable ground beyond were the
// tunnel's ends, so the opened wall faced away from every blaze and the bow never
// had a shot in fifteen minutes. Against a shooter the wall facing it opens as a
// firing port, not a door: natural rock and a drop beyond are fine, since nobody
// steps out of it. Lava, water or fire touching the port refuses that side.
// Against a shooter the port is the head cell only (lab run 156, 15 October: a two-high
// port into a sealed room took four blazes' fire, 20 health to 8.7 in six seconds). A
// blaze aims at the target's mid-height from its own feet+1.4, so through a one-high slit
// at eye level the bot sees down into a room whose fireballs all meet the wall below it.
// An enderman is struck through the same port (enderman-stand.js): 2.9 tall, it cannot
// follow through a 2-high wall into the hut, and the port must face it to meet its eyes.
// 16 October: a hut leans on any wall already standing, and in the family world that can be a
// player's. A side opens only through what the bot may break (natural.js): natural ground, or
// a block it placed itself; a player's wall refuses that side, for a port and the plain exit.
const PORT_MOBS=new Set([...SHOOTERS_ONLY,'enderman'])
const LIQUID=new Set(['water','lava','bubble_column'])
const AROUND=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
// The controller tells a stuck hut by these words (waitInBurrow), so they are kept in one place.
export const WALLS_NOT_MINE='not natural ground and not placed by me'
const opens=(bot,b)=>!b||REPLACEABLE.has(b.name)||breakable(bot,b)||ownedNow(bot,b)
// Exported for the hut's watch (burrow.js portSightline), so it judges a shot only through the
// side unhut will open (lab run 166, 16 October).
// Live rehearsal, 16 October 22:21Z: the port opened by pull alone, not where the line was judged. Given goal.side (the
// side the watch judged the line through), only that side is offered, unranked, and every refusal below still applies.
export function firingPort(bot,feet,goal){
 const t=goal.toward,skip=goal.skip||[],given=goal.side
 // An enderman's port is always two high: the pearl it drops is fetched by a step into it.
 const low=goal.shooter==='enderman'
 const toward=([dx,,dz])=>dx*(t.x-feet.x)+dz*(t.z-feet.z)
 const inside=[feet,feet.offset(0,1,0)]
 for(const side of given?SIDES.filter(s=>s[0]===given.dx&&s[2]===given.dz):SIDES.filter(s=>toward(s)>0&&!skip.some(k=>k.dx===s[0]&&k.dz===s[2])).sort((a,b)=>toward(b)-toward(a))){
  const [dx,,dz]=side,cells=low?[feet.offset(dx,1,dz),feet.offset(dx,0,dz)]:[feet.offset(dx,1,dz)]
  const touching=cells.flatMap(c=>[c,...AROUND.map(([x,y,z])=>c.offset(x,y,z))]).filter(c=>!inside.some(i=>i.equals(c)))
  if(touching.every(c=>{const b=bot.blockAt(c);return b&&!LIQUID.has(b.name)&&!FIRE_BLOCKS.has(b.name)})&&cells.every(c=>opens(bot,bot.blockAt(c))))return {side,cells}
 }
 return null
}
export async function unwall(bot,task,{check,stage,progress}){
 check();const feet=bot.entity.position.floored()
 stage('surfacing');progress('Opening one wall of the hut')
 if(task.goal?.toward&&PORT_MOBS.has(task.goal.shooter)){
  const port=firingPort(bot,feet,task.goal)
  if(!port)throw new Error(`No wall facing the ${task.goal.shooter} left to open without lava, water or fire beside it or a block I did not place`)
  const [dx,,dz]=port.side
  for(const c of port.cells){
   check();const b=bot.blockAt(c)
   if(!b||REPLACEABLE.has(b.name))continue
   if(bot.tool?.equipForBlock)await bot.tool.equipForBlock(b,{requireHarvest:false,getFromChest:false})
   await bot.dig(b);check()
  }
  if(!port.cells.every(c=>REPLACEABLE.has(bot.blockAt(c)?.name||'air')))throw new Error(`Could not open a firing port toward the ${task.goal.shooter}`)
  const p=bot.entity.position
  return {item:'safety',count:1,receipt:'unwalled',port:true,side:{dx,dz},opened:port.cells.map(c=>({x:c.x,y:c.y,z:c.z})),position:{x:p.x,y:p.y,z:p.z}}
 }
 // Prefer a side whose outside cell is standable, so stepping out is safe.
 // Asked to face a place (the way to a portal in the Nether, run 73), the side
 // toward it opens first among the sides that are safe to step out of.
 const t=task.goal?.toward,facing=([dx,,dz])=>t?-(dx*(t.x-feet.x)+dz*(t.z-feet.z)):0
 // Going on past mobs that held the hut (lab run 147, 15 October): no wall with any pull
 // toward one of them opens, nor one onto lava, fire or water, nor the portal's own side.
 // With none left the hut stays shut and the caller decides.
 const from=task.goal?.from||[]
 const away=([dx,,dz])=>from.every(m=>dx*(m.x-feet.x)+dz*(m.z-feet.z)<=0)
  &&[-1,0,1].every(y=>{const b=bot.blockAt(feet.offset(dx*2,y,dz*2));return !LIQUID.has(b?.name)&&!/^flowing_/.test(b?.name||'')&&!FIRE_BLOCKS.has(b?.name)})
  &&[0,1].every(y=>bot.blockAt(feet.offset(dx,y,dz))?.name!=='nether_portal')
 const sides=from.length?SIDES.filter(away):SIDES
 if(!sides.length)throw new Error('No wall to open away from the mobs without lava, fire, water or the portal beyond')
 const order=[...sides].sort((a,b)=>{const score=([dx,,dz])=>{const o=feet.offset(dx*2,0,dz*2);return (REPLACEABLE.has(bot.blockAt(o)?.name)&&REPLACEABLE.has(bot.blockAt(o.offset(0,1,0))?.name)&&solid(bot,bot.blockAt(o.offset(0,-1,0))))?0:1};return score(a)-score(b)||facing(a)-facing(b)})
 let refused=0
 for(const [dx,dy,dz] of order){
  const cells=[feet.offset(dx,1,dz),feet.offset(dx,0,dz)]
  if(!cells.every(c=>opens(bot,bot.blockAt(c)))){refused++;continue}
  let opened=true
  for(const c of cells){
   check();const b=bot.blockAt(c)
   if(!b||REPLACEABLE.has(b.name))continue
   if(bot.tool?.equipForBlock)await bot.tool.equipForBlock(b,{requireHarvest:false,getFromChest:false})
   try{await bot.dig(b);check()}catch{check();opened=false;break}
  }
  if(opened&&cells.every(c=>REPLACEABLE.has(bot.blockAt(c)?.name||'air')))return {item:'safety',count:1,receipt:'unwalled',side:{dx,dz},position:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z}}
 }
 throw new Error(`Could not open a wall of the hut${refused?`: ${refused===order.length?`all ${refused} sides are`:refused===1?'one side is':`${refused} sides are`} ${WALLS_NOT_MINE}`:''}`)
}
// Rehearsal, 16 October 19:25Z: at the mouth of its own tunnel beside the arrival portal, a wither skeleton came through
// the portal's open far side and the bot went home. From the covered cell beside the portal the bot places the portal's
// faces (the far side of every column, the near side of the others) through the portal plane, which only the reach
// limits (run 84's portal room does the same). Nothing is dug and the bot never steps into the portal; cobblestone first,
// since a ghast's fireball breaks netherrack. The tunnel behind stays open: tunnel and portal become one cavity, which
// is the bore's to vouch for, so no cavity inspection here. Idempotent: what stands is skipped.
export async function sealPortal(bot,task,{check,stage,progress}){
 check()
 if(!inNether(bot))throw new Error('seal_portal is for the arrival portal in the Nether')
 if(!bot.entity.onGround)await settle(()=>bot.entity.onGround,{check})
 const site=hutSite(bot,{facesOnly:true})
 if(!site.ok)throw new Error('Cannot seal the portal here: '+site.reason)
 const {feet,cells}=site,side=SIDES.find(([dx,,dz])=>bot.blockAt(feet.offset(dx,0,dz))?.name==='nether_portal')
 const receipt=placed=>({item:'safety',count:placed,receipt:'portal_sealed',portal:xyz(feet.offset(side[0],0,side[2])),side:{dx:side[0],dz:side[2]},cells:cells.map(xyz),placed,alreadySealed:placed===0&&site.needed===0})
 if(!site.needed)return receipt(0)
 assertNoHostileOccupants(bot,[feet,feet.offset(0,1,0),...cells])
 await centreOn(bot,feet,check)
 stage('walling');progress(`Sealing the portal's ${site.needed} open face cells`)
 const cobble=()=>{const m=hutMaterials(bot);return [...m.filter(i=>i.name==='cobblestone'),...m.filter(i=>i.name!=='cobblestone')]}
 const before=cells.filter(c=>!solid(bot,bot.blockAt(c))).length
 await placeCells(bot,cells.map(target=>({target,ref:null})),{check,progress,feet,materials:cobble})
 const missing=cells.filter(c=>!solid(bot,bot.blockAt(c))).map(key)
 if(missing.length)throw new Error(`Portal seal incomplete: ${missing.length} of ${cells.length} face cells open (${missing.slice(0,3).join('; ')})`)
 return receipt(before)
}
