import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import registry from 'prismarine-registry'
import {Vec3} from 'vec3'
import {defenseDecision,defendAgainstMob,clearStrike} from '../src/combat.js'
import {validateTaskGoal} from '../src/task-store.js'
import {Runner} from '../src/runner.js'
import {Teammate} from '../src/companion/controller.js'
import {THREAT_INTERRUPTION} from '../src/survival.js'

const uuid='10000000-0000-0000-0000-000000000001',connection='20000000-0000-0000-0000-000000000002'
function fixture(){
 const bot=new EventEmitter(),target={id:7,uuid,...registry('1.21.4').entitiesByName.husk,position:new Vec3(2,64,0)}
 target.id=7
 const weapon={name:'iron_axe',count:1,maxDurability:250,durabilityUsed:0,slot:36},items=[weapon]
 Object.assign(bot,{registry:registry('1.21.4'),health:20,food:20,game:{gameMode:'survival',difficulty:'easy'},entity:{id:1,type:'player',position:new Vec3(0,64,0),onGround:true},entities:{7:target},players:{},inventory:{items:()=>items,slots:[]},world:{raycast:()=>null,getColumn:()=>({})},blockAt:p=>({name:p.y<64?'stone':'air'}),equip:async i=>{bot.heldItem=i},getEquipmentDestSlot:()=>45,activateItem:()=>{},deactivateItem:()=>{},clearControlStates:()=>{},lookAt:async()=>{},pathfinder:{setGoal:()=>{},setMovements:()=>{}},attack:()=>{}})
 const task={kind:'defend',goal:{targetId:7,targetUuid:uuid,targetName:'husk',connectionId:connection},deadline:Date.now()+30000}
 const context={check(){},stage(){},progress(){},persist(){}}
 return {bot,target,weapon,items,task,context}
}
test('defense engages a lone melee mob and rejects weak readiness, extra threats and obstructed sight',()=>{
 const f=fixture();assert.equal(defenseDecision(f.bot).engage,true)
 f.bot.health=11;assert.equal(defenseDecision(f.bot).engage,false);f.bot.health=13;assert.equal(defenseDecision(f.bot).engage,true);f.bot.health=20
 f.bot.food=9;assert.equal(defenseDecision(f.bot).engage,false);f.bot.food=20
 f.bot.entities[8]={id:8,uuid:connection,name:'creeper',position:new Vec3(7,64,0)};assert.equal(defenseDecision(f.bot).engage,false);delete f.bot.entities[8]
 f.bot.world.raycast=()=>({name:'stone'});assert.equal(defenseDecision(f.bot).engage,true)
 f.bot.world.raycast=()=>null;f.bot.blockAt=()=>null;assert.equal(clearStrike(f.bot,f.target),false)
})
test('players and neutral mobs are never valid targets; sword sweeping excludes bystanders',()=>{
 const f=fixture();f.target.type='player';assert.equal(defenseDecision(f.bot).engage,false);f.target.type='hostile'
 f.target.name='wolf';assert.equal(defenseDecision(f.bot).engage,false);f.target.name='husk'
 f.weapon.name='iron_sword';assert.equal(defenseDecision(f.bot).engage,true)
 f.bot.entities[8]={id:8,type:'player',position:new Vec3(1,64,1)};assert.equal(defenseDecision(f.bot).engage,false)
 f.bot.entities[8]={id:8,name:'cow',type:'animal',position:new Vec3(1,64,1)};assert.equal(defenseDecision(f.bot).engage,false)
 f.weapon.name='iron_axe';assert.equal(defenseDecision(f.bot).engage,true)
 assert.throws(()=>validateTaskGoal('defend',{...f.task.goal,targetName:'player'}),/observed mob/)
})
test('combat respects weapon cadence and confirms server death with cleanup',async()=>{
 const f=fixture(),times=[],controls=[];f.weapon.name='iron_sword'
 f.bot.deactivateItem=()=>controls.push('release');f.bot.clearControlStates=()=>controls.push('clear')
 f.bot.attack=e=>{times.push(Date.now());f.bot.emit('entityHurt',e);if(times.length===2)f.bot.emit('entityDead',e)}
 const r=await defendAgainstMob(f.bot,f.task,f.context)
 assert.equal(r.receipt,'target_death_observed');assert.equal(r.attacks,2);assert.equal(r.hurtEvents,2)
 assert.ok(times[1]-times[0]>=700);assert.equal(f.bot.listenerCount('entityDead'),0);assert.ok(controls.includes('clear'));assert.ok(controls.includes('release'))
})
test('Stop during native equip prevents attacks and releases controls',async()=>{
 const f=fixture();let cancelled=false,release,attacks=0,cleared=false
 f.context.check=()=>{if(cancelled)throw new Error('Stopped')};f.bot.equip=()=>new Promise(r=>release=r)
 f.bot.attack=()=>attacks++;f.bot.clearControlStates=()=>cleared=true
 const pending=defendAgainstMob(f.bot,f.task,f.context);cancelled=true;release()
 await assert.rejects(pending,/Stopped/);assert.equal(attacks,0);assert.equal(cleared,true)
})
test('shield use is released when Stop interrupts defense',async()=>{
 const f=fixture();f.items.push({name:'shield',count:1,maxDurability:336,slot:37});let blocked=false,cancelled=false,attacks=0
 f.bot.equip=async(i,d)=>{if(d==='hand')f.bot.heldItem=i;else f.bot.inventory.slots[45]=i}
 f.bot.activateItem=off=>{assert.equal(off,true);blocked=true;cancelled=true}
 f.bot.deactivateItem=()=>blocked=false;f.bot.attack=()=>attacks++
 f.context.check=()=>{if(cancelled)throw new Error('Stopped')}
 await assert.rejects(defendAgainstMob(f.bot,f.task,f.context),/Stopped/)
 assert.equal(attacks,0);assert.equal(blocked,false);assert.equal(f.task.combat.shield,true)
})
test('target disappearance and ID reuse are not reported as kills',async()=>{
 for(const reuse of [false,true]){
  const f=fixture();let attacks=0
  f.bot.lookAt=async()=>{if(reuse)f.bot.entities[7]={...f.target,uuid:connection};else delete f.bot.entities[7]}
  f.bot.attack=()=>attacks++
  await assert.rejects(defendAgainstMob(f.bot,f.task,f.context),/disappeared|identity changed/)
  assert.equal(attacks,0);assert.equal(f.task.combat.deathObserved,false)
 }
})
test('falling health or an arriving threat prevents the next attack',async()=>{
 for(const threat of [false,true]){
  const f=fixture();let attacks=0
  f.bot.lookAt=async()=>{if(threat)f.bot.entities[8]={id:8,name:'creeper',position:new Vec3(3,64,0)};else f.bot.health=10}
  f.bot.attack=()=>attacks++
  await assert.rejects(defendAgainstMob(f.bot,f.task,f.context),/retreat/);assert.equal(attacks,0)
 }
})
test('reconnected Runner refuses an old combat goal before dispatch',()=>{
 let result;const runner={ready:true,task:{kind:'defend',status:'running',goal:{connectionId:connection},deadline:Date.now()+10000},connectionId:uuid,finish:(status,reason)=>result={status,reason},runSkill:()=>assert.fail('Old combat replayed')}
 Runner.prototype.applyGoal.call(runner);assert.equal(result.status,'failed');assert.match(result.reason,/connection changed/)
})
function controllerFixture(){
 const f=fixture(),runner=new EventEmitter()
 Object.assign(runner,{bot:f.bot,ready:true,profile:'combat-test',owner:'Sov',connectionId:connection,position:()=>f.bot.entity.position,commands:[],waitForIdle:async()=>{}})
 runner.command=cmd=>{runner.commands.push(cmd);runner.emit('operator_command',cmd);if(cmd.action==='follow')runner.task={id:'follow',kind:'follow',status:'running',goal:{player:cmd.player}}}
 const c=new Teammate(runner,{model:'none',plan:()=>assert.fail('No model call during defense')},join(mkdtempSync(join(tmpdir(),'mc-combat-')),'teammate.json'))
 c.execute=async cmd=>{runner.commands.push(cmd);assert.equal(cmd.action,'defend');delete f.bot.entities[7];runner.task={result:{receipt:'target_death_observed',attacks:2}}}
 return {...f,runner,c}
}
test('supervisor chooses fighting, retains request and automatically continues after clearance',async()=>{
 const f=controllerFixture();f.c.requestProgress={id:'original',request:'gather',status:'running',feedback:[]};let resumed=0
 f.c.resume=async options=>{assert.equal(options.automatic,true);resumed++}
 await f.c.seekSafety(THREAT_INTERRUPTION)
 assert.equal(f.runner.commands.filter(c=>c.action==='defend').length,1);assert.equal(f.runner.commands.some(c=>c.action==='retreat'),false)
 assert.equal(f.c.requestProgress.id,'original');assert.equal(f.c.requestProgress.feedback[0].action,'defend');assert.equal(resumed,1);assert.equal(f.c.requestProgress.combatContinuations.length,1)
})
test('self-defense resumes following and Stop prevents a pending combat handoff',async()=>{
 const f=controllerFixture();f.runner.task={kind:'follow',status:'running',goal:{player:'Sov'}}
 await f.c.seekSafety(THREAT_INTERRUPTION);assert.equal(f.runner.commands.at(-1).action,'follow');assert.equal(f.c.safety,null)
 const g=controllerFixture();let release;g.runner.waitForIdle=()=>new Promise(r=>release=r)
 const pending=g.c.seekSafety(THREAT_INTERRUPTION);g.c.stop();release();await pending
 assert.equal(g.runner.commands.some(c=>c.action==='defend'),false);assert.equal(g.c.safety.status,'cancelled')
})
test('Stop while defending prevents retreat and resumption',async()=>{
 const f=controllerFixture();let release
 f.c.execute=()=>new Promise(r=>release=r)
 const pending=f.c.seekSafety(THREAT_INTERRUPTION);await new Promise(r=>setImmediate(r))
 assert.equal(f.c.phase,'defending');f.c.stop();release();await pending
 assert.equal(f.c.safety.status,'cancelled');assert.equal(f.runner.commands.some(c=>c.action==='retreat'||c.action==='follow'),false)
})

test('an armed bot engages from ten blocks, rushes skeletons only with a health margin, and counts a wooden axe',()=>{
 const f=fixture();f.target.position=new Vec3(9,64,0);assert.equal(defenseDecision(f.bot).engage,true)
 f.target.position=new Vec3(11,64,0);assert.equal(defenseDecision(f.bot).engage,false);f.target.position=new Vec3(2,64,0)
 Object.assign(f.target,f.bot.registry.entitiesByName.skeleton,{id:7,uuid});f.bot.health=15;assert.match(defenseDecision(f.bot).reason,/skeleton/)
 f.bot.health=16;assert.equal(defenseDecision(f.bot).engage,true)
 f.weapon.name='wooden_axe';f.weapon.maxDurability=59;assert.equal(defenseDecision(f.bot).weapon,'wooden_axe')
 f.weapon.name='stick';assert.match(defenseDecision(f.bot).reason,/weapon/)
})

test('a mob that drifts from the opening position keeps the fight, and a dropped follow goal is re-issued',async()=>{
 const f=fixture();f.weapon.name='iron_sword'
 f.bot.blockAt=()=>({name:'air',boundingBox:'empty'})
 f.bot.entity.position=new Vec3(0,64,0);f.target.position=new Vec3(9,64,0)
 let goal=null,issued=0
 f.bot.pathfinder={setGoal(g){goal=g;if(g)issued++},setMovements(){},get goal(){return goal}}
 f.bot.lookAt=async()=>{};f.bot.equip=async()=>{};f.bot.attack=()=>{};f.bot.activateItem=()=>{};f.bot.deactivateItem=()=>{}
 f.bot.getEquipmentDestSlot=()=>45;f.bot.heldItem=f.weapon;f.bot.clearControlStates=()=>{}
 // The target drifts to thirteen blocks from the opening anchor while staying four from the bot.
 setTimeout(()=>{f.bot.entity.position=new Vec3(9,64,0);f.target.position=new Vec3(13,64,0);goal=null},60)
 setTimeout(()=>{f.target.position=new Vec3(10.5,64,0)},200)
 setTimeout(()=>f.bot.emit('entityDead',f.target),1100)
 const result=await defendAgainstMob(f.bot,f.task,f.context)
 assert.equal(result.receipt,'target_death_observed');assert.ok(result.attacks>=1,'landed a hit after the drift')
 assert.ok(issued>=2,`follow goal re-issued after being dropped (issued ${issued})`)
})
import {corneredDecision,cornerWeapon,CORNER_HEALTH} from '../src/combat.js'
test('cornered, the nearest mob in reach is fought whatever the count, down to two hearts, with a pickaxe if that is all there is',()=>{
 // Test world, 3 October 19:44Z: two zombies at 2 and 3.8 blocks, every
 // shelter refused, and the bot died without one swing.
 const f=fixture();const second={...f.target,id:8,uuid:'10000000-0000-0000-0000-000000000003',position:new Vec3(0,64,3)};f.bot.entities[8]=second
 assert.equal(defenseDecision(f.bot).engage,false,'the normal rule still refuses two mobs')
 const d=corneredDecision(f.bot);assert.equal(d.engage,true);assert.equal(d.target.targetId,7,'the nearer one');assert.equal(d.weapon,'iron_axe')
 f.bot.health=5;assert.equal(corneredDecision(f.bot).engage,true,'below the normal floors');f.bot.health=CORNER_HEALTH;assert.equal(corneredDecision(f.bot).engage,false);f.bot.health=20
 f.items.length=0;f.items.push({name:'diamond_pickaxe',count:1,maxDurability:1561,durabilityUsed:0,slot:36})
 assert.equal(cornerWeapon(f.bot,f.target).name,'diamond_pickaxe');assert.equal(corneredDecision(f.bot).weapon,'diamond_pickaxe')
 f.target.position=new Vec3(6,64,0);second.position=new Vec3(0,64,6);assert.equal(corneredDecision(f.bot).engage,false,'nothing within four blocks is not cornered')
})

import {armorPoints,groupFightable,GROUP_ARMOR} from '../src/combat.js'
test('in full iron the bot fights up to three zombies, husks or spiders, nearest first; skeletons, creepers and crowds still send it to shelter',()=>{
 // Test world, 4 October 19:09Z: two zombies followed the bot while it dug a
 // burrow, 18.6 to 4.8 health in ten seconds, then death. It wore full iron
 // and carried an axe, and the one-mob rule never let it swing.
 const f=fixture(),zombie=(id,x)=>({id,uuid:'10000000-0000-0000-0000-00000000000'+id,...registry('1.21.4').entitiesByName.husk,name:'husk',position:new Vec3(x,64,0)})
 f.bot.entities[3]=zombie(3,4)
 assert.equal(defenseDecision(f.bot).engage,false,'two husks, no armour: shelter, as before')
 const slots=[];f.bot.inventory.slots=slots;f.bot.getEquipmentDestSlot=s=>({head:5,torso:6,legs:7,feet:8})[s]
 for(const [i,n] of [[5,'iron_helmet'],[6,'iron_chestplate'],[7,'iron_leggings'],[8,'iron_boots']])slots[i]={name:n}
 assert.equal(armorPoints(f.bot),15);assert.equal(GROUP_ARMOR,15)
 const d=defenseDecision(f.bot);assert.equal(d.engage,true);assert.equal(d.target.targetId,7,'the nearer one first');assert.equal(d.group,2)
 f.bot.entities[4]=zombie(4,5);assert.equal(defenseDecision(f.bot).engage,true,'three');f.bot.entities[5]=zombie(5,6);assert.equal(defenseDecision(f.bot).engage,false,'four is a crowd')
 delete f.bot.entities[5];f.bot.entities[4]={...registry('1.21.4').entitiesByName.skeleton,id:4,uuid:'10000000-0000-0000-0000-000000000004',name:'skeleton',position:new Vec3(5,64,0)}
 assert.equal(defenseDecision(f.bot).engage,false,'a skeleton in the group: shelter')
 slots[6]=null;assert.equal(armorPoints(f.bot),9);assert.equal(groupFightable(f.bot,[{name:'husk'},{name:'husk'}]),false,'without the chestplate, no group fight')
})

// At night the bow's string comes from the spiders that come for the bot. The
// melee fight recorded no place for its kill, so nothing went back for the drop,
// and the pickup took only the items the request named: a bow, never string.
test('a melee self-defense kill reports where the mob died',async()=>{
 const f=fixture();f.bot.attack=e=>{f.bot.emit('entityHurt',e);f.bot.emit('entityDead',e)}
 const r=await defendAgainstMob(f.bot,f.task,f.context)
 assert.deepEqual(r.at,{x:2,y:64,z:0})
})
test('after a melee kill the bot picks up what the request is made from: string and feathers for a bow and arrows',async()=>{
 const f=controllerFixture(),at={x:2,y:64,z:0}
 f.c.requestProgress={id:'bow',request:'Make a bow and 32 arrows',status:'running',feedback:[],completed:[],goal:{criteria:[{kind:'inventory',item:'bow',count:1},{kind:'inventory',item:'arrow',count:32}]}}
 f.c.resume=async()=>{}
 f.c.execute=async cmd=>{f.runner.commands.push(cmd);if(cmd.action==='defend'){delete f.bot.entities[7];f.runner.task={result:{receipt:'target_death_observed',attacks:2,at}}}else f.runner.task={result:{receipt:'collected',item:'',gained:1,items:{string:1}}}}
 await f.c.seekSafety(THREAT_INTERRUPTION)
 const collect=f.runner.commands.find(c=>c.action==='collect')
 assert.ok(collect,f.runner.commands.map(c=>c.action).join(' '))
 assert.deepEqual(collect.goal.at,[at])
 for(const item of ['bow','arrow','string','stick','flint','feather'])assert.ok(collect.goal.items.includes(item),`${item} in ${collect.goal.items}`)
 assert.equal(collect.goal.items.includes('bone'),false,'nothing the request is not made from')
})
