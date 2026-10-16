// Covered moves: walled in on a Nether trip, the bot digs a shaft and bores toward the work
// without ever opening its cover. Family rehearsal, 16 October: walled in beside the arrival
// portal at the hub, with a pillager, three wither skeletons and a zombified piglin within 24
// blocks, the wait held "for daylight and a clear area", which never comes in the Nether. The
// model proposes one move at a time (planner.covered); the harness admits it or refuses it with
// a reason the next decision reads. Shaped like sheltered-planning.js: an independent protection
// loop owns the bot while the model thinks, and a late answer never dispatches after Stop.
import {setTimeout as delay} from 'node:timers/promises'
import {Vec3} from 'vec3'
import {COVERED_MOVES,COVERED_CELLS,canResume,canContinueAfterSafety,continuationMark} from './continuity.js'
import {inspectEmergencyShelter} from '../shelter-occupants.js'
import {fullCube} from '../construction.js'
import {survivalObservation,fireObservation,FIRE_BLOCKS} from '../survival.js'
import {inNether,dimensionOf} from '../dimension.js'
import {onTrip,TRIP_HEALTH} from '../nether-trip.js'
import {refuseDigCell,validateDigGoal,LIQUID,GRAVITY,key} from '../primitives.js'
import {validateBoreGoal,borePath,columnCells,BORE_TIMEOUT_MS} from '../bore.js'
import {isNatural,NETHER_NATURAL} from '../natural.js'
import {projectFootprints} from '../site-survey.js'
import {recoveryContext,recoveryState,recordRecovery} from './recovery-context.js'
export const SHAFT_MAX=4
const SIDES=[[1,0],[-1,0],[0,1],[0,-1]]
const xyz=p=>({x:p.x,y:p.y,z:p.z})
const hot=b=>!b||LIQUID.has(b.name)||FIRE_BLOCKS.has(b.name)||b.name==='magma_block'
// Natural rock only: a covered move never breaks a block a player placed, nor its own hut walls.
const rock=(bot,b)=>!!b&&fullCube(bot.registry,b.name)&&!hot(b)&&!GRAVITY.has(b.name)&&(isNatural(b.name)||inNether(bot)&&NETHER_NATURAL.has(b.name))
const feetOf=bot=>{const p=bot.entity.position;return new Vec3(Math.floor(p.x),Math.floor(p.y+.2),Math.floor(p.z))}
// Why the phase does not run, or null.
export function coveredGate(c,bot,eligible){
 const request=c.requestProgress,safety=c.safety
 if(!inNether(bot))return 'not in the Nether'
 if(!onTrip(bot,canResume(request)))return 'not on a trip'
 if(!['hut','burrow'].includes(safety?.retreat?.shelterName)||!safety.retreat.surface)return 'not walled in'
 if(safety.exit||safety.port)return 'the shelter is open'
 if((request.coveredMoves||0)>=COVERED_MOVES)return `${COVERED_MOVES} covered moves made`
 // Handing back is a safety continuation: it shares the episode cap, so done never loops.
 if(!(eligible||safety.resumeRequested)||!(safety.resumeRequested||canContinueAfterSafety(request,undefined,{protectedPlanning:true})))return 'the request is not due to continue'
 if(fireObservation(bot).onFire===true)return 'on fire'
 return null
}
// The whole column before anything opens: rock to dig, rock on all four sides, rock under the foot.
export function shaftRefusal(bot,count,sites=[]){
 if(!Number.isInteger(count)||count<1||count>SHAFT_MAX)return `dig count must be 1–${SHAFT_MAX}, straight down`
 const f=feetOf(bot)
 for(let i=1;i<=count;i++){
  const cell=f.offset(0,-i,0),b=bot.blockAt(cell)
  if(!b)return `${key(cell)} is not loaded`
  if(!rock(bot,b))return `${b.name} at ${key(cell)} is not natural rock to dig`
  const why=refuseDigCell(bot,cell,{protectedSites:sites,role:'head'});if(why)return why
  for(const [dx,dz] of SIDES){const q=cell.offset(dx,0,dz),s=bot.blockAt(q);if(!s||!fullCube(bot.registry,s.name)||hot(s))return `${s?.name??'unloaded ground'} beside the shaft at ${key(q)}; a covered shaft needs rock on all four sides`}
 }
 const foot=f.offset(0,-count-1,0),u=bot.blockAt(foot)
 if(!u||!fullCube(bot.registry,u.name)||hot(u))return `${u?.name??'unloaded ground'} under the shaft foot at ${key(foot)}`
 return null
}
// A move the harness lets through, as a command, or the reason it does not.
function admit(c,bot,v,sites){
 const f=feetOf(bot)
 if(v.action==='dig'){
  if(!Number.isInteger(v.count)||v.count<1||v.count>SHAFT_MAX)return {reason:`dig count must be 1–${SHAFT_MAX}, straight down`}
  if(v.target.x!==f.x||v.target.z!==f.z||v.target.y!==f.y-v.count)return {reason:`dig goes straight down from the feet: for count ${v.count} the target is ${key({x:f.x,y:f.y-v.count,z:f.z})}`}
  const why=shaftRefusal(bot,v.count,sites);if(why)return {reason:why}
  return {command:{action:'dig',goal:validateDigGoal({...v.target,count:v.count,protectedSites:sites}),timeoutMs:120000}}
 }
 let goal;try{goal=validateBoreGoal({...v.target,count:v.count,protectedSites:sites})}catch(error){return {reason:error.message}}
 // From the hut's own level the first column is the hut wall: the shaft comes first.
 if(f.y>=c.safety.retreat.surface.y)return {reason:'shaft first: bore only from the foot of a shaft, so the hut walls stay shut'}
 const path=borePath(f,goal)
 if(!path.length)return {reason:`${key(goal)} is straight above or below; dig a shaft with dig`}
 for(const p of columnCells(f,path[0])){const b=bot.blockAt(p);if(!rock(bot,b))return {reason:`${b?.name??'unloaded ground'} at ${key(p)} is not natural rock; shaft first, then bore from rock`}}
 return {command:{action:'bore',goal,timeoutMs:BORE_TIMEOUT_MS}}
}
// The request goes back to the planner from inside the cover, as the departed branch does, and
// the hut is never opened (unhut): its cavity stays shut behind the bot. The alarm guards what follows.
export async function coveredHandBack(c,bot,receipt=null){
 const request=c.requestProgress,safety=c.safety
 ;(request.safetyContinuations??=[]).push({requestId:request.id,connectionId:c.runner.connectionId,shelter:'covered_route',covered:structuredClone(safety.covered||{from:safety.retreat.surface,at:xyz(feetOf(bot)),moves:[]}),...(receipt?{receipt}:{}),resumeSerial:request.resumeSerial||0,...continuationMark(request)})
 ;(request.feedback??=[]).push({action:'safety_continuation',status:'completed',result:request.safetyContinuations.at(-1)})
 c.safety=null;c.activity='';c.phase='blocked';c.persist()
 c.say(receipt?.slit?.length?'The tunnel has a slit toward the target. Carrying on with the request from here.':'Carrying on with the request from here, under cover.')
 await c.resume({automatic:true});return {status:'handed_back'}
}
export async function coveredMoves(c,epoch,signal,bot,{eligible=false,rounds=2*COVERED_MOVES,budgetMs=600000,decisionMs=30000,pollMs=100,waitMs=10000}={}){
 const gate=coveredGate(c,bot,eligible);if(gate)return {status:'skipped',reason:gate}
 const request=c.requestProgress,safety=c.safety,connection=c.runner.connectionId,deadline=Date.now()+budgetMs
 let health=bot.health,refusals=0
 const check=()=>{if(signal.aborted||c.epoch!==epoch||c.safety!==safety||c.requestProgress!==request||!c.runner.ready||c.runner.bot!==bot||c.runner.connectionId!==connection)throw new Error('Covered moves cancelled or context changed')}
 // during: mid-move a fall leaves no floor for a moment, so the flood runs only on the ground there.
 const protection=(during=false)=>{
  check()
  if(bot.health<health)throw new Error('Health fell during a covered move')
  if(bot.health<TRIP_HEALTH)throw new Error(`Health ${bot.health} is under the trip's ${TRIP_HEALTH}`)
  if(bot.entity.isInWater||bot.entity.isInLava)throw new Error('Entered liquid during a covered move')
  if(!during||bot.entity.onGround)safety.protection=inspectEmergencyShelter(bot,{limit:COVERED_CELLS})
  health=bot.health
 }
 const decisionState=()=>JSON.stringify({health:bot.health,food:bot.food,threats:survivalObservation(bot).nearbyThreats.map(t=>[t.name,Math.round(t.distance/4)]).sort()})
 const trace=(type,data)=>c.runner.log?.(type,data)
 const journal=(status,extra={})=>recordRecovery(c,{at:new Date().toISOString(),requestId:request.id,connectionId:connection,action:'covered_move',status,after:recoveryState(bot),...extra})
 const handBack=receipt=>coveredHandBack(c,bot,receipt)
 try{
  for(let round=0;round<rounds&&Date.now()<deadline;round++){
   protection()
   const why=coveredGate(c,bot,eligible);if(why){journal('held',{reason:why});return {status:'held',reason:why}}
   const before=decisionState(),sites=projectFootprints(c.projects,dimensionOf(bot)),f=feetOf(bot)
   let deepest=0,shaft=null;for(let n=1;n<=SHAFT_MAX;n++){const r=shaftRefusal(bot,n,sites);if(r){shaft=r;break}deepest=n}
   const snapshot=c.snapshot(),state=Object.fromEntries(['position','health','survival','tools','inventory'].map(k=>[k,snapshot[k]]))
   const observed={...state,goal:request.goal,pending:(request.pending||[]).slice(0,4),feedback:(request.feedback||[]).slice(-8),recovery:recoveryContext(c,bot),enclosure:safety.protection,
    feet:xyz(f),hut:safety.retreat.surface,shaftBelow:{deepest,refusal:shaft},lastReceipt:safety.covered?.moves?.at(-1)?.receipt??null,movesLeft:COVERED_MOVES-(request.coveredMoves||0),remainingMs:deadline-Date.now()}
   trace('covered_observation',{round,observation:observed})
   const abort=new AbortController(),combined=AbortSignal.any([signal,abort.signal]);let settled=false,value,error
   const pending=Promise.resolve().then(()=>{if(combined.aborted)throw new Error('Cancelled');return c.planner.covered(observed,combined,e=>trace('covered_model',e))}).then(v=>{value=v;settled=true},e=>{error=e;settled=true})
   try{
    const until=Math.min(deadline,Date.now()+decisionMs)
    while(!settled){protection();if(Date.now()>=until)throw new Error('Covered decision budget reached');await delay(pollMs,undefined,{signal})}
    await pending;protection();if(error)throw error
   }finally{abort.abort()}
   trace('covered_decision',{round,decision:value})
   if(value.action==='done'){journal('completed',{expectation:value.expectation});return handBack(null)}
   if(value.action==='wait'){
    journal('held',{expectation:value.expectation})
    const earliest=Date.now()+waitMs
    while(Date.now()<deadline){protection();if(Date.now()>=earliest&&decisionState()!==before)break;await delay(pollMs,undefined,{signal})}
    continue
   }
   const move=admit(c,bot,value,sites)
   if(move.reason){journal('rejected',{reason:move.reason,expectation:value.expectation});if(++refusals>=2)return {status:'held',reason:move.reason};continue}
   request.coveredMoves=(request.coveredMoves||0)+1;c.persist()
   const moveAbort=new AbortController(),moveSignal=AbortSignal.any([signal,moveAbort.signal]);let failure=null,receipt
   const monitor=setInterval(()=>{try{protection(true)}catch(e){failure??=e;moveAbort.abort();c.dispatch({action:'stop'})}},pollMs)
   try{await c.execute(move.command,moveSignal);receipt=structuredClone(c.runner.task?.result??null)}
   catch(e){if(failure)throw failure;check();journal('failed',{reason:e.message,expectation:value.expectation});if(++refusals>=2)return {status:'held',reason:e.message};continue}
   finally{clearInterval(monitor);moveAbort.abort()}
   if(failure)throw failure
   // The last block dug may still be under a falling bot: land before the cavity is judged.
   for(let i=0;i<20&&!bot.entity.onGround;i++)await delay(50,undefined,{signal})
   protection();refusals=0
   safety.covered??={from:structuredClone(safety.retreat.surface),moves:[]}
   safety.covered.at=xyz(feetOf(bot));safety.covered.moves.push({action:value.action,target:value.target,count:value.count,receipt});c.persist()
   journal('completed',{expectation:value.expectation,receipt})
   if(receipt?.slit?.length)return handBack(receipt)
  }
  journal('held',{reason:'Covered move budget exhausted'});return {status:'held'}
 }catch(e){
  if(signal.aborted||c.epoch!==epoch||c.safety!==safety||c.requestProgress!==request||!c.runner.ready||c.runner.bot!==bot||c.runner.connectionId!==connection)return {status:'cancelled'}
  // A provider error falls back to the watch only while the enclosure still passes; a breach propagates.
  protection();journal('failed',{reason:e.message});return {status:'held'}
 }
}
