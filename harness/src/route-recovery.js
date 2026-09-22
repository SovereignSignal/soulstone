import {setTimeout as delay} from 'node:timers/promises'
import {requireReachedGoal} from './navigation.js'
import {climbOut,climbBlocks} from './burrow.js'

const routeFailure=e=>['NoPath','Timeout'].includes(e.name)||e.code==='NAVIGATION_INCOMPLETE'
const collision=(b,m)=>b?JSON.stringify([b.boundingBox,b.shapes,m.blocksToAvoid?.has(b.type),/^(water|lava)$/.test(b.name||'')?b.name:null]):null
const standing=bot=>bot.entity.onGround?bot.entity.position.floored().toString():null

const SIDES=[[1,0],[-1,0],[0,1],[0,-1]]
const LIQUID=new Set(['water','lava','bubble_column'])
const GRAVITY=new Set(['sand','red_sand','gravel','suspicious_sand','suspicious_gravel'])
const clear=b=>!b||b.name==='air'||(b.boundingBox==='empty'&&!LIQUID.has(b.name))
const solid=b=>!!b&&b.boundingBox==='block'
// A pit rim is terrain you could have walked off, which is a narrower question
// than "has a collision box". Leaves answer yes to solid() in the pinned
// registry, so a spruce standing beside the bot read as a ledge: it pillared up
// on its own dirt onto the canopy and stranded itself on a one-wide tower for
// 62% of a six-hour run. Gravity blocks are deliberately NOT excluded here:
// settled sand and gravel are ground this agent already walks and digs
// (quarry.js DIGGABLE, navigation.js SOFT_GROUND), and excluding them would
// break climb on every beach, desert and riverbank.
const rimGround=b=>solid(b)&&!/_leaves$/.test(b.name||'')
const standable=(bot,c)=>rimGround(bot.blockAt(c.offset(0,-1,0)))&&clear(bot.blockAt(c))&&clear(bot.blockAt(c.offset(0,1,0)))
// A cell with no walkable neighbour is a tower top, not a rim. Flat, one up and
// one down, matching what stepFree already accepts as somewhere to go.
const walkableNeighbour=(bot,c)=>SIDES.some(([dx,dz])=>[0,1,-1].some(dy=>standable(bot,c.offset(dx,dy,dz))))
// A single full block with open air above it (a burrow cap, a thin cave roof)
// is dug through on the way up; sand, gravel, liquid or a thicker roof is not.
const thinRoof=(bot,b,aboveCell)=>solid(b)&&!GRAVITY.has(b.name)&&clear(bot.blockAt(aboveCell))
// Short forward pulses toward a neighbouring cell; the pathfinder is off.
async function nudge(bot,cell,{check,jump=false,pulses=4}){
 const start=bot.entity.position.floored().toString()
 if(bot.lookAt)await bot.lookAt(cell.offset(.5,bot.entity.eyeHeight||1.62,.5),true)
 for(let pulse=0;pulse<pulses;pulse++){
  bot.setControlState('forward',true);if(jump)bot.setControlState('jump',true)
  await delay(150);bot.setControlState('forward',false);bot.setControlState('jump',false);await delay(100);check()
  if(bot.entity.position.floored().toString()!==start)return true
 }
 return false
}
// A bot wedged in a slot (its own refilled shaft, a one-block pit) reports
// no ground and the pathfinder refuses every route. Before waiting on terrain,
// step manually toward any open neighbour, flat or one block up.
export async function stepFree(bot,{check,progress}){
 if(!bot.blockAt||!bot.setControlState)return false
 const feet=bot.entity.position.floored()
 const options=[]
 for(const [dx,dz] of SIDES){
  const c=feet.offset(dx,0,dz)
  if(clear(bot.blockAt(c))&&clear(bot.blockAt(c.offset(0,1,0)))&&solid(bot.blockAt(c.offset(0,-1,0))))options.push({c,jump:false})
  else if(solid(bot.blockAt(c))&&clear(bot.blockAt(c.offset(0,1,0)))&&clear(bot.blockAt(c.offset(0,2,0)))&&clear(bot.blockAt(feet.offset(0,2,0))))options.push({c:c.offset(0,1,0),jump:true})
 }
 for(const {c,jump} of options){
  check();progress(`Stepping free toward ${c.x},${c.y},${c.z}`)
  if(await nudge(bot,c,{check,jump}))return true
 }
 return false
}
// A bot at the bottom of a pit (its own prospecting shaft, collapsed sand, a
// creeper crater) has open sky but no walkable exit, and the walking policy
// never towers or digs. Judge the pit by the open column above the bot and the
// first height with a solid ledge beside it. Roofed columns are never dug.
export const MAX_CLIMB=8
export function pitExit(bot,feet=bot.entity.position.floored()){
 // The block two above the feet is exactly the cap the bot puts over its own
 // burrow, and the roof of the hut it walls itself into. climbOut digs whatever
 // sits there on the way up, so refusing to judge an exit at all was stricter
 // than the climb being judged: a shelter four blocks down could be opened at
 // the side and still never climbed out of, and the walk home timed out in it.
 let roof=null
 const overhead=feet.offset(0,2,0)
 if(!clear(bot.blockAt(overhead))){
  if(!thinRoof(bot,bot.blockAt(overhead),overhead.offset(0,1,0)))return null
  roof=overhead
 }
 for(let h=2;h<=MAX_CLIMB;h++){
  const above=feet.offset(0,h+1,0)
  if(!clear(bot.blockAt(above))){
   if(roof||!thinRoof(bot,bot.blockAt(above),above.offset(0,1,0)))return null
   roof=above
  }
  for(const [dx,dz] of SIDES){
   const c=feet.offset(dx,h,dz)
   if(standable(bot,c)&&walkableNeighbour(bot,c))return {height:h,cell:c,roof}
  }
 }
 return null
}
export async function climbFree(bot,{check,stage,progress,climb=climbOut}){
 if(!bot.blockAt||!bot.setControlState||bot.entity.onGround===false)return false
 const feet=bot.entity.position.floored(),exit=pitExit(bot,feet)
 if(!exit)return false
 const blocks=climbBlocks(bot)
 if(blocks<exit.height){progress(`In a pit ${exit.height} deep with ${blocks} carried blocks; too few to climb out`);return false}
 progress(`Climbing ${exit.height} blocks out of a pit toward ${exit.cell.x},${exit.cell.y},${exit.cell.z}${exit.roof?`, digging through the ceiling at ${exit.roof.y}`:''}`)
 try{await climb(bot,{x:exit.cell.x,y:feet.y+exit.height,z:exit.cell.z},{check,stage,progress})}
 catch(error){check();progress(`Climb out of the pit failed: ${error.message}`);return false}
 stage('walking');await nudge(bot,exit.cell,{check})
 // Height gained was the whole receipt, so pillaring straight up reported
 // success while leaving the bot somewhere it could not walk off. Require
 // ground beside it, not a number.
 const at=bot.entity.position.floored()
 if(at.y<exit.cell.y||!walkableNeighbour(bot,at)){
  progress(`Climbed ${at.y-feet.y} blocks to ${at.x},${at.y},${at.z} with no walkable ground beside it; still stuck`)
  return false
 }
 return true
}
// Safety action: leave a pit before sprinting from a threat. Fails plainly
// when no exit is judged so the caller can choose the next step.
export async function climbSkill(bot,task,{check,stage,progress}){
 check();const start=bot.entity.position.clone()
 if(!await climbFree(bot,{check,stage,progress}))throw new Error('No pit exit judged from here')
 const p=bot.entity.position
 return {item:'safety',count:1,receipt:'climbed',rise:Math.round(p.y-start.y),position:{x:p.x,y:p.y,z:p.z}}
}
const SELF_HELP=[[stepFree,'stepped_free'],[climbFree,'climbed_free']]
// Self-help retries under the unchanged policy, then one retry only after
// fresh evidence that the local route may differ. No larger drops, teleporting
// or resource-action replay; the only blocks placed are the bot's own climb.
export async function walkWithTerrainRecovery(bot,goal,{movements,check,stage,progress,onRecovery=()=>{},attemptMs=15000,waitMs=30000,allowRecovery=true,climb=climbOut}){
 let changed=false
 const start=bot.entity.position.clone();let initialStanding=standing(bot)
 const updated=(before,after)=>{
  const p=after?.position||before?.position
  if(p&&(p.distanceTo(start)<=6||p.distanceTo(bot.entity.position)<=6)&&collision(before,movements)!==collision(after,movements))changed=true
 }
 bot.on('blockUpdate',updated)
 async function attempt(){
  check();stage('walking');bot.pathfinder.setMovements(movements)
  let expired=false
  const timer=setTimeout(()=>{expired=true;bot.pathfinder.setGoal(null)},attemptMs)
  try{await bot.pathfinder.goto(goal);check();if(expired)throw Object.assign(new Error('Walking attempt timed out'),{name:'Timeout'});requireReachedGoal(bot,goal)}
  catch(e){check();if(expired)throw Object.assign(new Error('Walking attempt timed out'),{name:'Timeout'});throw e}
  finally{clearTimeout(timer)}
 }
 try{
  try{await attempt();return}catch(error){
   check();if(!allowRecovery||!routeFailure(error))throw error
   bot.pathfinder.setGoal(null);bot.clearControlStates()
   const record={status:'waiting',reason:error.message,startedAt:Date.now(),attempts:1}
   let last=error
   for(const [free,trigger] of SELF_HELP){
    if(!await free(bot,{check,stage,progress,climb}))continue
    bot.pathfinder.setGoal(null);bot.clearControlStates()
    record.status='retrying';record.attempts++;record.trigger=trigger;onRecovery({...record})
    progress(`${trigger==='stepped_free'?'Stepped free':'Climbed out'}; checking the walking route again`)
    try{await attempt();onRecovery({...record,status:'recovered',endedAt:Date.now()});return}
    catch(e){check();onRecovery({...record,status:'failed',reason:e.message,endedAt:Date.now()});if(!routeFailure(e))throw e;last=e}
   }
   if(record.trigger)throw last
   // The self-help ladder above can move the bot without setting a trigger (a
   // climb that gained height and then refused). The watch below tests whether
   // our standing position changed, which is now trivially true because WE
   // moved it, so it exits immediately and retries the same blocked walk,
   // reporting our own footwork as the terrain changing.
   initialStanding=standing(bot)
   onRecovery({...record});stage('observing');progress('Route blocked; watching nearby terrain for up to 30 seconds before one retry')
   const deadline=Date.now()+waitMs
   while(!changed&&!(standing(bot)&&standing(bot)!==initialStanding)&&Date.now()<deadline){check();await delay(Math.min(100,Math.max(1,deadline-Date.now())))}
   check()
   if(!changed&&!(standing(bot)&&standing(bot)!==initialStanding)){
    onRecovery({...record,status:'unchanged',endedAt:Date.now()});throw error
   }
   record.status='retrying';record.attempts=2;record.trigger=changed?'nearby_collision_changed':'standing_position_changed';onRecovery({...record})
   progress('Terrain changed; checking the walking route again')
   try{await attempt();onRecovery({...record,status:'recovered',endedAt:Date.now()})}
   catch(e){check();onRecovery({...record,status:'failed',reason:e.message,endedAt:Date.now()});throw e}
  }
 }finally{bot.removeListener('blockUpdate',updated)}
}
