import pathfinding from 'mineflayer-pathfinder'
import {Vec3} from 'vec3'
const {goals}=pathfinding
const berryAge=b=>{const value=b?.getProperties?.()?.age;const age=value===null||value===undefined?NaN:Number(value);return Number.isInteger(age)&&age>=0&&age<=3?age:null}
// Planning and execution share the same bounded loaded-block survey. A bush
// with unknown age is not a ripe food source, and absence is only local evidence.
export function berryObservation(bot){
 const id=bot?.registry?.blocksByName?.sweet_berry_bush?.id
 const scope={radius:48,limit:64,scope:'Loaded berry bushes only; access and terrain beyond this bounded scan are unverified'}
 if(!Number.isInteger(id)||!bot?.findBlocks||!bot?.blockAt)return {...scope,status:'unknown',bushes:[],ripeCount:null}
 const positions=bot.findBlocks({matching:id,maxDistance:scope.radius,count:scope.limit}).slice(0,scope.limit),bushes=[];let unknownBlocks=0
 for(const p of positions){const b=bot.blockAt(p);if(!b){unknownBlocks++;continue}if(b.name!=='sweet_berry_bush')continue
  const age=berryAge(b);bushes.push({position:{x:p.x,y:p.y,z:p.z},age,ripe:age===null?null:age>=2})}
 return {...scope,status:'observed',bushes,ripeCount:bushes.filter(b=>b.ripe).length,unknownBlocks,truncated:positions.length===scope.limit}
}
export function validateHarvest(goal){
 if(goal?.item!=='sweet_berries'||!Number.isInteger(goal.count)||goal.count<1||goal.count>32)throw new Error('Harvest requires a total of 1–32 sweet_berries')
 return {item:goal.item,count:goal.count}
}
export async function harvestBerries(bot,task,{check,walk,settle,progress,stage,persist}){
 const {count}=validateHarvest(task.goal),total=()=>bot.inventory.items().filter(i=>i.name==='sweet_berries').reduce((n,i)=>n+i.count,0),id=bot.registry.blocksByName.sweet_berry_bush?.id
 if(id===undefined)throw new Error('Sweet berry bushes are unavailable in this version')
 const harvested=task.harvested??=[],rejected=task.harvestRejected??=[],visited=new Set(rejected.map(r=>new Vec3(r.position.x,r.position.y,r.position.z).toString()));let attempts=0
 while(total()<count&&attempts++<16){
  check();const source=berryObservation(bot).bushes.find(b=>b.ripe&&!visited.has(new Vec3(b.position.x,b.position.y,b.position.z).toString())),p=source?new Vec3(source.position.x,source.position.y,source.position.z):null
  if(!p)throw new Error(`No more ripe berry bushes within 48 blocks; carrying ${total()}. Existing bushes are preserved for regrowth.`)
  visited.add(p.toString());progress(`Harvesting renewable berries: ${total()}/${count}`)
  const attempt=task.harvestAttempt={position:{x:p.x,y:p.y,z:p.z},status:'approaching',observedAge:source.age,beforeCount:total()};persist()
  // Berry bushes have no collision shape, so a collision-raycast look goal
  // can never finish. Approach by distance without stepping into the bush.
  const goal=new goals.GoalNear(p.x,p.y,p.z,2)
  try{await walk(goal);check()}catch(error){check();attempt.status='unreachable';attempt.reason=error.message;rejected.push({position:{x:p.x,y:p.y,z:p.z},reason:error.message});persist();continue}
  if(bot.entity.position.distanceTo(p.offset(.5,0,.5))>3.5)throw new Error('Berry bush is outside interaction reach')
  const b=bot.blockAt(p);if(b?.name!=='sweet_berry_bush'||!(berryAge(b)>=2)){attempt.status='not_ripe';persist();continue}
  const priorDrops=new Set(Object.values(bot.entities||{}).map(e=>e.id))
  // An empty hand is required here: activating with an item held uses that item instead. When `use` lands, bare-hand becomes an explicit variant of this path, not an invariant of it.
  // Here specifically: berries would be eaten or a block placed into the bush.
  const before=total();await bot.unequip('hand');check();attempt.status='activation_pending';attempt.beforeCount=before;persist();stage('harvesting');await bot.activateBlock(b);check()
  await settle(()=>bot.blockAt(p)?.name==='sweet_berry_bush'&&Number(bot.blockAt(p).getProperties().age)===1,'Berry harvest was not confirmed; do not destroy the bush')
  attempt.status='crop_confirmed';attempt.remainingAge=1;persist()
  // Drops can tumble downhill. Observe the new entities after their initial
  // fall and walk to a supported landing cell, never into the damaging bush.
  await bot.waitForTicks(10);check()
  const observedDrops=Object.values(bot.entities||{}).filter(e=>!priorDrops.has(e.id)&&e.getDroppedItem?.()?.name==='sweet_berries'&&e.position.distanceTo(p)<6)
  attempt.dropIds=observedDrops.map(e=>e.id);persist()
  const drops=observedDrops.map(e=>e.position.floored())
  const candidates=[...drops,...[[1,0],[-1,0],[0,1],[0,-1]].map(([x,z])=>p.offset(x,0,z))].filter(q=>bot.blockAt(q)?.name==='air'&&bot.blockAt(q.offset(0,1,0))?.name==='air'&&bot.blockAt(q.offset(0,-1,0))?.boundingBox==='block').sort((a,b)=>a.distanceTo(bot.entity.position)-b.distanceTo(bot.entity.position))
  if(total()<=before&&!candidates.length)throw new Error('Harvested berries have no safe adjacent pickup position')
  for(const q of candidates){if(total()>before)break;try{await walk(new goals.GoalBlock(q.x,q.y,q.z))}catch(error){check();continue}check();await bot.waitForTicks(10);check()}
  await settle(()=>total()>before,'Berry pickup not confirmed; crop remains planted')
  attempt.status='pickup_confirmed';attempt.gained=total()-before
  harvested.push({position:{x:p.x,y:p.y,z:p.z},gained:attempt.gained,remainingAge:bot.blockAt(p).getProperties().age,dropIds:attempt.dropIds});persist()
 }
 if(total()<count)throw new Error('Bounded harvesting limit reached; inspect the food reserve')
 return {item:'sweet_berries',count:total(),receipt:'renewable_berry_harvest',harvested}
}
