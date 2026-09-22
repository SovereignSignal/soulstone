import {survivalObservation} from '../survival.js'

export function recoveryState(bot){
 const s=survivalObservation(bot),p=bot?.entity?.position
 return {health:s.health,hunger:s.food,timeOfDay:s.timeOfDay,position:p?{x:p.x,y:p.y,z:p.z}:null,
  threats:s.nearbyThreats.slice(0,6).map(t=>{
   const e=Object.values(bot?.entities||{}).find(e=>e.name===t.name&&e.position&&Math.hypot(e.position.x-t.position.x,e.position.y-t.position.y,e.position.z-t.position.z)<.01)
   return {...t,id:e?.uuid||null,headEquipment:e?.equipment&&5 in e.equipment?(e.equipment[5]?.name||'none'):null}
  }),coverage:s.threatCoverage}
}
export function recentRecovery(controller){
 return (controller.recoveryHistory||[]).filter(e=>e.connectionId===controller.runner.connectionId&&e.requestId===(controller.requestProgress?.id||null)).slice(-8)
}
export function recoveryContext(controller,bot){
 const r=controller.requestProgress
 return {objective:r?{request:r.request,remaining:r.verification?.missing||null,completedSteps:r.completed?.length||0}:null,
  observed:recoveryState(bot),recentAttempts:recentRecovery(controller),
  uncertainty:'Only loaded entities are observed. Absence from this list does not establish death or ended pursuit. Head equipment null means unknown. Proximity alone does not establish a clear attack or escape route.'}
}
export function recordRecovery(controller,entry){
 controller.recoveryHistory=[...(controller.recoveryHistory||[]),entry].slice(-16)
 controller.runner.log?.('recovery_outcome',entry);controller.persist()
}
