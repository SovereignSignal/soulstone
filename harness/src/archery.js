import {setTimeout as delay} from 'node:timers/promises'
import {Vec3} from 'vec3'
import {validateAttackGoal,nearestOfType,isProtectedBystander,collectKillDrops} from './primitives-world.js'
import {observedSightline,shotLine,aimPoint} from './visibility.js'
import {aimPitch,arrowPath} from './arrow.js'
import {fullCube} from './construction.js'
import {survivalObservation} from './survival.js'
import {standable} from './fire-safety.js'
import {DoorAwareMovements,bridgeFall} from './navigation.js'
import pathfinding from 'mineflayer-pathfinder'
const {goals}=pathfinding
import {RANGED_DEFENSE,bowCanAnswer} from './bow-readiness.js'
export {RANGED_DEFENSE,bowCanAnswer}
export const SHOOT={radius:32,drawMs:1100,maxShots:12,settleMs:900,reacquire:10,reposition:4,repositionMs:12000,repositions:3,healthStop:10,breakOnHit:false}
// Security reviews of 6da6e6c, ae7e4aa and 1993aea (9 October): an arrow flies on
// past a miss, so the target's type is not enough. A protected bystander within a
// block and a half of the arrow's arc holds the shot, along the whole flight: until
// the arrow falls well below the target or meets a solid block, not a fixed
// distance past the target. The arc, not the straight line: a long shot rises.
export const LINE_OF_FIRE={clearance:1.5,fallBelow:8,overhead:6}
export function lineOfFireBlocker(bot,from,aimAt,target){
 const flat=new Vec3(aimAt.x-from.x,0,aimAt.z-from.z),d=flat.norm()
 // Straight up or down there is no horizontal line to follow, and the arrow comes
 // back down by the shooter: any protected bystander close by holds it.
 if(d<1)return Object.values(bot.entities||{}).find(e=>e?.position&&e!==bot.entity&&e.id!==target.id&&isProtectedBystander(e)&&Math.hypot(e.position.x-from.x,e.position.z-from.z)<=LINE_OF_FIRE.overhead)||null
 const unit=flat.scaled(1/d),pitch=aimPitch(from,aimAt),floor=aimAt.y-LINE_OF_FIRE.fallBelow
 const path=pitch===null?[from,aimAt]:arrowPath(pitch).map(p=>from.plus(unit.scaled(p.x)).offset(0,p.y,0))
 // Past the target the flight ends where it falls well below it, or in the first
 // solid block (anyone behind that is safe). A tick covers up to three blocks, so
 // each step is walked in half blocks to find a wall one block thick.
 const points=[path[0]],past=p=>Math.hypot(p.x-from.x,p.z-from.z)>d
 flight:for(let i=1;i<path.length;i++){
  const a=path[i-1],b=path[i],steps=Math.max(1,Math.ceil(b.minus(a).norm()/0.5))
  for(let k=1;k<=steps;k++){
   const p=a.plus(b.minus(a).scaled(k/steps))
   if(!past(p))continue
   // Only a full cube stops it: an arrow passes over a slab or beside a fence post or a pane.
   const block=bot.blockAt?.(p.floored())
   if(p.y<floor||block&&bot.registry&&fullCube(bot.registry,block.name)){points.push(p);break flight}
  }
  points.push(b)
 }
 const near=(c,a,b)=>{const ab=b.minus(a),t=Math.max(0,Math.min(1,c.minus(a).dot(ab)/(ab.dot(ab)||1)));return c.minus(a.plus(ab.scaled(t))).norm()}
 for(const e of Object.values(bot.entities||{})){
  if(!e?.position||e===bot.entity||e.id===target.id||!isProtectedBystander(e))continue
  const c=e.position.offset(0,(e.height??1.8)/2,0),reach=LINE_OF_FIRE.clearance+(e.width??0.6)/2
  for(let i=1;i<points.length;i++)if(near(c,points[i-1],points[i])<=reach)return e
 }
 return null
}
// A stance at an open edge: a neighbouring cell the bot could be knocked into
// with no ground within a harmless fall below it. A blaze's fireball knocks back.
const AROUND=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]
export function edgeExposed(bot,cell){
 return AROUND.some(([dx,dz])=>{const n=cell.offset(dx,0,dz);return !fullCube(bot.registry,bot.blockAt(n)?.name)&&bridgeFall(bot,n)==='unsafe'})
}
// Lab run 146, 15 October: in a hut inside a one-wide netherrack tunnel, a blaze below
// eye level outside the tunnel wall. Through the firing port the line from the middle
// of the hut ran into the port's own floor; one step into the port it was clear. That
// step is still cover when the port cell has a floor, a full block over it and both of
// its sides walled, as a port in a tunnel wall does: only its front is open, and what
// shoots from there knocks the bot back into the hut, not over an edge.
const SIDES=[[1,0],[-1,0],[0,1],[0,-1]]
export function coveredSteps(bot,feet){
 const solid=c=>fullCube(bot.registry,bot.blockAt(c)?.name)
 return SIDES.filter(([dx,dz])=>{const c=feet.offset(dx,0,dz);return standable(bot,c)&&solid(c.offset(0,2,0))&&[0,1].every(y=>solid(c.offset(dz,y,dx))&&solid(c.offset(-dz,y,-dx)))}).map(([dx,dz])=>feet.offset(dx,0,dz))
}
export async function shootTarget(bot,task,{check,stage,progress,movements},options={}){
 // Shooting from a firing port it stays in cover (lab run 146, 15 October).
 const o={...SHOOT,...(task.goal?.stay?{repositions:0}:{}),...(task.goal?.breakOnHit===true?{breakOnHit:true}:{}),...options}
 const goal=validateAttackGoal(task.goal,bot.registry)
 const bow=bot.inventory.items().find(i=>i.name==='bow')
 if(!bow)throw new Error('Shooting needs a bow (3 sticks and 3 string)')
 const arrows=()=>bot.inventory.items().filter(i=>i.name==='arrow').reduce((n,i)=>n+i.count,0)
 if(!arrows())throw new Error('Shooting needs arrows (flint, a stick and a feather make four)')
 if(!nearestOfType(bot,goal.type,bot.entity.position,o.radius))throw new Error(`No ${goal.type} within ${o.radius} blocks`)
 // Run 87 (10 October): the nearest blaze sat behind the fortress's nether bricks
 // three times over. Take the nearest one in sight; with none in sight, step to a
 // standing spot within four blocks that has a clear line, as a player strafes.
 const eyeAt=c=>c.offset(.5,bot.entity.eyeHeight??1.62,.5)
 const candidates=()=>Object.values(bot.entities||{}).filter(e=>e?.name===goal.type&&e.position&&e.position.distanceTo(bot.entity.position)<=o.radius).sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position))
 let lastBlock=null
 const visibleFrom=(from,e)=>{const line=shotLine(bot,from,e);if(line.status==='blocked')lastBlock=line.block;return line.status==='clear'||line.status==='unknown'}
 const inSight=()=>candidates().find(e=>visibleFrom(bot.entity.position.offset(0,bot.entity.eyeHeight??1.62,0),e))
 let moves=0,edgeRefusal=false,home=null,port=null,strayed=null
 const walk=async(c,why)=>{
  stage('repositioning');progress(why)
  // Security review of 35a7589: walk as attack chases, never digging, towering or
  // placing on the way, and give the runner its own movement profile back.
  const previous=bot.pathfinder.movements,movement=new DoorAwareMovements(bot)
  Object.assign(movement,{canDig:false,allow1by1towers:false,allowParkour:false,allowSprinting:false,maxDropDown:2,scafoldingBlocks:[]})
  bot.pathfinder.setMovements(movement)
  const timer=setTimeout(()=>bot.pathfinder?.setGoal?.(null),o.repositionMs)
  try{await bot.pathfinder.goto(new goals.GoalBlock(c.x,c.y,c.z))}catch{check()}finally{clearTimeout(timer);if(previous)bot.pathfinder.setMovements(previous)}
  check()
 }
 const takeAim=async()=>{
  // Lab run 99: knocked off the open end of the fortress bridge between shots.
  // Never draw at an open edge; step back from one first.
  // Standing in the port is exempt: only its front is open (coveredSteps).
  const feet=bot.entity.position.floored(),atEdge=!port?.equals(feet)&&edgeExposed(bot,feet)
  const seen=atEdge?null:inSight();if(seen)return seen
  // Shooting from the hut (stay), a step into a firing port is still cover, so it is
  // taken; an ordinary shot keeps the reposition rules below.
  // A head-only port (lab run 156) never gives a covered step: this serves the enderman's two-high port.
  if(task.goal?.stay&&!home&&!atEdge)for(const c of coveredSteps(bot,feet)){
   if(!candidates().some(t=>visibleFrom(eyeAt(c),t)))continue
   home=feet;port=c;await walk(c,`Stepping into the port at ${c.x},${c.y},${c.z} for a clear shot at the ${goal.type}`)
   return inSight()||null
  }
  if(moves>=o.repositions)return null
  const spots=[]
  for(let dx=-o.reposition;dx<=o.reposition;dx++)for(let dz=-o.reposition;dz<=o.reposition;dz++)for(const dy of [0,1,-1]){
   if(!dx&&!dz)continue
   const c=feet.offset(dx,dy,dz);if(Math.hypot(dx,dz)<=o.reposition&&standable(bot,c)&&!edgeExposed(bot,c))spots.push(c)
  }
  if(atEdge&&!spots.length)edgeRefusal=true
  spots.sort((a,b)=>Math.hypot(a.x-feet.x,a.z-feet.z)-Math.hypot(b.x-feet.x,b.z-feet.z)||Math.abs(a.y-feet.y)-Math.abs(b.y-feet.y))
  for(const c of spots){
   const e=candidates().find(t=>visibleFrom(eyeAt(c),t));if(!e){if(atEdge)edgeRefusal=true;continue}
   moves++;await walk(c,`Stepping to ${c.x},${c.y},${c.z} for a clear shot at the ${goal.type}`)
   return inSight()||null
  }
  return null
 }
 // Out of the port and back into the hut, so the hut closes round the bot again. A
 // walk that ends anywhere else is reported, never assumed home: the caller walls in
 // where the bot actually stands.
 const back=async()=>{
  if(!home)return
  const cell=home;home=null;port=null
  try{check()}catch{return}
  try{await walk(cell,'Stepping back into the hut')}catch{}
  const at=bot.entity.position.floored();if(!at.equals(cell))strayed={x:at.x,y:at.y,z:at.z}
 }
 const notHome=error=>{if(strayed)error.message+=`. Not back in the hut: at ${strayed.x},${strayed.y},${strayed.z}`;return error}
 let target
 try{target=await takeAim()}catch(error){await back();throw notHome(error)}
 if(!target)await back()
 if(!target&&edgeRefusal)throw notHome(new Error(`Not shooting from an open edge: no spot within ${o.reposition} blocks away from the drop has a clear shot at a ${goal.type}`))
 // Live rehearsal, 16 October 22:21Z: a stayed shot said "nor from a spot within 4" though it tries none, and named the
 // farthest blaze's blocker (crimson_nylium); from the port the nearest is the one that matters.
 if(!target&&task.goal?.stay){
  const near=candidates()[0],line=near?shotLine(bot,bot.entity.position.offset(0,bot.entity.eyeHeight??1.62,0),near):null
  throw notHome(new Error(`No clear shot through the port at the nearest ${goal.type}${near?` (${Math.round(near.position.distanceTo(bot.entity.position))} blocks)`:''}: ${line?.block||lastBlock||'a block'} is in the way`))
 }
 if(!target)throw notHome(new Error(`No clear shot at any ${goal.type} within ${o.radius} blocks, nor from a spot within ${o.reposition}: ${lastBlock||'a block'} is in the way`))
 let dead=false,shots=0,drawn=false,stopped=null,lastSeen=target.position.clone?.()??target.position
 // Lab run 101: 20 health to 5 in five seconds against a blaze at close range, still
 // drawing. In the Nether burning raises no alarm, so the duel must end itself: once
 // it has cost health and left half or less, break off and let the shelter decide.
 // Lab run 156, 15 October: at a firing port into a sealed room of blazes, 20 health to 8.7
 // in about six seconds over three arrows, then death by fire while walling in. A port that
 // lets one hit through will let the next: told to break on a hit, any point lost ends it.
 const startHealth=bot.health
 let top=startHealth
 const hurtOut=()=>{
  if(!Number.isFinite(bot.health)||!Number.isFinite(startHealth))return false
  if(o.breakOnHit){top=Math.max(top,bot.health);return bot.health<top}
  return bot.health<startHealth&&bot.health<=o.healthStop
 }
 const breakOff=()=>new Error(o.breakOnHit?`Hit at the slit: ${Math.round(bot.health*10)/10} health after ${shots} arrow${shots===1?'':'s'} at the ${goal.type}; standing down`
  :`Breaking off at ${Math.round(bot.health)} health: the ${goal.type} survived ${shots} arrow${shots===1?'':'s'}`)
 const killed=e=>{if(e?.id===target.id)dead=true}
 bot.on('entityDead',killed)
 const eye=()=>bot.entity.position.offset(0,bot.entity.eyeHeight??1.62,0)
 const centre=()=>aimPoint(target,bot.registry)
 const aim=()=>{
  const from=eye(),{aimAt,pitch}=aimPitch.lead(from,centre(),target.velocity??new Vec3(0,0,0))
  if(pitch===null)throw new Error(`The ${goal.type} is out of bow range`)
  return {yaw:Math.atan2(-(aimAt.x-from.x),-(aimAt.z-from.z)),pitch,aimAt}
 }
 const holdFire=e=>new Error(`Holding fire: a ${e.type==='player'?`player (${e.username||'someone'})`:e.name} is in the line of fire`)
 // Releasing a drawn bow always looses the arrow; changing the held slot cancels the draw.
 const standDown=()=>{try{bot.setQuickBarSlot?.(((bot.quickBarSlot??0)+1)%9)}catch{}}
 let failure=null
 try{
  stage('arming');await bot.equip(bow,'hand');check()
  for(;;){
   if(dead){stopped='killed';break}
   if(hurtOut())throw breakOff()
   if(shots>=o.maxShots){stopped='shot_budget';break}
   if(arrows()<=0){stopped='out_of_arrows';break}
   // Lab, 10 October: a blaze dropped out of the entity list after one arrow and the
   // shot ended with 47 left. Like attack, look for the same type where it was.
   if(!bot.entities?.[target.id]){
    const again=nearestOfType(bot,goal.type,lastSeen,o.reacquire)
    if(!again){stopped='target_lost';break}
    target=again
   }
   lastSeen=target.position.clone?.()??target.position
   const sight=observedSightline(bot,eye(),centre())
   if(sight.status==='blocked'){
    const next=await takeAim()
    if(!next)throw new Error(`No clear shot at the ${goal.type}: ${sight.block||'a block'} is in the way`)
    target=next;lastSeen=target.position.clone?.()??target.position;continue
   }
   let a=aim()
   const early=lineOfFireBlocker(bot,eye(),a.aimAt,target)
   if(early)throw holdFire(early)
   stage('drawing');bot.activateItem();drawn=true
   // Full draw takes a second; keep the aim on a moving target while it draws.
   const end=Date.now()+o.drawMs
   while(Date.now()<end){check();if(hurtOut()){standDown();drawn=false;throw breakOff()}a=aim();await bot.look(a.yaw,a.pitch,true);await delay(Math.min(100,o.drawMs))}
   a=aim()
   // Checked at the moment of release, against where the arrow is going.
   const blocker=lineOfFireBlocker(bot,eye(),a.aimAt,target)
   if(blocker){standDown();drawn=false;throw holdFire(blocker)}
   await bot.look(a.yaw,a.pitch,true);bot.deactivateItem();drawn=false;shots++
   progress(`Shot ${shots} at the ${goal.type}`)
   const until=Date.now()+o.settleMs
   while(!dead&&Date.now()<until){check();await delay(20)}
  }
 }catch(error){failure=error;throw error}finally{
  // Never leave an arrow drawn: the runner's cleanup calls deactivateItem, which would loose it.
  if(drawn)standDown()
  bot.removeListener('entityDead',killed)
  await back()
  if(failure)notHome(failure)
 }
 const at=dead?{x:target.position.x,y:target.position.y,z:target.position.z}:null
 // The kill's drops are part of the fight (lab runs 99 to 101: rods left on the
 // bridge when a later round never came). Self-defense picks up after its area check.
 const collected=dead&&task.goal?.collect!==false?await collectKillDrops(bot,[at],{check,stage,progress,movements}):null
 return {item:goal.type,count:dead?1:0,receipt:dead?'killed':'target_survived',shots,arrowsLeft:arrows(),stopped:dead?'killed':stopped,...(at?{at}:{}),...(collected?{collected}:{}),...(strayed?{strayed}:{})}
}

// Lab, 10 October: a blaze 18 blocks off set off the safety ladder, every shelter
// failed on open ground, and the bot burned to death with a bow and 55 arrows in
// hand. Melee declines what keeps its distance; a player shoots back. Asked only
// after the melee decision declines, so a zombie at arm's length is still a sword.
export function rangedDefenseDecision(bot,{healthFloor=10,foodFloor=6,minArrows=4,meleeClose=8}={}){
 const reject=reason=>({engage:false,reason})
 const s=survivalObservation(bot)
 if(s.gameMode!=='survival'||!['easy','normal','hard'].includes(s.difficulty))return reject('Combat requires observed hostile Survival difficulty')
 if(!Number.isFinite(s.health)||s.health<healthFloor||!Number.isFinite(s.food)||s.food<foodFloor)return reject('Health or food is too low to stand and shoot')
 if(!bot.inventory.items().some(i=>i.name==='bow'))return reject('No bow to answer a ranged threat')
 const arrows=bot.inventory.items().filter(i=>i.name==='arrow').reduce((n,i)=>n+i.count,0)
 if(arrows<minArrows)return reject(`Only ${arrows} arrows; ${minArrows} or more to stand and shoot`)
 if(!bot.entity?.onGround||bot.entity.isInWater||bot.entity.isInLava||bot.currentWindow)return reject('Not ready on stable ground with inventory closed')
 const threats=s.nearbyThreats.filter(t=>t.risk==='potential_hostile').sort((a,b)=>a.distance-b.distance)
 if(!threats.length)return reject('No hostile in sight to shoot')
 if(threats.some(t=>t.distance<=meleeClose&&!RANGED_DEFENSE.has(t.name)))return reject('A melee hostile is close; the bow waits')
 const height=bot.entity.eyeHeight??1.62,here=bot.entity.position.offset(0,height,0)
 // Blocked from here, the shot is judged from one step into a firing port as well,
 // the step the bow takes (lab run 146, 15 October).
 const steps=coveredSteps(bot,bot.entity.position.floored()).map(c=>c.offset(.5,height,.5))
 const judge=t=>{
  if(t.distance>SHOOT.radius)return `The ${t.name} is out of bow range`
  const target=nearestOfType(bot,t.name,t.position,1)
  if(!target)return 'Target identity is unavailable'
  const centre=aimPoint(target,bot.registry)
  const sight=observedSightline(bot,here,centre)
  const eye=sight.status==='blocked'?steps.find(e=>observedSightline(bot,e,centre).status!=='blocked'):here
  if(!eye)return `No clear shot at the ${t.name}: ${sight.block||'a block'} is in the way`
  if(aimPitch(eye,centre)===null)return `The ${t.name} is out of bow range`
  const blocker=lineOfFireBlocker(bot,eye,centre,target)
  if(blocker)return `A ${blocker.type==='player'?'player':blocker.name} is in the line of fire`
  return target
 }
 // Nearest first, passing over shooters the bot cannot hit (lab run 90: a blaze
 // behind the fortress wall at five blocks, another in the open at ten). A melee
 // hostile ends the search: it would arrive while the bot stands drawing.
 let first=null
 for(const t of threats){
  if(!RANGED_DEFENSE.has(t.name))return reject(first??`The nearest hostile, a ${t.name}, is not a ranged one`)
  const answer=judge(t)
  if(typeof answer!=='string')return {engage:true,ranged:true,target:{targetId:answer.id,targetName:answer.name}}
  first??=answer
 }
 return reject(first)
}

