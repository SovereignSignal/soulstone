// The enderman stand (dragon roadmap stage 2, brief 1): ender pearls from endermen,
// fought from the 2-high hut on a kitted Nether trip. An enderman is 2.9 blocks tall and
// cannot enter a room two high, so the hut is cover it cannot follow into. It aggroes on
// eye contact and teleports to whoever looked, so the bot opens a port toward one, looks it
// in the eye, and strikes it when it comes; the port closes between kills and whenever a
// second one comes near. The pearls a receipt reports are the inventory's own delta: kills
// without one are a failure with the reason, never a success.
import {setTimeout as delay} from 'node:timers/promises'
import pathfinding from 'mineflayer-pathfinder'
import {inNether} from './dimension.js'
import {tripKit,TRIP_HEALTH} from './nether-trip.js'
import {hutSite,wallIn,unwall} from './hut.js'
import {aloneRefusal,weaponFor,meleeWeapon,clearStrike,DEFENSE_HEALTH} from './combat.js'
import {survivalObservation,threatRadius} from './survival.js'
import {killDrops,ATTACK_REACH,KILL_DROPS} from './primitives-world.js'
import {DoorAwareMovements} from './navigation.js'
import {inventoryCounts,inventoryDelta} from './primitives.js'
const {goals}=pathfinding

// radius: endermen looked for. limitMs: the whole stand, and timeoutMs the step's limit.
// provokeMs: how long a provoked one has to reach the port, counted again from each strike.
// crowd: another enderman this close, or one screaming anywhere in the radius, shuts the
// port. healMs: waiting shut for the fight rule's health before provoking the next.
// settleMs: a drop's fall. stepReach: a pearl this close to the port's floor cell is picked
// up by one step into it and back. closeWaitMs, closeTries: a mob in the port's cell.
// The step's timeout is the runner's idle window, which every stage and progress slides
// forward, so the close at the limit is not cut off; the runner takes no more than 600000.
export const STAND={item:'ender_pearl',max:8,radius:24,limitMs:600000,timeoutMs:600000,provokeMs:20000,crowd:6,crowdPollMs:500,healMs:60000,settleMs:1500,stepReach:1.5,stepMs:4000,closeWaitMs:10000,closeTries:3,poll:50}
const round=p=>({x:Math.round(p.x*10)/10,y:Math.round(p.y*10)/10,z:Math.round(p.z*10)/10})
const cell=p=>`${p.x},${p.y},${p.z}`
const a=name=>{const n=name.replaceAll('_',' ');return `${/^[aeiou]/.test(n)?'an':'a'} ${n}`}

// The stand is fought for one of two drops: ender pearls from endermen (here) and blaze rods from blazes (blaze-stand.js).
const STAND_ITEMS={ender_pearl:'ender pearls',blaze_rod:'blaze rods'}
export function validateStandGoal(goal){
 if(!Object.hasOwn(STAND_ITEMS,goal?.item))throw new Error('stand takes item ender_pearl (endermen) or blaze_rod (blazes)')
 if(!Number.isInteger(goal.count)||goal.count<1||goal.count>STAND.max)throw new Error(`stand needs a count of 1 to ${STAND.max} ${STAND_ITEMS[goal.item]}`)
 return {item:goal.item,count:goal.count}
}
// Whatever living stands in a port's cells: the server will not place a block in it.
export const standingIn=(bot,cells)=>Object.values(bot.entities||{}).filter(e=>e&&e!==bot.entity&&e.position&&!e.getDroppedItem?.()&&!['item','experience_orb'].includes(e.name)&&e.type!=='projectile'&&
 (cells||[]).some(c=>Math.abs(e.position.x-(c.x+.5))<.5+(e.width??.6)/2&&Math.abs(e.position.z-(c.z+.5))<.5+(e.width??.6)/2&&e.position.y<c.y+1&&e.position.y+(e.height??1.8)>c.y))
// wallIn puts back whatever of the hut is missing, which is the port. A mob in the port refuses the blocks, so the close
// waits for it to clear and tries again, a bounded number of times. '' once closed, else why not. whileBlocked: what the
// caller does each poll while something stands in the port (the blaze stand strikes a blaze there).
export async function closePort(bot,cells,context,o,{whileBlocked=async()=>{}}={}){
 const {check}=context;let why=''
 for(let attempt=0;attempt<o.closeTries;attempt++){
  for(const end=Date.now()+o.closeWaitMs;Date.now()<end&&standingIn(bot,cells).length;){check();await whileBlocked(standingIn(bot,cells));await delay(o.poll)}
  const blocking=standingIn(bot,cells)[0];if(blocking){why=`${a(blocking.name)} stands in it`;continue}
  try{await wallIn(bot,{kind:'hut',goal:{}},context);check();return ''}
  catch(error){check();why=error.message}
 }
 return why||'it would not close'
}

// The `creepy` flag is an enderman screaming at someone (survival.js reads it the same way).
const screaming=(bot,e)=>{const i=bot.registry?.entitiesByName?.enderman?.metadataKeys?.indexOf('creepy')??-1;return i>=0&&e?.metadata?.[i]===true}
const endermen=(bot,radius)=>Object.values(bot.entities||{}).filter(e=>e?.name==='enderman'&&e.position&&e.position.distanceTo(bot.entity.position)<=radius)
 .sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position))
// Any enderman but the one in hand that is close, or already after someone.
const crowding=(bot,target,o)=>endermen(bot,o.radius).filter(e=>e!==target&&(e.position.distanceTo(bot.entity.position)<=o.crowd||screaming(bot,e)))

// Why the stand cannot start here, or ''. A stand step is the request, so the trip is the
// Nether with the kit and the trip's health (nether-trip.js); the fight rule's own floors
// for an enderman come on top.
export function standRefusal(bot,o=STAND){
 if(!inNether(bot))return 'The stand is Nether only: endermen are thickest in a warped forest, and an Overworld night sends the bot indoors'
 const kit=tripKit(bot)
 if(!kit.ready)return `Not on a kitted trip: ${kit.missing.join(', ')} missing`
 if(!(bot.health>=TRIP_HEALTH))return `Not on a kitted trip: health ${Math.round(bot.health)} is under ${TRIP_HEALTH}`
 const refused=aloneRefusal(bot,'enderman');if(refused)return refused
 if(!endermen(bot,o.radius).length)return `No enderman within ${o.radius} blocks`
 const site=hutSite(bot);if(!site.ok)return 'No wall-in site here: '+site.reason
 return ''
}

export async function enderStand(bot,task,{check,stage,progress,persist=()=>{},movements},options={}){
 const o={...STAND,...options},goal=validateStandGoal(task.goal)
 if(goal.item!==o.item)throw new Error('The enderman stand takes item ender_pearl')
 const refused=standRefusal(bot,o);if(refused)throw new Error(refused)
 const before=inventoryCounts(bot),started=Date.now(),context={check,stage,progress,persist,movements}
 const record={kills:0,ports:0,crowds:0,missed:[],unclosed:null},tried=new Set()
 const pearls=()=>inventoryDelta(before,inventoryCounts(bot))[o.item]||0
 const left=()=>o.limitMs-(Date.now()-started)
 const ranOut=()=>`the stand's ${Math.round(o.limitMs/60000)} minutes ran out`
 const floor=DEFENSE_HEALTH.enderman
 let port=null,stopped=null
 const here=()=>bot.entity.position.floored()
 // A close that cannot finish says why rather than failing the pearls already won (closePort).
 const close=async()=>{
  if(!port)return true
  stage('walling')
  const why=await closePort(bot,port.opened,context,o)
  if(!why){port=null;return true}
  record.unclosed=why;return false
 }
 // One step, walked as the bow's covered step is: no digging, towering or placing, and the
 // runner's movement profile restored. Never throws but for a cancellation.
 const step=async(c,why)=>{
  progress(why)
  const previous=bot.pathfinder.movements,movement=new DoorAwareMovements(bot)
  Object.assign(movement,{canDig:false,allow1by1towers:false,allowParkour:false,allowSprinting:false,maxDropDown:0,scafoldingBlocks:[]})
  bot.pathfinder.setMovements(movement)
  const timer=setTimeout(()=>bot.pathfinder?.setGoal?.(null),o.stepMs)
  try{await bot.pathfinder.goto(new goals.GoalBlock(c.x,c.y,c.z))}catch{check()}finally{clearTimeout(timer);if(previous)bot.pathfinder.setMovements(previous)}
  check()
 }
 const settled=async had=>{for(const end=Date.now()+o.settleMs;Date.now()<end&&pearls()===had;){check();await delay(o.poll)}}
 // Out of the hut for a pearl only when nothing else can be at the bot there: the fight
 // rule's health, no other enderman near, no other hostile within its own alarm radius.
 const stepRisk=()=>{
  if(!(bot.health>=floor))return `health ${Math.round(bot.health)} is under ${floor}`
  const other=crowding(bot,null,o)[0];if(other)return `an enderman ${Math.round(other.position.distanceTo(bot.entity.position))} blocks off`
  const hostile=survivalObservation(bot).nearbyThreats.find(t=>t.risk==='potential_hostile'&&t.distance<=threatRadius(t.name))
  return hostile?`${a(hostile.name)} ${Math.round(hostile.distance)} blocks off`:''
 }
 // The pearl falls where the enderman died, usually just outside the port: within pickup
 // reach it comes in by itself, one cell out it takes a step and back, and further it is
 // named. A step back that does not land home ends the stand walled in where the bot
 // stands, as the firing port's stray does. 'strayed' when it did.
 const collect=async(where,feet)=>{
  stage('collecting')
  const had=pearls(),lying=()=>killDrops(bot,where,{...KILL_DROPS,items:[o.item]})
  const miss=why=>{for(const d of lying())record.missed.push(`${d.count} ${d.name} at ${cell(d.position.floored())} (${why})`)}
  await settled(had)
  if(pearls()>had||!lying().length)return null
  const ground=port?.opened?.find(c=>c.y===feet.y),door=ground&&feet.offset(ground.x-feet.x,0,ground.z-feet.z)
  if(!door||!lying().some(d=>Math.hypot(d.position.x-(door.x+.5),d.position.z-(door.z+.5))<=o.stepReach)){miss('past the port');return null}
  const risk=stepRisk();if(risk){miss(`not stepping out: ${risk}`);return null}
  await step(door,`Stepping into the port at ${cell(door)} for the pearl`)
  await settled(had)
  for(let attempt=0;attempt<2&&!here().equals(feet);attempt++)await step(feet,'Stepping back into the hut')
  if(pearls()===had)miss('not picked up')
  if(here().equals(feet))return null
  const at=here();port=null
  try{stage('walling');await wallIn(bot,{kind:'hut',goal:{}},context);check()}
  catch(error){check();record.unclosed=`walling in at ${cell(at)}: ${error.message}`}
  return `Not back in the hut after the pearl: at ${cell(at)}; walled in where I stand`
 }
 // Provoke the target through the open port and strike it there. Ends 'killed', 'crowd',
 // 'no_show' (never came, or went for good), 'hurt' (under the fight rule's floor) or 'time'.
 const duel=async target=>{
  const weapon=weaponFor(bot,target)||meleeWeapon(bot,16)
  if(!weapon)throw new Error('No melee weapon with 16 uses left for the enderman')
  await bot.equip(weapon,'hand');check()
  const cooldown=o.cooldownMs??(weapon.name.endsWith('_axe')?1300:700)
  let dead=null,nextSwing=0,since=Date.now()
  const killed=e=>{if(e?.id===target.id)dead=(e.position??target.position).clone()}
  bot.on('entityDead',killed)
  stage('provoking');progress(`Looking the enderman ${Math.round(target.position.distanceTo(bot.entity.position))} blocks off in the eye`)
  try{
   for(;;){
    check()
    if(dead)return {end:'killed',where:dead}
    // Under the floor it took to start, the port shuts and the bot heals before another round.
    if(!(bot.health>=floor))return {end:'hurt'}
    if(left()<=0)return {end:'time'}
    if(crowding(bot,target,o).length)return {end:'crowd'}
    if(bot.entities?.[target.id]!==target){
     // Gone from view after a teleport: the nearest provoked one in the radius stands in.
     const again=endermen(bot,o.radius).find(e=>screaming(bot,e))
     if(!again)return {end:'no_show'}
     target=again;since=Date.now()
    }
    if(Date.now()-since>=o.provokeMs)return {end:'no_show'}
    if(target.position.distanceTo(bot.entity.position)<=ATTACK_REACH&&(typeof bot.world?.raycast!=='function'||clearStrike(bot,target))){
     await bot.lookAt(target.position.offset(0,Math.min(1.2,(target.height??2.9)/2),0),true);check()
     if(!dead&&Date.now()>=nextSwing&&bot.entities?.[target.id]===target){bot.attack(target);nextSwing=Date.now()+cooldown;since=Date.now()}
    }
    // Eye contact is what provokes it; held on a provoked one it keeps the stare.
    else await bot.lookAt(target.position.offset(0,(target.height??2.9)*.88,0),true)
    await delay(o.poll)
   }
  }finally{(bot.removeListener||bot.off)?.call(bot,'entityDead',killed)}
 }
 stage('walling');progress('Walling in for the stand')
 await wallIn(bot,{kind:'hut',goal:{}},context);check()
 const feet=here()
 try{
  for(;;){
   check()
   if(pearls()>=goal.count){stopped='reached the count';break}
   if(left()<=0){stopped=ranOut();break}
   if(!(bot.health>=TRIP_HEALTH)){stopped=`health ${Math.round(bot.health)} is under ${TRIP_HEALTH}`;break}
   // Shut in, the bot heals to the fight rule's floor before it provokes another.
   if(aloneRefusal(bot,'enderman')){
    stage('healing')
    for(const end=Date.now()+Math.min(o.healMs,left());Date.now()<end&&aloneRefusal(bot,'enderman');){check();await delay(o.crowdPollMs)}
    const still=aloneRefusal(bot,'enderman');if(still){stopped=still;break}
   }
   const target=endermen(bot,o.radius).find(e=>!tried.has(e.id))
   if(!target){stopped=`no enderman left within ${o.radius} blocks`;break}
   if(crowding(bot,target,o).length){stage('waiting');await delay(Math.max(0,Math.min(o.crowdPollMs,left())));continue}
   stage('opening')
   port=await unwall(bot,{kind:'unhut',goal:{toward:{x:Math.floor(target.position.x),z:Math.floor(target.position.z)},shooter:'enderman'}},context);check()
   record.ports++;persist()
   const r=await duel(target)
   if(r.end==='killed'){record.kills++;persist();const strayed=await collect(r.where,feet);if(strayed){stopped=strayed;break}}
   if(!await close()){stopped=`could not close the port: ${record.unclosed}`;break}
   if(r.end==='crowd'){record.crowds++;progress('A second enderman came near: port closed')}
   if(r.end==='no_show')tried.add(target.id)
   if(r.end==='time'){stopped=ranOut();break}
  }
 }catch(error){
  // A cancellation is the safety's to answer; any other failure still reports the pearls won.
  check();stopped=error.message
 }finally{
  if(port&&!record.unclosed)try{await close()}catch{}
 }
 const gained=pearls(),tally=`${record.kills} ${record.kills===1?'enderman':'endermen'} killed, ${record.ports} ${record.ports===1?'port':'ports'} opened`
 const open=port?{portOpen:port.opened,unclosed:record.unclosed}:record.unclosed?{unclosed:record.unclosed}:{}
 if(!gained)throw new Error(`No ender pearl gained: ${tally}; ${stopped}${record.missed.length?`; left behind: ${record.missed.join('; ')}`:''}${port?'; the port is still open':''}`)
 return {receipt:'stand',item:o.item,count:gained,requested:goal.count,pearls:gained,kills:record.kills,ports:record.ports,crowds:record.crowds,partial:gained<goal.count,stopped,closed:!port&&!record.unclosed,position:round(bot.entity.position),...open,...(record.missed.length?{missed:record.missed}:{})}
}
