import {setTimeout as delay} from 'node:timers/promises'

// Ordinary food only. Special effects, teleportation and valuable consumables
// need a separate explicit capability rather than automatic hunger management.
export const SAFE_FOODS=new Set(['raw_beef','raw_porkchop','raw_mutton','raw_cod','raw_salmon','apple','baked_potato','beetroot','beetroot_soup','bread','carrot','cooked_beef','cooked_chicken','cooked_cod','cooked_mutton','cooked_porkchop','cooked_rabbit','cooked_salmon','cookie','dried_kelp','melon_slice','mushroom_stew','potato','pumpkin_pie','rabbit_stew','sweet_berries','glow_berries'])
const hostile=new Set(['zombie','husk','drowned','skeleton','stray','bogged','wither_skeleton','creeper','spider','cave_spider','witch','slime','magma_cube','phantom','pillager','vindicator','evoker','vex','ravager','silverfish','endermite','blaze','ghast','hoglin','zoglin','piglin_brute','warden','wither','ender_dragon'])
const conditional=new Set(['enderman','piglin','zombified_piglin','wolf','bee','polar_bear','iron_golem'])
export const isPotentialHostile=name=>hostile.has(name)
export const THREAT_INTERRUPTION='A potential hostile is within ten blocks'
export const NIGHT_EXPOSURE='Night with no shelter'
const ANIMALS=new Set(['cow','pig','sheep','chicken','rabbit','mooshroom','goat'])
// Ten blocks buys the three to four seconds a burrow needs; a creeper covers six in two.
export const WATER_EMERGENCY='Underwater or running low on air'
export const WATER_BLOCKS=new Set(['water','kelp','kelp_plant','seagrass','tall_seagrass','bubble_column'])
export function survivalObservation(bot) {
 const p=bot?.entity?.position
 const head=p?.offset&&bot.blockAt?bot.blockAt(p.offset(0,1.6,0).floored()):null
 const headSubmerged=head?WATER_BLOCKS.has(head.name)||head.getProperties?.().waterlogged===true:null
 // Surface spiders are neutral in daylight; treating them as hostile sends the bot underground for nothing.
 const tod=bot?.time?.timeOfDay,daylight=Number.isFinite(tod)&&tod>=1000&&tod<12500
 const nearbyThreats=p?Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&e.position&&(hostile.has(e.name)||conditional.has(e.name))).map(e=>({name:e.name,distance:Math.round(e.position.distanceTo(p)*10)/10,position:{x:e.position.x,y:e.position.y,z:e.position.z},risk:conditional.has(e.name)||e.name==='spider'&&daylight?'conditional':'potential_hostile'})).filter(e=>e.distance<=24).sort((a,b)=>a.distance-b.distance).slice(0,16):[]
 // Farm animals within 32 blocks, so the planner hunts what is actually there.
 const nearbyAnimals=p?Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&e.position&&ANIMALS.has(e.name)).map(e=>({name:e.name,distance:Math.round(e.position.distanceTo(p)*10)/10})).filter(e=>e.distance<=32).sort((a,b)=>a.distance-b.distance).slice(0,12):[]
 return {oxygen:Number.isFinite(bot?.oxygenLevel)?bot.oxygenLevel:null,nearbyAnimals,headSubmerged,inWater:bot?.entity?.isInWater??null,food:Number.isFinite(bot?.food)?bot.food:null,saturation:Number.isFinite(bot?.foodSaturation)?bot.foodSaturation:null,health:Number.isFinite(bot?.health)?bot.health:null,gameMode:bot?.game?.gameMode??null,difficulty:bot?.game?.difficulty??null,timeOfDay:bot?.time?.timeOfDay??null,carriedFood:(bot?.inventory?.items()||[]).filter(i=>SAFE_FOODS.has(i.name)).map(i=>({name:i.name,count:i.count})),nearbyThreats,threatCoverage:'Loaded entities within 24 blocks only; proximity does not establish aggression or line of sight'}
}
export function validateEatGoal(goal) {
 if(!goal||!SAFE_FOODS.has(goal.item)||!Number.isInteger(goal.count)||goal.count<1||goal.count>8)throw new Error('Eat requires an ordinary safe food and a maximum of 1–8 portions')
 return {item:goal.item,count:goal.count}
}
export async function eatFood(bot,task,{check,stage,progress,persist}) {
 const {item,count}=validateEatGoal(task.goal),quantity=()=>bot.inventory.items().filter(i=>i.name===item).reduce((n,i)=>n+i.count,0)
 check()
 if(bot.game?.gameMode!=='survival')throw new Error('Eating verification requires Survival mode')
 if(!Number.isFinite(bot.food))throw new Error('Hunger is not observable')
 if(bot.currentWindow)throw new Error('Close the current container before eating')
 if(task.consumption?.uncertain)throw new Error('Previous consumption is uncertain; inspect hunger and inventory before a new request')
 const receipts=task.consumed??=[]
 if(!Array.isArray(receipts)||receipts.length>count||receipts.some(r=>r.item!==item||r.after?.count!==r.before?.count-1||!(r.after?.food>r.before?.food)))throw new Error('Invalid saved consumption receipts')
 while(receipts.length<count&&bot.food<20){
  check();const food=bot.inventory.items().find(i=>i.name===item)
  if(!food)throw new Error('No carried '+item+'; acquire food first')
  await bot.equip(food,'hand');check()
  const before={food:bot.food,count:quantity()}
  task.consumption={item,before,uncertain:true};persist();stage('eating');progress('Eating '+item.replaceAll('_',' '))
  try{
   await bot.consume();check()
   const deadline=Date.now()+3000
   while(!(quantity()===before.count-1&&bot.food>before.food)){
    check();if(Date.now()>deadline)throw new Error('Consumption not confirmed by both hunger and inventory; inspect before retrying')
    await delay(50)
   }
   const receipt={item,before,after:{food:bot.food,count:quantity()}};receipts.push(receipt)
   task.consumption={...receipt,uncertain:false};persist()
  }finally{bot.deactivateItem()}
 }
 return {item,count:receipts.length,food:bot.food,receipt:receipts.length?'food_consumption_verified':'hunger_already_full',consumed:receipts}
}

export function emergencyReason(observation){
 if(observation.gameMode!=='survival'||!Number.isFinite(observation.health)||observation.health<=0)return null
 if(observation.headSubmerged===true||observation.headSubmerged!==false&&Number.isFinite(observation.oxygen)&&observation.oxygen<=15)return WATER_EMERGENCY
 // An emergency is something safety can act on. Low health matters when a
 // hostile is near or a base exists to retreat to; low food matters when there
 // is food to eat. Otherwise the planner keeps working and forages itself.
 const hostileNear=!!observation.difficulty&&observation.difficulty!=='peaceful'&&(observation.nearbyThreats||[]).some(t=>t.risk==='potential_hostile'&&t.distance<=16)
 if(observation.health<=10&&(hostileNear||observation.shelterAvailable===true))return 'Health is at or below half'
 if(Number.isFinite(observation.food)&&observation.food<=6&&(observation.carriedFood||[]).length)return 'Food is critically low'
 if(observation.difficulty&&observation.difficulty!=='peaceful'&&observation.nearbyThreats.some(t=>t.risk==='potential_hostile'&&t.distance<=(t.name==='creeper'?16:10)))return THREAT_INTERRUPTION
 // Out in the open after dusk with no built base: dig in before the crowd arrives.
 if(observation.shelterAvailable===false&&observation.difficulty&&observation.difficulty!=='peaceful'&&Number.isFinite(observation.timeOfDay)&&(observation.timeOfDay>=12500||observation.timeOfDay<500))return NIGHT_EXPOSURE
 return null
}
