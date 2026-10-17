// The blaze stand (dragon roadmap: blaze rods), the design of the blaze endgame after the R8 trip of 17 October (02:10Z to
// 03:37Z). Walled in over the spawner platform, the bot's port had no line to the blazes resting below its window, the
// melee standoff kept it shut while hovering ones were in line, and every blaze it might have killed fell three blocks
// to the platform, outside pickup reach. The stand is the enderman stand's loop (enderman-stand.js) with a bow and a
// sword: wall in, prepare one port, open it toward a blaze in its line and hold it open; an arrow for a blaze in line
// beyond reach, the sword for one with its head in the port; close on a hit, under 16, with a melee mob at the port or
// nothing in line; and never leave the cell. Only a blaze killed in the port column drops its rod on the sill, inside
// pickup reach. The rods a receipt reports are the inventory's own delta: a kill with no rod is reported, never counted.
// Unverified vanilla blaze behaviour this leans on (to check on pi2 before the family world): a targeting blaze floats
// its eye to the bot's, one that loses sight flies to where it last saw the bot, and one blocked at the bot's feet level
// by the ledge rises to the sill and from there pursues into the port.
import {setTimeout as delay} from 'node:timers/promises'
import {Vec3} from 'vec3'
import {inNether} from './dimension.js'
import {tripKit,TRIP_HEALTH,TRIP_ARROWS,PORT_HEALTH,portReady} from './nether-trip.js'
import {hutSite,hutSiteAt,hutMaterials,wallIn,unwall,firingPort,coveredColumn} from './hut.js'
import {weaponFor,portStrike} from './combat.js'
import {SHOOTERS_ONLY,hostileNow,survivalObservation,fireObservation,eatFood} from './survival.js'
import {shelterHolds} from './shelter-occupants.js'
import {shotLine} from './visibility.js'
import {portSightline} from './burrow.js'
import {looseArrow,SHOOT} from './archery.js'
import {killDrops,KILL_DROPS} from './primitives-world.js'
import {inventoryCounts,inventoryDelta,refuseDigCell,digOne,AIR} from './primitives.js'
import {ownedNow,claimPlaced} from './natural.js'
import {holdToPlace} from './placement.js'
import {fullCube} from './construction.js'
import {validateStandGoal,standingIn,closePort} from './enderman-stand.js'
import {DoorAwareMovements} from './navigation.js'
import pathfinding from 'mineflayer-pathfinder'
const {goals}=pathfinding

// radius: blazes looked for, the bow's. limitMs: the whole stand, and timeoutMs the step's limit (the runner's idle window,
// which each stage and progress slides forward, as for the enderman stand). arrows: the trip's floor; under it the stand
// ends. emptyMs: no blaze loaded within the radius this long ends it (idle blazes sink into the corridors under the kerbs,
// and the planner then chooses the corridor mouth or home). idleMs: the port shuts after this long with nothing in its
// line. drawInMs, drawIn: blazes in line but none within drawIn blocks this long, the port blinks shut for blinkMs and opens
// again, since a blaze that loses sight of the bot flies to where it last saw it. healMs: shut, waiting for the port's 16.
// meleeNear: a melee mob this close to the port cell shuts it. digReach: the bot's own blocks in the port's line dug from
// inside. settleMs: a rod's fall. spawnReach, spawnRise: a spawner's volume, 4 across and 1 up or down (vanilla).
// closeWaitMs: one round of waiting on a mob in the port's cell (closePort). closeLimitMs: the close gives up after this long
// at or over the trip's health; under it the close keeps going. finalCloseMs: the closing of a stand that ends, by its own
// clock, since after a cancellation the runner's check throws (review of the stand). burnMs: a fall this long after the bot
// was last seen alight is still the burn's, as the shelter wait and the covered guard judge it (continuity.js BURN_MS: the
// last tick can land after the flag clears). cavityCells: the closed cavity the heal verifies, up to a covered route's
// (continuity.js COVERED_CELLS), since the stand may be walled in at a covered tunnel's end. retreatDrop: health lost since a
// failing close began that steps the bot back out of the port's cell (close), and stepMs bounds that step.
export const BLAZE_STAND={item:'blaze_rod',radius:SHOOT.radius,limitMs:600000,timeoutMs:600000,arrows:TRIP_ARROWS,emptyMs:120000,idleMs:20000,drawInMs:15000,drawIn:4,blinkMs:1500,healMs:60000,
 meleeNear:3,digReach:4.5,settleMs:1500,drawMs:SHOOT.drawMs,spawnReach:4,spawnRise:1,closeWaitMs:10000,closeLimitMs:60000,finalCloseMs:15000,burnMs:6000,cavityCells:256,retreatDrop:4,stepMs:4000,poll:50}
const key=p=>`${p.x},${p.y},${p.z}`
const round=p=>({x:Math.round(p.x*10)/10,y:Math.round(p.y*10)/10,z:Math.round(p.z*10)/10})
const plural=(n,one,many)=>`${n} ${n===1?one:many}`
const span=ms=>ms>=60000?plural(Math.round(ms/60000),'minute','minutes'):plural(Math.round(ms/1000),'second','seconds')
const a=name=>{const n=name.replaceAll('_',' ');return `${/^[aeiou]/.test(n)?'an':'a'} ${n}`}
const column=p=>({x:Math.floor(p.x),z:Math.floor(p.z)})
const middle=e=>e.position.offset(0,Math.min(1.2,(e.height??1.8)/2),0)
const blazes=(bot,radius)=>Object.values(bot.entities||{}).filter(e=>e?.name==='blaze'&&e.position&&e.position.distanceTo(bot.entity.position)<=radius)
 .sort((x,y)=>x.position.distanceTo(bot.entity.position)-y.position.distanceTo(bot.entity.position))
const arrowsCarried=bot=>bot.inventory.items().filter(i=>i.name==='arrow').reduce((n,i)=>n+i.count,0)

// A spawner places a mob within 4 blocks of itself across and one up or down, in any light for a blaze, wherever the
// mob's box fits, and a pocket the bot stands in is such a box: the spawner whose volume holds these feet, or null.
export function spawnerOver(bot,feet,o=BLAZE_STAND){
 for(let dy=-o.spawnRise;dy<=o.spawnRise;dy++)for(let dx=-o.spawnReach;dx<=o.spawnReach;dx++)for(let dz=-o.spawnReach;dz<=o.spawnReach;dz++){
  const c=feet.offset(dx,dy,dz);if(bot.blockAt(c)?.name==='spawner')return c
 }
 return null
}
// Why the stand cannot start here, or ''. A stand step is the request, so the trip is the Nether with the kit and the
// trip's health (nether-trip.js); the cell comes on top: outside every spawner's volume, a wall that would open toward a
// loaded blaze (hut.js firingPort: never beside lava, water or fire, nor through a block the bot did not place), and a hut.
export function blazeStandRefusal(bot,o=BLAZE_STAND){
 if(!inNether(bot))return 'The stand for blaze rods is Nether only: blazes live in fortresses'
 const kit=tripKit(bot)
 if(!kit.ready)return `Not on a kitted trip: ${kit.missing.join(', ')} missing`
 if(!(bot.health>=TRIP_HEALTH))return `Not on a kitted trip: health ${Math.round(bot.health)} is under ${TRIP_HEALTH}`
 const feet=bot.entity.position.floored(),spawner=spawnerOver(bot,feet,o)
 if(spawner)return `${key(feet)} is inside the spawner's reach at ${key(spawner)} (${o.spawnReach} blocks across, ${o.spawnRise} up or down): a blaze could be made in the hut. Stand two above the blazes' floor, or more than ${o.spawnReach} blocks from the spawner`
 const near=blazes(bot,o.radius)
 if(!near.length)return `No blaze within ${o.radius} blocks`
 const ports=near.map(b=>firingPort(bot,feet,{toward:column(b.position),shooter:'blaze'})).filter(Boolean)
 if(!ports.length)return 'No wall here opens toward a blaze: each faces away, or has lava, water or fire beside it, or a block I did not place'
 // Review of the stand: the port cell is a pocket a blaze's box can fit too.
 if(ports.every(p=>spawnerOver(bot,p.cells[0],o))){const c=ports[0].cells[0];return `The port cell ${key(c)} is inside the spawner's reach at ${key(spawnerOver(bot,c,o))}: a blaze could be made in the port. Stand where the port is two above the blazes' floor`}
 const site=hutSite(bot);if(!site.ok)return 'No wall-in site here: '+site.reason
 return ''
}

export async function blazeStand(bot,task,{check,stage,progress,persist=()=>{},movements},options={}){
 const o={...BLAZE_STAND,...options},goal=validateStandGoal(task.goal)
 if(goal.item!==o.item)throw new Error('The blaze stand takes item blaze_rod')
 const refused=blazeStandRefusal(bot,o);if(refused)throw new Error(refused)
 const before=inventoryCounts(bot),started=Date.now(),context={check,stage,progress,persist,movements}
 const record={kills:0,ports:0,cycles:0,arrows:0,swings:0,missed:[],unclosed:null}
 const rods=()=>inventoryDelta(before,inventoryCounts(bot))[o.item]||0
 const left=()=>o.limitMs-(Date.now()-started)
 const ranOut=()=>`the stand's ${span(o.limitMs)} ran out`
 const eye=()=>bot.entity.position.offset(0,bot.entity.eyeHeight??1.62,0)
 let port=null,stopped=null,nextSwing=0
 // Blazes the bot shot at or struck: their deaths are its kills, and each kill's rod is judged a settle later.
 const engaged=new Set(),pending=[],named=new Set()
 const died=e=>{if(e?.name==='blaze'&&engaged.has(e.id)&&e.position){record.kills++;pending.push({at:e.position.clone(),due:Date.now()+o.settleMs,had:rods()});persist()}}
 // A rod that came in is the inventory's; one still lying within 3 of the kill is named, with its cell, and left.
 const judge=(all=false)=>{
  for(let i=pending.length-1;i>=0;i--){
   const k=pending[i];if(!all&&Date.now()<k.due)continue
   pending.splice(i,1);if(rods()>k.had)continue
   for(const d of killDrops(bot,k.at,{...KILL_DROPS,items:[o.item]}))if(!named.has(d.id)){named.add(d.id);record.missed.push(`${d.count} ${d.name} at ${key(d.position.floored())} (outside the port; I do not step out for it)`)}
  }
 }
 const portCell=()=>port?.opened?.[0]??null
 const inColumn=b=>{const c=portCell();return !!c&&Math.floor(b.position.x)===c.x&&Math.floor(b.position.z)===c.z}
 // A melee mob (hostile to the bot, not a shooter) near the port's cell: it shuts the port, and keeps it shut.
 const meleeNear=c=>{const centre=new Vec3(c.x+.5,c.y+.5,c.z+.5);return Object.values(bot.entities||{}).find(e=>e&&e!==bot.entity&&e.position&&e.name!=='blaze'&&!SHOOTERS_ONLY.has(e.name)&&hostileNow(bot,e)&&e.position.distanceTo(centre)<=o.meleeNear)||null}
 const hold=async(item,chk=check)=>{if(bot.heldItem?.name!==item.name){await bot.equip(item,'hand');chk()}}
 // The sword (weaponFor: no sweep with a bystander near), aimed at its middle, one swing a cooldown.
 const strike=async(b,chk=check)=>{
  const weapon=weaponFor(bot,b);if(!weapon)return false
  await hold(weapon,chk)
  await bot.lookAt(middle(b),true);chk()
  if(Date.now()<nextSwing||bot.entities?.[b.id]!==b)return true
  engaged.add(b.id);bot.attack(b);record.swings++;nextSwing=Date.now()+(o.cooldownMs??(weapon.name.endsWith('_axe')?1300:700))
  return true
 }
 // One full-draw arrow (archery.js looseArrow). 'hurt' when a hit lands while it draws, 'held' when a bystander or the
 // bow's range holds the shot.
 const shoot=async(b,top)=>{
  const bow=bot.inventory.items().find(i=>i.name==='bow');if(!bow)throw new Error('No bow left for the blaze stand')
  await hold(bow)
  // Engaged before the release: an arrow can kill it before the call returns.
  engaged.add(b.id)
  try{
   if(await looseArrow(bot,b,{check,stage,drawMs:o.drawMs,hurtOut:()=>!(bot.health>=top()),name:'blaze'})==='hurt')return 'hurt'
   record.arrows++;persist();return 'loosed'
  }catch(error){if(/^Holding fire|out of bow range/.test(error.message)){progress(error.message);return 'held'}throw error}
 }
 const eat=async(ctx,below)=>{
  const food=survivalObservation(bot).carriedFood?.[0];if(!food||!(bot.food<below))return
  try{await eatFood(bot,{kind:'eat',goal:{item:food.name,count:1}},ctx)}catch(error){ctx.check();ctx.progress(`Could not eat: ${String(error.message).slice(0,60)}`)}
 }
 // Nothing can be closed out of the port. While something stands in it (a blaze in the port, or a 1.4-wide hoglin on the
 // ledge whose box reaches into the port cell), the close strikes whatever there is hostile to the bot within clear reach
 // (combat.js portStrike, anyHostile), in place. A kill still settling is let land first, so its rod is not walled in. At
 // or over the trip's health the close gives up after closeLimitMs and says why; under it there is nowhere better to be,
 // so it keeps closing, eating when it can, and the bot never leaves the cell. ctx: the stand's context, or the bounded one
 // the ending uses.
 // The port's cells: the opened ones, or the chosen ones on the task when the opening was cut off inside unwall.
 const portCells=()=>port?.opened??task.portOpen??null
 // Live rehearsal R9, 17 October 06:42Z (death 6): the close could not succeed and the bot stood a minute beside the open,
 // burning port. In the Nether a water bucket evaporates (fire-safety.js pours none there), so the act is to leave the port's
 // cell: into a covered neighbour (hut.js coveredColumn: floor, roof and both sides standing, as the tunnel the stand was
 // reached by), the two across the port's line before the one behind it, whose cells hold air or the bot's own wall and
 // where a hut closes. The bot digs its own wall, steps in (no digging, towering or placing on the way) and walls in there,
 // which puts a wall between it and the port. The cell, or null with nothing dug when there is none; a step or wall-in that
 // fails after the dig is null too, said, and the close goes on.
 const stepBack=async(ctx,why)=>{
  const here=bot.entity.position.floored(),c0=portCells()[0],px=Math.sign(c0.x-here.x),pz=Math.sign(c0.z-here.z)
  if(Math.abs(c0.x-here.x)+Math.abs(c0.z-here.z)!==1)return null
  const open=c=>{const b=bot.blockAt(c);return !!b&&(AIR.has(b.name)||fullCube(bot.registry,b.name)&&ownedNow(bot,b))}
  const cell=[[pz,px],[-pz,-px],[-px,-pz]].map(([dx,dz])=>here.offset(dx,0,dz))
   .find(c=>open(c)&&open(c.offset(0,1,0))&&coveredColumn(bot,c,{walled:true})&&hutSiteAt(bot,c).ok)
  if(!cell)return null
  ctx.stage('retreating');ctx.progress(`Hurt beside a port I cannot close (${why}): stepping back into the covered cell at ${key(cell)}`)
  for(const c of [cell.offset(0,1,0),cell])await digOne(bot,bot.blockAt(c),ctx.check)
  ctx.check()
  const previous=bot.pathfinder.movements,movement=new DoorAwareMovements(bot)
  Object.assign(movement,{canDig:false,allow1by1towers:false,allowParkour:false,allowSprinting:false,maxDropDown:0,scafoldingBlocks:[]})
  bot.pathfinder.setMovements(movement)
  const timer=setTimeout(()=>bot.pathfinder?.setGoal?.(null),o.stepMs)
  try{await bot.pathfinder.goto(new goals.GoalBlock(cell.x,cell.y,cell.z))}catch{ctx.check()}finally{clearTimeout(timer);if(previous)bot.pathfinder.setMovements(previous)}
  ctx.check()
  if(!bot.entity.position.floored().equals(cell)){ctx.progress(`Could not step back into ${key(cell)}`);return null}
  try{await wallIn(bot,{kind:'hut',goal:{}},ctx);ctx.check()}catch(error){ctx.check();ctx.progress(`Could not wall in at ${key(cell)}: ${String(error.message).slice(0,80)}`);return null}
  return cell
 }
 const close=async(ctx=context)=>{
  if(!portCells())return true
  ctx.stage('walling')
  for(const end=Date.now()+o.settleMs;pending.length&&bot.health>=TRIP_HEALTH&&Date.now()<end;){ctx.check();judge();await delay(o.poll)}
  const until=Date.now()+o.closeLimitMs,from=bot.health
  for(let ate=0,stepped=false;;){
   const why=await closePort(bot,portCells(),ctx,{...o,closeTries:1},{whileBlocked:async inside=>{const m=inside.find(e=>portStrike(bot,e,null,{anyHostile:true}));if(m)await strike(m,ctx.check)}})
   if(!why){port=null;record.unclosed=null;delete task.portOpen;persist();return true}
   record.unclosed=why
   // Alight or losing health, and under the trip's line or retreatDrop down since the close began: step back, once.
   if(!stepped&&(fireObservation(bot).onFire===true||bot.health<from)&&(bot.health<TRIP_HEALTH||from-bot.health>=o.retreatDrop)){
    stepped=true;const opened=portCells(),cell=await stepBack(ctx,why)
    if(cell){record.stepped=`${why}; I stepped back into the covered cell at ${key(cell)} and walled in there; the port at ${opened.map(key).join(' and ')} stays open outside it`;port=null;record.unclosed=null;delete task.portOpen;persist();return false}
   }
   if(bot.health>=TRIP_HEALTH&&Date.now()>=until)return false
   if(bot.health<TRIP_HEALTH&&Date.now()-ate>=30000){ate=Date.now();await eat(ctx,20)}
   // Live rehearsal R9, 17 October 06:42Z (death 6): a close the hut refuses at once throws before any await on a timer, so
   // this loop spun on resolved promises for its whole minute. No packet was read, no tick or alarm ran and the bot's health
   // stayed 15.875 in its own view while the server killed it. Each try waits a poll.
   await delay(o.poll)
  }
 }
 // Shut, the bot eats if it can and waits up to healMs for the port's health (portReady: 16, not burning, food 6).
 const heal=async()=>{
  stage('healing');progress(`Healing with the port shut (health ${Math.round(bot.health)})`)
  await eat(context,18)
  // Review of the covered stand (17 October): a mob through a broken wall hit the bot for the whole wait. Health falling
  // while it heals, or under the trip's line, ends the wait at once: '' when ready, else why not.
  // Live rehearsal R9b, 17 October 06:05:48Z: alight from a fireball at the port, the bot healed shut with no fire block in
  // or around the hut, and the first burn tick ended the stand as a hit. A fall while alight (or within burnMs of it) in a
  // hut that still holds, with no fire or lava in or touching its cavity (shelter-occupants.js shelterHolds), is the burn;
  // not alight, or with the hut open or burning, it is a hit as before. The trip's line stops it either way.
  let last=bot.health,alightAt=-Infinity
  for(const end=Date.now()+Math.min(o.healMs,Math.max(0,left()));Date.now()<end&&!portReady(bot).ready;){
   check()
   if(fireObservation(bot).onFire===true)alightAt=Date.now()
   if(bot.health<last&&!(Date.now()-alightAt<=o.burnMs&&shelterHolds(bot,{limit:o.cavityCells})))return `hit while healing with the port shut (health ${Math.round(bot.health)})`
   if(!(bot.health>=TRIP_HEALTH))return `health ${Math.round(bot.health)} is under ${TRIP_HEALTH} while healing`
   last=bot.health;await delay(o.poll)
  }
  return portReady(bot).ready?'':`${portReady(bot).reason}, not back after ${span(o.healMs)} shut`
 }
 stage('walling');progress('Walling in for the stand')
 await wallIn(bot,{kind:'hut',goal:{}},context);check()
 const feet=bot.entity.position.floored()
 // The hut's own cells, its floor and the footings under its walls: never dug to open a line.
 const hutCells=new Set([feet.offset(0,-1,0),feet.offset(0,2,0),feet.offset(1,2,0),...[[1,0],[-1,0],[0,1],[0,-1]].flatMap(([dx,dz])=>[-1,0,1].map(y=>feet.offset(dx,y,dz)))].map(key))
 const prepared=new Set()
 // Port preparation, once a side, with the port shut. The bot's own blocks within dig reach that stop a line from the eye
 // through the port cell to a loaded blaze are dug (a natural block in a line is left, and that line goes without), and so
 // is its own block over the port cell, so a blaze can come onto the sill. With air over the port, one block is placed at
 // feet level beyond the sill if that cell is air (the ledge): a blaze cannot cross it at the bot's feet level, so it comes
 // up to the sill. Cobblestone first, as the portal seal's.
 const prepare=async({side,cells})=>{
  const [dx,,dz]=side,over=cells[0].offset(0,1,0),sill=feet.offset(dx,0,dz),ledge=feet.offset(2*dx,0,2*dz)
  const mine=c=>{const b=bot.blockAt(c);return !!b&&!hutCells.has(key(c))&&!c.equals(ledge)&&ownedNow(bot,b)&&c.offset(.5,.5,.5).distanceTo(eye())<=o.digReach&&!refuseDigCell(bot,c,{role:'head',ownAnyAge:true})}
  const dig=async c=>{stage('preparing');progress(`Digging my own block at ${key(c)} out of the port's line`);await digOne(bot,bot.blockAt(c),check);check()}
  for(let n=0;n<8;n++){
   const plug=blazes(bot,o.radius).map(b=>portSightline(bot,feet,b)).find(l=>l.status==='blocked'&&l.side?.[0]===dx&&l.side?.[2]===dz&&l.cell&&mine(new Vec3(l.cell.x,l.cell.y,l.cell.z)))
   if(!plug)break
   await dig(new Vec3(plug.cell.x,plug.cell.y,plug.cell.z))
  }
  // Not when the cell over the port is inside a spawner's volume: the dug column would be a pocket a blaze fits.
  if(mine(over)&&!spawnerOver(bot,over,o))await dig(over)
  if(!AIR.has(bot.blockAt(over)?.name)||!AIR.has(bot.blockAt(ledge)?.name)||!fullCube(bot.registry,bot.blockAt(sill)?.name))return
  const m=hutMaterials(bot),material=m.find(i=>i.name==='cobblestone')??m[0];if(!material)return
  stage('preparing');progress(`Placing a ledge at ${key(ledge)} beyond the port`)
  try{await holdToPlace(bot,material.name,check);await bot.placeBlock(bot.blockAt(sill),new Vec3(dx,0,dz))}catch(error){check();progress(`The ledge at ${key(ledge)} did not go down: ${String(error.message).slice(0,60)}`)}
  if(fullCube(bot.registry,bot.blockAt(ledge)?.name))claimPlaced(bot,ledge)
 }
 // The side to open: each loaded blaze's port side (burrow.js portSightline, the bow's own line through the side unhut opens),
 // prepared the first time it is seen; then the nearest blaze with a clear line, a side with air over its port first.
 const choose=async()=>{
  const near=blazes(bot,o.radius)
  for(const b of near){const l=portSightline(bot,feet,b),k=l.side&&`${l.side[0]},${l.side[2]}`;if(k&&!prepared.has(k)){prepared.add(k);await prepare(l)}}
  const lined=near.map(b=>({b,l:portSightline(bot,feet,b)})).filter(x=>x.l.status==='clear'&&!spawnerOver(bot,x.l.cells[0],o))
  const pick=lined.find(x=>AIR.has(bot.blockAt(x.l.cells[0].offset(0,1,0))?.name))??lined[0]
  return pick?{target:pick.b,side:pick.l.side,cells:pick.l.cells}:null
 }
 // The port held open. Each tick the nearest blaze with a line: in the port column within clear reach, the sword; within
 // drawIn blocks outside it (knocked back out, or not yet in), watched until it comes into the column, since a kill there
 // drops the rod beyond the wall (review of the stand); farther, one arrow.
 // Ends 'count', 'time', 'arrows', 'hit', 'hurt', 'melee', 'idle' or 'blink'.
 const session=async()=>{
  let top=bot.health,lined=Date.now(),near=Date.now()
  for(;;){
   check();judge()
   if(rods()>=goal.count)return {end:'count'}
   if(left()<=0)return {end:'time'}
   if(arrowsCarried(bot)<o.arrows)return {end:'arrows'}
   top=Math.max(top,bot.health)
   if(bot.health<top)return {end:'hit'}
   if(!(bot.health>=PORT_HEALTH))return {end:'hurt'}
   const mob=meleeNear(portCell());if(mob)return {end:'melee',mob}
   const seen=blazes(bot,o.radius).filter(b=>shotLine(bot,eye(),b).status==='clear')
   if(!seen.length){if(Date.now()-lined>=o.idleMs)return {end:'idle'};await delay(o.poll);continue}
   lined=Date.now()
   if(seen.some(b=>b.position.distanceTo(bot.entity.position)<=o.drawIn))near=Date.now()
   else if(Date.now()-near>=o.drawInMs)return {end:'blink'}
   const b=seen[0]
   if(inColumn(b)&&portStrike(bot,b,portCell())){if(!await strike(b))await bot.lookAt(middle(b),true)}
   else if(b.position.distanceTo(bot.entity.position)<=o.drawIn)await bot.lookAt(middle(b),true)
   else if(await shoot(b,()=>top)==='hurt')return {end:'hit'}
   await delay(o.poll)
  }
 }
 bot.on('entityDead',died)
 let empty=null
 try{
  for(;;){
   check();judge()
   if(rods()>=goal.count){stopped='reached the count';break}
   if(left()<=0){stopped=ranOut();break}
   const carried=arrowsCarried(bot)
   if(carried<o.arrows){stopped=`arrows ${carried} are under ${o.arrows}`;break}
   if(!(bot.health>=TRIP_HEALTH)){stopped=`health ${Math.round(bot.health)} is under ${TRIP_HEALTH}`;break}
   if(!blazes(bot,o.radius).length){
    empty??=Date.now()
    if(Date.now()-empty>=o.emptyMs){stopped=`no blaze loaded within ${o.radius} blocks for ${span(o.emptyMs)}`;break}
    stage('waiting');await delay(o.poll);continue
   }
   empty=null
   if(!portReady(bot).ready){const why=await heal();if(why){stopped=why;break}}
   const choice=await choose();check()
   if(!choice||meleeNear(choice.cells[0])){stage('waiting');await delay(o.poll);continue}
   // The port opens only with the blocks to wall in here again after it, and one to spare (controller.js's port rule).
   const site=hutSite(bot),blocks=hutMaterials(bot).reduce((n,i)=>n+i.count,0),needed=site.ok?site.needed+choice.cells.filter(c=>fullCube(bot.registry,bot.blockAt(c)?.name)).length+1:null
   if(!site.ok){stopped=`no wall-in site to close the port again: ${site.reason}`;break}
   if(blocks<needed){stopped=`not enough blocks to close the port again (${blocks} carried, ${needed} needed)`;break}
   // On the task before the dig (re-review of the stand): a cancellation inside unwall, after its dig, otherwise leaves the
   // cell open with nothing recorded. The controller walls in if the stand ends without closing it.
   task.portOpen=choice.cells.map(c=>({x:c.x,y:c.y,z:c.z}));persist()
   stage('opening')
   port=await unwall(bot,{kind:'unhut',goal:{toward:column(choice.target.position),shooter:'blaze',side:{dx:choice.side[0],dz:choice.side[2]}}},context);check()
   task.portOpen=structuredClone(port.opened);record.ports++;persist()
   const r=await session()
   if(!await close()){stopped=`could not close the port: ${record.stepped??record.unclosed}`;break}
   if(r.end==='time'){stopped=ranOut();break}
   if(r.end==='hit')progress('Hit at the port. I closed it.')
   if(r.end==='melee')progress(`${a(r.mob.name).replace(/^a/,'A')} came near the port. I closed it.`)
   if(r.end==='idle')progress(`No blaze in line for ${span(o.idleMs)}. I closed the port.`)
   if(r.end==='blink'){record.cycles++;await delay(Math.max(0,Math.min(o.blinkMs,left())))}
  }
 }catch(error){
  // A cancellation is the safety's to answer; any other failure still reports the rods won.
  check();stopped=error.message
 }finally{
  bot.removeListener?.('entityDead',died)
  // After a cancellation the runner's check and progress throw, so the closing runs on its own clock (finalCloseMs).
  if(portCells()&&!record.unclosed){
   const end=Date.now()+o.finalCloseMs,quiet=m=>{try{progress(m)}catch{}}
   try{await close({...context,check:()=>{if(Date.now()>end)throw new Error('the closing ran out of time')},progress:quiet})}catch{}
  }
 }
 for(const end=Date.now()+o.settleMs;pending.length&&Date.now()<end;)await delay(o.poll)
 judge(true)
 const gained=rods(),tally=`${plural(record.kills,'blaze','blazes')} killed, ${plural(record.ports,'port','ports')} opened`
 const open=task.portOpen?{portOpen:task.portOpen,unclosed:record.unclosed}:record.unclosed?{unclosed:record.unclosed}:{}
 // A kill at range is no rod, but it frees the spawner for a blaze that may come to the port: said, never counted.
 if(!gained)throw new Error(`No blaze rod gained: ${tally}; ${stopped}${record.missed.length?`; left behind: ${record.missed.join('; ')}`:''}${record.kills?'; each kill frees the spawner for another blaze':''}${task.portOpen?'; the port is still open':''}`)
 return {receipt:'stand',item:o.item,count:gained,requested:goal.count,rods:gained,kills:record.kills,withoutRod:Math.max(0,record.kills-gained),ports:record.ports,cycles:record.cycles,arrows:record.arrows,arrowsLeft:arrowsCarried(bot),swings:record.swings,
  partial:gained<goal.count,stopped,closed:!task.portOpen&&!record.unclosed,position:round(bot.entity.position),...open,...(record.missed.length?{missed:record.missed}:{})}
}
