import test from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {eatFood,survivalObservation} from '../src/survival.js'
import {validateTaskGoal} from '../src/task-store.js'
import {validatePlan} from '../src/companion/planner.js'
import {interruptedEffect} from '../src/companion/continuity.js'
import {parseBuildingBlock,validateBuildingBlock,placeBuildingBlock} from '../src/building-blocks.js'
import {setPlacementSneaking} from '../src/placement.js'
import {compileArchitecture,reviewArchitecture} from '../src/construction.js'
function fixture(){
 let count=3;const bot={food:14,game:{gameMode:'survival'},inventory:{items:()=>count?[{name:'bread',count}]:[]},equip:async()=>{},consume:async()=>{count--;bot.food=Math.min(20,bot.food+5)},deactivateItem(){}}
 return {bot,task:{goal:{item:'bread',count:3}},api:{check(){},stage(){},progress(){},persist(){}}}
}
test('eating caps at full hunger with both hunger and inventory receipts',async()=>{
 const {bot,task,api}=fixture();const result=await eatFood(bot,task,api)
 assert.equal(result.count,2);assert.equal(bot.inventory.items()[0].count,1);assert.equal(bot.food,20);assert.equal(task.consumption.uncertain,false)
 assert.equal((await eatFood(bot,{goal:task.goal},api)).receipt,'hunger_already_full')
})
test('eating rejects unsafe foods and survives task/planner validation',()=>{
 const step={action:'eat',item:'bread',count:1,name:'',design:[]}
 assert.equal(validatePlan({reply:'Eating bread.',steps:[step]}).steps[0].action,'eat')
 assert.deepEqual(validateTaskGoal('eat',step),{item:'bread',count:1})
 for(const item of ['rotten_flesh','pufferfish','chorus_fruit','golden_apple','suspicious_stew'])assert.throws(()=>validateTaskGoal('eat',{item,count:1}),/safe food/)
})
test('interrupted eating remains uncertain and releases item use without retries',async()=>{
 const {bot,task,api}=fixture();let released=false,calls=0
 bot.deactivateItem=()=>released=true;bot.consume=async()=>{calls++;throw new Error('disconnected')}
 await assert.rejects(eatFood(bot,task,api),/disconnected/)
 assert.equal(calls,1);assert.equal(released,true);assert.match(interruptedEffect(task),/eating/)
})
test('eating does not accept hunger increase without consumed inventory',async()=>{
 const {bot,task,api}=fixture();bot.consume=async()=>{bot.food=20}
 await assert.rejects(eatFood(bot,task,api),/not confirmed/)
 assert.equal(task.consumption.uncertain,true)
})
test('survival observations distinguish unknown state and bounded conditional threats',()=>{
 assert.equal(survivalObservation(null).food,null)
 const bot={entity:{position:new Vec3(0,64,0)},entities:{1:{name:'creeper',position:new Vec3(3,64,0)},2:{name:'wolf',position:new Vec3(2,64,0)},3:{name:'zombie',position:new Vec3(30,64,0)}},inventory:{items:()=>[{name:'bread',count:2},{name:'rotten_flesh',count:3}]}}
 const o=survivalObservation(bot);assert.deepEqual(o.nearbyThreats.map(e=>e.name),['wolf','creeper']);assert.equal(o.nearbyThreats[0].risk,'conditional');assert.deepEqual(o.carriedFood,[{name:'bread',count:2}])
})
test('torch cannot act as a structural floor in architecture review',()=>{
 const r=(x,y,z,block)=>({x,y,z,x2:x,y2:y,z2:z,block})
 const blueprint=compileArchitecture([r(0,0,0,'stone'),r(1,0,0,'torch'),r(0,1,0,'checkpoint'),r(1,1,0,'checkpoint')])
 assert.deepEqual(reviewArchitecture(blueprint).unreachable,[new Vec3(1,1,0)])
 assert.deepEqual(parseBuildingBlock('torch'),{block:'torch'})
 assert.throws(()=>parseBuildingBlock('torch[facing=north]'),/no configurable/)
 assert.throws(()=>validateBuildingBlock({blocksByName:{},itemsByName:{}},{block:'torch'},()=>false),/Unsupported/)
})
test('torch placement uses top face with sneak and restores controls on failure',async()=>{
 const controls=[],p=new Vec3(0,1,0),bot={blockAt:p=>({name:p.y===1?'air':'barrel'}),world:{getBlock:()=>({shapes:[[0,0,0,1,1,1]]})},inventory:{items:()=>[{name:'torch',count:1}]},equip:async()=>{},setControlState:(k,v)=>controls.push([k,v]),waitForTicks:async()=>{},placeBlock:async(_,face)=>{assert.deepEqual(face,new Vec3(0,1,0));throw new Error('placement failed')}}
 await assert.rejects(placeBuildingBlock(bot,p,{block:'torch'},{check(){},stage(){},approach:async()=>({ref:p.offset(0,-1,0)})}),/placement failed/)
 assert.deepEqual(controls,[['sneak',true],['sneak',false]])
})

test('transitional sneak protocol sends both inputs and legacy actions only where needed',()=>{
 for(const [input,mapped,expected] of [[true,false,2],[true,true,0],[false,false,0]]){
  const packets=[],controls=[],bot={entity:{id:42},setControlState:(k,v)=>controls.push(v),supportFeature:n=>n==='newPlayerInputPacket'?input:mapped,_client:{write:(name,p)=>packets.push({name,...p})}}
  setPlacementSneaking(bot,true);setPlacementSneaking(bot,false)
  assert.deepEqual(controls,[true,false]);assert.equal(packets.length,expected)
  if(expected)assert.deepEqual(packets.map(p=>p.actionId),[0,1])
 }
})

import {Runner} from '../src/runner.js'
test('runner dispatches eat to its own durable skill, not give',()=>{
 const calls=[],runner={closed:false,emit(){},skill:(...args)=>calls.push(args)}
 Runner.prototype.command.call(runner,{action:'eat',goal:{item:'bread',count:1},timeoutMs:10000})
 assert.deepEqual(calls,[['eat',{item:'bread',count:1},10000]])
})

test('resumed eating retains its original portion cap and refuses uncertain replay',async()=>{
 const {bot,task,api}=fixture();task.goal.count=1
 await eatFood(bot,task,api);assert.equal(bot.food,19)
 const resumed=await eatFood(bot,task,api);assert.equal(resumed.count,1);assert.equal(bot.inventory.items()[0].count,2)
 task.consumption.uncertain=true
 await assert.rejects(eatFood(bot,task,api),/Previous consumption is uncertain/)
})

test('the observation lists farm animals within 32 blocks for the planner to hunt',()=>{
 const bot={entity:{position:new Vec3(0,64,0)},entities:{1:{name:'cow',position:new Vec3(10,64,0)},2:{name:'pig',position:new Vec3(40,64,0)},3:{name:'zombie',position:new Vec3(5,64,0)},4:{name:'chicken',position:new Vec3(0,64,-3)}},inventory:{items:()=>[]},game:{gameMode:'survival',difficulty:'normal'},time:{timeOfDay:1000},health:20,food:20}
 const o=survivalObservation(bot)
 assert.deepEqual(o.nearbyAnimals,[{name:'chicken',distance:3},{name:'cow',distance:10}])
})

test('low health plus incoming damage is an emergency even when nothing is classified hostile',async()=>{
 const {emergencyReason,HEALTH_EMERGENCY}=await import('../src/survival.js')
 // An enderman and a piglin are `conditional`, so hostileNear is false and a
 // provoked one can beat the agent below ten health with nothing firing. The
 // fix is not to reclassify them: a passive enderman is genuinely not a threat,
 // and reclassifying would make the agent flee every one it sees. Falling
 // health is the honest signal, and it covers fire and lava too.
 const base={gameMode:'survival',health:8,food:18,difficulty:'easy',timeOfDay:6000,sheltered:false,
  shelterAvailable:false,headSubmerged:false,oxygen:20,carriedFood:[],
  nearbyThreats:[{name:'enderman',distance:3,risk:'conditional'}]}
 assert.equal(emergencyReason(base),null,'stable low health next to a neutral mob is not an emergency')
 assert.equal(emergencyReason({...base,recentDamageMs:800}),HEALTH_EMERGENCY,'the same agent actually being hurt is')
 assert.equal(emergencyReason({...base,recentDamageMs:30000}),null,'damage long past is not')
})

test('falling health does not override the guard that keeps a hurt agent free to forage',async()=>{
 const {emergencyReason}=await import('../src/survival.js')
 // The existing comment is load-bearing: interrupting every time a hurt agent
 // steps outside its base traps it there at five health with no food. Only
 // health at or below ten qualifies, and only while it is actually dropping.
 const hurt={gameMode:'survival',health:14,food:4,difficulty:'easy',timeOfDay:6000,sheltered:false,
  shelterAvailable:false,headSubmerged:false,oxygen:20,carriedFood:[],nearbyThreats:[]}
 assert.equal(emergencyReason({...hurt,recentDamageMs:500}),null,'above the floor, damage alone does not interrupt foraging')
 assert.equal(emergencyReason({...hurt,health:8,sheltered:true,recentDamageMs:500}),null,'already sheltered, it is not an interruption')
})

// Fresh-world test on pi3, 9 October: a provoked enderman took the bot from 13
// to 6 to dead in two seconds; as a `conditional` mob it set off nothing until
// health fell to half. An enderman screams while it hunts a player (its
// `creepy` flag), and that is the moment it is a threat, not the first hit.
test('an enderman that is screaming for the bot is a potential hostile; a calm one stays conditional',async()=>{
 const registry=(await import('minecraft-data')).default('1.21.4')
 const creepy=registry.entitiesByName.enderman.metadataKeys.indexOf('creepy')
 const enderman=angry=>({name:'enderman',position:new Vec3(4,64,0),metadata:Object.assign([],{[creepy]:angry})})
 const bot=angry=>({registry,entity:{position:new Vec3(0,64,0)},entities:{1:enderman(angry)},inventory:{items:()=>[]}})
 assert.equal(survivalObservation(bot(false)).nearbyThreats[0].risk,'conditional')
 assert.equal(survivalObservation(bot(true)).nearbyThreats[0].risk,'potential_hostile')
})
// Live rehearsal, 17 October 01:17Z (Nether, Hard): in full iron and no gold, the bot bored on past a piglin standing
// in its own tunnel; it went from 12.6 to 4.9 in one hit and died 1.6 s later, while the health alarm logged
// "counted":[] and nether_shelter nearestMelee 12.9. An adult piglin attacks any player wearing no golden armour.
test('an adult piglin is a potential hostile unless the bot wears a piece of golden armour; a baby piglin never is',async()=>{
 const {emergencyReason,THREAT_INTERRUPTION}=await import('../src/survival.js')
 const registry=(await import('minecraft-data')).default('1.21.4')
 const babyKey=registry.entitiesByName.piglin.metadataKeys.indexOf('baby')
 const piglin=baby=>({name:'piglin',position:new Vec3(3,64,0),metadata:baby===undefined?undefined:Object.assign([],{[babyKey]:baby})})
 const bot=({worn=['iron_helmet','iron_chestplate','iron_leggings','iron_boots'],baby}={})=>{
  const slots=[];worn.forEach((n,i)=>{if(n)slots[5+i]={name:n}})
  return {registry,entity:{position:new Vec3(0,64,0)},entities:{1:piglin(baby)},inventory:{items:()=>[],slots},getEquipmentDestSlot:s=>({head:5,torso:6,legs:7,feet:8})[s]}
 }
 const seen=opts=>survivalObservation(bot(opts)).nearbyThreats[0]
 const alarm=t=>emergencyReason({gameMode:'survival',health:20,food:20,difficulty:'hard',dimension:'the_nether',timeOfDay:6000,sheltered:false,headSubmerged:false,oxygen:20,carriedFood:[],nearbyThreats:[{...t,sightline:{status:'clear'}}]})
 const iron=seen();assert.equal(iron.distance,3);assert.equal(iron.risk,'potential_hostile','full iron, no gold');assert.equal(alarm(iron),THREAT_INTERRUPTION)
 assert.equal(seen({baby:false}).risk,'potential_hostile','an adult by its flag')
 const helmet=seen({worn:['golden_helmet','iron_chestplate','iron_leggings','iron_boots']});assert.equal(helmet.risk,'conditional','a golden helmet');assert.equal(alarm(helmet),null)
 assert.equal(seen({worn:['iron_helmet','iron_chestplate','iron_leggings','golden_boots']}).risk,'conditional','golden boots')
 assert.equal(seen({worn:[]}).risk,'potential_hostile','nothing worn')
 assert.equal(seen({baby:true}).risk,'conditional','a baby piglin never attacks')
 // Gold in the pack is not gold worn.
 const packed=bot();packed.inventory.items=()=>[{name:'golden_helmet',count:1}];packed.inventory.slots[20]={name:'golden_helmet'}
 assert.equal(survivalObservation(packed).nearbyThreats[0].risk,'potential_hostile')
})

test('a blaze hitting the bot from across the fortress raises the threat alarm',async()=>{
 const {emergencyReason,THREAT_INTERRUPTION,FIRE_EMERGENCY,HEALTH_EMERGENCY}=await import('../src/survival.js')
 // Lab run 89 (10 October): two blazes 20 to 30 blocks off set the idle bot
 // alight again and again. The alarm looked 16 blocks out, so the only answer
 // was to stand and burn out (water boils away in the Nether) until health
 // reached half; it then walked to the portal under fire and died on the way.
 const blaze=(distance,status='clear')=>({name:'blaze',distance,risk:'potential_hostile',sightline:{status}})
 const base={gameMode:'survival',health:16,food:20,difficulty:'normal',dimension:'the_nether',timeOfDay:6000,sheltered:false,
  shelterAvailable:false,headSubmerged:false,oxygen:20,carriedFood:[],nearbyThreats:[blaze(28)]}
 assert.equal(emergencyReason(base),null,'a blaze in view that is not shooting does not stop work')
 assert.equal(emergencyReason({...base,recentDamageMs:600}),THREAT_INTERRUPTION,'one hitting the bot does')
 assert.equal(emergencyReason({...base,recentDamageMs:600,onFire:true}),THREAT_INTERRUPTION,'its fire is answered by fighting or cover, not by standing to burn out')
 assert.equal(emergencyReason({...base,recentDamageMs:600,nearbyThreats:[blaze(28,'blocked')]}),null,'behind bricks it cannot be what is hitting the bot')
 assert.equal(emergencyReason({...base,recentDamageMs:600,sheltered:true}),null,'walled in, the answer is already in place')
 assert.equal(emergencyReason({...base,recentDamageMs:600,onFire:true,inLava:true}),FIRE_EMERGENCY,'lava comes first')
 assert.equal(emergencyReason({...base,recentDamageMs:600,onFire:true,health:8}),HEALTH_EMERGENCY,'at half health in the Nether, getting out comes first: no water can put it out (run 96)')
 assert.equal(emergencyReason({...base,dimension:'overworld',recentDamageMs:600,onFire:true,health:8}),FIRE_EMERGENCY,'in the Overworld, putting the fire out still comes first')
 assert.equal(emergencyReason({...base,recentDamageMs:600,health:8}),HEALTH_EMERGENCY,'and the health alarm counts the blaze as a hostile near')
 assert.equal(emergencyReason({...base,recentDamageMs:600,nearbyThreats:[{...blaze(28),name:'skeleton'}]}),null,'a skeleton does not shoot from 28 blocks: something else is hurting the bot')
})

test('in the Nether, burning out of lava and fire is no emergency of its own',async()=>{
 const {emergencyReason,FIRE_EMERGENCY,HEALTH_EMERGENCY,THREAT_INTERRUPTION}=await import('../src/survival.js')
 // Lab run 96 (10 October): at half health a blaze's fireball cut the bot's
 // second shot short, the fire recovery stood still to burn out (water boils
 // away in the Nether), and the next fireball killed it five seconds later.
 // Burning there goes out the same whatever the bot does; what it can still
 // change is where it is, so the health and threat alarms decide.
 const blaze={name:'blaze',distance:12,risk:'potential_hostile',sightline:{status:'clear'}}
 const base={gameMode:'survival',health:8,food:20,difficulty:'normal',dimension:'the_nether',timeOfDay:6000,sheltered:false,
  shelterAvailable:false,headSubmerged:false,oxygen:20,carriedFood:[],nearbyThreats:[blaze],onFire:true,recentDamageMs:500}
 assert.equal(emergencyReason(base),HEALTH_EMERGENCY,'hurt and under fire: get out, not stand and burn')
 assert.equal(emergencyReason({...base,health:16}),THREAT_INTERRUPTION)
 assert.equal(emergencyReason({...base,nearbyThreats:[],recentDamageMs:null,health:16}),null,'merely burning, there is nothing to do')
 assert.equal(emergencyReason({...base,inLava:true}),FIRE_EMERGENCY,'lava still comes first')
 assert.equal(emergencyReason({...base,inFire:true}),FIRE_EMERGENCY,'and so does standing in fire')
 assert.equal(emergencyReason({...base,dimension:'overworld'}),FIRE_EMERGENCY,'in the Overworld water can still put it out')
})

// pi2, 10 October 20:33Z, on the food floor's first errand: at 1 health, hunger 10
// and nothing carried, the health alarm called the bot back inside for a zombie in
// the cave nine blocks below the base (10.5 away, out of sight, reach unknown). In
// the base nothing raises health or hunger without food, so going in only waits for
// mobs that never leave a cave beside a player: a deadlock, the dawn hunts' too.
// Hurt with no way to heal in place, under open sky in Overworld daylight, the
// health alarm leaves hostiles to the threat alarm, which still answers any one
// inside its own radius; damage taken, night and the Nether keep the health alarm.
test('hurt with no way to heal in place, out in Overworld daylight, the health alarm leaves hostiles to the threat alarm',async()=>{
 const {emergencyReason,HEALTH_EMERGENCY,THREAT_INTERRUPTION}=await import('../src/survival.js')
 const zombie={name:'zombie',distance:10.5,verticalOffset:-9,risk:'potential_hostile',reach:'unknown',sightline:{status:'blocked'}}
 const base={gameMode:'survival',health:1,food:10,difficulty:'normal',dimension:'overworld',timeOfDay:6750,sheltered:false,shelterAvailable:true,
  headSubmerged:false,oxygen:20,carriedFood:[],openSky:true,nearbyThreats:[zombie]}
 assert.equal(emergencyReason(base),null,'the zombie below is outside the threat alarm\'s ten blocks')
 assert.equal(emergencyReason({...base,nearbyThreats:[{...zombie,distance:8}]}),THREAT_INTERRUPTION,'closer, the threat alarm answers it')
 assert.equal(emergencyReason({...base,recentDamageMs:500}),HEALTH_EMERGENCY,'being hurt still sends it in')
 assert.equal(emergencyReason({...base,carriedFood:[{name:'bread',count:2}]}),HEALTH_EMERGENCY,'with food in the bag it can heal in shelter')
 assert.equal(emergencyReason({...base,food:18}),HEALTH_EMERGENCY,'at hunger 18 it heals by waiting')
 assert.equal(emergencyReason({...base,timeOfDay:12100}),HEALTH_EMERGENCY,'daylight is ending')
 assert.equal(emergencyReason({...base,dimension:'the_nether'}),HEALTH_EMERGENCY,'no food to find in the Nether')
 assert.equal(emergencyReason({...base,openSky:false}),HEALTH_EMERGENCY,'under rock the food is not here')
})
// Family rehearsal, 16 October: walled in at the back exit's foot, one block of rock over a
// cave of three skeletons, a zombie and two creepers, every one sealed off and out of sight.
// The rock floors kept the zombie at 2.2 and the creepers at 3.7 counting for good. Sealed and
// still is the shelter's test: nothing in the shelter digs, and a sealed creeper never fuses.
import {sealedStill} from '../src/survival.js'
test('a hostile sealed off and out of sight is still at any distance, unless rock does not stop it',()=>{
 const t=(name,distance,reach='sealed',status='blocked')=>({risk:'potential_hostile',name,distance,reach,sightline:{status}})
 assert.equal(sealedStill(t('zombie',2.2)),true,'the zombie through one block of stone')
 assert.equal(sealedStill(t('creeper',3.7)),true,'the creepers inside the fuse floor')
 for(const name of ['warden','vex','ghast','enderman'])assert.equal(sealedStill(t(name,6)),false,name)
 assert.equal(sealedStill(t('zombie',2.2,'open')),false,'a route counts');assert.equal(sealedStill(t('zombie',2.2,'unknown')),false,'an inconclusive flood proves nothing')
 assert.equal(sealedStill(t('zombie',2.2,'sealed','clear')),false,'in sight counts');assert.equal(sealedStill({...t('zombie',2.2),sightline:undefined}),false,'no sightline evidence counts')
})
