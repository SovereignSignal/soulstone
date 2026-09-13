import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {readFileSync} from 'node:fs'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {burrowSite,burrowIn,burrowClearance,unburrow} from '../src/burrow.js'
import {executeSkill} from '../src/skills.js'
import {validateTaskGoal} from '../src/task-store.js'
import {Teammate} from '../src/companion/controller.js'
import {canResume} from '../src/companion/continuity.js'
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
 w.bot.health=16;w.bot.entities={1:{name:'zombie',position:new Vec3(14.5,64,10.5)}};assert.match(burrowClearance(w.bot).reason,/lone zombie lingers/)
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
  execute:Teammate.prototype.execute,leaveOccupiedShelter:async()=>{},seekSafety:Teammate.prototype.seekSafety,lastResortShelter:Teammate.prototype.lastResortShelter,moveOutOfDanger:Teammate.prototype.moveOutOfDanger,leaveOnOpenGround:Teammate.prototype.leaveOnOpenGround,waitInBurrow:Teammate.prototype.waitInBurrow,
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
 // Never reaching the surface now triggers the manual climb; with no jump or placement it stalls and says so.
 w.bot.pathfinder.goto=async()=>{throw new Error('Took to long to decide path to goal!')};w.bot.entity.position=new Vec3(10.5,61,10.5)
 w.bot.setControlState=()=>{};w.bot.lookAt=async()=>{};w.bot.placeBlock=async()=>{}
 await assert.rejects(unburrow(w.bot,{kind:'unburrow',goal:{surface:{x:10,y:64,z:10}}},api),/Climb stalled/)
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

test('when the pathfinder will not climb out, the exit jumps and places blocks beneath until at the surface',async()=>{
 const w=world();w.bot.entity.position=new Vec3(10.5,60,10.5);w.cells.set(new Vec3(10,63,10).toString(),'dirt')
 for(const y of [60,61,62])w.cells.set(new Vec3(10,y,10).toString(),'air')
 w.inventory.push({name:'cobblestone',count:2},{name:'dirt',count:3})
 w.bot.pathfinder={setMovements(){},setGoal(){},async goto(){throw new Error('Took to long to decide path to goal!')}}
 const placedAt=[]
 w.bot.setControlState=(k,v)=>{if(k==='jump'&&v)w.bot.entity.position=new Vec3(10.5,Math.floor(w.bot.entity.position.y)+1.1,10.5)}
 w.bot.lookAt=async()=>{}
 w.bot.placeBlock=async(ref,face)=>{const p=ref.position.plus(face);placedAt.push(p.y);w.cells.set(p.toString(),'dirt');w.bot.entity.position=new Vec3(10.5,p.y+1,10.5);w.bot.entity.onGround=true}
 const result=await unburrow(w.bot,{kind:'unburrow',goal:{surface:{x:10,y:64,z:10}}},api)
 assert.equal(result.receipt,'surfaced');assert.equal(result.climbed,true);assert.equal(w.bot.entity.position.y,64)
 assert.deepEqual(placedAt,[60,61,62,63]);assert.ok(w.dug.includes(new Vec3(10,63,10).toString()),'dug the cap on the way up')
})

test('daylight judgement: a lone defendable mob that lingers is confronted after the patience window; creepers, pairs, low health and hunger keep the bot dug in',()=>{
 const w=world();w.bot.time.timeOfDay=6000;w.bot.health=20;w.bot.food=20
 w.bot.entities={1:{name:'skeleton',position:new Vec3(14.5,64,10.5)}}
 let r=burrowClearance(w.bot);assert.equal(r.clear,false);assert.equal(r.lingering,true);assert.match(r.reason,/lone skeleton .* 60 seconds/)
 r=burrowClearance(w.bot,{lingeredMs:61000});assert.equal(r.clear,true);assert.equal(r.confront.name,'skeleton');assert.match(r.reason,/surfacing to confront/)
 w.bot.health=14;r=burrowClearance(w.bot,{lingeredMs:61000});assert.equal(r.clear,false);assert.equal(r.lingering,undefined)
 w.bot.health=20;w.bot.entities={1:{name:'creeper',position:new Vec3(14.5,64,10.5)}};r=burrowClearance(w.bot,{lingeredMs:61000});assert.equal(r.clear,false);assert.equal(r.lingering,undefined)
 w.bot.entities={1:{name:'zombie',position:new Vec3(14.5,64,10.5)},2:{name:'zombie',position:new Vec3(12.5,64,10.5)}};assert.equal(burrowClearance(w.bot,{lingeredMs:61000}).clear,false)
 w.bot.entities={1:{name:'zombie',position:new Vec3(14.5,64,10.5)}};w.bot.food=8;assert.equal(burrowClearance(w.bot,{lingeredMs:61000}).clear,false)
 w.bot.food=20;w.bot.time.timeOfDay=13000;assert.match(burrowClearance(w.bot,{lingeredMs:61000}).reason,/daylight/)
})
test('a burrowed bot surfaces to confront a lone zombie that lingers through the daylight patience window, then continues the request',async()=>{
 const w=world();w.bot.entities={1:{name:'zombie',position:new Vec3(14.5,64,10.5)}}
 const runner=new EventEmitter();runner.bot=w.bot;runner.ready=true;runner.connectionId='c1';runner.profile='p';runner.owner='Sov'
 const commands=[]
 runner.command=c=>{commands.push(c.action);if(c.action==='stop')return;runner.task={id:String(commands.length),kind:c.action,status:'running'}
  const result=c.action==='burrow'?{receipt:'burrowed_capped',shelterName:'burrow',surface:{x:10,y:64,z:10}}:c.action==='unburrow'?{receipt:'surfaced'}:{}
  setTimeout(()=>{runner.task={...runner.task,status:'completed',result};runner.emit('event',{type:'task_finished',task:runner.task})},1)}
 runner.waitForIdle=async()=>{};runner.position=()=>({x:10,y:64,z:10})
 const said=[];let resumed=0
 const c={runner,projects:{},epoch:1,abort:null,phase:'acting',activity:'',requestProgress:{id:'r1',status:'running',feedback:[],completed:[]},safety:null,burrowWait:{quietMs:20,limitMs:3000,patienceMs:100},
  say:t=>said.push(t),persist(){},emit(){},cancel(){},interrupt(){this.requestProgress.status='interrupted'},dispatch(cmd){runner.command(cmd)},
  execute:Teammate.prototype.execute,leaveOccupiedShelter:async()=>{},seekSafety:Teammate.prototype.seekSafety,lastResortShelter:Teammate.prototype.lastResortShelter,moveOutOfDanger:Teammate.prototype.moveOutOfDanger,leaveOnOpenGround:Teammate.prototype.leaveOnOpenGround,waitInBurrow:Teammate.prototype.waitInBurrow,
  async resume(){resumed++;this.requestProgress.status='running'}}
 const started=c.seekSafety(THREAT_INTERRUPTION)
 await new Promise(r=>setTimeout(r,300));w.bot.time.timeOfDay=6000;w.bot.health=20
 await started
 assert.deepEqual(commands.filter(a=>a!=='stop'),['burrow','unburrow'])
 assert.equal(resumed,1);assert.equal(c.requestProgress.safetyContinuations.length,1);assert.equal(c.safety,null)
 assert.ok(said.some(t=>/lone zombie has lingered 4 blocks away. Opening up to confront it/.test(t)),said.join(' | '))
})

test('Resume while dug in defers to the burrow wait, then continues the request at daylight even without new progress',async()=>{
 const w=world();const runner=new EventEmitter();runner.bot=w.bot;runner.ready=true;runner.connectionId='c1';runner.profile='p';runner.owner='Sov';runner.respawnPending=false
 const commands=[]
 runner.command=c=>{commands.push(c.action);if(c.action==='stop')return;runner.task={id:String(commands.length),kind:c.action,status:'running'}
  const result=c.action==='burrow'?{receipt:'burrowed_capped',shelterName:'burrow',surface:{x:10,y:64,z:10}}:c.action==='unburrow'?{receipt:'surfaced'}:{}
  setTimeout(()=>{runner.task={...runner.task,status:'completed',result};runner.emit('event',{type:'task_finished',task:runner.task})},1)}
 runner.waitForIdle=async()=>{};runner.position=()=>({x:10,y:64,z:10})
 const said=[];let submitted=0
 const c={runner,projects:{},epoch:1,abort:null,phase:'acting',activity:'',requestProgress:{id:'r1',request:'mine a diamond',status:'running',feedback:[],completed:[],safetyContinuations:[{completedAt:0},{completedAt:0}]},safety:null,burrowWait:{quietMs:20,limitMs:3000},
  say:t=>said.push(t),persist(){},emit(){},cancel(){},interrupt(){this.requestProgress.status='interrupted'},dispatch(cmd){runner.command(cmd)},snapshot(){return {dead:false}},
  execute:Teammate.prototype.execute,leaveOccupiedShelter:async()=>{},seekSafety:Teammate.prototype.seekSafety,lastResortShelter:Teammate.prototype.lastResortShelter,moveOutOfDanger:Teammate.prototype.moveOutOfDanger,leaveOnOpenGround:Teammate.prototype.leaveOnOpenGround,waitInBurrow:Teammate.prototype.waitInBurrow,
  resume:Teammate.prototype.resume,async submit(){submitted++;this.requestProgress.status='running'}}
 const started=c.seekSafety(THREAT_INTERRUPTION)
 await new Promise(r=>setTimeout(r,300))
 await c.resume()
 assert.equal(submitted,0,'no planning from underground');assert.equal(c.safety.resumeRequested,true)
 assert.ok(said.some(t=>/still dug in/.test(t)),said.join(' | '))
 w.bot.time.timeOfDay=6000;w.bot.health=20
 await started
 assert.deepEqual(commands.filter(a=>a!=='stop'),['burrow','unburrow'])
 assert.equal(submitted,1,'the explicit Resume carries through the exit despite two idle continuations');assert.equal(c.safety,null)
})

test('when every shelter is refused with a threat near, the bot climbs out, sprints away and digs in on the new ground instead of standing still',async()=>{
 const w=world();w.bot.entities={1:{name:'creeper',position:new Vec3(22.5,64,10.5)}}
 const runner=new EventEmitter();runner.bot=w.bot;runner.ready=true;runner.connectionId='c1';runner.profile='p';runner.owner='Sov'
 const commands=[];let burrows=0,flights=0
 runner.command=c=>{commands.push(c.action);if(c.action==='stop')return;runner.task={id:String(commands.length),kind:c.action,status:'running'}
  const fail=reason=>{runner.task={...runner.task,status:'failed',reason};runner.emit('event',{type:'task_finished',task:runner.task})}
  const done=result=>{runner.task={...runner.task,status:'completed',result};runner.emit('event',{type:'task_finished',task:runner.task})}
  setTimeout(()=>{
   if(c.action==='burrow'&&++burrows===1)return fail('No safe burrow here: Only 0 diggable cells below')
   if(c.action==='hut')return fail('Cannot wall in here: No ground to build the wall on at 9,63,10')
   if(c.action==='climb')return done({receipt:'climbed',rise:5})
   if(c.action==='flee'&&++flights===1)return fail('No route away from here')
   if(c.action==='flee'){w.bot.entities={};return done({receipt:'fled',moved:24,gained:24})}
   if(c.action==='burrow')return done({receipt:'burrowed_capped',shelterName:'burrow',surface:{x:30,y:69,z:10}})
   if(c.action==='unburrow')return done({receipt:'surfaced'})
   done({})},1)}
 runner.waitForIdle=async()=>{};runner.position=()=>({x:10,y:64,z:10})
 const said=[];let resumed=0
 const c={runner,projects:{},epoch:1,abort:null,phase:'acting',activity:'',requestProgress:{id:'r1',status:'running',feedback:[],completed:[]},safety:null,burrowWait:{quietMs:20,limitMs:3000},
  say:t=>said.push(t),persist(){},emit(){},cancel(){},interrupt(){this.requestProgress.status='interrupted'},dispatch(cmd){runner.command(cmd)},
  execute:Teammate.prototype.execute,leaveOccupiedShelter:async()=>{},seekSafety:Teammate.prototype.seekSafety,lastResortShelter:Teammate.prototype.lastResortShelter,moveOutOfDanger:Teammate.prototype.moveOutOfDanger,leaveOnOpenGround:Teammate.prototype.leaveOnOpenGround,waitInBurrow:Teammate.prototype.waitInBurrow,
  async resume(){resumed++;this.requestProgress.status='running'}}
 const started=c.seekSafety(THREAT_INTERRUPTION)
 await new Promise(r=>setTimeout(r,400));w.bot.time.timeOfDay=6000;w.bot.health=20
 await started
 assert.deepEqual(commands.filter(a=>a!=='stop'),['flee','burrow','hut','climb','flee','burrow','unburrow'],commands.join(','))
 assert.equal(resumed,1);assert.equal(c.safety,null)
 assert.ok(said.some(t=>/No shelter here. Moving away from the creeper/.test(t)),said.join(' | '))
})

test('low health interrupts work only when there is something to do about it, never in safe daylight',()=>{
 const base={gameMode:'survival',health:5,food:15,difficulty:'normal',headSubmerged:false,oxygen:20,nearbyThreats:[],carriedFood:[],timeOfDay:6000}
 assert.equal(emergencyReason({...base,shelterAvailable:true,sheltered:false}),null,'daylight outside the base: the bot needs to go and find food')
 assert.equal(emergencyReason({...base,shelterAvailable:true,sheltered:true}),null,'resting inside with no food: healing needs food, not another retreat')
 assert.equal(emergencyReason({...base,timeOfDay:13000,shelterAvailable:true,sheltered:false}),'Health is at or below half','night outside a lit base is worth going home for')
 assert.equal(emergencyReason({...base,timeOfDay:13000,shelterAvailable:true,sheltered:true}),null,'already home for the night')
 assert.equal(emergencyReason({...base,shelterAvailable:true,sheltered:true,nearbyThreats:[{name:'zombie',risk:'potential_hostile',distance:6}]}),null,'inside the closed lit base, a hostile outside needs no further retreat')
 assert.equal(emergencyReason({...base,shelterAvailable:true,sheltered:false,nearbyThreats:[{name:'zombie',risk:'potential_hostile',distance:6}]}),'Health is at or below half','outside with a hostile near, day or night')
 assert.equal(emergencyReason({...base,shelterAvailable:false,sheltered:false}),null,'no shelter and no threat: the planner keeps working')
})

test('a verified closed lit shelter answers a nearby hostile by itself; no emergency retreats into the room the bot stands in',()=>{
 const base={gameMode:'survival',health:20,food:20,difficulty:'normal',headSubmerged:false,oxygen:20,carriedFood:[],timeOfDay:13000,shelterAvailable:true}
 const zombie=[{name:'zombie',risk:'potential_hostile',distance:8}]
 assert.equal(emergencyReason({...base,nearbyThreats:zombie,sheltered:false}),THREAT_INTERRUPTION,'outside, a close hostile still interrupts')
 assert.equal(emergencyReason({...base,nearbyThreats:zombie,sheltered:true}),null,'inside the closed lit base, staying put is the answer')
 assert.equal(emergencyReason({...base,health:6,nearbyThreats:zombie,sheltered:true}),null,'hurt and inside: no retreat into the same room')
 assert.equal(emergencyReason({...base,health:6,nearbyThreats:zombie,sheltered:false}),'Health is at or below half','hurt and outside with a hostile near')
})

test('a recovery that failed with nothing changed stops repeating, names every blocker once, and yields to the operator',async()=>{
 const w=world('sandstone');w.bot.entities={1:{name:'zombie',position:new Vec3(14.5,64,10.5)}}
 w.bot.inventory.items=()=>[]
 const runner=new EventEmitter();runner.bot=w.bot;runner.ready=true;runner.connectionId='c1';runner.profile='p';runner.owner='Sov'
 const commands=[]
 runner.command=c=>{commands.push(c.action);if(c.action==='stop')return;runner.task={id:String(commands.length),kind:c.action,status:'running'}
  const reason=c.action==='retreat'?'Shelter access obstructed by birch_log at -656,66,626':c.action==='burrow'?'No safe burrow here: Only 2 diggable cells below':c.action==='hut'?'Cannot wall in here: Fewer than 10 placeable blocks carried':'No pit exit judged from here'
  setTimeout(()=>{runner.task={...runner.task,status:'failed',reason};runner.emit('event',{type:'task_finished',task:runner.task})},1)}
 runner.waitForIdle=async()=>{};runner.position=()=>({x:10,y:64,z:10})
 const said=[]
 const c={runner,projects:{base:{build:{origin:{x:0,y:64,z:0},design:[{x:0,y:0,z:0,block:'oak_planks'}]},stations:{torch:{position:{x:1,y:65,z:1},confirmed:true}},built:true}},
  epoch:1,abort:null,phase:'acting',activity:'',requestProgress:{id:'r1',status:'running',feedback:[],completed:[]},safety:null,unsafeSignature:null,burrowWait:{quietMs:20,limitMs:500},
  say:t=>said.push(t),persist(){},emit(){},cancel(){},interrupt(){this.requestProgress.status='interrupted'},dispatch(cmd){runner.command(cmd)},
  execute:Teammate.prototype.execute,leaveOccupiedShelter:async()=>{},seekSafety:Teammate.prototype.seekSafety,lastResortShelter:Teammate.prototype.lastResortShelter,
  moveOutOfDanger:Teammate.prototype.moveOutOfDanger,leaveOnOpenGround:Teammate.prototype.leaveOnOpenGround,waitInBurrow:Teammate.prototype.waitInBurrow,
  safetyBlockKey:Teammate.prototype.safetyBlockKey,unsafeAdvice:Teammate.prototype.unsafeAdvice,async resume(){}}
 await c.seekSafety(THREAT_INTERRUPTION,{retries:3})
 assert.equal(c.safety.status,'failed')
 const advice=said.find(t=>/cannot make myself safe/.test(t))
 assert.ok(advice,said.join(' | '))
 assert.match(advice,/no pickaxe to dig in/)
 assert.match(advice,/no blocks to wall in/)
 assert.match(advice,/I need a pickaxe or ten building blocks/)
 // Nothing has changed, so a second call must do nothing at all.
 const before=commands.length,spoken=said.length
 c.safety=null
 await c.seekSafety(THREAT_INTERRUPTION,{retries:3})
 assert.equal(commands.length,before,'no second round of shelter attempts')
 assert.equal(said.length,spoken,'and no repeated message')
 // A carried pickaxe changes the fingerprint, so the chain is allowed to try again.
 w.bot.inventory.items=()=>[{name:'iron_pickaxe',count:1}]
 await c.seekSafety(THREAT_INTERRUPTION,{retries:3})
 assert.ok(commands.length>before,'a changed situation re-arms recovery')
})

test('when safety is unachievable the tick lets the paused request carry on, because idling fixes none of it',async()=>{
 const {Teammate:T}=await import('../src/companion/controller.js')
 const bot={registry,game:{gameMode:'survival',difficulty:'normal'},time:{timeOfDay:15000},health:3,food:16,entities:{},players:{},
  entity:{position:new Vec3(10.5,64,10.5),onGround:true},inventory:{items:()=>[]},blockAt:()=>({name:'air',boundingBox:'empty'})}
 const runner=new EventEmitter();runner.bot=bot;runner.ready=true;runner.connectionId='c1';runner.profile='p';runner.owner='Sov';runner.command=()=>{}
 let resumed=0
 const c={runner,projects:{},epoch:1,phase:'blocked',activity:'',standoffResuming:false,
  unsafeSignature:{reason:'Night with no shelter',key:'k',at:Date.now()},
  safety:{status:'failed',reason:'Night with no shelter'},
  requestProgress:{id:'r1',request:'craft a pickaxe',status:'interrupted',feedback:[],completed:[]},
  say(){},persist(){},emit(){},snapshot(){return {dead:false}},async resume(){resumed++;this.requestProgress.status='running'}}
 // Drive the one tick branch under test directly.
 const tick=()=>{
  if(c.safety?.status==='failed'&&c.unsafeSignature&&!c.standoffResuming&&!c.snapshot().dead&&canResume(c.requestProgress)){
   c.standoffResuming=true
   return c.resume({automatic:true}).finally(()=>{c.standoffResuming=false})
  }
 }
 await tick();assert.equal(resumed,1,'the instruction is not consumed by an impossible recovery')
 await tick();assert.equal(resumed,1,'and a running request is not resumed again')
 assert.ok(String(T.prototype.seekSafety).includes('carrying on with the work'),'the standoff still says so plainly')
})

test('a standoff survives the automatic resume it triggers, and only an operator instruction clears it',()=>{
 const source=readFileSync(new URL('../src/companion/controller.js',import.meta.url),'utf8')
 assert.match(source,/if\(!automatic\)this\.unsafeSignature=null/,'automatic resume keeps the standoff')
 assert.match(source,/this\.unsafeSignature=null\n/,'seekSafety clears it when a real attempt begins')
})
