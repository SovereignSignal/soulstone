import {setTimeout as delay} from 'node:timers/promises'
import {Vec3} from 'vec3'
import pathfinding from 'mineflayer-pathfinder'
import {DoorAwareMovements} from './navigation.js'
import {remainingDurability} from './supplies.js'
import {survivalObservation} from './survival.js'
import {observedSightline} from './visibility.js'

// Melee-defendable mobs and the health margin each demands. Skeletons shoot
// while the bot closes in, so they need more headroom.
export const DEFENDABLE_MOBS=new Set(['zombie','husk','spider','skeleton'])
export const DEFENSE_HEALTH={zombie:12,husk:12,spider:12,skeleton:16}
export const ENGAGE_RANGE=10
const weapons={wooden_axe:7,golden_axe:7,stone_axe:9,iron_axe:9,diamond_axe:9,netherite_axe:10,wooden_sword:4,golden_sword:4,stone_sword:5,iron_sword:6,diamond_sword:7,netherite_sword:8}
const point=p=>new Vec3(p.x,p.y,p.z)
const distance=(a,b)=>point(a).distanceTo(point(b))
const knownPoint=p=>p&&['x','y','z'].every(k=>Number.isFinite(p[k]))
const identified=e=>e&&Number.isInteger(e.id)&&typeof e.uuid==='string'&&e.uuid.length>0&&['mob','hostile'].includes(e.type)&&DEFENDABLE_MOBS.has(e.name)&&knownPoint(e.position)
const same=(e,g)=>identified(e)&&e.id===g.targetId&&e.uuid===g.targetUuid&&e.name===g.targetName
const dangerNearby=(bot,range=8)=>survivalObservation(bot).nearbyThreats.filter(e=>e.risk==='potential_hostile'&&e.distance<=range)
function swordBystander(bot,target){
 return Object.values(bot.entities||{}).some(e=>e!==bot.entity&&e!==target&&(['player','mob'].includes(e.type)||bot.registry?.entitiesByName[e.name]?.metadataKeys?.includes('health'))&&(!knownPoint(e.position)||distance(e.position,target.position)<=4||distance(e.position,bot.entity.position)<=4))
}
export function weaponFor(bot,target){
 return bot.inventory.items().filter(i=>weapons[i.name]&&Number.isFinite(i.maxDurability)&&remainingDurability(i)>=16&&(!i.name.endsWith('_sword')||!swordBystander(bot,target)))
  .sort((a,b)=>weapons[b.name]-weapons[a.name]||remainingDurability(b)-remainingDurability(a))[0]
}
// The best carried melee weapon for any target, bystanders aside.
export function meleeWeapon(bot){
 return bot.inventory.items().filter(i=>weapons[i.name]&&Number.isFinite(i.maxDurability)&&remainingDurability(i)>=8).sort((a,b)=>weapons[b.name]-weapons[a.name])[0]||null
}
export function clearStrike(bot,target){
 if(!knownPoint(bot.entity?.position)||!knownPoint(target?.position)||typeof bot.world?.raycast!=='function')return false
 const eye=point(bot.entity.position).offset(0,bot.entity.eyeHeight||1.62,0)
 const aim=point(target.position).offset(0,Math.min(1.2,(target.height||1.8)/2),0)
 const vector=aim.minus(eye),length=vector.norm();if(!length||length>7)return false
 return observedSightline(bot,eye,aim).status==='clear'
}
// The margins are the rule's; a judged fight may lower them to floors it names.
export function defenseDecision(bot,{healthFloor=12,foodFloor=10,mobMargins=true}={}){
 const s=survivalObservation(bot)
 const reject=reason=>({engage:false,reason})
 if(s.gameMode!=='survival'||!['easy','normal','hard'].includes(s.difficulty))return reject('Combat requires observed hostile Survival difficulty')
 if(!Number.isFinite(s.health)||s.health<healthFloor||s.food<foodFloor||!Number.isFinite(s.food))return reject('Health or food is too low to engage')
 if(!knownPoint(bot.entity?.position)||!bot.entity.onGround||bot.entity.isInWater||bot.entity.isInLava||bot.currentWindow)return reject('Not ready on stable ground with inventory closed')
 const threats=dangerNearby(bot,ENGAGE_RANGE)
 if(threats.length!==1||threats[0].distance>ENGAGE_RANGE||!DEFENDABLE_MOBS.has(threats[0].name))return reject('Threat type or nearby numbers exceed basic melee defense')
 if(mobMargins&&s.health<DEFENSE_HEALTH[threats[0].name])return reject(`Health is too low to engage a ${threats[0].name}`)
 const target=Object.values(bot.entities||{}).find(e=>identified(e)&&e.name===threats[0].name&&distance(e.position,bot.entity.position)<=ENGAGE_RANGE)
 // A blocked line (wall, doorway, roof) is not a reason to hide: the defense
 // loop closes in through doors and gives up after twelve seconds without a strike.
 if(!target)return reject('Target identity is unavailable')
 const weapon=weaponFor(bot,target)
 if(!weapon)return reject('No serviceable melee weapon safe to use near bystanders')
 return {engage:true,target:{targetId:target.id,targetUuid:target.uuid,targetName:target.name},weapon:weapon.name}
}
export function validateDefenseGoal(g){
 if(!g||!Number.isInteger(g.targetId)||g.targetId<0||typeof g.targetUuid!=='string'||!/^[\da-f-]{36}$/i.test(g.targetUuid)||!DEFENDABLE_MOBS.has(g.targetName)||typeof g.connectionId!=='string'||!/^[\da-f-]{36}$/i.test(g.connectionId))throw new Error('Defense requires an observed mob identity and current connection')
 return {targetId:g.targetId,targetUuid:g.targetUuid,targetName:g.targetName,connectionId:g.connectionId}
}
export function combatClearance(bot){
 const s=survivalObservation(bot),p=bot?.entity?.position
 if(!knownPoint(p)||s.gameMode!=='survival'||!['easy','normal','hard'].includes(s.difficulty)||!(s.health>10)||!(s.food>6)||!bot.entity.onGround)return {clear:false,reason:'Health, food or stable ground needs attention'}
 for(let x=Math.floor((p.x-8)/16);x<=Math.floor((p.x+8)/16);x++)for(let z=Math.floor((p.z-8)/16);z<=Math.floor((p.z+8)/16);z++){
  const column=bot.world?.getColumn?.(x,z)
  if(!column||typeof column.then==='function')return {clear:false,reason:'Nearby terrain is not fully observed'}
 }
 return dangerNearby(bot).length?{clear:false,reason:'Another potential threat is nearby'}:{clear:true,health:s.health,food:s.food}
}

// One identified mob per bounded action. Never chase a replacement entity or
// replay an encounter after reconnect. Server death is distinct from disappearance.
export async function defendAgainstMob(bot,task,{check,stage,progress,persist,movements}){
 const goal=validateDefenseGoal(task.goal),initial=defenseDecision(bot)
 if(!initial.engage||!same(bot.entities[goal.targetId],goal))throw new Error(initial.reason||'Combat target changed')
 const target=bot.entities[goal.targetId],anchor=point(bot.entity.position),weapon=weaponFor(bot,target)
 if(!weapon)throw new Error('No serviceable melee weapon')
 const cooldown=weapon.name.endsWith('_axe')?1300:700
 const record=task.combat={target:goal.targetName,uuid:goal.targetUuid,weapon:weapon.name,attacks:0,hurtEvents:0,deathObserved:false,startedAt:Date.now(),minimumHealth:bot.health}
 const killed=e=>{if(e===target&&same(e,goal)){record.deathObserved=true;persist()}}
 const hurt=e=>{if(e===target){record.hurtEvents++;persist()}}
 bot.on('entityDead',killed);bot.on('entityHurt',hurt)
 let blocking=false,following=false,nextAttack=Date.now()+cooldown,lastContact=Date.now()
 const blockingState=value=>{if(blocking===value)return;if(value)bot.activateItem(true);else bot.deactivateItem();blocking=value}
 const guard=()=>{
  check()
  if(Date.now()>=task.deadline||Date.now()-record.startedAt>=30000)throw new Error('Combat time limit reached')
  if(bot.game?.gameMode!=='survival'||!['easy','normal','hard'].includes(bot.game?.difficulty))throw new Error('Combat difficulty or game mode changed')
  if(!(bot.health>10)||!(bot.food>6))throw new Error('Health or food requires retreat')
  record.minimumHealth=Math.min(record.minimumHealth,bot.health)
  if(!knownPoint(bot.entity.position)||distance(anchor,bot.entity.position)>ENGAGE_RANGE||bot.entity.isInLava||bot.entity.isInWater)throw new Error('Combat left its safe movement boundary')
  const threats=dangerNearby(bot)
  if(threats.length>1||threats.some(e=>e.name!==goal.targetName||distance(e.position,target.position)>.05))throw new Error('Additional nearby threats require retreat')
 }
 try{
  check();stage('arming');await bot.equip(weapon,'hand');guard()
  const offHand=bot.getEquipmentDestSlot?.('off-hand')
  const shield=bot.inventory.slots?.[offHand]?.name==='shield'?bot.inventory.slots[offHand]:bot.inventory.items().find(i=>i.name==='shield'&&remainingDurability(i)>8)
  if(shield&&offHand!==undefined){await bot.equip(shield,'off-hand');guard();record.shield=true}
  const combatMovement=new DoorAwareMovements(bot)
  combatMovement.canDig=false;combatMovement.allow1by1towers=false;combatMovement.scafoldingBlocks=[]
  combatMovement.allowParkour=false;combatMovement.allowFreeMotion=false;combatMovement.allowSprinting=true;combatMovement.maxDropDown=1
  combatMovement.exclusionAreasStep.push(b=>!knownPoint(b.position)||distance(b.position,anchor)>ENGAGE_RANGE-1?100:0)
  bot.pathfinder.setMovements(combatMovement)
  stage('defending');progress('Defending against '+goal.targetName+' with '+weapon.name.replaceAll('_',' '));persist()
  while(true){
   guard()
   if(record.deathObserved){if(!record.attacks)throw new Error('Mob died before any defense attack');break}
   if(bot.entities[goal.targetId]!==target||!same(target,goal))throw new Error('Target disappeared or identity changed; no kill confirmed')
   // Judge the target's distance from the bot, not from where the fight began:
   // the bot's own leash to the anchor is enforced by the guard, and a mob that
   // drifts two blocks must not end a fight the bot opened at nine.
   if(distance(bot.entity.position,target.position)>ENGAGE_RANGE+2)throw new Error('Target left the defense boundary')
   const held=bot.heldItem
   if(held?.name!==weapon.name||remainingDurability(held)<4)throw new Error('Weapon changed or is nearly broken')
   const range=distance(bot.entity.position,target.position),sight=clearStrike(bot,target)
   if(range<=2.9&&sight){
    lastContact=Date.now()
    if(following){bot.pathfinder.setGoal(null);following=false}
    await bot.lookAt(point(target.position).offset(0,Math.min(1.2,(target.height||1.8)/2),0),true);guard()
    if(record.deathObserved)continue
    if(Date.now()>=nextAttack&&bot.entities[goal.targetId]===target&&same(target,goal)&&distance(bot.entity.position,target.position)<=2.9&&clearStrike(bot,target)){
     if(weapon.name.endsWith('_sword')&&swordBystander(bot,target))throw new Error('Bystander entered sword sweep range')
     blockingState(false);guard();bot.attack(target);record.attacks++;nextAttack=Date.now()+cooldown;persist()
    }else if(record.shield&&bot.inventory.slots?.[offHand]?.name==='shield')blockingState(true)
   }else{
    blockingState(false)
    // A dropped follow goal (no path inside the bubble, target moved) leaves the
    // bot standing; re-issue it rather than waiting out the contact window.
    if(!following||!bot.pathfinder.goal){bot.pathfinder.setGoal(new pathfinding.goals.GoalFollow(target,2),true);following=true}
   }
   // Twelve seconds without a strike covers a doorway detour or a kiting skeleton inside the boundary.
   if(Date.now()-lastContact>12000)throw new Error('Cannot reach a clear melee strike; retreat required')
   await delay(50)
  }
  record.endedAt=Date.now();persist()
  return {...record,count:1,item:goal.targetName,receipt:'target_death_observed',attribution:'Server death observed after our attacks; exclusive kill attribution requires server statistics'}
 }finally{
  bot.removeListener('entityDead',killed);bot.removeListener('entityHurt',hurt)
  bot.deactivateItem();bot.pathfinder.setGoal(null);bot.clearControlStates()
  if(movements)bot.pathfinder.setMovements(movements)
 }
}
