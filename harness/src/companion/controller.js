import {validateUseGoal,interactableObservation,useTargetNames,dimensionOf} from '../use-item.js'
import {addBearing,EYE} from '../eye-of-ender.js'
import {validateStandGoal,STAND} from '../enderman-stand.js'
import {projectDimension,sameDimension,inNether,inEnd} from '../dimension.js'
import {portalRefusal} from '../portal-guard.js'
import {updateMission,syncMissionStatus,missionFocus} from './milestones.js'
import {SkillControl,selectSkill} from './skill-control.js'
import {eatOnClearGround} from './food-recovery.js'
import {keepFoodFloor} from './food-floor.js'
import {validateObservedTravelGoal} from '../travel.js'
import {validateGotoGoal,validateDigGoal} from '../primitives.js'
import {validatePlaceAtGoal,validateCollectGoal,validateAttackGoal} from '../primitives-world.js'
import {berryObservation} from '../foraging.js'
import {shelteredPlanning} from './sheltered-planning.js'
import {adaptiveRecovery} from './adaptive-recovery.js'
import {recoveryContext,recoveryState,recentRecovery,recordRecovery} from './recovery-context.js'
import {THREAT_INTERRUPTION,clearanceObservation,awaitClearance,openGroundClearance} from './hazard-clearance.js'
import {alternativeShelters,occupiedAlternative} from '../alternate-shelter.js'
import {shelteredObservation,inspectRetreatShelter,insideBase,inBackExit,backExitObservation,pressingOutside,departureRefusal} from '../retreat.js'
import {fullCube} from '../construction.js'
import {Vec3} from 'vec3'
import {canopyLandings} from '../canopy.js'
import {setTimeout as delay} from 'node:timers/promises'
// Four expired windows is an hour of watching; past that a person should look.
const BURROW_WATCHES=4
// How far off the nearest hostile must be for a portal room to go up before it arrives.
const PORTAL_ROOM_STANDOFF=6
// How a shelter that will not clear moves away: through the portal when in the
// Nether with one in reach, toward the middle of the island in the End, where
// every way outward ends in the void, otherwise by running from the threats.
export function relocateWay(bot){
 if(inEnd(bot))return 'centre'
 return inNether(bot)&&bot?.findBlock?.({matching:bot.registry?.blocksByName?.nether_portal?.id,maxDistance:48})?'portal':'flee'
}
// Where a move toward 0,0 ends: up to `reach` blocks in, stopping `keep` short of
// the exit fountain, on a cell with ground under it within `climb` of the bot's
// height; a step ending over the void is halved until one does not. Only on the
// main island: from an outer one, inward is the void, so it holds (null), as it
// does when already beside the fountain.
export function centreward(bot,{reach=32,keep=6,main=80,climb=4}={}){
 const p=bot.entity.position,d=Math.hypot(p.x,p.z)
 if(Math.abs(p.x)>=main||Math.abs(p.z)>=main)return null
 const solid=b=>!!b&&fullCube(bot.registry,b.name),open=b=>!!b&&b.boundingBox==='empty'&&!/lava|water/.test(b.name)
 for(let go=Math.min(reach,d-keep);go>=4;go=Math.floor(go/2)){
  const x=Math.round(p.x-p.x/d*go),z=Math.round(p.z-p.z/d*go)
  for(let y=Math.floor(p.y)+climb;y>=Math.floor(p.y)-climb;y--){
   const at=new Vec3(x,y,z)
   if(solid(bot.blockAt(at.offset(0,-1,0)))&&open(bot.blockAt(at))&&open(bot.blockAt(at.offset(0,1,0))))return {x,y,z}
  }
 }
 return null
}
// Shooters the bow takes in one defense before the area is judged.
const RANGED_CHAIN=4
// Firing ports a shelter wait opens without a kill before it moves away (lab run 146).
const PORT_ATTEMPTS=4
const BURN_MS=6000,BURN_CAP_MS=10000
// Melee kills in a row before the area is judged: a big magma cube splits into up to four.
const MELEE_CHAIN=5
// A hostile inside its own interruption radius while the bot is indoors: the
// door does not open for work onto it, and waiting on it is not a stall.
const SAFETY_RETRIES=3
const NIGHT_HOLD_MS=14*60*1000
// A hostile camped outside the base by day: fought if the melee rules engage it; otherwise
// the hold is said again every HOLD_SAY_MS and ends after DAY_HOLD_MS, when the planner gets
// a round (lab run 138: a creeper, a zombie and a spider by the door, and the bot held in
// silence through a whole day, with a bow, 128 arrows and full iron in its pack).
// A Minecraft day is twenty minutes and the hold's daylight (1000 to 12500) under ten, and
// the clock resets at dusk, so a fifteen-minute daylight hold could never end (lab run 139,
// 13 October: it never fired). Five minutes, well inside one day's light.
export const PLAYER_ANSWER_MS=5*60*1000
export const HOLD_SAY_MS=10*60*1000,DAY_HOLD_MS=5*60*1000,DAY_HOLD_FIGHT_HEALTH=12,DAY_HOLD_FIGHT_LEVEL=2
export const DAYLIGHT_MS=(12500-1000)/20*1000
// How far a shelter may be to be walked to in the dark: the saved shelters' own limit.
export const FAR_SHELTER=48
// How far from where it closed the door a restarted bot still counts as in that shelter.
const SHELTER_DRIFT=4
import {survivalObservation,fireObservation,SHOOTERS_ONLY,emergencyReason,threatRadius,CLOSE_FLOORS,WATER_EMERGENCY,FIRE_EMERGENCY,PORTAL_EMERGENCY,NIGHT_EXPOSURE,HEALTH_EMERGENCY,FOOD_EMERGENCY,HEALTH_THREAT_RADIUS,HEALTH_EMERGENCY_LINE,outOfReach,cannotShootYet} from '../survival.js'
// Air, fire and a portal underfoot run their own recovery at once and preempt
// any shelter attempt: each has a clock no shelter stops.
const URGENT=new Set([WATER_EMERGENCY,FIRE_EMERGENCY,PORTAL_EMERGENCY])
// Dropped items despawn after five minutes; walk for them only well inside that.
const KILL_DROP_LIFE_MS=270000
// Walk for what the request wants where recent kills fell, once: only what it asks
// for (lab run 103: bones at night got the bot killed), only while drops last.
// A kill in the Nether is a trip's: kept until fetched or the trip ends (tripEnded), not for
// the drop's life only, since the hut may hold quiet past it first (lab run 156, 15 October).
const recordKill=(c,bot,at)=>(c.killSites??=[]).push({at,time:Date.now(),...(inNether(bot)?{trip:true}:{})})
// within: which sites to walk for now; the rest stay for later. A trip's kills count only
// while the bot is still in the Nether, where they fell.
async function collectKillSites(c,signal,bot,request,within=()=>true){
 const sites=(c.killSites||[]).filter(k=>k.trip?inNether(bot):Date.now()-k.time<KILL_DROP_LIFE_MS)
 c.killSites=sites
 const wanted=wantedDrops(request,bot?.registry).slice(0,8),taken=sites.filter(within)
 if(!taken.length||!wanted.length)return null
 c.killSites=sites.filter(k=>!taken.includes(k))
 try{await c.execute({action:'collect',goal:{item:'',count:64,at:taken.slice(-8).map(k=>k.at),items:wanted},timeoutMs:30000},signal);return structuredClone(c.runner.task.result)}
 catch(error){if(signal.aborted)throw error;c.dispatch({action:'stop'});await c.runner.waitForIdle?.(signal);return {failed:error.message}}
}
// The drop pile is worth going back for even when the trip it fell on is over: an ended
// trip is never resumed, but the bot still comes back for what it dropped.
// A request that can still go on: a finished, stopped or failed one carries no trip.
const LIVE_REQUEST=new Set(['running','blocked','interrupted','paused'])
const comeBackFor=request=>canResume(request)||!!request?.tripEnded
const inventoryOf=bot=>(bot?.inventory?.items?.()||[]).reduce((m,i)=>(m[i.name]=(m[i.name]||0)+i.count,m),{})
export const STOP_HOLD_MS=60000
import {burrowClearance,shelterExits,strongEnoughToLeave,RELOCATE_STANDOFF} from '../burrow.js'
import {roofed} from '../observations.js'
import {inspectEmergencyShelter} from '../shelter-occupants.js'
import {threatReach,threatRoutes} from '../threat-reach.js'
import {defenseDecision,combatClearance,DEFENDABLE_MOBS,meleeWeapon,corneredDecision} from '../combat.js'
import {ThreatJudge,harnessVerdict,wornArmour,forcedInterruption,gateVerdict,chooseResponse} from '../threat-judgement.js'
import {projectFootprints} from '../site-survey.js'
import {reviseArchitecture} from '../construction.js'
import {evaluateGoal,enforceProjectIntent,validateContract,constructionLimits,vacuousContract} from './goal-contract.js'
import {ExperienceStore,experienceEvidence} from './experience.js'
import {PLANNING_ROUNDS,ACTIVE_BUDGET_MS,canResume,progressFingerprint,interruptedEffect,buildSiteAnchor,withinBuildReach,AUTO_RESPAWN_LIMIT,STALL_CONTINUATIONS,STALL_RETRY_MS,shouldContinueAfterBudget,canContinueAfterSafety,canContinueAfterCombat,continuationMark,noteAdvance,wantedItems,wantedDrops,shouldRetryPlanning,noteCriterionStall} from './continuity.js'
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
import {hutSite,portalRoomSpot} from '../hut.js'
import {rangedDefenseDecision,bowCanAnswer} from '../archery.js'
import {onTrip,tripKit,walkOnThreat,portReady,tripPickup,sitesNearHut,PICKUP,PORT_HEALTH,PORT_FOOD} from '../nether-trip.js'
import {deliveredCount,satisfiedStep,currentRequestTask} from './progress.js'

const designKey=design=>JSON.stringify((design||[]).map(b=>[b.x,b.y,b.z,b.block]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]||a[3].localeCompare(b[3])))

// Hurt and below the hunger that heals (18), with food in the bag, while
// nothing else is running: eat during a shelter wait. Family world, 3 October:
// a whole night walled in at health 12 and hunger 17 with 9 berries carried.
// Never more than once in 30 seconds; a failed bite is not a failed wait. A
// module function, not a method: test doubles borrow the prototype's methods.
export async function topUpWhileSheltered(c,signal,bot){
 if(!bot||!(bot.health<20)||!Number.isFinite(bot.food)||bot.food>=18||typeof c.execute!=='function')return false
 if(Date.now()-(c.topUpAt||0)<30000||c.runner?.task?.status==='running')return false
 const food=survivalObservation(bot).carriedFood?.[0];if(!food)return false
 c.topUpAt=Date.now()
 try{await c.execute({action:'eat',goal:{item:food.name,count:Math.min(8,food.count)},timeoutMs:20000},signal)}catch(error){c.runner?.log?.('top_up_failed',{reason:String(error.message).slice(0,120)})}
 return false
}
// Back through the portal hurt, eat before the walk home: below hunger 18 nothing
// heals, and at 20 saturation heals fastest. Lab run 120, 13 October: home at 4.5
// health and hunger 17 with 16 cooked beef carried, a spider killed it two blocks
// from the base door. Two bites at most; a melee mob in reach is the retreat's to
// answer first, and a failed bite is not a failed escape.
export async function eatAfterPortalEscape(c,signal,bot){
 if(!bot||!(bot.health<20)||!Number.isFinite(bot.food)||bot.food>=20||typeof c.execute!=='function')return false
 const s=survivalObservation(bot),food=s.carriedFood?.[0];if(!food)return false
 if(s.nearbyThreats.some(t=>t.risk==='potential_hostile'&&!SHOOTERS_ONLY.has(t.name)&&t.distance<=CLOSE_FLOORS.melee))return false
 try{await c.execute({action:'eat',goal:{item:food.name,count:Math.min(2,food.count)},timeoutMs:10000},signal);return true}
 catch(error){c.runner?.log?.('portal_escape_eat_failed',{reason:String(error.message).slice(0,120)});return false}
}
// A burrow or hut the bot was dug into when the service stopped: the spawn handler resumes its wait.
// Not one it died in (the death handler keeps the retreat), and not a hut with a firing port
// open: re-armed, the wait watched an unclosed hut.
const rearmsOnSpawn=safety=>['burrow','hut'].includes(safety?.retreat?.shelterName)&&!!safety.retreat.surface&&!safety.exit&&!safety.port&&!safety.deathPosition&&!/^(Agent died|Died during)/.test(safety.error||'')
// Lab run 165, 15 October: a deploy restarted the service five seconds into a flee from a
// creeper. The flee came back as `safety` with its status still 'fleeing', and to the tick a
// saved episode is one already being handled, so no alarm ran for nine minutes while
// phantoms, a skeleton and zombies took the bot from 20 to 0; four health alarms logged and
// did nothing. An episode in flight does not survive the process that ran it. Kept: a shelter
// the spawn handler re-arms, a lit shelter reached, and a Stop the tick ends on its own. Not a
// failed recovery: the signature the tick ends a spent one by is not saved, so restored with
// its retries used it stood behind the alarm the same way.
const outlivesRestart=safety=>rearmsOnSpawn(safety)||['sheltered','cancelled'].includes(safety?.status)
export class Teammate extends EventEmitter {
  constructor(runner, planner, statePath, recorder = null) {
    super(); this.runner = runner; this.planner = planner; this.statePath = statePath; this.recorder = recorder
    this.messages = []; this.places = {}; this.phase = 'ready'; this.plan = []; this.stepIndex = -1; this.epoch = 0
    this.skillControlMode=process.env.MC_SKILL_CONTROL==='jev'?'jev':'planner'
    this.shelterPlanning=process.env.MC_SHELTER_PLANNING==='1';this.recoveryHistory=[];this.recoveryMode=process.env.MC_RECOVERY_MODE==='adaptive'?'adaptive':'existing';this.threatContextMode=process.env.MC_THREAT_CONTEXT==='legacy'?'legacy':'rich'
    this.safety = null; this.requestProgress = null; this.projects = {};this.experience=new ExperienceStore(join(dirname(statePath),'experience.json'),runner.profile)
    // Shadow mode: Jev's opinion is logged beside every safety decision and changes nothing yet.
    this.threatJudge=new ThreatJudge({log:(type,data)=>runner.log?.(type,data)})
    try { const s = JSON.parse(readFileSync(statePath, 'utf8')); if (s.profile === runner.profile) { this.recoveryHistory=Array.isArray(s.recoveryHistory)?s.recoveryHistory.slice(-16):[];this.safety=outlivesRestart(s.safety)?s.safety:null;this.messages = s.messages.slice(-60); this.places = s.places; this.projects=s.projects||{}; this.requestProgress=s.requestProgress||null; if(this.requestProgress?.status==='running')this.requestProgress.status='interrupted' } }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    if(this.safety?.continuation?.status==='watching')this.safety.continuation={status:'paused',reason:'Service restarted; explicit Resume is required'}
    // A request blocked before the restart is blocked after it: the stall retry and the
    // indoor holds it owns run only in that phase (lab run 139, 13 October: restarted with
    // a blocked request saved, the bot came back ready and sat silent in its base).
    if(this.requestProgress?.status==='blocked'&&canResume(this.requestProgress))this.phase='blocked'
    // A restart while dug in must not strand the bot underground: resume the wait on spawn.
    this.restoreBurrow=rearmsOnSpawn(this.safety)
    this.restoreSheltered=this.safety?.status==='sheltered'
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
    if(runner.task?.kind==='construct'&&runner.task.goal?.name)this.projects[runner.task.goal.name]={construction:structuredClone(runner.task.goal),progress:runner.task.progress,result:runner.task.result,status:runner.task.status,dimension:this.projects[runner.task.goal.name]?.dimension||dimensionOf(runner.bot)||'overworld'}
    if(runner.task?.goal?.project)this.projects.base=structuredClone(runner.task.goal.project)
    runner.on('operator_command', c => { if (!this.dispatching && c.action !== 'status') { this.cancel(false);if(c.action==='stop'){this.safety={status:'cancelled',reason:'Operator stop',at:Date.now()};if(canResume(this.requestProgress))this.requestProgress.status='cancelled';this.persist()} } })
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
        // Two farm animals within 24 blocks on the surface mark the hunting ground the
        // food floor walks back to (food-floor.js); it moves only 16 or more blocks.
        if(Date.now()-(this.groundAt||0)>=10000&&dimensionOf(runner.bot)==='overworld'&&(observation.nearbyAnimals||[]).filter(a=>a.distance<=24).length>=2){
          this.groundAt=Date.now();const p=runner.bot.entity.position,g=this.places.hunting_ground
          if(!g||g.dimension!=='overworld'||Math.hypot(g.x-p.x,g.z-p.z)>=16){this.places.hunting_ground={x:p.x,y:p.y,z:p.z,dimension:'overworld'};this.persist()}
        }
        // An item the request asks for, won by any means, is progress (lab run 101).
        if(this.requestProgress&&noteAdvance(this.requestProgress,inventoryOf(runner.bot),runner.bot.registry))this.persist()
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
        // Out to the health alarm's radius too, so it judges a hidden hostile by reach as well.
        const pressing=observation.nearbyThreats.filter(t=>t.risk==='potential_hostile'&&t.distance<=Math.max(threatRadius(t.name),HEALTH_THREAT_RADIUS))
        if(pressing.some(t=>t.sightline?.status==='blocked')){const routes=threatRoutes(runner.bot,pressing);pressing.forEach((t,i)=>{t.reach=routes[i].reach;t.routeSteps=routes[i].steps;t.routeAtLeast=routes[i].atLeast})}
        // On a kitted trip a lone mob the fight rule would take, out of sight past arm's reach,
        // is walked on rather than an alarm (nether-trip.js; lab run 148, 15 October: fifteen
        // minutes in the portal-room hut over one wither skeleton behind netherrack).
        const tripRequest=this.requestProgress?.status==='running'||canResume(this.requestProgress)
        const walkOn=onTrip(runner.bot,tripRequest)?pressing.filter(t=>walkOnThreat(runner.bot,t,observation.nearbyThreats)):[]
        for(const t of walkOn)t.walkOn=true
        if(walkOn.length&&Date.now()-(this.walkOnLogAt||0)>=5000){this.walkOnLogAt=Date.now();runner.log?.('threat_walk_on',{threats:walkOn.map(t=>`${t.name}@${t.distance}/${t.verticalOffset}:${t.reach||'-'}${Number.isFinite(t.routeSteps)?'~'+t.routeSteps:Number.isFinite(t.routeAtLeast)?'>='+t.routeAtLeast:''}:${t.sightline?.status||'-'}`)})}
        // Night only matters where the sky is: asked when it is dark and there is no base.
        const underRock=!shelterAvailable&&Number.isFinite(observation.timeOfDay)&&(observation.timeOfDay>=12500||observation.timeOfDay<500)&&roofed(runner.bot)
        // use_portal stands in a portal on purpose; every other way into one is still an emergency.
        const crossing=runner.task?.kind==='use_portal'&&runner.task.status==='running'
        // Once it is stepping in, a hostile does not stop it either: the far side is the escape (run 72).
        // Nor while it steps out of the arrival portal and hops: until that hop the server ignores
        // placements, so cover ordered before it fails (lab run 147, 15 October).
        // A bow duel under way is not stopped by a fireball's flames (lab, 10 October: the
        // blaze was left on 4 health twice); lava, or health at or under half, still is.
        const shooting=runner.task?.kind==='shoot'&&runner.task.status==='running'
        // Nor is cover going up stopped by a fire block a fireball lit (lab run 142, 14
        // October: a hut on a fortress walkway edge, the fire alarm cancelled it to stamp
        // out the flames, and the next fireball's knockback put the bot in the lava below).
        // The hut takes seconds; the flames are stamped out from inside it.
        const covering=['hut','burrow'].includes(runner.task?.kind)&&runner.task.status==='running'
        // Open sky decides whether a hurt, empty-handed bot can go and find food (survival.js).
        const openSky=!!runner.bot?.entity?.position&&!roofed(runner.bot)
        // Idle: nothing running and nothing being planned. Only an idle bot is sent home at night with a base.
        const idle=runner.task?.status!=='running'&&['ready','blocked'].includes(this.phase)
        // A stand provokes endermen on purpose and fights them at its port (enderman-stand.js):
        // they are its work, not an alarm. Anything else hostile, health and fire still are.
        const standing=runner.task?.kind==='stand'&&runner.task.status==='running'
        const raw=emergencyReason({...observation,...(standing?{nearbyThreats:observation.nearbyThreats.filter(t=>t.name!=='enderman')}:{}),shelterAvailable,sheltered,recentDamageMs,roofed:underRock,openSky,idle})
        const reason=crossing&&(raw===PORTAL_EMERGENCY||raw===THREAT_INTERRUPTION&&['entering','leaving_portal','arrival_hop'].includes(runner.work?.stage))?null
         :(shooting||covering)&&raw===FIRE_EMERGENCY&&observation.inLava!==true&&observation.health>HEALTH_EMERGENCY_LINE?null:raw
        // The journal should show the times rock was the reason work carried on.
        // The flood's answer is the evidence for an interruption through rock; without it the log says only that a hostile was "within ten blocks".
        if(reason===THREAT_INTERRUPTION&&pressing.some(t=>t.reach)&&Date.now()-(this.routeLogAt||0)>=5000){this.routeLogAt=Date.now();runner.log?.('threat_route',{threats:pressing.slice(0,4).map(t=>`${t.name}@${t.distance}/${t.verticalOffset}:${t.reach||'-'}${Number.isFinite(t.routeSteps)?'~'+t.routeSteps:Number.isFinite(t.routeAtLeast)?'>='+t.routeAtLeast:''}:${t.sightline?.status||'-'}`)})}
        // What raised the health alarm, as the alarm counted it: the recovery record is
        // taken a moment later and can no longer say (pi2, 10 October, two dawn hunts).
        if(reason===HEALTH_EMERGENCY&&Date.now()-(this.healthLogAt||0)>=5000){this.healthLogAt=Date.now();runner.log?.('health_alarm',{health:observation.health,food:observation.food,timeOfDay:observation.timeOfDay,recentDamageMs,counted:pressing.filter(t=>t.distance<=HEALTH_THREAT_RADIUS&&!outOfReach(t)&&!cannotShootYet(t)).slice(0,4).map(t=>`${t.name}@${t.distance}/${t.verticalOffset}:${t.reach||'-'}${Number.isFinite(t.routeSteps)?'~'+t.routeSteps:Number.isFinite(t.routeAtLeast)?'>='+t.routeAtLeast:''}:${t.sightline?.status||'-'}`)})}
        if(!reason&&pressing.some(t=>t.reach==='sealed')&&Date.now()-(this.sealedLogAt||0)>=30000&&emergencyReason({...observation,nearbyThreats:observation.nearbyThreats.map(t=>({...t,reach:undefined})),shelterAvailable,sheltered,recentDamageMs,roofed:underRock})===THREAT_INTERRUPTION){this.sealedLogAt=Date.now();runner.log?.('threat_sealed',{threats:pressing.slice(0,4).map(t=>`${t.name}@${t.distance}/${t.verticalOffset}:${t.reach}`)})}
        // Stop cancels the recovery in hand and stands while that emergency lasts.
        // Once nothing is wrong it has nothing left to hold: left in place it
        // switched safety off for good, and a stopped bot stood through dusk
        // until a creeper found it.
        // A Stop ends the current work and the current escape; it does not switch
        // survival off for the night. After STOP_HOLD_MS the watch is back even
        // while the danger lasts (3 October: a Stop left the walled-in family bot
        // ignoring night and mobs until morning).
        if(this.safety?.status==='cancelled'&&!Number.isFinite(this.safety.at))this.safety.at=Date.now()
        if(this.safety?.status==='cancelled'&&(!reason||Date.now()-this.safety.at>=STOP_HOLD_MS)){this.safety=null;this.persist()}
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
      if(['task_started','task_finished'].includes(e.type)&&e.task?.kind==='construct'&&e.task.goal?.name){this.projects[e.task.goal.name]={construction:structuredClone(e.task.goal),progress:structuredClone(e.task.progress||null),result:structuredClone(e.task.result||null),status:e.task.status,dimension:this.projects[e.task.goal.name]?.dimension||dimensionOf(runner.bot)||'overworld'};this.persist()}
      // Only a shelter build is the base. Any other build adopted it and wiped the
      // station records, after which every place, deposit and check_base threw and
      // the bot was homeless at dusk.
      // A failed build at the saved base changed nothing it can vouch for, so the
      // saved design stays (lab, 5 October: a failed repair's design, a solid
      // floor across the room and doorway, replaced it, and every retreat then
      // refused the base as malformed).
      // The base is the Overworld's: a shelter built anywhere else never replaces it.
      if(e.type==='task_finished'&&e.task?.kind==='build'&&e.task.goal?.origin&&e.task.goal.purpose==='shelter'&&(dimensionOf(runner.bot)||'overworld')==='overworld'){const sameSite=JSON.stringify(this.projects.base?.build?.origin)===JSON.stringify(e.task.goal.origin),completed=e.task.status==='completed',keep=sameSite&&!completed&&this.projects.base?.build?.design?.length;this.projects.base={...(sameSite?this.projects.base:{}),build:keep?this.projects.base.build:structuredClone(e.task.goal),stations:sameSite?(this.projects.base?.stations||{}):{},built:completed||(sameSite&&this.projects.base?.built===true)};this.persist()}
      // Both ends of each crossing: the way home is the other end of the portal it came through.
      // The last place a hunt killed is where food is: the food floor walks back there (food-floor.js).
      if(e.type==='task_finished'&&e.task?.kind==='hunt'&&e.task.status==='completed'&&e.task.result?.kills>0&&Number.isFinite(e.task.result.position?.x)){const p=e.task.result.position;this.places.hunting_ground={x:p.x,y:p.y,z:p.z,dimension:dimensionOf(runner.bot)||'overworld'};this.persist()}
      // A portal the bot lit is a place it can return to (honest run 2, 14 October: 53
      // blocks from its own lit portal, underground, the bot saw none within its scan
      // and set about building a second one).
      if(e.type==='task_finished'&&e.task?.kind==='use'&&e.task.status==='completed'&&e.task.result?.observed?.name==='nether_portal'&&Number.isFinite(e.task.result.target?.x)){const t=e.task.result.target;this.places.nether_portal={x:t.x,y:t.y,z:t.z,dimension:t.dimension||dimensionOf(runner.bot)||'overworld'};this.persist()}
      // Every watched eye is a bearing toward the stronghold; two that cross are its estimate (eye-of-ender.js).
      if(e.type==='task_finished'&&e.task?.kind==='throw_eye'&&e.task.status==='completed'&&e.task.result?.receipt==='eye_bearing'){this.places.stronghold_bearing=addBearing(this.places.stronghold_bearing,e.task.result);this.persist()}
      if(e.type==='task_finished'&&e.task?.kind==='use_portal'&&e.task.status==='completed'&&e.task.result?.from?.portal&&e.task.result?.to?.portal){const r=e.task.result,link={[r.from.dimension]:r.from.portal,[r.to.dimension]:r.to.portal},pairs=[...(this.projects.portal_link?.pairs||[])],same=pairs.findIndex(p=>p[r.from.dimension]&&Math.abs(p[r.from.dimension].x-r.from.portal.x)+Math.abs(p[r.from.dimension].z-r.from.portal.z)<=4);if(same>=0)pairs[same]={...pairs[same],...link};else pairs.push(link);this.projects.portal_link={pairs};this.persist()}
      // A kitted trip starts at the crossing out with the kit ready. An honest run crosses
      // unkitted and builds its kit over there, and that is no kitted trip. Home again by the
      // planner's own step, kit or no kit, the leg is over and the request goes on: a rod run
      // that spent its arrows walks the rods home and reports done. The safety chain ends its
      // own crossings home (tripEnded).
      if(e.type==='task_finished'&&e.task?.kind==='use_portal'&&e.task.status==='completed'&&this.requestProgress){
        const request=this.requestProgress,to=e.task.result?.to?.dimension,kit=tripKit(runner.bot)
        if(to==='the_nether'&&kit.ready&&(request.status==='running'||canResume(request))){request.kittedTrip={at:new Date().toISOString(),how:'crossed'};this.persist()}
        else if(to==='overworld'&&request.kittedTrip&&request.status==='running'){delete request.kittedTrip;this.persist()}
      }
      if (e.type === 'skill_progress') { this.activity = e.message; this.emit('change') }
      if (e.type === 'death') {
        const recovery=['retreating','defending'].includes(this.phase),action=this.phase==='defending'?'defense':'retreat'
        this.cancel(false,'interrupted');this.safety={...this.safety,status:'failed',error:recovery?'Died during '+action:'Agent died',deathPosition:runner.position()};this.phase='blocked'
        // The drop pile is the only thing worth going back for, and it despawns in
        // five minutes. `safety` already carries deathPosition, but the respawn
        // branch below nulls it before any reader sees it, so keep a copy that
        // survives the clear and reaches observe().
        this.lastDeath={position:runner.position(),dimension:dimensionOf(runner.bot)||'overworld'}
        if(canResume(this.requestProgress)){this.requestProgress.blocker='The agent died. Respawn first, then review the lost inventory before resuming.';this.persist()}
        // A death that ends a trip is said once, by the trip-over line.
        if(!this.tripEnded('I died on it'))this.say('I died. Use Respawn agent to return to the world. The saved request will stay paused; inventory may have been dropped.')
        // The drop pile despawns in five minutes, and on 20 September nobody was
        // watching: the agent sat dead through the whole window and a full kit
        // was lost. Come back automatically while a saved request is still live.
        // At night that same reflex put an empty-handed bot on a spawn point in the
        // dark, three times, onto the mob that was standing there. The drop pile
        // is not coming back from that either: wait for daylight.
        const tod=runner.bot?.time?.timeOfDay,dark=Number.isFinite(tod)&&(tod>=12500||tod<1000)
        if(comeBackFor(this.requestProgress)&&(this.requestProgress.autoRespawns||0)<AUTO_RESPAWN_LIMIT){
          if(dark){this.respawnAtDawn=true;this.watchForDawn();this.say('It is night. I will come back at daylight rather than empty-handed into the dark.')}
          else{
            this.requestProgress.autoRespawns=(this.requestProgress.autoRespawns||0)+1;this.persist()
            try{this.respawn()}catch(error){this.runner.log?.('auto_respawn_failed',{error:error.message})}
          }
        }else if(comeBackFor(this.requestProgress)){
          // Round 3 on pi1 (9 October): killed three times in two minutes at its
          // spawn, the bot then waited for a person who was not there. A whole day
          // lets the crowd move or burn; then it tries again with a fresh budget.
          this.respawnAtDawn=true;this.watchForDawn({nextSunrise:true})
          this.say('I keep getting knocked out here. I will try again at the next sunrise.')
        }
      }
      // A trip's kills and the last shooter seen belong to the dimension they were in.
      if(e.type==='spawn'&&runner.ready){const here=dimensionOf(runner.bot);if(this.lastDimension&&here!==this.lastDimension){this.killSites=(this.killSites||[]).filter(k=>!k.trip);this.shooterSeenAt=null}this.lastDimension=here}
      // Nothing re-arms a lit shelter kept over a restart, so it stands only while the bot is still
      // where it closed the door; anywhere else it would hold the alarm off in the open.
      if(e.type==='spawn'&&this.restoreSheltered&&runner.ready){this.restoreSheltered=false;const at=this.safety?.retreat?.position,p=runner.bot?.entity?.position;if(this.safety?.status==='sheltered'&&!(at&&p&&Math.hypot(at.x-p.x,at.y-p.y,at.z-p.z)<=SHELTER_DRIFT)){this.safety=null;this.persist()}}
      if(e.type==='spawn'&&this.restoreBurrow&&runner.ready){this.restoreBurrow=false;this.phase='blocked';this.safety.status='burrowed';delete this.safety.error;this.persist();const abort=this.abort=new AbortController();this.say('Service restarted while I was dug in. Waiting for daylight before digging out.');void this.waitInBurrow(this.epoch,abort.signal,runner.bot,this.requestProgress?.status==='interrupted')}
      if(e.type==='spawn'&&this.restoreRequest&&runner.ready&&!this.snapshot().dead){this.restoreRequest=false;this.requestProgress.restartContinuations=(this.requestProgress.restartContinuations||0)+1;this.persist();this.say('Service restarted while a request was running. Continuing it automatically.');setTimeout(()=>{this.resume({automatic:true}).catch(error=>{this.requestProgress.blocker=error.message;this.persist()})},1500)}
      // The dimension marks the trip too: the alarm can cancel a crossing that has already
      // carried the bot over, and then no completed use_portal ever says so (lab run 147, 15
      // October: unmarked, the walk home did not end the trip and the stall retry re-crossed).
      if(e.type==='spawn'&&runner.ready&&this.requestProgress){
        const request=this.requestProgress
        if(inNether(runner.bot)&&LIVE_REQUEST.has(request.status)&&!request.kittedTrip&&!request.tripEnded&&tripKit(runner.bot).ready){request.kittedTrip={at:new Date().toISOString(),how:'crossed'};this.persist()}
        else if(dimensionOf(runner.bot)==='overworld'&&request.kittedTrip&&request.status==='running'&&!this.respawning){delete request.kittedTrip;this.persist()}
      }
      if(e.type==='spawn'&&this.respawning){this.respawning=false;this.safety=null;this.phase=canResume(this.requestProgress)?'blocked':'ready';if(canResume(this.requestProgress))this.requestProgress.blocker='Respawned. Review current inventory before resuming the saved task.';this.say(this.requestProgress?.tripEnded&&!canResume(this.requestProgress)?'I respawned. Ready for your next instruction.':'I respawned. Check my current inventory before resuming the saved request.')}
    })
  }
  // A dead player gets no physics ticks, so no survival tick either: the dawn
  // check rode on it and pi2's bot lay dead through a whole day (9 October).
  // Nor does its clock move: through the bridge no time packet reached the dead
  // bot, not even a /time set. So dawn is worked out from the time of death at
  // twenty ticks a second, and a time update that does arrive counts at once.
  // With nextSunrise the budget is spent: only the clock's next dawn counts, a
  // reading of daylight now does not, and the budget starts again.
  watchForDawn({nextSunrise=false}={}) {
    clearInterval(this.dawnTimer)
    const now=()=>this.now?.()??Date.now(),diedAt=now(),tod=this.runner.bot?.time?.timeOfDay
    const dawnAt=Number.isFinite(tod)?diedAt+((25000-tod)%24000)*50:nextSunrise?diedAt+24000*50:Infinity
    this.dawnTimer=setInterval(()=>{
      const stop=()=>{clearInterval(this.dawnTimer);this.dawnTimer=null}
      if(!this.respawnAtDawn)return stop()
      const seen=this.runner.bot?.time?.timeOfDay
      if(!(now()>=dawnAt||!nextSunrise&&Number.isFinite(seen)&&seen>=1000&&seen<12500))return
      this.respawnAtDawn=false;stop()
      if(this.snapshot().dead&&comeBackFor(this.requestProgress)){
        if(nextSunrise)this.requestProgress.autoRespawns=0
        this.requestProgress.autoRespawns=(this.requestProgress.autoRespawns||0)+1;this.persist()
        try{this.respawn()}catch(error){this.runner.log?.('auto_respawn_failed',{error:error.message})}
      }
    },this.dawnPollMs||5000)
    this.dawnTimer.unref?.()
  }
  verifyGoal() {
    const request=this.requestProgress
    if(!request)return null
    request.verification=evaluateGoal(request.goal,this.snapshot(),this.runner.bot,request.feedback||[])
    updateMission(request,request.verification,{connected:this.runner.ready})
    return request.verification
  }
  persist() { syncMissionStatus(this.requestProgress); if(this.requestProgress?.kittedTrip&&!LIVE_REQUEST.has(this.requestProgress.status))delete this.requestProgress.kittedTrip; mkdirSync(dirname(this.statePath), { recursive: true }); writeFileSync(this.statePath + '.tmp', JSON.stringify({ profile: this.runner.profile, places: this.places, messages: this.messages.slice(-60), requestProgress:this.requestProgress,canResume:canResume(this.requestProgress),projects:this.projects,experienceCount:this.experience.entries.length,recoveryHistory:this.recoveryHistory,safety:this.safety }), { mode: 0o600 }); renameSync(this.statePath + '.tmp', this.statePath) }
  // game:false keeps a line out of game chat (the step narration); it still
  // shows in the companion. Everything else is relayed through gameLine.
  say(text, role = 'assistant', { game = true } = {}) { const m = { id: randomUUID(), role, text: String(text).slice(0,2000), at: new Date().toISOString(), ...(game ? {} : { game: false }) }; this.messages.push(m); this.messages = this.messages.slice(-60); this.persist(); this.emit('change'); return m }
  playingAsOwner() { return !!this.runner.bot?.username && this.runner.bot.username.toLowerCase() === this.runner.owner.toLowerCase() }
  // Who the current request is from, when it came from game chat, and who
  // reads the replies: the planner writes its reply and summary for them.
  conversation(){
    const speaker=this.requestProgress?.requester;if(!speaker)return null
    return {speaker,channel:'game chat',audience:this.runner.listening?.current?.audience||null}
  }
  // projects.base says the base was built, not that it still stands. Lab, 5
  // October: a creeper cratered the floor and blew the door out; every retreat
  // refused the base for an hour and the planner, reading built:true, never
  // thought to repair it. This is the retreat's own inspection, as a fact.
  baseCondition(){
    const b=this.runner.bot,base=this.projects.base
    if(!base?.build?.design?.length||base.built===false||typeof b?.blockAt!=='function')return null
    try{inspectRetreatShelter(b,base,{occupants:false});return {usable:true}}
    catch(error){return /: unloaded$/.test(error.message)?{usable:null,reason:'The base is too far away to see from here'}:{usable:false,reason:error.message}}
  }
  snapshot() {
    const b = this.runner.bot, owner = this.playingAsOwner() ? null : b?.players?.[this.runner.owner]?.entity
    const inventory = {}; for (const i of (b?.currentWindow||b?.inventory)?.items() || []) inventory[i.name] = (inventory[i.name] || 0) + i.count
    const dead=!!b&&b.health===0&&b.isAlive===false
    let litShelterVerified=false
    const base=this.projects.base
    if(base?.built===true&&base.stations?.torch?.confirmed===true){try{litShelterVerified=!!inspectRetreatShelter(b,base,{occupants:false})}catch{}}
    return { lastDeath:this.lastDeath??null, skillControl:{mode:this.skillControlMode,budget:this.requestProgress?.skillControl||null}, recovery:{shelterPlanning:!!this.shelterPlanning,mode:this.recoveryMode,context:this.threatContextMode,recentAttempts:recentRecovery(this)},litShelterVerified, threatJudge:{mode:this.threatJudge.enabled?(this.threatJudge.control?'control':'shadow'):'off',model:this.threatJudge.model}, phase: this.phase, connected: this.runner.ready, dead, respawning:!!this.runner.respawnPending, connectionId:this.runner.connectionId, owner: this.runner.owner, ownerVisible: !!owner, playingAsOwner:this.playingAsOwner(), position: this.runner.position(), ownerPosition: owner?.position || null,
      health: b?.health ?? null, survival:survivalObservation(b), footing:footingObservation(b), backExit:backExitObservation(b,base), worn:b?wornArmour(b):[], tools:(b?.inventory?.items()||[]).filter(i=>i.maxDurability).map(i=>({name:i.name,remaining:remainingDurability(i),maximum:i.maxDurability})), inventory, places: this.places, task: this.runner.task, plan: this.plan, stepIndex: this.stepIndex,
      safety:this.safety, conversation:this.conversation(), activity: this.activity || '', messages: this.messages, model: this.planner.model, requestProgress:this.requestProgress,canResume:!dead&&!this.runner.respawnPending&&!['retreating','defending'].includes(this.phase)&&canResume(this.requestProgress),projects:this.projects,experienceCount:this.experience.entries.length }
  }
  dispatch(command) { this.runner.shelterProject=this.projects.base; this.runner.protectedSites=projectFootprints(this.projects,dimensionOf(this.runner.bot)); this.dispatching = true; try { this.runner.command(command) } finally { this.dispatching = false } }
  cancel(stop = true, disposition = 'cancelled') { if(['retreating','defending'].includes(this.safety?.status))this.safety.status=disposition; ++this.epoch; if(this.requestProgress?.status==='running'){this.requestProgress.status=disposition;this.persist()} this.episode?.end(disposition); this.episode = null; this.abort?.abort(); this.abort = null; this.phase = 'ready'; this.plan = []; this.stepIndex = -1; this.activity = ''; if (stop) this.dispatch({ action: 'stop' }); this.emit('change') }
  stop() { const unfinished=['running','blocked','interrupted','paused'].includes(this.requestProgress?.status);this.cancel();if(unfinished){this.requestProgress.status='cancelled';this.persist()} this.safety={status:'cancelled',reason:'Operator stop',at:Date.now()};this.say('Stopped. I will wait for your next instruction.') }
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
          ;(request.safetyContinuations??=[]).push({...result,requestId:request.id,connectionId:this.runner.connectionId,shelter:'left_portal',resumeSerial:request.resumeSerial||0,...continuationMark(request)});this.persist()
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
          ;(request.safetyContinuations??=[]).push({...result,requestId:request.id,connectionId:this.runner.connectionId,shelter:'doused',resumeSerial:request.resumeSerial||0,...continuationMark(request)});this.persist()
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
          ;(request.safetyContinuations??=[]).push({...result,requestId:request.id,connectionId:this.runner.connectionId,...continuationMark(request)})
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
        // The bow answers what melee declines, unless a judge has chosen shelter.
        const ranged=!decision.engage&&(!this.threatJudge?.control||chosen!=='shelter')?rangedDefenseDecision(recoveryBot):null
        // After a kill by either weapon: confirm the area is clear, then resume or report.
        const finishDefense=async action=>{
          // Lab run 101: on 5 health after the kill, the check stood five seconds for a
          // quiet it could never declare and the next blaze's fireball landed. Hurt, go
          // straight to shelter.
          const hurt=combatClearance(recoveryBot);if(hurt.hurt)throw new Error(hurt.reason)
          const clear=await awaitClearance({check:()=>{if(epoch!==this.epoch||abort.signal.aborted||this.runner.bot!==recoveryBot||!this.runner.ready)throw new Error('Defense continuation cancelled')},observe:()=>combatClearance(recoveryBot),quietMs:2000,limitMs:5000,pollMs:100})
          if(epoch!==this.epoch||abort.signal.aborted)return
          if(clear.status!=='cleared')throw new Error(clear.reason)
          const result={...this.safety.combat,clearance:clear},request=this.requestProgress
          // The fight collects its own loot once the area is clear (lab run 101: a
          // self-defense kill's rod stayed on the bricks while the request moved on).
          if(interruptedActiveRequest){
            const collected=await collectKillSites(this,abort.signal,recoveryBot,request)
            if(epoch!==this.epoch||abort.signal.aborted)return
            if(collected)result.collected=collected
          }
          if(request)(request.feedback??=[]).push({action,status:'completed',result,automatic:true})
          this.activity='';this.safety=null;this.phase=interruptedActiveRequest?'blocked':'ready';this.persist()
          if(request)noteAdvance(request,inventoryOf(recoveryBot),recoveryBot.registry)
          if(interruptedActiveRequest&&canResume(request)&&canContinueAfterCombat(request)){
            (request.combatContinuations??=[]).push({requestId:request.id,result,...continuationMark(request)});this.persist()
            await this.resume({automatic:true})
          }else if(previousFollow){this.dispatch({action:'follow',player:previousFollow});this.say('I am following you again.')}
          else this.say(interruptedActiveRequest?'Self-defense finished. Resume is available if the saved request can safely continue.':'Self-defense finished. Ready for your next instruction.')
        }
        if(decision.engage&&(!this.threatJudge?.control||chosen==='fight')){
          this.safety.status='defending';this.phase='defending'
          this.say('I can defend against this '+decision.target.targetName+'. I am equipping '+decision.weapon.replaceAll('_',' ')+'.')
          try{
            await this.execute({action:'defend',goal:{...decision.target,connectionId:this.runner.connectionId},timeoutMs:35000},abort.signal)
            if(epoch!==this.epoch||abort.signal.aborted)return
            this.safety.combat=structuredClone(this.runner.task.result)
            this.noteKill(this.safety.combat)
            // Lab run 135: a killed magma cube had split, the after-kill check found the
            // pieces and the bot turned to shelter beside one. Another mob the rule would
            // fight is fought too, a bounded number, before the area is judged (as the bow does).
            let fought=decision.target
            for(let kill=1;kill<MELEE_CHAIN;kill++){
              const next=defenseDecision(recoveryBot)
              if(!next.engage)break
              this.say(`The ${fought.targetName} died after my attacks. Another ${next.target.targetName}; fighting it too.`)
              fought=next.target
              await this.execute({action:'defend',goal:{...next.target,connectionId:this.runner.connectionId},timeoutMs:35000},abort.signal)
              if(epoch!==this.epoch||abort.signal.aborted)return
              this.safety.combat=structuredClone(this.runner.task.result)
              this.noteKill(this.safety.combat)
            }
            this.say('The '+fought.targetName+' died after my attacks. Checking the area before continuing.')
            await finishDefense('defend');return
          }catch(error){
            if(epoch!==this.epoch||abort.signal.aborted)return
            this.safety.combatFailure=error.message
            this.say('I need shelter now: '+error.message)
            this.dispatch({action:'stop'});await this.runner.waitForIdle?.(abort.signal)
            if(epoch!==this.epoch||abort.signal.aborted)return
          }
        }else if(ranged?.engage){
          // Lab, 10 October: a blaze 18 blocks off, every shelter failed on open
          // ground, and the bot burned to death with a bow in hand. Shoot back.
          let name=ranged.target.targetName
          this.safety.status='defending';this.phase='defending'
          this.say('This '+name+' keeps its distance. I am drawing my bow.')
          try{
            // Lab run 97: a third blaze arrived during the after-kill check and the
            // bot fled with two kills' rods on the ground. Another shooter the bow
            // can answer is shot too, a bounded number, before the area is judged.
            for(let kill=1;;kill++){
              await this.execute({action:'shoot',goal:{type:name,collect:false},timeoutMs:60000},abort.signal)
              if(epoch!==this.epoch||abort.signal.aborted)return
              const shot=structuredClone(this.runner.task.result)
              if(shot?.receipt==='killed'&&shot.at)recordKill(this,recoveryBot,shot.at)
              // A follow-up target that flew out of view is the area check's to judge (run 98).
              if(kill>1&&shot?.stopped==='target_lost')break
              if(shot?.receipt!=='killed')throw new Error(`the ${name} survived ${shot?.shots??0} arrows`)
              this.safety.combat=shot
              const next=kill<RANGED_CHAIN?rangedDefenseDecision(recoveryBot):null
              if(next?.engage){name=next.target.targetName;this.say(`The ${shot.item||'target'} fell to my arrows. Another ${name}; shooting it too.`);continue}
              break
            }
            this.say(this.runner.task.result?.receipt==='killed'?'The '+name+' fell to my arrows. Checking the area before continuing.':`The ${name} flew out of sight. Checking the area before continuing.`)
            await finishDefense('shoot');return
          }catch(error){
            if(epoch!==this.epoch||abort.signal.aborted)return
            this.safety.combatFailure=error.message
            this.say('I need shelter now: '+error.message)
            this.dispatch({action:'stop'});await this.runner.waitForIdle?.(abort.signal)
            if(epoch!==this.epoch||abort.signal.aborted)return
          }
        }else this.say('I am choosing shelter: '+decision.reason+(ranged?'; the bow: '+ranged.reason:''))
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
      // In the Nether the way home is the shelter: the base is out of reach and
      // the arrival portal is usually a few steps away (run 70: a blaze killed
      // the bot a block from it while retreat, burrow and hut each refused).
      // Run 73: twenty blocks from the portal the bot walled itself in, opened up and
      // walled in again among wither skeletons; the walk home is worth more.
      // Run 84 (9 October): beside the arrival portal, with blocks to close a portal
      // room and the nearest hostile not yet close, wall in there instead: going home
      // at every hoglin meant the room it was asked to build never began.
      const roomSite=inNether(recoveryBot)?hutSite(recoveryBot):null,portalRoom=!!(roomSite?.ok&&roomSite.portal)
      // Against a shooter the room is cover; only a mob that closes to melee needs the
      // standoff (run 105: a skeleton three blocks off sent the bot home at half health
      // into an Overworld night with another skeleton at arm's length).
      const nearest=Math.min(Infinity,...survivalObservation(recoveryBot).nearbyThreats.filter(t=>t.risk==='potential_hostile'&&!SHOOTERS_ONLY.has(t.name)).map(t=>t.distance))
      // Run 101 (10 October): two blocks out of its opened portal room to shoot, hoglins
      // at ten blocks sent the bot home, leaving the blaze and its rod. A portal room a
      // few steps away is walked back to and closed, when the hostiles leave time for the steps.
      const roomSpot=inNether(recoveryBot)&&!portalRoom?portalRoomSpot(recoveryBot):null
      const stepsBack=roomSpot?recoveryBot.entity.position.distanceTo(roomSpot.offset(.5,0,.5)):0
      const wallInFirst=(portalRoom||!!roomSpot)&&nearest>=PORTAL_ROOM_STANDOFF+Math.ceil(stepsBack)
      // Why the room was or was not chosen (run 106: hurt beside the portal, it went home and the journal could not say why).
      if(inNether(recoveryBot))this.runner.log?.('nether_shelter',{reason,wallInFirst,portalRoom,site:roomSite?.ok?(roomSite.portal?'portal_room':'plain_hut'):roomSite?.reason,roomSpot:roomSpot?`${roomSpot.x},${roomSpot.y},${roomSpot.z}`:null,stepsBack:Math.round(stepsBack*10)/10,nearestMelee:Number.isFinite(nearest)?nearest:null,position:(p=>p&&{x:Math.round(p.x*10)/10,y:Math.round(p.y*10)/10,z:Math.round(p.z*10)/10})(recoveryBot.entity?.position)})
      // On a trip with the kit and health, the portal is not the answer to a hostile:
      // cover is built where the bot stands, and what the rules fight is fought (lab runs
      // 129 to 137: every walk home through the corridors was the walk that killed it).
      // The trip is the request's existence, not the planner's moment: a request interrupted
      // by the last alarm and waiting to resume is still the trip (lab run 144, 14 October:
      // "Resume is available", the next blaze, requestActive false, the portal walk, dead).
      const trip=!wallInFirst&&onTrip(recoveryBot,!!interruptedActiveRequest||canResume(this.requestProgress))
      // Said either way: run 144 (14 October) went home from the spawner with the kit on and
      // the journal could not say which condition the trip mode failed.
      if(inNether(recoveryBot))this.runner.log?.('nether_trip',{reason,trip,wallInFirst,requestActive:!!interruptedActiveRequest,requestStatus:this.requestProgress?.status||null,health:recoveryBot.health,kit:tripKit(recoveryBot)})
      if(trip)this.say('Danger in the Nether. I have my kit, so I am taking cover here rather than running for the portal.')
      if(wallInFirst)this.say('Danger in the Nether. Walling in around the portal.')
      // The room first and nothing before it: from the Nether the walk to the Overworld
      // base always refuses and nether bricks never burrow, and those 1.6 seconds under a
      // skeleton's arrows were the bot's last (run 106 staging). If it fails, the portal.
      if(wallInFirst){
        const attempt={name:'portal_room',status:'trying'};this.safety.attempts=[attempt];this.persist()
        // A room one block short is tried once more before the walk home (lab run 147, 15
        // October: one ignored placement, and the next thing tried was the portal).
        for(let tries=1;;tries++){
          try{
            await this.execute({action:'hut',goal:{portalRoom:true},timeoutMs:60000},abort.signal)
            if(epoch!==this.epoch||abort.signal.aborted)return
            this.safety.retreat=structuredClone(this.runner.task.result);attempt.status='sheltered';this.persist();break
          }catch(error){
            if(epoch!==this.epoch||abort.signal.aborted)return
            attempt.status='rejected';attempt.reason=error.message;this.persist()
            this.dispatch({action:'stop'});await this.runner.waitForIdle?.(abort.signal)
            if(tries>1||!/^Hut incomplete: 1 of /.test(error.message)||epoch!==this.epoch||abort.signal.aborted)break
            attempt.status='trying';attempt.retried=true;this.persist()
          }
        }
        if(epoch!==this.epoch||abort.signal.aborted)return
      }
      // A melee mob the rules can fight at arm's reach is fought before any walk to the
      // portal: the walk with it on the bot's back is what killed lab run 142 (14 October,
      // a wither skeleton at 0.8 blocks, health 4.9 at the portal), and the cornered rule
      // below only ran after the shelters, which the portal walk is chosen instead of.
      if(!this.safety.retreat&&!trip&&inNether(recoveryBot)&&corneredDecision(recoveryBot).engage){
        const cornered=corneredDecision(recoveryBot)
        const attempt={name:'cornered',status:'trying',target:cornered.target.targetName};(this.safety.attempts??=[]).push(attempt);this.persist()
        this.say(`A ${cornered.target.targetName.replaceAll('_',' ')} is at arm's reach. Fighting it before the walk to the portal.`)
        try{await this.execute({action:'defend',goal:{...cornered.target,connectionId:this.runner.connectionId,cornered:true},timeoutMs:35000},abort.signal);attempt.status='fought';this.noteKill(this.runner.task?.result)}
        catch(error){if(epoch!==this.epoch||abort.signal.aborted)return;attempt.status='failed';attempt.reason=error.message;this.dispatch({action:'stop'});await this.runner.waitForIdle?.(abort.signal)}
        if(epoch!==this.epoch||abort.signal.aborted)return
      }
      if(!this.safety.retreat&&!trip&&inNether(recoveryBot)&&recoveryBot.findBlock?.({matching:recoveryBot.registry?.blocksByName?.nether_portal?.id,maxDistance:48})){
        const attempt={name:'portal_home',status:'trying'};this.safety.attempts=[attempt];this.persist()
        this.say('Danger in the Nether. Going back through the portal.')
        try{
          await this.execute({action:'use_portal',goal:{},timeoutMs:45000},abort.signal)
          if(epoch!==this.epoch||abort.signal.aborted)return
          await eatAfterPortalEscape(this,abort.signal,recoveryBot)
          if(epoch!==this.epoch||abort.signal.aborted)return
          attempt.status='crossed';this.safety=null
          this.say('I am back in the Overworld, away from the danger.');this.tripEnded('danger sent me home through the portal')
          this.phase=canResume(this.requestProgress)?'blocked':'ready';this.persist()
          return
        }catch(error){
          if(epoch!==this.epoch||abort.signal.aborted)return
          attempt.status='rejected';attempt.reason=error.message;this.persist()
          this.dispatch({action:'stop'});await this.runner.waitForIdle?.(abort.signal)
        }
      }
      // In the dark the base is a shelter only within a sprint of it, like any saved
      // shelter: a long walk home at night crosses fresh spawns, and digging in takes
      // seconds (honest run 2, 14 October: dusk, the base 107 blocks off, the retreat
      // walked 83 of them through a skeleton, a spider, two more and a creeper, and died).
      const tod=recoveryBot.time?.timeOfDay,dark=Number.isFinite(tod)&&(tod>=11500||tod<1000),origin=this.projects.base?.build?.origin
      const baseDistance=origin&&recoveryBot.entity?.position?Math.hypot(origin.x-recoveryBot.entity.position.x,origin.z-recoveryBot.entity.position.z):0
      const baseFar=dark&&baseDistance>FAR_SHELTER
      if(baseFar&&!this.safety.retreat&&!inNether(recoveryBot))this.say(`The base is ${Math.round(baseDistance)} blocks off and it is dark. Sheltering here instead of walking there.`)
      const candidates=this.safety.retreat?[]:[...(this.projects.base&&!baseFar?[{name:'base',goal:{project:structuredClone(this.projects.base)}}]:[]),...alternativeShelters(recoveryBot,this.projects).slice(0,3).map(shelter=>({name:shelter.name,goal:{shelter:structuredClone(shelter)}}))]
      if(!this.safety.retreat)this.safety.attempts=[]
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
        // A shooter in arm's reach is no closer for being near: distance gains nothing
        // against it, and the sprint is where the Nether kills (lab run 141, 14 October:
        // kitted, a blaze at three blocks, "sprinting clear", off the fortress edge, lava).
        const close=survivalObservation(recoveryBot).nearbyThreats.filter(t=>t.risk==='potential_hostile'&&t.position&&t.distance<=CLOSE_FLOORS.melee&&!SHOOTERS_ONLY.has(t.name)).sort((a,b)=>a.distance-b.distance)[0]
        if(close&&!(this.safety.flights||[]).length){
          this.safety.status='fleeing';this.phase='retreating';this.say(`A ${close.name} is ${close.distance} blocks away and I have no shelter to reach. Sprinting clear before digging in.`)
          try{await this.execute({action:'flee',goal:{from:close.position,distance:24},timeoutMs:15000},abort.signal);if(epoch!==this.epoch||abort.signal.aborted)return;(this.safety.flights??=[]).push(structuredClone(this.runner.task.result));this.persist()}
          catch(error){if(epoch!==this.epoch||abort.signal.aborted)return;(this.safety.flights??=[]).push({failed:error.message});this.persist();this.dispatch({action:'stop'});await this.runner.waitForIdle?.(abort.signal)}
          if(epoch!==this.epoch||abort.signal.aborted)return
          this.safety.status='retreating'
        }
      }
      if(!this.safety.retreat)await this.lastResortShelter(epoch,abort.signal,{trip})
      if(epoch!==this.epoch||abort.signal.aborted)return
      // Cornered: every shelter refused and a mob in arm's reach. Fight the
      // nearest, up to three in turn, then try to shelter again.
      for(let round=0;round<3&&!this.safety.retreat;round++){
        const cornered=corneredDecision(recoveryBot);if(!cornered.engage)break
        const attempt={name:'cornered',status:'trying',target:cornered.target.targetName};this.safety.attempts.push(attempt);this.persist()
        this.say(`Cornered by a ${cornered.target.targetName} with nowhere to shelter. Fighting with my ${cornered.weapon.replaceAll('_',' ')}.`)
        try{await this.execute({action:'defend',goal:{...cornered.target,connectionId:this.runner.connectionId,cornered:true},timeoutMs:35000},abort.signal);attempt.status='fought';this.noteKill(this.runner.task?.result)}
        catch(error){if(epoch!==this.epoch||abort.signal.aborted)return;attempt.status='failed';attempt.reason=error.message;this.dispatch({action:'stop'});await this.runner.waitForIdle?.(abort.signal)}
        if(epoch!==this.epoch||abort.signal.aborted)return
        this.persist()
        if(!corneredDecision(recoveryBot).engage){await this.lastResortShelter(epoch,abort.signal,{trip});if(epoch!==this.epoch||abort.signal.aborted)return}
      }
      // In the Nether "moving away" runs into the fortress (runs 100 and 107 died that
      // way, 107 with two blaze rods). With a portal in reach, try it again instead.
      // Lab run 165, 15 October: kitted, health 20, the hut one block short and the burrow
      // refused by a dropper floor, this walk took the bot home with one rod. On a trip the
      // portal is for an ended trip or a hurt bot (the first walk above).
      if(!this.safety.retreat&&!trip&&inNether(recoveryBot)&&recoveryBot.findBlock?.({matching:recoveryBot.registry?.blocksByName?.nether_portal?.id,maxDistance:48})){
        const attempt={name:'portal_home',status:'trying'};this.safety.attempts.push(attempt);this.persist()
        this.say('Nowhere to wall in here. Trying the portal again.')
        try{
          await this.execute({action:'use_portal',goal:{},timeoutMs:45000},abort.signal)
          if(epoch!==this.epoch||abort.signal.aborted)return
          await eatAfterPortalEscape(this,abort.signal,recoveryBot)
          if(epoch!==this.epoch||abort.signal.aborted)return
          attempt.status='crossed';this.safety=null
          this.say('I am back in the Overworld, away from the danger.');this.tripEnded('danger sent me home through the portal')
          this.phase=canResume(this.requestProgress)?'blocked':'ready';this.persist()
          return
        }catch(error){
          if(epoch!==this.epoch||abort.signal.aborted)return
          attempt.status='rejected';attempt.reason=error.message;this.persist()
          this.dispatch({action:'stop'});await this.runner.waitForIdle?.(abort.signal)
        }
      }
      // On a trip this arm does nothing, on purpose: moving away below is climb, descend and a
      // 24-block flee, the Nether sprint that killed lab run 141 (14 October). The episode
      // fails, and its bounded retry tries cover again three seconds later on a fresh read of
      // the health; below the trip's health the trip is over and the first walk goes home.
      else if(!this.safety.retreat&&trip&&inNether(recoveryBot)){}
      else if(!this.safety.retreat&&await this.moveOutOfDanger(epoch,abort.signal,recoveryBot)){
        if(epoch!==this.epoch||abort.signal.aborted)return
        await this.lastResortShelter(epoch,abort.signal,{trip})
        if(epoch!==this.epoch||abort.signal.aborted)return
      }
      if(!this.safety.retreat)throw new Error('No verified shelter reached. '+this.safety.attempts.map(a=>a.name+': '+a.reason).join('; '))
      // Eat once safe, whatever the shelter is. Burrowing answers mobs, not hunger,
      // and a food emergency that only ever digs in re-fires every tick while the
      // bot starves holding the food that would clear it.
      {
        const carried=survivalObservation(this.runner.bot).carriedFood[0]
        // An ended Nether trip's review is of the trip, not the food: it still eats here.
        if(this.runner.bot.food<20&&carried&&!(this.requestProgress?.reviewRequired&&!this.requestProgress.tripEnded)){
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
      // A request that was blocked before the retreat is blocked after it, so the stall
      // retry and its indoor hold keep running (lab run 139, 13 October: a fight from the
      // base failed, the retreat marked the request ready, and the bot sat silent for a
      // hundred minutes with the saved request waiting).
      this.safety.status='sheltered';this.phase=this.requestProgress?.status==='interrupted'||canResume(this.requestProgress)?'blocked':'ready'
      // A health retreat deserves the same watch-and-continue as a threat retreat;
      // otherwise every hurt evening ends the request until an operator resumes it.
      const eligible=interruptedActiveRequest&&[THREAT_INTERRUPTION,HEALTH_EMERGENCY,FOOD_EMERGENCY].includes(reason)&&canResume(this.requestProgress)&&canContinueAfterSafety(this.requestProgress)
      this.say('I reached '+(this.safety.retreat.shelterName||'the lit base')+' and closed the door. '+(eligible?'I will watch for a clear area before continuing your request.':this.requestProgress?.status==='interrupted'?'Your request is paused; Resume will re-observe and continue.':canResume(this.requestProgress)?'Your request is still saved. I will carry on with it when it is safe to.':'Waiting for your next instruction.'))
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
    // Open ground is a daylight answer; the Nether has no daylight, only ghasts.
    if(inNether(bot)||!(s.timeOfDay>=1000&&s.timeOfDay<12000)||!(s.health>=12))return 'skipped'
    // Open ground is only better than a hole if nothing is already on the bot.
    // A daylight spider counts as conditional, but it still bites: one chased
    // the agent through a flight from 20 health to 0.
    if((s.nearbyThreats||[]).some(t=>t.distance<=5))return 'skipped'
    const flights=this.safety.flights||[],fled=flights.some(f=>!f.failed)
    // Two ways to stay out here instead of trekking home: sprint clear of a lone
    // mob this pass, or, having already sprinted (a creeper), find nothing in range.
    // Not from an enderman: it teleports after whoever provoked it, so a sprint gains nothing.
    const sprint=!fled&&lone&&DEFENDABLE_MOBS.has(lone.name)&&lone.name!=='enderman'&&flights.length<2?lone:null
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
      ;(request.safetyContinuations??=[]).push({...result,requestId:request.id,connectionId:connection,shelter:'open_ground',resumeSerial:request.resumeSerial||0,...continuationMark(request)})
      ;(request.feedback??=[]).push({action:'safety_continuation',status:'completed',result:request.safetyContinuations.at(-1)});this.persist()
      this.say('The threat stayed behind in daylight. I am continuing your saved request.')
      await this.resume({automatic:true})
    }else this.say('The threat stayed behind in daylight. '+(canResume(request)?'Resume is available if the saved request can safely continue.':'Ready for your next instruction.'))
    return 'continued'
  }
  // Last resort with no base and no weapon: dig in, or wall in where the
  // ground cannot be dug. Returns whether a shelter was reached.
  async lastResortShelter(epoch,signal,{trip=false}={}) {
    // Burrow and hut judge the ground under the bot; a sprint or jump leaves it airborne for a moment.
    for(let i=0;i<15&&this.runner.bot?.entity?.onGround===false;i++){await delay(100);if(epoch!==this.epoch||signal.aborted)return false}
    // One attempt; false when the shelter was cancelled under it.
    const shelter=async(name,said,goal)=>{
      const attempt={name,status:'trying'};this.safety.attempts.push(attempt);this.persist()
      this.say(said)
      try{
        await this.execute({action:name,goal,timeoutMs:60000},signal)
        if(epoch!==this.epoch||signal.aborted)return false
        this.safety.retreat=structuredClone(this.runner.task.result);attempt.status='sheltered';this.persist()
      }catch(error){
        if(epoch!==this.epoch||signal.aborted)return false
        attempt.status='rejected';attempt.reason=error.message;this.persist()
        this.dispatch({action:'stop'});await this.runner.waitForIdle?.(signal)
      }
      return true
    }
    const burrow=()=>shelter('burrow','No verified shelter is reachable. I am digging in to wait out the danger.',{})
    // In the Nether a portal room a step away beats a plain hut on a bridge (run 107).
    const hut=said=>{const bot=this.runner.bot,roomGoal=inNether(bot)&&((()=>{const site=hutSite(bot);return site.ok&&site.portal})()||portalRoomSpot(bot))?{portalRoom:true}:{};return shelter('hut',said,roomGoal)}
    // Lab run 150, 15 October: kitted in a one-wide covered netherrack tunnel, the burrow came
    // first, since netherrack and a pickaxe always dig, and a burrow has no port: leaving it was
    // a climb out under four blazes. Such a tunnel is a hut already but for its two open ends,
    // four blocks, so on a trip under rock those are walled first and the burrow is the fallback.
    const site=trip&&roofed(this.runner.bot)?hutSite(this.runner.bot):null
    const order=site?.ok&&site.needed<=4?[()=>hut('Rock on every side but two. I am walling in the open ends with carried blocks.'),burrow]
      // Ground that cannot be dug: wall in with carried blocks instead.
      :[burrow,()=>hut('The ground here cannot be dug. I am walling myself in with carried blocks.')]
    for(const step of order)if(!this.safety.retreat&&!await step())return false
    return !!this.safety.retreat
  }
  // Never stand still when every shelter is refused and a threat is near:
  // leave a pit, sprint from the nearest hostile and try the ground there.
  async collectKillSites(signal,bot,request){return collectKillSites(this,signal,bot,request)}
  // A melee kill's place, for the after-fight pickup (string from a night spider).
  noteKill(result){if(result?.at&&['x','y','z'].every(k=>Number.isFinite(result.at[k])))recordKill(this,this.runner?.bot,result.at)}
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
    const {quietMs=20000,limitMs=14*60*1000,patienceMs,relocateAfterMs,watches=BURROW_WATCHES,burnCapMs=BURN_CAP_MS}=this.burrowWait||{}
    let lingerSince=null
    // The relocate decision is derived from how long the threat has held, so
    // clearing the timer the moment it fires un-decides it on the next poll and
    // the wait oscillates for ever, never accumulating the quiet period it needs.
    // A brief clear reading is still inside the quiet-area verification window.
    // Keep elapsed patience until clearance succeeds; night starts a fresh wait.
    let protectedHealth=bot.health,portWait=null,burntAt=-Infinity,fireSince=null,doused=false,watchStart=Date.now()
    const observe=()=>{
      safety.protection=inspectEmergencyShelter(bot)
      // Lab run 156, 15 October: alight from the port, the bot closed the hut and the fire ticks
      // read as a breach. A drop while burning, or within BURN_MS of it (the last tick can land
      // after the flag clears), is a burn: the hut is kept and the wait goes on. The inspection
      // above still finds a hut that is no longer closed or has fire inside. Past burnCapMs of
      // continuous fire the wait douses once (douseLongBurn), and from then until the fire is
      // out a drop is a breach again, so no burn is waited out to the death.
      const alight=fireObservation(bot).onFire===true
      if(alight){burntAt=Date.now();fireSince??=Date.now()}else{fireSince=null;if(Date.now()-burntAt>BURN_MS)doused=false}
      if(bot.health<protectedHealth&&(doused||Date.now()-burntAt>BURN_MS))throw new Error('Health fell inside the emergency shelter; protection is not established')
      protectedHealth=bot.health
      // Any shooter loaded within its alarm radius, seen or behind rock, for the rod pickup's quiet minute.
      if(Object.values(bot.entities||{}).some(e=>SHOOTERS_ONLY.has(e?.name)&&e.position&&e.position.distanceTo(bot.entity.position)<=threatRadius(e.name)))this.shooterSeenAt=Date.now()
      const r=burrowClearance(bot,{lingeredMs:lingerSince?Date.now()-lingerSince:0,patienceMs,relocateAfterMs,exits:shelterExits(safety.retreat),canPort:safety.retreat?.shelterName==='hut',trip:onTrip(bot,canResume(request))});if(r.lingering||r.confront||r.relocate)lingerSince??=Date.now();else if(r.holding)lingerSince=null
      // With kills near the hut to fetch on a trip, the hut holds quiet until no shooter has been
      // near for tripPickup's minute, so the walk for them comes before going on; never so late in
      // a watch that the quiet the wait needs after it no longer fits (lab run 156, 15 October).
      const since=Date.now()-(this.shooterSeenAt??-Infinity)
      if(r.clear&&!r.confront&&!r.relocate&&since<PICKUP.quietMs&&Date.now()-watchStart<limitMs-quietMs-1000&&inNether(bot)&&canResume(request)&&sitesNearHut(safety.retreat?.surface,this.killSites||[]).length&&wantedDrops(request,bot.registry).length){
        const reason=`Holding the hut quiet before fetching what fell: a shooter was near ${Math.round(since/1000)} seconds ago`
        if(portWait!=='pickup'){portWait='pickup';this.say(reason+'.')}
        return {clear:false,reason}
      }
      // Lab run 156, 15 October: broken off at a port at 10 health and alight, the bot walled in
      // and burned to death. In the Nether no port opens toward a shooter until portReady; the
      // hut holds meanwhile, and the wait's top-up eats when it can.
      const port=r.confront&&safety.retreat?.shelterName==='hut'&&inNether(bot)&&SHOOTERS_ONLY.has(r.confront.name)&&bowCanAnswer(bot,r.confront.name)
      const ready=port?portReady(bot):{ready:true}
      if(ready.ready){portWait=null;return r}
      // A hold that cannot heal (no food carried, and too hungry to regenerate) only waits. On a
      // kitted trip that is the trip's end, out of food; otherwise the hut's own rules decide.
      const carried=survivalObservation(bot).carriedFood?.length>0
      if(!carried&&(!(bot.food>=PORT_FOOD)||bot.health<PORT_HEALTH&&!(bot.food>=18))){
        if(inNether(bot)&&request?.kittedTrip&&LIVE_REQUEST.has(request.status))this.tripEnded('I am out of food to heal on')
        else if(portWait!=='unhealed'){portWait='unhealed';this.say(`I cannot heal here: no food carried and hunger ${bot.food}. Not waiting to open the port.`)}
        return r
      }
      const reason=`Holding the port toward the ${r.confront.name.replaceAll('_',' ')} shut: ${ready.reason}`
      // Said once per cause, not at every point healed.
      const cause=ready.reason.split(' ')[0],eats=bot.food<18&&carried
      if(portWait!==cause){portWait=cause;this.say(`${reason}. Waiting in the hut${eats?' and eating':''} before I open it.`)}
      return {clear:false,lingering:true,reason,threats:[r.confront]}}
    // Burning past the cap inside the hut: put it out once (fire-safety.js), then count from here.
    const douseLongBurn=async()=>{
      if(doused||fireSince===null||Date.now()-fireSince<burnCapMs)return
      doused=true;this.say(`Burning for ${Math.round((Date.now()-fireSince)/1000)} seconds in the hut. Putting the fire out.`)
      try{await this.execute({action:'douse',goal:{},timeoutMs:30000},signal)}catch(error){check();this.dispatch({action:'stop'});await this.runner.waitForIdle?.(signal)}
      check();protectedHealth=bot.health
    }
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
          ;(request.safetyContinuations??=[]).push({...planned.clearance,requestId:request.id,connectionId:connection,shelter:'planned_departure',resumeSerial:request.resumeSerial||0,...continuationMark(request)})
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
      // Lab run 146, 15 October: kitted, walled in inside a one-wide netherrack tunnel, a
      // blaze outside its wall. The confront opened a wall and resumed; the alarm fired
      // seconds later at the same blaze, judged the shot through the hut's remaining wall
      // and walled in again, every ninety seconds for fifteen minutes, no arrow loosed.
      // A shooter the bow answers is shot through a firing port while the shelter is
      // still held, so no alarm fires, and the hut closes the port after. A port with no
      // shot is not opened again; PORT_ATTEMPTS openings without a kill and it moves away.
      let result,confront,relocate,attempts=0
      const tried=[]
      for(;;){
        for(let watch=1;;watch++){
          watchStart=Date.now()
          result=await awaitClearance({check,observe,quietMs,limitMs,maintain:async()=>{await douseLongBurn();return topUpWhileSheltered(this,signal,bot)},onUpdate:record=>{safety.continuation={...record,watch};this.persist();this.emit('change')}})
          check();safety.continuation={...result,watch};this.persist()
          if(result.status==='cleared'||watch>=watches)break
          this.say(`Still no clear area after ${Math.round(limitMs/60000)} minutes. I am staying dug in and watching again.`)
        }
        if(result.status!=='cleared'){this.say('I am staying dug in. Resume is required because daylight and a clear area were not established in time.');return}
        confront=result.observation?.confront;relocate=result.observation?.relocate
        if(!(safety.retreat.shelterName==='hut'&&confront?.position&&SHOOTERS_ONLY.has(confront.name)&&bowCanAnswer(bot,confront.name)))break
        // Out of ports, leaving takes the same health and standoff as the wait's own
        // relocation; short of them the hut holds, and the next watch's gates decide
        // (hurt, the bow no longer answers and the bot heals). The patience runs again.
        const name=confront.name.replaceAll('_',' '),leave=()=>{
          if(strongEnoughToLeave(bot)&&confront.distance>=RELOCATE_STANDOFF){relocate={threats:[confront],from:confront.position};confront=null;return true}
          this.say(`I will not walk out with the ${name} ${confront.distance} blocks away. Holding the hut and watching again.`)
          attempts=0;tried.length=0;lingerSince=null;return false
        }
        this.say(`A ${name} has lingered ${confront.distance} blocks away. Opening a firing port toward it.`)
        let port
        try{await this.execute({action:'unhut',goal:{toward:{x:Math.floor(confront.position.x),z:Math.floor(confront.position.z)},shooter:confront.name,...(tried.length?{skip:structuredClone(tried)}:{})},timeoutMs:60000},signal);check();port=structuredClone(this.runner.task.result)}
        catch(error){check();this.dispatch({action:'stop'});await this.runner.waitForIdle?.(signal);check();this.say(`No port to shoot the ${name} from: ${error.message}.`);if(leave())break;continue}
        safety.port=port;this.persist()
        let shot=null,missed=null
        // On a trip the first hit at the port ends the shot (lab run 156, 15 October: 20 health to
        // 8.7 in six seconds at a port into a room of four blazes, then burned to death walling in).
        const breakOnHit=onTrip(bot,canResume(request))?{breakOnHit:true}:{}
        try{await this.execute({action:'shoot',goal:{type:confront.name,collect:false,stay:true,...breakOnHit},timeoutMs:60000},signal);check();shot=structuredClone(this.runner.task.result)}
        catch(error){check();missed=error.message;this.dispatch({action:'stop'});await this.runner.waitForIdle?.(signal);check()}
        // The bow reports a step back from the port that did not land home; the hut then
        // walls in where the bot stands, and the wait watches that hut from here on.
        if(shot?.strayed||/Not back in the hut/.test(missed||''))this.say('I am not back in the hut from the port. Walling in where I stand.')
        // The hut puts back what is missing: the port, and any wall a fireball took. A
        // close the bridge drops is tried once more before the shelter counts as failed.
        try{
          try{await this.execute({action:'hut',goal:{},timeoutMs:60000},signal);check()}
          catch(error){check();this.dispatch({action:'stop'});await this.runner.waitForIdle?.(signal);check();await this.execute({action:'hut',goal:{},timeoutMs:60000},signal);check()}
          const closed=this.runner.task?.result?.surface;if(closed)safety.retreat={...safety.retreat,surface:structuredClone(closed)}
        }finally{delete safety.port;this.persist()}
        // Arrows taken at the open port are not a failed shelter; from here, closed, any hit is.
        protectedHealth=bot.health
        if(shot?.receipt==='killed'){
          if(shot.at)recordKill(this,bot,shot.at)
          this.say(`The ${name} fell to my arrows. Port closed; watching again.`);continue
        }
        if(port?.side&&/No clear shot/.test(missed||''))tried.push(port.side)
        this.say(`${missed?`No luck through that port: ${missed}`:`The ${name} survived ${shot?.shots??0} arrows`}. Port closed.`)
        if(++attempts>=PORT_ATTEMPTS&&leave())break
      }
      // Lab run 147, 15 October: kitted, health 20, 128 arrows, a wither skeleton lingering
      // thirteen blocks off held the hut four minutes, and "leaving the area" took the portal
      // home and ended the trip. On a trip, strong and past the standoff, leaving goes on: the
      // hut opens toward the request's next place, or away from the mob, and the planner
      // carries on with the alarm still guarding the walk.
      // Going on is only going on if the request resumes after: otherwise an opened hut and a mob near.
      const resumes=(eligible||safety.resumeRequested)&&canResume(request)&&(safety.resumeRequested||canContinueAfterSafety(request))
      let goOn=!!relocate&&resumes&&onTrip(bot,canResume(request))&&strongEnoughToLeave(bot)&&relocate.threats.every(t=>t.distance>=RELOCATE_STANDOFF)
      const here=bot.entity.position,mobs=goOn?relocate.threats.map(t=>t.position):[]
      // The next place the request walks to, unless it lies past a mob; then straight away from them.
      const next=goOn&&[request.inFlight?.step,...(request.pending||[])].find(s=>Number.isFinite(s?.target?.x)&&Number.isFinite(s?.target?.z))?.target
      const ahead=next&&mobs.every(m=>(next.x-here.x)*(m.x-here.x)+(next.z-here.z)*(m.z-here.z)<=0)?next
        :goOn&&{x:2*here.x-mobs.reduce((n,m)=>n+m.x,0)/mobs.length,z:2*here.z-mobs.reduce((n,m)=>n+m.z,0)/mobs.length}
      this.say(goOn?`A ${relocate.threats[0].name.replaceAll('_',' ')}${relocate.threats.length>1?` and ${relocate.threats.length-1} more`:''} will not move on. I have my kit and my health, so I am going on with the request rather than home.`
        :confront?`${inNether(bot)?'A':'Daylight, and a'} lone ${confront.name} has lingered ${confront.distance} blocks away. Opening up to confront it.`
        :relocate?`${inNether(bot)?'':'Daylight, and '}${relocate.threats.length===1?`a ${relocate.threats[0].name.replaceAll('_',' ')}`:`${relocate.threats.length} hostiles`} will not move on. I cannot fight that from here and waiting is not working, so I am leaving the area.`.replace(/^a /,'A ')
        :'Daylight with no hostile nearby. Opening up.')
      // Confronting from a hut, open the wall that faces it: the bow needs the sightline (run 86).
      const facing=confront?.position?{toward:{x:Math.floor(confront.position.x),z:Math.floor(confront.position.z)}}
        :goOn?{toward:{x:Math.floor(ahead.x),z:Math.floor(ahead.z)},from:mobs.map(m=>({x:Math.floor(m.x),z:Math.floor(m.z)}))}:{}
      try{await this.execute(safety.retreat.shelterName==='hut'?{action:'unhut',goal:facing,timeoutMs:60000}:{action:'unburrow',goal:{surface:safety.retreat.surface},timeoutMs:90000},signal);check()}
      catch(error){
        // No wall away from them to open: the hut is still whole, so leave the old way.
        if(!goOn||!facing.from)throw error
        check();this.dispatch({action:'stop'});await this.runner.waitForIdle?.(signal);check()
        goOn=false;this.say(`${error.message}. Leaving the area the old way.`)
        await this.execute({action:'unhut',goal:{},timeoutMs:60000},signal);check()
      }
      safety.exit=structuredClone(this.runner.task.result);this.persist()
      // Surfacing beside a threat that outguns us only helps if we then leave.
      // Opening one wall is not leaving: a shelter four blocks down still needs
      // the pit exit before a sprint has anywhere to go, which is why moving away
      // from danger climbs first everywhere else the harness does it.
      let ended=false
      if(relocate&&!goOn&&relocateWay(bot)==='portal'){
        // Lab run 100: in the Nether "leaving the area" fled 32 blocks deeper into a
        // fortress and met a wither skeleton. With the portal in reach, home is away.
        try{await this.execute({action:'use_portal',goal:{},timeoutMs:45000},signal);check();safety.relocated=structuredClone(this.runner.task.result);this.persist();await eatAfterPortalEscape(this,signal,bot);check();ended=this.tripEnded('danger sent me home through the portal')}
        catch(error){check();this.say('I could not get back through the portal: '+error.message);this.dispatch({action:'stop'});await this.runner.waitForIdle?.(signal);check()}
      }else if(relocate&&!goOn){
        try{await this.execute({action:'climb',goal:{},timeoutMs:45000},signal);check()}
        catch(error){check();this.dispatch({action:'stop'});await this.runner.waitForIdle?.(signal);check()}
        // In the End away is toward 0,0, since the void is every other way; beside the fountain already, it stays.
        const way=relocateWay(bot),centre=way==='centre'?centreward(bot):null
        if(way!=='centre'||centre)try{await this.execute(centre?{action:'travel',goal:centre,timeoutMs:60000}:{action:'flee',goal:{from:relocate.from,distance:32},timeoutMs:60000},signal);check()
          safety.relocated=structuredClone(this.runner.task.result);this.persist()}
        catch(error){check();this.say('I could not get clear of them: '+error.message)
          this.dispatch({action:'stop'});await this.runner.waitForIdle?.(signal);check()}
      }
      // Out with nothing near: pick up what earlier fights dropped (lab run 111: two rods
      // fell mid-chain, the chain ended in the portal room, and nobody went back for them).
      // In the Nether only after a quiet minute, on 16 health, and near the hut (lab run 156, 15 October).
      if(!confront&&!relocate&&canResume(request)){
        const guard=inNether(bot)?tripPickup({health:bot.health,onFire:fireObservation(bot).onFire===true,shooterSeenAt:this.shooterSeenAt,now:Date.now(),hut:safety.retreat?.surface,sites:this.killSites||[]}):null
        if(guard&&!guard.ok){if(this.killSites?.length&&wantedDrops(request,bot.registry).length)this.say(`Leaving what fell where it lies for now: ${guard.reason}.`)}
        else{const got=await collectKillSites(this,signal,bot,request,guard?k=>guard.sites.includes(k):undefined);check();if(got)safety.collected=got}
      }
      const continuing=(eligible||safety.resumeRequested)&&canResume(request)&&(safety.resumeRequested||canContinueAfterSafety(request))
      this.safety=null;this.activity='';this.phase=canResume(request)?'blocked':'ready'
      if(continuing){
        ;(request.safetyContinuations??=[]).push({...result,requestId:request.id,connectionId:connection,shelter:safety.retreat.shelterName,resumeRequested:!!safety.resumeRequested,resumeSerial:request.resumeSerial||0,...continuationMark(request)})
        ;(request.feedback??=[]).push({action:'safety_continuation',status:'completed',result:request.safetyContinuations.at(-1)});this.persist()
        this.say('Back on the surface. I am continuing your saved request.')
        await this.resume({automatic:true})
      }else if(!ended)this.say('Back on the surface. '+(canResume(request)?'Resume is available if the saved request can safely continue.':'Ready for your next instruction.'))
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
      const result=await awaitClearance({check,limitMs,maintain:async()=>{const r=recovery.maintain?await recovery.maintain():false;await topUpWhileSheltered(this,signal,bot);return r},observe,onUpdate:record=>{safety.continuation=record;this.persist();this.emit('change')}})
      check();safety.continuation=result;this.persist()
      if(result.status!=='cleared'){this.say('I am staying sheltered. Resume is required because a clear area was not established in time.');return}
      // Record before dispatch so restart, Stop or a second threat cannot create
      // an unbounded continuation loop. submit() re-observes the saved request.
      ;(request.safetyContinuations??=[]).push({...result,requestId:request.id,connectionId:connection,resumeSerial:request.resumeSerial||0,...continuationMark(request)});
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
    // A watch that has cleared is leaving the shelter, and resumes the request itself
    // once out (lab run 93: retrying over the exit walled the bot back in at the same mobs).
    // A watch that failed, whatever its last record said, leaves the retry in charge
    // (lab run 98: failed mid-watch, still marked watching, idle for 34 minutes).
    if(this.safety?.status!=='failed'&&['watching','cleared'].includes(this.safety?.continuation?.status))return false
    // A planner that asks for Resume, or says it lost its kit, has said a person must look
    // first (lab run 144, 23:26Z: "I lost the iron armour... Press Resume at daylight and
    // I'll gear up first"; this retry resumed it ninety seconds later and the bot rebuilt a
    // kit from nothing in the dark). Held until an explicit Resume, which does not come
    // through here. Narrow on purpose: the controller's own blockers say "Resume to",
    // "and Resume" or "the lost inventory before resuming", and those are what this retry is for.
    if(/\b(?:press|hit|tell me to|say) (?:the )?resume\b/i.test(request.blocker||'')||/\blost\b[^.]{0,40}\b(?:kit|gear|armou?r)\b/i.test(request.blocker||''))return false
    // Inside the base at night with the work unfinished is a wait, not a stall.
    // Asking the planner again every ninety seconds gets the same answer three
    // times and leaves the request dead before dawn. Hold, say so once, and let
    // the first retry after sunrise pick it up. Stalled anywhere else at night
    // is still an ordinary stall: underground the work can go on.
    const tod=this.runner.bot?.time?.timeOfDay
    if(insideBase(this.runner.bot,this.projects.base)&&!inBackExit(this.runner.bot,this.projects.base)){
      const night=Number.isFinite(tod)&&(tod>=12500||tod<1000)
      // The same hold for a hostile camped inside its radius: the door would not open for it anyway.
      const pressing=night?null:pressingOutside(this.runner.bot,this.projects.base)
      if(night||pressing){
        // A camper on the base's own level can be fought from the door. One under the floor or
        // over the roof is reached only by a route the defense loop does not take (lab run 139,
        // 13 October: a zombie seven blocks below in a dark pocket, the door opened on nothing).
        const level=!pressing||Math.abs(pressing.verticalOffset||0)<=DAY_HOLD_FIGHT_LEVEL
        const reason=night?'It is night and I am in the base.':`A ${pressing.name} is ${pressing.distance} blocks from the base${level?'':pressing.verticalOffset<0?', below its floor':', above its roof'}.`
        // A base with a back exit gets one planning round first: the door is
        // refused with a reason that names tunnel_out, and the planner decides
        // whether the work can go on underground (lab run 29, 3 October: held
        // indoors by day on a skeleton at twelve blocks, the exit never asked).
        if(this.projects.base?.backExit?.cell&&!this.backExitAsked){
          this.backExitAsked=true;this.say(`${reason} Checking whether the work can go on through the back exit.`)
          request.stallContinuations=request.stallContinuations||0;this.blockedSince=null;this.persist()
          await this.resume({automatic:true}).catch(error=>{request.blocker=error.message;this.persist()})
          return true
        }
        // A new kind of hold is said at once (night to a camper at dawn, dusk again); the same
        // kind is said again every HOLD_SAY_MS with whichever mob is nearest then. The key is
        // night or day only: with a skeleton and a pillager trading places the nearest mob
        // changed four times in ninety seconds (lab run 139), and each was news.
        const holdKey=night?'night':'day'
        const fresh=!this.nightHold||this.holdKey!==holdKey
        const said=()=>{this.nightHold=true;this.holdKey=holdKey;this.holdSaidAt=Date.now();this.say(reason+(night?' I will carry on with your request at daylight.':' I will carry on with your request when it has moved on.'))}
        if(night){
          this.dayHoldSince=null
          if(fresh)said()
          return false
        }
        if(level&&this.runner.bot.health>=DAY_HOLD_FIGHT_HEALTH&&defenseDecision(this.runner.bot).engage){
          // The hold owns this fight: a sheltered record from the last retreat would stop it.
          this.nightHold=false;this.dayHoldSince=null;this.safety=null
          this.say(`${reason} It is daylight and I can fight it. Going out to deal with it.`)
          void this.seekSafety(THREAT_INTERRUPTION);return true
        }
        this.dayHoldSince??=Date.now()
        if(Date.now()-this.dayHoldSince<DAY_HOLD_MS){
          if(fresh||Date.now()-(this.holdSaidAt||0)>=HOLD_SAY_MS)said()
          return false
        }
        this.dayHoldSince=null
        this.say(`${reason} It has stayed there ${Math.round(DAY_HOLD_MS/60000)} minutes into daylight. Asking the planner what to do about it.`)
      }
    }
    this.nightHold=false;this.backExitAsked=false
    // A blocker that asks the player a question waits for the player, not the clock (the
    // creative world, 14 October: "Can you shoo them away?" asked again every ninety seconds).
    // After PLAYER_ANSWER_MS one ordinary retry looks again, in case they did it silently.
    if(request.requester&&/\?/.test(request.blocker||'')){
      request.askedPlayerAt??=Date.now();this.persist()
      if(Date.now()-request.askedPlayerAt<PLAYER_ANSWER_MS)return false
      request.askedPlayerAt=Date.now()
    }
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
  // A kitted Nether trip is over when the safety chain takes the bot home through the
  // portal, when it comes home without the kit, or when it dies on the trip. Lab run 144
  // (14 October): home with the kit lost, every automatic path (dawn respawn, standoff,
  // stall retry, safety and restart continuations) revived the request, and the bot rebuilt
  // a kit from nothing overnight, 170 blocks from base, dying four more times. reviewRequired
  // makes canResume false, which every one of those paths checks. Said once.
  tripEnded(reason){
    const request=this.requestProgress
    if(!request?.kittedTrip)return false
    if(!LIVE_REQUEST.has(request.status)){delete request.kittedTrip;this.persist();return false}
    const message=`The Nether trip is over: ${reason}. Re-kit me or give me a new instruction.`
    if(request.status==='running')this.cancel(false,'blocked')
    delete request.kittedTrip;request.tripEnded={reason,at:new Date().toISOString()};if(this.killSites)this.killSites=this.killSites.filter(k=>!k.trip)
    request.status='blocked';request.pending=[];request.inFlight=null;request.blocker=message;request.reviewRequired=message
    this.runner.log?.('nether_trip_ended',{requestId:request.id,reason})
    this.say(message);return true
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
  // The player a request is for: whoever asked in game, else the owner. "Come
  // here", "follow me", "give me" and "remember this spot" mean that player
  // (3 October: Sov's children will ask, and all of it went to the owner).
  recipient(){ const r=this.requestProgress?.requester; return r&&this.runner.bot?.players?.[r]?r:this.runner.owner }
  async submit(text,continuation=null,{automatic=false,prepared=null,requester=null}={}) {
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
    this.requestProgress=continuation||{id:randomUUID(),request:text,completed:[],pending:[],feedback:[],rounds:0,...(requester?{requester}:{})};this.requestProgress.status='running';this.requestProgress.blocker=null
    // A request that begins in the Nether with the kit on is the same trip as one that
    // crossed out with it: the staged lab trips are put there with the kit by console.
    if(!continuation&&inNether(this.runner.bot)&&tripKit(this.runner.bot).ready)this.requestProgress.kittedTrip={at:new Date().toISOString(),how:'started'}
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
        const observation=expeditionObservation({...(this.threatContextMode==='legacy'?{}:{recovery:recoveryContext(this,b)}),goal:this.requestProgress.goal,verification:this.requestProgress.verification,activeMilestone:missionFocus(this.requestProgress.mission),experience,terrain:this.requestProgress.goal?terrainSummary(b,{near:ownerPosition||position,projects:this.projects}):null,connected,owner,ownerVisible,position,ownerPosition,health,survival,foraging:berryObservation(b),footing:footingObservation(b),world:worldObservation(b,{goal:this.requestProgress.goal,requestedBlocks:this.requestProgress.requestedBlocks}),interactables:interactableObservation(b,{names:useTargetNames(this.requestProgress.goal)}),localTerrain:terrainSummary(b,{projects:this.projects}),tools,inventory,places,task:currentTask,nearby,feedback:feedback.slice(-24),projects:structuredClone(this.projects),baseCondition:this.baseCondition(),portalTravel:{nether:this.runner.portalTravel?.current?.nether||'off',end:this.runner.portalTravel?.current?.end||'off'},existingBuild:existingTask?.kind==='build'?existingTask:null,requestProgress:structuredClone(this.requestProgress),lastDeath,conversation:this.conversation(),remainingPlanningRounds:PLANNING_ROUNDS-planningRound})
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
        // The food floor (food-floor.js): under a full bar of carried food in Overworld
        // daylight, the bot gets food before the request's next step, on its own.
        const errand=keepFoodFloor(this,epoch,abort.signal);if(errand){await errand;if(epoch!==this.epoch)return}
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
        const labels={emote:s=>`${s.item} ${s.count>1?s.count+' times':'once'}`,throw_eye:()=>'throw an eye of ender and watch where it flies',stand:s=>`wall in and fight endermen through a port for ${s.count} ender pearl${s.count===1?'':'s'}`,trade:s=>`trade with the nearest villager for ${s.item?`${s.count} ${s.item.replaceAll('_',' ')}`:'whatever I can afford'}`,use_portal:()=>'go through the portal and step out on the other side',travel:s=>`walk to observed ground at ${s.target.x}, ${s.target.y}, ${s.target.z}`,goto:s=>`Going to ${s.target.x},${s.target.y},${s.target.z}${s.target.exact?' to stand on that exact cell':''}${s.target.dig?', digging through':''}`,place_at:s=>`place one ${String(s.item).replaceAll('_',' ')} at ${s.target.x}, ${s.target.y}, ${s.target.z}`,attack:s=>`attack the nearest ${String(s.item).replaceAll('_',' ')}`,shoot:s=>`shoot the nearest ${String(s.item).replaceAll('_',' ')} with the bow`,collect:s=>`pick up ${s.count} ${s.item?String(s.item).replaceAll('_',' '):'dropped items'} lying nearby`,dig:s=>`Digging ${s.count} blocks toward ${s.target.x},${s.target.y},${s.target.z}`,descend:()=> 'find a checked route down from the canopy',climb:()=> 'climb to an observed exit from this pit',leave_base:()=> 'leave the base and close its door',tunnel_out:()=> 'open the back exit down through the base floor into rock',retreat:()=> 'enter the verified lit base and close its door',harvest:s=>`harvest renewable berries until I carry ${s.count}`,make_obsidian:s=>`turn open lava into obsidian and mine it until I carry ${s.count}`,hunt:s=>`hunt nearby animals for ${s.count} ${String(s.item).replaceAll('_',' ')}`,eat:s=>`eat up to ${s.count} ${s.item.replaceAll('_',' ')} while hungry`,sleep:()=> 'sleep the night through in a bed',use:s=>`use the ${String(s.item).replaceAll('_',' ')} ${s.target?.how==='point'?'in the air at':'on the block at'} ${s.target?.x}, ${s.target?.y}, ${s.target?.z}`,revise:s=>`revise ${s.name} while preserving the rest of its saved structure`,construct:s=>{const r=this.projects[s.name]?.result;return r&&!r.partial?`verify ${s.name} and walk its access routes`:r?Number.isInteger(r.verifiedBlocks)?`continue ${s.name} from ${r.verifiedBlocks} of ${r.totalBlocks} blocks`:`continue ${s.name} after checking its saved prerequisites`:`build ${s.name} and check its access when finished`},prepare:s=>`prepare ${s.count} serviceable ${s.item.replaceAll('_',' ')}`,stow:()=> 'unload excavation rubble into the base chest',prospect:s=>`prospect for ${s.count} ${s.item.replaceAll('_',' ')} and return to base`,return_base:()=>'return along the saved route to base',place:s=>`place a base ${s.item.replaceAll('_',' ')}`,deposit:s=>`store a total of ${s.count} ${s.item.replaceAll('_',' ')} in the base chest`,withdraw:s=>`retrieve ${s.item.replaceAll('_',' ')} until I carry ${s.count}`,smelt:s=>`smelt ${s.item.replaceAll('_',' ')} until I carry ${s.count}`,check_base:()=> 'verify base access, workstations, lighting and storage',remember:s=>`save your location as ${s.name}`,return:s=>`return to ${s.name}`,come:()=> 'come to you',follow:()=> 'follow you',gather:s=>`collect a total of ${s.count} ${resourceLabel(s.item||'oak_log')}`,inspect:()=> 'inspect my surroundings',acquire:s=>`obtain ${s.count} ${s.item.replaceAll('_',' ')}`,give:s=>`hand you ${s.count} ${s.item.replaceAll('_',' ')}`,build:s=>`obtain any missing materials and construct the ${s.design.length}-block design`}
        // Every planner action needs a spoken label; an unlabelled one must not end the round.
        const label=s=>(labels[s.action]||(x=>`${x.action.replaceAll('_',' ')}${x.item?` ${x.count||''} ${String(x.item).replaceAll('_',' ')}`.replace(/\s+/g,' '):''}`))(s)
        this.say('I will '+plan.steps.map(label).join(', then ')+'.','assistant',{game:false});this.phase='acting'
        // In game chat the plan's own reply speaks for the round, once per new wording.
        if(this.conversation()&&plan.reply&&plan.reply!==this.lastChatReply){this.lastChatReply=plan.reply;this.say(plan.reply)}
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
              const p=this.runner.bot?.players[this.recipient()]?.entity?.position
              if(!p)throw new Error(`${this.recipient()} is not visible`)
              this.places[step.name]={x:p.x,y:p.y,z:p.z,dimension:dimensionOf(this.runner.bot)||'overworld'};this.persist()
            } else if(step.action==='follow') {
              if(!this.runner.bot?.players[this.recipient()]?.entity)throw new Error(`${this.recipient()} is not visible`)
              await this.leaveOccupiedShelter(abort.signal)
              if(epoch!==this.epoch)return
              await this.runner.waitForIdle?.(abort.signal)
              if(epoch!==this.epoch||abort.signal.aborted)return
              this.dispatch({action:'follow',player:this.recipient()})
            } else if(step.action==='inspect') {
              if(step.item){applyInspectBlockRequest(this.requestProgress,step.item);this.persist()}
            } else if(step.action!=='inspect') {
              let command
              if(step.action==='gather'){const sites=projectFootprints(this.projects,dimensionOf(this.runner.bot));command={action:'gather',goal:{item:step.item||'oak_log',count:step.count,...(sites.length?{protectedSites:sites}:{})},timeoutMs:180000}}
              else if(['acquire','prepare','eat','harvest','hunt'].includes(step.action))command={action:step.action,goal:{item:step.item,count:step.count},timeoutMs:600000}
              else if(OBSIDIAN_ACTIONS.includes(step.action))command={action:'make_obsidian',goal:validateObsidianGoal({count:step.count,protectedSites:projectFootprints(this.projects,dimensionOf(this.runner.bot))}),timeoutMs:600000}
              else if(step.action==='travel')command={action:'travel',goal:validateObservedTravelGoal(this.runner.bot,step.target),timeoutMs:180000}
              else if(step.action==='emote')command={action:'emote',goal:{move:step.item,count:step.count||1},timeoutMs:30000}
              else if(step.action==='throw_eye')command={action:'throw_eye',goal:{},timeoutMs:EYE.timeoutMs}
              else if(step.action==='stand')command={action:'stand',goal:validateStandGoal({item:step.item,count:step.count}),timeoutMs:STAND.timeoutMs}
              else if(step.action==='trade')command={action:'trade',goal:{item:step.item||'',count:step.count||1},timeoutMs:120000}
              else if(step.action==='goto')command={action:'goto',goal:validateGotoGoal({...step.target,protectedSites:projectFootprints(this.projects,dimensionOf(this.runner.bot))}),timeoutMs:180000}
              else if(step.action==='dig')command={action:'dig',goal:validateDigGoal({...step.target,count:step.count,protectedSites:projectFootprints(this.projects,dimensionOf(this.runner.bot))}),timeoutMs:120000}
              else if(step.action==='place_at')command={action:'place_at',goal:validatePlaceAtGoal({...step.target,item:step.item,protectedSites:projectFootprints(this.projects,dimensionOf(this.runner.bot))}),timeoutMs:90000}
              else if(step.action==='collect')command={action:'collect',goal:validateCollectGoal({item:step.item||'',count:step.count,protectedSites:projectFootprints(this.projects,dimensionOf(this.runner.bot))}),timeoutMs:120000}
              else if(step.action==='attack')command={action:'attack',goal:validateAttackGoal({type:step.item}),timeoutMs:120000}
              else if(step.action==='shoot')command={action:'shoot',goal:validateAttackGoal({type:step.item}),timeoutMs:120000}
              else if(step.action==='use')command={action:'use',goal:validateUseGoal({item:step.item,count:1,expect:step.name,target:step.target,protectedSites:projectFootprints(this.projects,dimensionOf(this.runner.bot))}),timeoutMs:120000}
              else if(['descend','climb'].includes(step.action))command={action:step.action,goal:{},timeoutMs:45000}
              else if(step.action==='use_portal'){const refused=portalRefusal(this.runner.bot,{netherAllowed:this.runner.portalTravel?.allows?.('the_nether')===true,endAllowed:this.runner.portalTravel?.allows?.('the_end')===true});if(refused)throw new Error(refused);command={action:'use_portal',goal:{},timeoutMs:90000}}
              else if(step.action==='sleep')command={action:'sleep',goal:this.projects.base?{project:structuredClone(this.projects.base)}:{},timeoutMs:180000}
              else if(step.action==='give')command={action:'give',goal:{item:step.item,count:step.count-deliveredCount(feedback,step.item),player:this.recipient()},timeoutMs:30000}
              else if([...STATION_ACTIONS,...EXPEDITION_ACTIONS].includes(step.action)){
                const occupied=step.action==='leave_base'?occupiedAlternative(this.runner.bot,this.projects):null
                if(!this.projects.base&&!occupied&&step.action!=='smelt')throw new Error('No saved base; build or identify a shelter first')
                if(this.projects.base&&!occupied&&!sameDimension(this.runner.bot,this.projects.base))throw new Error(`The base is in the ${projectDimension(this.projects.base)}; go back through the portal before using it`)
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
                command={action:'construct',goal:{name:step.name,design,...(previousDesign?{previousDesign}:{}),near:{x:near.x,y:near.y,z:near.z},...(saved?.origin?{origin:saved.origin}:{protectedSites:projectFootprints(this.projects,dimensionOf(this.runner.bot)),constructionLimits:constructionLimits(this.requestProgress.goal,step.name)})},timeoutMs:600000}
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
                  return from?{origin:from.origin,...(from.wood?{wood:from.wood}:{})}:{protectedSites:projectFootprints(this.projects,dimensionOf(this.runner.bot))}
                }).call(this)},timeoutMs:600000}
              } else {
                const p=step.action==='come'?this.runner.bot?.players[this.recipient()]?.entity?.position:this.places[step.name]
                if(!p)throw new Error('That location is unavailable. Come into view or name a saved place.')
                if(step.action!=='come'&&!sameDimension(this.runner.bot,p))throw new Error(`${step.name} is in the ${projectDimension(p)}; go through the portal before walking there`)
                // The pathfinder searches a bounded region, so one goto across a
                // hundred blocks reports no route where an easy walk exists. Cross
                // real distances in stages instead.
                const here=this.runner.position()
                const far=here&&Math.hypot(p.x-here.x,p.z-here.z)>64
                command=step.action==='come'?{action:'travel',goal:{x:p.x,y:p.y,z:p.z,player:this.recipient()},timeoutMs:180000}:far?{action:'travel',goal:{x:p.x,y:p.y,z:p.z},timeoutMs:600000}
                             :{action:'navigate',goal:{x:p.x,y:p.y,z:p.z},timeoutMs:120000}
              }
              await this.execute(command,abort.signal,id=>{requestTasks.add(id);this.requestProgress.inFlight={taskId:id,step};this.persist()})
            }
            if(epoch!==this.epoch)return
            const result=['come','gather','acquire','build','construct','revise','give','eat','harvest','hunt','sleep','descend','climb','use_portal','travel','goto','emote','trade','throw_eye','stand','dig','place_at','collect','attack','shoot','use',...PREPARE_ACTIONS,...OBSIDIAN_ACTIONS,...STATION_ACTIONS,...EXPEDITION_ACTIONS].includes(step.action)?structuredClone(this.runner.task?.result||null):null
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
            const adaptive=plan.steps.some(s=>['come','acquire','build','construct','revise','inspect','give','eat','harvest','hunt','sleep','descend','climb','use_portal','travel','goto','dig','place_at','collect','attack','shoot','use',...PREPARE_ACTIONS,...OBSIDIAN_ACTIONS,...STATION_ACTIONS,...EXPEDITION_ACTIONS].includes(s.action))
            if(!adaptive||failureCount>=2)throw error
            this.dispatch({action:'stop'});this.say(`Blocked: ${error.message}. I will inspect the result and revise the plan.`);failed=true;break
          }
        }
        if(epoch!==this.epoch)return
        if(executed||failed)skillControl?.outcome(feedback.at(-1))
        if(!executed&&!failed&&!this.requestProgress.goal){this.phase='ready';this.activity='';this.requestProgress.status='steps_completed';this.requestProgress.pending=[];this.say('I checked those steps; they are already satisfied.');episode?.end('actions_finished',{feedback});this.emit('change');return}
        const fingerprint=progressFingerprint(this.snapshot());stagnant=fingerprint===lastFingerprint?stagnant+1:0;lastFingerprint=fingerprint
        if(stagnant>=3)throw new Error('No observed progress for three planning rounds. Progress is saved; resolve the blocker and Resume.')
        if(this.requestProgress.goal||failed||plan.steps.some(s=>['come','use','goto','dig','place_at','collect','attack','shoot','acquire','build','construct','revise','inspect','give','eat','harvest','hunt','sleep','descend','climb','use_portal','travel',...PREPARE_ACTIONS,...OBSIDIAN_ACTIONS,...STATION_ACTIONS,...EXPEDITION_ACTIONS].includes(s.action))){this.phase='thinking';continue}
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
      // Down the back exit the base is above, not around: there is no door to
      // leave by and the night rules do not reach into rock. Work starts here.
      if(inBackExit(this.runner.bot,this.projects.base))return
      const occupied=insideBase(this.runner.bot,this.projects.base)?{name:'base',project:this.projects.base}:occupiedAlternative(this.runner.bot,this.projects)
      if(occupied&&occupied.name!==destinationName){
        const refusal=departureRefusal(this.runner.bot,this.projects.base);if(refusal)throw refusal
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
    if(!deferredDeparture&&!['defend','eat','craft','stop','leave_base','burrow','unburrow','flee','hut','climb','descend','tunnel_out'].includes(command.action))await this.leaveOccupiedShelter(signal,command.action==='retreat'?(command.goal?.shelter?.name||'base'):null)
    // The planner's own leave_base is the same door with the same answer.
    if(command.action==='leave_base'&&(insideBase(this.runner.bot,this.projects.base)||occupiedAlternative(this.runner.bot,this.projects))){const refusal=departureRefusal(this.runner.bot,this.projects.base);if(refusal)throw refusal}
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
