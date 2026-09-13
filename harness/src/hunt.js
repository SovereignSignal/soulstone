// Hunt: kill the nearest farm animal for food or leather and collect the drops.
// When nothing is in sight the bot walks bounded cardinal legs to look, because
// a beach or a mined-out hillside has no animals and standing still is not food.
// Pauses when a hostile approaches so the safety chain can take over.
import {setTimeout as delay} from 'node:timers/promises'
import pathfinding from 'mineflayer-pathfinder'
import {Vec3} from 'vec3'
import {DoorAwareMovements} from './navigation.js'
import {clearStrike,meleeWeapon} from './combat.js'
import {survivalObservation} from './survival.js'
const {goals}=pathfinding
// Minecraft's raw meats carry no raw_ prefix; those item ids do not exist, so a
// goal naming one could never be counted or eaten. Guarded by a registry test.
export const HUNTABLE={beef:['cow'],porkchop:['pig'],mutton:['sheep'],chicken:['chicken'],rabbit:['rabbit'],leather:['cow'],feather:['chicken'],white_wool:['sheep']}
export const HUNT_LEGS=6,HUNT_LEG=32
const EDIBLE=['cow','pig','sheep','chicken','rabbit']
const point=p=>new Vec3(p.x,p.y,p.z)
const distance=(a,b)=>point(a).distanceTo(point(b))
export function validateHuntGoal(goal){
 if(!HUNTABLE[goal?.item]||!Number.isInteger(goal.count)||goal.count<1||goal.count>8)throw new Error('Hunt needs a farm-animal drop (beef, porkchop, mutton, chicken, rabbit, leather, feather, white_wool) and a total of 1–8')
 return {item:goal.item,count:goal.count}
}
export async function huntFor(bot,task,{check,stage,progress,persist=()=>{},movements}){
 const {item,count:total}=validateHuntGoal(task.goal),animals=HUNTABLE[item]
 const count=()=>bot.inventory.items().filter(i=>i.name===item).reduce((n,i)=>n+i.count,0)
 const start=bot.entity.position.clone(),startedAt=Date.now()
 let legs=0
 const record=task.hunt={item,kills:0,attacks:0,legs:0}
 const hostile=()=>survivalObservation(bot).nearbyThreats.find(t=>t.risk==='potential_hostile'&&t.distance<=10)
 // The boundary grows with each completed leg so the walk out is not itself a violation.
 const boundary=()=>32+Math.ceil(legs/4)*HUNT_LEG
 const guard=()=>{
  check()
  if(Date.now()-startedAt>180000)throw new Error('Hunting time limit reached')
  const threat=hostile();if(threat)throw new Error(`Hostile ${threat.name} nearby; hunting paused`)
  if(distance(bot.entity.position,start)>boundary())throw new Error('Hunting left its boundary')
 }
 const movement=new DoorAwareMovements(bot)
 Object.assign(movement,{canDig:false,allow1by1towers:false,allowParkour:false,allowSprinting:true,scafoldingBlocks:[],maxDropDown:2})
 // Sprinting is for closing on an animal, never for the search: it burns the
 // hunger the hunt exists to restore.
 const searching=new DoorAwareMovements(bot)
 Object.assign(searching,{canDig:false,allow1by1towers:false,allowParkour:false,allowSprinting:false,scafoldingBlocks:[],maxDropDown:2})
 bot.pathfinder.setMovements(movement)
 try{
  while(count()<total){
   guard()
   const target=Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&animals.includes(e.name)&&e.position&&distance(e.position,bot.entity.position)<=32).sort((a,b)=>distance(a.position,bot.entity.position)-distance(b.position,bot.entity.position))[0]
   if(!target){
    const others=[...new Set(Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&e.position&&EDIBLE.includes(e.name)&&distance(e.position,bot.entity.position)<=32).map(e=>e.name))]
    if(legs>=HUNT_LEGS||Date.now()-startedAt>150000){
     progress(`No ${animals.join(' or ')} within 32 blocks after ${legs} exploring legs${others.length?` (nearby animals: ${others.join(', ')})`:' and no other farm animals either'}; carrying ${count()}/${total} ${item}`)
     break
    }
    legs++;record.legs=legs;persist()
    const [dx,dz]=[[HUNT_LEG,0],[0,HUNT_LEG],[-HUNT_LEG,0],[0,-HUNT_LEG]][(legs-1)%4],ring=Math.ceil(legs/4)
    const to={x:Math.round(start.x+dx*ring),z:Math.round(start.z+dz*ring)}
    stage('walking');progress(`No ${animals.join(' or ')} in sight; walking to look, leg ${legs} of ${HUNT_LEGS}`)
    bot.pathfinder.setMovements(searching);bot.setControlState?.('sprint',false)
    const timer=setTimeout(()=>bot.pathfinder.setGoal(null),20000)
    try{await bot.pathfinder.goto(new goals.GoalXZ(to.x,to.z))}catch{}finally{clearTimeout(timer);bot.pathfinder.setGoal(null);bot.pathfinder.setMovements(movement)}
    await delay(400);continue
   }
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
 const seen=[...new Set(Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&e.position&&EDIBLE.includes(e.name)&&distance(e.position,bot.entity.position)<=32).map(e=>e.name))]
 return {item,count:count(),target:total,kills:record.kills,legs,nearbyAnimals:seen,position:point(bot.entity.position),acquired:count()>=total,partial:count()<total,receipt:count()>=total?'hunt_target_reached':'hunt_partial'}
}
