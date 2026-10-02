import {validateUseGoal,interactableObservation,useTargetNames} from '../use-item.js'
import {updateMission,syncMissionStatus,missionFocus} from './milestones.js'
import {SkillControl,selectSkill} from './skill-control.js'
import {eatOnClearGround} from './food-recovery.js'
import {validateObservedTravelGoal} from '../travel.js'
import {validateGotoGoal,validateDigGoal} from '../primitives.js'
import {validatePlaceAtGoal,validateCollectGoal,validateAttackGoal} from '../primitives-world.js'
import {berryObservation} from '../foraging.js'
import {shelteredPlanning} from './sheltered-planning.js'
import {adaptiveRecovery} from './adaptive-recovery.js'
import {recoveryContext,recoveryState,recentRecovery,recordRecovery} from './recovery-context.js'
import {THREAT_INTERRUPTION,clearanceObservation,awaitClearance,openGroundClearance} from './hazard-clearance.js'
import {alternativeShelters,occupiedAlternative} from '../alternate-shelter.js'
import {shelteredObservation,inspectRetreatShelter,insideBase} from '../retreat.js'
import {fullCube} from '../construction.js'
import {canopyLandings} from '../canopy.js'
import {setTimeout as delay} from 'node:timers/promises'
// Four expired windows is an hour of watching; past that a person should look.
const BURROW_WATCHES=4
const SAFETY_RETRIES=3
const NIGHT_HOLD_MS=14*60*1000
import {survivalObservation,emergencyReason,threatRadius,CLOSE_FLOORS,WATER_EMERGENCY,FIRE_EMERGENCY,PORTAL_EMERGENCY,NIGHT_EXPOSURE,HEALTH_EMERGENCY,FOOD_EMERGENCY} from '../survival.js'
// Air, fire and a portal underfoot run their own recovery at once and preempt
// any shelter attempt: each has a clock no shelter stops.
const URGENT=new Set([WATER_EMERGENCY,FIRE_EMERGENCY,PORTAL_EMERGENCY])
import {burrowClearance,shelterExits} from '../burrow.js'
import {roofed} from '../observations.js'
import {inspectEmergencyShelter} from '../shelter-occupants.js'
import {threatReach} from '../threat-reach.js'
import {defenseDecision,combatClearance,DEFENDABLE_MOBS,meleeWeapon} from '../combat.js'
import {ThreatJudge,harnessVerdict,wornArmour,forcedInterruption,gateVerdict,chooseResponse} from '../threat-judgement.js'
import {projectFootprints} from '../site-survey.js'
import {reviseArchitecture} from '../construction.js'
import {evaluateGoal,enforceProjectIntent,validateContract,constructionLimits,vacuousContract} from './goal-contract.js'
import {ExperienceStore,experienceEvidence} from './experience.js'
import {PLANNING_ROUNDS,ACTIVE_BUDGET_MS,canResume,progressFingerprint,interruptedEffect,buildSiteAnchor,withinBuildReach,AUTO_RESPAWN_LIMIT,STALL_CONTINUATIONS,STALL_RETRY_MS,shouldContinueAfterBudget,canContinueAfterSafety,shouldRetryPlanning,noteCriterionStall} from './continuity.js'
import {PREPARE_ACTIONS} from '../supplies.js'
import {OBSIDIAN_ACTIONS,validateObsidianGoal} from '../obsidian.js'
import {EXPEDITION_ACTIONS,remainingDurability,expeditionObservation} from '../prospecting.js'
import {STATION_ACTIONS} from '../stations.js'
import {nearbyResources,terrainSummary,footingObservation,worldObservation,applyInspectBlockRequest} from '../observations.js'
import {LOG_ITEMS} from '../resources.js'
import { resourceCount, resourceLabel } from '../resources.js'
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname,join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validatePlan } from './planner.js'
import {deliveredCount,satisfiedStep,currentRequestTask} from './progress.js'

const designKey=design=>JSON.stringify((design||[]).map(b=>[b.x,b.y,b.z,b.block]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]||a[3].localeCompare(b[3])))

export class Teammate extends EventEmitter {
  constructor(runner, planner, statePath, recorder = null) {
    super(); this.runner = runner; this.planner = planner; this.statePath = statePath; this.recorder = recorder
    this.messages = []; this.places = {}; this.phase = 'ready'; this.plan = []; this.stepIndex = -1; this.epoch = 0
    this.skillControlMode=process.env.MC_SKILL_CONTROL==='jev'?'jev':'planner'
    this.shelterPlanning=process.env.MC_SHELTER_PLANNING==='1';this.recoveryHistory=[];this.recoveryMode=process.env.MC_RECOVERY_MODE==='adaptive'?'adaptive':'existing';this.threatContextMode=process.env.MC_THREAT_CONTEXT==='legacy'?'legacy':'rich'
    this.safety = null; this.requestProgress = null; this.projects = {};this.experience=new ExperienceStore(join(dirname(statePath),'experience.json'),runner.profile)
    // Shadow mode: Jev's opinion is logged beside every safety decision and changes nothing yet.
    this.threatJudge=new ThreatJudge({log:(type,data)=>runner.log?.(type,data)})
    try { const s = JSON.parse(readFileSync(statePath, 'utf8')); if (s.profile === runner.profile) { this.recoveryHistory=Array.isArray(s.recoveryHistory)?s.recoveryHistory.slice(-16):[];this.safety=s.safety||null;if(['retreating','defending'].includes(this.safety?.status))this.safety.status='interrupted';this.messages = s.messages.slice(-60); this.places = s.places; this.projects=s.projects||{}; this.requestProgress=s.requestProgress||null; if(this.requestProgress?.status==='running')this.requestProgress.status='interrupted' } }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    if(this.safety?.continuation?.status==='watching')this.safety.continuation={status:'paused',reason:'Service restarted; explicit Resume is required'}
    // A restart while dug in must not strand the bot underground: resume the wait on spawn.
    this.restoreBurrow=['burrow','hut'].includes(this.safety?.retreat?.shelterName)&&!!this.safety.retreat.surface&&!this.safety.exit
    // A request interrupted only by a service restart continues once on its own
    // after the bot is back in the world; a second restart needs a person.
    // The blocker string this used to match is written nine lines below, so it was
    // always absent on the very restart it was meant to detect. Gate on the state.
    this.restoreRequest=!this.restoreBurrow&&this.requestProgress?.status==='interrupted'&&!interruptedEffect(runner.task)&&!this.requestProgress.reviewRequired&&!(this.requestProgress.restartContinuations>=1)
    if(this.requestProgress?.status==='interrupted'&&this.requestProgress.inFlight?.taskId&&this.requestProgress.inFlight.taskId===runner.task?.id&&runner.task.status==='completed'){
      const {step,taskId}=this.requestProgress.inFlight,result=structuredClone(runner.task.result||null)
      if(!(this.requestProgress.feedback||[]).some(f=>f.taskId===taskId)){
        (this.requestProgress.feedback??=[]).push({action:step.action,step,taskId,status:'completed',result})
        this.requestProgress.completed.push({step,result,taskId})
      }
      this.requestProgress.inFlight=null
    }
    if(this.requestProgress?.status==='interrupted'){this.requestProgress.reviewRequired=interruptedEffect(runner.task);this.requestProgress.blocker=this.requestProgress.reviewRequired||'Service restarted. Resume to re-observe and continue.';this.phase='blocked'}
    syncMissionStatus(this.requestProgress)
    if(runner.task?.kind==='build'&&runner.task.goal?.origin&&!this.projects.base)this.projects.base={build:structuredClone(runner.task.goal),stations:{},built:runner.task.status==='completed'}
    if(runner.task?.kind==='construct'&&runner.task.goal?.name)this.projects[runner.task.goal.name]={construction:structuredClone(runner.task.goal),progress:runner.task.progress,result:runner.task.result,status:runner.task.status}
    if(runner.task?.goal?.project)this.projects.base=structuredClone(runner.task.goal.project)
    runner.on('operator_command', c => { if (!this.dispatching && c.action !== 'status') { this.cancel(false);if(c.action==='stop'){this.safety={status:'cancelled',reason:'Operator stop'};if(canResume(this.requestProgress))this.requestProgress.status='cancelled';this.persist()} } })
    runner.on('event', e => {
      if(e.type==='survival_tick'&&runner.ready){
        const bot=runner.bot
        // Recovery can finish an inventory, hunger or health goal while the
        // agent remains sheltered. Completion need not wait for a departure.
        const request=this.requestProgress
        if(request?.status==='interrupted'&&!request.reviewRequired&&request.goal?.kind==='task'&&this.safety?.protection?.verified){
          let protectedNow=false
          try{protectedNow=inspectEmergencyShelter(bot).verified}catch{}
          const verdict=protectedNow?this.verifyGoal():null
          if(verdict?.verdict==='passed'){
            request.verification=verdict;request.status='verified';request.pending=[];request.inFlight=null;request.blocker=null
            this.say('Your saved goal checks have passed. I am staying sheltered while the safety watch continues.')
            runner.log?.('goal_verified_during_recovery',{requestId:request.id,verification:verdict})
          }
        }
        // Shelter means a built base with a recorded light: the retreat refuses an unlit one.
        // A torch station is recorded before placement; only a confirmed one lights
        // the base, and a base players have damaged is not shelter at all.
        const base=this.projects.base
        let shelterAvailable=!!base&&base.built!==false&&base.stations?.torch?.confirmed===true
        // Only a base we can actually inspect can be judged damaged; no design means no evidence.
        // Login announces spawn before the chunks arrive. A base whose blocks are
        // not there yet is not a destroyed base: standing inside it, hold it as
        // shelter for a few seconds rather than treat the mob beyond the wall as an
        // emergency. Blocks that never arrive stop being an excuse.
        let awaitingBase=false
        if(shelterAvailable&&base.build?.design?.length){try{inspectRetreatShelter(runner.bot,base,{occupants:false});this.unloadedSince=null}catch(error){
          awaitingBase=/: unloaded$/.test(error.message)&&insideBase(runner.bot,base)&&Date.now()-(this.unloadedSince??=Date.now())<20000
          if(!awaitingBase)shelterAvailable=false
        }}
        const sheltered=awaitingBase||shelterAvailable&&(()=>{try{return shelteredObservation(runner.bot,base).passed}catch{return false}})()
        const observation=survivalObservation(runner.bot)
        // Health over time is something only this tick can see. A single
        // snapshot cannot tell "hurt and stable, go find food" from "hurt and
        // still being hit", and the difference decides whether stopping helps.
        if(Number.isFinite(observation.health)){
          if(Number.isFinite(this.lastHealth)&&observation.health<this.lastHealth)this.lastDamageAt=Date.now()
          this.lastHealth=observation.health
        }
        const recentDamageMs=Number.isFinite(this.lastDamageAt)?Date.now()-this.lastDamageAt:null
        if(this.phase==='blocked'&&canResume(this.requestProgress)){this.blockedSince??=Date.now()}else this.blockedSince=null
        // Whether the hostiles in range share the bot's open space: asked only
        // when one of them is behind something, since a mob in plain view counts anyway.
        const pressing=observation.nearbyThreats.filter(t=>t.risk==='potential_hostile'&&t.distance<=threatRadius(t.name))
        if(pressing.some(t=>t.sightline?.status==='blocked')){const reach=threatReach(runner.bot,pressing);pressing.forEach((t,i)=>{t.reach=reach[i]})}
        // Night only matters where the sky is: asked when it is dark and there is no base.
        const underRock=!shelterAvailable&&Number.isFinite(observation.timeOfDay)&&(observation.timeOfDay>=12500||observation.timeOfDay<500)&&roofed(runner.bot)
        const reason=emergencyReason({...observation,shelterAvailable,sheltered,recentDamageMs,roofed:underRock})
        // The journal should show the times rock was the reason work carried on.
        if(!reason&&pressing.some(t=>t.reach==='sealed')&&Date.now()-(this.sealedLogAt||0)>=30000&&emergencyReason({...observation,nearbyThreats:observation.nearbyThreats.map(t=>({...t,reach:undefined})),shelterAvailable,sheltered,recentDamageMs,roofed:underRock})===THREAT_INTERRUPTION){this.sealedLogAt=Date.now();runner.log?.('threat_sealed',{threats:pressing.slice(0,4).map(t=>`${t.name}@${t.distance}/${t.verticalOffset}:${t.reach}`)})}
        // Stop cancels the recovery in hand and stands while that emergency lasts.
        // Once nothing is wrong it has nothing left to hold: left in place it
        // switched safety off for good, and a stopped bot stood through dusk
        // until a creeper found it.
        if(!reason&&this.safety?.status==='cancelled'){this.safety=null;this.persist()}
        if(!reason){this.noteProgress();void this.stallRetry()}
        if(this.safety?.reason===WATER_EMERGENCY&&['failed','afloat'].includes(this.safety.status)&&observation.headSubmerged===false&&observation.inWater===false&&runner.bot.entity.onGround){
          this.safety=null;this.activity='';runner.bot.clearControlStates();this.phase=canResume(this.requestProgress)?'blocked':'ready'
          if(canResume(this.requestProgress))this.requestProgress.blocker='On dry ground. Review current inventory before resuming the saved task.'
          this.say('I am on dry ground and can breathe. The saved task remains paused.')
        }
        // Exhaustion applies to one observed situation, not to a new attacker
        // or a material change in health, equipment or shelter. Keep the same
        // retry budget while the fingerprint is unchanged and respect Stop.
        if(reason&&this.safety?.status==='failed'&&this.unsafeSignature&&!this.snapshot().dead&&
          (reason!==this.unsafeSignature.reason||this.safetyBlockKey()!==this.unsafeSignature.key)){
          this.safety=null;this.threatHold=null
        }
        if(reason&&(!this.safety||URGENT.has(reason)&&this.safety.reason!==reason&&this.safety.status!=='cancelled')){
          // Control mode: whether a hostile in radius stops work is Jev's call,
          // above the floors; a judged continue holds for a few seconds so the
          // next tick does not ask again about the same mob.
          const forced=reason===THREAT_INTERRUPTION&&this.threatJudge?.control?forcedInterruption(observation,this.threatJudge.floors):'not judged'
          if(forced)void this.seekSafety(reason)
          else if(this.threatHold&&Date.now()<this.threatHold.until){}
          else if(!this.threatGate){
            const context=this.judgementContext(runner.bot,shelterAvailable,sheltered)
            this.threatGate=this.threatJudge.judge('gate',observation,{...context,harness:'interrupt',harnessReason:'a hostile is inside the rule\'s interruption radius'}).then(j=>{
              this.threatGate=null
              if(this.safety||!runner.ready||runner.bot!==bot)return
              const verdict=gateVerdict(j,this.threatJudge.floors)
              runner.log?.('threat_gate',{verdict,response:j?.response??null,interrupt:j?.interrupt??null,confidence:j?.confidence??null,threats:observation.nearbyThreats.map(t=>`${t.name}@${t.distance}`)})
              if(verdict==='continue'){const fresh=!this.threatHold;this.threatHold={until:Date.now()+this.threatJudge.floors.holdMs,response:j.response};if(fresh)this.say(`Jev says keep working (${j.response}, interrupt ${Math.round(j.interrupt*100)}%). Watching the ${observation.nearbyThreats[0]?.name||'threat'}.`)}
              else{this.threatHold=null;void this.seekSafety(reason)}
            }).catch(()=>{this.threatGate=null;void this.seekSafety(reason)})
          }
        }
        // Hostiles in view that the rule leaves alone: ask whether a player would, throttled.
        else if(!reason&&!this.safety&&observation.nearbyThreats.some(t=>t.risk==='potential_hostile'&&t.distance<=24))void this.threatJudge?.judge('watch',observation,{...this.judgementContext(runner.bot,shelterAvailable,sheltered),harness:'continue',harnessReason:'no hostile inside its interruption radius'})
        // Safety is unreachable here and the chain has stopped trying. Idling fixes
        // none of the blockers and the work usually does, so let saved work continue.
        // Owned by the tick rather than the failure handler, which races the retries.
        if(this.safety?.status==='failed'&&this.unsafeSignature&&!this.standoffResuming&&!this.snapshot().dead&&canResume(this.requestProgress)){
          this.standoffResuming=true
          void this.resume({automatic:true}).catch(error=>this.say('I could not continue the saved request: '+error.message)).finally(()=>{this.standoffResuming=false})
        }
        // A failed recovery never leaves the bot standing still while the danger
        // persists: after a short pause the chain runs again, a bounded number of times.
        else if(reason&&this.safety?.status==='failed'&&this.safety.error!=='Agent died'&&!this.snapshot().dead&&(this.safety.retries||0)<SAFETY_RETRIES&&Date.now()-(this.safety.failedAt||0)>=3000){const retries=(this.safety.retries||0)+1,resumeInterrupted=this.safety.resumeRequestId===this.requestProgress?.id&&this.requestProgress?.status==='interrupted'&&canResume(this.requestProgress);this.safety=null;void this.seekSafety(reason,{retries,resumeInterrupted})}
      }
      if(['task_started','task_finished'].includes(e.type)&&e.task?.goal?.project){this.projects.base=structuredClone(e.task.goal.project);this.persist()}
      if(['task_started','task_finished'].includes(e.type)&&e.task?.kind==='construct'&&e.task.goal?.name){this.projects[e.task.goal.name]={construction:structuredClone(e.task.goal),progress:structuredClone(e.task.progress||null),result:structuredClone(e.task.result||null),status:e.task.status};this.persist()}
      // Only a shelter build is the base. Any other build adopted it and wiped the
      // station records, after which every place, deposit and check_base threw and
      // the bot was homeless at dusk.
      if(e.type==='task_finished'&&e.task?.kind==='build'&&e.task.goal?.origin&&e.task.goal.purpose==='shelter'){const sameSite=JSON.stringify(this.projects.base?.build?.origin)===JSON.stringify(e.task.goal.origin);this.projects.base={...(sameSite?this.projects.base:{}),build:structuredClone(e.task.goal),stations:sameSite?(this.projects.base?.stations||{}):{},built:e.task.status==='completed'||(sameSite&&this.projects.base?.built===true)};this.persist()}
      if (e.type === 'skill_progress') { this.activity = e.message; this.emit('change') }
      if (e.type === 'death') {
        const recovery=['retreating','defending'].includes(this.phase),action=this.phase==='defending'?'defense':'retreat'
        this.cancel(false,'interrupted');this.safety={...this.safety,status:'failed',error:recovery?'Died during '+action:'Agent died',deathPosition:runner.position()};this.phase='blocked'
        // The drop pile is the only thing worth going back for, and it despawns in
        // five minutes. `safety` already carries deathPosition, but the respawn
        // branch below nulls it before any reader sees it, so keep a copy that
        // survives the clear and reaches observe().
        this.lastDeath={position:runner.position()}
        if(canResume(this.requestProgress)){this.requestProgress.blocker='The agent died. Respawn first, then review the lost inventory before resuming.';this.persist()}
        this.say('I died. Use Respawn agent to return to the world. The saved request will stay paused; inventory may have been dropped.')
        // The drop pile despawns in five minutes, and on 20 September nobody was
        // watching: the agent sat dead through the whole window and a full kit
        // was lost. Come back automatically while a saved request is still live.
        if(canResume(this.requestProgress)&&(this.requestProgress.autoRespawns||0)<AUTO_RESPAWN_LIMIT){
          this.requestProgress.autoRespawns=(this.requestProgress.autoRespawns||0)+1;this.persist()
          try{this.respawn()}catch(error){this.runner.log?.('auto_respawn_failed',{error:error.message})}
        }
      }
      if(e.type==='spawn'&&this.restoreBurrow&&runner.ready){this.restoreBurrow=false;this.phase='blocked';this.safety.status='burrowed';delete this.safety.error;this.persist();const abort=this.abort=new AbortController();this.say('Service restarted while I was dug in. Waiting for daylight before digging out.');void this.waitInBurrow(this.epoch,abort.signal,runner.bot,this.requestProgress?.status==='interrupted')}
      if(e.type==='spawn'&&this.restoreRequest&&runner.ready&&!this.snapshot().dead){this.restoreRequest=false;this.requestProgress.restartContinuations=(this.requestProgress.restartContinuations||0)+1;this.persist();this.say('Service restarted while a request was running. Continuing it automatically.');setTimeout(()=>{this.resume({automatic:true}).catch(error=>{this.requestProgress.blocker=error.message;this.persist()})},1500)}
      if(e.type==='spawn'&&this.respawning){this.respawning=false;this.safety=null;this.phase=canResume(this.requestProgress)?'blocked':'ready';if(canResume(this.requestProgress))this.requestProgress.blocker='Respawned. Review current inventory before resuming the saved task.';this.say('I respawned. Check my current inventory before resuming the saved request.')}
    })
  }
  verifyGoal() {
    const request=this.requestProgress
    if(!request)return null
    request.verification=evaluateGoal(request.goal,this.snapshot(),this.runner.bot,request.feedback||[])
    updateMission(request,request.verification,{connected:this.runner.ready})
    return request.verification
  }
  persist() { syncMissionStatus(this.requestProgress); mkdirSync(dirname(this.statePath), { recursive: true }); writeFileSync(this.statePath + '.tmp', JSON.stringify({ profile: this.runner.profile, places: this.places, messages: this.messages.slice(-60), requestProgress:this.requestProgress,canResume:canResume(this.requestProgress),projects:this.projects,experienceCount:this.experience.entries.length,recoveryHistory:this.recoveryHistory,safety:this.safety }), { mode: 0o600 }); renameSync(this.statePath + '.tmp', this.statePath) }
  say(text, role = 'assistant') { const m = { id: randomUUID(), role, text: String(text).slice(0,2000), at: new Date().toISOString() }; this.messages.push(m); this.messages = this.messages.slice(-60); this.persist(); this.emit('change'); return m }
  playingAsOwner() { return !!this.runner.bot?.username && this.runner.bot.username.toLowerCase() === this.runner.owner.toLowerCase() }
  snapshot() {
    const b = this.runner.bot, owner = this.playingAsOwner() ? null : b?.players?.[this.runner.owner]?.entity
    const inventory = {}; for (const i of (b?.currentWindow||b?.inventory)?.items() || []) inventory[i.name] = (inventory[i.name] || 0) + i.count
    const dead=!!b&&b.health===0&&b.isAlive===false
    let litShelterVerified=false
    const base=this.projects.base
    if(base?.built===true&&base.stations?.torch?.confirmed===true){try{litShelterVerified=!!inspectRetreatShelter(b,base,{occupants:false})}catch{}}
    return { lastDeath:this.lastDeath??null, skillControl:{mode:this.skillControlMode,budget:this.requestProgress?.skillControl||null}, recovery:{shelterPlanning:!!this.shelterPlanning,mode:this.recoveryMode,context:this.threatContextMode,recentAttempts:recentRecovery(this)},litShelterVerified, threatJudge:{mode:this.threatJudge.enabled?(this.threatJudge.control?'control':'shadow'):'off',model:this.threatJudge.model}, phase: this.phase, connected: this.runner.ready, dead, respawning:!!this.runner.respawnPending, connectionId:this.runner.connectionId, owner: this.runner.owner, ownerVisible: !!owner, playingAsOwner:this.playingAsOwner(), position: this.runner.position(), ownerPosition: owner?.position || null,
      health: b?.health ?? null, survival:survivalObservation(b), footing:footingObservation(b), tools:(b?.inventory?.items()||[]).filter(i=>i.maxDurability).map(i=>({name:i.name,remaining:remainingDurability(i),maximum:i.maxDurability})), inventory, places: this.places, task: this.runner.task, plan: this.plan, stepIndex: this.stepIndex,
      safety:this.safety, activity: this.activity || '', messages: this.messages, model: this.planner.model, requestProgress:this.requestProgress,canResume:!dead&&!this.runner.respawnPending&&!['retreating','defending'].includes(this.phase)&&canResume(this.requestProgress),projects:this.projects,experienceCount:this.experience.entries.length }
  }
  dispatch(command) { this.runner.shelterProject=this.projects.base; this.runner.protectedSites=projectFootprints(this.projects); this.dispatching = true; try { this.runner.command(command) } finally { this.dispatching = false } }
  cancel(stop = true, disposition = 'cancelled') { if(['retreating','defending'].includes(this.safety?.status))this.safety.status=disposition; ++this.epoch; if(this.requestProgress?.status==='running'){this.requestProgress.status=disposition;this.persist()} this.episode?.end(disposition); this.episode = null; this.abort?.abort(); this.abort = null; this.phase = 'ready'; this.plan = []; this.stepIndex = -1; this.activity = ''; if (stop) this.dispatch({ action: 'stop' }); this.emit('change') }
  stop() { const unfinished=['running','blocked','interrupted','paused'].includes(this.requestProgress?.status);this.cancel();if(unfinished){this.requestProgress.status='cancelled';this.persist()} this.safety={status:'cancelled',reason:'Operator stop'};this.say('Stopped. I will wait for your next instruction.') }
  interrupt(reason='Service stopped. Resume to continue the saved request.') {
    const active=this.requestProgress?.status==='running',request=this.requestProgress,task=this.runner.task
    // Recovery replaces the runner task. Preserve the interrupted work's observed
    // progress before that replacement so replanning does not start from zero.
    if(active&&request.inFlight?.taskId===task?.id&&task?.status==='running'){
      const receipt={action:request.inFlight.step.action,step:structuredClone(request.inFlight.step),taskId:task.id,status:'interrupted',reason,
        observed:{kind:task.kind,position:this.runner.position(),...(task.hunt?{hunt:structuredClone(task.hunt)}:{}),...(task.kind==='harvest'?{harvest:{attempt:structuredClone(task.harvestAttempt||null),completed:structuredClone(task.harvested||[]),rejected:structuredClone(task.harvestRejected||[]),carried:this.snapshot().inventory.sweet_berries||0}}:{}),...(task.progress?{progress:structuredClone(task.progress)}:{}),...(task.result?{result:structuredClone(task.result)}:{})}}
      ;(request.feedback??=[]).push(receipt);this.episode?.write('interrupted_work',receipt)
    }
    this.cancel(false,'interrupted')
    if(active){this.requestProgress.status='interrupted';this.requestProgress.reviewRequired=interruptedEffect(this.runner.task);this.requestProgress.blocker=this.requestProgress.reviewRequired||reason;this.persist()}
  }
  // What could change the outcome of a failed recovery: the tools and blocks it
  // would need, whether the base is usable, and whether anything is hunting it.
  safetyBlockKey() {
    const b=this.runner.bot,items=b?.inventory?.items?.()||[]
    const placeable=items.filter(i=>fullCube(b?.registry,i.name)).reduce((n,i)=>n+i.count,0)
    const base=this.projects.base
    let shelter='none'
    if(base){try{shelter=shelteredObservation(b,base).passed?'inside':inspectRetreatShelter(b,base,{occupants:true})?'usable':'unusable'}catch(error){shelter=String(error.message).slice(0,60)}}
    const s=survivalObservation(b)
    return JSON.stringify({pickaxe:items.some(i=>/_pickaxe$/.test(i.name)),placeable:Math.min(placeable,16),shelter,
      hostile:(s.nearbyThreats||[]).some(t=>t.risk==='potential_hostile'&&t.distance<=16),health:Math.round((s.health??0)/4),food:(s.carriedFood||[]).length>0})
  }
  // One plain sentence naming each blocker and what would clear it, instead of
  // four generic lines per attempt repeated until the operator gives up.
  unsafeAdvice(attempts=[]) {
    const say=[],items=this.runner.bot?.inventory?.items?.()||[]
    for(const a of attempts){
      if(a.status!=='rejected'||!a.reason)continue
      if(a.name==='base')say.push(`the base is not usable (${a.reason})`)
      else if(a.name==='burrow')say.push(items.some(i=>/_pickaxe$/.test(i.name))?`digging in failed (${a.reason})`:'I have no pickaxe to dig in')
      else if(a.name==='hut')say.push(/Fewer than/.test(a.reason)?'I have no blocks to wall in with':`walling in failed (${a.reason})`)
      else if(a.name==='move')say.push('there was nowhere to move to')
      else say.push(`${a.name}: ${a.reason}`)
    }
    const needs=[]
    if(!items.some(i=>/_pickaxe$/.test(i.name)))needs.push('a pickaxe')
    if(items.filter(i=>fullCube(this.runner.bot?.registry,i.name)).reduce((n,i)=>n+i.count,0)<10)needs.push('ten building blocks')
    if(attempts.some(a=>a.name==='base'&&a.status==='rejected'))needs.push('the base doorway clear and its walls whole')
    return (say.length?say.join('; '):'nothing here worked')+(needs.length?`. I need ${needs.join(' or ')}.`:'')
  }
  // What the judge sees beyond the survival observation: weapon, armour, tools, shelter and base distance.
  judgementContext(bot,shelterAvailable=false,sheltered=false){
    const origin=this.projects?.base?.build?.origin,p=bot?.entity?.position
    const baseDistance=origin&&p?Math.hypot(origin.x-p.x,origin.z-p.z):null
    const items=bot?.inventory?.items?.()||[]
    return {contextMode:this.threatContextMode,evidence:this.threatContextMode==='legacy'?null:recoveryContext(this,bot),weapon:meleeWeapon(bot)?.name||null,armour:wornArmour(bot),tools:items.filter(i=>/_(pickaxe|axe|shovel|sword|hoe)$/.test(i.name)).map(i=>i.name),inventory:items.reduce((m,i)=>({...m,[i.name]:(m[i.name]||0)+i.count}),{}),sheltered,shelterAvailable,baseDistance}
  }
  async seekSafety(reason,{retries=0,resumeInterrupted=false}={}) {
    if(this.safety&&(!URGENT.has(reason)||this.safety.reason===reason||this.safety.status==='cancelled'))return
    // A recovery that already failed, with nothing changed that could make it
    // succeed, must not run again: it produces the same messages and no safety,
    // and it preempts every instruction the operator types in the meantime.
    if(!URGENT.has(reason)&&this.unsafeSignature?.reason===reason&&this.unsafeSignature.key===this.safetyBlockKey())return
    const interruptedActiveRequest=this.requestProgress?.status==='running'||resumeInterrupted&&canResume(this.requestProgress)
    const previousFollow=this.runner.task?.kind==='follow'&&this.runner.task.status==='running'?this.runner.task.goal.player:null
    this.interrupt('Safety interruption: '+reason)
    const epoch=this.epoch,abort=this.abort=new AbortController()
    this.unsafeSignature=null
    this.safety={status:'retreating',reason,startedAt:new Date().toISOString(),retries,resumeRequestId:interruptedActiveRequest?this.requestProgress?.id:null};this.phase='retreating'
    this.say(reason+'. '+(reason===WATER_EMERGENCY?'I am stopping work and swimming up for air.':reason===FIRE_EMERGENCY?'I am stopping work to put the fire out.':reason===PORTAL_EMERGENCY?'I am stepping out before it carries me to the Nether.':reason===THREAT_INTERRUPTION?'I am pausing work and assessing self-defense.':'I am pausing work and looking for a verified lit shelter.'))
    try{
      this.dispatch({action:'stop'})
      if(reason===WATER_EMERGENCY)this.runner.bot?.setControlState('jump',true)
      await this.runner.waitForIdle?.(abort.signal)
      if(epoch!==this.epoch||abort.signal.aborted)return
      if(reason===WATER_EMERGENCY){
        await this.execute({action:'surface',goal:{},timeoutMs:40000},abort.signal)
        if(epoch!==this.epoch||abort.signal.aborted)return
        this.safety.water=structuredClone(this.runner.task.result)
        const dry=this.safety.water.receipt==='dry_ground_reached'
        this.safety.status=dry?'sheltered':'afloat';this.phase='blocked';this.activity=''
        if(!dry)this.runner.bot.setControlState('jump',true)
        if(this.requestProgress)(this.requestProgress.feedback??=[]).push({action:'surface',status:'completed',result:structuredClone(this.safety.water),automatic:true})
        if(dry)this.safety=null
        this.say(dry?'I reached dry ground and can breathe. The previous request is paused.':'I can breathe at the surface, but did not reach shore. I am staying afloat; the previous request is paused.')
        return
      }
      if(reason===PORTAL_EMERGENCY){
        await this.execute({action:'leave_portal',goal:{},timeoutMs:10000},abort.signal)
        if(epoch!==this.epoch||abort.signal.aborted)return
        const result=structuredClone(this.runner.task.result),request=this.requestProgress
        if(request)(request.feedback??=[]).push({action:'leave_portal',status:'completed',result,automatic:true})
        this.safety=null;this.activity='';this.phase=canResume(request)?'blocked':'ready';this.persist()
        if(interruptedActiveRequest&&canResume(request)&&canContinueAfterSafety(request)){
          ;(request.safetyContinuations??=[]).push({...result,requestId:request.id,connectionId:this.runner.connectionId,shelter:'left_portal',resumeSerial:request.resumeSerial||0,completedAt:request.completed?.length||0});this.persist()
          this.say('I am out of the portal and will not walk through it. Continuing your saved request.')
          await this.resume({automatic:true})
        }else this.say('I am out of the portal and will not walk through it. '+(canResume(request)?'Resume is available if the saved request can safely continue.':'Ready for your next instruction.'))
        return
      }
      if(reason===FIRE_EMERGENCY){
        await this.execute({action:'douse',goal:{},timeoutMs:30000},abort.signal)
        if(epoch!==this.epoch||abort.signal.aborted)return
        const result=this.safety.fire=structuredClone(this.runner.task.result),request=this.requestProgress,how=result?.receipt==='not_burning'?'it had already gone out':String(result?.method||'put out').replaceAll('_',' ')
        if(request)(request.feedback??=[]).push({action:'douse',status:'completed',result,automatic:true})
        // The damage that raised the alarm was the fire just put out. Left in place
        // it reads as an attack for four more seconds and sends a hurt bot to shelter.
        this.lastDamageAt=null
        this.safety=null;this.activity='';this.phase=canResume(request)?'blocked':'ready';this.persist()
        if(interruptedActiveRequest&&canResume(request)&&canContinueAfterSafety(request)){
          ;(request.safetyContinuations??=[]).push({...result,requestId:request.id,connectionId:this.runner.connectionId,shelter:'doused',resumeSerial:request.resumeSerial||0,completedAt:request.completed?.length||0});this.persist()
          this.say(`The fire is out (${how}). Continuing your saved request.`)
          await this.resume({automatic:true})
        }else this.say(`The fire is out (${how}). `+(canResume(request)?'Resume is available if the saved request can safely continue.':'Ready for your next instruction.'))
        return
      }
      const deadline=Date.now()+20000
      while(!this.runner.ready){if(epoch!==this.epoch||abort.signal.aborted)return;if(Date.now()>deadline)throw new Error('Could not reconnect for retreat');await delay(100)}
      if(epoch!==this.epoch||abort.signal.aborted)return
      const recoveryBot=this.runner.bot
      if(recoveryBot?.waitForChunksToLoad){let timer;try{await Promise.race([recoveryBot.waitForChunksToLoad(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Retreat chunks did not load within 15 seconds')),15000)})])}finally{clearTimeout(timer)}}
      if(epoch!==this.epoch||abort.signal.aborted)return
      if(this.runner.bot!==recoveryBot||!this.runner.ready)throw new Error('Connection changed before retreat')
      if(reason===FOOD_EMERGENCY){
        if(await eatOnClearGround(this,epoch,abort.signal,recoveryBot,interruptedActiveRequest))return
        if(epoch!==this.epoch||abort.signal.aborted)return
        if(this.runner.bot!==recoveryBot||!this.runner.ready)throw new Error('Connection changed during recovery eating')
      }
      let adaptive='fallback'
      if(reason===THREAT_INTERRUPTION&&this.recoveryMode==='adaptive'&&interruptedActiveRequest&&typeof this.planner.recover==='function'){
        adaptive=await adaptiveRecovery(this,epoch,abort.signal,recoveryBot)
        if(adaptive==='cancelled'||epoch!==this.epoch||abort.signal.aborted)return
        if(adaptive==='cleared'){
          const request=this.requestProgress,result={status:'cleared',shelter:'adaptive_recovery',health:recoveryBot.health}
          this.runner.log?.('recovery_complete',result)
          const continuing=canResume(request)&&canContinueAfterSafety(request)
          ;(request.feedback??=[]).push({action:'recovery',status:'completed',result,automatic:true})
          ;(request.safetyContinuations??=[]).push({...result,requestId:request.id,connectionId:this.runner.connectionId,completedAt:request.completed?.length||0})
          this.safety=null;this.activity='';this.phase='blocked';this.persist()
          if(continuing){this.say('Recovery verified. Continuing the saved objective.');await this.resume({automatic:true})}
          else this.say('Recovery verified. The continuation budget is exhausted; the saved objective remains paused.')
          return
        }
      }
      if(reason===THREAT_INTERRUPTION&&adaptive!=='shelter'){
        let decision=defenseDecision(recoveryBot)
        // Landing from a jump or closing a window takes a moment; re-judge briefly before choosing shelter.
        for(let i=0;i<4&&!decision.engage&&/^Not ready/.test(decision.reason);i++){await delay(250);if(epoch!==this.epoch||abort.signal.aborted)return;decision=defenseDecision(recoveryBot)}
        const observed=survivalObservation(recoveryBot),verdict=harnessVerdict(decision,observed)
        let chosen=verdict.verdict
        const record=j=>{if(j&&this.safety&&epoch===this.epoch){this.safety.judgement={response:j.response,confidence:j.confidence,interrupt:j.interrupt,danger:j.danger,winnable:j.winnable,harness:j.harness,agrees:j.agrees};this.persist()}}
        if(this.threatJudge?.control){
          // Bounded wait: the judge answers in well under a second or not at all.
          const j=await this.threatJudge.judge('interruption',observed,{...this.judgementContext(recoveryBot),harness:verdict.verdict,harnessReason:verdict.reason})
          if(epoch!==this.epoch||abort.signal.aborted)return
          record(j);const pick=chooseResponse(j,verdict.verdict,this.threatJudge.floors);chosen=pick.response
          // A judged fight lowers the rule's margins to the floors, never below them.
          if(chosen==='fight'&&!decision.engage)decision=defenseDecision(recoveryBot,{healthFloor:this.threatJudge.floors.fightHealth,foodFloor:this.threatJudge.floors.fightFood,mobMargins:false})
          if(chosen==='fight'&&!decision.engage){this.say(`Jev would fight, but I cannot: ${decision.reason}. Falling back to ${verdict.verdict==='fight'?'shelter':verdict.verdict}.`);chosen=verdict.verdict==='fight'?'shelter':verdict.verdict}
          else this.say(`Judgement: ${chosen} (${pick.source}${j?`; Jev ${j.response} at ${Math.round(j.confidence*100)}%, rule ${verdict.verdict}`:''}).`)
          this.runner.log?.('threat_control',{chosen,source:pick.source,rule:verdict.verdict,jev:j?.response??null,confidence:j?.confidence??null,winnable:j?.winnable??null,danger:j?.danger??null})
        }else void this.threatJudge?.judge('interruption',observed,{...this.judgementContext(recoveryBot),harness:verdict.verdict,harnessReason:verdict.reason})?.then(record)
        if(decision.engage&&(!this.threatJudge?.control||chosen==='fight')){
          this.safety.status='defending';this.phase='defending'
          this.say('I can defend against this '+decision.target.targetName+'. I am equipping '+decision.weapon.replaceAll('_',' ')+'.')
          try{
            await this.execute({action:'defend',goal:{...decision.target,connectionId:this.runner.connectionId},timeoutMs:35000},abort.signal)
            if(epoch!==this.epoch||abort.signal.aborted)return
            this.safety.combat=structuredClone(this.runner.task.result)
            this.say('The '+decision.target.targetName+' died after my attacks. Checking the area before continuing.')
            const clear=await awaitClearance({check:()=>{if(epoch!==this.epoch||abort.signal.aborted||this.runner.bot!==recoveryBot||!this.runner.ready)throw new Error('Defense continuation cancelled')},observe:()=>combatClearance(recoveryBot),quietMs:2000,limitMs:5000,pollMs:100})
            if(epoch!==this.epoch||abort.signal.aborted)return
            if(clear.status!=='cleared')throw new Error(clear.reason)
            const result={...this.safety.combat,clearance:clear},request=this.requestProgress
            if(request)(request.feedback??=[]).push({action:'defend',status:'completed',result,automatic:true})
            this.activity='';this.safety=null;this.phase=interruptedActiveRequest?'blocked':'ready';this.persist()
            if(interruptedActiveRequest&&canResume(request)&&(request.combatContinuations||[]).length<3){
              (request.combatContinuations??=[]).push({requestId:request.id,result});this.persist()
              await this.resume({automatic:true})
            }else if(previousFollow){this.dispatch({action:'follow',player:previousFollow});this.say('I am following you again.')}
            else this.say(interruptedActiveRequest?'Self-defense finished. Resume is available if the saved request can safely continue.':'Self-defense finished. Ready for your next instruction.')
            return
          }catch(error){
            if(epoch!==this.epoch||abort.signal.aborted)return
            this.safety.combatFailure=error.message
            this.say('I need shelter now: '+error.message)
            this.dispatch({action:'stop'});await this.runner.waitForIdle?.(abort.signal)
            if(epoch!==this.epoch||abort.signal.aborted)return
          }
        }else this.say('I am choosing shelter: '+decision.reason)
        // A creeper cannot be fought unarmed or waited out at close range: it
        // starts swelling within three blocks. Sprint out of its reach first.
        // Behind its own walls the answer to anything outside is to stay behind
        // them and close up: no sprint past the door, no detour over open ground.
        const indoors=insideBase(recoveryBot,this.projects.base)||!!occupiedAlternative(recoveryBot,this.projects)
        for(let attempt=0;attempt<2;attempt++){
          const creeper=survivalObservation(recoveryBot).nearbyThreats.find(t=>t.name==='creeper'&&t.risk==='potential_hostile'&&t.distance<=16)
          if(!creeper||indoors)break
          this.safety.status='fleeing';this.phase='retreating';this.say('A creeper is '+creeper.distance+' blocks away. Sprinting clear before sheltering.')
          try{await this.execute({action:'flee',goal:{from:creeper.position,distance:24},timeoutMs:15000},abort.signal);if(epoch!==this.epoch||abort.signal.aborted)return;(this.safety.flights??=[]).push(structuredClone(this.runner.task.result));this.persist()}
          catch(error){if(epoch!==this.epoch||abort.signal.aborted)return;(this.safety.flights??=[]).push({failed:error.message});this.persist();break}
        }
        // Daylight judgement: a lone zombie, husk, spider or skeleton the bot
        // cannot strike (roofed, behind a wall, kiting) is left behind on open
        // ground rather than waited out underground. Undead burn in the sun
        // when they follow; a mob that stays put is no longer a threat.
        let open=!indoors&&this.threatJudge?.control&&chosen==='evade'?await this.judgedEvade(epoch,abort.signal,recoveryBot,interruptedActiveRequest):'skipped'
        // A judged shelter is a decision, not a hint: the daylight open-ground detour stays with the rule.
        if(!indoors&&open==='skipped'&&!(this.threatJudge?.control&&chosen==='shelter'))open=await this.leaveOnOpenGround(epoch,abort.signal,recoveryBot,interruptedActiveRequest)
        if(open!=='skipped'||epoch!==this.epoch||abort.signal.aborted)return
        this.safety.status='retreating';this.phase='retreating'
      }
      const candidates=[...(this.projects.base?[{name:'base',goal:{project:structuredClone(this.projects.base)}}]:[]),...alternativeShelters(recoveryBot,this.projects).slice(0,3).map(shelter=>({name:shelter.name,goal:{shelter:structuredClone(shelter)}}))]
      this.safety.attempts=[]
      const recoveryDeadline=Date.now()+120000
      for(const candidate of candidates){
        if(epoch!==this.epoch||abort.signal.aborted)return
        if(this.runner.bot!==recoveryBot||!this.runner.ready)throw new Error('Connection changed during shelter selection')
        const remaining=recoveryDeadline-Date.now();if(remaining<=0)break
        const attempt={name:candidate.name,status:'trying'};this.safety.attempts.push(attempt);this.persist()
        try{
          await this.execute({action:'retreat',goal:candidate.goal,timeoutMs:Math.min(45000,remaining)},abort.signal)
          if(epoch!==this.epoch||abort.signal.aborted)return
          this.safety.retreat=structuredClone(this.runner.task.result);attempt.status='sheltered';break
        }catch(error){
          if(epoch!==this.epoch||abort.signal.aborted)return
          attempt.status='rejected';attempt.reason=error.message;this.persist()
          this.dispatch({action:'stop'});await this.runner.waitForIdle?.(abort.signal)
          this.say(candidate.name+' is unavailable: '+error.message+'. Checking another saved shelter.')
        }
      }
      // Digging in takes seconds, and a mob already in reach spends them hitting:
      // two zombies took sixteen health while the burrow was being dug. Put
      // distance behind first, the way a creeper is handled, then dig. Melee reach
      // is the same floor the threat rule never negotiates.
      if(!this.safety.retreat&&!insideBase(recoveryBot,this.projects.base)&&!occupiedAlternative(recoveryBot,this.projects)){
        const close=survivalObservation(recoveryBot).nearbyThreats.filter(t=>t.risk==='potential_hostile'&&t.position&&t.distance<=CLOSE_FLOORS.melee).sort((a,b)=>a.distance-b.distance)[0]
        if(close&&!(this.safety.flights||[]).length){
          this.safety.status='fleeing';this.phase='retreating';this.say(`A ${close.name} is ${close.distance} blocks away and I have no shelter to reach. Sprinting clear before digging in.`)
          try{await this.execute({action:'flee',goal:{from:close.position,distance:24},timeoutMs:15000},abort.signal);if(epoch!==this.epoch||abort.signal.aborted)return;(this.safety.flights??=[]).push(structuredClone(this.runner.task.result));this.persist()}
          catch(error){if(epoch!==this.epoch||abort.signal.aborted)return;(this.safety.flights??=[]).push({failed:error.message});this.persist();this.dispatch({action:'stop'});await this.runner.waitForIdle?.(abort.signal)}
          if(epoch!==this.epoch||abort.signal.aborted)return
          this.safety.status='retreating'
        }
      }
      if(!this.safety.retreat)await this.lastResortShelter(epoch,abort.signal)
      if(epoch!==this.epoch||abort.signal.aborted)return
      if(!this.safety.retreat&&await this.moveOutOfDanger(epoch,abort.signal,recoveryBot)){
        if(epoch!==this.epoch||abort.signal.aborted)return
        await this.lastResortShelter(epoch,abort.signal)
        if(epoch!==this.epoch||abort.signal.aborted)return
      }
      if(!this.safety.retreat)throw new Error('No verified shelter reached. '+this.safety.attempts.map(a=>a.name+': '+a.reason).join('; '))
      // Eat once safe, whatever the shelter is. Burrowing answers mobs, not hunger,
      // and a food emergency that only ever digs in re-fires every tick while the
      // bot starves holding the food that would clear it.
      {
        const carried=survivalObservation(this.runner.bot).carriedFood[0]
        if(this.runner.bot.food<20&&carried&&!this.requestProgress?.reviewRequired){
          try{await this.execute({action:'eat',goal:{item:carried.name,count:Math.min(8,carried.count)},timeoutMs:30000},abort.signal);if(epoch!==this.epoch||abort.signal.aborted)return;this.safety.eating=structuredClone(this.runner.task.result)}
          catch(error){if(epoch!==this.epoch||abort.signal.aborted)return;this.safety.eating={failed:error.message};const review=interruptedEffect(this.runner.task);if(review&&this.requestProgress){this.requestProgress.reviewRequired=review;this.requestProgress.blocker=review;this.persist()}}
        }
      }
      if(['burrow','hut'].includes(this.safety.retreat.shelterName)){
        this.safety.status='burrowed';this.phase='blocked';this.persist()
        this.say((this.safety.retreat.shelterName==='hut'?'I am walled in.':this.safety.retreat.capped?'I am dug in below the surface with the shaft capped.':'I am dug in below the surface; no cap block was available.')+' I will wait for daylight and a clear area before opening up.')
        await this.waitInBurrow(epoch,abort.signal,recoveryBot,interruptedActiveRequest&&[THREAT_INTERRUPTION,NIGHT_EXPOSURE,HEALTH_EMERGENCY,FOOD_EMERGENCY].includes(reason))
        return
      }
      this.safety.status='sheltered';this.phase=this.requestProgress?.status==='interrupted'?'blocked':'ready'
      // A health retreat deserves the same watch-and-continue as a threat retreat;
      // otherwise every hurt evening ends the request until an operator resumes it.
      const eligible=interruptedActiveRequest&&[THREAT_INTERRUPTION,HEALTH_EMERGENCY,FOOD_EMERGENCY].includes(reason)&&canResume(this.requestProgress)&&canContinueAfterSafety(this.requestProgress)
      this.say('I reached '+(this.safety.retreat.shelterName||'the lit base')+' and closed the door. '+(eligible?'I will watch for a clear area before continuing your request.':this.requestProgress?.status==='interrupted'?'Your request is paused; Resume will re-observe and continue.':'Waiting for your next instruction.'))
      if(eligible)await this.continueAfterClearance(epoch,abort.signal,recoveryBot)

    }catch(error){
      if(epoch!==this.epoch)return
      this.safety.status='failed';this.safety.error=error.message;this.safety.failedAt=Date.now();this.phase='blocked';this.activity=''
      const last=this.safety.retries>=SAFETY_RETRIES
      if(last){this.unsafeSignature={reason,key:this.safetyBlockKey(),at:Date.now()};this.persist()}
      this.say(last?`I cannot make myself safe here: ${this.unsafeAdvice(this.safety.attempts)} ${canResume(this.requestProgress)?'Standing still will not fix any of that, so I am carrying on with the work.':'No work request is active. I need help reaching safe ground.'}`
        :'Safety recovery failed: '+error.message+'. I will try again in a few seconds if the danger persists.')

    }
    finally{if(epoch===this.epoch){this.abort=null;this.persist();this.emit('change')}}
  }
  // Jev chose evade: put distance between the bot and the nearest hostile and go
  // back to work if nothing followed; anything else falls through to the chain.
  async judgedEvade(epoch,signal,bot,interruptedActiveRequest) {
    const s=survivalObservation(bot),threat=(s.nearbyThreats||[]).filter(t=>t.risk==='potential_hostile'&&t.position).sort((a,b)=>a.distance-b.distance)[0]
    if(!threat)return 'skipped'
    this.safety.status='fleeing';this.phase='retreating'
    this.say(`Judged evade: moving away from the ${threat.name} at ${threat.distance} blocks instead of sheltering.`)
    try{await this.execute({action:'flee',goal:{from:threat.position,distance:24},timeoutMs:15000},signal);if(epoch!==this.epoch||signal.aborted)return 'cancelled';(this.safety.flights??=[]).push(structuredClone(this.runner.task.result));this.persist()}
    catch(error){if(epoch!==this.epoch||signal.aborted)return 'cancelled';(this.safety.flights??=[]).push({failed:error.message});this.persist();this.say('Could not get clear: '+error.message+'. Sheltering instead.');return 'skipped'}
    const after=survivalObservation(bot)
    if((after.nearbyThreats||[]).some(t=>t.risk==='potential_hostile'&&t.distance<=16)){this.say('The threat followed me. Sheltering instead.');return 'skipped'}
    return await this.leaveOnOpenGround(epoch,signal,bot,interruptedActiveRequest)
  }
  async leaveOnOpenGround(epoch,signal,bot,interruptedActiveRequest) {
    const s=survivalObservation(bot),near=(s.nearbyThreats||[]).filter(t=>t.risk==='potential_hostile'&&t.distance<=16),lone=near.length===1?near[0]:null
    if(!(s.timeOfDay>=1000&&s.timeOfDay<12000)||!(s.health>=12))return 'skipped'
    // Open ground is only better than a hole if nothing is already on the bot.
    // A daylight spider counts as conditional, but it still bites: one chased
    // the agent through a flight from 20 health to 0.
    if((s.nearbyThreats||[]).some(t=>t.distance<=5))return 'skipped'
    const flights=this.safety.flights||[],fled=flights.some(f=>!f.failed)
    // Two ways to stay out here instead of trekking home: sprint clear of a lone
    // mob this pass, or, having already sprinted (a creeper), find nothing in range.
    const sprint=!fled&&lone&&DEFENDABLE_MOBS.has(lone.name)&&flights.length<2?lone:null
    if(!sprint&&!(fled&&!near.length))return 'skipped'
    if(sprint){
      this.safety.status='fleeing';this.phase='retreating'
      this.say(`Daylight, with a lone ${sprint.name} ${sprint.distance} blocks away that I cannot strike. Moving to open ground instead of digging in.`)
      try{await this.execute({action:'flee',goal:{from:sprint.position,distance:24},timeoutMs:15000},signal);if(epoch!==this.epoch||signal.aborted)return 'cancelled';(this.safety.flights??=[]).push(structuredClone(this.runner.task.result));this.persist()}
      catch(error){if(epoch!==this.epoch||signal.aborted)return 'cancelled';(this.safety.flights??=[]).push({failed:error.message});this.persist();return 'skipped'}
    }else this.say('I sprinted clear and nothing is near me in daylight. Watching the area instead of walking back to base.')
    const request=this.requestProgress,safety=this.safety,connection=this.runner.connectionId
    const check=()=>{
      if(signal.aborted||epoch!==this.epoch||this.safety!==safety)throw new Error('Open-ground watch cancelled')
      if(!this.runner.ready||this.runner.bot!==bot||this.runner.connectionId!==connection)throw new Error('Connection changed on open ground')
    }
    const {quietMs=10000,limitMs=45000}=this.openGroundWait||{}
    let result
    try{result=await awaitClearance({check,observe:()=>openGroundClearance(bot),quietMs,limitMs,stopOnUnsafe:true,onUpdate:record=>{safety.continuation=record;this.persist();this.emit('change')}})}
    catch(error){if(epoch!==this.epoch||signal.aborted)return 'cancelled';safety.continuation={status:'paused',reason:error.message};this.persist();return 'skipped'}
    if(result.status!=='cleared'){safety.continuation=result;this.persist();this.say('The threat followed me into the open. Sheltering instead.');return 'skipped'}
    safety.continuation=result;safety.status='clear';this.persist()
    const continuing=interruptedActiveRequest&&canResume(request)&&canContinueAfterSafety(request)
    this.safety=null;this.activity='';this.phase=canResume(request)?'blocked':'ready'
    if(continuing){
      ;(request.safetyContinuations??=[]).push({...result,requestId:request.id,connectionId:connection,shelter:'open_ground',resumeSerial:request.resumeSerial||0,completedAt:request.completed?.length||0})
      ;(request.feedback??=[]).push({action:'safety_continuation',status:'completed',result:request.safetyContinuations.at(-1)});this.persist()
      this.say('The threat stayed behind in daylight. I am continuing your saved request.')
      await this.resume({automatic:true})
    }else this.say('The threat stayed behind in daylight. '+(canResume(request)?'Resume is available if the saved request can safely continue.':'Ready for your next instruction.'))
    return 'continued'
  }
  // Last resort with no base and no weapon: dig in, or wall in where the
  // ground cannot be dug. Returns whether a shelter was reached.
  async lastResortShelter(epoch,signal) {
    // Burrow and hut judge the ground under the bot; a sprint or jump leaves it airborne for a moment.
    for(let i=0;i<15&&this.runner.bot?.entity?.onGround===false;i++){await delay(100);if(epoch!==this.epoch||signal.aborted)return false}
    if(!this.safety.retreat){
      const attempt={name:'burrow',status:'trying'};this.safety.attempts.push(attempt);this.persist()
      this.say('No verified shelter is reachable. I am digging in to wait out the danger.')
      try{
        await this.execute({action:'burrow',goal:{},timeoutMs:60000},signal)
        if(epoch!==this.epoch||signal.aborted)return false
        this.safety.retreat=structuredClone(this.runner.task.result);attempt.status='sheltered';this.persist()
      }catch(error){
        if(epoch!==this.epoch||signal.aborted)return false
        attempt.status='rejected';attempt.reason=error.message;this.persist()
        this.dispatch({action:'stop'});await this.runner.waitForIdle?.(signal)
      }
    }
    // Ground that cannot be dug: wall in with carried blocks instead.
    if(!this.safety.retreat){
      const attempt={name:'hut',status:'trying'};this.safety.attempts.push(attempt);this.persist()
      this.say('The ground here cannot be dug. I am walling myself in with carried blocks.')
      try{
        await this.execute({action:'hut',goal:{},timeoutMs:60000},signal)
        if(epoch!==this.epoch||signal.aborted)return false
        this.safety.retreat=structuredClone(this.runner.task.result);attempt.status='sheltered';this.persist()
      }catch(error){
        if(epoch!==this.epoch||signal.aborted)return false
        attempt.status='rejected';attempt.reason=error.message;this.persist()
        this.dispatch({action:'stop'});await this.runner.waitForIdle?.(signal)
      }
    }
    return !!this.safety.retreat
  }
  // Never stand still when every shelter is refused and a threat is near:
  // leave a pit, sprint from the nearest hostile and try the ground there.
  async moveOutOfDanger(epoch,signal,bot) {
    const s=survivalObservation(bot),threat=(s.nearbyThreats||[]).find(t=>t.risk==='potential_hostile')
    const attempt={name:'move',status:'trying'};this.safety.attempts.push(attempt);this.persist()
    this.say('No shelter here. Moving away'+(threat?` from the ${threat.name}`:'')+' before trying again.')
    let climbed=false
    // Ask the descent itself whether there is anywhere to descend to, rather
    // than testing the block underfoot for leaves. A bot on its own placed dirt
    // failed that test and was sent to `climb`, which is how it got up there.
    const descendable=(()=>{try{return canopyLandings(bot).length>0}catch{return false}})()
    try{await this.execute({action:descendable?'descend':'climb',goal:{},timeoutMs:45000},signal);if(epoch!==this.epoch||signal.aborted)return false;climbed=true;attempt[descendable?'descended':'climbed']=structuredClone(this.runner.task.result)}
    catch(error){if(epoch!==this.epoch||signal.aborted)return false;attempt.terrainFailure=error.message;this.dispatch({action:'stop'});await this.runner.waitForIdle?.(signal);if(epoch!==this.epoch||signal.aborted)return false}
    if(!threat){attempt.status=climbed?'moved':'rejected';attempt.reason=climbed?undefined:'No safe terrain exit and no threat to sprint from';this.persist();return climbed}
    try{
      await this.execute({action:'flee',goal:{from:threat.position,distance:24},timeoutMs:15000},signal);if(epoch!==this.epoch||signal.aborted)return false
      const result=structuredClone(this.runner.task.result);(this.safety.flights??=[]).push(result);attempt.status='moved';attempt.moved=result.moved;this.persist();return true
    }catch(error){
      if(epoch!==this.epoch||signal.aborted)return false
      attempt.status=climbed?'moved':'rejected';attempt.reason=error.message;this.persist();this.dispatch({action:'stop'});await this.runner.waitForIdle?.(signal)
      return climbed
    }
  }
  async waitInBurrow(epoch,signal,bot,eligible) {
    const request=this.requestProgress,safety=this.safety,connection=this.runner.connectionId
    if(eligible&&request?.status==='interrupted'){safety.resumeRequestId=request.id;this.persist()}
    const {quietMs=20000,limitMs=14*60*1000,patienceMs,relocateAfterMs,watches=BURROW_WATCHES}=this.burrowWait||{}
    let lingerSince=null
    // The relocate decision is derived from how long the threat has held, so
    // clearing the timer the moment it fires un-decides it on the next poll and
    // the wait oscillates for ever, never accumulating the quiet period it needs.
    // A brief clear reading is still inside the quiet-area verification window.
    // Keep elapsed patience until clearance succeeds; night starts a fresh wait.
    let protectedHealth=bot.health
    const observe=()=>{
      safety.protection=inspectEmergencyShelter(bot)
      if(bot.health<protectedHealth)throw new Error('Health fell inside the emergency shelter; protection is not established')
      protectedHealth=bot.health
      const r=burrowClearance(bot,{lingeredMs:lingerSince?Date.now()-lingerSince:0,patienceMs,relocateAfterMs,exits:shelterExits(safety.retreat)});if(r.lingering||r.confront||r.relocate)lingerSince??=Date.now();else if(r.holding)lingerSince=null;return r}
    const check=()=>{
      if(signal.aborted||epoch!==this.epoch||this.safety!==safety)throw new Error('Burrow wait cancelled')
      if(!this.runner.ready||this.runner.bot!==bot||this.runner.connectionId!==connection)throw new Error('Connection changed while burrowed')
    }
    try{
      // Login can announce spawn before local chunks arrive. Unknown ground is
      // not a destroyed shelter and must not start another excavation.
      if(!bot.blockAt?.(bot.entity.position.floored().offset(0,-1,0))&&bot.waitForChunksToLoad){
        const waiting=new AbortController(),loadedSignal=AbortSignal.any([signal,waiting.signal])
        try{await Promise.race([bot.waitForChunksToLoad(),delay(10000,undefined,{signal:loadedSignal}).then(()=>{throw new Error('Shelter chunks did not load within ten seconds')})]);check()}
        finally{waiting.abort()}
      }
      if(this.shelterPlanning&&eligible&&canResume(request)&&canContinueAfterSafety(request,undefined,{protectedPlanning:true})&&typeof this.planner.sheltered==='function'){
        const planned=await shelteredPlanning(this,epoch,signal,bot,this.shelteredLimits)
        if(planned.status==='cancelled')return
        check()
        if(planned.status==='unsafe'){
          this.safety=null;await this.seekSafety(THREAT_INTERRUPTION,{resumeInterrupted:true});return
        }
        if(planned.status==='departed'){
          ;(request.safetyContinuations??=[]).push({...planned.clearance,requestId:request.id,connectionId:connection,shelter:'planned_departure',resumeSerial:request.resumeSerial||0,completedAt:request.completed?.length||0})
          ;(request.feedback??=[]).push({action:'safety_continuation',status:'completed',result:request.safetyContinuations.at(-1)})
          this.safety=null;this.phase='blocked';this.persist()
          this.say('Departure verified. Continuing with the work plan prepared while sheltered.')
          await this.resume({automatic:true,prepared:planned.prepared});return
        }
      }
      // One expired window used to end the watch for good: sheltered, safe, and
      // waiting for a person to notice. Working unattended that is where the day
      // ends. Keep watching a bounded number of times, carrying the linger clock
      // across so a threat holding station still comes due, before giving up.
      let result
      for(let watch=1;;watch++){
        result=await awaitClearance({check,observe,quietMs,limitMs,onUpdate:record=>{safety.continuation={...record,watch};this.persist();this.emit('change')}})
        check();safety.continuation={...result,watch};this.persist()
        if(result.status==='cleared'||watch>=watches)break
        this.say(`Still no clear area after ${Math.round(limitMs/60000)} minutes. I am staying dug in and watching again.`)
      }
      if(result.status!=='cleared'){this.say('I am staying dug in. Resume is required because daylight and a clear area were not established in time.');return}
      const confront=result.observation?.confront,relocate=result.observation?.relocate
      this.say(confront?`Daylight, and a lone ${confront.name} has lingered ${confront.distance} blocks away. Opening up to confront it.`
        :relocate?`Daylight, and ${relocate.threats.length===1?`a ${relocate.threats[0].name}`:`${relocate.threats.length} hostiles`} will not move on. I cannot take that unarmed and waiting is not working, so I am surfacing and leaving the area.`
        :'Daylight with no hostile nearby. Opening up.')
      await this.execute(safety.retreat.shelterName==='hut'?{action:'unhut',goal:{},timeoutMs:60000}:{action:'unburrow',goal:{surface:safety.retreat.surface},timeoutMs:90000},signal);check()
      safety.exit=structuredClone(this.runner.task.result);this.persist()
      // Surfacing beside a threat that outguns us only helps if we then leave.
      // Opening one wall is not leaving: a shelter four blocks down still needs
      // the pit exit before a sprint has anywhere to go, which is why moving away
      // from danger climbs first everywhere else the harness does it.
      if(relocate){
        try{await this.execute({action:'climb',goal:{},timeoutMs:45000},signal);check()}
        catch(error){check();this.dispatch({action:'stop'});await this.runner.waitForIdle?.(signal);check()}
        try{await this.execute({action:'flee',goal:{from:relocate.from,distance:32},timeoutMs:60000},signal);check()
          safety.relocated=structuredClone(this.runner.task.result);this.persist()}
        catch(error){check();this.say('I could not get clear of them: '+error.message)
          this.dispatch({action:'stop'});await this.runner.waitForIdle?.(signal);check()}
      }
      const continuing=(eligible||safety.resumeRequested)&&canResume(request)&&(safety.resumeRequested||canContinueAfterSafety(request))
      this.safety=null;this.activity='';this.phase=canResume(request)?'blocked':'ready'
      if(continuing){
        ;(request.safetyContinuations??=[]).push({...result,requestId:request.id,connectionId:connection,shelter:safety.retreat.shelterName,resumeRequested:!!safety.resumeRequested,resumeSerial:request.resumeSerial||0,completedAt:request.completed?.length||0})
        ;(request.feedback??=[]).push({action:'safety_continuation',status:'completed',result:request.safetyContinuations.at(-1)});this.persist()
        this.say('Back on the surface. I am continuing your saved request.')
        await this.resume({automatic:true})
      }else this.say('Back on the surface. '+(canResume(request)?'Resume is available if the saved request can safely continue.':'Ready for your next instruction.'))
    }catch(error){
      if(epoch!==this.epoch)return
      safety.status='failed';safety.error=error.message;safety.failedAt=Date.now();safety.protection={verified:false,reason:error.message};this.phase='blocked';this.activity='';this.persist()
      if(!signal.aborted&&this.runner.ready&&this.runner.bot===bot&&this.runner.connectionId===connection)recordRecovery(this,{at:new Date().toISOString(),connectionId:connection,requestId:request?.id||null,action:'shelter_watch',status:'failed',error:error.message,after:recoveryState(bot)})
      this.say('Burrow recovery failed: '+error.message+'. I have stopped; safety is not established.')
    }finally{if(epoch===this.epoch){this.abort=null;this.persist();this.emit('change')}}
  }
  async continueAfterClearance(epoch,signal,bot,recovery={}) {
    const request=this.requestProgress,safety=this.safety,connection=this.runner.connectionId
    const check=()=>{
      if(signal.aborted||epoch!==this.epoch||this.requestProgress!==request||this.safety!==safety)throw new Error('Clearance observation cancelled')
      if(!this.runner.ready||this.runner.bot!==bot||this.runner.connectionId!==connection)throw new Error('Connection changed during clearance observation')
      if(request.status!=='interrupted'||request.reviewRequired||!canContinueAfterSafety(request))throw new Error('Request needs explicit review or continuation')
      recovery.check?.()
    }
    try{
      // Inside the lit base at night the area may read clear while phantoms and
      // the night crowd wait outside: hold until daylight before continuing.
      const night=()=>{const t=survivalObservation(bot).timeOfDay;return Number.isFinite(t)&&(t>=12500||t<1000)}
      // A base retreat records no shelterName, so an equality test on 'base' never
      // matched live and the watch fell back to its ninety-second default.
      const atBase=!safety.retreat.shelterName||safety.retreat.shelterName==='base'
      const observe=()=>{const o=clearanceObservation(bot,this.projects,safety.retreat.shelterName);return o.clear&&atBase&&night()?{clear:false,reason:'Waiting in the lit base for daylight'}:o}
      const limitMs=night()&&atBase?Math.max(recovery.limitMs||0,this.nightHoldMs??NIGHT_HOLD_MS):recovery.limitMs
      const result=await awaitClearance({check,limitMs,maintain:recovery.maintain,observe,onUpdate:record=>{safety.continuation=record;this.persist();this.emit('change')}})
      check();safety.continuation=result;this.persist()
      if(result.status!=='cleared'){this.say('I am staying sheltered. Resume is required because a clear area was not established in time.');return}
      // Record before dispatch so restart, Stop or a second threat cannot create
      // an unbounded continuation loop. submit() re-observes the saved request.
      ;(request.safetyContinuations??=[]).push({...result,requestId:request.id,connectionId:connection,resumeSerial:request.resumeSerial||0,completedAt:request.completed?.length||0});
      (request.feedback??=[]).push({action:'safety_continuation',status:'completed',result:request.safetyContinuations.at(-1)});this.persist()
      this.say('The observed area has stayed clear for 20 seconds. I am continuing your saved request.')
      await this.resume({automatic:true})
    }catch(error){
      if(signal.aborted||epoch!==this.epoch||this.safety!==safety)return
      const review=interruptedEffect(this.runner.task)
      if(review&&this.requestProgress===request){request.reviewRequired=review;request.blocker=review}
      safety.continuation={status:'paused',reason:error.message};this.persist();this.say('Automatic continuation paused: '+error.message+(review?'. Check inventory before giving a new instruction.':'. Resume when ready.'))
    }
  }
  async resume({automatic=false,prepared=null}={}) {
    if(this.snapshot().dead||this.runner.respawnPending)throw new Error('Respawn the agent before resuming a task')
    if(!canResume(this.requestProgress))throw new Error(this.requestProgress?.reviewRequired||'No interrupted request can be resumed. Stop cancels a request; enter a new instruction.')
    // Dug in or walled in: the shelter wait continues the request at daylight
    // with a clear area. An explicit Resume makes that continuation eligible,
    // or re-arms a wait that timed out, instead of planning from underground.
    if(!automatic&&['burrow','hut'].includes(this.safety?.retreat?.shelterName)&&!this.safety.exit&&this.safety.status!=='cancelled'){
      const safety=this.safety;safety.resumeRequested=true;safety.resumeRequestId=this.requestProgress.id;this.phase='blocked';this.persist()
      this.say('I am still dug in. I will continue your request once it is daylight and the area is clear.')
      if(!this.abort){safety.status='burrowed';delete safety.error;const abort=this.abort=new AbortController();void this.waitInBurrow(this.epoch,abort.signal,this.runner.bot,true)}
      return
    }
    const saved=structuredClone(this.requestProgress)
    return this.submit(saved.request,saved,{automatic,prepared})
  }
  // Three recoveries is the right cap for "stuck" and the wrong one for "has
  // been working all afternoon". A run that legitimately mines for hours spent
  // its budget on transient blocks along the way and then parked permanently
  // while still making progress, so observable progress earns it back.
  noteProgress() {
    const now=progressFingerprint(this.snapshot())
    if(this.progressMark===now)return false
    this.progressMark=now
    if(this.requestProgress?.stallContinuations){
      this.requestProgress.stallContinuations=0
      delete this.requestProgress.stallExhausted
      this.persist()
    }
    return true
  }
  // Retry a request that blocked while nothing is actually wrong. Bounded, and
  // it never runs behind a human: a request marked reviewRequired, a dead or
  // disconnected agent, and an exhausted budget all stop it.
  async stallRetry() {
    const request=this.requestProgress
    if(this.phase!=='blocked'||!canResume(request))return false
    if(this.snapshot().dead||!this.runner.ready)return false
    // Sheltered and watching for clearance is not a stall: the watch resumes the
    // request itself when it clears. Retrying over it walked the bot out of a lit
    // base at night three times. A watch that has given up leaves this in charge.
    if(this.safety?.continuation?.status==='watching')return false
    if(!Number.isFinite(this.blockedSince)||Date.now()-this.blockedSince<STALL_RETRY_MS)return false
    const spent=request.stallContinuations||0
    if(spent>=STALL_CONTINUATIONS){
      if(!request.stallExhausted){
        request.stallExhausted=true;this.persist()
        this.say(`Still blocked after ${STALL_CONTINUATIONS} attempts: ${request.blocker||'no progress'}. I have stopped retrying and am waiting for you.`)
      }
      return false
    }
    request.stallContinuations=spent+1;this.blockedSince=null;this.persist()
    this.say(`Blocked and nothing else is wrong, so I am trying again (${spent+1} of ${STALL_CONTINUATIONS}): ${request.blocker||''}`)
    await this.resume({automatic:true}).catch(error=>{request.blocker=error.message;this.persist()})
    return true
  }
  respawn() {
    if(!this.snapshot().dead)throw new Error('The agent is not dead')
    if(this.runner.respawnPending){this.runner.log?.('respawn_ignored',{reason:'controller: respawn already pending'});return}
    this.interrupt('Respawning. Review inventory before resuming the saved request.')
    this.respawning=true
    try{this.runner.respawn();this.say('Respawning at the world spawn or the account\'s saved spawn point. Your previous task stays paused.')}
    catch(e){this.respawning=false;throw e}
  }
  async rememberExperience(epoch,signal) {
    const r=this.requestProgress;if(!r?.goal||r.goal.kind!=='task'||!r.feedback?.length)return
    const evidence=experienceEvidence(r.feedback,r.verification);if(!evidence.length)return
    let reflection={lessons:[]}
    try{if(this.planner.reflect)reflection=await this.planner.reflect(r.goal.summary,evidence,r.verification,signal)}catch(error){if(signal.aborted)return;this.episode?.write('reflection_failed',{reason:error.message})}
    if(epoch!==this.epoch)return
    this.experience.record({requestId:r.id,summary:r.goal.summary,criteria:r.goal.criteria,version:this.runner.bot?.version||'unknown',evidence,reflection,verdict:r.verification?.verdict||'blocked'})
    this.episode?.write('experience_saved',{requestId:r.id,evidence,reflection,verdict:r.verification?.verdict||'blocked'})
  }
  async submit(text,continuation=null,{automatic=false,prepared=null}={}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('Enter a message of 1–2000 characters')
    text = text.trim()
    if (/^(?:please )?(?:stop|stop now|stop bot|cancel|hold on|stop everything|wait)[.!]?$/i.test(text)) { this.say(text, 'user'); this.stop(); return }
    if(/^(?:please )?respawn(?: agent| bot)?[.!]?$/i.test(text)){this.respawn();return}
    if(this.snapshot().dead||this.runner.respawnPending){this.say('Respawn the agent first. Your saved task stays paused until you choose Resume.');return}
    if(!continuation&&/^(?:resume|continue)(?: (?:task|request|the task|the request))?[.!]?$/i.test(text)){await this.resume();return}
    if(!continuation&&/^(?:what(?:'s| is) (?:your progress|the status)|what are you doing|how(?:'s| is) it going|status|progress)[?.!]*$/i.test(text)){
      this.say(text,'user');const r=this.requestProgress,check=r?.verification,milestone=r?.mission?.nodes.find(n=>n.id===r.mission.activeId)
      if(milestone)this.say(`Current milestone: ${milestone.description}. ${r.mission.nodes.filter(n=>n.status==='verified').length}/${r.mission.nodes.length} milestones last verified.${r.mission.requiresObservation?' I will recheck them before continuing.':''}`)
      this.say(r?.status==='running'?`${r.goal?.summary||r.request}. ${this.activity||'Planning the next step'}.${check?` ${check.checks.filter(c=>c.passed).length}/${check.checks.length} goal checks passed.`:''}`:this.phase==='blocked'?`Blocked: ${r?.blocker||'Waiting for a new instruction'}`:'Ready for your next instruction.');return
    }
    // An operator instruction may well have changed the world, so it clears a
    // standoff. An automatic resume has changed nothing, and clearing it there
    // restarts the very recovery cycle the standoff exists to stop.
    this.cancel(['thinking', 'acting','retreating','defending'].includes(this.phase)); this.safety=null; if(!automatic)this.unsafeSignature=null; const epoch = this.epoch; const abort = this.abort = new AbortController()
    const history = this.messages.slice(-12); this.say(continuation?(automatic?'Automatically continuing the saved request: ':'Resume the saved request: ')+text:text, automatic?'assistant':'user'); this.phase = 'thinking'; this.emit('change')
    const episode = this.episode = this.recorder?.start({ request: text, model: this.planner.model, profile: this.runner.profile, minecraftVersion: this.runner.bot?.version || null })
    this.requestProgress=continuation||{id:randomUUID(),request:text,completed:[],pending:[],feedback:[],rounds:0};this.requestProgress.status='running';this.requestProgress.blocker=null
    if(continuation&&!automatic)this.requestProgress.resumeSerial=(continuation.resumeSerial||0)+1
    this.persist()
    const requestTasks=new Set()
    const existingTask=structuredClone(this.runner.task?.kind==='build'?this.runner.task:(this.projects.base?{kind:'build',status:'completed',goal:this.projects.base.build}:this.runner.task))
    const feedback=this.requestProgress.feedback??=[],completedAtStart=this.requestProgress.completed?.length||0
    // Explicit Resume may follow an operator change. Automatic recovery alone
    // does not invalidate resource or route failures from the same request.
    if(continuation&&feedback.length){
      if(!automatic)for(const f of feedback)if(f.status==='failed'&&!f.beforeResume)f.beforeResume=true
      feedback.push({action:'resume',status:'completed',automatic,reason:automatic?'Automatic continuation preserves earlier failure evidence. Compare fresh observations with the failed attempt before retrying; a shelter exit or elapsed time alone does not establish a new resource or route. Choose a different supported approach when its prerequisite remains absent.':'Resumed after a pause. Earlier failures are marked beforeResume and may no longer apply; retry that prerequisite once before treating it as blocked or asking for help.'})
      this.persist()
    }
    let planningRound=0,skillControl=null
    const observe=()=>{
        const { connected, owner, ownerVisible, position, ownerPosition, health, survival, tools, inventory, places, task, lastDeath } = this.snapshot()
        const b=this.runner.bot
        const nearby=nearbyResources(b,[...LOG_ITEMS,'stone','coal_ore','iron_ore','crafting_table'])
        // Completed work from an earlier request cannot fulfill a fresh one.
        // Keep unfinished tasks available for explicitly requested build resume.
        const currentTask=currentRequestTask(task,requestTasks)
        this.verifyGoal()
        const experience=this.experience.retrieve(text,this.requestProgress.goal,b?.version||'unknown')
        this.requestProgress.retrievedExperience=experience.map(e=>e.id);this.persist()
        const observation=expeditionObservation({...(this.threatContextMode==='legacy'?{}:{recovery:recoveryContext(this,b)}),goal:this.requestProgress.goal,verification:this.requestProgress.verification,activeMilestone:missionFocus(this.requestProgress.mission),experience,terrain:this.requestProgress.goal?terrainSummary(b,{near:ownerPosition||position,projects:this.projects}):null,connected,owner,ownerVisible,position,ownerPosition,health,survival,foraging:berryObservation(b),footing:footingObservation(b),world:worldObservation(b,{goal:this.requestProgress.goal,requestedBlocks:this.requestProgress.requestedBlocks}),interactables:interactableObservation(b,{names:useTargetNames(this.requestProgress.goal)}),localTerrain:terrainSummary(b,{projects:this.projects}),tools,inventory,places,task:currentTask,nearby,feedback:feedback.slice(-24),projects:structuredClone(this.projects),existingBuild:existingTask?.kind==='build'?existingTask:null,requestProgress:structuredClone(this.requestProgress),lastDeath,remainingPlanningRounds:PLANNING_ROUNDS-planningRound})
        return observation
    }
    const activeStarted=Date.now();let stagnant=0,lastFingerprint=progressFingerprint(this.snapshot())
    let repeatFailure='',failureCount=0,lastRejection='',rejections=0,invalidPlans=0
    try {
      if(this.skillControlMode==='jev'&&!this.skillSelect&&!this.threatJudge.key)throw new Error('Jev skill control requires the configured TypeSafe key')
      let vacuousRetried=false,contractRejection=null
      for(let attempt=0;attempt<2&&!this.requestProgress.goal&&this.planner.formulate;attempt++){
        const initial={...this.snapshot(),foraging:berryObservation(this.runner.bot),task:currentRequestTask(this.runner.task,requestTasks),terrain:terrainSummary(this.runner.bot,{near:this.snapshot().ownerPosition||this.runner.position(),projects:this.projects}),experience:this.experience.retrieve(text,null,this.runner.bot?.version||'unknown'),...(contractRejection?{contractRejection}:{})}
        const interpreted=await this.planner.formulate(text,initial,history,abort.signal,result=>episode?.write('goal_interpretation',result))
        if(epoch!==this.epoch)return
        if(interpreted){
          const contract=validateContract(interpreted,this.projects)
          const vacuous=vacuousContract(contract,this.snapshot(),this.runner.bot)
          if(vacuous&&!vacuousRetried){
            vacuousRetried=true
            contractRejection=`Your previous completion criteria were rejected: ${vacuous}. Restate them as checkable outcomes of the work itself (health, ate, inventory, tools, slept, delivered, at_base and the rest), never as conditions the current state already meets, and never leave the real outcome in a review criterion.`
            feedback.push({action:'goal_contract',status:'failed',reason:contractRejection})
            this.persist();this.say('That set of completion criteria would pass without doing the work. Restating them.')
            this.requestProgress.goal=null;continue
          }
          this.requestProgress.goal=contract;this.persist()
          if(interpreted.kind!=='task'){this.phase='ready';this.activity='';this.requestProgress.status=interpreted.kind==='question'?'answered':'needs_clarification';this.say(interpreted.summary);episode?.end(this.requestProgress.status);return}
          this.say(interpreted.summary)
        }
      }
      if(this.skillControlMode==='jev'&&this.requestProgress.goal?.kind==='task'){
        const request=this.requestProgress,bot=this.runner.bot,connection=this.runner.connectionId
        request.skillControl??={}
        skillControl=new SkillControl({signal:abort.signal,budget:request.skillControl,persist:()=>this.persist(),
          current:()=>this.epoch===epoch&&this.requestProgress===request&&request.status==='running'&&!request.reviewRequired&&this.runner.ready&&this.runner.bot===bot&&this.runner.connectionId===connection,
          observe,plan:(o,signal)=>this.planner.plan(text,o,history,signal,'',decision=>episode?.write('skill_planning',decision)),
          select:this.skillSelect||((o,options,signal)=>selectSkill(o,options,{signal,key:this.threatJudge.key,model:this.threatJudge.model})),
          eligible:(step,o)=>{
            if(satisfiedStep(step,feedback,o,bot))return false
            if(step.action==='eat'&&(!(o.inventory[step.item]>0)||o.survival?.food===20))return false
            if([...STATION_ACTIONS,...EXPEDITION_ACTIONS].includes(step.action)&&step.action!=='smelt'&&!o.projects.base)return false
            try{if(step.action==='travel')validateObservedTravelGoal(bot,step.target);if(step.action==='construct')enforceProjectIntent(request.goal,step,this.projects)}catch{return false}
            return true
          },trace:(type,data)=>{episode?.write(type,data);this.runner.log?.(type,data)}})
      }
      for(let round=0;round<PLANNING_ROUNDS;round++) {
        if(Date.now()-activeStarted>=ACTIVE_BUDGET_MS)throw new Error('Active planning time limit reached. Progress is saved; use Resume to continue.')
        this.requestProgress.rounds=(this.requestProgress.rounds||0)+1;this.persist()
        planningRound=round
        // One request ran 295 rounds with no goal criterion ever changing state;
        // progressFingerprint refreshes on any movement, so the stagnation stop
        // never fired. Count rounds in which the criteria themselves stood still
        // and halt for review, which stallRetry never resurrects. Once per round,
        // here, so repeated verification inside a round cannot double count.
        this.verifyGoal();const stall=noteCriterionStall(this.requestProgress,this.snapshot().inventory,this.projects)
        if(stall.stalled){
          const missing=this.requestProgress.verification?.missing||[]
          const message=`No goal criterion has changed in ${stall.rounds} planning rounds (last change at round ${stall.since}). Halting rather than looping. Remaining: ${missing.join('; ')}. Send a new instruction to continue.`
          skillControl?.close()
          this.phase='blocked';this.activity='';this.requestProgress.status='blocked';this.requestProgress.pending=[];this.requestProgress.blocker=message;this.requestProgress.reviewRequired=message;this.persist()
          episode?.write('criterion_stall_halt',{rounds:stall.rounds,since:stall.since,missing})
          this.say(message);episode?.end('blocked',{reason:'criterion_stall',rounds:stall.rounds,missing});this.emit('change');return
        }
        const observation=observe(),milestoneId=observation.activeMilestone?.id
        this.phase='thinking';this.emit('change')
        episode?.write('observation', { round, observation: structuredClone(observation) })
        let plan
        try{const cached=round===0&&prepared?.requestId===this.requestProgress.id&&prepared.connectionId===this.runner.connectionId&&Date.now()-prepared.createdAt<90000;plan=validatePlan(skillControl?await skillControl.next():cached?prepared.plan:await this.planner.plan(text,observation,history,abort.signal,'',decision=>episode?.write('decision',{round,...decision})));if(cached&&!skillControl)episode?.write('prepared_plan_used',{requestId:prepared.requestId,connectionId:prepared.connectionId,plan});invalidPlans=0}
        catch(error){if(epoch!==this.epoch)return;if(!error.invalidPlan||++invalidPlans>2)throw error;feedback.push({action:'plan',status:'failed',reason:'Plan validation failed before execution: '+error.message});this.requestProgress.blocker=error.message;this.persist();continue}
        if(epoch!==this.epoch)return
        episode?.write('plan', { round, plan })
        if(!plan.steps.length){
          const verdict=this.verifyGoal()
          if(verdict?.verdict==='needs_work'){
            const signature=JSON.stringify([verdict.checks,progressFingerprint(this.snapshot())]);rejections=signature===lastRejection?rejections+1:1;lastRejection=signature
            if(rejections>=2)throw new Error('Goal still incomplete. '+(plan.reply||this.requestProgress.blocker||verdict.missing.join('; ')))
            feedback.push({action:'goal_check',status:'failed',reason:'Goal unfinished. Reassess the failed prerequisite and use a different supported recovery before requesting help. Remaining requirements: '+verdict.missing.join('; '),explanation:plan.reply,verification:verdict});this.persist();continue
          }
          if(verdict){
            skillControl?.close()
            this.activity='Saving lessons';await this.rememberExperience(epoch,abort.signal);if(epoch!==this.epoch)return
            this.phase='ready';this.activity='';this.requestProgress.status=verdict.verdict==='passed'?'verified':'needs_review';this.requestProgress.pending=[]
            this.say(verdict.verdict==='passed'?(plan.reply||'The goal checks passed.'):'The executable checks passed. Still needs your review: '+verdict.missing.join('; '));episode?.end(this.requestProgress.status,{verification:verdict});return
          }
          const blocked=feedback.at(-1)?.status==='failed'||feedback.at(-1)?.result?.partial===true
          this.phase=blocked?'blocked':'ready';this.activity='';this.requestProgress.status=blocked?'blocked':'reviewed';if(!blocked)this.requestProgress.pending=[]
          const unfinished=feedback.filter(f=>f.action==='build'&&f.status==='failed'&&f.task?.progress?.verifiedBlocks>0&&!feedback.some(done=>done.action==='build'&&done.status==='completed'&&JSON.stringify(done.result?.origin)===JSON.stringify(f.task.goal.origin)))
          const leftovers=[...new Set(unfinished.map(f=>Object.values(f.task.goal.origin).join(', ')))]
          this.say((blocked?`I could not finish: ${feedback.at(-1).reason||feedback.at(-1).result?.needs?.join('; ')||feedback.at(-1).result?.next||'The last expedition is incomplete'}`:(plan.reply||'Ready.'))+(leftovers.length?' Earlier unfinished construction remains at '+leftovers.join('; ')+'.':''));episode?.end(blocked?'blocked':'model_finished', { evidence: 'Model ended planning; overall goal success requires separate verification.', feedback });this.emit('change');return
        }
        this.dispatch({action:'stop'});this.plan=plan.steps
        this.requestProgress.pending=structuredClone(plan.steps);this.persist()
        const labels={travel:s=>`walk to observed ground at ${s.target.x}, ${s.target.y}, ${s.target.z}`,goto:s=>`Going to ${s.target.x},${s.target.y},${s.target.z}${s.target.dig?', digging through':''}`,place_at:s=>`place one ${String(s.item).replaceAll('_',' ')} at ${s.target.x}, ${s.target.y}, ${s.target.z}`,attack:s=>`attack the nearest ${String(s.item).replaceAll('_',' ')}`,collect:s=>`pick up ${s.count} ${s.item?String(s.item).replaceAll('_',' '):'dropped items'} lying nearby`,dig:s=>`Digging ${s.count} blocks toward ${s.target.x},${s.target.y},${s.target.z}`,descend:()=> 'find a checked route down from the canopy',climb:()=> 'climb to an observed exit from this pit',leave_base:()=> 'leave the base and close its door',retreat:()=> 'enter the verified lit base and close its door',harvest:s=>`harvest renewable berries until I carry ${s.count}`,make_obsidian:s=>`turn open lava into obsidian and mine it until I carry ${s.count}`,hunt:s=>`hunt nearby animals for ${s.count} ${String(s.item).replaceAll('_',' ')}`,eat:s=>`eat up to ${s.count} ${s.item.replaceAll('_',' ')} while hungry`,sleep:()=> 'sleep the night through in a bed',use:s=>`use the ${String(s.item).replaceAll('_',' ')} ${s.target?.how==='point'?'in the air at':'on the block at'} ${s.target?.x}, ${s.target?.y}, ${s.target?.z}`,revise:s=>`revise ${s.name} while preserving the rest of its saved structure`,construct:s=>{const r=this.projects[s.name]?.result;return r&&!r.partial?`verify ${s.name} and walk its access routes`:r?Number.isInteger(r.verifiedBlocks)?`continue ${s.name} from ${r.verifiedBlocks} of ${r.totalBlocks} blocks`:`continue ${s.name} after checking its saved prerequisites`:`build ${s.name} and check its access when finished`},prepare:s=>`prepare ${s.count} serviceable ${s.item.replaceAll('_',' ')}`,stow:()=> 'unload excavation rubble into the base chest',prospect:s=>`prospect for ${s.count} ${s.item.replaceAll('_',' ')} and return to base`,return_base:()=>'return along the saved route to base',place:s=>`place a base ${s.item.replaceAll('_',' ')}`,deposit:s=>`store a total of ${s.count} ${s.item.replaceAll('_',' ')} in the base chest`,withdraw:s=>`retrieve ${s.item.replaceAll('_',' ')} until I carry ${s.count}`,smelt:s=>`smelt ${s.item.replaceAll('_',' ')} until I carry ${s.count}`,check_base:()=> 'verify base access, workstations, lighting and storage',remember:s=>`save your location as ${s.name}`,return:s=>`return to ${s.name}`,come:()=> 'come to you',follow:()=> 'follow you',gather:s=>`collect a total of ${s.count} ${resourceLabel(s.item||'oak_log')}`,inspect:()=> 'inspect my surroundings',acquire:s=>`obtain ${s.count} ${s.item.replaceAll('_',' ')}`,give:s=>`hand you ${s.count} ${s.item.replaceAll('_',' ')}`,build:s=>`obtain any missing materials and construct the ${s.design.length}-block design`}
        // Every planner action needs a spoken label; an unlabelled one must not end the round.
        const label=s=>(labels[s.action]||(x=>`${x.action.replaceAll('_',' ')}${x.item?` ${x.count||''} ${String(x.item).replaceAll('_',' ')}`.replace(/\s+/g,' '):''}`))(s)
        this.say('I will '+plan.steps.map(label).join(', then ')+'.');this.phase='acting'
        let failed=false,executed=0
        for(let i=0;i<plan.steps.length;i++) {
          if(epoch!==this.epoch)return
          // A stage boundary or lost prerequisite invalidates the rest of a
          // batch. Re-observe and ask for work on the newly eligible milestone.
          this.verifyGoal()
          if(milestoneId!==missionFocus(this.requestProgress.mission)?.id)break
          this.stepIndex=i;const step=plan.steps[i];this.activity=step.action;this.emit('change')
          episode?.write('action_started', { round, stepIndex: i, step })
          try {
            if(!this.runner.ready)throw new Error('Disconnected; wait for reconnection')
            if(satisfiedStep(step,feedback,this.snapshot(),this.runner.bot)) {
              episode?.write('action_skipped',{round,stepIndex:i,step,reason:'Already satisfied by current state or confirmed delivery receipts'})
              this.requestProgress.pending=plan.steps.slice(i+1);this.persist();continue
            }
            if(step.action==='eat'&&feedback.some(f=>f.action==='eat'&&f.status==='failed'&&f.task?.consumption?.uncertain))throw new Error('Previous consumption is uncertain. Inspect hunger and inventory before a new request.')
            // Keyed on the receipt of a COMPLETED entry, not a failed one: a
            // failed step carries no task for most actions, which is what made
            // the first version of this guard dead code.
            if(step.action==='use'&&feedback.some(f=>f.action==='use'&&f.result?.receipt==='use_effect_unobserved'&&f.result.item===step.item&&JSON.stringify(f.result.target)===JSON.stringify(step.target)))
              throw new Error(`A previous ${step.item} at ${step.target.x}, ${step.target.y}, ${step.target.z} was charged without a confirmed effect. Re-observe that block before using there again.`)
            if(step.action==='give'&&feedback.some(f=>f.action==='give'&&f.step?.item===step.item&&f.status==='failed'&&f.task?.delivery?.attempted))throw new Error('Delivery was already attempted without confirmation. Check receipt before sending more.')
            executed++
            if(this.playingAsOwner() && ['follow','come','give'].includes(step.action))throw new Error('I am playing as your account. Use the app for tasks, or use a second account to follow you and hand you items.')
            if(step.action==='remember') {
              const p=this.runner.bot?.players[this.runner.owner]?.entity?.position
              if(!p)throw new Error('Owner is not visible')
              this.places[step.name]={x:p.x,y:p.y,z:p.z};this.persist()
            } else if(step.action==='follow') {
              if(!this.runner.bot?.players[this.runner.owner]?.entity)throw new Error('Owner is not visible')
              await this.leaveOccupiedShelter(abort.signal)
              if(epoch!==this.epoch)return
              await this.runner.waitForIdle?.(abort.signal)
              if(epoch!==this.epoch||abort.signal.aborted)return
              this.dispatch({action:'follow',player:this.runner.owner})
            } else if(step.action==='inspect') {
              if(step.item){applyInspectBlockRequest(this.requestProgress,step.item);this.persist()}
            } else if(step.action!=='inspect') {
              let command
              if(step.action==='gather'){const sites=projectFootprints(this.projects);command={action:'gather',goal:{item:step.item||'oak_log',count:step.count,...(sites.length?{protectedSites:sites}:{})},timeoutMs:180000}}
              else if(['acquire','prepare','eat','harvest','hunt'].includes(step.action))command={action:step.action,goal:{item:step.item,count:step.count},timeoutMs:600000}
              else if(OBSIDIAN_ACTIONS.includes(step.action))command={action:'make_obsidian',goal:validateObsidianGoal({count:step.count,protectedSites:projectFootprints(this.projects)}),timeoutMs:600000}
              else if(step.action==='travel')command={action:'travel',goal:validateObservedTravelGoal(this.runner.bot,step.target),timeoutMs:180000}
              else if(step.action==='goto')command={action:'goto',goal:validateGotoGoal({...step.target,protectedSites:projectFootprints(this.projects)}),timeoutMs:180000}
              else if(step.action==='dig')command={action:'dig',goal:validateDigGoal({...step.target,count:step.count,protectedSites:projectFootprints(this.projects)}),timeoutMs:120000}
              else if(step.action==='place_at')command={action:'place_at',goal:validatePlaceAtGoal({...step.target,item:step.item,protectedSites:projectFootprints(this.projects)}),timeoutMs:90000}
              else if(step.action==='collect')command={action:'collect',goal:validateCollectGoal({item:step.item||'',count:step.count,protectedSites:projectFootprints(this.projects)}),timeoutMs:120000}
              else if(step.action==='attack')command={action:'attack',goal:validateAttackGoal({type:step.item}),timeoutMs:120000}
              else if(step.action==='use')command={action:'use',goal:validateUseGoal({item:step.item,count:1,expect:step.name,target:step.target,protectedSites:projectFootprints(this.projects)}),timeoutMs:120000}
              else if(['descend','climb'].includes(step.action))command={action:step.action,goal:{},timeoutMs:45000}
              else if(step.action==='sleep')command={action:'sleep',goal:this.projects.base?{project:structuredClone(this.projects.base)}:{},timeoutMs:180000}
              else if(step.action==='give')command={action:'give',goal:{item:step.item,count:step.count-deliveredCount(feedback,step.item)},timeoutMs:30000}
              else if([...STATION_ACTIONS,...EXPEDITION_ACTIONS].includes(step.action)){
                const occupied=step.action==='leave_base'?occupiedAlternative(this.runner.bot,this.projects):null
                if(!this.projects.base&&!occupied&&step.action!=='smelt')throw new Error('No saved base; build or identify a shelter first')
                command={action:step.action,goal:occupied?{shelter:structuredClone(occupied)}:{item:step.item,count:step.count,project:this.projects.base?structuredClone(this.projects.base):null},timeoutMs:600000}
              } else if(['construct','revise'].includes(step.action)) {
                enforceProjectIntent(this.requestProgress.goal,step,this.projects)
                const saved=this.projects[step.name]?.construction
                if(step.action==='construct'&&saved?.origin&&step.design.length&&JSON.stringify(saved.design)!==JSON.stringify(step.design))throw new Error('A construction with a reserved origin must keep its exact blueprint; an unstarted design without an origin may be revised')
                const near=saved?.near||this.runner.bot?.players[this.runner.owner]?.entity?.position||this.runner.position()
                let design=step.design.length?step.design:saved?.design,previousDesign=saved?.previousDesign
                if(step.action==='revise'){
                  if(!saved?.origin)throw new Error('Revision requires an existing project with a saved origin')
                  if(saved.previousDesign&&(this.projects[step.name].status!=='completed'||this.projects[step.name].result?.partial===true))throw new Error('Continue the pending revision with construct and an empty design before another edit')
                  previousDesign=saved.design;design=reviseArchitecture(saved.design,step.design)
                }
                command={action:'construct',goal:{name:step.name,design,...(previousDesign?{previousDesign}:{}),near:{x:near.x,y:near.y,z:near.z},...(saved?.origin?{origin:saved.origin}:{protectedSites:projectFootprints(this.projects),constructionLimits:constructionLimits(this.requestProgress.goal,step.name)})},timeoutMs:600000}
              } else if(step.action==='build') {
                const site=buildSiteAnchor(this.runner)
                if(!site)throw new Error('Position is unknown; cannot choose a build site')
                const near=site.near
                if(site.anchor==='agent')this.say('You are not in view, so I am choosing a shelter site near me.')
                const shelter=this.requestProgress?.goal?.criteria?.some(c=>c.kind==='shelter')||step.name==='shelter'||/\b(?:build|make|construct|repair|fix|finish|improve|upgrade)\s+(?:(?:me|a|an|the|this|my|our|existing|small|wooden|starter|usable)\s+){0,6}(?:house|home|shelter|hut|cabin)\b/i.test(text)
                const repairExisting=/\b(repair|improve|fix|finish|this|existing)\b/i.test(text)
                const prior=feedback.findLast(f=>f.action==='build'&&f.status==='failed'&&f.task?.goal?.origin&&designKey(f.task?.goal?.design)===designKey(step.design)) || (existingTask?.kind==='build'&&(['failed','paused','running','cancelled'].includes(existingTask.status)||repairExisting)&&designKey(existingTask.goal.design)===designKey(step.design)?{task:existingTask}:null)
                command={action:'build',goal:{design:step.design,...(shelter?{purpose:'shelter'}:{}),near:{x:near.x,y:near.y,z:near.z},...(function(){
                  // A shelter build with a saved base repairs that base. Searching for a
                  // fresh site abandons a lit, furnished one: the new origin wipes the
                  // station records, and 140 of 143 'no recorded light' refusals in a
                  // single session followed exactly that. Only a base within reach can
                  // be tonight's shelter, though: anchoring to one 387 blocks away walked
                  // the agent to a site that had gone stale, and the contract that
                  // mandates the build action forbids named construction as a fallback.
                  const base=this.projects.base?.build
                  const saved=shelter&&base?.origin&&withinBuildReach(near,base.origin)?base:null
                  const from=prior?.task?.goal?.origin?prior.task.goal:saved
                  return from?{origin:from.origin,...(from.wood?{wood:from.wood}:{})}:{protectedSites:projectFootprints(this.projects)}
                }).call(this)},timeoutMs:600000}
              } else {
                const p=step.action==='come'?this.runner.bot?.players[this.runner.owner]?.entity?.position:this.places[step.name]
                if(!p)throw new Error('That location is unavailable. Come into view or name a saved place.')
                // The pathfinder searches a bounded region, so one goto across a
                // hundred blocks reports no route where an easy walk exists. Cross
                // real distances in stages instead.
                const here=this.runner.position()
                const far=here&&Math.hypot(p.x-here.x,p.z-here.z)>64
                command=step.action==='come'?{action:'travel',goal:{x:p.x,y:p.y,z:p.z,player:this.runner.owner},timeoutMs:180000}:far?{action:'travel',goal:{x:p.x,y:p.y,z:p.z},timeoutMs:600000}
                             :{action:'navigate',goal:{x:p.x,y:p.y,z:p.z},timeoutMs:120000}
              }
              await this.execute(command,abort.signal,id=>{requestTasks.add(id);this.requestProgress.inFlight={taskId:id,step};this.persist()})
            }
            if(epoch!==this.epoch)return
            const result=['come','gather','acquire','build','construct','revise','give','eat','harvest','hunt','sleep','descend','climb','travel','goto','dig','place_at','collect','attack','use',...PREPARE_ACTIONS,...OBSIDIAN_ACTIONS,...STATION_ACTIONS,...EXPEDITION_ACTIONS].includes(step.action)?structuredClone(this.runner.task?.result||null):null
            feedback.push({action:step.action,step,taskId:this.requestProgress.inFlight?.taskId,status:'completed',result,inventory:this.snapshot().inventory,...(['build','construct','revise'].includes(step.action)?{task:structuredClone(this.runner.task)}:{})})
            this.requestProgress.completed.push({step,result,taskId:this.requestProgress.inFlight?.taskId});this.requestProgress.inFlight=null;this.requestProgress.pending=plan.steps.slice(i+1);this.requestProgress.blocker=null;this.verifyGoal();this.persist()
            episode?.write('action_result', { round, stepIndex: i, step, outcome: feedback.at(-1), evidence: step.action==='follow'?'Follow started; continued proximity is not independently verified.':'Executor/client observation; no independent server verification.' })
            // A returned expedition may have only part of its resource target.
            // Let the planner repair prerequisites before dependent steps run.
            if(result?.partial)break
          } catch(error) {
            if(epoch!==this.epoch)return
            const signature=JSON.stringify([step,error.message,progressFingerprint(this.snapshot())])
            failureCount=signature===repeatFailure?failureCount+1:1;repeatFailure=signature
            feedback.push({action:step.action,step,status:'failed',reason:error.message,inventory:this.snapshot().inventory,task:structuredClone(this.runner.task)})
            this.requestProgress.blocker=error.message;this.requestProgress.reviewRequired=interruptedEffect(this.runner.task);this.persist()
            episode?.write('action_result', { round, stepIndex: i, step, outcome: feedback.at(-1), evidence: 'Executor/client observation' })
            if(step.action==='give'&&this.runner.task?.delivery?.attempted||['deposit','withdraw','stow'].includes(step.action)&&this.runner.task?.transfer?.uncertain)throw error
            const adaptive=plan.steps.some(s=>['come','acquire','build','construct','revise','inspect','give','eat','harvest','hunt','sleep','descend','climb','travel','goto','dig','place_at','collect','attack','use',...PREPARE_ACTIONS,...OBSIDIAN_ACTIONS,...STATION_ACTIONS,...EXPEDITION_ACTIONS].includes(s.action))
            if(!adaptive||failureCount>=2)throw error
            this.dispatch({action:'stop'});this.say(`Blocked: ${error.message}. I will inspect the result and revise the plan.`);failed=true;break
          }
        }
        if(epoch!==this.epoch)return
        if(executed||failed)skillControl?.outcome(feedback.at(-1))
        if(!executed&&!failed&&!this.requestProgress.goal){this.phase='ready';this.activity='';this.requestProgress.status='steps_completed';this.requestProgress.pending=[];this.say('I checked those steps; they are already satisfied.');episode?.end('actions_finished',{feedback});this.emit('change');return}
        const fingerprint=progressFingerprint(this.snapshot());stagnant=fingerprint===lastFingerprint?stagnant+1:0;lastFingerprint=fingerprint
        if(stagnant>=3)throw new Error('No observed progress for three planning rounds. Progress is saved; resolve the blocker and Resume.')
        if(this.requestProgress.goal||failed||plan.steps.some(s=>['come','use','goto','dig','place_at','collect','attack','acquire','build','construct','revise','inspect','give','eat','harvest','hunt','sleep','descend','climb','travel',...PREPARE_ACTIONS,...OBSIDIAN_ACTIONS,...STATION_ACTIONS,...EXPEDITION_ACTIONS].includes(s.action))){this.phase='thinking';continue}
        this.phase='ready';this.activity='';this.stepIndex=plan.steps.length
        this.requestProgress.status='steps_completed';this.requestProgress.pending=[]
        this.say(plan.steps.at(-1).action==='follow'?'I am following you.':`Finished. ${plan.steps.some(s=>s.action==='gather')?`I have ${resourceCount(this.snapshot().inventory,plan.steps.find(s=>s.action==='gather').item||'oak_log')} logs.`:'Ready for the next task.'}`)
        episode?.end('actions_finished', { evidence: 'Executor reported completion; overall goal success requires separate verification.', feedback });this.emit('change');return
      }
      throw new Error('Planning limit reached after 24 rounds. Progress is saved; use Resume to continue.')
    } catch(e) {
      skillControl?.close()
      if(epoch!==this.epoch)return
      if(this.phase==='acting')this.dispatch({action:'stop'})
      this.requestProgress.status='blocked';this.requestProgress.blocker=e.message
      this.verifyGoal()
      this.persist()
      await this.rememberExperience(epoch,abort.signal);if(epoch!==this.epoch)return
      this.phase='blocked';this.activity='';this.say(`I could not finish: ${e.message==='fetch failed'?'The selected model could not be reached. Check its connection in Models.':e.message}`)
      episode?.end('blocked', { reason: e.message, feedback })
      if(shouldRetryPlanning(this.requestProgress,completedAtStart,e.message)&&canResume(this.requestProgress)){
        this.requestProgress.planRetries=(this.requestProgress.planRetries||0)+1;this.persist()
        this.say('The planner did not answer in time. Nothing has been tried yet, so I am asking it again.')
        try{await this.resume({automatic:true})}catch(error){if(epoch!==this.epoch)return;this.requestProgress.blocker=error.message;this.persist()}
      }
      else if(shouldContinueAfterBudget(this.requestProgress,completedAtStart,e.message)&&canResume(this.requestProgress)){
        this.requestProgress.budgetContinuations=(this.requestProgress.budgetContinuations||0)+1;this.persist()
        this.say('Steps were still completing when the budget ran out. Continuing the saved request automatically.')
        try{await this.resume({automatic:true})}catch(error){if(epoch!==this.epoch)return;this.requestProgress.blocker=error.message;this.persist()}
      }
    } finally { skillControl?.close() }
  }

  async leaveOccupiedShelter(signal,destinationName=null){
      const occupied=insideBase(this.runner.bot,this.projects.base)?{name:'base',project:this.projects.base}:occupiedAlternative(this.runner.bot,this.projects)
      if(occupied&&occupied.name!==destinationName){
        const goal=occupied.name==='base'?{project:structuredClone(occupied.project)}:{shelter:structuredClone(occupied)}
        await this.execute({action:'leave_base',goal,timeoutMs:30000},signal)
        if(signal.aborted)throw new Error('Cancelled')
        if(this.requestProgress?.status==='running'){
          const step={action:'leave_base',name:occupied.name,item:'',count:0,design:[]},result=structuredClone(this.runner.task.result)
          this.requestProgress.feedback.push({action:'leave_base',step,taskId:this.runner.task.id,status:'completed',result,automatic:true})
          this.requestProgress.completed.push({step,result,taskId:this.runner.task.id});this.persist()
        }
      }
  }
  async execute(command, signal, started = () => {}) {
    const tracked=!!this.safety&&['defend','flee','retreat','burrow','hut','climb','descend'].includes(command.action)
    const bot=this.runner.bot,connectionId=this.runner.connectionId,requestId=this.requestProgress?.id||null
    const before=tracked?recoveryState(bot):null,at=new Date().toISOString(),expectation=this.safety?.adaptiveDecision?.expectation||null
    let outcome='completed',reason=null
    try{return await Teammate.prototype.executeCommand.call(this,command,signal,started)}
    catch(error){outcome=signal.aborted?'cancelled':'failed';reason=error.message;throw error}
    finally{if(tracked&&this.runner.bot===bot&&this.runner.connectionId===connectionId)recordRecovery(this,{at,connectionId,requestId,action:command.action,expectation,status:outcome,reason,before,after:recoveryState(bot)})}
  }
  async executeCommand(command, signal, started = () => {}) {
    await this.runner.waitForIdle?.(signal)
    const deferredDeparture=['acquire','prepare'].includes(command.action)&&insideBase(this.runner.bot,this.projects.base)
    // The checked door exit is for work. A safety action never walks out of a
    // shelter first: fleeing a creeper at the door used to open the door on it.
    if(!deferredDeparture&&!['defend','eat','craft','stop','leave_base','burrow','unburrow','flee','hut','climb','descend'].includes(command.action))await this.leaveOccupiedShelter(signal,command.action==='retreat'?(command.goal?.shelter?.name||'base'):null)
    return new Promise((resolve, reject) => {
      let taskId
      const cleanup = () => { this.runner.off('event', handler); signal.removeEventListener('abort', onAbort) }
      const onAbort = () => { cleanup(); reject(new Error('Cancelled')) }
      const handler = e => { if (e.type !== 'task_finished' || e.task?.id !== taskId) return; cleanup(); e.task.status === 'completed' ? resolve() : reject(new Error(e.task.reason || 'Task failed')) }
      this.runner.on('event', handler); signal.addEventListener('abort', onAbort, { once: true })
      try { if (signal.aborted) return onAbort(); this.dispatch(command); taskId = this.runner.task.id;started(taskId) } catch (e) { cleanup(); reject(e) }
    })
  }
}
