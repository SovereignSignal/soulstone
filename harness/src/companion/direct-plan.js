import { resourceCount, LOG_ITEMS } from '../resources.js'

// Compile complete, unambiguous requests before invoking a language model.
// Anchoring prevents partial execution of negations, conditions or compound jobs.
const amounts = ['one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen']
const quantity = `(?:\\d+|${amounts.join('|')}|some)`
const species = LOG_ITEMS.map(n => n.replace('_log', '').replaceAll('_', '[ _]')).join('|')
const woodRequest = new RegExp(`^(?:please )?(?:(?:can|could|would) you )?(?:go (?:and )?)?(?:chop(?: down)?|cut(?: down)?|gather|collect|get|fetch|harvest|mine|pick up) (?:me )?(?:(${quantity}) )?(?:(${species}) )?(?:wood|logs?|trees?|timber|lumber)(?: for me)?(?: please)?[.!?]*$`, 'i')
// Only complete regroup requests take this fast path. Compound jobs, negation
// and named destinations stay with the normal intent/goal planner.
export function regroupPlan(text,observation={}) {
 if(!/^(?:please )?(?:(?:can|could|would) you )?(?:(?:come|come back|join|meet)(?: (?:to )?(?:me|us|here|over here|the team|where (?:all of )?us are playing))|regroup(?: with (?:me|us|the team))?)[.!?]*$/i.test(text.trim()))return null
 const target=observation.ownerPosition,here=observation.position,name=observation.owner||'the team leader'
 if(!target||!here)return {reply:`I cannot currently locate ${name}. Have the team leader come into view or share a meeting point.`,steps:[]}
 if(Math.hypot(target.x-here.x,target.y-here.y,target.z-here.z)<=3)return {reply:`I have regrouped with ${name}.`,steps:[]}
 const feedback=(observation.feedback||[]).filter(f=>!f.beforeResume),last=feedback.at(-1)
 if(last?.status==='failed') {
  if(last.action==='come'){
   const recovery=observation.footing?.support?.name?.endsWith('_leaves')?'descend':'climb'
   if(!feedback.some(f=>f.action===recovery)&&observation.footing?.onGround===true)
    return {reply:'The route is blocked. I will check a safe way out of this terrain, then regroup.',steps:[{action:recovery,name:'',item:'',count:0,design:[]}]}
  }
  return {reply:`I can locate ${name}, but the route is blocked: ${last.reason||'no safe route found'}. Meet me on reachable ground or choose a closer meeting point.`,steps:[]}
 }
 if(feedback.filter(f=>f.action==='come').length>=3)return {reply:`${name} is still out of reach after three approaches. Please pause on reachable ground so I can regroup.`,steps:[]}
 return {reply:`I will regroup with ${name}, checking their position as I travel.`,steps:[{action:'come',name:'',count:0}]}
}

export function directPlan(text, observation = {}) {
  const regroup=regroupPlan(text,observation)
  if(regroup)return regroup
  const request = text.trim()
  const returnSuffix = / (?:and|then|and then) (?:come|go|walk|head) back(?: here| to me)?[.!?]*$| (?:and|then|and then) return(?: here| to me)?[.!?]*$/i
  const back = returnSuffix.test(request)
  const match = request.replace(returnSuffix, '').match(woodRequest)
  if (!match) return null
  const item = match[2] ? match[2].toLowerCase().replaceAll(' ', '_') + '_log' : 'logs'
  const current = resourceCount(observation.inventory || {}, item)
  // Unspecified amount means eight more logs, bounded by the current task limit.
  const count = !match[1] || match[1].toLowerCase() === 'some' ? Math.min(32, current + 8)
    : /^\d+$/.test(match[1]) ? Number(match[1]) : amounts.indexOf(match[1].toLowerCase()) + 1
  if (count < 1 || count > 32) return { reply: 'I can gather 1 to 32 logs per task. Tell me an amount in that range.', steps: [] }
  if (current >= count && !back) return { reply: `I already have ${current} ${item === 'logs' ? 'logs' : item.replaceAll('_', ' ') + 's'}.`, steps: [] }
  const gather = { action: 'gather', name: '', count, item }
  return { reply: 'On it.', steps: back ? [{action:'remember',name:'meeting',count:0}, gather, {action:'return',name:'meeting',count:0}] : [gather] }
}
