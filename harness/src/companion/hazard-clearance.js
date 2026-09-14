import {setTimeout as delay} from 'node:timers/promises'
import {survivalObservation,isPotentialHostile} from '../survival.js'
import {shelteredObservation} from '../retreat.js'
import {occupiedAlternative,inspectConstructionShelter} from '../alternate-shelter.js'
import {shelterLayout} from '../shelter.js'

export {THREAT_INTERRUPTION} from '../survival.js'
const corridorPoint=(origin,layout,depth)=>({x:origin.x+layout.door.x+0.5+layout.out.x*depth,y:origin.y+layout.door.y+0.5,z:origin.z+layout.door.z+0.5+layout.out.z*depth})
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)
const corridorDistance=(p,a,b)=>{
 const dx=b.x-a.x,dz=b.z-a.z,len2=dx*dx+dz*dz
 const t=len2?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/len2)):0
 const x=a.x+t*dx,z=a.z+t*dz
 return {lateral:Math.hypot(p.x-x,p.z-z),along:t*Math.sqrt(len2)}
}
export function departureThreatObservation(bot,projects,shelterName='base',{depth=3,radius=2.5}={}){
 const p=bot?.entity?.position
 const entities=Object.values(bot?.entities||{}).filter(e=>e!==bot?.entity&&(isPotentialHostile(e.name)||e?.name==='enderman'||e?.name==='piglin'||e?.name==='zombified_piglin'||e?.name==='wolf'||e?.name==='bee'||e?.name==='polar_bear'||e?.name==='iron_golem'))
 let start,end
 try{
  if(shelterName&&shelterName!=='base'){
   // A fallback shelter is {name, construction}; it has no `build`, so reading
   // one here left the corridor permanently unavailable and every loaded mob
   // marked as blocking, at any distance. Derive it from the shelter itself.
   const shelter=occupiedAlternative(bot,projects)
   if(!shelter)throw new Error('Not inside the named fallback shelter')
   const inspected=inspectConstructionShelter(bot,shelter,{occupants:false})
   const door=inspected.door.position,out=inspected.outside
   start={x:door.x+0.5,y:door.y+0.5,z:door.z+0.5}
   const dx=Math.sign(out.x-door.x),dz=Math.sign(out.z-door.z)
   end={x:start.x+dx*depth,y:start.y,z:start.z+dz*depth}
  }else{
   const build=projects?.base?.build
   if(!build)throw new Error('No saved shelter project')
   const layout=shelterLayout(build.design),origin=build.origin
   start={x:origin.x+layout.door.x+0.5,y:origin.y+layout.door.y+0.5,z:origin.z+layout.door.z+0.5}
   end=corridorPoint(origin,layout,depth)
  }
 }catch{
  // Without a corridor only what is actually near the bot can block departure.
  return {blocking:entities.filter(e=>!e.position||!p||distance(e.position,p)<=24).map(e=>({name:e.name,reason:'departure corridor is unavailable'})),peripheral:[]}
 }
 const blocking=[],peripheral=[]
 for(const e of entities){
  if(!e.position){blocking.push({name:e.name,reason:'entity position is unknown'});continue}
  const distanceFromBot=p?distance(e.position,p):Infinity
  if(distanceFromBot>24)continue
  const d=corridorDistance(e.position,start,end),near=d.along>=-1&&d.along<=depth+2&&d.lateral<=radius&&Math.abs(e.position.y-start.y)<=3
  const item={name:e.name,distance:Math.round(distanceFromBot*10)/10,position:{x:e.position.x,y:e.position.y,z:e.position.z},corridor:near?'departure':'peripheral'}
  ;(near?blocking:peripheral).push(item)
 }
 return {blocking,peripheral}
}
export function clearanceObservation(bot,projects,shelterName){
 const s=survivalObservation(bot),p=bot?.entity?.position
 if(!p||s.gameMode!=='survival'||!['easy','normal','hard'].includes(s.difficulty))return {clear:false,reason:'Survival difficulty is unavailable or changed'}
 if(s.health!==20||s.food===null||s.food<14)return {clear:false,reason:'Health or food is not ready'}
 for(let x=Math.floor((p.x-24)/16);x<=Math.floor((p.x+24)/16);x++)for(let z=Math.floor((p.z-24)/16);z<=Math.floor((p.z+24)/16);z++){
  const column=bot.world?.getColumn?.(x,z)
  if(!column||typeof column.then==='function')return {clear:false,reason:'Nearby chunks are not fully observed'}
 }
 const threats=departureThreatObservation(bot,projects,shelterName)
 if(threats.blocking.length)return {clear:false,reason:'A potential threat remains on or near the departure corridor',blockingThreats:threats.blocking,peripheralThreats:threats.peripheral}
 const sheltered=shelterName&&shelterName!=='base'?occupiedAlternative(bot,projects)?.name===shelterName:shelteredObservation(bot,projects.base).passed
 if(!sheltered)return {clear:false,reason:'Closed lit shelter is no longer verified'}
 return {clear:true,health:s.health,food:s.food,peripheralThreats:threats.peripheral,scope:'Loaded chunks and classified entities within 24 blocks; departure corridor checked for the first three approach blocks; not proof of a safe destination route'}
}
// After a daylight flight from a lone mob the bot could not strike: clear when
// it is still day and no potential hostile has followed within 16 blocks.
export function openGroundClearance(bot){
 const s=survivalObservation(bot)
 if(!(s.timeOfDay>=1000&&s.timeOfDay<12000))return {clear:false,reason:'Daylight is ending'}
 if(!(s.health>=12))return {clear:false,reason:'Health is too low for open ground'}
 const near=(s.nearbyThreats||[]).filter(t=>t.risk==='potential_hostile'&&t.distance<=16)
 if(near.length)return {clear:false,reason:'A potential hostile followed within 16 blocks',threats:near}
 return {clear:true,health:s.health,timeOfDay:s.timeOfDay,scope:'Loaded entities within 16 blocks and the world clock; open ground, not a shelter'}
}
// The observation window bounds how long we will wait for a situation that can
// change. Time in which nothing could possibly change is not part of that: a bot
// that digs in at dusk spends ten real minutes waiting for a dawn that is simply
// coming, and charging that to the window left twenty-eight seconds for the
// judgement that needed four minutes. An observation marked holding stops the
// clock without stopping the watch.
export async function awaitClearance({check,observe,maintain,onUpdate=()=>{},quietMs=20000,limitMs=90000,pollMs=500}){
 const startedAt=Date.now();let clearSince=null,lastReason=null,held=0,since=Date.now()
 const elapsed=()=>Date.now()-startedAt-held
 while(elapsed()<limitMs){
  check();if(maintain){if(await maintain())clearSince=null;check();if(Date.now()-startedAt>=limitMs)break}
  const observation=observe();check()
  const now=Date.now();if(observation.holding)held+=now-since;since=now
  if(observation.clear){clearSince??=Date.now();if(Date.now()-clearSince>=quietMs)return {status:'cleared',startedAt,clearedAt:Date.now(),quietMs,observation}}
  else clearSince=null
  const reason=observation.clear?'Watching clear area':observation.reason
  if(reason!==lastReason){onUpdate({status:'watching',reason,startedAt,clearSince});lastReason=reason}
  await delay(Math.min(pollMs,Math.max(1,limitMs-elapsed())))
 }
 check();return {status:'paused',code:'clearance_timeout',reason:'Clearance was not established within the observation window',startedAt,endedAt:Date.now(),...(held?{heldMs:Math.round(held)}:{})}
}
