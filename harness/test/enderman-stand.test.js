import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Vec3} from 'vec3'
import minecraftData from 'minecraft-data'
import {enderStand,validateStandGoal,STAND} from '../src/enderman-stand.js'
import {defenseDecision,fightableAlone} from '../src/combat.js'
import {attackEntity,validateAttackGoal} from '../src/primitives-world.js'
import {validatePlan} from '../src/companion/planner.js'
import {validateTaskGoal} from '../src/task-store.js'
import {guardIntent} from '../src/companion/intent.js'
import {SKILL_ACTIONS} from '../src/companion/skill-control.js'
import {Teammate} from '../src/companion/controller.js'
import {THREAT_INTERRUPTION} from '../src/survival.js'

// Dragon roadmap stage 2, brief 1: ender pearls from endermen, fought from a 2-high hut
// on a kitted Nether trip. An enderman is 2.9 tall and cannot follow into the hut.
const registry=minecraftData('1.21.4')
const CREEPY=registry.entitiesByName.enderman.metadataKeys.indexOf('creepy')
const key=p=>`${p.x},${p.y},${p.z}`

// A netherrack floor at y 63 and the bot at 0.5,64,0.5 in the Nether kit. An enderman the
// bot looks in the eye screams and, a few ticks later, stands at its `arrive` point outside
// the hut; struck `hits` times it dies and drops a pearl unless `drops` is false. An item
// within 1.4 blocks of the bot is picked up, as the server does.
function fixture({dimension='the_nether',kit=true,health=20,endermen=[{at:[10.5,64,.5],arrive:[2.5,64,.5]}],hits=3,drops=true}={}){
 const bot=new EventEmitter(),cells=new Map(),log={placed:[],dug:[],swings:0,provoked:[],steps:[]}
 const inv=[{name:'netherrack',count:64},...(kit?[{name:'bow',count:1,maxDurability:384,durabilityUsed:0},{name:'arrow',count:64},{name:'iron_sword',count:1,maxDurability:250,durabilityUsed:0}]:[])]
 const slots=[];for(const [i,n] of [[5,'iron_helmet'],[6,'iron_chestplate'],[7,'iron_leggings'],[8,'golden_boots']])slots[i]={name:n}
 let nextId=20
 const add=e=>{e.id=nextId++;e.uuid=`10000000-0000-0000-0000-0000000000${e.id}`;bot.entities[e.id]=e;bot.emit('entitySpawn',e);return e}
 const enderman=({at,arrive})=>add({name:'enderman',type:'hostile',height:2.9,width:.6,position:new Vec3(...at),arrive:arrive&&new Vec3(...arrive),metadata:[]})
 const gain=(name,count)=>{const s=inv.find(i=>i.name===name);if(s)s.count+=count;else inv.push({name,count})}
 const pickUp=()=>{for(const e of Object.values(bot.entities))if(e.name==='item'&&Math.hypot(e.position.x-bot.entity.position.x,e.position.z-bot.entity.position.z)<=1.4){const s=e.getDroppedItem();gain(s.name,s.count);delete bot.entities[e.id];bot.emit('entityGone',e)}}
 Object.assign(bot,{registry,game:{dimension:'minecraft:'+dimension,gameMode:'survival',difficulty:'normal'},health,food:20,players:{},entities:{},time:{timeOfDay:6000},
  entity:{position:new Vec3(.5,64,.5),onGround:true,height:1.8,eyeHeight:1.62},
  inventory:{items:()=>inv.filter(i=>i.count>0).map(i=>({...i,type:registry.itemsByName[i.name].id})),slots},getEquipmentDestSlot:s=>({head:5,torso:6,legs:7,feet:8})[s],
  blockAt(p){const c=p.floored(),name=cells.get(key(c))??(c.y<64?'netherrack':'air');return {name,position:c,boundingBox:registry.blocksByName[name]?.boundingBox}},
  async equip(item){bot.heldItem=item},
  // The server refuses a block inside a mob, as inside a player.
  async placeBlock(ref,face){const p=ref.position.plus(face)
   if(Object.values(bot.entities).some(e=>e.name!=='item'&&Math.abs(e.position.x-(p.x+.5))<.8&&Math.abs(e.position.z-(p.z+.5))<.8&&e.position.y<p.y+1&&e.position.y+(e.height||1.8)>p.y))throw new Error('Block placement rejected: entity in the way')
   log.placed.push(key(p));cells.set(key(p),'netherrack');inv[0].count--},
  async dig(block){log.dug.push(key(block.position));cells.set(key(block.position),'air')},
  tool:{async equipForBlock(){}},setControlState(){},clearControlStates(){},activateItem(){},deactivateItem(){},
  // Endermen aggro on eye contact: a look at the head of a calm one provokes it.
  async lookAt(p){for(const e of Object.values(bot.entities))if(e.name==='enderman'&&!e.metadata[CREEPY]&&p.distanceTo(e.position.offset(0,2.55,0))<.4){e.metadata[CREEPY]=true;log.provoked.push(e.id);if(e.arrive)setTimeout(()=>{e.position=e.arrive.clone()},20)}},
  attack(t){log.swings++;t.hits=(t.hits||0)+1;log.onSwing?.(t);if(t.hits>=hits){delete bot.entities[t.id];bot.emit('entityDead',t)
   if(drops)add({name:'item',type:'object',position:t.position.clone(),getDroppedItem:()=>({name:'ender_pearl',count:1})})}},
  pathfinder:{movements:null,setMovements(m){this.movements=m},setGoal(){},async goto(g){log.steps.push(key(g));if(log.stuck?.has(key(g)))return;bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5);pickUp()}}})
 for(const e of endermen)enderman(e)
 const timer=setInterval(pickUp,5)
 const api={check(){},stage(){},progress(){},persist(){},movements:null}
 return {bot,cells,inv,log,api,add,enderman,stop:()=>clearInterval(timer)}
}
const fast={provokeMs:400,settleMs:60,poll:5,cooldownMs:5,crowdPollMs:20,limitMs:4000,healMs:50,closeWaitMs:100,closeTries:2}
const stand=async(f,count=1,options=fast)=>{try{return await enderStand(f.bot,{kind:'stand',goal:validateStandGoal({item:'ender_pearl',count})},f.api,options)}finally{f.stop()}}
const pearls=f=>f.inv.find(i=>i.name==='ender_pearl')?.count||0

test('the stand refuses outside the Nether, off a kitted trip, and with no enderman within 24 blocks',async()=>{
 await assert.rejects(stand(fixture({dimension:'overworld'})),/Nether only/)
 await assert.rejects(stand(fixture({kit:false})),/Not on a kitted trip: a bow/)
 await assert.rejects(stand(fixture({health:11})),/Not on a kitted trip: health 11/)
 // The fight rule's own floor for an enderman is 16, above the trip's 12.
 await assert.rejects(stand(fixture({health:15})),/Health is too low to engage a enderman/)
 const far=fixture({endermen:[{at:[30.5,64,.5]}]})
 await assert.rejects(stand(far),/No enderman within 24 blocks/);assert.equal(far.log.placed.length,0,'nothing built for nobody')
})

test('an enderman provoked through the port is struck there, its pearl counted from the inventory, and the port closed',async()=>{
 const f=fixture()
 const r=await stand(f)
 assert.equal(r.receipt,'stand');assert.equal(r.kills,1);assert.equal(r.pearls,1);assert.equal(r.count,1);assert.equal(r.item,'ender_pearl')
 assert.equal(r.ports,1);assert.equal(r.partial,false);assert.equal(pearls(f),1)
 assert.equal(f.log.swings,3);assert.deepEqual(f.log.provoked,[20],'looked the one enderman in the eye')
 // The port faced it (+x), opened both cells, and the pearl was one step out: in and back.
 assert.deepEqual(f.log.dug.sort(),['1,64,0','1,65,0']);assert.deepEqual(f.log.steps,['1,64,0','0,64,0'])
 for(const c of ['1,64,0','1,65,0'])assert.equal(f.cells.get(c),'netherrack','port closed after the kill')
 assert.equal(f.bot.heldItem.name,'netherrack')
})

test('a second enderman near the port closes it, and the stand opens again once it is gone',async()=>{
 const f=fixture({endermen:[{at:[10.5,64,.5],arrive:[2.5,64,.5]}]})
 let second=null,closedWithTwo=false
 f.log.onSwing=t=>{if(t.hits===1&&!second){second=f.enderman({at:[3.5,64,3.5]});setTimeout(()=>{delete f.bot.entities[second.id]},120)}}
 const place=f.bot.placeBlock;f.bot.placeBlock=async(ref,face)=>{await place(ref,face);if(second&&f.bot.entities[second.id])closedWithTwo=['1,64,0','1,65,0'].every(c=>f.cells.get(c)==='netherrack')}
 const r=await stand(f)
 assert.ok(closedWithTwo,'port shut while the second stood by')
 assert.equal(r.crowds,1);assert.equal(r.ports,2);assert.equal(r.kills,1);assert.equal(r.pearls,1)
})

test('kills without a pearl fail with the reason, never a success',async()=>{
 const f=fixture({drops:false,endermen:[{at:[10.5,64,.5],arrive:[2.5,64,.5]},{at:[-10.5,64,.5],arrive:[-1.5,64,.5]}]})
 await assert.rejects(stand(f,2),/No ender pearl gained: 2 endermen killed, 2 ports opened; no enderman left within 24 blocks/)
 const shy=fixture({endermen:[{at:[10.5,64,.5]}]})
 await assert.rejects(stand(shy),/No ender pearl gained: 0 endermen killed, 1 port opened/)
})

test('the stand stops at the trip health floor and reports what it has',async()=>{
 const f=fixture({hits:4})
 f.log.onSwing=t=>{if(t.hits===2)f.bot.health=11}
 await assert.rejects(stand(f),/No ender pearl gained: 0 endermen killed, 1 port opened; health 11 is under 12/)
 for(const c of ['1,64,0','1,65,0'])assert.equal(f.cells.get(c),'netherrack','port closed on the way out')
})

test('the planner, the task store, intent and skill control admit stand for 1 to 8 pearls',()=>{
 const step={action:'stand',name:'',item:'ender_pearl',count:4,design:[],target:null}
 const plan=validatePlan({reply:'Pearls',steps:[step]});assert.equal(plan.steps[0].action,'stand')
 assert.throws(()=>validatePlan({reply:'',steps:[{...step,count:9}]}),/stand/)
 assert.throws(()=>validatePlan({reply:'',steps:[{...step,count:0}]}),/stand/)
 // Blaze rods have their own stand (blaze-stand.js); any other item is refused.
 assert.throws(()=>validatePlan({reply:'',steps:[{...step,item:'diamond'}]}),/stand/)
 assert.deepEqual(validateTaskGoal('stand',{item:'ender_pearl',count:4}),{item:'ender_pearl',count:4})
 assert.throws(()=>validateTaskGoal('stand',{item:'ender_pearl',count:9}),/1 to 8/)
 assert.deepEqual(guardIntent(plan,'take a stand and bring 4 pearls home'),plan)
 assert.ok(SKILL_ACTIONS.has('stand'))
 assert.ok(STAND.limitMs<=600000)
})

// The fight rule takes on a provoked enderman alone, as it does a wither skeleton: 40
// health, hits for 7, so only nearly unhurt and in the Nether kit.
test('a lone screaming enderman is fought at 16 health or more in the Nether kit; a calm one is no fight',()=>{
 const f=fixture();f.stop()
 const e=Object.values(f.bot.entities)[0];e.position=new Vec3(3.5,64,.5);e.metadata[CREEPY]=true
 const d=defenseDecision(f.bot);assert.equal(d.engage,true,d.reason);assert.equal(d.target.targetName,'enderman')
 f.bot.health=15;assert.match(defenseDecision(f.bot).reason,/Health is too low to engage a enderman/);f.bot.health=20
 f.bot.inventory.slots[6]=null;assert.match(defenseDecision(f.bot).reason,/enderman needs iron armour/)
 assert.equal(fightableAlone(f.bot,'enderman'),false);f.bot.inventory.slots[6]={name:'iron_chestplate'}
 assert.equal(fightableAlone(f.bot,'enderman'),true)
 e.metadata[CREEPY]=false;assert.equal(defenseDecision(f.bot).engage,false,'a calm enderman is not a threat')
})

// An enderman teleports up to 32 blocks; a provoked one comes back at the bot.
test('attack re-acquires an enderman that teleports away within 24 blocks of the bot; other mobs keep the 8-block search',async()=>{
 const fightBot=entities=>{const bot=new EventEmitter();Object.assign(bot,{entity:{position:new Vec3(.5,64,.5),eyeHeight:1.62},entities,health:20,food:20,registry,
  inventory:{items:()=>[{name:'iron_sword',count:1,type:registry.itemsByName.iron_sword.id,maxDurability:250,durabilityUsed:0}]},
  pathfinder:{goal:null,setMovements(){},setGoal(g){this.goal=g;if(g?.entity)bot.entity.position=g.entity.position.offset(1,0,0)}},
  equip:async()=>{},lookAt:async()=>{},clearControlStates(){},attack(t){bot.swings=(bot.swings||0)+1;bot.hit?.(t)}});return bot}
 const mob=(id,name,x)=>({id,name,type:'hostile',position:new Vec3(x,64,.5),height:2.9})
 const bot=fightBot({11:mob(11,'enderman',5.5)})
 bot.hit=()=>{if(bot.swings===1){delete bot.entities[11];bot.entities[12]=mob(12,'enderman',-12.5)}
  if(bot.swings===3){const e=bot.entities[12];delete bot.entities[12];bot.emit('entityDead',e)}}
 const r=await attackEntity(bot,{kind:'attack',goal:validateAttackGoal({type:'enderman'})},{check(){},stage(){},progress(){}})
 assert.equal(r.receipt,'target_death_observed');assert.equal(r.reacquired,1)
 const z=fightBot({11:mob(11,'zombie',5.5)})
 z.hit=()=>{delete z.entities[11];z.entities[12]=mob(12,'zombie',-12.5)}
 await assert.rejects(attackEntity(z,{kind:'attack',goal:validateAttackGoal({type:'zombie'})},{check(){},stage(){},progress(){}}),/Lost the zombie.*none within 8 blocks/)
})

// The stand provokes endermen on purpose: a screaming one at its port is the work, not an
// alarm. Anything else hostile still is, and so is an enderman during any other task.
test('a provoked enderman at the port does not interrupt a stand; it still interrupts other work, and a hoglin interrupts the stand',async()=>{
 const tick=async({kind='stand',mob='enderman'}={})=>{
  const f=fixture();f.stop()
  const e=Object.values(f.bot.entities)[0];e.name=mob;e.position=new Vec3(2.5,64,.5);e.metadata[CREEPY]=true
  f.bot.world={raycast:()=>null};f.bot.findBlocks=()=>[];f.bot.findBlock=()=>null;f.bot.entity.metadata={0:0}
  const r=Object.assign(new EventEmitter(),{profile:'stand',owner:'Player',ready:true,connectionId:'one',bot:f.bot,commands:[],position:()=>({x:0,y:64,z:0}),log(){},
   command(c){this.commands.push(c);this.task={id:String(this.commands.length),kind:c.action,status:'running',goal:c.goal}}})
  const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-stand-')),'state.json'))
  r.task={id:'s',kind,status:'running',goal:{item:'ender_pearl',count:1}}
  r.emit('event',{type:'survival_tick'});await new Promise(res=>setTimeout(res,20))
  const reason=c.safety?.reason;c.cancel?.(true);return reason
 }
 assert.equal(await tick(),undefined,'the stand carries on')
 assert.equal(await tick({kind:'goto'}),THREAT_INTERRUPTION)
 assert.equal(await tick({mob:'hoglin'}),THREAT_INTERRUPTION)
})

// Review of 3aa7808: a mob in the port's cell refuses the close, and a failed close must not
// lose the pearls already in the inventory.
test('a close waits for the port to clear; one that never clears is reported, and the pearls are still the receipt',async()=>{
 const run=async leaves=>{
  const f=fixture({endermen:[{at:[10.5,64,.5],arrive:[1.8,64,.5]}]})
  let blocker=null
  f.log.onSwing=t=>{if(t.hits===3){blocker=f.enderman({at:[1.5,64,.5]});if(leaves)setTimeout(()=>{delete f.bot.entities[blocker.id]},60)}}
  try{return {f,r:await enderStand(f.bot,{kind:'stand',goal:{item:'ender_pearl',count:2}},f.api,{...fast,limitMs:600})}}finally{f.stop()}
 }
 const cleared=await run(true)
 assert.equal(cleared.r.pearls,1);assert.equal(cleared.r.closed,true)
 for(const c of ['1,64,0','1,65,0'])assert.equal(cleared.f.cells.get(c),'netherrack')
 const stuck=await run(false)
 assert.equal(stuck.r.pearls,1,'the pearl is kept');assert.equal(stuck.r.closed,false);assert.match(stuck.r.stopped,/could not close the port: an enderman stands in it/)
})

test('the pearl step waits for safety, and a step back that fails walls in where the bot stands',async()=>{
 const risky=fixture()
 risky.log.onSwing=t=>{if(t.hits===3)risky.add({name:'hoglin',type:'hostile',height:1.4,position:new Vec3(.5,64,8.5),metadata:[]})}
 await assert.rejects(stand(risky),/No ender pearl gained: 1 enderman killed.*left behind: 1 ender_pearl at 2,64,0 \(not stepping out: a hoglin 8 blocks off\)/)
 assert.deepEqual(risky.log.steps,[],'never left the hut')
 const hurt=fixture();hurt.log.onSwing=t=>{if(t.hits===3)hurt.bot.health=15}
 await assert.rejects(stand(hurt),/not stepping out: health 15 is under 16/)
 const strays=fixture();strays.log.stuck=new Set(['0,64,0'])
 const r=await stand(strays,2)
 assert.equal(r.pearls,1);assert.match(r.stopped,/Not back in the hut after the pearl: at 1,64,0; walled in where I stand/)
 assert.deepEqual(strays.log.steps,['1,64,0','0,64,0','0,64,0'],'one step out, two tries back')
 for(const c of ['2,64,0','2,65,0','1,66,0'])assert.equal(strays.cells.get(c),'netherrack','a hut round the port cell')
})

test('hurt under 16 in a duel, the port closes and the bot heals before going on',async()=>{
 const f=fixture({hits:4})
 let closedHurt=false
 f.log.onSwing=t=>{if(t.hits===2){f.bot.health=14;setTimeout(()=>{f.bot.health=20},80)}}
 const place=f.bot.placeBlock;f.bot.placeBlock=async(ref,face)=>{await place(ref,face);if(f.bot.health===14&&['1,64,0','1,65,0'].every(c=>f.cells.get(c)==='netherrack'))closedHurt=true}
 const r=await stand(f,1,{...fast,healMs:500})
 assert.ok(closedHurt,'port shut at 14 health');assert.equal(r.ports,2);assert.equal(r.kills,1);assert.equal(r.pearls,1)
})

test('an enderman above eye level still gets a two-high port, so its pearl can be stepped for',async()=>{
 const f=fixture({endermen:[{at:[10.5,67,.5],arrive:[2.5,64,.5]}]})
 const r=await stand(f);assert.equal(r.pearls,1)
 assert.deepEqual(f.log.dug.sort(),['1,64,0','1,65,0'])
})

// Review of 3aa7808: now that the fight tables name the enderman, a lone provoked one in
// Overworld daylight must not send the bot on a 24-block sprint: it teleports after anyone.
test('a lone screaming enderman in daylight is no reason to sprint to open ground; a lone zombie still is',async()=>{
 const run=name=>{
  const f=fixture({dimension:'overworld'});f.stop()
  const e=Object.values(f.bot.entities)[0];e.name=name;e.position=new Vec3(8.5,64,.5);e.metadata[CREEPY]=true
  const commands=[]
  const c={safety:{},epoch:1,runner:{ready:true,bot:f.bot,connectionId:'one'},say(){},persist(){},
   async execute(cmd){commands.push(cmd.action);throw new Error('stop here')}}
  return Teammate.prototype.leaveOnOpenGround.call(c,1,new AbortController().signal,f.bot,false).then(r=>({r,commands}))
 }
 const ender=await run('enderman');assert.equal(ender.r,'skipped');assert.deepEqual(ender.commands,[])
 const zombie=await run('zombie');assert.deepEqual(zombie.commands,['flee'])
})

// Re-review of the blaze stand: a pearl stand cancelled with its port open left it open, and nothing recorded it. The port's
// cells go on the task before the dig and come off when it closes, so the controller walls in before the next command.
test('a pearl stand cancelled with its port open leaves the port on the task, and the controller walls in before the next command',async()=>{
 const f=fixture();let cancelled=false
 f.api.check=()=>{if(cancelled)throw new Error('skill interrupted')}
 f.api.progress=()=>f.api.check()
 f.log.onSwing=()=>{cancelled=true}
 const task={kind:'stand',goal:validateStandGoal({item:'ender_pearl',count:1})}
 await assert.rejects(enderStand(f.bot,task,f.api,fast).finally(f.stop),/skill interrupted/)
 assert.deepEqual(task.portOpen,[{x:1,y:65,z:0},{x:1,y:64,z:0}]);assert.equal(f.cells.get('1,65,0'),'air','left open')
 const r=Object.assign(new EventEmitter(),{profile:'stand',owner:'Player',ready:true,connectionId:'one',bot:f.bot,commands:[],position:()=>({x:0,y:64,z:0}),log(){},waitForIdle:async()=>{}})
 r.command=c=>{r.commands.push(c);if(c.action==='stop')return;const t=r.task={id:String(r.commands.length),kind:c.action,status:'running',goal:c.goal};setTimeout(()=>{if(c.action==='hut')for(const k of ['1,64,0','1,65,0'])f.cells.set(k,'netherrack');t.status='completed';t.result={receipt:c.action};r.emit('event',{type:'task_finished',task:t})},1)}
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-stand-port-')),'state.json'))
 r.emit('event',{type:'task_finished',task:{...structuredClone(task),id:'s',status:'cancelled'}})
 await c.executeCommand({action:'goto',goal:{x:0,y:64,z:0},timeoutMs:60000},new AbortController().signal);c.cancel?.(true)
 assert.deepEqual(r.commands.map(x=>x.action).filter(x=>x!=='stop'),['hut','goto'])
})
