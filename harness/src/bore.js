// Bore: a covered one-wide, two-high tunnel toward a target, the route to a blaze
// spawner when hostiles hold the open ground at the arrival portal. Nether trip
// lessons, 13 to 14 October: ten deaths, never at the stand, always on the walk.
// dig's straight line rounds each axis, so consecutive columns meet at a corner and
// the step between them cuts a third; it never closes the air pockets it uncovers,
// and it walks into open space at its own level. bore takes Manhattan columns,
// plugs every face a column uncovers before stepping in, stops one column short of
// open space and keeps that column as the wall, with a three-cell slit at head
// height (lab run 166, 16 October: the bay at -42,59,-8 had exactly that shape and
// held twenty minutes). Lava and the family rule stop it with a named reason;
// nothing is left half done, so the next bore from where it stands carries on.
import {Vec3} from 'vec3'
import {refuseDigCell,digOne,walkNear,inventoryCounts,inventoryDelta,validateProtectedSites,inProtectedSite,LIQUID,AIR,key} from './primitives.js'
import {fullCube} from './construction.js'
import {hutMaterials} from './hut.js'
import {fillCell} from './scaffold.js'
import {mayDig} from './natural.js'
import {portReady} from './nether-trip.js'
import {FIRE_BLOCKS} from './survival.js'
import {centreOn} from './navigation.js'
import {inNether} from './dimension.js'
export const BORE_MAX=64,BORE_PLUGS=8,BORE_TIMEOUT_MS=600000
// Live canary on the test world, 16 October (4e95192): boring from a closed portal room toward a
// target 27 blocks off, open space behind the room's wall drew a slit from the safe room into the
// open hub. A slit opens only within this many blocks of the target (the spawner room is its
// neighbourhood); open space farther off stops the bore with the wall left whole.
export const SLIT_REACH=6
const AROUND=[[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0],[0,-1,0]].map(([x,y,z])=>new Vec3(x,y,z))
const xyz=p=>({x:p.x,y:p.y,z:p.z})
// Magma is a full cube and natural ground, and it burns whoever stands on it (review of 9d2770d).
const hot=b=>!b||LIQUID.has(b.name)||FIRE_BLOCKS.has(b.name)||b.name==='magma_block'
export function validateBoreGoal(goal){
 if(!goal||!['x','y','z'].every(k=>Number.isSafeInteger(goal[k])))throw new Error('Bore needs a target with integer x, y and z')
 if(!Number.isInteger(goal.count)||goal.count<1||goal.count>BORE_MAX)throw new Error(`Bore count must be 1–${BORE_MAX} columns`)
 validateProtectedSites(goal.protectedSites)
 return {x:goal.x,y:goal.y,z:goal.z,count:goal.count,...(goal.protectedSites?.length?{protectedSites:goal.protectedSites}:{})}
}
export function validateBoreStep(s){
 if(s.name!==''||(s.item??'')!==''||(s.design!==undefined&&(!Array.isArray(s.design)||s.design.length)))throw new Error('Bore requires empty name, item and design')
 if(!s.target||Object.keys(s.target).length!==3)throw new Error('Bore needs a target with integer x, y and z')
 validateBoreGoal({...s.target,count:s.count})
}
// The longer horizontal axis in full, then the other: one corner, never a diagonal pair.
// A height change is spread one step per floor(H/|dy|) columns, never two in one column.
export function borePath(from,to){
 const dx=to.x-from.x,dz=to.z-from.z,dy=to.y-from.y,every=Math.max(1,Math.floor((Math.abs(dx)+Math.abs(dz))/Math.max(1,Math.abs(dy)))),path=[]
 let at=new Vec3(from.x,from.y,from.z)
 for(const [axis,d] of Math.abs(dx)>=Math.abs(dz)?[['x',dx],['z',dz]]:[['z',dz],['x',dx]])for(let n=0;n<Math.abs(d);n++){
  at=at.clone();at[axis]+=Math.sign(d)
  if((path.length+1)%every===0&&Math.abs(at.y-from.y)<Math.abs(dy))at.y+=Math.sign(dy)
  path.push(at)
 }
 return path
}
// The cells a column opens, top first. A step down opens the lower column's third cell, the
// one the body passes through as it drops; a step up the one over the head it jumps from:
// mineflayer-pathfinder's drop-down and jump-up moves need both, and a player does too.
export const columnCells=(prev,c)=>[...(c.y<prev.y?[c.offset(0,2,0)]:c.y>prev.y?[prev.offset(0,2,0)]:[]),c.offset(0,1,0),c]
// budgetMs: the bore stops at the top of a column once it has run this long, so a receipt comes
// back before the runner's hard deadline ends it with none (review of 9d2770d).
export async function boreToward(bot,task,{check,stage,progress,movements,budgetMs=BORE_TIMEOUT_MS}){
 const goal=validateBoreGoal(task.goal),sites=goal.protectedSites||[],solid=b=>!!b&&fullCube(bot.registry,b.name)
 const here=()=>{const p=bot.entity.position;return new Vec3(Math.floor(p.x),Math.floor(p.y+.2),Math.floor(p.z))}
 check()
 if(!inNether(bot))throw new Error('bore is for the Nether: a covered route through netherrack. In the Overworld use dig or goto with dig')
 if(!bot.inventory.items().some(i=>/_pickaxe$/.test(i.name)))throw new Error('Boring needs a pickaxe')
 const carried=hutMaterials(bot).reduce((n,i)=>n+i.count,0)
 if(carried<BORE_PLUGS)throw new Error(`Boring needs ${BORE_PLUGS} blocks to close what it uncovers; carrying ${carried}`)
 const before=inventoryCounts(bot),from=here(),path=borePath(from,goal),started=Date.now()
 if(!path.length)throw new Error(`Bore runs sideways and ${key(goal)} is straight above or below; dig a shaft with dig`)
 const open=new Set([from,from.offset(0,1,0)].map(key)),plugged=[]
 let columns=0,covered=0,frontLeft=[],reason=null,stoppedAt=null,slit=null,beyond=null,wall=null
 const stop=(why,at,b)=>{reason=why;stoppedAt=xyz(at);if(b?.boundingBox==='block'&&!mayDig(bot,b))wall=`${b.name} at ${key(b.position)}`}
 // Close each of these cells that is not a full cube and not the tunnel itself, standing
 // centred first (a player is 0.6 wide). Returns why the first one it could not close stays open.
 // Lowest first, so each plug has a face to go against: the floor, then the plug beside it in the
 // column behind, or the one below it. In the open (cover) cobblestone goes first: a ghast's fireball
 // breaks netherrack and dirt, not cobblestone (rehearsal map, 16 October).
 const seal=async(cells,{cover=false}={})=>{
  let centred=false
  const place=async n=>{
   if(inProtectedSite(n,sites))return `${key(n)} is inside a saved project footprint; bore does not build there`
   if(!centred){centred=true;await centreOn(bot,here(),check)}
   const all=hutMaterials(bot),item=cover&&all.find(i=>i.name==='cobblestone')||all[0]
   if(!item)return `out of blocks to cover ${key(n)}`
   if(!await fillCell(bot,n,{check,progress,item}))return `could not close ${key(n)}`
   plugged.push(xyz(n));progress(`Plugged ${key(n)}`);return null
  }
  for(const n of [...cells].sort((a,b)=>a.y-b.y)){
   if(open.has(key(n))||solid(bot.blockAt(n)))continue
   // Nothing beside it to place against (the first roof out over open ground): a helper on a
   // block already standing goes in first, as the hut's roof hangs off its helper.
   if(!AROUND.some(d=>solid(bot.blockAt(n.plus(d))))){
    const helper=AROUND.slice(0,4).map(d=>n.plus(d)).find(q=>!open.has(key(q))&&!solid(bot.blockAt(q))&&solid(bot.blockAt(q.offset(0,-1,0))))
    if(helper){const why=await place(helper);if(why)return why}
   }
   const why=await place(n);if(why)return why
  }
  return null
 }
 // The burrow's lid: at the foot of a shaft the cell two above the feet is open. The start column
 // itself stays open behind the bot by design: it is the tunnel's mouth and the way home.
 // Only at the foot of a shaft: on open ground there is nothing to hang a lid from.
 if(AROUND.slice(0,4).every(d=>solid(bot.blockAt(from.offset(0,1,0).plus(d))))){
  stage('walling');const lid=await seal([from.offset(0,2,0)])
  if(lid)throw new Error(`Boring stopped over the start: ${lid}`)
 }
 // Open space: a cell that is not a full cube, unless it is air closed in by rock and the tunnel.
 // That is a pocket inside the column, or a column an alarm left dug and closed: a bore issued
 // again from the column behind it carries on through it.
 const exposed=(p,own)=>{const b=bot.blockAt(p);return !b||!solid(b)&&(!AIR.has(b.name)||AROUND.some(d=>{const q=p.plus(d);return !open.has(key(q))&&!own.some(o=>o.equals(q))&&!solid(bot.blockAt(q))}))}
 const far=p=>Math.abs(goal.x-p.x)+Math.abs(goal.z-p.z)>SLIT_REACH
 // A floor bore can stand on or lay: solid and not burning, or air to place one in.
 const floored=p=>{const b=bot.blockAt(p.offset(0,-1,0));return !!b&&(AIR.has(b.name)||solid(b))&&!hot(b)}
 // Family rehearsal, 16 October: the arrival portal stands on a fortress bridge of nether bricks over
 // a lava sea, and the bridge ends in a void well short of solid land. Bricks are never dug. Open air
 // far from the target, level or going down, is crossed under cover instead: the floor laid where
 // there is none, then walls and roof, all from carried blocks before the step. Walking on bricks
 // breaks nothing; lava far below the floor is no matter.
 const airy=cells=>cells.every(q=>AIR.has(bot.blockAt(q)?.name))
 const limit=Math.min(goal.count,path.length)
 const named=p=>{const b=bot.blockAt(p);return !b?`unloaded ground at ${key(p)}`:AIR.has(b.name)?`open space at ${key(p)}`:`${b.name} at ${key(p)}`}
 for(let i=0;i<limit;i++){
  check()
  if(Date.now()-started>=budgetMs){reason=`timed out after ${columns} columns`;stoppedAt=xyz(path[i]);break}
  const c=path[i],prev=i?path[i-1]:from,next=path[i+1],cells=columnCells(prev,c)
  // The next column's own cells stay open as the way on; the last column closes its front too.
  const front=next&&i+1<limit?columnCells(c,next).filter(q=>q.x!==c.x||q.z!==c.z):[]
  const skin=()=>cells.flatMap(p=>AROUND.map(d=>p.plus(d))).filter(q=>!cells.some(p=>p.equals(q))&&!front.some(p=>p.equals(q)))
  stage('digging');progress(`Boring column ${i+1}/${goal.count} at ${key(c)}`)
  const cover=c.y<=prev.y&&airy(cells)&&far(c)&&floored(c)
  if(!cover&&airy(cells)&&far(c)&&hot(bot.blockAt(c.offset(0,-1,0)))){stop(`${named(c.offset(0,-1,0)).replace(' at ',' under '+key(c)+' at ')}; bore again toward a point three blocks to the side`,c);break}
  if(cover){
   const mob=Object.values(bot.entities||{}).find(e=>e!==bot.entity&&e?.position&&[...cells,...skin()].some(q=>q.equals(e.position.floored())))
   if(mob){stop(`${mob.name||mob.type||'an entity'} in ${key(mob.position.floored())}; the covered walk waits for it`,c);break}
   const burn=skin().find(q=>hot(bot.blockAt(q)))
   if(burn){stop(`${named(burn)} beside ${key(c)}; bore again toward a point three blocks to the side`,c);break}
  }else{
   const gap=cells.find(p=>exposed(p,cells))
   if(gap){stop(`${named(gap)}; the tunnel stops before it`,c);break}
  }
  // Two ahead: open space there makes this column the last wall.
  const ahead=next&&[next,next.offset(0,1,0)].find((p,_,own)=>exposed(p,own))
  if(ahead){
   const b=bot.blockAt(ahead);beyond=b?{...xyz(ahead),name:b.name}:null
   if(hot(b)){stop(`${named(ahead)} beyond ${key(c)}; bore again toward a point three blocks to the side`,c);break}
   const short=Math.abs(goal.x-c.x)+Math.abs(goal.z-c.z),walk=columnCells(c,next).filter(q=>q.x!==c.x||q.z!==c.z)
   // Far from the target, open air over a floor ahead is the next covered column, not a stop.
   if(short>SLIT_REACH&&airy(walk)&&floored(next)&&next.y<=c.y)beyond=null
   else if(short>SLIT_REACH){stop(`${named(ahead)}${airy(walk)?` over ${bot.blockAt(next.offset(0,-1,0))?.name??'unloaded ground'}`:''}, ${short} blocks short of the target; bore around it${columns?'':'. This wall is the first one: step to another wall or re-aim the bore'}`,c);break}
   else{stop(`${named(ahead)} beyond the wall at ${key(c)}`,c);await openSlit(c);break}
  }
  if(cover){
   stage('walling');const why=await seal(skin(),{cover:true})
   if(why){stop(`${why}; the covered walk stops before ${key(c)}`,c);break}
   try{await walkNear(bot,c,{dig:false,protectedSites:sites,check,stage,progress,movements,exact:true,timeoutMs:20000})}
   catch(error){check();stop(`did not step into ${key(c)}: ${error.message}`,c);break}
   for(const p of cells)open.add(key(p))
   columns++;covered++;frontLeft=front.length?[next.offset(0,-1,0),...front]:[];continue
  }
  // The family rule, lava beside, over or under, falling blocks overhead: refuseDigCell as dig judges them.
  let refused=null
  for(const p of cells){const why=refuseDigCell(bot,p,{protectedSites:sites,role:'head'});if(why){refused=[why,p];break}}
  const f=c.offset(0,-1,0),floor=bot.blockAt(f)
  if(!refused&&hot(floor))refused=[`${key(c)} has ${floor?.name??'unloaded ground'} under it at ${key(f)}; bore again toward a point three blocks to the side`,f]
  if(refused){stop(refused[0],c,bot.blockAt(refused[1]));break}
  // The skin is closed against the column's own rock before it is dug, so no opening is ever
  // uncovered, and read again after the dig.
  stage('walling');const early=await seal(skin())
  if(early){stop(`${early}; the tunnel stops before ${key(c)}`,c);break}
  stage('digging')
  for(const p of cells){
   const b=bot.blockAt(p)
   if(!AIR.has(b.name)){
    if(typeof bot.canDigBlock==='function'&&!bot.canDigBlock(b)){stop(`Cannot reach ${b.name} at ${key(p)} to dig it`,c);break}
    try{await digOne(bot,b,check)}catch(error){if(error?.code!=='DIG_REFUSED')throw error;stop(error.message,c);break}
   }
   open.add(key(p))
  }
  stage('walling');const leak=await seal(skin())
  if(leak&&!reason)stop(`${leak}; the tunnel stops before ${key(c)}`,c)
  if(reason)break
  try{await walkNear(bot,c,{dig:false,protectedSites:sites,check,stage,progress,movements,exact:true,timeoutMs:20000})}
  catch(error){check();stop(`did not step into ${key(c)}: ${error.message}`,c);break}
  columns++;frontLeft=front.length?[next.offset(0,-1,0),...front]:[]
 }
 // Stopped facing an open column it meant to walk on: close it off before handing back.
 if(reason&&!slit&&frontLeft.length){const why=await seal(frontLeft,{cover:true});if(why)reason+=`; ${why} ahead`}
 // Three cells at head height in the wall column, centre first; its feet cell stays, so nothing
 // walks in or out. Gated as the hut's port is (portReady), and skipping what the port skips.
 async function openSlit(w){
  const feet=here(),ready=portReady(bot),s0=new Vec3(w.x,feet.y+1,w.z),lateral=new Vec3(Math.abs(w.z-feet.z),0,Math.abs(w.x-feet.x))
  // A wall a step above the bot has its feet cell at the bot's head height, and the hut re-closes
  // only that height: a slit there would be a doorway. Level first, then the slit.
  if(w.y!==feet.y){reason=`wall one step ${w.y>feet.y?'up':'down'} at ${key(w)}; bore level first, toward a target at y ${feet.y}`;return}
  if(!ready.ready){reason=`${ready.reason}: the slit at ${key(s0)} waits; rest, then bore again from here`;return}
  const inside=[feet,feet.offset(0,1,0)].map(key)
  const fit=p=>{const b=bot.blockAt(p);return !!b&&(AIR.has(b.name)||mayDig(bot,b))&&![p,...AROUND.map(d=>p.plus(d))].some(q=>!inside.includes(key(q))&&hot(bot.blockAt(q)))}
  if(!fit(s0)){const b=bot.blockAt(s0);reason=`no slit at ${key(s0)}: ${b&&!AIR.has(b.name)&&!mayDig(bot,b)?`${b.name} is not natural ground`:'lava, fire or unloaded ground touches it'}`;if(b&&!AIR.has(b.name)&&!mayDig(bot,b))wall=`${b.name} at ${key(s0)}`;return}
  stage('digging');slit=[]
  for(const p of [s0,s0.minus(lateral),s0.plus(lateral)]){
   check();if(!fit(p)){progress(`Slit cell ${key(p)} stays shut`);continue}
   try{await digOne(bot,bot.blockAt(p),check);slit.push(xyz(p))}
   catch(error){if(error?.code!=='DIG_REFUSED')throw error;progress(`Slit cell ${key(p)} stays shut: ${error.message}`)}
   if(!slit.length){reason=`no slit at ${key(s0)}: the centre would not open`;slit=null;return}
  }
 }
 // Plugs alone are no progress: as dig's failOrStop, nothing opened is a failure that says why.
 if(!columns&&!slit)throw new Error(`${reason||`Bore opened nothing toward ${key(goal)}`}${plugged.length?` (plugged ${plugged.map(key).join('; ')} first)`:''}`)
 return {receipt:'bored',columns,covered,requested:goal.count,from:xyz(from),to:xyz(here()),stoppedAt,reason,plugged,slit,beyond,wall,drops:inventoryDelta(before,inventoryCounts(bot))}
}
