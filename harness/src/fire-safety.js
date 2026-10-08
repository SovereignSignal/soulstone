import {setTimeout as delay} from 'node:timers/promises'
import pathfinding from 'mineflayer-pathfinder'
import {fireObservation} from './survival.js'
import {DoorAwareMovements} from './navigation.js'
import {fullCube} from './construction.js'
import {inNether} from './dimension.js'
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
export const standable=(bot,p)=>fullCube(bot.registry,bot.blockAt(p.offset(0,-1,0))?.name)&&[0,1].every(y=>AIR.has(bot.blockAt(p.offset(0,y,0))?.name))

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

// Fire recovery never waits for a model or a shelter. In order: pour water at the
// feet (into the lava itself when standing in it), climb out of lava with the
// bot's own controls, step into water in sight, then get clear of lava and let
// the fire burn out. Only an observed end of burning is a success.
export async function douseFire(bot,task,{check,stage,progress,movements},{limitMs=15000,pollMs=50,walkMs=6000,climbMs=2500}={}){
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
 const isSourceAt=p=>{const b=bot.blockAt(p);return b?.name==='water'&&String(b.getProperties?.()?.level??'')==='0'}
 // Pour straight down. The look passes through liquid to the first solid face,
 // and the game replaces the cell above it, so standing in lava the water takes
 // the lava's place. Anything with an outline in the feet cell (fire, grass, a
 // snow layer) catches the look instead and the water lands one cell up, at head
 // height: the lab bot drowned that way while the receipt said extinguished. So
 // clear that first (fire goes out to a punch), and take the water back from
 // wherever it landed.
 const pourHere=async()=>{
  const bucket=carried(bot,'water_bucket')
  // Water evaporates in the Nether: the bucket would be spent for nothing.
  if(!bucket||inNether(bot))return false
  if(!fireObservation(bot).inLava&&!await until(()=>bot.entity.onGround,500,pollMs,check))return false
  const feet=bot.entity.position.floored(),head=feet.offset(0,1,0)
  const outlined=b=>!!b&&!AIR.has(b.name)&&b.boundingBox==='empty'&&!['water','lava'].includes(b.name)
  if(outlined(bot.blockAt(feet))){try{await bot.dig(bot.blockAt(feet));check()}catch{check()}}
  const cell=bot.blockAt(feet),floor=bot.blockAt(feet.offset(0,-1,0))
  if(floor?.boundingBox!=='block'||!(cell?.name==='lava'||cell?.boundingBox==='empty'&&cell.name!=='water'))return false
  progress(cell.name==='lava'?'Pouring water into the lava I am standing in':'Pouring water at my feet')
  await useLookingDown(bot,bucket);check()
  const out=await until(()=>!burning(bot),1000,pollMs,check)
  // The next fire needs the water, and a source at head height drowns the bot.
  // The fire flag arrives before the water block and the emptied bucket do.
  const landed=()=>[head,feet].find(isSourceAt)
  if(await until(()=>!!carried(bot,'bucket')&&!!landed(),1500,pollMs,check)){
   await useLookingDown(bot,carried(bot,'bucket'));check()
   if(!await until(()=>!!carried(bot,'water_bucket'),1000,pollMs,check))progress(`The water at ${landed()?.y===head.y?'head height':'my feet'} did not come back into the bucket`)
  }else progress(`Leaving the water where it is: ${carried(bot,'bucket')?'':'no empty bucket in the inventory; '}${landed()?'':'no water source at my feet or head'}`)
  return out
 }
 // Asked to walk out of lava, the pathfinder did not move the lab bot in 2.5 s
 // and it died there. Face the nearest dry standing cell and hold forward and jump.
 const climbOut=async()=>{
  const center=bot.entity.position.floored(),dry=[]
  for(let dx=-2;dx<=2;dx++)for(let dz=-2;dz<=2;dz++)for(const dy of [0,1]){const p=center.offset(dx,dy,dz);if((dx||dz)&&standable(bot,p))dry.push(p)}
  const target=dry.sort((a,b)=>a.distanceTo(center)-b.distanceTo(center))[0]
  if(!target)return false
  progress(`Climbing out of the lava toward ${target.x},${target.y},${target.z}`)
  await bot.lookAt(target.offset(.5,.5,.5),true)
  bot.setControlState('forward',true);bot.setControlState('jump',true)
  try{return await until(()=>!fireObservation(bot).inLava,climbMs,pollMs,check)}finally{bot.clearControlStates()}
 }
 let method=null
 try{
  check()
  // The alarm and the skill are a tick or two apart, and a fire can go out between them.
  if(!burning(bot)){const p=bot.entity.position.floored();return {item:'safety',count:0,receipt:'not_burning',position:at(p),health:bot.health,clearOfLava:!lavaWithin(bot,p,1),waterBucket:!!carried(bot,'water_bucket')}}
  stage('dousing');progress('I am on fire. Putting it out')
  bot.pathfinder.setGoal(null);bot.clearControlStates()
  // 1. Water at the feet, or into the lava being stood in.
  if(await pourHere())method='poured_water'
  // 2. Still in lava: climb out, and walk only if the climb did not make it.
  if(fireObservation(bot).inLava&&!await climbOut()){progress('Getting out of the lava');await walkTo(clearOfLavaGoals(bot))}
  // 3. Out of the lava and still burning: the bucket now has ground to aim at.
  if(!method&&burning(bot)&&!fireObservation(bot).inLava&&await pourHere())method='poured_water'
  // 4. Water in sight.
  if(!method&&burning(bot)){
   const water=waterGoals(bot)
   if(water.length){progress('Stepping into water');await walkTo(water,{water:true});if(await until(()=>!burning(bot),1000,pollMs,check))method='stepped_in_water'}
  }
  // 5. Out of reach of the lava that lit it, so it cannot catch again.
  if(lavaWithin(bot,bot.entity.position.floored(),1)){progress('Moving clear of the lava');await walkTo(clearOfLavaGoals(bot))}
  // 6. Wait the rest out, bounded.
  if(!(await until(()=>!burning(bot)||bot.health<=0,limitMs,pollMs,check)))
   throw new Error(`Still burning after ${Math.round(limitMs/1000)} s with no water to put it out`)
  if(bot.health<=0)throw new Error('Died while burning')
  const p=bot.entity.position.floored()
  return {item:'safety',count:1,receipt:'extinguished',method:method||'burned_out',position:at(p),health:bot.health,clearOfLava:!lavaWithin(bot,p,1),waterBucket:!!carried(bot,'water_bucket')}
 }finally{
  bot.pathfinder.setGoal(null);if(movements)bot.pathfinder.setMovements(movements)
  bot.clearControlStates()
 }
}
