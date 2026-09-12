import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {burrowSite,burrowIn,burrowClearance,unburrow} from '../src/burrow.js'
import {executeSkill} from '../src/skills.js'
import {validateTaskGoal} from '../src/task-store.js'
import {Teammate} from '../src/companion/controller.js'
import {THREAT_INTERRUPTION,NIGHT_EXPOSURE,emergencyReason,survivalObservation} from '../src/survival.js'
const registry=minecraftData('1.21.4')
function world(ground='dirt'){
 const cells=new Map(),inventory=[],placed=[],dug=[],equipped=[]
 const bot={registry,game:{gameMode:'survival',difficulty:'normal'},time:{timeOfDay:15000},health:14,food:18,entities:{},players:{},
  entity:{position:new Vec3(10.5,64,10.5),onGround:true},inventory:{items:()=>inventory},
  blockAt(p){const name=cells.get(p.toString())??(p.y>=64?'air':p.y===63?'grass_block':ground);return {name,position:p.clone(),boundingBox:registry.blocksByName[name]?.boundingBox}},
  pathfinder:{setGoal(){},setMovements(){},async goto(){}},clearControlStates(){},
  async equip(item){equipped.push(item.name)},
  async dig(block){dug.push(block.position.toString());cells.set(block.position.toString(),'air');const drop=block.name==='grass_block'?'dirt':block.name;const slot=inventory.find(i=>i.name===drop);slot?slot.count++:inventory.push({name:drop,count:1});bot.entity.position=block.position.offset(.5,0,.5)},
  async placeBlock(ref,face){const p=ref.position.plus(face);placed.push(p.toString());cells.set(p.toString(),equipped.at(-1));const slot=inventory.find(i=>i.name===equipped.at(-1));if(slot)slot.count--}}
 return {bot,cells,inventory,placed,dug,equipped}
}
const api={check(){},stage(){},progress(){},persist(){},movements:{}}
test('a burrow needs diggable ground, solid walls on every level and a solid floor',()=>{
 assert.equal(world().bot&&burrowSite(world().bot).ok,true)
 const cave=world();cave.cells.set(new Vec3(11,62,10).toString(),'air');assert.match(burrowSite(cave.bot).reason,/wall/)
 const lake=world();lake.cells.set(new Vec3(9,61,10).toString(),'water');assert.match(burrowSite(lake.bot).reason,/Liquid/)
 const hollow=world();hollow.cells.set(new Vec3(10,59,10).toString(),'air');assert.match(burrowSite(hollow.bot).reason,/floor/)
 const rock=world('stone');assert.match(burrowSite(rock.bot).reason,/stone/)
 rock.inventory.push({name:'wooden_pickaxe',count:1});assert.equal(burrowSite(rock.bot).ok,true)
 const airborne=world();airborne.bot.entity.onGround=false;assert.match(burrowSite(airborne.bot).reason,/ground/)
 // The cap level is refilled, so a hillside with one open side there still works; the deeper cells need every wall.
 const slope=world();slope.cells.set(new Vec3(11,63,10).toString(),'air');assert.equal(burrowSite(slope.bot).ok,true)
 const bare=world();for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]])bare.cells.set(new Vec3(10+dx,63,10+dz).toString(),'short_grass');assert.match(burrowSite(bare.bot).reason,/cap/)
})
test('a rejected column steps to a sound neighbouring column before digging',async()=>{
 const w=world();w.cells.set(new Vec3(11,62,10).toString(),'air')
 let walked
 w.bot.pathfinder.goto=async g=>{walked=[g.x,g.y,g.z];w.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}
 const result=await burrowIn(w.bot,{kind:'burrow',goal:{}},api)
 assert.ok(walked,'should have moved');assert.notDeepEqual([walked[0],walked[2]],[10,10]);assert.equal(walked[1],64)
 assert.equal(result.receipt,'burrowed_capped');assert.deepEqual(result.surface,{x:walked[0],y:64,z:walked[2]})
})
test('digging in goes four deep, caps the shaft with dug earth and reports the surface cell',async()=>{
 const w=world()
 const result=await executeSkill(w.bot,{kind:'burrow',goal:{}},api)
 assert.deepEqual(w.dug,[new Vec3(10,63,10).toString(),new Vec3(10,62,10).toString(),new Vec3(10,61,10).toString(),new Vec3(10,60,10).toString()])
 assert.equal(w.bot.entity.position.y,60)
 assert.deepEqual(w.placed,[new Vec3(10,63,10).toString()]);assert.equal(w.cells.get(new Vec3(10,63,10).toString()),'dirt')
 assert.equal(result.receipt,'burrowed_capped');assert.equal(result.shelterName,'burrow');assert.deepEqual(result.surface,{x:10,y:64,z:10})
 assert.equal(w.inventory.find(i=>i.name==='dirt').count,3)
})
test('a hit that knocks the bot off the shaft is answered by stepping back over it',async()=>{
 const w=world();let knocked=false,walked=[]
 const dig=w.bot.dig;w.bot.dig=async block=>{await dig(block);if(!knocked){knocked=true;w.bot.entity.position=new Vec3(11.5,64,10.5)}}
 w.bot.pathfinder.goto=async g=>{walked.push([g.x,g.y,g.z]);w.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}
 const messages=[];const result=await burrowIn(w.bot,{kind:'burrow',goal:{}},{...api,progress:m=>messages.push(m)})
 assert.deepEqual(walked,[[10,63,10]]);assert.equal(result.receipt,'burrowed_capped');assert.equal(w.bot.entity.position.y,60)
 assert.ok(messages.some(m=>/Dug 4\/4/.test(m)),messages.join(' | '))
})
test('each dig waits for the bot to land, since airborne mining is five times slower',async()=>{
 const w=world();const digsWhileAirborne=[]
 const dig=w.bot.dig;w.bot.dig=async block=>{digsWhileAirborne.push(w.bot.entity.onGround===false);await dig(block);w.bot.entity.onGround=false;setTimeout(()=>{w.bot.entity.onGround=true},120)}
 const result=await burrowIn(w.bot,{kind:'burrow',goal:{}},api)
 assert.equal(result.receipt,'burrowed_capped');assert.deepEqual(digsWhileAirborne,[false,false,false,false])
})
test('a gravity block never becomes the cap, so a sand burrow stays open and says so',async()=>{
 const w=world('sand');w.cells.set(new Vec3(10,63,10).toString(),'sand')
 const result=await burrowIn(w.bot,{kind:'burrow',goal:{}},api)
 assert.equal(result.receipt,'burrowed_open');assert.deepEqual(w.placed,[])
})
test('burrow clearance waits for daylight, health and an empty neighbourhood',()=>{
 const w=world();assert.match(burrowClearance(w.bot).reason,/daylight/)
 w.bot.time.timeOfDay=6000;w.bot.health=3;assert.match(burrowClearance(w.bot).reason,/Health/)
 w.bot.health=16;w.bot.entities={1:{name:'zombie',position:new Vec3(14.5,64,10.5)}};assert.match(burrowClearance(w.bot).reason,/hostile/)
 w.bot.entities={1:{name:'zombie',position:new Vec3(40.5,64,10.5)},2:{name:'cow',position:new Vec3(11.5,64,10.5)}};assert.equal(burrowClearance(w.bot).clear,true)
})
test('digging out lets the pathfinder tunnel and pillar back to the recorded surface cell',async()=>{
 const w=world();w.bot.entity.position=new Vec3(10.5,60,10.5);w.inventory.push({name:'dirt',count:2})
 let movements,goal
 w.bot.pathfinder={setMovements(m){movements=m},setGoal(){},async goto(g){goal=g;w.bot.entity.position=new Vec3(10.5,64,10.5)}}
 const result=await executeSkill(w.bot,{kind:'unburrow',goal:validateTaskGoal('unburrow',{surface:{x:10,y:64,z:10}})},api)
 assert.equal(movements.canDig,true);assert.equal(movements.allow1by1towers,true);assert.ok(movements.scafoldingBlocks.includes(registry.blocksByName.dirt.id))
 assert.deepEqual([goal.x,goal.y,goal.z],[10,64,10]);assert.equal(result.receipt,'surfaced')
 assert.throws(()=>validateTaskGoal('unburrow',{}),/finite/)
})
test('with no shelter to retreat to, safety digs in, waits for day, digs out and continues the request',async()=>{
 const w=world();const runner=new EventEmitter();runner.bot=w.bot;runner.ready=true;runner.connectionId='c1';runner.profile='p';runner.owner='Sov'
 const commands=[]
 runner.command=c=>{commands.push(c.action);if(c.action==='stop')return;runner.task={id:String(commands.length),kind:c.action,status:'running'}
  const result=c.action==='burrow'?{receipt:'burrowed_capped',shelterName:'burrow',surface:{x:10,y:64,z:10}}:c.action==='unburrow'?{receipt:'surfaced'}:{}
  setTimeout(()=>{runner.task={...runner.task,status:'completed',result};runner.emit('event',{type:'task_finished',task:runner.task})},1)}
 runner.waitForIdle=async()=>{};runner.position=()=>({x:10,y:64,z:10})
 const said=[];let resumed=0
 const c={runner,projects:{},epoch:1,abort:null,phase:'acting',activity:'',requestProgress:{id:'r1',status:'running',feedback:[],completed:[]},safety:null,burrowWait:{quietMs:20,limitMs:2000},
  say:t=>said.push(t),persist(){},emit(){},cancel(){},interrupt(){this.requestProgress.status='interrupted'},dispatch(cmd){runner.command(cmd)},
  execute:Teammate.prototype.execute,leaveOccupiedShelter:async()=>{},seekSafety:Teammate.prototype.seekSafety,waitInBurrow:Teammate.prototype.waitInBurrow,
  async resume(){resumed++;this.requestProgress.status='running'}}
 const started=c.seekSafety(THREAT_INTERRUPTION)
 await new Promise(r=>setTimeout(r,300));w.bot.time.timeOfDay=6000;w.bot.health=20
 await started
 assert.deepEqual(commands.filter(a=>a!=='stop'),['burrow','unburrow'])
 assert.equal(resumed,1);assert.equal(c.requestProgress.safetyContinuations.length,1);assert.equal(c.safety,null)
 assert.ok(said.some(t=>/digging in/i.test(t)),said.join(' | '))
})

test('a hostile within ten blocks interrupts work, one at eleven does not',()=>{
 const base={gameMode:'survival',health:20,food:20,difficulty:'normal',headSubmerged:false,oxygen:20}
 assert.equal(emergencyReason({...base,nearbyThreats:[{name:'creeper',risk:'potential_hostile',distance:9.5}]}),THREAT_INTERRUPTION)
 assert.equal(emergencyReason({...base,nearbyThreats:[{name:'zombie',risk:'potential_hostile',distance:11}]}),null)
})
test('the burrow nudges itself onto the column centre before the first dig, without the pathfinder',async()=>{
 const w=world();w.bot.entity.position=new Vec3(10.97,64,10.5);let looked=null,pulses=0
 w.bot.lookAt=async p=>{looked=p};w.bot.setControlState=(k,v)=>{if(k==='forward'&&v&&looked){pulses++;const p=w.bot.entity.position,dx=looked.x-p.x,dz=looked.z-p.z,d=Math.hypot(dx,dz)||1;const step=Math.min(.2,d);w.bot.entity.position=new Vec3(p.x+dx/d*step,p.y,p.z+dz/d*step)}}
 w.bot.pathfinder.goto=async()=>{throw new Error('pathfinder must not be used to centre')}
 const result=await burrowIn(w.bot,{kind:'burrow',goal:{}},api)
 assert.ok(pulses>=2,'nudged');assert.ok(Math.abs(w.bot.entity.position.x-10.5)<=.15);assert.equal(result.receipt,'burrowed_capped')
})

test('creepers trigger the interruption at sixteen blocks, other hostiles at ten',()=>{
 const base={gameMode:'survival',health:20,food:20,difficulty:'normal',headSubmerged:false,oxygen:20}
 assert.equal(emergencyReason({...base,nearbyThreats:[{name:'creeper',risk:'potential_hostile',distance:15}]}),THREAT_INTERRUPTION)
 assert.equal(emergencyReason({...base,nearbyThreats:[{name:'zombie',risk:'potential_hostile',distance:15}]}),null)
})
test('when the blast destroyed the dug earth, the burrow takes a cap block from the bottom wall',async()=>{
 const w=world();const dig=w.bot.dig
 w.bot.dig=async block=>{const column=block.position.x===10&&block.position.z===10;await dig(block);if(column){const i=w.inventory.findIndex(x=>x.name==='dirt');if(i>=0)w.inventory.splice(i,1)}}
 const result=await burrowIn(w.bot,{kind:'burrow',goal:{}},api)
 assert.equal(result.receipt,'burrowed_capped')
 assert.ok(w.dug.some(k=>[new Vec3(11,60,10),new Vec3(9,60,10),new Vec3(10,60,11),new Vec3(10,60,9)].map(String).includes(k)),'took a wall block at the bottom level')
})
test('a restart while dug in resumes the burrow wait on spawn',async()=>{
 const {mkdtempSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path')
 const path=join(mkdtempSync(join(tmpdir(),'mc-burrow-')),'state.json')
 writeFileSync(path,JSON.stringify({profile:'p',places:{},messages:[],projects:{},requestProgress:{id:'r',request:'x',status:'interrupted',completed:[],pending:[],feedback:[]},safety:{status:'burrowed',reason:THREAT_INTERRUPTION,retreat:{shelterName:'burrow',surface:{x:1,y:64,z:1},capped:true}}}))
 const runner=new EventEmitter();runner.profile='p';runner.ready=true;runner.owner='Sov';runner.task=null;runner.bot=world().bot;runner.position=()=>({x:1,y:61,z:1})
 const c=new Teammate(runner,{model:'fake',plan:async()=>({reply:'',steps:[]})},path)
 const calls=[];c.waitInBurrow=async(epoch,signal,bot,eligible)=>{calls.push(eligible)}
 runner.emit('event',{type:'spawn'});await new Promise(r=>setImmediate(r))
 assert.deepEqual(calls,[true]);assert.equal(c.restoreBurrow,false)
})

test('a late pathfinder rejection does not fail an exit the bot has already made',async()=>{
 const w=world();w.bot.entity.position=new Vec3(10.5,61,10.5);w.inventory.push({name:'dirt',count:2})
 w.bot.pathfinder={setMovements(){},setGoal(){},async goto(g){w.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+1.5);throw new Error('Took to long to decide path to goal!')}}
 const result=await unburrow(w.bot,{kind:'unburrow',goal:{surface:{x:10,y:64,z:10}}},api)
 assert.equal(result.receipt,'surfaced')
 w.bot.pathfinder.goto=async()=>{throw new Error('Took to long to decide path to goal!')};w.bot.entity.position=new Vec3(10.5,61,10.5)
 await assert.rejects(unburrow(w.bot,{kind:'unburrow',goal:{surface:{x:10,y:64,z:10}}},api),/Did not reach the surface cell.*Took to long/)
})

test('low health is an emergency only near a hostile; low food only with food to eat',()=>{
 const base={gameMode:'survival',difficulty:'normal',headSubmerged:false,oxygen:20,nearbyThreats:[],carriedFood:[]}
 assert.equal(emergencyReason({...base,health:6,food:17}),null)
 assert.equal(emergencyReason({...base,health:6,food:17,nearbyThreats:[{name:'zombie',risk:'potential_hostile',distance:14}]}),'Health is at or below half')
 assert.equal(emergencyReason({...base,health:20,food:4}),null)
 assert.equal(emergencyReason({...base,health:20,food:4,carriedFood:[{name:'bread',count:1}]}),'Food is critically low')
})
test('a restart after a failed burrow exit still resumes the exit on spawn',async()=>{
 const {mkdtempSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path')
 const path=join(mkdtempSync(join(tmpdir(),'mc-burrow-')),'state.json')
 writeFileSync(path,JSON.stringify({profile:'p',places:{},messages:[],projects:{},requestProgress:null,safety:{status:'failed',error:'Took to long to decide path to goal!',reason:THREAT_INTERRUPTION,retreat:{shelterName:'burrow',surface:{x:1,y:64,z:1},capped:true}}}))
 const runner=new EventEmitter();runner.profile='p';runner.ready=true;runner.owner='Sov';runner.task=null;runner.bot=world().bot;runner.position=()=>({x:1,y:61,z:1})
 const c=new Teammate(runner,{model:'fake',plan:async()=>({reply:'',steps:[]})},path)
 const calls=[];c.waitInBurrow=async(epoch,signal,bot,eligible)=>{calls.push(eligible)}
 runner.emit('event',{type:'spawn'});await new Promise(r=>setImmediate(r))
 assert.deepEqual(calls,[false])
 writeFileSync(path,JSON.stringify({profile:'p',places:{},messages:[],projects:{},requestProgress:null,safety:{status:'failed',retreat:{shelterName:'burrow',surface:{x:1,y:64,z:1}},exit:{receipt:'surfaced'}}}))
 const d=new Teammate(runner,{model:'fake',plan:async()=>({reply:'',steps:[]})},path);assert.equal(d.restoreBurrow,false)
})

test('a missed block-update event does not fail a cap that is actually there',async()=>{
 const w=world();const place=w.bot.placeBlock;let attempts=0
 w.bot.placeBlock=async(ref,face)=>{attempts++;await place(ref,face);throw new Error('Event blockUpdate:(10, 63, 10) did not fire within timeout of 5000ms')}
 const result=await burrowIn(w.bot,{kind:'burrow',goal:{}},api)
 assert.equal(result.receipt,'burrowed_capped');assert.equal(attempts,1)
 const v=world();let tries=0;v.bot.placeBlock=async()=>{tries++;throw new Error('rejected')}
 const open=await burrowIn(v.bot,{kind:'burrow',goal:{}},api)
 assert.equal(open.receipt,'burrowed_open');assert.equal(tries,4)
})

test('a spider in daylight is conditional, not a trigger, and does not hold the burrow closed',()=>{
 const w=world();w.bot.time.timeOfDay=6000;w.bot.entities={1:{name:'spider',position:new Vec3(14.5,64,10.5)}}
 const day=survivalObservation(w.bot);assert.equal(day.nearbyThreats[0].risk,'conditional');assert.equal(emergencyReason(day),null)
 w.bot.health=16;assert.equal(burrowClearance(w.bot).clear,true)
 w.bot.time.timeOfDay=15000;const night=survivalObservation(w.bot);assert.equal(night.nearbyThreats[0].risk,'potential_hostile');assert.equal(emergencyReason(night),THREAT_INTERRUPTION)
})

test('dusk with no built base is an emergency; a built base, daylight or peaceful is not',()=>{
 const base={gameMode:'survival',health:20,food:20,difficulty:'normal',headSubmerged:false,oxygen:20,nearbyThreats:[],carriedFood:[]}
 assert.equal(emergencyReason({...base,timeOfDay:13000,shelterAvailable:false}),NIGHT_EXPOSURE)
 assert.equal(emergencyReason({...base,timeOfDay:23900,shelterAvailable:false}),NIGHT_EXPOSURE)
 assert.equal(emergencyReason({...base,timeOfDay:13000,shelterAvailable:true}),null)
 assert.equal(emergencyReason({...base,timeOfDay:6000,shelterAvailable:false}),null)
 assert.equal(emergencyReason({...base,timeOfDay:13000,shelterAvailable:false,difficulty:'peaceful'}),null)
 assert.equal(emergencyReason({...base,timeOfDay:13000,shelterAvailable:false,nearbyThreats:[{name:'zombie',risk:'potential_hostile',distance:8}]}),THREAT_INTERRUPTION)
})
