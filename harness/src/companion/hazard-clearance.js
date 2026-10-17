import {setTimeout as delay} from 'node:timers/promises'
import {survivalObservation,threatRadius} from '../survival.js'
import {shelteredObservation,pressingThreats} from '../retreat.js'
import {occupiedAlternative} from '../alternate-shelter.js'
import {stillCreeper} from '../still-creeper.js'

export {THREAT_INTERRUPTION} from '../survival.js'
import {departureThreatObservation} from '../shelter-departure.js'
export {departureThreatObservation} from '../shelter-departure.js'
export function clearanceObservation(bot,projects,shelterName){
 const s=survivalObservation(bot),p=bot?.entity?.position
 if(!p||s.gameMode!=='survival'||!['easy','normal','hard'].includes(s.difficulty))return {clear:false,reason:'Survival difficulty is unavailable or changed'}
 // Readiness is worth waiting for only where waiting brings it: food in the bag, or
 // hunger high enough to regenerate (as burrowClearance). Hurt and hungry with
 // nothing to eat, nothing inside raises either (pi2, 10 October: 1 health, hunger
 // 10, every dawn watch timed out), so the way out is food, and that waits for
 // working daylight (day-routine's 1000 to 10000) rather than for full health.
 const canHeal=(s.carriedFood||[]).length>0||Number.isFinite(s.food)&&s.food>=18
 const ready=s.health===20&&Number.isFinite(s.food)&&s.food>=14
 if(!ready&&(s.food===null||canHeal))return {clear:false,reason:'Health or food is not ready'}
 if(!ready&&!(Number.isFinite(s.timeOfDay)&&s.timeOfDay>=1000&&s.timeOfDay<10000))return {clear:false,reason:'Hurt or hungry with no food: going out for food waits for working daylight'}
 for(let x=Math.floor((p.x-24)/16);x<=Math.floor((p.x+24)/16);x++)for(let z=Math.floor((p.z-24)/16);z<=Math.floor((p.z+24)/16);z++){
  const column=bot.world?.getColumn?.(x,z)
  if(!column||typeof column.then==='function')return {clear:false,reason:'Nearby chunks are not fully observed'}
 }
 const threats=departureThreatObservation(bot,projects,shelterName)
 if(threats.blocking.length)return {clear:false,reason:'A potential threat remains on or near the departure corridor',blockingThreats:threats.blocking,peripheralThreats:threats.peripheral}
 // Leaving with a hostile already inside its interruption radius walks straight
 // back into the rule: out for ten seconds, in again, all morning.
 // Judged by reach from the doorstep, as the door and the base hold judge it (pressingOutside): family
 // rehearsal, 16 October, a sealed cave under the base held this watch while the door would have opened.
 const near=(s.nearbyThreats||[]).filter(t=>t.risk==='potential_hostile'&&t.distance<=threatRadius(t.name))
 // A flood that cannot be judged counts every one of them, as before.
 const released=[],pressing=(()=>{try{return !shelterName||shelterName==='base'?pressingThreats(bot,projects?.base,near,released):near.filter(t=>!stillCreeper(bot,t))}catch{released.length=0;return near}})()
 if(pressing.length)return {clear:false,reason:'A potential hostile is inside its interruption radius of the shelter',threats:pressing,peripheralThreats:threats.peripheral}
 const sheltered=shelterName&&shelterName!=='base'?occupiedAlternative(bot,projects)?.name===shelterName:shelteredObservation(bot,projects.base).passed
 if(!sheltered)return {clear:false,reason:'Closed lit shelter is no longer verified'}
 return {clear:true,health:s.health,food:s.food,...(released.length?{sealed:released}:{}),peripheralThreats:threats.peripheral,scope:'Loaded chunks and classified entities within 24 blocks; departure corridor checked for the first three approach blocks; not proof of a safe destination route'}
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
export async function awaitClearance({check,observe,maintain,onUpdate=()=>{},quietMs=20000,limitMs=90000,pollMs=500,stopOnUnsafe=false}){
 const startedAt=Date.now();let clearSince=null,lastReason=null,held=0,since=Date.now()
 const elapsed=()=>Date.now()-startedAt-held
 while(elapsed()<limitMs){
  check();if(maintain){if(await maintain())clearSince=null;check();if(Date.now()-startedAt>=limitMs)break}
  const observation=observe();check()
  if(stopOnUnsafe&&!observation.clear)return {status:'paused',code:'clearance_lost',reason:observation.reason,observation,startedAt,endedAt:Date.now()}
  const now=Date.now();if(observation.holding)held+=now-since;since=now
  if(observation.clear){clearSince??=Date.now();if(Date.now()-clearSince>=quietMs)return {status:'cleared',startedAt,clearedAt:Date.now(),quietMs,observation}}
  else clearSince=null
  const reason=observation.clear?'Watching clear area':observation.reason
  if(reason!==lastReason){onUpdate({status:'watching',reason,startedAt,clearSince});lastReason=reason}
  await delay(Math.min(pollMs,Math.max(1,limitMs-elapsed())))
 }
 check();return {status:'paused',code:'clearance_timeout',reason:'Clearance was not established within the observation window',startedAt,endedAt:Date.now(),...(held?{heldMs:Math.round(held)}:{})}
}
