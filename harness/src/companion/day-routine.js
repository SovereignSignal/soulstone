import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {clearanceObservation} from './hazard-clearance.js'
import {shelteredObservation} from '../retreat.js'
import {SAFE_FOODS} from '../survival.js'

export const MORNING_START=1000, WORK_CUTOFF=10000
export const RECOVERY_LIMIT_MS=300000, RECOVERY_WORK_MARGIN=2400
export function daytimeWork(time){return Number.isFinite(time)&&time>=MORNING_START&&time<WORK_CUTOFF}
export function extendedRecoveryEligible(snapshot,job,record){
 const request=snapshot.requestProgress,safety=snapshot.safety
 return !!job&&request?.id===job.requestId&&request.status==='interrupted'&&!request.reviewRequired&&!request.safetyContinuations?.length&&safety?.status==='sheltered'&&safety.continuation?.code==='clearance_timeout'&&!safety.retreat?.shelterName&&(record.recoveryWaits||[]).every(w=>w.requestId!==job.requestId)
}
export function morningGoal(snapshot,wood='spruce_log'){
 const inventory=snapshot.inventory,planks=wood.replace('_log','_planks')
 const logs=32,boards=Math.min(128,(inventory[planks]||0)+8)
 return {logs,boards,wood,planks,text:`Do a short morning resupply trip. Craft ${planks} until carrying at least ${boards}, then gather ${wood} until carrying at least ${logs}. Harvest renewable sweet berries if carrying fewer than 32; leave bushes intact. Eat carried ordinary food if hungry. Prepare one serviceable stone axe if none has at least half durability and 32 uses. Return inside the verified lit primary base and close its door. Work from stable solid ground, never craft while standing on leaves or temporary tree support. Preserve existing buildings, all diamonds, other tools and base chest contents. Do not mine underground, seek combat or start another project.`}
}
export function morningOutcome(snapshot,target){
 return snapshot.inventory[target.wood]>=target.logs&&snapshot.inventory[target.planks]>=target.boards&&snapshot.inventory.sweet_berries>=32&&snapshot.survival.food>=18&&snapshot.tools.some(t=>t.name==='stone_axe'&&t.remaining>=Math.max(32,Math.ceil(t.maximum/2)))
}
export class DayRoutine {
 constructor(teammate,path){
  this.teammate=teammate;this.runner=teammate.runner;this.path=path;this.active=false
  try{this.record=JSON.parse(readFileSync(path,'utf8'));if(this.record.status==='running'){this.record.status='paused';this.record.reason='Service restarted; start a new session explicitly';this.save()}}catch(e){if(e.code!=='ENOENT')throw e}
  this.runner.on('operator_command',c=>{if(!this.teammate.dispatching&&c.action!=='status')this.stop('Player command took control')})
 }
 save(){mkdirSync(dirname(this.path),{recursive:true});writeFileSync(this.path+'.tmp',JSON.stringify(this.record,null,2),{mode:0o600});renameSync(this.path+'.tmp',this.path)}
 snapshot(){return this.record||null}
 update(mode,reason){if(this.record.mode!==mode||this.record.reason!==reason){Object.assign(this.record,{mode,reason});this.save()}}
 start(days=2){
  if(this.active)throw new Error('A survival session is already active')
  if(!Number.isInteger(days)||days<1||days>3)throw new Error('Choose one to three day/night cycles')
  const s=this.teammate.snapshot(),b=this.runner.bot
  if(!s.connected||s.phase!=='ready'||s.safety||s.survival.gameMode!=='survival'||s.survival.difficulty!=='easy'||s.health!==20||s.survival.food<14)throw new Error('Start ready and healthy in Survival on Easy with no pending safety recovery')
  if(!shelteredObservation(b,this.teammate.projects.base).passed||!Number.isFinite(b.time?.age)||!Number.isFinite(b.time?.time)||b.time.doDaylightCycle!==true)throw new Error('Start inside a verified closed lit base with natural daylight running')
  const wood=this.teammate.projects.base.build.wood
  if(!/^(spruce|oak|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/.test(wood))throw new Error('This routine needs an established overworld wood supply')
  const id=randomUUID();this.record={id,status:'running',mode:'waiting',reason:'Observing the morning',days,startedAt:Date.now(),startAge:b.time.age,startTime:b.time.time,connectionId:s.connectionId,wood,jobs:[],actions:[],before:{inventory:s.inventory,tools:s.tools},completedCycles:0}
  this.active=true;this.abort=new AbortController();this.save();this.promise=this.run().catch(e=>{if(this.active)this.fail(e.message)})
  return this.snapshot()
 }
 stop(reason='Operator stopped the survival session'){
  if(!this.active)return
  this.active=false;this.abort.abort();this.record.status='paused';this.record.reason=reason;this.record.endedAt=Date.now();this.save()
 }
 fail(reason){this.stop(reason);this.record.status='blocked';this.teammate.interrupt('Survival session paused: '+reason);this.teammate.dispatch({action:'stop'});this.teammate.say('Survival session paused: '+reason);this.save()}
 async action(action,goal){
  this.update(action,action==='eat'?'Eating carried food':'Returning to the closed lit base')
  await this.teammate.execute({action,goal,timeoutMs:60000},this.abort.signal)
  if(!this.active)return
  this.record.actions.push({at:Date.now(),action,result:structuredClone(this.runner.task.result)});this.save()
 }
 async extendRecovery(job){
  const b=this.runner.bot,r=this.record,requestId=job.requestId
  const wait={requestId,startedAt:Date.now(),status:'watching',previousWatch:structuredClone(this.teammate.safety.continuation)}
  ;(r.recoveryWaits??=[]).push(wait);this.save()
  this.teammate.safety.continuation={status:'watching',reason:'Extended survival-session observation',startedAt:wait.startedAt};this.teammate.persist()
  this.teammate.say('I am staying in shelter and watching longer. I will only continue if the area clears with enough daylight left.')
  const check=()=>{
   const s=this.teammate.snapshot(),time=b.time.timeOfDay
   if(!this.active||this.abort.signal.aborted||s.requestProgress?.id!==requestId)throw new Error('Survival recovery cancelled')
   if(s.health<=12||s.survival.gameMode!=='survival'||s.survival.difficulty!=='easy'||b.time.doDaylightCycle!==true)throw new Error('Survival recovery conditions changed')
   if(s.inventory.diamond!==r.before.inventory.diamond)throw new Error('Diamond inventory changed')
   if(!daytimeWork(time)||time>=WORK_CUTOFF-RECOVERY_WORK_MARGIN)throw new Error('Insufficient daylight to safely continue the morning job')
   if(!shelteredObservation(b,this.teammate.projects.base).passed)throw new Error('Primary shelter is no longer verified')
  }
  await this.teammate.continueAfterClearance(this.teammate.epoch,this.abort.signal,b,{
   limitMs:RECOVERY_LIMIT_MS,check,maintain:async()=>{
    const s=this.teammate.snapshot()
    if(s.survival.food<18){
     const food=s.survival.carriedFood.find(i=>SAFE_FOODS.has(i.name)&&i.count>0)
     if(!food)throw new Error('No carried food during sheltered recovery')
     await this.action('eat',{item:food.name,count:Math.min(8,food.count)})
     return true
    }
    this.update('sheltered_wait','Maintaining shelter while waiting for verified clearance and enough daylight')
   }
  })
  wait.endedAt=Date.now();wait.status=this.teammate.requestProgress?.safetyContinuations?.length?'continued':'paused';this.save()
 }
 async run(){
  let clearSince=null,waitSince=null,lastDay=null,job=null
  while(this.active){
   const s=this.teammate.snapshot(),b=this.runner.bot,r=this.record
   if(!s.connected||s.connectionId!==r.connectionId)throw new Error('Connection changed; explicit restart required')
   if(s.health<=12||s.survival.difficulty!=='easy'||b.time.doDaylightCycle!==true)throw new Error('Health cutoff or trial conditions changed')
   if(!Number.isFinite(b.time.age)||!Number.isFinite(b.time.time)||b.time.age<r.startAge||b.time.time<r.startTime)throw new Error('World clock is unavailable or moved backward')
   if(Date.now()-r.startedAt>(r.days*24+10)*60000)throw new Error('Session wall-clock limit reached')
   if(s.inventory.diamond!==(r.before.inventory.diamond??undefined))throw new Error('Diamond inventory changed')
   if(s.safety){
    clearSince=null
    if(extendedRecoveryEligible(s,job,r)){void this.extendRecovery(job).catch(e=>{if(this.active)this.fail(e.message)});await delay(500);continue}
    if(s.safety.status!=='retreating'&&s.safety.continuation?.status!=='watching')throw new Error('Safety recovery needs explicit attention')
    this.update('safety','Existing safety supervisor is handling an interruption');await delay(500);continue
   }
   const sheltered=shelteredObservation(b,this.teammate.projects.base).passed,time=b.time.timeOfDay,day=b.time.day
   r.completedCycles=Math.floor((b.time.age-r.startAge)/24000)
   if(job?.done&&!['thinking','acting','retreating'].includes(s.phase)){
    if(s.phase==='blocked'||s.requestProgress?.reviewRequired)throw new Error(s.requestProgress?.blocker||'Morning work needs explicit review')
    if(!sheltered||!morningOutcome(s,job.target))throw new Error('Morning outcome did not meet independently checked reserves, tool or shelter requirements')
    r.jobs.push({day:job.day,requestId:s.requestProgress.id,target:job.target,after:{inventory:s.inventory,tools:s.tools,food:s.survival.food},feedback:s.requestProgress.feedback,status:'passed'});job=null;this.save()
   }
   if(r.completedCycles>=r.days&&sheltered&&!job){
    if(r.jobs.length<r.days)throw new Error('Not enough completed morning jobs for the requested cycles')
    this.active=false;r.status='completed';r.mode='finished';r.reason='Day/night cycles completed with morning work';r.endedAt=Date.now();r.after={inventory:s.inventory,tools:s.tools,food:s.survival.food};this.save();this.teammate.say('The survival session is complete. I am staying home until your next instruction.');return
   }
   if(!daytimeWork(time)){
    clearSince=null;waitSince=null
    if(job){
     // Do not abandon an uncertain transfer/consumption and automatically retry it tomorrow.
     this.teammate.interrupt('Dusk cutoff reached; returning home');this.teammate.dispatch({action:'stop'})
     await this.runner.waitForIdle(this.abort.signal);await this.action('retreat',{project:structuredClone(this.teammate.projects.base)})
     throw new Error('Morning work missed the dusk deadline; returned home, explicit review required')
    }
    if(!sheltered)await this.action('retreat',{project:structuredClone(this.teammate.projects.base)})
    else if(s.survival.food<18){const food=s.survival.carriedFood.find(i=>SAFE_FOODS.has(i.name)&&i.count>0);if(!food)throw new Error('No carried food while sheltered');await this.action('eat',{item:food.name,count:8})}
    else this.update('sheltering','Waiting through dusk and night in the verified closed lit base')
   }else if(job){this.update('working',this.teammate.activity||'Carrying out the morning resupply goal')}
   else if(lastDay!==day){
    if(!sheltered)throw new Error('Morning started outside the verified primary base')
    if(s.survival.food<18){const food=s.survival.carriedFood.find(i=>SAFE_FOODS.has(i.name));if(!food)throw new Error('No food available before departure');await this.action('eat',{item:food.name,count:8});clearSince=null}
    else {
     const observation=clearanceObservation(b,this.teammate.projects,'base');waitSince??=Date.now()
     if(!observation.clear)clearSince=null;else clearSince??=Date.now()
     this.update('morning_check',observation.clear?'Waiting for 20 continuous clear seconds before departure':observation.reason)
     if(Date.now()-waitSince>240000)throw new Error('Morning area did not become clear within four minutes')
     if(clearSince&&Date.now()-clearSince>=20000){
      const target=morningGoal(s,r.wood);lastDay=day;clearSince=null;waitSince=null
      job={day,target,done:false};const current=job
      this.teammate.submit(target.text,null,{automatic:true}).then(()=>{current.done=true}).catch(e=>{if(this.active)this.fail(e.message)})
      current.requestId=this.teammate.requestProgress.id
     }
    }
   }else this.update('resting','Morning reserves verified; staying home until the next day')
   await delay(500)
  }
 }
}
