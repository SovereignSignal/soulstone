import {setTimeout as delay} from 'node:timers/promises'
import {requireReachedGoal} from './navigation.js'

const routeFailure=e=>['NoPath','Timeout'].includes(e.name)||e.code==='NAVIGATION_INCOMPLETE'
const collision=(b,m)=>b?JSON.stringify([b.boundingBox,b.shapes,m.blocksToAvoid?.has(b.type),/^(water|lava)$/.test(b.name||'')?b.name:null]):null
const standing=bot=>bot.entity.onGround?bot.entity.position.floored().toString():null

const SIDES=[[1,0],[-1,0],[0,1],[0,-1]]
const clear=b=>!b||b.name==='air'||b.boundingBox==='empty'
const solid=b=>!!b&&b.boundingBox==='block'
// A bot wedged in a slot (its own refilled shaft, a one-block pit) reports
// no ground and the pathfinder refuses every route. Before waiting on terrain,
// step manually toward any open neighbour, flat or one block up.
export async function stepFree(bot,{check,progress}){
 if(!bot.blockAt||!bot.setControlState)return false
 const feet=bot.entity.position.floored(),start=feet.toString()
 const options=[]
 for(const [dx,dz] of SIDES){
  const c=feet.offset(dx,0,dz)
  if(clear(bot.blockAt(c))&&clear(bot.blockAt(c.offset(0,1,0)))&&solid(bot.blockAt(c.offset(0,-1,0))))options.push({c,jump:false})
  else if(solid(bot.blockAt(c))&&clear(bot.blockAt(c.offset(0,1,0)))&&clear(bot.blockAt(c.offset(0,2,0)))&&clear(bot.blockAt(feet.offset(0,2,0))))options.push({c:c.offset(0,1,0),jump:true})
 }
 for(const {c,jump} of options){
  check();progress(`Stepping free toward ${c.x},${c.y},${c.z}`)
  if(bot.lookAt)await bot.lookAt(c.offset(.5,bot.entity.eyeHeight||1.62,.5),true)
  for(let pulse=0;pulse<4;pulse++){
   bot.setControlState('forward',true);if(jump)bot.setControlState('jump',true)
   await delay(150);bot.setControlState('forward',false);bot.setControlState('jump',false);await delay(100);check()
   if(bot.entity.position.floored().toString()!==start)return true
  }
 }
 return false
}
// One unchanged-policy retry, only after fresh evidence that the local route
// may differ. No digging, larger drops, teleporting or resource-action replay.
export async function walkWithTerrainRecovery(bot,goal,{movements,check,stage,progress,onRecovery=()=>{},attemptMs=15000,waitMs=30000,allowRecovery=true}){
 let changed=false
 const start=bot.entity.position.clone(),initialStanding=standing(bot)
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
   if(await stepFree(bot,{check,progress})){
    record.status='retrying';record.attempts=2;record.trigger='stepped_free';onRecovery({...record});progress('Stepped free; checking the walking route again')
    try{await attempt();onRecovery({...record,status:'recovered',endedAt:Date.now()});return}
    catch(e){check();onRecovery({...record,status:'failed',reason:e.message,endedAt:Date.now()});throw e}
   }
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
