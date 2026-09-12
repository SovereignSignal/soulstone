// Hunt: kill the nearest farm animal for food or leather and collect the drops.
// Bounded to 32 blocks from the start and sixty seconds; pauses when a hostile
// approaches so the safety chain can take over.
import {setTimeout as delay} from 'node:timers/promises'
import pathfinding from 'mineflayer-pathfinder'
import {Vec3} from 'vec3'
import {DoorAwareMovements} from './navigation.js'
import {clearStrike,meleeWeapon} from './combat.js'
import {survivalObservation} from './survival.js'
const {goals}=pathfinding
export const HUNTABLE={raw_beef:['cow'],raw_porkchop:['pig'],raw_mutton:['sheep'],raw_chicken:['chicken'],leather:['cow'],feather:['chicken']}
const point=p=>new Vec3(p.x,p.y,p.z)
const distance=(a,b)=>point(a).distanceTo(point(b))
export function validateHuntGoal(goal){
 if(!HUNTABLE[goal?.item]||!Number.isInteger(goal.count)||goal.count<1||goal.count>8)throw new Error('Hunt needs a farm-animal drop (raw_beef, raw_porkchop, raw_mutton, raw_chicken, leather, feather) and a total of 1–8')
 return {item:goal.item,count:goal.count}
}
export async function huntFor(bot,task,{check,stage,progress,persist=()=>{},movements}){
 const {item,count:total}=validateHuntGoal(task.goal),animals=HUNTABLE[item]
 const count=()=>bot.inventory.items().filter(i=>i.name===item).reduce((n,i)=>n+i.count,0)
 const start=bot.entity.position.clone(),startedAt=Date.now(),record=task.hunt={item,kills:0,attacks:0}
 const hostile=()=>survivalObservation(bot).nearbyThreats.find(t=>t.risk==='potential_hostile'&&t.distance<=10)
 const guard=()=>{
  check()
  if(Date.now()-startedAt>60000)throw new Error('Hunting time limit reached')
  const threat=hostile();if(threat)throw new Error(`Hostile ${threat.name} nearby; hunting paused`)
  if(distance(bot.entity.position,start)>32)throw new Error('Hunting left its boundary')
 }
 const movement=new DoorAwareMovements(bot)
 Object.assign(movement,{canDig:false,allow1by1towers:false,allowParkour:false,allowSprinting:true,scafoldingBlocks:[],maxDropDown:2})
 bot.pathfinder.setMovements(movement)
 try{
  while(count()<total){
   guard()
   const target=Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&animals.includes(e.name)&&e.position&&distance(e.position,bot.entity.position)<=32).sort((a,b)=>distance(a.position,bot.entity.position)-distance(b.position,bot.entity.position))[0]
   if(!target){progress(`No ${animals.join(' or ')} within 32 blocks; carrying ${count()}/${total} ${item}`);break}
   const weapon=meleeWeapon(bot)
   if(weapon)await bot.equip(weapon,'hand');check()
   const cooldown=weapon?.name.endsWith('_axe')?1300:weapon?700:500
   stage('hunting');progress(`Hunting ${target.name} for ${item}: ${count()}/${total}`)
   let dead=false,lastPosition=point(target.position),nextAttack=0,following=false,contact=Date.now()
   const onDead=e=>{if(e===target){dead=true;lastPosition=point(target.position)}}
   bot.on('entityDead',onDead)
   try{
    while(!dead){
     guard()
     if(!bot.entities[target.id]){dead=true;break}
     lastPosition=point(target.position)
     const range=distance(bot.entity.position,target.position)
     if(range<=2.9&&clearStrike(bot,target)){
      contact=Date.now()
      if(following){bot.pathfinder.setGoal(null);following=false}
      await bot.lookAt(point(target.position).offset(0,(target.height||1)/2,0),true);check()
      if(Date.now()>=nextAttack){bot.attack(target);record.attacks++;nextAttack=Date.now()+cooldown;persist()}
     }else if(!following){bot.pathfinder.setGoal(new goals.GoalFollow(target,2),true);following=true}
     if(Date.now()-contact>12000)throw new Error(`Cannot reach the ${target.name}`)
     await delay(50)
    }
   }finally{bot.removeListener('entityDead',onDead);bot.pathfinder.setGoal(null)}
   record.kills++;persist();progress(`${target.name} down; collecting drops`)
   const before=count()
   const timer=setTimeout(()=>bot.pathfinder.setGoal(null),6000)
   try{await bot.pathfinder.goto(new goals.GoalNear(lastPosition.x,lastPosition.y,lastPosition.z,.5))}catch{}finally{clearTimeout(timer)}
   await delay(600);check()
   if(count()<=before)progress('No drop collected from that kill')
  }
 }finally{bot.pathfinder.setGoal(null);bot.clearControlStates?.();if(movements)bot.pathfinder.setMovements(movements)}
 return {item,count:count(),target:total,kills:record.kills,acquired:count()>=total,partial:count()<total,receipt:count()>=total?'hunt_target_reached':'hunt_partial'}
}
