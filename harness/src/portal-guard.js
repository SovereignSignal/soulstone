import {setTimeout as delay} from 'node:timers/promises'
import {portalObservation} from './survival.js'
import {standable} from './fire-safety.js'
import pathfinding from 'mineflayer-pathfinder'
import {dimensionOf} from './dimension.js'
import {wearBestArmor} from './armor.js'
import {unwall,coveredColumn} from './hut.js'
import {wayBack,standingGround} from './trail.js'
import {plainCube} from './scaffold.js'
const {goals}=pathfinding

// The owner's limit: never step through a portal or enter the Nether. A survival
// player standing in a nether portal is carried through after four seconds,
// so this never waits for a model or a path search: it faces the nearest
// standing cell outside the portal and walks.
export async function leavePortal(bot,task,{check,stage,progress},{pollMs=50,stepMs=2000}={}){
 const inside=()=>portalObservation(bot).inPortal===true
 const here=()=>{const p=bot.entity.position.floored();return {x:p.x,y:p.y,z:p.z}}
 check()
 if(!inside())return {item:'safety',count:0,receipt:'not_in_portal',position:here()}
 stage('leaving_portal');progress('I am standing in a portal. Stepping out before it carries me to the Nether')
 const center=bot.entity.position.floored(),out=[]
 for(let dx=-2;dx<=2;dx++)for(let dz=-2;dz<=2;dz++)for(const dy of [0,-1,1]){
  const p=center.offset(dx,dy,dz)
  if((dx||dz)&&standable(bot,p)&&![0,1].some(y=>/portal/.test(bot.blockAt(p.offset(0,y,0))?.name||'')))out.push(p)
 }
 // Rehearsal, 16 October 19:25Z: both sides one block off, the first listed won and the bot stepped west onto the
 // open bridge among the mobs instead of east into its own tunnel. A covered standing cell comes first.
 out.sort((a,b)=>!!coveredColumn(bot,b)-!!coveredColumn(bot,a)||a.distanceTo(center)-b.distanceTo(center))
 try{
  for(const target of out.slice(0,3)){
   check()
   await bot.lookAt(target.offset(.5,.5,.5),true)
   bot.setControlState('forward',true);if(target.y>center.y)bot.setControlState('jump',true)
   const end=Date.now()+stepMs
   while(inside()&&Date.now()<end){check();await delay(pollMs)}
   bot.clearControlStates()
   if(!inside())return {item:'safety',count:1,receipt:'out_of_portal',position:here()}
  }
 }finally{bot.clearControlStates()}
 throw new Error(`Still in the portal after ${Math.min(3,out.length)} step${out.length===1?'':'s'} toward open ground`)
}

// Runs 81 and 82, measured by console: through the bridge the server finishes
// a dimension change only once the bot moves up or down. Level walking for 32
// seconds, three portal entries included, never finished it; a jump did within
// half a second each time. Until it finishes, a portal only re-arms its
// cooldown and placements are ignored (lab run 147, 15 October). So the bot hops
// on arrival, before every step into a portal, and when a placement goes unheard.
export async function hop(bot,{check=()=>{}}={},{hopMs=500,pollMs=50}={}){
 const until=async(predicate,ms)=>{const end=Date.now()+ms;while(Date.now()<end){check();if(predicate())return true;await delay(pollMs)}return predicate()}
 if(!bot.entity.onGround)return
 bot.setControlState('jump',true)
 try{await until(()=>!bot.entity.onGround,hopMs)}finally{bot.setControlState('jump',false)}
 await until(()=>bot.entity.onGround,hopMs*2)
}
const PORTAL_REACH=48
const findPortal=(bot,name)=>{const id=bot.registry?.blocksByName?.[name]?.id;if(id===undefined)return null;const b=bot.findBlock?.({matching:id,maxDistance:PORTAL_REACH});return b?.name===name?b:null}
// Which portal use_portal means. From the Overworld the nearest lit portal its
// switch allows, and with none allowed the nearest, so the refusal names it;
// from the End there is only the End's.
export function portalKind(bot,{netherAllowed=false,endAllowed=false}={}){
 const from=dimensionOf(bot)
 if(from==='the_end')return 'end'
 if(from!=='overworld')return 'nether'
 const end=findPortal(bot,'end_portal');if(!end)return 'nether'
 const nether=findPortal(bot,'nether_portal'),here=bot.entity.position
 const found=[{kind:'end',block:end,allowed:endAllowed},...(nether?[{kind:'nether',block:nether,allowed:netherAllowed}]:[])].sort((a,b)=>a.block.position.distanceTo(here)-b.block.position.distanceTo(here))
 return (found.find(f=>f.allowed)??found[0]).kind
}
export function portalRefusal(bot,{netherAllowed=false,endAllowed=false,kind}={}){
 if(dimensionOf(bot)!=='overworld')return null
 return (kind??portalKind(bot,{netherAllowed,endAllowed}))==='end'
  ?endAllowed?null:'Portal travel to the End is off for this world; only the owner can turn it on'
  :netherAllowed?null:'Portal travel to the Nether is off for this world; only the owner can turn it on'
}
// The End (the dragon roadmap, brief 3). An end portal is a
// floor, not a doorway: stepping onto it carries a player across at once, so there
// is no wait in the middle and no stepping out and in again. The arrival platform
// can be buried; the bot digs out through what it may dig anywhere (end stone) and
// never the obsidian it stands on. From the End the one way home is the exit
// fountain's portal at 0,0, which is lit only once the dragon is dead.
async function crossEnd(bot,{check,stage,progress},{reachMs,crossMs,hopMs,loadMs,pollMs}){
 const xyz=p=>({x:p.x,y:p.y,z:p.z}),key=p=>`${p.x},${p.y},${p.z}`
 const until=async(predicate,ms)=>{const end=Date.now()+ms;while(Date.now()<end){check();if(predicate())return true;await delay(pollMs)}return predicate()}
 const from=dimensionOf(bot),named=(p,name)=>bot.blockAt(p)?.name===name
 const block=findPortal(bot,'end_portal')
 if(!block)throw new Error(from==='the_end'?`No lit exit portal within ${PORTAL_REACH} blocks; the fountain at 0,0 lights when the dragon dies`:`No lit end portal within ${PORTAL_REACH} blocks`)
 if(from==='the_end'&&Math.max(Math.abs(block.position.x),Math.abs(block.position.z))>3)throw new Error(`The end portal at ${key(block.position)} is not the exit fountain at 0,0, and from the End that is the only way home`)
 // Every cell of the portal's floor, and the standing cells around it: on the frame
 // rim one above, or on the floor beyond the rim at the portal's level.
 const STEPS=[[1,0],[-1,0],[0,1],[0,-1]],cells=[block.position],seen=new Set([key(block.position)])
 for(let i=0;i<cells.length&&cells.length<25;i++)for(const [dx,dz] of STEPS){const c=cells[i].offset(dx,0,dz);if(!seen.has(key(c))&&named(c,'end_portal')){seen.add(key(c));cells.push(c)}}
 const open=p=>[0,1].every(y=>bot.blockAt(p.offset(0,y,0))?.boundingBox==='empty'&&!named(p.offset(0,y,0),'end_portal')&&!/lava|water/.test(bot.blockAt(p.offset(0,y,0))?.name||''))
 const stands=new Map()
 for(const c of cells)for(const [dx,dz] of STEPS)for(const [reach,dy] of [[1,1],[1,0],[2,0]]){const p=c.offset(dx*reach,dy,dz*reach);if(!stands.has(key(p))&&open(p)&&bot.blockAt(p.offset(0,-1,0))?.boundingBox==='block')stands.set(key(p),{cell:p,into:c})}
 const here=bot.entity.position,order=(a,b)=>(b.cell.y-a.cell.y)||a.cell.distanceTo(here)-b.cell.distanceTo(here)
 const options=[...stands.values()].sort(order)
 if(!options.length)throw new Error(`No standing cell beside the end portal at ${key(block.position)}`)
 const at=()=>{const f=bot.entity.position.floored();return options.find(o=>key(o.cell)===key(f))}
 if(!at()){
  const stand=options[0].cell
  stage('walking');progress(`Walking to the end portal at ${key(block.position)}`)
  const timer=setTimeout(()=>bot.pathfinder.setGoal(null),reachMs)
  try{await bot.pathfinder.goto(new goals.GoalBlock(stand.x,stand.y,stand.z))}catch(error){check();progress(`The walk to the end portal ended early: ${String(error.message).slice(0,60)}`)}
  finally{clearTimeout(timer)}
  check()
  if(!at())throw new Error(`I did not reach a standing cell beside the end portal at ${key(block.position)}; not stepping toward it from ${key(bot.entity.position.floored())}`)
 }
 const portal=at().into
 await hop(bot,{check},{hopMs,pollMs})
 stage('entering');progress('Stepping onto the end portal')
 // From beyond the rim the frame is a step up, taken with a jump.
 await bot.lookAt(portal.offset(.5,0,.5),true);bot.setControlState('forward',true);if(Math.floor(bot.entity.position.y)<=portal.y)bot.setControlState('jump',true)
 let crossed
 try{crossed=await until(()=>dimensionOf(bot)!==from,crossMs)}finally{bot.clearControlStates()}
 if(!crossed){
  if(portalObservation(bot).inPortal===true)await leavePortal(bot,null,{check,stage,progress})
  throw new Error(`The end portal at ${key(portal)} did not carry me across in ${Math.round(crossMs/1000)} seconds`)
 }
 const to=dimensionOf(bot)
 await until(()=>!!bot.blockAt(bot.entity.position.floored().offset(0,-1,0)),loadMs)
 const arrival=bot.entity.position.floored(),dug=[]
 if(to==='the_end')for(const y of [1,0]){
  const c=arrival.offset(0,y,0),b=bot.blockAt(c)
  if(!b||b.boundingBox==='empty')continue
  if(!plainCube(bot)(b))throw new Error(`Buried on the arrival platform in ${b.name} at ${key(c)}, which I never dig`)
  check();stage('digging_out');progress(`Digging out of the ${b.name.replaceAll('_',' ')} over the arrival platform`)
  await bot.tool?.equipForBlock?.(b,{requireHarvest:false});await bot.dig(b);dug.push({block:b.name,...xyz(c)});check()
 }
 stage('arrival_hop');await hop(bot,{check},{hopMs,pollMs})
 await wearBestArmor(bot,{check,progress})
 // The End's arrival is a platform, not a portal; it is the far end of the link all the same.
 return {item:'portal',count:1,receipt:'crossed',from:{dimension:from,portal:xyz(portal)},to:{dimension:to,portal:to==='the_end'?xyz(arrival):null,position:xyz(arrival)},...(dug.length?{dug}:{})}
}
// The one deliberate way through a portal (the Nether plan,
// step 5). From the Overworld only where the world's switch allows the Nether;
// from the Nether always, so turning the switch off never strands the bot.
// Every walk avoids portal blocks, so the last step in is by direct control;
// then it stands still until the dimension changes, and steps out of the
// arrival portal with the same guard that steps it out of any other.
export async function usePortal(bot,task,{check,stage,progress,netherAllowed=false,endAllowed=false},{reachMs=20000,enterMs=3000,crossMs=7000,attempts=3,pauseMs=1500,hopMs=500,loadMs=10000,pollMs=50,retraceMs=8000}={}){
 const xyz=p=>({x:p.x,y:p.y,z:p.z}),key=p=>`${p.x},${p.y},${p.z}`
 const until=async(predicate,ms)=>{const end=Date.now()+ms;while(Date.now()<end){check();if(predicate())return true;await delay(pollMs)}return predicate()}
 const inside=()=>portalObservation(bot).inPortal===true
 check()
 const from=dimensionOf(bot)
 const kind=portalKind(bot,{netherAllowed,endAllowed}),refused=portalRefusal(bot,{netherAllowed,endAllowed,kind});if(refused)throw new Error(refused)
 if(kind==='end')return crossEnd(bot,{check,stage,progress},{reachMs,crossMs,hopMs,loadMs,pollMs})
 if(!['overworld','the_nether'].includes(from))throw new Error(`No portal travel from ${from||'an unknown dimension'}`)
 const block=bot.findBlock({matching:bot.registry.blocksByName.nether_portal.id,maxDistance:48})
 if(!block)throw new Error('No lit nether portal within 48 blocks')
 // The bottom portal cell, and the standing cells beside it at that level.
 let portal=block.position.clone?.()??block.position
 while(bot.blockAt(portal.offset(0,-1,0))?.name==='nether_portal')portal=portal.offset(0,-1,0)
 // Every column of the portal's bottom row (lab run 136: a two-wide portal, one column
 // walled in, the other with open floor in front; only the first was ever considered).
 const STEPS=[[1,0],[-1,0],[0,1],[0,-1]],bottoms=[portal]
 for(const [dx,dz] of STEPS){let c=portal.offset(dx,0,dz);while(bot.blockAt(c)?.name==='nether_portal'&&bottoms.length<23){bottoms.push(c);c=c.offset(dx,0,dz)}}
 const enter=async()=>{
  // Run 69: a walk that timed out short of the portal, then a blind step from
  // there, put the bot in a water hole and it drowned. The blind step is taken
  // only from a standing cell beside the portal.
  const here=bot.entity.position
  // Level with the bottom cell, or one lower for a frame built on the ground, jumped in from.
  // Each standing cell remembers the column it faces, which is the one stepped into.
  const faces=new Map()
  for(const b of bottoms)for(const dy of [0,-1])for(const [dx,dz] of STEPS){const c=b.offset(dx,dy,dz);if(!faces.has(key(c))&&bot.blockAt(c)?.name!=='nether_portal')faces.set(key(c),{cell:c,into:b})}
  const sides=[...faces.values()].map(f=>f.cell)
  const order=(a,b)=>(b.y-a.y)||a.distanceTo(here)-b.distanceTo(here)
  let stands=sides.filter(p=>standable(bot,p)).sort(order)
  // Lab run 100: every cell beside the portal held the bot's own portal-room
  // cobblestone, and it fled into the fortress instead. What it placed it may
  // take back; anything else still walls the portal off.
  if(!stands.length){
   const own=p=>{const b=bot.blockAt(p);return !!b&&b.boundingBox==='block'&&!!bot.ownBlocks?.has?.(p,b.name,dimensionOf(bot))}
   const open=p=>{const b=bot.blockAt(p);return !!b&&b.boundingBox==='empty'&&b.name!=='nether_portal'&&!/lava|water/.test(b.name)}
   const floor=p=>bot.blockAt(p.offset(0,-1,0))?.boundingBox==='block'
   const reclaim=sides.filter(p=>floor(p)&&[0,1].every(y=>open(p.offset(0,y,0))||own(p.offset(0,y,0)))).sort(order)
   if(!reclaim.length)throw new Error(`No standing cell beside the portal at ${key(portal)}; it is walled or flooded`)
   const cell=reclaim[0]
   stage('opening');progress(`Opening my own wall beside the portal at ${key(cell)}`)
   if(bot.entity.position.distanceTo(cell.offset(.5,.5,.5))>3.5){
    const timer=setTimeout(()=>bot.pathfinder.setGoal(null),reachMs)
    try{await bot.pathfinder.goto(new goals.GoalNear(cell.x,cell.y,cell.z,2))}catch{check()}finally{clearTimeout(timer)}
   }
   for(const y of [1,0]){const c=cell.offset(0,y,0);if(!own(c))continue;check();const b=bot.blockAt(c);await bot.tool?.equipForBlock?.(b,{requireHarvest:false});await bot.dig(b);check()}
   if(!standable(bot,cell))throw new Error(`Could not open my own wall beside the portal at ${key(cell)}`)
   stands=[cell]
  }
  const beside=()=>stands.some(p=>{const f=bot.entity.position;return Math.floor(f.x)===p.x&&Math.floor(f.y)===p.y&&Math.floor(f.z)===p.z})
  // Walled in for safety (run 73), open the wall facing the portal first: the
  // walk never digs blocks the bot placed itself.
  // A side is a way out when its feet and head cells are both open (run 74: a
  // half-opened wall left none, and the pathfinder's empty path read as done).
  // The direct walk failed: go back the way it came, crumb by crumb (trail.js), then
  // try the last few blocks again. Three missed hops in a row end it. The way back ends
  // beside this portal, the short way along the trail (rehearsal, 16 October 23:12Z: a
  // trip that doubled back was replayed in reverse, out to the blaze spawner); a trail
  // that does not lead here, or crosses ground that is gone, is refused with the reason.
  const retrace=async()=>{
   if(bot.trail?.dimension!==from)return
   let crumbs
   try{crumbs=wayBack(bot.trail,bot.entity.position.floored(),{to:stands,reach:3,usable:c=>standingGround(bot,c)})}
   catch(error){throw new Error(`I did not reach a standing cell beside the portal at ${key(portal)}, and I will not retrace my steps: ${error.message}`)}
   if(!crumbs.length)return
   const last=crumbs.find(c=>stands.some(s=>c.distanceTo(s)<=3))??crumbs.at(-1)
   const stand=stands.reduce((a,b)=>b.distanceTo(last)<a.distanceTo(last)?b:a)
   stage('retracing');progress(`Retracing my steps to the portal (${crumbs.length} steps back)`)
   let misses=0
   for(const c of crumbs){
    if(c===last)break
    const timer=setTimeout(()=>bot.pathfinder.setGoal(null),retraceMs)
    try{await bot.pathfinder.goto(new goals.GoalNear(c.x,c.y,c.z,1));misses=0}catch{check();if(++misses>=3)break}
    finally{clearTimeout(timer)}
    check()
   }
   const timer=setTimeout(()=>bot.pathfinder.setGoal(null),reachMs)
   try{await bot.pathfinder.goto(new goals.GoalBlock(stand.x,stand.y,stand.z))}catch(error){check();progress(`The last steps to the portal failed: ${String(error.message).slice(0,60)}`)}
   finally{clearTimeout(timer)}
   check()
  }
  const passable=b=>!b||b.boundingBox==='empty'
  const feet=bot.entity.position.floored(),walled=[[1,0],[-1,0],[0,1],[0,-1]].every(([dx,dz])=>[0,1].some(y=>!passable(bot.blockAt(feet.offset(dx,y,dz)))))
  if(!beside()&&walled){progress('Opening the wall toward the portal');await unwall(bot,{kind:'unhut',goal:{toward:{x:portal.x,z:portal.z}}},{check,stage,progress})}
  if(!beside()){
   stage('walking');progress(`Walking to the portal at ${key(portal)}`)
   const timer=setTimeout(()=>bot.pathfinder.setGoal(null),reachMs)
   try{await bot.pathfinder.goto(new goals.GoalBlock(stands[0].x,stands[0].y,stands[0].z))}catch(error){check();progress(`The walk to the portal ended early: ${String(error.message).slice(0,60)}`)}
   finally{clearTimeout(timer)}
   check()
   if(!beside())await retrace()
   if(!beside())throw new Error(`I did not reach a standing cell beside the portal at ${key(portal)}; not stepping toward it from ${key(bot.entity.position.floored())}`)
  }
  {const f=bot.entity.position.floored(),at=stands.find(p=>p.x===f.x&&p.y===f.y&&p.z===f.z);if(at)portal=faces.get(key(at))?.into??portal}
  await hop(bot,{check},{hopMs,pollMs})
  stage('entering');progress('Stepping into the portal')
  const below=Math.floor(bot.entity.position.y)<portal.y
  await bot.lookAt(portal.offset(.5,0,.5),true);bot.setControlState('forward',true);if(below)bot.setControlState('jump',true)
  try{if(!await until(inside,enterMs))throw new Error(`Could not step into the portal at ${key(portal)}`)}
  finally{bot.clearControlStates()}
 }
 // The portal's working shape is a thin plane in the middle of its cell; the
 // feet reaching the cell can leave the body short of it (run 73), and only
 // time in the middle counts toward crossing. The bot walks to the middle and
 // back to it whenever it is off it, for the whole wait (run 80).
 let reached=false
 const wait=async()=>{
  const middle=bot.entity.position.floored().offset(.5,0,.5)
  const centred=()=>{const p=bot.entity.position;return Math.abs(p.x-middle.x)<0.2&&Math.abs(p.z-middle.z)<0.2}
  const hold=()=>{
   if(dimensionOf(bot)!==from)return true
   if(centred()){reached=true;bot.setControlState('forward',false)}
   else{bot.lookAt(middle.offset(0,.5,0),true)?.catch?.(()=>{});bot.setControlState('forward',true)}
   return false
  }
  progress('In the portal; waiting to cross')
  try{return await until(hold,crossMs)}finally{bot.clearControlStates()}
 }
 // Run 81, measured by console: after a crossing the server finishes the
 // dimension change late, at a moment the bot cannot see (once it moves), and
 // until ten ticks after that, standing in a portal only re-arms the cooldown.
 // A portal that has not taken the bot in its usual four seconds is stepped out
 // of, and entered again after a pause, as a player would.
 for(let attempt=1;;attempt++){
  if(!inside())await enter()
  if(await wait())break
  const p=bot.entity.position,at=[p.x,p.y,p.z].map(v=>v.toFixed(2)).join(',')
  await leavePortal(bot,task,{check,stage,progress})
  if(attempt>=attempts)throw new Error(reached
   ?`The portal at ${key(portal)} did not carry me across in ${attempts} tries of ${Math.round(crossMs/1000)} seconds (last at ${at}); I stepped back out`
   :`I never reached the middle of the portal at ${key(portal)} in ${attempts} tries (last at ${at}), so it could not carry me; I stepped back out`)
  progress('The portal has not taken me yet; stepping out and in again')
  await until(()=>false,pauseMs)
 }
 const to=dimensionOf(bot)
 // The far side's ground arrives after the dimension does.
 await until(()=>!!bot.blockAt(bot.entity.position.floored().offset(0,-1,0)),loadMs)
 const arrival=bot.findBlock({matching:bot.registry.blocksByName.nether_portal.id,maxDistance:4})?.position
 const out=await leavePortal(bot,task,{check,stage,progress})
 // Its own stage, so the alarm lets the crossing finish through it (lab run 147).
 stage('arrival_hop');await hop(bot,{check},{hopMs,pollMs})
 // Gold boots on arrival in the Nether, iron back on in the Overworld, before anything nearby decides.
 await wearBestArmor(bot,{check,progress})
 return {item:'portal',count:1,receipt:'crossed',from:{dimension:from,portal:xyz(portal)},to:{dimension:to,portal:arrival?xyz(arrival):null,position:out.position}}
}
