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
export const ACTIVE_BUDGET_MS=45*60*1000
// A request that runs out of rounds or time while still completing steps
// continues on its own, at most twice, instead of waiting for a manual Resume.
export const BUDGET_CONTINUATIONS=2
// After a safety episode (shelter, burrow, hut, combat) the request continues on
// its own while it keeps completing steps between episodes, at most six times.
export const SAFETY_CONTINUATIONS=6,IDLE_CONTINUATIONS=2
export function canContinueAfterSafety(request,limit=SAFETY_CONTINUATIONS){
 const list=request?.safetyContinuations||[];if(list.length>=limit)return false
 // An entry without a recorded step count predates this rule: stay one-shot for it.
 const last=list.at(-1);if(!last)return true
 if(!Number.isInteger(last.completedAt))return false
 const done=request.completed?.length||0
 if(done>last.completedAt)return true
 // Threats can repeat before any step completes; allow a short run of idle
 // continuations at the same step count before requiring an explicit Resume.
 // An explicit Resume starts a fresh run, since the user re-engaged.
 const serial=request.resumeSerial||0
 return list.filter(c=>c.completedAt===done&&(c.resumeSerial||0)===serial).length<IDLE_CONTINUATIONS
}
export function shouldContinueAfterBudget(request,completedAtStart,message){
 return /^(Active planning time limit|Planning limit reached)/.test(message||'')&&(request?.completed?.length||0)>completedAtStart&&(request?.budgetContinuations||0)<BUDGET_CONTINUATIONS
}
export const canResume=request=>!!request&&['blocked','interrupted','paused'].includes(request.status)&&!request.reviewRequired
export function progressFingerprint(snapshot){
 const e=snapshot.projects?.base?.expedition
 return JSON.stringify({inventory:snapshot.inventory,tools:snapshot.tools,places:snapshot.places,
  construction:Object.entries(snapshot.projects||{}).filter(([,p])=>p.construction).map(([name,p])=>[name,p.progress?.verifiedBlocks,p.result?.verifiedBlocks]),goalChecks:snapshot.requestProgress?.verification?.checks.map(c=>[c.kind,c.target,c.passed,c.observed]),base:snapshot.projects?.base?.stations,frontier:e?.frontier?.at(-1),search:e?.searchSteps,rejected:e?.rejected?.map(r=>[r.item,r.position]),
  outcomes:[...new Set(snapshot.requestProgress?.completed.filter(c=>c.result&&!c.result.partial).map(c=>JSON.stringify([c.step,c.result]))||[])],position:snapshot.position})
}
export function interruptedEffect(task){
 if(task?.consumption?.uncertain)return 'Interrupted eating needs hunger and inventory review before a new request.'
 if(task?.transfer?.uncertain||task?.delivery?.attempted&&!task?.delivery?.confirmed&&task.status!=='completed')return 'The interrupted inventory transfer needs review before continuing. Inspect the recipient or chest and start a new request.'
 return null
}
