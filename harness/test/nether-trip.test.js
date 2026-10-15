import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import registryFor from 'prismarine-registry'
import {Vec3} from 'vec3'
import {tripKit,onTrip,TRIP_ARMOR,TRIP_ARROWS} from '../src/nether-trip.js'
import {burrowClearance} from '../src/burrow.js'
import {Teammate} from '../src/companion/controller.js'
import {THREAT_INTERRUPTION} from '../src/survival.js'
import {canResume} from '../src/companion/continuity.js'
const registry=registryFor('1.21.4')
// Step 4, lab runs 129 to 137 (13 October): the planner said walk 47 blocks to the
// spawner while the Nether safety rule sent the bot home at any hostile within ten
// blocks. A fortress always has one, so the bot never got twenty blocks in and died
// retreating through the corridors. On a trip with the kit it holds its ground.
const kitItems=()=>[{name:'bow',count:1},{name:'arrow',count:40},{name:'iron_sword',count:1,maxDurability:250,durabilityUsed:0},{name:'cobblestone',count:64,type:registry.itemsByName.cobblestone.id}]
function wear(bot,boots='golden_boots'){
 const slots=[];bot.inventory.slots=slots;bot.getEquipmentDestSlot=s=>({head:5,torso:6,legs:7,feet:8})[s]
 for(const [i,n] of [[5,'iron_helmet'],[6,'iron_chestplate'],[7,'iron_leggings'],[8,boots]])slots[i]={name:n}
 return slots
}
test('the trip kit is a bow, 16 arrows, an iron sword or axe and the Nether armour; each missing piece is named',()=>{
 const items=kitItems(),bot={health:20,game:{dimension:'minecraft:the_nether'},inventory:{items:()=>items}}
 wear(bot)
 assert.deepEqual(tripKit(bot),{ready:true,missing:[],arrows:40,armour:14,weapon:'iron_sword'})
 assert.equal(onTrip(bot,true),true)
 assert.equal(onTrip(bot,false),false,'no request, no trip')
 bot.game.dimension='minecraft:overworld';assert.equal(onTrip(bot,true),false,'the Overworld is not a trip');bot.game.dimension='minecraft:the_nether'
 bot.health=11;assert.equal(onTrip(bot,true),false,'hurt: the portal is back on the table');bot.health=20
 items[1].count=10;assert.match(tripKit(bot).missing[0],new RegExp(`${TRIP_ARROWS} arrows \\(carrying 10\\)`));items[1].count=40
 items[2]={name:'stone_sword',count:1,maxDurability:131,durabilityUsed:0};assert.match(tripKit(bot).missing[0],/iron sword or axe/);items[2]=kitItems()[2]
 bot.inventory.slots[6]=null;assert.match(tripKit(bot).missing[0],new RegExp(`iron armour \\(8 of ${TRIP_ARMOR} points worn\\)`))
})
function netherBot({health=20,kit=true,hoglinAt=3}={}){
 const items=kit?kitItems():[{name:'cobblestone',count:64,type:registry.itemsByName.cobblestone.id}]
 const bot=new EventEmitter()
 Object.assign(bot,{registry,username:'SoulStone303',players:{},health,food:20,oxygenLevel:20,game:{gameMode:'survival',difficulty:'normal',dimension:'minecraft:the_nether'},time:{timeOfDay:6000},
  entity:{id:1,type:'player',position:new Vec3(0.5,64,0.5),onGround:true,eyeHeight:1.62,isInWater:false,metadata:[0]},inventory:{items:()=>items,slots:[]},
  entities:{7:{id:7,uuid:'10000000-0000-0000-0000-000000000007',type:'mob',name:'hoglin',position:new Vec3(0.5,64,0.5+hoglinAt)}},
  world:{raycast:()=>null,getColumn:()=>({})},clearControlStates(){},setControlState(){},pathfinder:{setGoal(){},setMovements(){},async goto(){}}})
 // Frame in the z=-1 plane: obsidian x -1..2, y 63..67; portal x 0..1, y 64..66. Stone floor at y 63.
 bot.blockAt=p=>{const frame=p.z===-1&&p.x>=-1&&p.x<=2&&p.y>=63&&p.y<=67
  const name=frame?((p.x===-1||p.x===2||p.y===63||p.y===67)?'obsidian':'nether_portal'):p.y===63?'stone':'air'
  return {name,position:p.clone(),boundingBox:(name==='stone'||name==='obsidian')?'block':'empty',getProperties:()=>({})}}
 bot.findBlock=({matching})=>matching===registry.blocksByName.nether_portal.id?{name:'nether_portal',position:new Vec3(0,64,-1)}:null
 if(kit)wear(bot)
 return bot
}
async function firstActs({status='running',...opts}={}){
 const bot=netherBot(opts),r=new EventEmitter()
 Object.assign(r,{bot,ready:true,profile:'trip-test',owner:'Sov',connectionId:'20000000-0000-0000-0000-000000000002',position:()=>bot.entity.position,commands:[],waitForIdle:async()=>{}})
 r.command=c=>{r.commands.push(c);if(c.action!=='stop')r.task={id:String(r.commands.length),kind:c.action,status:'running',goal:c.goal}}
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-trip-')),'state.json'))
 c.requestProgress={id:'trip',request:'rods',status,feedback:[]}
 void c.seekSafety(THREAT_INTERRUPTION);await new Promise(res=>setTimeout(res,80))
 const acts=r.commands.map(x=>x.action).filter(a=>a!=='stop');c.cancel?.(true);return {acts,said:c.messages.map(m=>m.text)}
}
test('on a trip with the kit, a hoglin three blocks off beside the portal means cover here, not the portal; hurt or without the kit, the portal as before',async()=>{
 const trip=await firstActs({})
 assert.ok(!trip.acts.includes('use_portal'),'no run for the portal: '+trip.acts.join(' '))
 assert.ok(trip.said.some(t=>/taking cover here rather than running for the portal/.test(t)),trip.said.join(' | '))
 const hurt=await firstActs({health:8});assert.equal(hurt.acts[0],'use_portal','hurt: home, '+hurt.acts.join(' '))
 const bare=await firstActs({kit:false});assert.equal(bare.acts[0],'use_portal','no kit: home, '+bare.acts.join(' '))
})
// Lab run 144 (14 October): a shelter wait at the spawner spent its idle continuations and
// left the request interrupted; the next alarm read "no request" and walked the bot home
// with full health and kit. A request waiting to resume is still the trip (36def62).
test('on a trip with the kit, an interrupted request waiting to resume is still the trip: cover here, not the portal',async()=>{
 const trip=await firstActs({status:'interrupted'})
 assert.ok(!trip.acts.includes('use_portal'),'no run for the portal: '+trip.acts.join(' '))
 assert.ok(trip.said.some(t=>/taking cover here rather than running for the portal/.test(t)),trip.said.join(' | '))
})
test('from cover, a group the fight rules engage is confronted nearest first, not waited out or run from',()=>{
 const bot=netherBot({hoglinAt:30});delete bot.entities[7]
 const cube=(id,z)=>({id,uuid:'10000000-0000-0000-0000-00000000000'+id,type:'mob',name:'magma_cube',position:new Vec3(0.5,64,0.5+z)})
 bot.entities={2:cube(2,6),3:cube(3,4),4:cube(4,8)}
 // Under a roof, so the clock is not the question.
 const blockAt=bot.blockAt;bot.blockAt=p=>p.y>=66&&p.y<=70&&Math.abs(p.x)<3&&Math.abs(p.z)<3?{name:'netherrack',position:p.clone(),boundingBox:'block',getProperties:()=>({})}:blockAt(p)
 const r=burrowClearance(bot,{lingeredMs:90000,patienceMs:60000,relocateAfterMs:120000})
 assert.equal(r.clear,true,r.reason);assert.equal(r.confront?.name,'magma_cube');assert.equal(r.confront.distance,4,'nearest first');assert.equal(r.relocate,undefined)
 assert.match(r.reason,/3 hostiles I can fight/)
 const early=burrowClearance(bot,{lingeredMs:10000,patienceMs:60000});assert.equal(early.clear,false);assert.match(early.reason,/3 hostiles I can fight linger/)
})

// Run 144, after the walk home: the kit was lost, the bot died, and every automatic path
// (dawn respawn, standoff resume, stall retry, safety and restart continuations) revived
// the same request. At 23:26Z the planner itself said "I can't do this run yet... Press
// Resume at daylight", the stall retry resumed it anyway, and the bot rebuilt a kit from
// nothing overnight, 170 blocks from base, dying four more times. A kitted trip ends.
const portal={x:0,y:64,z:-1}
function crossTo(bot,to){const from=bot.game.dimension.replace(/^minecraft:/,'');bot.game.dimension='minecraft:'+to;return {item:'portal',count:1,receipt:'crossed',from:{dimension:from,portal},to:{dimension:to,portal,position:{x:.5,y:64,z:.5}}}}
// fails: reasons each action fails with, in turn, before it completes.
function tripTeammate({fails={},cancelled=false,...opts}={}){
 const bot=netherBot(opts),r=new EventEmitter()
 Object.assign(r,{bot,ready:true,profile:'trip-test',owner:'Sov',connectionId:'20000000-0000-0000-0000-000000000003',position:()=>bot.entity.position,commands:[],waitForIdle:async()=>{}})
 r.command=c=>{r.commands.push(c);if(c.action==='stop')return
  const task=r.task={id:String(r.commands.length),kind:c.action,status:'running',goal:c.goal},reason=fails[c.action]?.shift()
  setTimeout(()=>{if(r.task!==task)return;if(reason){task.status='failed';task.reason=reason}else{task.status='completed';task.result=c.action==='use_portal'?crossTo(bot,bot.game.dimension.endsWith('the_nether')?'overworld':'the_nether'):{receipt:c.action}};r.emit('event',{type:'task_finished',task})},1)}
 // The planner's own use_portal step, as the runner reports it finished.
 r.walkThrough=()=>{const task=r.task={id:'walk'+r.commands.length,kind:'use_portal',status:'completed',goal:{},result:crossTo(bot,bot.game.dimension.endsWith('the_nether')?'overworld':'the_nether')};r.emit('event',{type:'task_finished',task})}
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-trip-end-')),'state.json'))
 c.requestProgress={id:'trip',request:'shoot blazes at the spawner',status:'running',feedback:[],completed:[]}
 // Out from the Overworld through the portal, as the trip begins.
 bot.game.dimension='minecraft:overworld'
 // Lab run 147, 15 October: across, but the alarm cancelled the crossing before it finished.
 if(cancelled){const task=r.task={id:'walk0',kind:'use_portal',status:'cancelled',goal:{}};bot.game.dimension='minecraft:the_nether';r.emit('event',{type:'spawn'});r.emit('event',{type:'task_finished',task})}
 else r.walkThrough()
 return {bot,r,c}
}
const over=c=>c.messages.filter(m=>/The Nether trip is over/.test(m.text))
test('a kitted trip the safety chain takes home through the portal is over: blocked, named, said once',async()=>{
 const {bot,r,c}=tripTeammate({})
 assert.ok(c.requestProgress.kittedTrip,'crossing out with the kit marks the trip')
 bot.health=8
 await c.seekSafety(THREAT_INTERRUPTION)
 assert.ok(r.commands.some(x=>x.action==='use_portal'),'hurt: home through the portal')
 assert.equal(bot.game.dimension,'minecraft:overworld')
 assert.equal(c.requestProgress.status,'blocked')
 assert.equal(canResume(c.requestProgress),false,'no automatic path can revive it')
 assert.match(String(c.requestProgress.reviewRequired),/The Nether trip is over: .*Re-kit me or give me a new instruction/)
 assert.equal(over(c).length,1,c.messages.map(m=>m.text).join(' | '))
 assert.equal(c.phase,'ready')
 c.blockedSince=1;assert.equal(await c.stallRetry(),false)
 await assert.rejects(c.resume({automatic:true}),/The Nether trip is over/)
})
test('a death on a kitted trip ends it, and the dawn respawn still comes back for the drop pile without resuming it',async()=>{
 const wait=ms=>new Promise(res=>setTimeout(res,ms))
 const {bot,r,c}=tripTeammate({});let now=0;c.now=()=>now;c.dawnPollMs=5
 let respawns=0;r.respawn=()=>{respawns++;r.respawnPending=true}
 bot.time.timeOfDay=15000;r.ready=false;bot.health=0;bot.isAlive=false;r.emit('event',{type:'death'})
 assert.equal(c.requestProgress.status,'blocked');assert.equal(canResume(c.requestProgress),false)
 assert.match(String(c.requestProgress.reviewRequired),/The Nether trip is over: I died on it/)
 assert.ok(!c.messages.some(m=>/^I died\./.test(m.text)),'one line for the death: the trip-over line')
 now+=10*60000;await wait(30);assert.equal(respawns,1,'dawn brings it back for the drop pile')
 bot.health=20;bot.isAlive=true;r.respawnPending=false;r.ready=true;r.emit('event',{type:'spawn'})
 assert.equal(c.phase,'ready');assert.equal(c.requestProgress.status,'blocked')
 c.blockedSince=1;assert.equal(await c.stallRetry(),false,'the ended trip is not retried')
 assert.equal(over(c).length,1)
 clearInterval(c.dawnTimer)
})
test('an unkitted Nether request that crosses home is not ended by the trip rule',async()=>{
 const {bot,r,c}=tripTeammate({kit:false})
 assert.equal(c.requestProgress.kittedTrip,undefined,'crossing out without the kit is no kitted trip')
 await c.seekSafety(THREAT_INTERRUPTION)
 assert.ok(r.commands.some(x=>x.action==='use_portal'));assert.equal(bot.game.dimension,'minecraft:overworld')
 assert.equal(canResume(c.requestProgress),true,'the honest run carries on');assert.equal(over(c).length,0)
})
// A rod run that spent its arrows walks the rods home: the planner going home is its own
// call, and the trip is not ended at the portal before it reports done.
test('a planner crossing home, kit or no kit, only ends the leg; a later death at home is an ordinary death',()=>{
 for(const arrows of [3,40]){
  const t=tripTeammate({});t.bot.inventory.items()[1].count=arrows;t.r.walkThrough()
  assert.equal(t.c.requestProgress.kittedTrip,undefined,'home: the leg is over');assert.equal(t.c.requestProgress.status,'running',String(arrows));assert.equal(over(t.c).length,0)
  t.r.ready=false;t.bot.health=0;t.bot.isAlive=false;t.r.respawn=()=>{};t.r.emit('event',{type:'death'})
  assert.equal(canResume(t.c.requestProgress),true,'a later death at home is an ordinary death');assert.equal(over(t.c).length,0)
  clearInterval(t.c.dawnTimer)
 }
})
test('a stopped request is no trip: Stop in the Nether, then a death, leaves it cancelled and says nothing of a trip',()=>{
 const {bot,r,c}=tripTeammate({})
 c.stop();assert.equal(c.requestProgress.status,'cancelled');assert.equal(c.requestProgress.kittedTrip,undefined,'a finished request drops the trip mark')
 r.respawn=()=>{};r.ready=false;bot.health=0;bot.isAlive=false;r.emit('event',{type:'death'})
 assert.equal(c.requestProgress.status,'cancelled');assert.equal(over(c).length,0,c.messages.map(m=>m.text).join(' | '))
 clearInterval(c.dawnTimer)
})
test('a kitted trip moved home from the burrow wait is over, said in one line',async()=>{
 const {bot,r,c}=tripTeammate({});delete bot.entities[7]
 // Dug in four down, a wither skeleton on the surface that will not move on.
 bot.blockAt=p=>{const name=p.x===0&&p.z===0&&p.y>=64&&p.y<=65||p.y>=68?'air':'netherrack';return {name,position:p.clone(),boundingBox:registry.blocksByName[name].boundingBox,getProperties:()=>({})}}
 bot.entities={8:{id:8,type:'mob',name:'wither_skeleton',position:new Vec3(12.5,68,.5)}}
 c.requestProgress.status='interrupted';c.safety={status:'burrowed',retreat:{shelterName:'burrow',surface:{x:0,y:68,z:0}}};c.shelterPlanning=false
 c.burrowWait={quietMs:50,limitMs:1500,patienceMs:100,relocateAfterMs:100,watches:1}
 const acts=[];c.execute=async command=>{acts.push(command.action);r.task={kind:command.action,status:'completed',result:command.action==='use_portal'?crossTo(bot,'overworld'):{receipt:command.action}}};c.resume=async()=>{throw new Error('resumed an ended trip')}
 await c.waitInBurrow(c.epoch,new AbortController().signal,bot,true)
 assert.ok(acts.includes('use_portal'),acts.join(' ')+' :: '+c.messages.map(m=>m.text).join(' | '))
 assert.equal(canResume(c.requestProgress),false);assert.equal(over(c).length,1)
 assert.ok(!c.messages.some(m=>/^Back on the surface/.test(m.text)),c.messages.map(m=>m.text).join(' | '))
})
// Lab run 145, 15 October: out of the wall again, the tick must not alarm on the wither
// skeleton below the netherrack that the clearance has just judged too far round to
// matter, or the bot walls in, waits four minutes and goes home through the portal.
// A cavern twelve high over netherrack, the skeleton in a pocket below it.
test('in open Nether air the tick and the clearance agree: a wither skeleton below rock a capped flood never met is no alarm',()=>{
 const bot=netherBot({hoglinAt:30});delete bot.entities[7]
 const pocket=new Set(['14,57,0','14,58,0'])
 bot.blockAt=p=>{const name=p.y>=64&&p.y<=75||pocket.has(`${p.x},${p.y},${p.z}`)?'air':'netherrack';return {name,position:p.clone(),boundingBox:registry.blocksByName[name].boundingBox,getProperties:()=>({})}}
 bot.world={raycast:()=>({name:'netherrack'}),getColumn:()=>({})}
 bot.entities={8:{id:8,type:'mob',name:'wither_skeleton',position:new Vec3(14.5,57,.5)}}
 const exits=[new Vec3(0,64,0),new Vec3(0,65,0)]
 assert.equal(burrowClearance(bot,{exits,trip:true,lingeredMs:600000}).relocate,undefined)
 assert.equal(burrowClearance(bot,{exits,trip:true}).clear,true)
 const r=new EventEmitter();Object.assign(r,{bot,ready:true,profile:'trip-test',owner:'Sov',connectionId:'20000000-0000-0000-0000-000000000004',position:()=>bot.entity.position,commands:[],waitForIdle:async()=>{},command(c){r.commands.push(c)}})
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-trip-tick-')),'state.json'))
 const calls=[],logs=[];c.seekSafety=async why=>{calls.push(why)};r.log=(type,data)=>logs.push([type,data])
 r.emit('event',{type:'survival_tick'})
 assert.deepEqual(calls,[],JSON.stringify(logs))
})

// Lab run 147, 15 October: across at 17:16:18Z, an alarm at 18.98 cancelled use_portal in
// leaving_portal, before the arrival hop; until the hop the server ignores placements, so
// the portal room failed by one block. The arrival is part of the crossing.
function crossingTeammate(blockAt){
 const bot=netherBot({hoglinAt:30});bot.entities={8:{id:8,type:'mob',name:'wither_skeleton',position:new Vec3(10.5,64,.5)}}
 if(blockAt){const base=bot.blockAt;bot.blockAt=p=>blockAt(p)??base(p)}
 const r=new EventEmitter();Object.assign(r,{bot,ready:true,profile:'trip-test',owner:'Sov',connectionId:'20000000-0000-0000-0000-000000000005',position:()=>bot.entity.position,commands:[],waitForIdle:async()=>{},command(c){r.commands.push(c)}})
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-trip-arrive-')),'state.json'))
 const calls=[];c.seekSafety=async why=>{calls.push(why)}
 return {r,c,calls}
}
test('a hostile does not cancel a crossing while it steps out of the arrival portal or hops; lava still does',()=>{
 for(const stage of ['entering','leaving_portal','arrival_hop']){
  const {r,calls}=crossingTeammate()
  r.task={id:'1',kind:'use_portal',status:'running'};r.work={stage}
  r.emit('event',{type:'survival_tick'})
  assert.deepEqual(calls,[],stage)
 }
 const walking=crossingTeammate();walking.r.task={id:'1',kind:'use_portal',status:'running'};walking.r.work={stage:'walking'}
 walking.r.emit('event',{type:'survival_tick'});assert.deepEqual(walking.calls,[THREAT_INTERRUPTION],'on the walk to the portal the alarm still stops it')
 const lava=crossingTeammate(p=>p.x===0&&p.y===64&&p.z===0?{name:'lava',position:p.clone(),boundingBox:'empty',getProperties:()=>({level:0})}:null)
 lava.r.task={id:'1',kind:'use_portal',status:'running'};lava.r.work={stage:'leaving_portal'}
 lava.r.emit('event',{type:'survival_tick'});assert.equal(lava.calls.length,1);assert.notEqual(lava.calls[0],THREAT_INTERRUPTION)
})
// Lab run 147: the portal room the alarm asked for failed by one block, and the next thing
// tried was the walk home. One cell short is tried once more first.
test('a portal room that fails by one cell is tried again before the portal walk',async()=>{
 const {r,c}=tripTeammate({hoglinAt:8,fails:{hut:['Hut incomplete: 1 of 15 blocks missing (0,65,1)']}})
 void c.seekSafety(THREAT_INTERRUPTION);await new Promise(res=>setTimeout(res,100))
 const acts=r.commands.map(x=>x.action).filter(a=>a!=='stop');c.cancel?.(true)
 assert.deepEqual(acts.slice(0,2),['hut','hut'],acts.join(' '));assert.ok(!acts.includes('use_portal'),acts.join(' '))
 const short=tripTeammate({hoglinAt:8,fails:{hut:['Hut incomplete: 3 of 15 blocks missing (0,65,1)']}})
 await short.c.seekSafety(THREAT_INTERRUPTION)
 const two=short.r.commands.map(x=>x.action).filter(a=>a!=='stop');assert.deepEqual(two.slice(0,2),['hut','use_portal'],two.join(' '))
})
// Lab run 147: the cancelled crossing left no trip mark, so the safety chain's walk home did
// not end the trip and the stall retry crossed again into the same alarm.
test('a crossing the alarm cancelled still marks the kitted trip by the dimension, and the walk home ends it',async()=>{
 const {bot,r,c}=tripTeammate({cancelled:true,hoglinAt:8,fails:{hut:['Hut incomplete: 3 of 15 blocks missing (0,65,1)']}})
 assert.ok(c.requestProgress.kittedTrip,'in the Nether with the kit: a kitted trip')
 await c.seekSafety(THREAT_INTERRUPTION)
 assert.ok(r.commands.some(x=>x.action==='use_portal'));assert.equal(bot.game.dimension,'minecraft:overworld')
 assert.equal(c.requestProgress.status,'blocked');assert.equal(canResume(c.requestProgress),false)
 assert.equal(over(c).length,1,c.messages.map(m=>m.text).join(' | '))
 // The planner's own walk home, arriving with the request running, ends the leg only.
 const leg=tripTeammate({cancelled:true});leg.bot.game.dimension='minecraft:overworld';leg.r.emit('event',{type:'spawn'})
 assert.equal(leg.c.requestProgress.kittedTrip,undefined);assert.equal(leg.c.requestProgress.status,'running')
})
