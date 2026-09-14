// Wall-in hut: the emergency shelter when the ground cannot be dug. Eight wall
// blocks around the bot's own cell at feet and head level, one helper block and
// one roof block, all from carried full cubes. A closed hut breaks the line of
// sight a creeper needs and every melee reach. Exit by digging one side out.
import {setTimeout as delay} from 'node:timers/promises'
import {fullCube} from './construction.js'
import {centreOn} from './navigation.js'
export const HUT_BLOCKS=10
const GRAVITY=new Set(['sand','red_sand','gravel','suspicious_sand','suspicious_gravel'])
const REPLACEABLE=new Set(['air','cave_air','short_grass','tall_grass','fern','large_fern','dead_bush','pink_petals','snow','seagrass','vine'])
const SIDES=[[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]
const solid=(bot,b)=>!!b&&fullCube(bot.registry,b.name)
const key=p=>`${p.x},${p.y},${p.z}`
export function hutMaterials(bot){
 return bot.inventory.items().filter(i=>fullCube(bot.registry,i.name)&&!GRAVITY.has(i.name))
}
export function hutSite(bot){
 const p=bot.entity?.position
 if(!p||!bot.entity.onGround)return {ok:false,reason:'Not standing on solid ground'}
 const feet=p.floored()
 if(!solid(bot,bot.blockAt(feet.offset(0,-1,0))))return {ok:false,reason:'No solid floor under the bot'}
 for(const [dx,dy,dz] of SIDES){
  for(const level of [0,1]){const c=feet.offset(dx,level,dz),b=bot.blockAt(c);if(!b)return {ok:false,reason:`Cell ${key(c)} is not observed`};if(!REPLACEABLE.has(b.name)&&!solid(bot,b))return {ok:false,reason:`Cannot wall through ${b.name} at ${key(c)}`}}
  // A wall that already stands (a shaft, a cave nook) needs no ground under it.
  const ground=bot.blockAt(feet.offset(dx,-1,dz));if(!solid(bot,bot.blockAt(feet.offset(dx,0,dz)))&&!solid(bot,ground))return {ok:false,reason:`No ground to build the wall on at ${key(feet.offset(dx,-1,dz))}`}
 }
 const roof=bot.blockAt(feet.offset(0,2,0)),helper=bot.blockAt(feet.offset(1,2,0))
 if(!roof||!helper||!(REPLACEABLE.has(roof.name)||solid(bot,roof))||!(REPLACEABLE.has(helper.name)||solid(bot,helper)))return {ok:false,reason:'No room for the roof'}
 // Count what this site actually needs rather than a fixed ten. Terrain, a
 // shaft or a cave nook often supplies several walls, and the bot was refused
 // with nine blocks in hand on a night it could have sealed itself in.
 const wanted=[]
 for(const [dx,dy,dz] of SIDES)for(const level of [0,1])wanted.push(feet.offset(dx,level,dz))
 wanted.push(feet.offset(1,2,0),feet.offset(0,2,0))
 const needed=wanted.filter(c=>!solid(bot,bot.blockAt(c))).length
 const carried=hutMaterials(bot).reduce((n,i)=>n+i.count,0)
 if(carried<needed)return {ok:false,reason:`${needed} blocks needed to close this spot and ${carried} carried`}
 return {ok:true,feet,needed}
}
async function settle(predicate,{check,ms=1500,poll=50}){
 const end=Date.now()+ms
 while(Date.now()<end){check();if(predicate())return true;await delay(poll)}
 return predicate()
}
export async function wallIn(bot,task,{check,stage,progress}){
 check();const site=hutSite(bot)
 if(!site.ok)throw new Error('Cannot wall in here: '+site.reason)
 bot.pathfinder?.setGoal(null);bot.clearControlStates?.()
 // A player is 0.6 blocks wide. Standing a hand's breadth off centre puts the
 // hitbox inside the next cell, and the server refuses to place a block inside
 // a player: the same two walls fail to close, in the same two cells, every
 // night, while the bot reports carrying enough to finish. Centre, then build.
 const centred=await centreOn(bot,site.feet,check)
 stage('walling');progress('Walling in with carried blocks')
 const {feet}=site
 const placements=[]
 for(const [dx,dy,dz] of SIDES){
  placements.push({target:feet.offset(dx,0,dz),ref:feet.offset(dx,-1,dz)})
  placements.push({target:feet.offset(dx,1,dz),ref:feet.offset(dx,0,dz)})
 }
 placements.push({target:feet.offset(1,2,0),ref:feet.offset(1,1,0)})
 placements.push({target:feet.offset(0,2,0),ref:feet.offset(1,2,0)})
 let placed=0
 for(const {target,ref} of placements){
  check()
  if(solid(bot,bot.blockAt(target))){placed++;continue}
  const material=hutMaterials(bot)[0]
  if(!material)break
  await bot.equip(material,'hand');check()
  const reference=bot.blockAt(ref)
  if(!solid(bot,reference))continue
  // The bridge can drop a placement or its update: try each block twice.
  for(let attempt=0;attempt<2&&!solid(bot,bot.blockAt(target));attempt++){
   try{await bot.placeBlock(reference,target.minus(ref))}catch(error){check()}
   await settle(()=>solid(bot,bot.blockAt(target)),{check})
  }
  if(solid(bot,bot.blockAt(target)))placed++
 }
 const missing=placements.filter(({target})=>!solid(bot,bot.blockAt(target))).map(({target})=>key(target))
 if(missing.length)throw new Error(`Hut incomplete: ${missing.length} of ${placements.length} blocks missing (${missing.slice(0,3).join('; ')})${centred?'':'; could not stand clear of the wall line'}`)
 progress('Walled in; waiting for daylight')
 const p=bot.entity.position
 return {item:'safety',count:1,receipt:'walled_in',shelterName:'hut',capped:true,placed,position:{x:p.x,y:p.y,z:p.z},surface:{x:feet.x,y:feet.y,z:feet.z}}
}
export async function unwall(bot,task,{check,stage,progress}){
 check();const feet=bot.entity.position.floored()
 stage('surfacing');progress('Opening one wall of the hut')
 // Prefer a side whose outside cell is standable, so stepping out is safe.
 const order=[...SIDES].sort((a,b)=>{const score=([dx,,dz])=>{const o=feet.offset(dx*2,0,dz*2);return (REPLACEABLE.has(bot.blockAt(o)?.name)&&REPLACEABLE.has(bot.blockAt(o.offset(0,1,0))?.name)&&solid(bot,bot.blockAt(o.offset(0,-1,0))))?0:1};return score(a)-score(b)})
 for(const [dx,dy,dz] of order){
  const cells=[feet.offset(dx,1,dz),feet.offset(dx,0,dz)]
  let opened=true
  for(const c of cells){
   check();const b=bot.blockAt(c)
   if(!b||REPLACEABLE.has(b.name))continue
   if(bot.tool?.equipForBlock)await bot.tool.equipForBlock(b,{requireHarvest:false,getFromChest:false})
   try{await bot.dig(b);check()}catch{check();opened=false;break}
  }
  if(opened&&cells.every(c=>REPLACEABLE.has(bot.blockAt(c)?.name||'air')))return {item:'safety',count:1,receipt:'unwalled',side:{dx,dz},position:{x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z}}
 }
 throw new Error('Could not open a wall of the hut')
}
