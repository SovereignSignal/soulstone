import {setTimeout as delay} from 'node:timers/promises'
import {Vec3} from 'vec3'
import pathfinding from 'mineflayer-pathfinder'
import {DoorAwareMovements} from './navigation.js'
import {remainingDurability} from './supplies.js'
import {survivalObservation,cannotShootYet} from './survival.js'
import {observedSightline} from './visibility.js'

// Melee-defendable mobs and the health margin each demands. Skeletons shoot
// while the bot closes in, so they need more headroom. A wither skeleton guards
// every fortress corridor (step 4, lab run 131: the bot went home at the sight of
// one); it hits hard and withers, so it is fought only alone, nearly unhurt, in
// HEAVY armour, with a weapon of at least HEAVY damage (iron sword or axe up).
// Every melee-range hostile the alarm counts is one the rules can fight, or a cornered bot
// dies with a sword in its hand (honest run 2, 14 October: a zombie villager at arm's reach
// for thirty seconds, every shelter refused for containing it, and not one swing at 15 health).
// The zombie and skeleton variants share their originals' floors; the poisoners a little more.
export const DEFENDABLE_MOBS=new Set(['zombie','zombie_villager','husk','drowned','spider','cave_spider','skeleton','stray','bogged','wither_skeleton','magma_cube'])
export const DEFENSE_HEALTH={zombie:12,zombie_villager:12,husk:12,drowned:14,spider:12,cave_spider:14,skeleton:16,stray:16,bogged:16,wither_skeleton:18,magma_cube:14}
// HEAVY_ARMOR is the Nether kit: iron helmet, chestplate and leggings with the golden boots
// piglins demand, 14 points (lab run 133 refused one at 14 of 15).
// Magma cubes too (lab run 134: a big one stood on the trail home and killed the bot).
const HEAVY_MOBS=new Set(['wither_skeleton','magma_cube']),HEAVY_ARMOR=14,HEAVY_DAMAGE=6
// Hit, a big magma cube splits into two to four smaller ones: one fight, not a crowd.
const SPLIT_SIZE=4
export const ENGAGE_RANGE=10
// Armour changes the arithmetic. In full iron a zombie's hit falls from 3 to
// about 1.2, and digging a burrow with two zombies on its back cost the test
// bot 14 health in ten seconds and then its life (4 October 19:09Z), because
// the one-mob rule sent it to dig. Armoured to GROUP_ARMOR points or more, it
// fights up to GROUP_SIZE melee mobs, nearest first; ranged mobs, creepers and
// bigger groups still send it to shelter.
export const GROUP_ARMOR=15,GROUP_SIZE=3,GROUP_MOBS=new Set(['zombie','husk','spider'])
const ARMOR_POINTS={leather_helmet:1,leather_chestplate:3,leather_leggings:2,leather_boots:1,golden_helmet:2,golden_chestplate:5,golden_leggings:3,golden_boots:1,
 chainmail_helmet:2,chainmail_chestplate:5,chainmail_leggings:4,chainmail_boots:1,iron_helmet:2,iron_chestplate:6,iron_leggings:5,iron_boots:2,turtle_helmet:2,
 diamond_helmet:3,diamond_chestplate:8,diamond_leggings:6,diamond_boots:3,netherite_helmet:3,netherite_chestplate:8,netherite_leggings:6,netherite_boots:3}
export function armorPoints(bot){
 return ['head','torso','legs','feet'].reduce((n,slot)=>{const i=bot?.getEquipmentDestSlot?.(slot);return n+(ARMOR_POINTS[Number.isInteger(i)?bot.inventory?.slots?.[i]?.name:'']||0)},0)
}
// A group fight is allowed while every hostile near is a melee mob of the
// group kinds, there are at most GROUP_SIZE of them, and the armour holds.
export function groupFightable(bot,threats){
 return threats.length>=1&&(threats.length<=GROUP_SIZE&&threats.every(t=>GROUP_MOBS.has(t.name))&&armorPoints(bot)>=GROUP_ARMOR||
  threats.length<=SPLIT_SIZE&&threats.every(t=>t.name==='magma_cube')&&armorPoints(bot)>=HEAVY_ARMOR)
}
const weapons={wooden_axe:7,golden_axe:7,stone_axe:9,iron_axe:9,diamond_axe:9,netherite_axe:10,wooden_sword:4,golden_sword:4,stone_sword:5,iron_sword:6,diamond_sword:7,netherite_sword:8}
const point=p=>new Vec3(p.x,p.y,p.z)
const distance=(a,b)=>point(a).distanceTo(point(b))
const knownPoint=p=>p&&['x','y','z'].every(k=>Number.isFinite(p[k]))
const identified=e=>e&&Number.isInteger(e.id)&&typeof e.uuid==='string'&&e.uuid.length>0&&['mob','hostile'].includes(e.type)&&DEFENDABLE_MOBS.has(e.name)&&knownPoint(e.position)
const same=(e,g)=>identified(e)&&e.id===g.targetId&&e.uuid===g.targetUuid&&e.name===g.targetName
const dangerNearby=(bot,range=8)=>survivalObservation(bot).nearbyThreats.filter(e=>e.risk==='potential_hostile'&&e.distance<=range)
// A bystander is something the sweep must not hit: a player, a villager, a pet. Another
// hostile is not one (the pieces of a split magma cube cluster, and the sword was refused).
function swordBystander(bot,target){
 const hostiles=new Set(survivalObservation(bot).nearbyThreats.filter(t=>t.risk==='potential_hostile').map(t=>t.name))
 return Object.values(bot.entities||{}).some(e=>e!==bot.entity&&e!==target&&!hostiles.has(e.name)&&(['player','mob'].includes(e.type)||bot.registry?.entitiesByName[e.name]?.metadataKeys?.includes('health'))&&(!knownPoint(e.position)||distance(e.position,target.position)<=4||distance(e.position,bot.entity.position)<=4))
}
export const meleeDamage=name=>weapons[name]||0
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
// Cornered: every shelter refused with a mob in arm's reach. Test world,
// 3 October 19:44Z: two zombies at 2 and 3.8 blocks, burrow, hut, retreat
// and sprint all failed, and the bot died at full gear without one swing.
// Then the nearest defendable mob within CORNER_RANGE is fought whatever the
// count, down to CORNER_HEALTH, with the best tool carried, pickaxes included.
export const CORNER_RANGE=4,CORNER_HEALTH=2
const pickaxes={wooden_pickaxe:2,golden_pickaxe:2,stone_pickaxe:3,iron_pickaxe:4,diamond_pickaxe:5,netherite_pickaxe:6}
export function cornerWeapon(bot,target){
 return weaponFor(bot,target)||bot.inventory.items().filter(i=>(weapons[i.name]||pickaxes[i.name])&&Number.isFinite(i.maxDurability)&&remainingDurability(i)>=4)
  .sort((a,b)=>(weapons[b.name]||pickaxes[b.name])-(weapons[a.name]||pickaxes[a.name]))[0]||null
}
export function corneredDecision(bot){
 const s=survivalObservation(bot),reject=reason=>({engage:false,reason})
 if(s.gameMode!=='survival'||!['easy','normal','hard'].includes(s.difficulty))return reject('Combat requires observed hostile Survival difficulty')
 if(!(s.health>CORNER_HEALTH))return reject('Too hurt even to fight cornered')
 if(!knownPoint(bot.entity?.position)||bot.entity.isInLava)return reject('Not on ground the fight can use')
 const near=dangerNearby(bot,CORNER_RANGE).filter(t=>DEFENDABLE_MOBS.has(t.name)).sort((a,b)=>a.distance-b.distance)[0]
 if(!near)return reject('No defendable mob within reach')
 const target=Object.values(bot.entities||{}).filter(e=>identified(e)&&e.name===near.name&&distance(e.position,bot.entity.position)<=CORNER_RANGE+.5).sort((a,b)=>distance(a.position,bot.entity.position)-distance(b.position,bot.entity.position))[0]
 if(!target)return reject('Target identity is unavailable')
 const weapon=cornerWeapon(bot,target)
 if(!weapon)return reject('Nothing carried to fight with')
 return {engage:true,cornered:true,target:{targetId:target.id,targetUuid:target.uuid,targetName:target.name},weapon:weapon.name}
}
// The margins are the rule's; a judged fight may lower them to floors it names.
export function defenseDecision(bot,{healthFloor=12,foodFloor=10,mobMargins=true}={}){
 const s=survivalObservation(bot)
 const reject=reason=>({engage:false,reason})
 if(s.gameMode!=='survival'||!['easy','normal','hard'].includes(s.difficulty))return reject('Combat requires observed hostile Survival difficulty')
 if(!Number.isFinite(s.health)||s.health<healthFloor||s.food<foodFloor||!Number.isFinite(s.food))return reject('Health or food is too low to engage')
 if(!knownPoint(bot.entity?.position)||!bot.entity.onGround||bot.entity.isInWater||bot.entity.isInLava||bot.currentWindow)return reject('Not ready on stable ground with inventory closed')
 const threats=dangerNearby(bot,ENGAGE_RANGE).sort((a,b)=>a.distance-b.distance)
 const group=threats.length>1&&groupFightable(bot,threats)
 if(!group&&(threats.length!==1||threats[0].distance>ENGAGE_RANGE||!DEFENDABLE_MOBS.has(threats[0].name)))return reject('Threat type or nearby numbers exceed basic melee defense')
 if(mobMargins&&s.health<DEFENSE_HEALTH[threats[0].name])return reject(`Health is too low to engage a ${threats[0].name}`)
 const target=Object.values(bot.entities||{}).filter(e=>identified(e)&&e.name===threats[0].name&&distance(e.position,bot.entity.position)<=ENGAGE_RANGE).sort((a,b)=>distance(a.position,bot.entity.position)-distance(b.position,bot.entity.position))[0]
 // A blocked line (wall, doorway, roof) is not a reason to hide: the defense
 // loop closes in through doors and gives up after twelve seconds without a strike.
 if(!target)return reject('Target identity is unavailable')
 const weapon=weaponFor(bot,target)
 if(!weapon)return reject('No serviceable melee weapon safe to use near bystanders')
 if(HEAVY_MOBS.has(target.name)){
  if(armorPoints(bot)<HEAVY_ARMOR)return reject(`A ${target.name} needs iron armour, golden boots allowed, or better (${armorPoints(bot)} of ${HEAVY_ARMOR} points worn)`)
  if(weapons[weapon.name]<HEAVY_DAMAGE)return reject(`A ${target.name} needs an iron sword or axe or better, not a ${weapon.name.replaceAll('_',' ')}`)
 }
 return {engage:true,target:{targetId:target.id,targetUuid:target.uuid,targetName:target.name},weapon:weapon.name,...(group?{group:threats.length}:{})}
}
export function validateDefenseGoal(g){
 if(!g||!Number.isInteger(g.targetId)||g.targetId<0||typeof g.targetUuid!=='string'||!/^[\da-f-]{36}$/i.test(g.targetUuid)||!DEFENDABLE_MOBS.has(g.targetName)||typeof g.connectionId!=='string'||!/^[\da-f-]{36}$/i.test(g.connectionId))throw new Error('Defense requires an observed mob identity and current connection')
 return {targetId:g.targetId,targetUuid:g.targetUuid,targetName:g.targetName,connectionId:g.connectionId,...(g.cornered===true?{cornered:true}:{})}
}
export function combatClearance(bot){
 const s=survivalObservation(bot),p=bot?.entity?.position
 // Hurt is its own answer: waiting out a quiet that cannot come at this health only
 // stands still under whatever is still shooting (lab run 101).
 if(knownPoint(p)&&Number.isFinite(s.health)&&s.health<=10)return {clear:false,hurt:true,reason:`Health ${Math.round(s.health)} is half or less`}
 if(!knownPoint(p)||s.gameMode!=='survival'||!['easy','normal','hard'].includes(s.difficulty)||!(s.health>10)||!(s.food>6)||!bot.entity.onGround)return {clear:false,reason:'Health, food or stable ground needs attention'}
 for(let x=Math.floor((p.x-8)/16);x<=Math.floor((p.x+8)/16);x++)for(let z=Math.floor((p.z-8)/16);z<=Math.floor((p.z+8)/16);z++){
  const column=bot.world?.getColumn?.(x,z)
  if(!column||typeof column.then==='function')return {clear:false,reason:'Nearby terrain is not fully observed'}
 }
 // A shooter with no line to the bot is no threat until it has one, as for the
 // alarms (lab run 91: a blaze behind the fortress wall sent the bot home after its kill).
 return dangerNearby(bot).some(t=>!cannotShootYet(t))?{clear:false,reason:'Another potential threat is nearby'}:{clear:true,health:s.health,food:s.food}
}

// One identified mob per bounded action. Never chase a replacement entity or
// replay an encounter after reconnect. Server death is distinct from disappearance.
export async function defendAgainstMob(bot,task,{check,stage,progress,persist,movements}){
 const goal=validateDefenseGoal(task.goal),initial=goal.cornered?corneredDecision(bot):defenseDecision(bot)
 if(!initial.engage||!same(bot.entities[goal.targetId],goal))throw new Error(initial.reason||'Combat target changed')
 const target=bot.entities[goal.targetId],anchor=point(bot.entity.position),weapon=goal.cornered?cornerWeapon(bot,target):weaponFor(bot,target)
 if(!weapon)throw new Error('No serviceable melee weapon')
 const cooldown=weapon.name.endsWith('_axe')?1300:700
 const record=task.combat={target:goal.targetName,uuid:goal.targetUuid,weapon:weapon.name,attacks:0,hurtEvents:0,deathObserved:false,startedAt:Date.now(),minimumHealth:bot.health}
 // Where it died is where its drops lie: the after-fight pickup walks there.
 const killed=e=>{if(e===target&&same(e,goal)){record.deathObserved=true;if(knownPoint(e.position))record.at={x:e.position.x,y:e.position.y,z:e.position.z};persist()}}
 const hurt=e=>{if(e===target){record.hurtEvents++;persist()}}
 bot.on('entityDead',killed);bot.on('entityHurt',hurt)
 let blocking=false,following=false,nextAttack=Date.now()+cooldown,lastContact=Date.now()
 const blockingState=value=>{if(blocking===value)return;if(value)bot.activateItem(true);else bot.deactivateItem();blocking=value}
 const guard=()=>{
  check()
  if(Date.now()>=task.deadline||Date.now()-record.startedAt>=30000)throw new Error('Combat time limit reached')
  if(bot.game?.gameMode!=='survival'||!['easy','normal','hard'].includes(bot.game?.difficulty))throw new Error('Combat difficulty or game mode changed')
  if(goal.cornered?!(bot.health>CORNER_HEALTH):!(bot.health>10)||!(bot.food>6))throw new Error('Health or food requires retreat')
  record.minimumHealth=Math.min(record.minimumHealth,bot.health)
  if(!knownPoint(bot.entity.position)||distance(anchor,bot.entity.position)>ENGAGE_RANGE||bot.entity.isInLava||bot.entity.isInWater)throw new Error('Combat left its safe movement boundary')
  const threats=dangerNearby(bot)
  // Cornered, the other mobs are why: only a creeper close by ends the fight.
  if(goal.cornered){if(threats.some(e=>e.name==='creeper'&&e.distance<=CORNER_RANGE))throw new Error('A creeper closed in; the cornered fight ends')}
  else if(!groupFightable(bot,threats)&&(threats.length>1||threats.some(e=>e.name!==goal.targetName||distance(e.position,target.position)>.05)))throw new Error('Additional nearby threats require retreat')
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
