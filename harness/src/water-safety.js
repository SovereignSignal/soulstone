import {setTimeout as delay} from 'node:timers/promises'
import pathfinding from 'mineflayer-pathfinder'
import {survivalObservation} from './survival.js'
import {DoorAwareMovements,requireReachedGoal} from './navigation.js'
import {fullCube} from './construction.js'
import {Vec3} from 'vec3'
const {goals}=pathfinding

export function dryShoreGoals(bot,radius=12){
 const center=bot.entity.position.floored(),found=[]
 for(let dx=-radius;dx<=radius;dx++)for(let dz=-radius;dz<=radius;dz++){
  if(Math.hypot(dx,dz)>radius)continue
  for(let dy=-1;dy<=3;dy++){
   const p=center.offset(dx,dy,dz)
   if(!fullCube(bot.registry,bot.blockAt(p.offset(0,-1,0))?.name)||[0,1].some(y=>bot.blockAt(p.offset(0,y,0))?.name!=='air'))continue
   if(Object.values(bot.players||{}).some(v=>v.entity&&v.entity!==bot.entity&&v.entity.position.distanceTo(p.offset(.5,0,.5))<1.5))continue
   found.push(p);break
  }
 }
 return found.sort((a,b)=>a.distanceTo(center)-b.distanceTo(center)).slice(0,12).map(p=>new goals.GoalBlock(p.x,p.y,p.z))
}

// Air recovery never waits for a model or depends on a lit shelter. Reaching
// dry ground and merely keeping the head above water have different receipts.
export async function surfaceForAir(bot,task,{check,stage,progress,movements},{surfaceMs=12000,shoreMs=8000,climbMs=2500,pollMs=50}={}){
 let hold=false
 const observe=()=>survivalObservation(bot)
 const breathe=async()=>{
  const end=Date.now()+surfaceMs;let clear=0
  bot.pathfinder.setGoal(null);bot.clearControlStates();bot.setControlState('jump',true)
  while(Date.now()<end){
   check();const s=observe()
   if(s.health<=0)throw new Error('Died before reaching air')
   clear=s.headSubmerged===false&&(s.oxygen===null||s.oxygen>=18||s.inWater===false)?clear+1:0
   if(clear>=4)return
   await delay(pollMs)
  }
  throw new Error('Could not reach breathable air within the surfacing limit')
 }
 try{
  check();stage('surfacing');progress('Swimming up for air')
  await breathe();check()
  const targets=dryShoreGoals(bot)
  if(targets.length){
   const movement=new DoorAwareMovements(bot,{surfaceWaterOnly:true})
   Object.assign(movement,{canDig:false,allow1by1towers:false,allowParkour:false,allowSprinting:false,scafoldingBlocks:[],maxDropDown:1})
   const goal=new goals.GoalCompositeAny(targets)
   bot.pathfinder.setMovements(movement);stage('swimming');progress('Air restored; moving toward nearby dry ground')
   const timer=setTimeout(()=>bot.pathfinder.setGoal(null),shoreMs)
   try{await bot.pathfinder.goto(goal);check();requireReachedGoal(bot,goal)}catch(e){check()}finally{clearTimeout(timer)}
   check()
   if(goal.isEnd(bot.entity.position.floored())&&bot.entity.onGround&&observe().headSubmerged===false){
    return {item:'safety',count:1,receipt:'dry_ground_reached',position:bot.entity.position.clone(),oxygen:bot.oxygenLevel??null}
   }
   // The path search has no jump-up move out of water, so a ledge one block above
   // the surface is out of its reach: trial 24 trod water beside dry rock for most
   // of an hour. A player faces the ledge and holds forward and jump.
   for(const g of targets.slice(0,3)){
    check();progress(`Climbing out toward ${g.x},${g.y},${g.z}`)
    await bot.lookAt?.(new Vec3(g.x+.5,g.y+.5,g.z+.5),true)
    bot.setControlState('forward',true);bot.setControlState('jump',true)
    const end=Date.now()+climbMs
    while(Date.now()<end&&!(bot.entity.onGround&&!bot.entity.isInWater)){check();await delay(pollMs)}
    bot.clearControlStates()
    if(bot.entity.onGround&&!bot.entity.isInWater&&observe().headSubmerged===false)
     return {item:'safety',count:1,receipt:'dry_ground_reached',climbed:true,position:bot.entity.position.clone(),oxygen:bot.oxygenLevel??null}
   }
  }
  // If shore cannot be reached, keep swimming at the surface. Runner.halt()
  // owns release on Stop, death, disconnect or the next movement action.
  await breathe();check()
  if(bot.entity.onGround&&!bot.entity.isInWater)return {item:'safety',count:1,receipt:'dry_ground_reached',position:bot.entity.position.clone(),oxygen:bot.oxygenLevel??null}
  hold=true
  return {item:'safety',count:0,receipt:'breathing_at_surface',dryGround:false,position:bot.entity.position.clone(),oxygen:bot.oxygenLevel??null}
 }finally{
  bot.pathfinder.setGoal(null);if(movements)bot.pathfinder.setMovements(movements)
  bot.clearControlStates();if(hold)bot.setControlState('jump',true)
 }
}
