import {PREPARE_ACTIONS} from '../supplies.js'
import {OBSIDIAN_ACTIONS} from '../obsidian.js'
import {EXPEDITION_ACTIONS} from '../prospecting.js'
import {STATION_ACTIONS} from '../stations.js'
// Conservative permission boundary for this small capability set. The model may
// propose steps, but conversation history cannot silently authorize a new task.
export function guardIntent(plan, request, history = []) {
  // Transferring inventory needs evidence in this request, even when mixed
  // with acquisition/build steps. An unrelated old message cannot authorize it.
  if(plan.steps.some(s=>s.action==='give')&&!/\b(give|bring|deliver|hand|pass|share|drop|toss)\b|\bmake\s+me\b/i.test(request))return {reply:'I need a delivery instruction before handing over inventory.',steps:[]}
  // Open-ended tasks can legitimately require intermediate work absent from
  // the request wording. Typed tool validation owns the execution boundary.
  if(plan.steps.some(s=>['acquire','build','construct','revise','inspect','give','eat','harvest','hunt','sleep','descend','climb','use_portal','travel','goto','emote','trade','throw_eye','dig','place_at','collect','attack','shoot','use',...PREPARE_ACTIONS,...OBSIDIAN_ACTIONS,...STATION_ACTIONS,...EXPEDITION_ACTIONS].includes(s.action)))return plan
  // An empty plan can be a valid completion review, including after mining.
  if (!plan.steps.length) return plan
  // Prevent unrelated substitutions without denying implemented capabilities.
  // Equipment descriptions name materials without requesting their ore.
  const resourceRequest=request.replace(/\b(?:wooden|stone|iron|golden|diamond|netherite)[ _-](?:axe|pickaxe|shovel|hoe|sword|helmet|chestplate|leggings|boots)\b/gi,'equipment')
  if (/\b(?:mine|dig|collect|gather)\b.*\b(?:diamonds?|ores?|coal|iron|gold|redstone|stone|cobblestone)\b/i.test(resourceRequest)) {
    return {reply: 'I could not validate those actions for your mining request. I will wait for a revised instruction.', steps: []}
  }
  let scope = request.toLowerCase()
  if (/^(yes|yes please|go ahead|do that|please do|okay|ok|sure)[.!]?$/i.test(scope.trim())) {
    const last = history.at(-1)
    if (last?.role === 'assistant' && /[?？]/.test(last.text) && /(?:^|[.!]\s+)(?:would you like me to|shall i|should i|do you want me to)\b/i.test(last.text)) scope += ' ' + last.text.toLowerCase()
  }
  const gathering = /\b(wood|oak|logs?|lumber|timber)\b/.test(scope)
  const following = /\b(follow|stay|stick|accompany)\b|by my side|keep up|walk with|tag along/.test(scope)
  const remembering = /\b(remember|save|mark|name)\b|call this|this place is/.test(scope)
  const coming = /\b(come|meet|join|regroup)\b|over here/.test(scope)
  const returning = /\b(return|back|go|head|walk|navigate)\b/.test(scope)
  // Gathering and returning authorizes a temporary meeting-point capture.
  for (const step of plan.steps) {
    const allowed = step.action === 'gather' ? gathering
      : step.action === 'follow' ? following
      : step.action === 'come' ? coming
      : step.action === 'remember' ? remembering || (gathering && returning)
      : step.action === 'return' ? returning : false
    if (!allowed) return { reply: 'I could not validate the proposed actions against your request. I will wait for a revised instruction.', steps: [] }
  }
  return plan
}
