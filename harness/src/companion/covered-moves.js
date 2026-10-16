// Covered moves: walled in on a Nether trip, the bot digs a shaft and bores toward the work
// without ever opening its cover. Family rehearsal, 16 October: walled in beside the arrival
// portal at the hub, with a pillager, three wither skeletons and a zombified piglin within 24
// blocks, the wait held "for daylight and a clear area", which never comes in the Nether. The
// model proposes one move at a time (planner.covered); the harness admits it or refuses it with
// a reason the next decision reads. Shaped like sheltered-planning.js: an independent protection
// loop owns the bot while the model thinks, and a late answer never dispatches after Stop.
import {setTimeout as delay} from 'node:timers/promises'
import {Vec3} from 'vec3'
import {COVERED_MOVES,COVERED_CELLS,COVERED_CALLS,BURN_MS,canResume,canContinueAfterSafety,continuationMark} from './continuity.js'
import {inspectEmergencyShelter} from '../shelter-occupants.js'
import {fullCube} from '../construction.js'
import {survivalObservation,fireObservation,FIRE_BLOCKS} from '../survival.js'
import {inNether,dimensionOf} from '../dimension.js'
import {onTrip,TRIP_HEALTH} from '../nether-trip.js'
import {refuseDigCell,validateDigGoal,LIQUID,GRAVITY,AIR,key} from '../primitives.js'
import {validateBoreGoal,borePath,columnCells,living,BORE_TIMEOUT_MS} from '../bore.js'
import {isNatural,NETHER_NATURAL,mayDig} from '../natural.js'
import {projectFootprints} from '../site-survey.js'
import {recoveryContext,recoveryState,recordRecovery} from './recovery-context.js'
import {SHOOTERS_ONLY,threatRadius} from '../survival.js'
import {bowCanAnswer} from '../archery.js'
import {portSightline} from '../burrow.js'
export const SHAFT_MAX=4
const SIDES=[[1,0],[-1,0],[0,1],[0,-1]]
const AROUND=[[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0],[0,-1,0]]
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
 if((request.coveredCalls||0)>=COVERED_CALLS)return `${COVERED_CALLS} covered decisions asked`
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
 const path=borePath(f,goal)
 if(!path.length)return {reason:`${key(goal)} is straight above or below; dig a shaft with dig`}
 // Live, 16 October: the family seed's Nether arrival is a fortress bridge of nether bricks the family rule
 // never digs, so the first column may be the bot's own hut wall as well as rock. Blaze death, 18:44Z: a bore
 // from that hut dug its wall into open floored air, the cavity joined the fortress ground and the shelter
 // failed open. Under cover a bore goes through rock only: the column beyond the wall is full cubes too.
 const cells=columnCells(f,path[0])
 for(const p of cells){
  const b=bot.blockAt(p)
  if(!b)return {reason:`${key(p)} is not loaded`}
  if(AIR.has(b.name))return {reason:`open ground at ${key(p)}; under cover I bore through rock only, so the cover stays shut`}
  if(!fullCube(bot.registry,b.name)||hot(b)||GRAVITY.has(b.name)||!mayDig(bot,b))return {reason:`${b.name} at ${key(p)} is neither natural rock nor my own block; on rock dig a shaft first, then bore from its foot`}
  for(const [dx,dy,dz] of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0]]){const q=p.offset(dx,dy,dz),n=bot.blockAt(q);if(!cells.some(o=>o.equals(q))&&hot(n))return {reason:`${n?.name??'unloaded ground'} beside the first column at ${key(q)}`}}
 }
 // Live rehearsal, 16 October 22:13Z: walking its own tunnel east along the fortress bridge, a hoglin on the roof
 // raised the alarm and the bot walled in at -64,61,-41, plugging the tunnel ahead; the bore on along its own sealed
 // tunnel was refused as open ground, done handed back into the same alarm, and it walled in again, never moving on.
 // The column beyond the wall may be a covered one as well as rock: air at feet and head, every skin cell a full cube
 // but the faces to the wall and to the next column (what bore would plug), nothing hot beside it, no mob in it.
 // hut.js coveredColumn reads one standing cell on either axis and gives null for a closed pocket, so the skin is read here.
 // A partly open column is still open ground.
 const beyond=path[1]?columnCells(path[0],path[1]).filter(q=>!cells.some(o=>o.equals(q))):[]
 const front=path[2]?columnCells(path[1],path[2]).filter(q=>q.x!==path[1].x||q.z!==path[1].z):[]
 const around=beyond.flatMap(p=>AROUND.map(d=>p.offset(...d))).filter(q=>!beyond.some(o=>o.equals(q)))
 const skin=around.filter(q=>![...cells,...front].some(o=>o.equals(q)))
 if(beyond.length&&beyond.every(p=>AIR.has(bot.blockAt(p)?.name))&&skin.every(q=>{const b=bot.blockAt(q);return !!b&&fullCube(bot.registry,b.name)})){
  const burn=around.find(q=>hot(bot.blockAt(q)));if(burn)return {reason:`${bot.blockAt(burn)?.name??'unloaded ground'} beside my tunnel at ${key(burn)}; under cover I bore through rock only`}
  const mob=Object.values(bot.entities||{}).find(e=>e!==bot.entity&&living(e)&&e?.position&&beyond.some(q=>q.equals(e.position.floored())))
  if(mob)return {reason:`${mob.name||mob.type||'an entity'} in ${key(mob.position.floored())} beyond the wall at ${key(cells.at(-1))}; under cover I bore on once it leaves my tunnel`}
 }else for(const p of beyond){const b=bot.blockAt(p);if(!b||!fullCube(bot.registry,b.name))return {reason:`open ground beyond the wall at ${key(cells.at(-1))} (${b?.name??'unloaded'} at ${key(p)}); under cover I bore through rock only. Done hands the bore to the planner, guarded by the alarm`}}
 return {command:{action:'bore',goal,timeoutMs:BORE_TIMEOUT_MS}}
}
// The request goes back to the planner from inside the cover, as the departed branch does, and
// the hut is never opened (unhut): its cavity stays shut behind the bot. The alarm guards what follows.
// A line said at most once a minute per key, so a cycle that repeats does not fill the chat.
export function sayEvery(c,key,text,ms=60000){const saidAt=c.saidAt??={},at=saidAt[key];if(at&&Date.now()-at<ms)return false;saidAt[key]=Date.now();c.say(text);return true}
export async function coveredHandBack(c,bot,receipt=null){
 const request=c.requestProgress,safety=c.safety
 ;(request.safetyContinuations??=[]).push({requestId:request.id,connectionId:c.runner.connectionId,shelter:'covered_route',covered:structuredClone(safety.covered||{from:safety.retreat.surface,at:xyz(feetOf(bot)),moves:[]}),...(receipt?{receipt}:{}),resumeSerial:request.resumeSerial||0,...continuationMark(request)})
 ;(request.feedback??=[]).push({action:'safety_continuation',status:'completed',result:request.safetyContinuations.at(-1)})
 c.safety=null;c.activity='';c.phase='blocked';c.persist()
 sayEvery(c,'covered_handback',receipt?.slit?.length?'The tunnel has a slit toward the target. Carrying on with the request from here.':'Carrying on with the request from here, under cover.')
 await c.resume({automatic:true});return {status:'handed_back'}
}
// A shooter in its alarm radius the bow answers and a port from where the bot stands would see.
export function atPort(bot){
 const feet=feetOf(bot)
 return Object.values(bot.entities||{}).find(e=>SHOOTERS_ONLY.has(e?.name)&&e.position&&e.position.distanceTo(bot.entity.position)<=threatRadius(e.name)&&bowCanAnswer(bot,e.name)&&portSightline(bot,feet,e).status==='clear')??null
}
const enclosureError=e=>/^Emergency shelter|^Shelter contains|liquid/i.test(e?.message||'')
export async function coveredMoves(c,epoch,signal,bot,{eligible=false,rounds=2*COVERED_MOVES,budgetMs=600000,decisionMs=30000,pollMs=100,waitMs=10000}={}){
 const gate=coveredGate(c,bot,eligible);if(gate)return {status:'skipped',reason:gate}
 const request=c.requestProgress,safety=c.safety,connection=c.runner.connectionId,deadline=Date.now()+budgetMs
 let health=bot.health,refusals=0,burntAt=-Infinity
 const check=()=>{if(signal.aborted||c.epoch!==epoch||c.safety!==safety||c.requestProgress!==request||!c.runner.ready||c.runner.bot!==bot||c.runner.connectionId!==connection)throw new Error('Covered moves cancelled or context changed')}
 // during: mid-move a fall leaves no floor for a moment, so the flood runs only on the ground there.
 const protection=(during=false)=>{
  check()
  // Review of 7d69c86, 16 October: a burn tick read as a breach failed the shelter and the retry shot
  // from the open. Burns are judged as the wait judges them (controller.js observe).
  if(fireObservation(bot).onFire===true)burntAt=Date.now()
  if(bot.health<health&&Date.now()-burntAt>BURN_MS)throw new Error('Health fell during a covered move')
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
   // Live, 18:43Z, 16 October: every bore under blazes was cancelled by the alarm within seconds, spending a model
   // call each time. A shooter the bow answers, in sight through a port the hut would open, is the port's (the
   // watch's firing-port branch): the phase holds without asking the model.
   const shooter=atPort(bot);if(shooter){const reason=`a ${shooter.name.replaceAll('_',' ')} is in sight through a port; the port answers it`;journal('held',{reason});return {status:'held',reason}}
   const before=decisionState(),sites=projectFootprints(c.projects,dimensionOf(bot)),f=feetOf(bot)
   let deepest=0,shaft=null;for(let n=1;n<=SHAFT_MAX;n++){const r=shaftRefusal(bot,n,sites);if(r){shaft=r;break}deepest=n}
   const snapshot=c.snapshot(),state=Object.fromEntries(['position','health','survival','tools','inventory'].map(k=>[k,snapshot[k]]))
   const observed={...state,goal:request.goal,pending:(request.pending||[]).slice(0,4),feedback:(request.feedback||[]).slice(-8),recovery:recoveryContext(c,bot),enclosure:safety.protection,
    feet:xyz(f),hut:safety.retreat.surface,shaftBelow:{deepest,refusal:shaft},lastReceipt:safety.covered?.moves?.at(-1)?.receipt??null,movesLeft:COVERED_MOVES-(request.coveredMoves||0),remainingMs:deadline-Date.now()}
   trace('covered_observation',{round,observation:observed})
   request.coveredCalls=(request.coveredCalls||0)+1;c.persist()
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
   // Alight, or the trip ended while the model thought: no move starts.
   const still=coveredGate(c,bot,eligible);if(still){journal('held',{reason:still,expectation:value.expectation});return {status:'held',reason:still}}
   const move=admit(c,bot,value,sites)
   if(move.reason){journal('rejected',{reason:move.reason,expectation:value.expectation});if(++refusals>=2)return {status:'held',reason:move.reason};continue}
   // Saved before the move runs: a restart mid-bore re-arms the wait with the route's own cavity limit.
   request.coveredMoves=(request.coveredMoves||0)+1;safety.covered??={from:structuredClone(safety.retreat.surface),at:xyz(feetOf(bot)),moves:[]};c.persist()
   const moveAbort=new AbortController(),moveSignal=AbortSignal.any([signal,moveAbort.signal]);let failure=null,receipt
   const monitor=setInterval(()=>{try{protection(true)}catch(e){failure??=e;moveAbort.abort();c.dispatch({action:'stop'})}},pollMs)
   let failed=null
   try{await c.execute(move.command,moveSignal);receipt=structuredClone(c.runner.task?.result??null)}
   catch(e){failed=e}
   finally{clearInterval(monitor);moveAbort.abort()}
   // Blaze death, 16 October 18:44Z: the bot's own move opened the cavity, the breach failed the shelter three
   // times and the bot stood idle in an opened hut. A breach a move makes is a refused move: stop, wall in again
   // where the bot stands, and tell the model. If walling in fails, that is a shelter failure as before.
   if(failure&&enclosureError(failure)){
    check();await c.execute({action:'hut',goal:{},timeoutMs:60000},signal);check()
    const closed=c.runner.task?.result?.surface;if(closed)safety.retreat={...safety.retreat,surface:structuredClone(closed)}
    health=bot.health;protection()
    const reason=`the move opened the cavity (${failure.message}); closed again where I stand`
    journal('rejected',{reason,expectation:value.expectation});if(++refusals>=2)return {status:'held',reason};continue
   }
   if(failure)throw failure
   if(failed){check();journal('failed',{reason:failed.message,expectation:value.expectation});if(++refusals>=2)return {status:'held',reason:failed.message};continue}
   // The last block dug may still be under a falling bot: land before the cavity is judged.
   for(let i=0;i<20&&!bot.entity.onGround;i++)await delay(50,undefined,{signal})
   protection();refusals=0
   safety.covered.at=xyz(feetOf(bot));safety.covered.moves.push({action:value.action,target:value.target,count:value.count,receipt});c.persist()
   journal('completed',{expectation:value.expectation,receipt})
   if(receipt?.slit?.length)return handBack(receipt)
  }
  journal('held',{reason:'Covered move budget exhausted'});return {status:'held'}
 }catch(e){
  if(signal.aborted||c.epoch!==epoch||c.safety!==safety||c.requestProgress!==request||!c.runner.ready||c.runner.bot!==bot||c.runner.connectionId!==connection)return {status:'cancelled'}
  // A breach of the enclosure propagates to the wait's recovery. Anything else (a provider error, health
  // falling, the trip's health line) hands the hut back to the watch, whose own rules then judge it.
  if(enclosureError(e))throw e
  safety.protection=inspectEmergencyShelter(bot,{limit:COVERED_CELLS});journal('failed',{reason:e.message});return {status:'held',reason:e.message}
 }
}
