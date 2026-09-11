import {setTimeout as delay} from 'node:timers/promises'
import {requireReachedGoal} from './navigation.js'

const routeFailure=e=>['NoPath','Timeout'].includes(e.name)||e.code==='NAVIGATION_INCOMPLETE'
const collision=(b,m)=>b?JSON.stringify([b.boundingBox,b.shapes,m.blocksToAvoid?.has(b.type),/^(water|lava)$/.test(b.name||'')?b.name:null]):null
const standing=bot=>bot.entity.onGround?bot.entity.position.floored().toString():null

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
