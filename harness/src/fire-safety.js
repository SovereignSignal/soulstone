import {setTimeout as delay} from 'node:timers/promises'
import pathfinding from 'mineflayer-pathfinder'
import {fireObservation} from './survival.js'
import {DoorAwareMovements} from './navigation.js'
import {fullCube} from './construction.js'
const {goals}=pathfinding
const AIR=new Set(['air','cave_air','void_air'])

const carried=(bot,name)=>bot.inventory.items().find(i=>i.name===name)
const burning=bot=>{const f=fireObservation(bot);return f.onFire===true||f.inLava===true||f.inFire===true}
const at=p=>({x:p.x,y:p.y,z:p.z})

// Any lava in the column band a player's body and floor touch, within `margin`
// cells sideways. Flowing lava is still `lava`, and it still sets you alight.
export function lavaWithin(bot,p,margin=1){
 for(let dx=-margin;dx<=margin;dx++)for(let dz=-margin;dz<=margin;dz++)for(let dy=-1;dy<=2;dy++)
  if(bot.blockAt(p.offset(dx,dy,dz))?.name==='lava')return true
 return false
}
const standable=(bot,p)=>fullCube(bot.registry,bot.blockAt(p.offset(0,-1,0))?.name)&&[0,1].every(y=>AIR.has(bot.blockAt(p.offset(0,y,0))?.name))

// Nearest standing cells with no lava within the margin, relaxing the margin
// only when a wide one leaves nowhere to go: inside a lake, any dry cell beats none.
export function clearOfLavaGoals(bot,radius=6){
 const center=bot.entity.position.floored()
 for(const margin of [2,1,0]){
  const found=[]
  for(let dx=-radius;dx<=radius;dx++)for(let dz=-radius;dz<=radius;dz++){
   if(Math.hypot(dx,dz)>radius)continue
   for(let dy=-2;dy<=2;dy++){const p=center.offset(dx,dy,dz);if(standable(bot,p)&&!lavaWithin(bot,p,margin)){found.push(p);break}}
  }
  if(found.length)return found.sort((a,b)=>a.distanceTo(center)-b.distanceTo(center)).slice(0,12).map(p=>new goals.GoalBlock(p.x,p.y,p.z))
 }
 return []
}
function waterGoals(bot,radius=6){
 const id=bot.registry.blocksByName.water.id,center=bot.entity.position
 return (bot.findBlocks?.({matching:id,maxDistance:radius,count:16})||[])
  .filter(p=>['air','water','cave_air'].includes(bot.blockAt(p.offset(0,1,0))?.name))
  .sort((a,b)=>a.distanceTo(center)-b.distanceTo(center)).slice(0,8).map(p=>new goals.GoalBlock(p.x,p.y,p.z))
}

// A bucket writes use_item, which the server raycasts along the look vector.
// Straight down from a standing player the ray meets the floor's top face and
// the water lands in the feet cell. Settle the look first, as `use` does.
async function useLookingDown(bot,item){
 await bot.equip(item,'hand')
 await bot.look(bot.entity.yaw,-Math.PI/2,true);await bot.waitForTicks(1)
 try{bot.activateItem()}finally{bot.deactivateItem()}
}
async function until(predicate,ms,pollMs,check){
 const end=Date.now()+ms
 while(Date.now()<end){check();if(predicate())return true;await delay(pollMs)}
 return predicate()
}

// Fire recovery never waits for a model or a shelter. In order: leave lava,
// pour water at the feet, step into water in sight, then get clear of lava and
// let the fire burn out. Only an observed end of burning is a success.
export async function douseFire(bot,task,{check,stage,progress,movements},{limitMs=15000,pollMs=50,walkMs=6000}={}){
 const walkTo=async(targets,{water=false}={})=>{
  if(!targets.length)return false
  // Never dig on the way out: breaking a block beside lava is how it gets let out.
  const movement=new DoorAwareMovements(bot,{surfaceWaterOnly:water})
  Object.assign(movement,{canDig:false,allow1by1towers:false,allowParkour:false,scafoldingBlocks:[],maxDropDown:2})
  const goal=new goals.GoalCompositeAny(targets)
  bot.pathfinder.setMovements(movement)
  const timer=setTimeout(()=>bot.pathfinder.setGoal(null),walkMs)
  try{await bot.pathfinder.goto(goal)}catch{}finally{clearTimeout(timer)}
  check()
  return goal.isEnd(bot.entity.position.floored())
 }
 let method=null,waterBucket=null
 try{
  check();stage('dousing');progress('I am on fire. Putting it out')
  bot.pathfinder.setGoal(null);bot.clearControlStates()
  // 1. Water poured while standing in lava does not stop the burning.
  if(fireObservation(bot).inLava){progress('Getting out of the lava');await walkTo(clearOfLavaGoals(bot))}
  // 2. Pour at the feet. Needs ground to aim at and a feet cell water can take.
  const bucket=carried(bot,'water_bucket')
  if(burning(bot)&&bucket&&!fireObservation(bot).inLava&&await until(()=>bot.entity.onGround,500,pollMs,check)){
   const feet=bot.entity.position.floored(),cell=bot.blockAt(feet),floor=bot.blockAt(feet.offset(0,-1,0))
   if(cell?.boundingBox==='empty'&&!['water','lava'].includes(cell.name)&&floor?.boundingBox==='block'){
    progress('Pouring water at my feet')
    await useLookingDown(bot,bucket);check()
    if(await until(()=>!burning(bot),1000,pollMs,check)){
     method='poured_water'
     // Take the water back: the next fire needs it, and a stray source floods the work.
     const empty=carried(bot,'bucket'),here=bot.blockAt(feet)
     if(empty&&here?.name==='water'&&String(here.getProperties?.()?.level??'')==='0'){
      await useLookingDown(bot,empty);check()
      await until(()=>!!carried(bot,'water_bucket'),1000,pollMs,check)
     }
    }
   }
  }
  // 3. Water in sight.
  if(!method&&burning(bot)){
   const water=waterGoals(bot)
   if(water.length){progress('Stepping into water');await walkTo(water,{water:true});if(!burning(bot))method='stepped_in_water'}
  }
  // 4. Out of reach of the lava that lit it, so it cannot catch again.
  if(lavaWithin(bot,bot.entity.position.floored(),1)){progress('Moving clear of the lava');await walkTo(clearOfLavaGoals(bot))}
  // 5. Wait the rest out, bounded.
  if(!(await until(()=>!burning(bot)||bot.health<=0,limitMs,pollMs,check)))
   throw new Error(`Still burning after ${Math.round(limitMs/1000)} s with no water to put it out`)
  if(bot.health<=0)throw new Error('Died while burning')
  waterBucket=!!carried(bot,'water_bucket')
  const p=bot.entity.position.floored()
  return {item:'safety',count:1,receipt:'extinguished',method:method||'burned_out',position:at(p),health:bot.health,clearOfLava:!lavaWithin(bot,p,1),waterBucket}
 }finally{
  bot.pathfinder.setGoal(null);if(movements)bot.pathfinder.setMovements(movements)
  bot.clearControlStates()
 }
}
