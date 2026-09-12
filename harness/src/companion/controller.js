import {THREAT_INTERRUPTION,clearanceObservation,awaitClearance} from './hazard-clearance.js'
import {alternativeShelters,occupiedAlternative} from '../alternate-shelter.js'
import {setTimeout as delay} from 'node:timers/promises'
import {survivalObservation,emergencyReason,WATER_EMERGENCY} from '../survival.js'
import {burrowClearance} from '../burrow.js'
import {defenseDecision,combatClearance} from '../combat.js'
import {projectFootprints} from '../site-survey.js'
import {reviseArchitecture} from '../construction.js'
import {evaluateGoal,enforceProjectIntent,validateContract,constructionLimits} from './goal-contract.js'
import {ExperienceStore,experienceEvidence} from './experience.js'
import {PLANNING_ROUNDS,ACTIVE_BUDGET_MS,canResume,progressFingerprint,interruptedEffect} from './continuity.js'
import {PREPARE_ACTIONS} from '../supplies.js'
import {EXPEDITION_ACTIONS,remainingDurability,expeditionObservation} from '../prospecting.js'
import {STATION_ACTIONS} from '../stations.js'
import {nearbyResources,terrainSummary} from '../observations.js'
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
    this.safety = null; this.requestProgress = null; this.projects = {};this.experience=new ExperienceStore(join(dirname(statePath),'experience.json'),runner.profile)
    try { const s = JSON.parse(readFileSync(statePath, 'utf8')); if (s.profile === runner.profile) { this.safety=s.safety||null;if(['retreating','defending'].includes(this.safety?.status))this.safety.status='interrupted';this.messages = s.messages.slice(-60); this.places = s.places; this.projects=s.projects||{}; this.requestProgress=s.requestProgress||null; if(this.requestProgress?.status==='running')this.requestProgress.status='interrupted' } }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    if(this.safety?.continuation?.status==='watching')this.safety.continuation={status:'paused',reason:'Service restarted; explicit Resume is required'}
    if(this.requestProgress?.status==='interrupted'&&this.requestProgress.inFlight?.taskId&&this.requestProgress.inFlight.taskId===runner.task?.id&&runner.task.status==='completed'){
      const {step,taskId}=this.requestProgress.inFlight,result=structuredClone(runner.task.result||null)
      if(!(this.requestProgress.feedback||[]).some(f=>f.taskId===taskId)){
        (this.requestProgress.feedback??=[]).push({action:step.action,step,taskId,status:'completed',result})
        this.requestProgress.completed.push({step,result,taskId})
      }
      this.requestProgress.inFlight=null
    }
    if(this.requestProgress?.status==='interrupted'){this.requestProgress.reviewRequired=interruptedEffect(runner.task);this.requestProgress.blocker=this.requestProgress.reviewRequired||'Service restarted. Resume to re-observe and continue.';this.phase='blocked'}
    if(runner.task?.kind==='build'&&runner.task.goal?.origin&&!this.projects.base)this.projects.base={build:structuredClone(runner.task.goal),stations:{}}
    if(runner.task?.kind==='construct'&&runner.task.goal?.name)this.projects[runner.task.goal.name]={construction:structuredClone(runner.task.goal),progress:runner.task.progress,result:runner.task.result,status:runner.task.status}
    if(runner.task?.goal?.project)this.projects.base=structuredClone(runner.task.goal.project)
    runner.on('operator_command', c => { if (!this.dispatching && c.action !== 'status') { this.cancel(false);if(c.action==='stop'){this.safety={status:'cancelled',reason:'Operator stop'};if(canResume(this.requestProgress))this.requestProgress.status='cancelled';this.persist()} } })
    runner.on('event', e => {
      if(e.type==='survival_tick'&&runner.ready){
        const observation=survivalObservation(runner.bot),reason=emergencyReason(observation)
        if(this.safety?.reason===WATER_EMERGENCY&&['failed','afloat'].includes(this.safety.status)&&observation.headSubmerged===false&&observation.inWater===false&&runner.bot.entity.onGround){
          this.safety=null;this.activity='';runner.bot.clearControlStates();this.phase=canResume(this.requestProgress)?'blocked':'ready'
          if(canResume(this.requestProgress))this.requestProgress.blocker='On dry ground. Review current inventory before resuming the saved task.'
          this.say('I am on dry ground and can breathe. The saved task remains paused.')
        }
        if(reason&&(!this.safety||reason===WATER_EMERGENCY&&this.safety.reason!==WATER_EMERGENCY&&this.safety.status!=='cancelled'))void this.seekSafety(reason)
      }
      if(['task_started','task_finished'].includes(e.type)&&e.task?.goal?.project){this.projects.base=structuredClone(e.task.goal.project);this.persist()}
      if(['task_started','task_finished'].includes(e.type)&&e.task?.kind==='construct'&&e.task.goal?.name){this.projects[e.task.goal.name]={construction:structuredClone(e.task.goal),progress:structuredClone(e.task.progress||null),result:structuredClone(e.task.result||null),status:e.task.status};this.persist()}
      if(e.type==='task_finished'&&e.task?.kind==='build'&&e.task.goal?.origin){const sameSite=JSON.stringify(this.projects.base?.build?.origin)===JSON.stringify(e.task.goal.origin);this.projects.base={...(sameSite?this.projects.base:{}),build:structuredClone(e.task.goal),stations:sameSite?(this.projects.base?.stations||{}):{}};this.persist()}
      if (e.type === 'skill_progress') { this.activity = e.message; this.emit('change') }
      if (e.type === 'death') {
        const recovery=['retreating','defending'].includes(this.phase),action=this.phase==='defending'?'defense':'retreat'
        this.cancel(false,'interrupted');this.safety={...this.safety,status:'failed',error:recovery?'Died during '+action:'Agent died',deathPosition:runner.position()};this.phase='blocked'
        if(canResume(this.requestProgress)){this.requestProgress.blocker='The agent died. Respawn first, then review the lost inventory before resuming.';this.persist()}
        this.say('I died. Use Respawn agent to return to the world. The saved request will stay paused; inventory may have been dropped.')
      }
      if(e.type==='spawn'&&this.respawning){this.respawning=false;this.safety=null;this.phase=canResume(this.requestProgress)?'blocked':'ready';if(canResume(this.requestProgress))this.requestProgress.blocker='Respawned. Review current inventory before resuming the saved task.';this.say('I respawned. Check my current inventory before resuming the saved request.')}
    })
  }
  persist() { mkdirSync(dirname(this.statePath), { recursive: true }); writeFileSync(this.statePath + '.tmp', JSON.stringify({ profile: this.runner.profile, places: this.places, messages: this.messages.slice(-60), requestProgress:this.requestProgress,canResume:canResume(this.requestProgress),projects:this.projects,experienceCount:this.experience.entries.length,safety:this.safety }), { mode: 0o600 }); renameSync(this.statePath + '.tmp', this.statePath) }
  say(text, role = 'assistant') { const m = { id: randomUUID(), role, text: String(text).slice(0,2000), at: new Date().toISOString() }; this.messages.push(m); this.messages = this.messages.slice(-60); this.persist(); this.emit('change'); return m }
  playingAsOwner() { return !!this.runner.bot?.username && this.runner.bot.username.toLowerCase() === this.runner.owner.toLowerCase() }
  snapshot() {
    const b = this.runner.bot, owner = this.playingAsOwner() ? null : b?.players?.[this.runner.owner]?.entity
    const inventory = {}; for (const i of (b?.currentWindow||b?.inventory)?.items() || []) inventory[i.name] = (inventory[i.name] || 0) + i.count
    const dead=!!b&&b.health===0&&b.isAlive===false
    return { phase: this.phase, connected: this.runner.ready, dead, respawning:!!this.runner.respawnPending, connectionId:this.runner.connectionId, owner: this.runner.owner, ownerVisible: !!owner, playingAsOwner:this.playingAsOwner(), position: this.runner.position(), ownerPosition: owner?.position || null,
      health: b?.health ?? null, survival:survivalObservation(b), tools:(b?.inventory?.items()||[]).filter(i=>i.maxDurability).map(i=>({name:i.name,remaining:remainingDurability(i),maximum:i.maxDurability})), inventory, places: this.places, task: this.runner.task, plan: this.plan, stepIndex: this.stepIndex,
      safety:this.safety, activity: this.activity || '', messages: this.messages, model: this.planner.model, requestProgress:this.requestProgress,canResume:!dead&&!this.runner.respawnPending&&!['retreating','defending'].includes(this.phase)&&canResume(this.requestProgress),projects:this.projects,experienceCount:this.experience.entries.length }
  }
  dispatch(command) { this.dispatching = true; try { this.runner.command(command) } finally { this.dispatching = false } }
  cancel(stop = true, disposition = 'cancelled') { if(['retreating','defending'].includes(this.safety?.status))this.safety.status=disposition; ++this.epoch; if(this.requestProgress?.status==='running'){this.requestProgress.status=disposition;this.persist()} this.episode?.end(disposition); this.episode = null; this.abort?.abort(); this.abort = null; this.phase = 'ready'; this.plan = []; this.stepIndex = -1; this.activity = ''; if (stop) this.dispatch({ action: 'stop' }); this.emit('change') }
  stop() { const unfinished=['running','blocked','interrupted','paused'].includes(this.requestProgress?.status);this.cancel();if(unfinished){this.requestProgress.status='cancelled';this.persist()} this.safety={status:'cancelled',reason:'Operator stop'};this.say('Stopped. I will wait for your next instruction.') }
  interrupt(reason='Service stopped. Resume to continue the saved request.') {
    const active=this.requestProgress?.status==='running';this.cancel(false,'interrupted')
    if(active){this.requestProgress.status='interrupted';this.requestProgress.reviewRequired=interruptedEffect(this.runner.task);this.requestProgress.blocker=this.requestProgress.reviewRequired||reason;this.persist()}
  }
  async seekSafety(reason) {
    if(this.safety&&(reason!==WATER_EMERGENCY||this.safety.reason===WATER_EMERGENCY||this.safety.status==='cancelled'))return
    const interruptedActiveRequest=this.requestProgress?.status==='running'
    const previousFollow=this.runner.task?.kind==='follow'&&this.runner.task.status==='running'?this.runner.task.goal.player:null
    this.interrupt('Safety interruption: '+reason)
    const epoch=this.epoch,abort=this.abort=new AbortController()
    this.safety={status:'retreating',reason,startedAt:new Date().toISOString()};this.phase='retreating'
    this.say(reason+'. '+(reason===WATER_EMERGENCY?'I am stopping work and swimming up for air.':reason===THREAT_INTERRUPTION?'I am pausing work and assessing self-defense.':'I am pausing work and looking for a verified lit shelter.'))
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
      const deadline=Date.now()+20000
      while(!this.runner.ready){if(epoch!==this.epoch||abort.signal.aborted)return;if(Date.now()>deadline)throw new Error('Could not reconnect for retreat');await delay(100)}
      if(epoch!==this.epoch||abort.signal.aborted)return
      const recoveryBot=this.runner.bot
      if(recoveryBot?.waitForChunksToLoad){let timer;try{await Promise.race([recoveryBot.waitForChunksToLoad(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Retreat chunks did not load within 15 seconds')),15000)})])}finally{clearTimeout(timer)}}
      if(epoch!==this.epoch||abort.signal.aborted)return
      if(this.runner.bot!==recoveryBot||!this.runner.ready)throw new Error('Connection changed before retreat')
      if(reason===THREAT_INTERRUPTION){
        const decision=defenseDecision(recoveryBot)
        if(decision.engage){
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
      // Last resort with no base and no weapon: dig in, wait for daylight, dig out.
      if(!this.safety.retreat){
        const attempt={name:'burrow',status:'trying'};this.safety.attempts.push(attempt);this.persist()
        this.say('No verified shelter is reachable. I am digging in to wait out the danger.')
        try{
          await this.execute({action:'burrow',goal:{},timeoutMs:60000},abort.signal)
          if(epoch!==this.epoch||abort.signal.aborted)return
          this.safety.retreat=structuredClone(this.runner.task.result);attempt.status='sheltered';this.persist()
        }catch(error){
          if(epoch!==this.epoch||abort.signal.aborted)return
          attempt.status='rejected';attempt.reason=error.message;this.persist()
          this.dispatch({action:'stop'});await this.runner.waitForIdle?.(abort.signal)
        }
      }
      if(!this.safety.retreat)throw new Error('No verified shelter reached. '+this.safety.attempts.map(a=>a.name+': '+a.reason).join('; '))
      if(this.safety.retreat.shelterName==='burrow'){
        this.safety.status='burrowed';this.phase='blocked';this.persist()
        this.say((this.safety.retreat.capped?'I am dug in below the surface with the shaft capped.':'I am dug in below the surface; no cap block was available.')+' I will wait for daylight and a clear area before digging out.')
        await this.waitInBurrow(epoch,abort.signal,recoveryBot,interruptedActiveRequest&&reason===THREAT_INTERRUPTION)
        return
      }
      const food=survivalObservation(this.runner.bot).carriedFood[0]
      if(this.runner.bot.food<20&&food){await this.execute({action:'eat',goal:{item:food.name,count:Math.min(8,food.count)},timeoutMs:30000},abort.signal);if(epoch!==this.epoch)return;this.safety.eating=structuredClone(this.runner.task.result)}
      this.safety.status='sheltered';this.phase=this.requestProgress?.status==='interrupted'?'blocked':'ready'
      const eligible=interruptedActiveRequest&&reason===THREAT_INTERRUPTION&&canResume(this.requestProgress)&&!(this.requestProgress.safetyContinuations?.length)
      this.say('I reached '+(this.safety.retreat.shelterName||'the lit base')+' and closed the door. '+(eligible?'I will watch for a clear area before continuing your request.':this.requestProgress?.status==='interrupted'?'Your request is paused; Resume will re-observe and continue.':'Waiting for your next instruction.'))
      if(eligible)await this.continueAfterClearance(epoch,abort.signal,recoveryBot)

    }catch(error){if(epoch!==this.epoch)return;this.safety.status='failed';this.safety.error=error.message;this.phase='blocked';this.activity='';this.say('Safety recovery failed: '+error.message+'. I have stopped; safety is not established.')}
    finally{if(epoch===this.epoch){this.abort=null;this.persist();this.emit('change')}}
  }
  async waitInBurrow(epoch,signal,bot,eligible) {
    const request=this.requestProgress,safety=this.safety,connection=this.runner.connectionId
    const {quietMs=20000,limitMs=14*60*1000}=this.burrowWait||{}
    const check=()=>{
      if(signal.aborted||epoch!==this.epoch||this.safety!==safety)throw new Error('Burrow wait cancelled')
      if(!this.runner.ready||this.runner.bot!==bot||this.runner.connectionId!==connection)throw new Error('Connection changed while burrowed')
    }
    try{
      const result=await awaitClearance({check,observe:()=>burrowClearance(bot),quietMs,limitMs,onUpdate:record=>{safety.continuation=record;this.persist();this.emit('change')}})
      check();safety.continuation=result;this.persist()
      if(result.status!=='cleared'){this.say('I am staying dug in. Resume is required because daylight and a clear area were not established in time.');return}
      this.say('Daylight with no hostile nearby. Digging back out.')
      await this.execute({action:'unburrow',goal:{surface:safety.retreat.surface},timeoutMs:90000},signal);check()
      safety.exit=structuredClone(this.runner.task.result);this.persist()
      const continuing=eligible&&canResume(request)&&!(request.safetyContinuations?.length)
      this.safety=null;this.activity='';this.phase=canResume(request)?'blocked':'ready'
      if(continuing){
        request.safetyContinuations=[{...result,requestId:request.id,connectionId:connection,shelter:'burrow'}]
        ;(request.feedback??=[]).push({action:'safety_continuation',status:'completed',result:request.safetyContinuations[0]});this.persist()
        this.say('Back on the surface. I am continuing your saved request.')
        await this.resume({automatic:true})
      }else this.say('Back on the surface. '+(canResume(request)?'Resume is available if the saved request can safely continue.':'Ready for your next instruction.'))
    }catch(error){
      if(epoch!==this.epoch)return
      safety.status='failed';safety.error=error.message;this.phase='blocked';this.activity='';this.persist()
      this.say('Burrow recovery failed: '+error.message+'. I have stopped; safety is not established.')
    }finally{if(epoch===this.epoch){this.abort=null;this.persist();this.emit('change')}}
  }
  async continueAfterClearance(epoch,signal,bot,recovery={}) {
    const request=this.requestProgress,safety=this.safety,connection=this.runner.connectionId
    const check=()=>{
      if(signal.aborted||epoch!==this.epoch||this.requestProgress!==request||this.safety!==safety)throw new Error('Clearance observation cancelled')
      if(!this.runner.ready||this.runner.bot!==bot||this.runner.connectionId!==connection)throw new Error('Connection changed during clearance observation')
      if(request.status!=='interrupted'||request.reviewRequired||request.safetyContinuations?.length)throw new Error('Request needs explicit review or continuation')
      recovery.check?.()
    }
    try{
      const result=await awaitClearance({check,limitMs:recovery.limitMs,maintain:recovery.maintain,observe:()=>clearanceObservation(bot,this.projects,safety.retreat.shelterName),onUpdate:record=>{safety.continuation=record;this.persist();this.emit('change')}})
      check();safety.continuation=result;this.persist()
      if(result.status!=='cleared'){this.say('I am staying sheltered. Resume is required because a clear area was not established in time.');return}
      // Record before dispatch so restart, Stop or a second threat cannot create
      // an unbounded continuation loop. submit() re-observes the saved request.
      request.safetyContinuations=[{...result,requestId:request.id,connectionId:connection}];
      (request.feedback??=[]).push({action:'safety_continuation',status:'completed',result:request.safetyContinuations[0]});this.persist()
      this.say('The observed area has stayed clear for 20 seconds. I am continuing your saved request.')
      await this.resume({automatic:true})
    }catch(error){
      if(signal.aborted||epoch!==this.epoch||this.safety!==safety)return
      const review=interruptedEffect(this.runner.task)
      if(review&&this.requestProgress===request){request.reviewRequired=review;request.blocker=review}
      safety.continuation={status:'paused',reason:error.message};this.persist();this.say('Automatic continuation paused: '+error.message+(review?'. Check inventory before giving a new instruction.':'. Resume when ready.'))
    }
  }
  async resume({automatic=false}={}) {
    if(this.snapshot().dead||this.runner.respawnPending)throw new Error('Respawn the agent before resuming a task')
    if(!canResume(this.requestProgress))throw new Error(this.requestProgress?.reviewRequired||'No interrupted request can be resumed. Stop cancels a request; enter a new instruction.')
    const saved=structuredClone(this.requestProgress)
    return this.submit(saved.request,saved,{automatic})
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
  async submit(text,continuation=null,{automatic=false}={}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('Enter a message of 1–2000 characters')
    text = text.trim()
    if (/^(?:please )?(?:stop|stop now|stop bot|cancel|hold on|stop everything|wait)[.!]?$/i.test(text)) { this.say(text, 'user'); this.stop(); return }
    if(/^(?:please )?respawn(?: agent| bot)?[.!]?$/i.test(text)){this.respawn();return}
    if(this.snapshot().dead||this.runner.respawnPending){this.say('Respawn the agent first. Your saved task stays paused until you choose Resume.');return}
    if(!continuation&&/^(?:resume|continue)(?: (?:task|request|the task|the request))?[.!]?$/i.test(text)){await this.resume();return}
    if(!continuation&&/^(?:what(?:'s| is) (?:your progress|the status)|what are you doing|how(?:'s| is) it going|status|progress)[?.!]*$/i.test(text)){
      this.say(text,'user');const r=this.requestProgress,check=r?.verification
      this.say(r?.status==='running'?`${r.goal?.summary||r.request}. ${this.activity||'Planning the next step'}.${check?` ${check.checks.filter(c=>c.passed).length}/${check.checks.length} goal checks passed.`:''}`:this.phase==='blocked'?`Blocked: ${r?.blocker||'Waiting for a new instruction'}`:'Ready for your next instruction.');return
    }
    this.cancel(['thinking', 'acting','retreating','defending'].includes(this.phase)); this.safety=null; const epoch = this.epoch; const abort = this.abort = new AbortController()
    const history = this.messages.slice(-12); this.say(continuation?(automatic?'Automatically continuing the saved request: ':'Resume the saved request: ')+text:text, automatic?'assistant':'user'); this.phase = 'thinking'; this.emit('change')
    const episode = this.episode = this.recorder?.start({ request: text, model: this.planner.model, profile: this.runner.profile, minecraftVersion: this.runner.bot?.version || null })
    this.requestProgress=continuation||{id:randomUUID(),request:text,completed:[],pending:[],feedback:[],rounds:0};this.requestProgress.status='running';this.requestProgress.blocker=null;this.persist()
    const requestTasks=new Set()
    const existingTask=structuredClone(this.runner.task?.kind==='build'?this.runner.task:(this.projects.base?{kind:'build',status:'completed',goal:this.projects.base.build}:this.runner.task))
    const feedback=this.requestProgress.feedback??=[]
    const activeStarted=Date.now();let stagnant=0,lastFingerprint=progressFingerprint(this.snapshot())
    let repeatFailure='',failureCount=0,lastRejection='',rejections=0,invalidPlans=0
    try {
      if(!this.requestProgress.goal&&this.planner.formulate){
        const initial={...this.snapshot(),task:currentRequestTask(this.runner.task,requestTasks),terrain:terrainSummary(this.runner.bot,{near:this.snapshot().ownerPosition||this.runner.position(),projects:this.projects}),experience:this.experience.retrieve(text,null,this.runner.bot?.version||'unknown')}
        const interpreted=await this.planner.formulate(text,initial,history,abort.signal,result=>episode?.write('goal_interpretation',result))
        if(epoch!==this.epoch)return
        if(interpreted){
          this.requestProgress.goal=validateContract(interpreted,this.projects);this.persist()
          if(interpreted.kind!=='task'){this.phase='ready';this.activity='';this.requestProgress.status=interpreted.kind==='question'?'answered':'needs_clarification';this.say(interpreted.summary);episode?.end(this.requestProgress.status);return}
          this.say(interpreted.summary)
        }
      }
      for(let round=0;round<PLANNING_ROUNDS;round++) {
        if(Date.now()-activeStarted>=ACTIVE_BUDGET_MS)throw new Error('Active planning time limit reached. Progress is saved; use Resume to continue.')
        this.requestProgress.rounds=(this.requestProgress.rounds||0)+1;this.persist()
        const { connected, owner, ownerVisible, position, ownerPosition, health, survival, tools, inventory, places, task } = this.snapshot()
        const b=this.runner.bot
        const nearby=nearbyResources(b,[...LOG_ITEMS,'stone','coal_ore','iron_ore','crafting_table'])
        // Completed work from an earlier request cannot fulfill a fresh one.
        // Keep unfinished tasks available for explicitly requested build resume.
        const currentTask=currentRequestTask(task,requestTasks)
        this.requestProgress.verification=evaluateGoal(this.requestProgress.goal,this.snapshot(),b,feedback)
        const experience=this.experience.retrieve(text,this.requestProgress.goal,b?.version||'unknown')
        this.requestProgress.retrievedExperience=experience.map(e=>e.id);this.persist()
        const observation=expeditionObservation({goal:this.requestProgress.goal,verification:this.requestProgress.verification,experience,terrain:this.requestProgress.goal?terrainSummary(b,{near:ownerPosition||position,projects:this.projects}):null,connected,owner,ownerVisible,position,ownerPosition,health,survival,tools,inventory,places,task:currentTask,nearby,feedback:feedback.slice(-24),projects:structuredClone(this.projects),existingBuild:existingTask?.kind==='build'?existingTask:null,requestProgress:structuredClone(this.requestProgress),remainingPlanningRounds:PLANNING_ROUNDS-round})
        this.phase='thinking';this.emit('change')
        episode?.write('observation', { round, observation: structuredClone(observation) })
        let plan
        try{plan=validatePlan(await this.planner.plan(text,observation,history,abort.signal,'',decision=>episode?.write('decision',{round,...decision})));invalidPlans=0}
        catch(error){if(epoch!==this.epoch)return;if(!error.invalidPlan||++invalidPlans>2)throw error;feedback.push({action:'plan',status:'failed',reason:'Plan validation failed before execution: '+error.message});this.requestProgress.blocker=error.message;this.persist();continue}
        if(epoch!==this.epoch)return
        episode?.write('plan', { round, plan })
        if(!plan.steps.length){
          const verdict=evaluateGoal(this.requestProgress.goal,this.snapshot(),b,feedback);this.requestProgress.verification=verdict
          if(verdict?.verdict==='needs_work'){
            const signature=JSON.stringify([verdict.checks,progressFingerprint(this.snapshot())]);rejections=signature===lastRejection?rejections+1:1;lastRejection=signature
            if(rejections>=2)throw new Error('Goal still incomplete. '+(plan.reply||this.requestProgress.blocker||verdict.missing.join('; ')))
            feedback.push({action:'goal_check',status:'failed',reason:'Goal unfinished. Reassess the failed prerequisite and use a different supported recovery before requesting help. Remaining requirements: '+verdict.missing.join('; '),explanation:plan.reply,verification:verdict});this.persist();continue
          }
          if(verdict){
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
        const labels={leave_base:()=> 'leave the base and close its door',retreat:()=> 'enter the verified lit base and close its door',harvest:s=>`harvest renewable berries until I carry ${s.count}`,eat:s=>`eat up to ${s.count} ${s.item.replaceAll('_',' ')} while hungry`,revise:s=>`revise ${s.name} while preserving the rest of its saved structure`,construct:s=>{const r=this.projects[s.name]?.result;return r&&!r.partial?`verify ${s.name} and walk its access routes`:r?`continue ${s.name} from ${r.verifiedBlocks} of ${r.totalBlocks} blocks`:`build ${s.name} and check its access when finished`},prepare:s=>`prepare ${s.count} serviceable ${s.item.replaceAll('_',' ')}`,stow:()=> 'unload excavation rubble into the base chest',prospect:s=>`prospect for ${s.count} ${s.item.replaceAll('_',' ')} and return to base`,return_base:()=>'return along the saved route to base',place:s=>`place a base ${s.item.replaceAll('_',' ')}`,deposit:s=>`store a total of ${s.count} ${s.item.replaceAll('_',' ')} in the base chest`,withdraw:s=>`retrieve ${s.item.replaceAll('_',' ')} until I carry ${s.count}`,smelt:s=>`smelt ${s.item.replaceAll('_',' ')} until I carry ${s.count}`,check_base:()=> 'verify base access, workstations, lighting and storage',remember:s=>`save your location as ${s.name}`,return:s=>`return to ${s.name}`,come:()=> 'come to you',follow:()=> 'follow you',gather:s=>`collect a total of ${s.count} ${resourceLabel(s.item||'oak_log')}`,inspect:()=> 'inspect my surroundings',acquire:s=>`obtain ${s.count} ${s.item.replaceAll('_',' ')}`,give:s=>`hand you ${s.count} ${s.item.replaceAll('_',' ')}`,build:s=>`obtain any missing materials and construct the ${s.design.length}-block design`}
        this.say('I will '+plan.steps.map(s=>labels[s.action](s)).join(', then ')+'.');this.phase='acting'
        let failed=false,executed=0
        for(let i=0;i<plan.steps.length;i++) {
          if(epoch!==this.epoch)return
          this.stepIndex=i;const step=plan.steps[i];this.activity=step.action;this.emit('change')
          episode?.write('action_started', { round, stepIndex: i, step })
          try {
            if(!this.runner.ready)throw new Error('Disconnected; wait for reconnection')
            if(satisfiedStep(step,feedback,this.snapshot(),this.runner.bot)) {
              episode?.write('action_skipped',{round,stepIndex:i,step,reason:'Already satisfied by current state or confirmed delivery receipts'})
              this.requestProgress.pending=plan.steps.slice(i+1);this.persist();continue
            }
            if(step.action==='eat'&&feedback.some(f=>f.action==='eat'&&f.status==='failed'&&f.task?.consumption?.uncertain))throw new Error('Previous consumption is uncertain. Inspect hunger and inventory before a new request.')
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
            } else if(step.action!=='inspect') {
              let command
              if(step.action==='gather')command={action:'gather',goal:{item:step.item||'oak_log',count:step.count},timeoutMs:180000}
              else if(['acquire','prepare','eat','harvest'].includes(step.action))command={action:step.action,goal:{item:step.item,count:step.count},timeoutMs:600000}
              else if(step.action==='give')command={action:'give',goal:{item:step.item,count:step.count-deliveredCount(feedback,step.item)},timeoutMs:30000}
              else if([...STATION_ACTIONS,...EXPEDITION_ACTIONS].includes(step.action)){
                const occupied=step.action==='leave_base'?occupiedAlternative(this.runner.bot,this.projects):null
                if(!this.projects.base&&!occupied)throw new Error('No saved base; build or identify a shelter first')
                command={action:step.action,goal:occupied?{shelter:structuredClone(occupied)}:{item:step.item,count:step.count,project:structuredClone(this.projects.base)},timeoutMs:600000}
              } else if(['construct','revise'].includes(step.action)) {
                enforceProjectIntent(this.requestProgress.goal,step,this.projects)
                const saved=this.projects[step.name]?.construction
                if(step.action==='construct'&&saved?.origin&&step.design.length&&JSON.stringify(saved.design)!==JSON.stringify(step.design))throw new Error('A construction with a reserved origin must keep its exact blueprint; an unstarted design without an origin may be revised')
                const near=saved?.near||this.runner.bot?.players[this.runner.owner]?.entity?.position||this.runner.position()
                let design=step.design.length?step.design:saved?.design,previousDesign=saved?.previousDesign
                if(step.action==='revise'){
                  if(!saved?.origin)throw new Error('Revision requires an existing project with a saved origin')
                  if(saved.previousDesign&&this.projects[step.name].status!=='completed')throw new Error('Continue the pending revision with construct and an empty design before another edit')
                  previousDesign=saved.design;design=reviseArchitecture(saved.design,step.design)
                }
                command={action:'construct',goal:{name:step.name,design,...(previousDesign?{previousDesign}:{}),near:{x:near.x,y:near.y,z:near.z},...(saved?.origin?{origin:saved.origin}:{protectedSites:projectFootprints(this.projects),constructionLimits:constructionLimits(this.requestProgress.goal,step.name)})},timeoutMs:600000}
              } else if(step.action==='build') {
                const near=this.runner.bot?.players[this.runner.owner]?.entity?.position
                if(!near)throw new Error('Owner must be in view to choose a nearby build site')
                const shelter=step.name==='shelter'||/\b(?:build|make|construct|repair|fix|finish|improve|upgrade)\s+(?:(?:me|a|an|the|this|my|our|existing|small|wooden|starter|usable)\s+){0,6}(?:house|home|shelter|hut|cabin)\b/i.test(text)
                const repairExisting=/\b(repair|improve|fix|finish|this|existing)\b/i.test(text)
                const prior=feedback.findLast(f=>f.action==='build'&&f.status==='failed'&&f.task?.goal?.origin&&designKey(f.task?.goal?.design)===designKey(step.design)) || (existingTask?.kind==='build'&&(['failed','paused','running','cancelled'].includes(existingTask.status)||repairExisting)&&designKey(existingTask.goal.design)===designKey(step.design)?{task:existingTask}:null)
                command={action:'build',goal:{design:step.design,...(shelter?{purpose:'shelter'}:{}),near:{x:near.x,y:near.y,z:near.z},...(prior?.task?.goal?.origin?{origin:prior.task.goal.origin,wood:prior.task.goal.wood}:{protectedSites:projectFootprints(this.projects)})},timeoutMs:600000}
              } else {
                const p=step.action==='come'?this.runner.bot?.players[this.runner.owner]?.entity?.position:this.places[step.name]
                if(!p)throw new Error('That location is unavailable. Come into view or name a saved place.')
                command={action:'navigate',goal:{x:p.x,y:p.y,z:p.z},timeoutMs:120000}
              }
              await this.execute(command,abort.signal,id=>{requestTasks.add(id);this.requestProgress.inFlight={taskId:id,step};this.persist()})
            }
            if(epoch!==this.epoch)return
            const result=['gather','acquire','build','construct','revise','give','eat','harvest',...PREPARE_ACTIONS,...STATION_ACTIONS,...EXPEDITION_ACTIONS].includes(step.action)?structuredClone(this.runner.task?.result||null):null
            feedback.push({action:step.action,step,taskId:this.requestProgress.inFlight?.taskId,status:'completed',result,inventory:this.snapshot().inventory,...(['build','construct','revise'].includes(step.action)?{task:structuredClone(this.runner.task)}:{})})
            this.requestProgress.completed.push({step,result,taskId:this.requestProgress.inFlight?.taskId});this.requestProgress.inFlight=null;this.requestProgress.pending=plan.steps.slice(i+1);this.requestProgress.blocker=null;this.persist()
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
            const adaptive=plan.steps.some(s=>['acquire','build','construct','revise','inspect','give','eat','harvest',...PREPARE_ACTIONS,...STATION_ACTIONS,...EXPEDITION_ACTIONS].includes(s.action))
            if(!adaptive||failureCount>=2)throw error
            this.dispatch({action:'stop'});this.say(`Blocked: ${error.message}. I will inspect the result and revise the plan.`);failed=true;break
          }
        }
        if(epoch!==this.epoch)return
        if(!executed&&!failed&&!this.requestProgress.goal){this.phase='ready';this.activity='';this.requestProgress.status='steps_completed';this.requestProgress.pending=[];this.say('I checked those steps; they are already satisfied.');episode?.end('actions_finished',{feedback});this.emit('change');return}
        const fingerprint=progressFingerprint(this.snapshot());stagnant=fingerprint===lastFingerprint?stagnant+1:0;lastFingerprint=fingerprint
        if(stagnant>=3)throw new Error('No observed progress for three planning rounds. Progress is saved; resolve the blocker and Resume.')
        if(this.requestProgress.goal||failed||plan.steps.some(s=>['acquire','build','construct','revise','inspect','give','eat','harvest',...PREPARE_ACTIONS,...STATION_ACTIONS,...EXPEDITION_ACTIONS].includes(s.action))){this.phase='thinking';continue}
        this.phase='ready';this.activity='';this.stepIndex=plan.steps.length
        this.requestProgress.status='steps_completed';this.requestProgress.pending=[]
        this.say(plan.steps.at(-1).action==='follow'?'I am following you.':`Finished. ${plan.steps.some(s=>s.action==='gather')?`I have ${resourceCount(this.snapshot().inventory,plan.steps.find(s=>s.action==='gather').item||'oak_log')} logs.`:'Ready for the next task.'}`)
        episode?.end('actions_finished', { evidence: 'Executor reported completion; overall goal success requires separate verification.', feedback });this.emit('change');return
      }
      throw new Error('Planning limit reached after 24 rounds. Progress is saved; use Resume to continue.')
    } catch(e) {
      if(epoch!==this.epoch)return
      if(this.phase==='acting')this.dispatch({action:'stop'})
      this.requestProgress.status='blocked';this.requestProgress.blocker=e.message
      this.requestProgress.verification=evaluateGoal(this.requestProgress.goal,this.snapshot(),this.runner.bot,feedback)
      await this.rememberExperience(epoch,abort.signal);if(epoch!==this.epoch)return
      this.phase='blocked';this.activity='';this.say(`I could not finish: ${e.message==='fetch failed'?'The selected model could not be reached. Check its connection in Models.':e.message}`)
      episode?.end('blocked', { reason: e.message, feedback })
    }
  }

  async leaveOccupiedShelter(signal,destinationName=null){
      const occupied=occupiedAlternative(this.runner.bot,this.projects)
      if(occupied&&occupied.name!==destinationName){
        await this.execute({action:'leave_base',goal:{shelter:structuredClone(occupied)},timeoutMs:30000},signal)
        if(signal.aborted)throw new Error('Cancelled')
        if(this.requestProgress?.status==='running'){
          const step={action:'leave_base',name:occupied.name,item:'',count:0,design:[]},result=structuredClone(this.runner.task.result)
          this.requestProgress.feedback.push({action:'leave_base',step,taskId:this.runner.task.id,status:'completed',result,automatic:true})
          this.requestProgress.completed.push({step,result,taskId:this.runner.task.id});this.persist()
        }
      }
  }
  async execute(command, signal, started = () => {}) {
    await this.runner.waitForIdle?.(signal)
    if(!['defend','eat','craft','stop','leave_base','burrow','unburrow'].includes(command.action))await this.leaveOccupiedShelter(signal,command.action==='retreat'?command.goal?.shelter?.name:null)
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
