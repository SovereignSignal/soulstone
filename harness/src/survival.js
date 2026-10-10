import {setTimeout as delay} from 'node:timers/promises'
import {observedSightline} from './visibility.js'
import {roofed} from './observations.js'

// Ordinary food only. Special effects, teleportation and valuable consumables
// need a separate explicit capability rather than automatic hunger management.
// Raw meats use their plain item ids. Raw chicken is excluded: it causes food
// poisoning. Guarded by a registry test so a misspelled id cannot hide here.
export const SAFE_FOODS=new Set(['beef','porkchop','mutton','rabbit','cod','salmon','apple','baked_potato','beetroot','beetroot_soup','bread','carrot','cooked_beef','cooked_chicken','cooked_cod','cooked_mutton','cooked_porkchop','cooked_rabbit','cooked_salmon','cookie','dried_kelp','melon_slice','mushroom_stew','potato','pumpkin_pie','rabbit_stew','sweet_berries','glow_berries'])
const hostile=new Set(['zombie','zombie_villager','husk','drowned','skeleton','stray','bogged','wither_skeleton','creeper','spider','cave_spider','witch','slime','magma_cube','phantom','pillager','vindicator','evoker','vex','ravager','silverfish','endermite','blaze','ghast','hoglin','zoglin','piglin_brute','warden','breeze','creaking','guardian','elder_guardian','shulker','wither','ender_dragon'])
const conditional=new Set(['enderman','piglin','zombified_piglin','wolf','bee','polar_bear','iron_golem'])
export const isPotentialHostile=name=>hostile.has(name)
// Mobs that attack from a distance. A pillager opens fire at about sixteen
// blocks, so a ten-block interruption radius let it shoot the bot for six
// blocks of approach without any response; one killed the agent that way.
// Blazes and ghasts shoot from well past 24 blocks (run 70: health fell from
// 20 to 7 under blaze fire with nothing on the threat list).
const FAR_SHOOTERS=new Set(['blaze','ghast'])
export const RANGED=new Set(['skeleton','stray','bogged','wither_skeleton','pillager','witch','ghast','blaze','illusioner','breeze','drowned'])
export const threatRadius=name=>name==='creeper'||RANGED.has(name)?16:10
// What is never a judgement call: a hostile in arm's reach, a creeper in fuse range.
export const CLOSE_FLOORS={melee:6,creeper:10}
// Rock does not stop these: a warden's boom and a vex pass through it, the rest break it.
const WALL_BREACHING=new Set(['warden','vex','wither','ender_dragon','ghast'])
// A hostile the tick found sealed off from the bot's own space, with the ray to
// it blocked as well, cannot path, see or shoot in. Distance through stone is
// not danger, so only these floors still count for it: a melee mob within
// three (one or two blocks of rock the bot's own digging could open), a
// creeper within fuse-and-blast range. The melee floor was six, and lab run 27
// (3 October, y 50, cave country) spent its night re-sheltering from
// skeletons and cave spiders at five and six blocks, every one sealed.
// A creeper lights its fuse only near a target it can see, so one sealed
// behind rock never fuses: test run 47 (4 October) held the bot walled in at
// y 29 over a cave of four creepers 5 to 7 blocks below, all sealed and out of
// sight, under the old floor of 10. Four keeps a margin over the fuse range.
export const ROCK_FLOORS={melee:3,creeper:4}
export const breachesRock=t=>WALL_BREACHING.has(t.name)||t.distance<=(t.name==='creeper'?ROCK_FLOORS.creeper:ROCK_FLOORS.melee)
export const sealedOff=t=>t.reach==='sealed'&&t.sightline?.status==='blocked'&&!breachesRock(t)
// Out of sight with only a long way round: a hostile that cannot see the bot
// counts by the length of its open route, not the straight line through rock.
// ROUTE_FACTOR allows for the flood's square steps against a mob's diagonal walk.
export const ROUTE_FACTOR=1.5
export const farRoute=t=>t.reach==='open'&&t.sightline?.status==='blocked'&&Number.isFinite(t.routeSteps)&&t.routeSteps>threatRadius(t.name)*ROUTE_FACTOR&&!breachesRock(t)
// The one test of "this hostile cannot get at the bot yet", for the alarm, the
// shelter's clearance and the door guard alike.
export const outOfReach=t=>sealedOff(t)||farRoute(t)
// Run 86 (10 October): a blaze four blocks below behind nether bricks kept the bot
// walling in and opening up at the fortress portal: the alarm counted it, the bow
// had no shot. A mob that only shoots cannot hurt the bot without a line of sight,
// so until it has one, or is within four blocks, it raises no alarm; the moment it
// can see the bot, the bow can see it. Melee mobs (wither skeletons, drowned) count
// through walls as before. One test for the alarms and the shelter's clearance alike.
export const SHOOTERS_ONLY=new Set([...RANGED].filter(n=>!['wither_skeleton','drowned'].includes(n)))
export const cannotShootYet=t=>SHOOTERS_ONLY.has(t?.name)&&t.sightline?.status==='blocked'&&t.distance>4
export const THREAT_INTERRUPTION='A potential hostile is within ten blocks'
export const NIGHT_EXPOSURE='Night with no shelter'
export const HEALTH_EMERGENCY='Health is at or below half'
// The line that sends a hurt bot to cover, and that it must be above to leave it.
export const HEALTH_EMERGENCY_LINE=10
// How far the health alarm looks for a hostile; the tick judges reach out to here.
export const HEALTH_THREAT_RADIUS=16
// How recently health must have dropped to count as still under attack. One
// survival tick is about a second, so this is a few ticks of grace.
export const DAMAGE_WINDOW_MS=4000
export const FOOD_EMERGENCY='Food is critically low'
const ANIMALS=new Set(['cow','pig','sheep','chicken','rabbit','mooshroom','goat'])
// Ten blocks buys the three to four seconds a burrow needs; a creeper covers six in two.
export const WATER_EMERGENCY='Underwater or running low on air'
export const WATER_BLOCKS=new Set(['water','kelp','kelp_plant','seagrass','tall_seagrass','bubble_column'])
// Lava leaves a player burning for seconds after it steps out, at about one
// health a second, and only water ends it early. Shelters answer mobs and do
// nothing for fire: trial 21 burned to death walling in beside a lava pool.
export const FIRE_EMERGENCY='Burning or standing in lava'
const FIRE_BLOCKS=new Set(['fire','soul_fire'])
// Bit 0 of the entity's shared flags is "on fire". Null until the server has
// sent flags: no metadata is not evidence of not burning.
export function fireObservation(bot){
 const e=bot?.entity,flags=e?.metadata?.[0]
 const onFire=typeof flags==='number'?(flags&1)===1:null
 const p=e?.position,cells=p?.offset&&bot.blockAt?[bot.blockAt(p.floored()),bot.blockAt(p.offset(0,1.6,0).floored())]:[]
 return {onFire,inLava:e?.isInLava===true||cells.some(b=>b?.name==='lava'),inFire:cells.some(b=>FIRE_BLOCKS.has(b?.name))}
}
// A survival player standing in a nether portal is carried through after four
// seconds. Sov's limit is never to enter the Nether, so this outranks everything.
export const PORTAL_EMERGENCY='Standing in a portal'
export const PORTAL_BLOCKS=['nether_portal','end_portal','end_gateway']
export function portalObservation(bot){
 const p=bot?.entity?.position
 if(!p?.offset||!bot.blockAt)return {inPortal:null}
 return {inPortal:[p.floored(),p.offset(0,1.6,0).floored()].some(c=>PORTAL_BLOCKS.includes(bot.blockAt(c)?.name))}
}
// Daylight on the open surface: the only time a spider is calm. Shared by the
// threat list and the spider hunt, so the two can never disagree.
export function calmDaylight(bot){
 const tod=bot?.time?.timeOfDay,p=bot?.entity?.position
 return Number.isFinite(tod)&&tod>=1000&&tod<12500&&!(p&&roofed(bot))
}
export function survivalObservation(bot) {
 const p=bot?.entity?.position
 const head=p?.offset&&bot.blockAt?bot.blockAt(p.offset(0,1.6,0).floored()):null
 const headSubmerged=head?WATER_BLOCKS.has(head.name)||head.getProperties?.().waterlogged===true:null
 // Surface spiders are neutral in daylight; treating them as hostile sends the bot underground for nothing.
 // Under rock there is no daylight to calm them: two spiders killed the bot at
 // y -16 at 2986 ticks while the clock called them neutral (lab run 58).
 const daylight=calmDaylight(bot)
 // An enderman screams while it hunts a player (its `creepy` flag): from then on it
 // is a threat. As a calm `conditional` mob, a provoked one on pi3's fresh world
 // (9 October) set off nothing until the bot was at half health, two seconds from dead.
 const creepy=bot?.registry?.entitiesByName?.enderman?.metadataKeys?.indexOf('creepy')??-1
 const screaming=e=>e.name==='enderman'&&creepy>=0&&e.metadata?.[creepy]===true
 const nearbyThreats=p?Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&e.position&&(hostile.has(e.name)||conditional.has(e.name))).map(e=>({name:e.name,distance:Math.round(e.position.distanceTo(p)*10)/10,position:{x:e.position.x,y:e.position.y,z:e.position.z},risk:!screaming(e)&&(conditional.has(e.name)||e.name==='spider'&&daylight)?'conditional':'potential_hostile'})).filter(e=>e.distance<=(FAR_SHOOTERS.has(e.name)?48:24)).sort((a,b)=>a.distance-b.distance).slice(0,16):[]
 for(const t of nearbyThreats){t.verticalOffset=Math.round((t.position.y-p.y)*10)/10;t.sightline=observedSightline(bot,{x:p.x,y:p.y+(bot.entity.eyeHeight||1.62),z:p.z},{x:t.position.x,y:t.position.y+1,z:t.position.z})}
 // Farm animals within 32 blocks, so the planner hunts what is actually there.
 const nearbyAnimals=p?Object.values(bot.entities||{}).filter(e=>e!==bot.entity&&e.position&&ANIMALS.has(e.name)).map(e=>({name:e.name,distance:Math.round(e.position.distanceTo(p)*10)/10})).filter(e=>e.distance<=32).sort((a,b)=>a.distance-b.distance).slice(0,12):[]
 return {...fireObservation(bot),...portalObservation(bot),oxygen:Number.isFinite(bot?.oxygenLevel)?bot.oxygenLevel:null,nearbyAnimals,headSubmerged,inWater:bot?.entity?.isInWater??null,food:Number.isFinite(bot?.food)?bot.food:null,saturation:Number.isFinite(bot?.foodSaturation)?bot.foodSaturation:null,health:Number.isFinite(bot?.health)?bot.health:null,gameMode:bot?.game?.gameMode??null,difficulty:bot?.game?.difficulty??null,dimension:String(bot?.game?.dimension||'').replace(/^minecraft:/,'')||null,timeOfDay:bot?.time?.timeOfDay??null,carriedFood:(bot?.inventory?.items()||[]).filter(i=>SAFE_FOODS.has(i.name)).map(i=>({name:i.name,count:i.count})),nearbyThreats,threatCoverage:'Loaded entities within 24 blocks only; proximity does not establish aggression or line of sight'}
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

// Blazes and ghasts open fire from across a fortress, far past the alarm's
// radius. One in clear sight while the bot is actually being hurt is what is
// hurting it (lab run 89: the idle bot burned out fire after fire from blazes
// 20 to 30 blocks off, and the alarm only woke at half health).
export function underFire(observation){
 return Number.isFinite(observation.recentDamageMs)&&observation.recentDamageMs<=DAMAGE_WINDOW_MS&&
  (observation.nearbyThreats||[]).some(t=>t.risk==='potential_hostile'&&FAR_SHOOTERS.has(t.name)&&t.sightline?.status==='clear')
}
export function emergencyReason(observation){
 if(observation.gameMode!=='survival'||!Number.isFinite(observation.health)||observation.health<=0)return null
 if(observation.inPortal===true)return PORTAL_EMERGENCY
 const peaceful=!observation.difficulty||observation.difficulty==='peaceful'
 const shotAt=!peaceful&&observation.sheltered!==true&&underFire(observation)
 // Burning under blaze fire, standing still to burn out only waits for the next
 // fireball. Fight or take cover while health allows; lava always comes first.
 if(observation.inLava===true||observation.inFire===true)return FIRE_EMERGENCY
 // In the Nether no water survives, so burning goes out the same whatever the bot
 // does; standing still to wait for it only waits for the next fireball (lab run
 // 96 died that way at half health). There the other alarms decide.
 const unquenchable=observation.dimension==='the_nether'
 if(observation.onFire===true&&!unquenchable)return shotAt&&observation.health>HEALTH_EMERGENCY_LINE?THREAT_INTERRUPTION:FIRE_EMERGENCY
 if(observation.headSubmerged===true||observation.headSubmerged!==false&&Number.isFinite(observation.oxygen)&&observation.oxygen<=15)return WATER_EMERGENCY
 // An emergency is something safety can act on. Low health matters when a
 // hostile is near or a base exists to retreat to; low food matters when there
 // is food to eat. Otherwise the planner keeps working and forages itself.
 // Judged by reach like the threat alarm and the shelter's clearance: a hostile
 // sealed behind rock or snow kept a hurt bot walling in and opening up every
 // 22 seconds on pi1's fresh world (9 October), never planning.
 const hostileNear=!!observation.difficulty&&observation.difficulty!=='peaceful'&&((observation.nearbyThreats||[]).some(t=>t.risk==='potential_hostile'&&t.distance<=HEALTH_THREAT_RADIUS&&!outOfReach(t)&&!cannotShootYet(t))||underFire(observation))
 // Low health is an emergency only when something can be done about it: a threat
 // to escape, or nightfall with a lit base to reach that the bot is not already
 // sitting in. Hunger under eighteen stops natural regeneration, so a hurt bot
 // with no food must be free to go and find some in daylight; interrupting it
 // every time it steps outside its own base traps it there at five health.
 const darkness=Number.isFinite(observation.timeOfDay)&&(observation.timeOfDay>=12500||observation.timeOfDay<500)
 // Health actually falling is the honest signal that something can be done,
 // and it needs no mob taxonomy. Enderman and piglin are `conditional`, so a
 // provoked one is invisible to hostileNear and could beat the agent below ten
 // with nothing firing. Reclassifying them would be worse: a passive enderman
 // is genuinely not a threat and the agent would flee every one it sees. This
 // also covers fire, lava and a mob the version added after this was written.
 const underAttack=Number.isFinite(observation.recentDamageMs)&&observation.recentDamageMs<=DAMAGE_WINDOW_MS
 // Hurt with no way to heal in place (nothing carried, hunger under the 18 that
 // regenerates), going in only waits for hostiles to leave, and a mob in a cave
 // beside a player never does: pi2 (10 October) was called back from every food
 // errand at 1 health by a zombie nine blocks below its base. Out under open sky in
 // Overworld daylight, food is the remedy, so a hostile alone is the threat alarm's
 // to answer, within its own radius; damage, night and the Nether keep this alarm.
 const foraging=observation.openSky===true&&observation.dimension==='overworld'&&!(observation.carriedFood||[]).length&&
  Number.isFinite(observation.food)&&observation.food<18&&Number.isFinite(observation.timeOfDay)&&observation.timeOfDay>=1000&&observation.timeOfDay<12000
 if(observation.health<=HEALTH_EMERGENCY_LINE&&observation.sheltered!==true&&(hostileNear&&!foraging||underAttack||observation.shelterAvailable===true&&darkness))return HEALTH_EMERGENCY
 if(Number.isFinite(observation.food)&&observation.food<=6&&(observation.carriedFood||[]).length)return FOOD_EMERGENCY
 // Inside a verified closed lit shelter the answer to a nearby hostile is already
 // in place; interrupting there only retreats into the room the bot is standing in.
 if(observation.sheltered!==true&&observation.difficulty&&observation.difficulty!=='peaceful'&&observation.nearbyThreats.some(t=>t.risk==='potential_hostile'&&t.distance<=threatRadius(t.name)&&!outOfReach(t)&&!cannotShootYet(t))||shotAt)return THREAT_INTERRUPTION
 // Out in the open after dusk with no built base: dig in before the crowd arrives.
 // Under rock there is no crowd arriving: trial 42 spent fifteen minutes of a
 // thirty-minute run waiting for a sunrise thirty-six blocks above it.
 if(observation.roofed!==true&&observation.shelterAvailable===false&&observation.difficulty&&observation.difficulty!=='peaceful'&&Number.isFinite(observation.timeOfDay)&&(observation.timeOfDay>=12500||observation.timeOfDay<500))return NIGHT_EXPOSURE
 return null
}
