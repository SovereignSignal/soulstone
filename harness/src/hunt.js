// Hunt: kill the nearest farm animal for food or leather and collect the drops.
// When nothing is in sight the bot walks bounded cardinal legs to look, because
// a beach or a mined-out hillside has no animals and standing still is not food.
// Pauses when a hostile approaches so the safety chain can take over.
import {setTimeout as delay} from 'node:timers/promises'
import pathfinding from 'mineflayer-pathfinder'
import {Vec3} from 'vec3'
import {DoorAwareMovements} from './navigation.js'
import {clearStrike,meleeWeapon} from './combat.js'
import {survivalObservation,calmDaylight,HEALTH_EMERGENCY_LINE} from './survival.js'
import {roofed} from './observations.js'
import {DEFENSE_HEALTH} from './combat.js'
const {goals}=pathfinding
// Minecraft's raw meats carry no raw_ prefix; those item ids do not exist, so a
// goal naming one could never be counted or eaten. Guarded by a registry test.
export const HUNTABLE={beef:['cow'],porkchop:['pig'],mutton:['sheep'],chicken:['chicken'],rabbit:['rabbit'],leather:['cow'],feather:['chicken'],white_wool:['sheep'],string:['spider']}
// Food rather than one species: 'meat' takes whichever farm animal is nearest and
// counts every raw meat (pi2, 10 October: two dawn hunts for beef walked past a pig
// and a chicken toward cows more than a hundred blocks off).
export const MEAT_DROPS={cow:'beef',pig:'porkchop',sheep:'mutton',chicken:'chicken',rabbit:'rabbit'}
export const HUNT_LEGS=6,HUNT_LEG=32
const EDIBLE=Object.keys(MEAT_DROPS)
const point=p=>new Vec3(p.x,p.y,p.z)
const distance=(a,b)=>point(a).distanceTo(point(b))
// Planned hunts carry at most 8; acquire, which needs 8 feathers for 32 arrows
// and more for a stack, passes its own bound.
export function validateHuntGoal(goal,max=8){
 if(!(HUNTABLE[goal?.item]||goal?.item==='meat')||!Number.isInteger(goal.count)||goal.count<1||goal.count>max)throw new Error('Hunt needs a farm-animal drop (beef, porkchop, mutton, chicken, rabbit, leather, feather, white_wool, string from spiders in daylight, or meat for any of them) and a total of 1–'+max)
 return {item:goal.item,count:goal.count}
}
export async function huntFor(bot,task,{check,stage,progress,persist=()=>{},movements,contactMs=12000,max=8}){
 const {item,count:total}=validateHuntGoal(task.goal,max),animals=item==='meat'?EDIBLE:HUNTABLE[item]
 const counted=item==='meat'?Object.values(MEAT_DROPS):[item]
 const count=()=>bot.inventory.items().filter(i=>counted.includes(i.name)).reduce((n,i)=>n+i.count,0)
 // String comes from spiders. A spider is calm only in daylight on the open
 // surface, so that is the only time the bot picks the fight; at night or under
 // rock it is a hostile, and self-defense answers the one that closes in.
 const spiders=animals.includes('spider')
 if(spiders){
  const tod=bot.time?.timeOfDay
  if(!calmDaylight(bot))throw new Error(`String comes from spiders, and the bot hunts them only in daylight on the open surface, where they are calm (time ${Number.isFinite(tod)?tod:'unknown'}${roofed(bot)?', under rock':''}). Hunt string after sunrise in the open; at night a spider that closes in is fought by self-defense, and its string is picked up while the request wants it.`)
  if(!meleeWeapon(bot))throw new Error('Hunting spiders needs a sword or an axe: a spider has 16 health and bites back. Acquire stone_sword first.')
  if(!(bot.health>=DEFENSE_HEALTH.spider))throw new Error(`Health ${Math.round(bot.health)} is below ${DEFENSE_HEALTH.spider}; a spider bites back. Eat and heal before hunting spiders.`)
 }
 const start=bot.entity.position.clone(),startedAt=Date.now()
 let legs=0,farthest=0,walkError=null
 const record=task.hunt={item,kills:0,attacks:0,legs:0}
 // Animals the walk could not get to: passed over, not the end of the hunt.
 const unreachable=new Map()
 const hostile=()=>survivalObservation(bot).nearbyThreats.find(t=>t.risk==='potential_hostile'&&t.distance<=10&&!(spiders&&t.name==='spider'))
 // The boundary grows with each completed leg so the walk out is not itself a violation.
 const boundary=()=>32+Math.ceil(legs/4)*HUNT_LEG
 // A chase is leashed to where it began, not to where the hunt began: a target
 // locked near the exploration edge used to abort the whole hunt on its first
 // step away, reported as leaving a boundary the bot never crossed.
 let chaseAnchor=null
 const guard=()=>{
  check()
  if(Date.now()-startedAt>180000)throw new Error('Hunting time limit reached')
  const threat=hostile();if(threat)throw new Error(`Hostile ${threat.name} nearby; hunting paused`)
  if(spiders){
   if(!(bot.health>HEALTH_EMERGENCY_LINE))throw new Error(`Health ${Math.round(bot.health)}: broke off the spider hunt with ${count()}/${total} string; heal before the next one`)
   if(!calmDaylight(bot))throw new Error(`The spiders are no longer calm (dusk or under rock); hunting paused with ${count()}/${total} string`)
  }
  if(chaseAnchor){if(distance(bot.entity.position,chaseAnchor)>32)throw new Error('Chase left its boundary')}
  else if(distance(bot.entity.position,start)>boundary())throw new Error('Hunting left its boundary')
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
   const target=Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&animals.includes(e.name)&&!unreachable.has(e.id)&&e.position&&distance(e.position,bot.entity.position)<=32).sort((a,b)=>distance(a.position,bot.entity.position)-distance(b.position,bot.entity.position))[0]
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
    // A leg the pathfinder refuses is not ground searched: keep its reason for the receipt.
    try{await bot.pathfinder.goto(new goals.GoalXZ(to.x,to.z))}catch(error){walkError??=String(error?.message||error).slice(0,100)}finally{clearTimeout(timer);bot.pathfinder.setGoal(null);bot.pathfinder.setMovements(movement)}
    farthest=Math.max(farthest,Math.round(distance(bot.entity.position,start)))
    await delay(400);continue
   }
   const weapon=meleeWeapon(bot)
   if(weapon)await bot.equip(weapon,'hand');check()
   const cooldown=weapon?.name.endsWith('_axe')?1300:weapon?700:500
   stage('hunting');progress(`Hunting ${target.name} for ${item}: ${count()}/${total}`)
   chaseAnchor=point(bot.entity.position)
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
     if(Date.now()-contact>contactMs)break
     await delay(50)
    }
   }finally{chaseAnchor=null;bot.removeListener('entityDead',onDead);bot.pathfinder.setGoal(null)}
   if(!dead){
    unreachable.set(target.id,target.name);record.unreachable=[...unreachable.values()];persist()
    if(unreachable.size>=3)throw new Error(`Cannot reach the ${[...unreachable.values()].join(', ')}; carrying ${count()}/${total} ${item}`)
    progress(`Cannot reach the ${target.name}; trying another`);continue
   }
   record.kills++;persist();progress(`${target.name} down; collecting drops`)
   const before=count()
   const timer=setTimeout(()=>bot.pathfinder.setGoal(null),6000)
   try{await bot.pathfinder.goto(new goals.GoalNear(lastPosition.x,lastPosition.y,lastPosition.z,.5))}catch{}finally{clearTimeout(timer)}
   await delay(600);check()
   if(count()<=before)progress('No drop collected from that kill')
  }
 }finally{bot.pathfinder.setGoal(null);bot.clearControlStates?.();if(movements)bot.pathfinder.setMovements(movements)}
 const seen=[...new Set(Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&e.position&&EDIBLE.includes(e.name)&&distance(e.position,bot.entity.position)<=32).map(e=>e.name))]
 // Partial means "I got some of what I wanted". Zero is a failure, and saying
 // otherwise starved the agent: twelve hunts in a row reported completed
 // carrying {count:0,kills:0,acquired:false} while hunger sat at 0/20, so the
 // planner never tried berries, a different area, or the surface.
 const walked=legs&&farthest<HUNT_LEG/2?` (the legs got at most ${farthest} blocks from the start${walkError?`; pathfinding: ${walkError}`:''})`:''
 if(count()===0)throw new Error(`Found no ${String(item).replaceAll('_',' ')} after ${legs} search ${legs===1?'leg':'legs'}${walked}`+
  (seen.length?`; animals seen nearby: ${[...new Set(seen.map(a=>a.name||a))].join(', ')}`:' and no animals in range')+
  (unreachable.size?`; out of reach: ${[...unreachable.values()].join(', ')}`:'')+
  '. Try a different area, the surface, or another food source.')
 return {item,count:count(),target:total,kills:record.kills,legs,nearbyAnimals:seen,...(unreachable.size?{unreachable:[...unreachable.values()]}:{}),position:point(bot.entity.position),acquired:count()>=total,partial:count()<total,receipt:count()>=total?'hunt_target_reached':'hunt_partial'}
}
