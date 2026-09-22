// Reach observed natural ground from a canopy using the normal checked
// three-block drop policy. Never mine the supporting leaf or guess a landing.
import {setTimeout as delay} from 'node:timers/promises'
import pathfinding from 'mineflayer-pathfinder'
import {DoorAwareMovements,allowGroundBreaking,requireReachedGoal,SOFT_GROUND} from './navigation.js'
const {goals}=pathfinding
const ground=new Set([...SOFT_GROUND,'stone','andesite','diorite','granite'].filter(n=>!['sand','red_sand','gravel','mud'].includes(n)))
const full=b=>b?.shapes?.some(s=>s.length===6&&s.every((v,i)=>v===[0,0,0,1,1,1][i]))
const open=b=>b&&['air','cave_air','short_grass','tall_grass','fern','large_fern'].includes(b.name)&&b.boundingBox==='empty'
// One more than the walking policy's maxDropDown: a shorter drop is travel's
// job. This names the mechanism (a descent the walking graph cannot pay for)
// rather than the situation (standing in a tree), which is why the old leaves
// test was wrong: the bot that needed this was on its own dirt pillar.
export const MIN_DROP=4
export function canopyLandings(bot){
 const feet=bot.entity.position.floored()
 return bot.findBlocks({matching:b=>ground.has(b.name)&&full(b),useExtraInfo:b=>b.position.y<feet.y-MIN_DROP&&open(bot.blockAt(b.position.offset(0,1,0)))&&open(bot.blockAt(b.position.offset(0,2,0))),maxDistance:32,count:16})
  .map(p=>p.offset(0,1,0)).filter(p=>open(bot.blockAt(p))&&open(bot.blockAt(p.offset(0,1,0))))
  .sort((a,b)=>a.distanceTo(feet)-b.distanceTo(feet)).slice(0,16)
}
export async function descendFromCanopy(bot,task,{check,stage,progress,movements}){
 check()
 if(!bot.entity.onGround)throw new Error('Canopy descent needs stable footing')
 const landings=canopyLandings(bot),start=bot.entity.position.clone()
 const footing=bot.blockAt(start.floored().offset(0,-1,0))?.name
 if(!landings.length)throw new Error(`No observed safe ground at least ${MIN_DROP} blocks below ${Math.floor(start.y)} within 32 blocks; standing on ${footing||'unloaded terrain'}`)
 const goal=new goals.GoalCompositeAny(landings.map(p=>new goals.GoalBlock(p.x,p.y,p.z)))
 const movement=allowGroundBreaking(bot,new DoorAwareMovements(bot))
 Object.assign(movement,{allow1by1towers:false,allowParkour:false,allowSprinting:false,scafoldingBlocks:[],maxDropDown:3})
 if(movements?.blocksToAvoid)for(const id of movements.blocksToAvoid)movement.blocksToAvoid.add(id)
 stage('walking');progress('Looking for a route down from the leaves to observed solid ground')
 bot.pathfinder.setMovements(movement)
 let expired=false
 const timer=setTimeout(()=>{expired=true;bot.pathfinder.setGoal(null)},20000)
 try{
  // The deadline cancels the goal, so goto() REJECTS with GoalChanged rather
  // than returning: an `expired` check after the await is unreachable. Convert
  // it here, and name it Timeout so navigationFailure treats a stalled route as
  // retryable instead of terminal.
  try{await bot.pathfinder.goto(goal)}
  catch(error){
   if(expired)throw Object.assign(new Error('Canopy descent timed out looking for a route down'),{name:'Timeout'})
   throw error
  }
  check()
  // A drop is still in flight when goto resolves. requireReachedGoal reads
  // position.floored() against exact-cell goals, so a mid-fall sample floors one
  // cell high and throws NAVIGATION_INCOMPLETE a line before the real symptom.
  for(let i=0;i<30&&!bot.entity.onGround;i++){check();await delay(50)}
  requireReachedGoal(bot,goal)
  const p=bot.entity.position,floor=bot.blockAt(p.floored().offset(0,-1,0))
  if(!bot.entity.onGround||!ground.has(floor?.name)||!full(floor)||p.y>=start.y)throw new Error('Canopy descent did not reach stable lower ground')
  return {item:'safety',count:1,receipt:'descended_to_ground',drop:Math.round(start.y-p.y),position:{x:p.x,y:p.y,z:p.z}}
 }finally{clearTimeout(timer);bot.pathfinder.setGoal(null);bot.clearControlStates();if(movements)bot.pathfinder.setMovements(movements)}
}
