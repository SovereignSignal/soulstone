import {SAFE_FOODS} from '../survival.js'
import {SMELTING} from '../stations.js'
import {MEAT_DROPS} from '../hunt.js'
import {columnAbove} from '../observations.js'
import {dimensionOf} from '../dimension.js'
import {daytimeWork} from './day-routine.js'
import {interruptedEffect} from './continuity.js'

// The food floor: food is kept in the bag before it is needed. pi2, 10 October:
// diamond reached and no deaths, but the bot went a whole day with nothing to eat.
// Overnight its health fell from 12 to 1, and with no food and hunger 10 nothing it
// could do raised it again; at dawn it was still asking for food at the door.
// A full hunger bar's worth carried (cooked beef is 8) is the floor. Below it, in
// Overworld daylight on the surface, the bot gets food before the request's next
// step: cook what it carries raw, eat when hurt or hungry, hunt for meat, cook the
// catch. The planner is not asked to remember; it reads the receipts.
export const FOOD_FLOOR=20
// Meat sought per errand beyond what is already carried raw: two cows' worth.
export const FOOD_HUNT_COUNT=4
// After an errand: two minutes when it brought food back, ten when it found none,
// so an area with no animals costs one hunt, not one per planning round.
export const FOOD_RETRY_MS={gained:120000,interrupted:120000,nothing:600000}
const MEATS=Object.values(MEAT_DROPS)
// The errand is for the open surface. A base roof is one block overhead; more than
// two is underground, where the hunt's legs find no path (pi2, 21:53Z: four blocks of
// rock over the bot's own tunnel at y 54, one block walked, "No path to the goal").
export const SURFACE_COVER=2
// Within this of the hunting ground the hunt's own search covers it.
export const HUNT_GROUND_REACH=24
// Raw -> cooked, from the furnace recipes the smelt action knows.
const COOKS=Object.fromEntries(Object.entries(SMELTING).filter(([out])=>/^(cooked_|baked_)/.test(out)).map(([out,raw])=>[raw,out]))

export function foodPoints(inventory,points){
 return Object.entries(inventory||{}).filter(([name,n])=>SAFE_FOODS.has(name)&&n>0).reduce((sum,[name,n])=>sum+n*(points(name)||0),0)
}
export function foodFloorDue(s){
 const carried=foodPoints(s.inventory,s.points)
 if(carried>=FOOD_FLOOR)return {due:false,carried,reason:`Carrying ${carried} hunger points of food, at or above the floor of ${FOOD_FLOOR}`}
 if(s.dimension!=='overworld')return {due:false,carried,reason:'Food errands run in the Overworld only'}
 if(!daytimeWork(s.timeOfDay))return {due:false,carried,reason:'Outside working daylight; a food errand starts between 1000 and 10000'}
 if(s.underRock)return {due:false,carried,reason:'Under rock; the food errand waits for the surface'}
 const wait=s.last?.at?FOOD_RETRY_MS[s.last.outcome]??FOOD_RETRY_MS.nothing:0
 if(wait&&s.now-s.last.at<wait)return {due:false,carried,reason:`A food errand was tried ${Math.round((s.now-s.last.at)/1000)} s ago (${s.last.outcome})`}
 return {due:true,carried,reason:`Carrying ${carried} hunger points of food, under the floor of ${FOOD_FLOOR}`}
}
// One step at a time, re-observed after each. `done` lists the steps already taken
// in this errand: 'hunt', 'eat', 'smelt:<cooked item>'.
export function nextFoodStep(s,done=[]){
 const have=name=>s.inventory?.[name]||0
 const sinceHunt=done.slice(done.lastIndexOf('hunt')+1)
 if(s.canCook){
  const raw=Object.keys(COOKS).filter(r=>have(r)>0&&!sinceHunt.includes('smelt:'+COOKS[r])).sort((a,b)=>have(b)-have(a)||a.localeCompare(b))[0]
  if(raw)return {action:'smelt',goal:{item:COOKS[raw],count:Math.min(16,have(COOKS[raw])+have(raw))}}
 }
 // Hurt below the hunger that heals, or simply hungry: eat the best food carried.
 if(!done.includes('eat')&&(s.health<20&&s.food<18||s.food<=14)){
  const best=[...SAFE_FOODS].filter(f=>have(f)>0).sort((a,b)=>(s.points(b)||0)-(s.points(a)||0)||a.localeCompare(b))[0]
  if(best)return {action:'eat',goal:{item:best,count:Math.min(8,have(best))}}
 }
 if(!done.includes('hunt')&&foodPoints(s.inventory,s.points)<FOOD_FLOOR){
  // Nothing in sight here, and a hunting ground remembered from an earlier kill:
  // walk there first (pi2, 21:08Z: the search legs from the base found nothing
  // while every kill had been 40 to 60 blocks west).
  const g=s.huntingGround,p=s.position
  if(!done.includes('go')&&g&&p&&!(s.animalsInSight>0)&&Math.hypot(g.x-p.x,g.z-p.z)>HUNT_GROUND_REACH)return {action:'go',goal:{x:g.x,y:g.y,z:g.z}}
  const raw=MEATS.reduce((n,m)=>n+have(m),0)
  return {action:'hunt',goal:{item:'meat',count:Math.min(8,raw+FOOD_HUNT_COUNT)}}
 }
 return null
}
const inventoryOf=bot=>(bot?.inventory?.items?.()||[]).reduce((m,i)=>(m[i.name]=(m[i.name]||0)+i.count,m),{})
// A furnace the smelt action can reach or make, and something to burn in it.
export function canCook(bot,base,inventory){
 const fuel=['coal','charcoal'].some(f=>inventory[f]>0)||Object.keys(inventory).some(n=>/_(log|planks)$/.test(n)&&inventory[n]>0)
 const saved=base?.stations?.furnace?.position,p=bot?.entity?.position
 const furnace=inventory.furnace>0||(inventory.cobblestone||0)>=8||!!(saved&&p&&Math.hypot(saved.x-p.x,saved.y-p.y,saved.z-p.z)<=48)
 return fuel&&furnace
}
export function foodState(c,bot){
 const inventory=inventoryOf(bot),p=bot.entity?.position,here=dimensionOf(bot)
 const ground=c.places?.hunting_ground,animals=Object.keys(MEAT_DROPS)
 const animalsInSight=p?Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&animals.includes(e.name)&&e.position&&e.position.distanceTo(p)<=32).length:0
 return {inventory,position:p?{x:p.x,y:p.y,z:p.z}:null,animalsInSight,huntingGround:ground&&(ground.dimension||'overworld')===here?ground:null,food:bot.food,health:bot.health,timeOfDay:bot.time?.timeOfDay,dimension:dimensionOf(bot),underRock:!!bot.entity?.position&&(dimensionOf(bot)!=='overworld'||columnAbove(bot).solidCells>SURFACE_COVER),
  canCook:canCook(bot,c.projects?.base,inventory),points:name=>bot.registry?.foodsByName?.[name]?.foodPoints||0,now:Date.now(),last:c.requestProgress?.foodFloor||null}
}
const summary=(bot,s=foodState({},bot))=>({points:foodPoints(s.inventory,s.points),food:bot.food,health:bot.health,carried:Object.fromEntries(Object.entries(s.inventory).filter(([n])=>SAFE_FOODS.has(n)||COOKS[n]))})

// Decided synchronously: null when the floor is not due, else the errand's promise.
// Not due must not cost an await, or work queued behind it starts a tick late.
// Ordinary work only: a request with a task contract, and none where a person is
// waiting on the bot (come to me, hand me something): those go first.
const PERSON_WAITING=['at_owner','delivered']
export function keepFoodFloor(c,epoch,signal){
 const bot=c.runner?.bot,request=c.requestProgress
 if(!bot||!request||request.reviewRequired||typeof c.execute!=='function')return null
 if(request.goal?.kind!=='task'||(request.goal.criteria||[]).some(k=>PERSON_WAITING.includes(k.kind)))return null
 if(!foodFloorDue(foodState(c,bot)).due)return null
 return foodErrand(c,epoch,signal,bot,request)
}
async function foodErrand(c,epoch,signal,bot,request){
 const current=()=>!signal.aborted&&c.epoch===epoch&&c.requestProgress===request&&c.runner.ready&&c.runner.bot===bot
 const before=summary(bot),done=[],steps=[],feedback=request.feedback??=[]
 c.say(`Below my food floor: carrying ${before.points} hunger points of food, under ${FOOD_FLOOR}. Getting food before the next step.`)
 c.runner.log?.('food_floor',{phase:'started',...before})
 let interrupted=false,paused=false
 for(let i=0;i<6;i++){
  const step=nextFoodStep(foodState(c,bot),done);if(!step)break
  done.push(step.action==='smelt'?'smelt:'+step.goal.item:step.action)
  const goal=step.action==='smelt'?{...step.goal,project:c.projects?.base?structuredClone(c.projects.base):null}:step.goal
  const record={action:step.action,step:{action:step.action,item:step.goal.item,count:step.goal.count,...(step.action==='go'?{name:'hunting_ground'}:{})},automatic:true,foodFloor:true}
  // Walking to the hunting ground is the same walk as to any saved place.
  const here=bot.entity?.position,far=step.action==='go'&&here&&Math.hypot(goal.x-here.x,goal.z-here.z)>64
  const command=step.action==='go'?{action:far?'travel':'navigate',goal:{x:goal.x,y:goal.y,z:goal.z},timeoutMs:far?600000:120000}
   :{action:step.action,goal,timeoutMs:step.action==='eat'?30000:600000}
  try{
   await c.execute(command,signal)
   if(!current()){interrupted=true;break}
   const result=structuredClone(c.runner.task?.result??null)
   feedback.push({...record,status:'completed',result})
   steps.push({action:step.action,item:step.goal.item,count:step.goal.count,status:'completed',receipt:result?.receipt??null})
  }catch(error){
   if(!current()){interrupted=true;break}
   const review=interruptedEffect(c.runner.task)
   feedback.push({...record,status:'failed',reason:error.message,...(review?{reviewRequired:review}:{})})
   steps.push({action:step.action,item:step.goal.item,count:step.goal.count,status:'failed',reason:String(error.message).slice(0,200)})
   if(review){request.reviewRequired=review;request.blocker=review;break}
   // A hostile turning up is not an empty area: the hunt pauses and is tried sooner.
   if(/hunting paused/.test(error.message))paused=true
  }
  c.persist()
 }
 const after=summary(bot)
 const outcome=after.points>before.points||after.food>before.food?'gained':interrupted||paused?'interrupted':'nothing'
 request.foodFloor={at:Date.now(),outcome,before,after}
 c.runner.log?.('food_floor',{phase:'finished',outcome,before,after,steps})
 if(!current())return true
 c.persist()
 c.say(outcome==='gained'?`Food floor: now carrying ${after.points} hunger points of food; hunger ${after.food}, health ${Math.round(after.health)}.`
  :outcome==='interrupted'?`Food floor: the errand was cut short (${steps.map(s=>s.reason||`${s.action} ${s.status}`).join('; ')}). Carrying on with the request; I will try again in two minutes.`
  :`Food floor: the errand brought back no food (${steps.map(s=>s.reason||`${s.action} ${s.status}`).join('; ')||'nothing to try'}). Carrying on with the request; I will look again in ten minutes.`)
 return true
}
