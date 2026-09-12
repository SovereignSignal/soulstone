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
