export const PLANNING_ROUNDS=24
// A starter shelter goes near the owner when they are in view; a bot working
// alone in a fresh world anchors the site to its own position instead.
export function buildSiteAnchor(runner){
 const owner=runner.bot?.players?.[runner.owner]?.entity?.position
 if(owner)return {near:{x:owner.x,y:owner.y,z:owner.z},anchor:'owner'}
 const self=runner.position?.()
 if(self)return {near:{x:self.x,y:self.y,z:self.z},anchor:'agent'}
 return null
}
// A saved base can only anchor a shelter build while it is close enough to be
// tonight's shelter. The same 64 blocks the planner already treats as a staged
// walk: beyond it the agent builds where it stands.
export const BASE_REACH_BLOCKS=64
export const withinBuildReach=(near,origin)=>!!near&&!!origin&&Math.hypot(origin.x-near.x,origin.z-near.z)<=BASE_REACH_BLOCKS
// No model call happens while the agent is dead, so death recovery cannot be a
// planner verb; the controller brings it back itself. Bounded, because
// respawning into whatever just killed you is a death loop, and a stopped agent
// is recoverable while a looping one grinds the world down.
export const AUTO_RESPAWN_LIMIT=2
export const ACTIVE_BUDGET_MS=45*60*1000
// A request that runs out of rounds or time while still completing steps
// continues on its own, at most twice, instead of waiting for a manual Resume.
export const BUDGET_CONTINUATIONS=2
// A model call that never answered says nothing about whether the request can be
// done: no step ran, nothing was tried, nothing was learned. Treating that as
// terminal cost a whole unattended hour to one slow planning call, with the agent
// surviving on the safety system and never being asked again.
export const PLAN_RETRIES=2
// After a safety episode (shelter, burrow, hut, combat) the request continues on
// its own while it keeps completing steps between episodes, at most six times.
// A blocked request means the plan failed and a human should look, which is
// right when a human is looking. Unattended it is how a run dies quietly: on
// the persistent world "get a diamond" blocked at its first step and sat for
// eight hours, alive and at full health. Retry a few times, then stop loudly.
export const STALL_CONTINUATIONS=3, STALL_RETRY_MS=90000
export const SAFETY_CONTINUATIONS=6,IDLE_CONTINUATIONS=2
export const SHELTERED_CALLS=6
export function canContinueAfterSafety(request,limit=SAFETY_CONTINUATIONS,{protectedPlanning=false}={}){
 // Both caps count the run since the last explicit Resume: the user re-engaged.
 const serial=request?.resumeSerial||0,run=(request?.safetyContinuations||[]).filter(c=>(c.resumeSerial||0)===serial)
 if(run.length>=limit)return false
 // A fresh protected decision can reconsider failed work without waiting for a
 // completed step. It shares the episode cap and consumes its finite call cap.
 if(protectedPlanning){const calls=request?.shelteredCalls??0;return Number.isInteger(calls)&&calls>=0&&calls<SHELTERED_CALLS}
 // An entry without a recorded step count predates this rule: stay one-shot for it.
 const last=run.at(-1);if(!last)return true
 if(!Number.isInteger(last.completedAt))return false
 const done=request.completed?.length||0
 if(done>last.completedAt)return true
 // Threats can repeat before any step completes; allow a short run of idle
 // continuations at the same step count before requiring an explicit Resume.
 return run.filter(c=>c.completedAt===done).length<IDLE_CONTINUATIONS
}
export function shouldContinueAfterBudget(request,completedAtStart,message){
 return /^(Active planning time limit|Planning limit reached)/.test(message||'')&&(request?.completed?.length||0)>completedAtStart&&(request?.budgetContinuations||0)<BUDGET_CONTINUATIONS
}
export function shouldRetryPlanning(request,completedAtStart,message){
 return /(exceeded its \d+ second budget|could not be reached|fetch failed|was cancelled)/i.test(message||'')
  &&(request?.completed?.length||0)===completedAtStart
  &&(request?.planRetries||0)<PLAN_RETRIES
}
export const canResume=request=>!!request&&['blocked','interrupted','paused'].includes(request.status)&&!request.reviewRequired
export function progressFingerprint(snapshot){
 const e=snapshot.projects?.base?.expedition
 return JSON.stringify({inventory:snapshot.inventory,tools:snapshot.tools,places:snapshot.places,
  construction:Object.entries(snapshot.projects||{}).filter(([,p])=>p.construction).map(([name,p])=>[name,p.progress?.verifiedBlocks,p.result?.verifiedBlocks]),goalChecks:snapshot.requestProgress?.verification?.checks?.map(c=>[c.kind,c.target,c.passed,c.observed]),base:snapshot.projects?.base?.stations,frontier:e?.frontier?.at(-1),search:e?.searchSteps,rejected:e?.rejected?.map(r=>[r.item,r.position]),
  outcomes:[...new Set(snapshot.requestProgress?.completed?.filter(c=>c.result&&!c.result.partial).map(c=>JSON.stringify([c.step,c.result]))||[])],// Floored: runner.js returns raw floats, so a bot standing still changed its
 // own fingerprint by micrometres and defeated both planner stop rules, which
 // each need identical consecutive fingerprints to fire.
 position:snapshot.position?{x:Math.floor(snapshot.position.x),y:Math.floor(snapshot.position.y),z:Math.floor(snapshot.position.z)}:null})
}
// progressFingerprint refreshes on any movement or a travel that completes, so a
 // request can churn for hundreds of rounds while no goal criterion ever flips.
 // This fingerprint ignores position and feedback; only check outcomes and
 // milestone status count. After CRITERION_STALL_ROUNDS identical rounds the
 // controller halts with reviewRequired so stallRetry cannot resurrect it.
 // Below PLANNING_ROUNDS on purpose: one loop can reach it, so a single run is
 // enough to halt and a test can drive it without a 90 second stall retry.
export const CRITERION_STALL_ROUNDS=20
const coarseObserved=v=>{
 if(v===null||v===undefined)return 'null'
 if(typeof v==='object')return JSON.stringify(v)
 return v
}
export function criterionFingerprint(verification,mission){
 const checks=(verification?.checks||[]).map(c=>[c.kind,c.item,c.target,!!c.passed,coarseObserved(c.observed)])
 const nodes=(mission?.nodes||[]).map(n=>`${n.id}:${n.status}`)
 return JSON.stringify({checks,nodes})
}
export function criterionStall(request){
 const rounds=request?.criterionStallRounds||0
 return {stalled:rounds>=CRITERION_STALL_ROUNDS,rounds,since:request?.criterionStallSince??null}
}
export function noteCriterionStall(request){
 if(!request)return criterionStall(request)
 const fp=criterionFingerprint(request.verification,request.mission)
 const round=request.rounds||0
 if(request.criterionFingerprint===fp)request.criterionStallRounds=(request.criterionStallRounds||0)+1
 else{request.criterionFingerprint=fp;request.criterionStallRounds=0;request.criterionStallSince=round}
 return criterionStall(request)
}
export function interruptedEffect(task){
 if(task?.consumption?.uncertain)return 'Interrupted eating needs hunger and inventory review before a new request.'
 if(task?.use?.uncertain)return 'An interrupted use may have charged the item without a confirmed effect. Re-observe the target block and the inventory before continuing.'
 if(task?.transfer?.uncertain||task?.delivery?.attempted&&!task?.delivery?.confirmed&&task.status!=='completed')return 'The interrupted inventory transfer needs review before continuing. Inspect the recipient or chest and start a new request.'
 return null
}
