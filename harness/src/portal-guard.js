import {setTimeout as delay} from 'node:timers/promises'
import {portalObservation} from './survival.js'
import {standable} from './fire-safety.js'
import pathfinding from 'mineflayer-pathfinder'
import {dimensionOf} from './dimension.js'
import {wearBestArmor} from './armor.js'
import {unwall} from './hut.js'
const {goals}=pathfinding

// Sov's limit: never step through a portal or enter the Nether. A survival
// player standing in a nether portal is carried through after four seconds,
// so this never waits for a model or a path search: it faces the nearest
// standing cell outside the portal and walks.
export async function leavePortal(bot,task,{check,stage,progress},{pollMs=50,stepMs=2000}={}){
 const inside=()=>portalObservation(bot).inPortal===true
 const here=()=>{const p=bot.entity.position.floored();return {x:p.x,y:p.y,z:p.z}}
 check()
 if(!inside())return {item:'safety',count:0,receipt:'not_in_portal',position:here()}
 stage('leaving_portal');progress('I am standing in a portal. Stepping out before it carries me to the Nether')
 const center=bot.entity.position.floored(),out=[]
 for(let dx=-2;dx<=2;dx++)for(let dz=-2;dz<=2;dz++)for(const dy of [0,-1,1]){
  const p=center.offset(dx,dy,dz)
  if((dx||dz)&&standable(bot,p)&&![0,1].some(y=>/portal/.test(bot.blockAt(p.offset(0,y,0))?.name||'')))out.push(p)
 }
 out.sort((a,b)=>a.distanceTo(center)-b.distanceTo(center))
 try{
  for(const target of out.slice(0,3)){
   check()
   await bot.lookAt(target.offset(.5,.5,.5),true)
   bot.setControlState('forward',true);if(target.y>center.y)bot.setControlState('jump',true)
   const end=Date.now()+stepMs
   while(inside()&&Date.now()<end){check();await delay(pollMs)}
   bot.clearControlStates()
   if(!inside())return {item:'safety',count:1,receipt:'out_of_portal',position:here()}
  }
 }finally{bot.clearControlStates()}
 throw new Error(`Still in the portal after ${Math.min(3,out.length)} step${out.length===1?'':'s'} toward open ground`)
}

// The one deliberate way through a portal (workstreams/minecraft/nether-plan.md,
// step 5). From the Overworld only where the world's switch allows the Nether;
// from the Nether always, so turning the switch off never strands the bot.
// Every walk avoids portal blocks, so the last step in is by direct control;
// then it stands still until the dimension changes, and steps out of the
// arrival portal with the same guard that steps it out of any other.
export async function usePortal(bot,task,{check,stage,progress,netherAllowed=false},{reachMs=20000,enterMs=3000,crossMs=15000,loadMs=10000,pollMs=50}={}){
 const xyz=p=>({x:p.x,y:p.y,z:p.z}),key=p=>`${p.x},${p.y},${p.z}`
 const until=async(predicate,ms)=>{const end=Date.now()+ms;while(Date.now()<end){check();if(predicate())return true;await delay(pollMs)}return predicate()}
 const inside=()=>portalObservation(bot).inPortal===true
 check()
 const from=dimensionOf(bot)
 if(from==='overworld'&&!netherAllowed)throw new Error('Portal travel to the Nether is off for this world; only the owner can turn it on')
 if(!['overworld','the_nether'].includes(from))throw new Error(`No portal travel from ${from||'an unknown dimension'}`)
 const block=bot.findBlock({matching:bot.registry.blocksByName.nether_portal.id,maxDistance:48})
 if(!block)throw new Error('No lit nether portal within 48 blocks')
 // The bottom portal cell, and the standing cells beside it at that level.
 let portal=block.position.clone?.()??block.position
 while(bot.blockAt(portal.offset(0,-1,0))?.name==='nether_portal')portal=portal.offset(0,-1,0)
 if(!inside()){
  // Run 69: a walk that timed out short of the portal, then a blind step from
  // there, put the bot in a water hole and it drowned. The blind step is taken
  // only from a standing cell beside the portal.
  const here=bot.entity.position
  // Level with the bottom cell, or one lower for a frame built on the ground, jumped in from.
  const stands=[0,-1].flatMap(dy=>[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dz])=>portal.offset(dx,dy,dz))).filter(p=>standable(bot,p)).sort((a,b)=>(b.y-a.y)||a.distanceTo(here)-b.distanceTo(here))
  if(!stands.length)throw new Error(`No standing cell beside the portal at ${key(portal)}; it is walled or flooded`)
  const beside=()=>stands.some(p=>{const f=bot.entity.position;return Math.floor(f.x)===p.x&&Math.floor(f.y)===p.y&&Math.floor(f.z)===p.z})
  // Walled in for safety (run 73), open the wall facing the portal first: the
  // walk never digs blocks the bot placed itself.
  // A side is a way out when its feet and head cells are both open (run 74: a
  // half-opened wall left none, and the pathfinder's empty path read as done).
  const passable=b=>!b||b.boundingBox==='empty'
  const feet=bot.entity.position.floored(),walled=[[1,0],[-1,0],[0,1],[0,-1]].every(([dx,dz])=>[0,1].some(y=>!passable(bot.blockAt(feet.offset(dx,y,dz)))))
  if(!beside()&&walled){progress('Opening the wall toward the portal');await unwall(bot,{kind:'unhut',goal:{toward:{x:portal.x,z:portal.z}}},{check,stage,progress})}
  if(!beside()){
   stage('walking');progress(`Walking to the portal at ${key(portal)}`)
   const timer=setTimeout(()=>bot.pathfinder.setGoal(null),reachMs)
   try{await bot.pathfinder.goto(new goals.GoalBlock(stands[0].x,stands[0].y,stands[0].z))}catch(error){check();progress(`The walk to the portal ended early: ${String(error.message).slice(0,60)}`)}
   finally{clearTimeout(timer)}
   check()
   if(!beside())throw new Error(`I did not reach a standing cell beside the portal at ${key(portal)}; not stepping toward it from ${key(bot.entity.position.floored())}`)
  }
  stage('entering');progress('Stepping into the portal')
  const below=Math.floor(bot.entity.position.y)<portal.y
  await bot.lookAt(portal.offset(.5,0,.5),true);bot.setControlState('forward',true);if(below)bot.setControlState('jump',true)
  try{if(!await until(inside,enterMs))throw new Error(`Could not step into the portal at ${key(portal)}`)}
  finally{bot.clearControlStates()}
 }
 // The portal's working shape is a thin plane in the middle of its cell; the
 // feet reaching the cell can leave the body short of it (run 73), and only
 // time in the middle counts toward crossing. The bot walks to the middle and
 // back to it whenever it is off it, for the whole wait (run 80).
 const middle=bot.entity.position.floored().offset(.5,0,.5)
 const centred=()=>{const p=bot.entity.position;return Math.abs(p.x-middle.x)<0.2&&Math.abs(p.z-middle.z)<0.2}
 let reached=false
 const hold=()=>{
  if(dimensionOf(bot)!==from)return true
  if(centred()){reached=true;bot.setControlState('forward',false)}
  else{bot.lookAt(middle.offset(0,.5,0),true)?.catch?.(()=>{});bot.setControlState('forward',true)}
  return false
 }
 progress('In the portal; waiting to cross')
 let crossed
 try{crossed=await until(hold,crossMs)}finally{bot.clearControlStates()}
 if(!crossed){
  await leavePortal(bot,task,{check,stage,progress})
  throw new Error(reached
   ?`The portal at ${key(portal)} did not carry me across in ${Math.round(crossMs/1000)} seconds; I stepped back out`
   :`I never reached the middle of the portal at ${key(portal)} in ${Math.round(crossMs/1000)} seconds, so it could not carry me; I stepped back out`)
 }
 const to=dimensionOf(bot)
 // The far side's ground arrives after the dimension does.
 await until(()=>!!bot.blockAt(bot.entity.position.floored().offset(0,-1,0)),loadMs)
 const arrival=bot.findBlock({matching:bot.registry.blocksByName.nether_portal.id,maxDistance:4})?.position
 const out=await leavePortal(bot,task,{check,stage,progress})
 // Gold boots on arrival in the Nether, iron back on in the Overworld, before anything nearby decides.
 await wearBestArmor(bot,{check,progress})
 return {item:'portal',count:1,receipt:'crossed',from:{dimension:from,portal:xyz(portal)},to:{dimension:to,portal:arrival?xyz(arrival):null,position:out.position}}
}
