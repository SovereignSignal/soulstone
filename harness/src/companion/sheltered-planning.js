import {setTimeout as delay} from 'node:timers/promises'
import {berryObservation} from '../foraging.js'
import {Vec3} from 'vec3'
import {SHELTERED_CALLS,MODEL_DECISION_MS} from './continuity.js'
import {inspectEmergencyShelter} from '../shelter-occupants.js'
import {survivalObservation,RANGED} from '../survival.js'
import {fullCube} from '../construction.js'
import {nearbyResources} from '../observations.js'
import {LOG_ITEMS} from '../resources.js'
import {recoveryContext,recoveryState,recordRecovery} from './recovery-context.js'
import {awaitClearance,openGroundClearance} from './hazard-clearance.js'

export function shelterDeparture(bot,retreat){
 const s=survivalObservation(bot),p=retreat?.surface
 const reject=reason=>({available:false,reason})
 if(!p||!['x','y','z'].every(k=>Number.isFinite(p[k])))return reject('Exit position unavailable')
 if(!(s.timeOfDay>=1000&&s.timeOfDay<12000)||!(s.health>=12)||!(s.food>6))return reject('Daylight, health or sprint reserve insufficient')
 const exit=new Vec3(p.x,p.y,p.z),foot=bot.blockAt(exit),head=bot.blockAt(exit.offset(0,1,0)),floor=bot.blockAt(exit.offset(0,-1,0))
 const passable=b=>b&&b.boundingBox==='empty'&&!['water','lava','bubble_column'].includes(b.name)
 if(retreat.shelterName==='burrow'&&(!passable(foot)||!passable(head)||!floor||!fullCube(bot.registry,floor.name)))return reject('Recorded surface exit is obstructed or unobserved')
 const threats=s.nearbyThreats.filter(t=>t.risk==='potential_hostile')
 for(const t of threats){
  if(!t.position)return reject('Threat position unavailable')
  if(Math.hypot(t.position.x-(p.x+.5),t.position.z-(p.z+.5))<(RANGED.has(t.name)?24:10))return reject('A threat is too close to the surface exit')
 }
 return {available:true,surface:p,threats,scope:'Observed surface landing and loaded threats; exit path and future pursuit remain unverified'}
}

// Deliberation is protected by an independent observation loop. The slow model
// never owns the safety watch, and a late response cannot dispatch after Stop.
export async function shelteredPlanning(c,epoch,signal,bot,{rounds=6,budgetMs=180000,decisionMs=MODEL_DECISION_MS,pollMs=100,waitMs=10000,quietMs=3000}={}){
 const request=c.requestProgress,safety=c.safety,connection=c.runner.connectionId,deadline=Date.now()+budgetMs
 let health=bot.health
 const check=()=>{if(signal.aborted||c.epoch!==epoch||c.safety!==safety||c.requestProgress!==request||!c.runner.ready||c.runner.bot!==bot||c.runner.connectionId!==connection)throw new Error('Sheltered planning cancelled or context changed')}
 const protection=()=>{check();safety.protection=inspectEmergencyShelter(bot);if(bot.health<health)throw new Error('Health fell during sheltered planning');health=bot.health}
 const decisionState=()=>{const d=shelterDeparture(bot,safety.retreat);return JSON.stringify({available:d.available,reason:d.reason,health:bot.health,food:bot.food,inventory:bot.inventory.items().map(i=>[i.name,i.count]).sort()})}
 const trace=(type,data)=>c.runner.log?.(type,data)
 const journal=(status,extra={})=>recordRecovery(c,{at:new Date().toISOString(),requestId:request.id,connectionId:connection,action:'sheltered_planning',status,after:recoveryState(bot),...extra})
 try{
  for(let round=0;round<rounds&&(request.shelteredCalls||0)<SHELTERED_CALLS&&Date.now()<deadline;round++){
   protection();const before=decisionState();request.shelteredCalls=(request.shelteredCalls||0)+1;c.persist()
   const snapshot=c.snapshot(),state=Object.fromEntries(['position','health','survival','footing','tools','inventory','places','ownerPosition','ownerVisible'].map(k=>[k,snapshot[k]]))
   const observed={...state,foraging:berryObservation(bot),recovery:recoveryContext(c,bot),goal:request.goal,feedback:(request.feedback||[]).slice(-8),protection:safety.protection,departure:shelterDeparture(bot,safety.retreat),nearby:nearbyResources(bot,[...LOG_ITEMS,'stone','crafting_table']),remainingMs:deadline-Date.now()}
   trace('sheltered_observation',{round,observation:observed})
   const abort=new AbortController(),combined=AbortSignal.any([signal,abort.signal]);let settled=false,value,error
   const pending=Promise.resolve().then(()=>{if(combined.aborted)throw new Error('Cancelled');return c.planner.sheltered(observed,combined,e=>trace('sheltered_model',e))}).then(v=>{value=v;settled=true},e=>{error=e;settled=true})
   try{
    const until=Math.min(deadline,Date.now()+decisionMs)
    while(!settled){protection();if(Date.now()>=until)throw new Error('Sheltered decision budget reached');await delay(pollMs,undefined,{signal})}
    await pending;protection();if(error)throw error
   }finally{abort.abort()}
   trace('sheltered_decision',{round,decision:value});safety.shelteredDecision=value;c.persist()
   if(value.action==='wait'){
    journal('held',{expectation:value.expectation})
    if(round+1>=rounds||(request.shelteredCalls||0)>=SHELTERED_CALLS)break
    // A clock tick or a moving mob that still blocks departure does not create
    // a new decision. Keep watching protection, saving model calls for changed
    // departure feasibility or resources. The original time budget still ends.
    const earliest=Date.now()+waitMs
    while(Date.now()<deadline){
     protection();if(Date.now()>=earliest&&decisionState()!==before)break
     await delay(pollMs,undefined,{signal})
    }
    continue
   }
   protection();const fresh=shelterDeparture(bot,safety.retreat)
   if(!fresh.available){journal('rejected',{reason:fresh.reason,expectation:value.expectation});continue}
   const prepared={requestId:request.id,connectionId:connection,createdAt:Date.now(),plan:value.plan}
   // Execution is bounded and rechecks health. Once the enclosure is opened,
   // proximity is handled by the existing escape executor, not another model.
   const actionAbort=new AbortController(),actionSignal=AbortSignal.any([signal,actionAbort.signal]);let failure=null
   const monitor=setInterval(()=>{try{check();if(bot.health<health||bot.entity.isInWater||bot.entity.isInLava)throw new Error('Departure lost health or entered liquid')}catch(e){failure=e;actionAbort.abort();c.dispatch({action:'stop'})}},pollMs)
   try{
    await c.execute(safety.retreat.shelterName==='hut'?{action:'unhut',goal:{},timeoutMs:30000}:{action:'unburrow',goal:{surface:fresh.surface},timeoutMs:30000},actionSignal);check()
    safety.exit=structuredClone(c.runner.task.result)
    const threat=survivalObservation(bot).nearbyThreats.find(t=>t.risk==='potential_hostile')
    if(threat)await c.execute({action:'flee',goal:{from:threat.position,distance:24},timeoutMs:20000},actionSignal)
    check();if(failure)throw failure
    const clearance=await awaitClearance({check:()=>{check();if(failure)throw failure},observe:()=>openGroundClearance(bot),quietMs,limitMs:quietMs+1000,pollMs,stopOnUnsafe:true})
    if(clearance.status!=='cleared')throw new Error(clearance.reason)
    journal('completed',{expectation:value.expectation,clearance});return {status:'departed',prepared,clearance}
   }catch(e){check();journal('failed',{expectation:value.expectation,reason:e.message});return {status:'unsafe',reason:e.message}}
   finally{clearInterval(monitor);actionAbort.abort()}
  }
  journal('held',{reason:'Sheltered planning budget exhausted'});return {status:'held'}
 }catch(e){
  if(signal.aborted||c.epoch!==epoch||c.safety!==safety||c.requestProgress!==request||!c.runner.ready||c.runner.bot!==bot||c.runner.connectionId!==connection)return {status:'cancelled'}
  // A provider error can fall back to the established shelter watch only if
  // the enclosure still passes. A breach propagates to its existing recovery.
  protection();journal('failed',{reason:e.message});return {status:'held'}
 }
}
