// Threat judgement: a typed second opinion from TypeSafe's Jev on what a careful
// player would do about the hostiles in view. Shadow mode only: the safety chain
// still acts on its own rules, and every judgement is logged beside the rule's
// verdict so the two can be compared on real situations before Jev is allowed
// to change anything. Sov's steer of 12 September: fight and survive with
// judgement, not always flee and hide. The rule cannot judge; this can.
import {execFileSync} from 'node:child_process'
import {RANGED,CLOSE_FLOORS} from './survival.js'

export const JUDGEMENT_URL='https://api.typesafe.ai/v1/systemone'
export const DEFAULT_MODEL='jev-latest'
const WEAPON_DAMAGE={wooden_axe:7,golden_axe:7,stone_axe:9,iron_axe:9,diamond_axe:9,netherite_axe:10,wooden_sword:4,golden_sword:4,stone_sword:5,iron_sword:6,diamond_sword:7,netherite_sword:8}
const BLOCKS=/cobblestone|dirt|planks|_log$|stone$/
export const dayPhase=t=>!Number.isFinite(t)?'unknown':t<1000?'dawn':t<11500?'day':t<13000?'dusk':t<23000?'night':'dawn'

// The key is read once at startup. A developer shell sets TYPESAFE_API_KEY; the
// packaged app has no environment, so it asks the login Keychain, where the
// key was stored by hand. No key means the judge is off, never a guess.
export function resolveKey(env=process.env,platform=process.platform){
 if(env.MC_THREAT_JUDGE==='0')return null
 if(env.TYPESAFE_API_KEY)return env.TYPESAFE_API_KEY
 if(!env.MC_SETUP_FILE||platform!=='darwin')return null
 try{return execFileSync('/usr/bin/security',['find-generic-password','-s','TYPESAFE_API_KEY','-w'],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','ignore']}).trim()||null}catch{return null}
}

// What the bot sees, named for a reader who does not know the harness. Facts the
// model cannot see in the numbers (regeneration, creeper fuse, arrow range) ride
// along as mechanics; the model judges, the state informs.
export function threatState(observation,{weapon=null,armour=[],tools=[],inventory={},sheltered=false,shelterAvailable=false,baseDistance=null,evidence=null,contextMode='rich'}={}){
 const s=observation||{}
 return {
  situation:'A Minecraft Java survival-mode agent is in the middle of a work task (gathering, building or mining) and hostile mobs have been observed nearby. Judge what a skilled, careful player would do right now.',
  agent:{
   health:`${s.health} of 20`,hunger:`${s.food} of 20`,
   carriedFood:(s.carriedFood||[]).map(f=>`${f.count} ${f.name.replaceAll('_',' ')}`),
   bestMeleeWeapon:weapon&&WEAPON_DAMAGE[weapon]?`${weapon.replaceAll('_',' ')} (${WEAPON_DAMAGE[weapon]} damage per hit)`:'none (bare hands, 1 damage per hit)',
   armourWorn:armour.length?armour.map(a=>a.replaceAll('_',' ')).join(', '):'none',
   tools:tools.map(t=>String(t).replaceAll('_',' ')),
   blocksCarried:Object.entries(inventory).filter(([k])=>BLOCKS.test(k)).map(([k,v])=>`${v} ${k.replaceAll('_',' ')}`),
   torches:inventory.torch||0,
   insideVerifiedShelter:sheltered===true,
   litBase:shelterAvailable?`available${Number.isFinite(baseDistance)?`, ${Math.round(baseDistance)} blocks away`:''}`:'none'
  },
  world:{timeOfDay:s.timeOfDay??null,phase:dayPhase(s.timeOfDay),difficulty:s.difficulty??null},
  threats:(s.nearbyThreats||[]).map(t=>({mob:t.name,distanceBlocks:t.distance,attacksFromRange:RANGED.has(t.name),risk:t.risk==='conditional'?'neutral unless provoked (or a daylight spider)':'hostile',...(contextMode!=='legacy'?{verticalOffset:t.verticalOffset??null,sightline:t.sightline??{status:'unknown'}}:{})})),
  ...(contextMode!=='legacy'&&evidence?{decisionContext:evidence}:{}),
  mechanics:[
   ...(contextMode!=='legacy'?['Sightline is a current eye-to-body ray through observed terrain. Blocked means a block obstructs that ray, not that pursuit or every attack is impossible. Negative vertical offset means the mob is below the agent. Recheck after moving or leaving a shelter; its current walls may be the obstruction.']:[]),
   'Natural health regeneration only happens when hunger is 18 or more; below that, lost health does not come back without food.',
   'A creeper explodes after about 1.5 seconds within 3 blocks and cannot be fought bare-handed safely.',
   'Skeletons and pillagers shoot arrows from up to about 16 blocks; zombies, spiders and husks must reach melee range.',
   contextMode==='legacy'?'Zombies and skeletons have 20 health and burn in direct daylight; spiders are neutral in daylight; creepers and pillagers do not burn.':'Zombies and skeletons can burn in direct sunlight, but head equipment or shade can prevent burning. Do not assume sunlight or an unprotected head when unknown. Spiders are usually neutral in daylight; creepers and pillagers do not burn.',
   'Each mob attack costs roughly 2 to 5 health without armour. Dying drops the whole inventory.',
   contextMode==='legacy'?'Digging into the ground and capping the hole, or walling in, takes a few seconds and is safe from everything except explosions at the wall.':'Sheltering needs suitable terrain, tools or blocks and a verified enclosure. Escape movement is not proof pursuit ended. Consider whether past responses enabled the actual objective.'
  ]
 }
}
export const THREAT_QUESTIONS={
 response:{type:'choice',instructions:'Which action should the agent take right now in response to the observed threats?',criteria:{
  fight:'Close in and attack the most dangerous nearby threat with the carried weapon; the agent has enough health, hunger and weapon to win without serious risk.',
  evade:'Move away from the threats to keep working elsewhere; no enclosed shelter needed because the threats are slow, far, or will burn off or lose interest.',
  shelter:'Stop work now and get behind blocks: dig in and cap the hole, wall in, or run to the base. The threats cannot be safely fought or outrun.',
  continue:'Keep working; the threats are too far, neutral, or not a real danger, and interrupting would only cost progress.'}},
 interrupt:{type:'noul',instructions:'Should the agent stop its current work right now because of these threats?',criteria:{true:'Yes, the threats need a response before any more work is done.',false:'No, the agent can keep working for now and watch the threats.'}},
 danger:{type:'score',instructions:"How dangerous is the agent's situation right now if it does nothing?",criteria:['No real danger: threats are far, neutral or blocked','Manageable: some risk, but a careful player would handle it without losing much health','Serious: the agent will probably take real damage within seconds','Lethal: standing still or continuing to work will very likely kill the agent']},
 winnable:{type:'noul',instructions:'If the agent attacks the closest hostile threat right now with what it carries, will it most likely kill it without dropping below half health?',criteria:{true:'Yes, a clear win with margin.',false:'No: too many mobs, a ranged or exploding mob, no weapon, or too little health.'}}
}
// One request, four independent answers. A slow answer is worth nothing to a
// safety tick, so the call is bounded and a timeout is an ordinary failure.
export async function judgeThreat(state,{fetch=globalThis.fetch,key,model=DEFAULT_MODEL,timeoutMs=2500}={}){
 if(!key)throw new Error('No TypeSafe key')
 const started=Date.now(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs)
 try{
  const response=await fetch(JUDGEMENT_URL,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({state,model,questions:THREAT_QUESTIONS}),signal:controller.signal})
  const body=await response.json()
  if(!response.ok)throw new Error(`TypeSafe HTTP ${response.status}: ${JSON.stringify(body).slice(0,160)}`)
  const a=body.answers||{}
  if(!a.response?.choice||!Number.isFinite(a.interrupt?.noul)||!Number.isFinite(a.danger?.score)||!Number.isFinite(a.winnable?.noul))throw new Error('TypeSafe answer is missing a question')
  return {model:body.model||model,response:a.response.choice,confidence:a.response.confidence,probabilities:a.response.probabilities,interrupt:a.interrupt.noul,danger:a.danger.score,winnable:a.winnable.noul,latencyMs:Date.now()-started,inputTokens:body.usage?.input_tokens??null}
 }catch(error){throw error.name==='AbortError'?new Error(`TypeSafe did not answer within ${timeoutMs}ms`):error}
 finally{clearTimeout(timer)}
}
// The safety chain's own answer in the judge's vocabulary, so the log compares like with like.
export function harnessVerdict(decision,observation){
 if(decision?.engage)return {verdict:'fight',reason:`defend against the ${decision.target?.targetName} with the ${String(decision.weapon).replaceAll('_',' ')}`}
 if((observation?.nearbyThreats||[]).some(t=>t.name==='creeper'&&t.risk==='potential_hostile'&&t.distance<=16))return {verdict:'evade',reason:'a creeper is within sixteen blocks: sprint clear, then shelter'}
 return {verdict:'shelter',reason:decision?.reason||'retreat, dig in or wall in'}
}
// Worn armour sits in equipment slots the item list does not include; armor.js reads them the same way.
export const wornArmour=bot=>['head','torso','legs','feet'].map(slot=>{const i=bot?.getEquipmentDestSlot?.(slot);return Number.isInteger(i)?bot.inventory?.slots?.[i]?.name:null}).filter(Boolean)
// Control mode. Code keeps the floors a player would never argue with; Jev
// judges between them. Nothing here fires unless MC_THREAT_JUDGE=control.
export const CONTROL=process.env.MC_THREAT_JUDGE==='control'
export const FLOORS={...CLOSE_FLOORS,health:8,fightHealth:10,fightFood:8,continueInterrupt:0.4,overrideConfidence:0.3,holdMs:10000}
// A hostile in arm's reach, a creeper in fuse range or a bot already hurt is not a judgement call.
export function forcedInterruption(observation,floors=FLOORS){
 const threats=(observation?.nearbyThreats||[]).filter(t=>t.risk==='potential_hostile')
 if(Number.isFinite(observation?.health)&&observation.health<=floors.health)return 'health at or below the floor'
 if(threats.some(t=>t.name==='creeper'&&t.distance<=floors.creeper))return 'a creeper inside fuse range'
 if(threats.some(t=>t.distance<=floors.melee))return 'a hostile in melee reach'
 return null
}
// Whether work stops at all: Jev's call, unless it did not answer.
export function gateVerdict(judgement,floors=FLOORS){
 if(!judgement)return 'interrupt'
 return judgement.response==='continue'||judgement.interrupt<floors.continueInterrupt?'continue':'interrupt'
}
// What the interruption does. An unsure answer defers to the rule; continue at
// this point (the gate already passed) means the same as evade.
export function chooseResponse(judgement,ruleVerdict,floors=FLOORS){
 if(!judgement||judgement.confidence<floors.overrideConfidence)return {response:ruleVerdict,source:judgement?'rule (judgement unsure)':'rule (no judgement)'}
 const response=judgement.response==='continue'?'evade':judgement.response
 return {response,source:'jev'}
}
export class ThreatJudge{
 constructor({key=resolveKey(),model=process.env.TYPESAFE_MODEL||DEFAULT_MODEL,fetch=globalThis.fetch,log=()=>{},timeoutMs=2500,minWatchIntervalMs=15000,now=Date.now,control=CONTROL,floors=FLOORS}={}){
  Object.assign(this,{key,model,fetch,log,timeoutMs,minWatchIntervalMs,now,floors});this.enabled=!!key;this.control=this.enabled&&!!control;this.lastWatchAt=0;this.failures=0
  if(!this.enabled)log('threat_judgement_disabled',{reason:'No TypeSafe key in the environment or the login Keychain',controlRequested:!!control})
  else log('threat_judgement_mode',{mode:this.control?'control':'shadow',model})
 }
 // kind: 'gate' before the rule interrupts (control mode), 'interruption' at the
 // moment the chain decides, 'watch' (throttled) when hostiles are in view but
 // nothing has interrupted. Never throws.
 async judge(kind,observation,extras={}){
  if(!this.enabled)return null
  if(kind==='watch'){const t=this.now();if(t-this.lastWatchAt<this.minWatchIntervalMs)return null;this.lastWatchAt=t}
  const {harness=null,harnessReason=null,...context}=extras,state=threatState(observation,context)
  try{
   const answer=await judgeThreat(state,{fetch:this.fetch,key:this.key,model:this.model,timeoutMs:this.timeoutMs})
   this.failures=0
   const agrees=kind==='gate'?gateVerdict(answer,this.floors)==='interrupt':harness?answer.response===harness:null
   const event={kind,harness,harnessReason,...answer,agrees,state}
   this.log('threat_judgement',event);return event
  }catch(error){
   // Three failures are worth reading; a dead endpoint is not worth a log line per tick.
   if(++this.failures<=3)this.log('threat_judgement_failed',{kind,error:error.message,...(this.failures===3?{note:'further failures are not logged until one succeeds'}:{})})
   return null
  }
 }
}
