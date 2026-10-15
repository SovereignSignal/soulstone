import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import registryFor from 'prismarine-registry'
import {Vec3} from 'vec3'
import {tripKit,onTrip,TRIP_ARMOR,TRIP_ARROWS,portReady,tripPickup} from '../src/nether-trip.js'
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
 // The arrows spent since crossing: with the kit whole it would go on (lab run 147).
 bot.inventory.items()[1].count=3
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
// Lab run 150, 15 October: kitted in a one-wide covered netherrack tunnel, blazes off the
// walls, and netherrack with a pickaxe always burrows, so the bot dug in where it had no
// port, and leaving was a climb out under four blazes. The tunnel is a hut already but for
// its two open ends; on a trip those are walled first and the burrow is the fallback.
async function tunnelCover(opts){
 const {bot,r,c}=tripTeammate(opts)
 bot.inventory.items().push({name:'iron_pickaxe',count:1,maxDurability:250,durabilityUsed:0})
 bot.blockAt=p=>{const name=p.x===0&&(p.y===64||p.y===65)&&Math.abs(p.z)<=10?'air':'netherrack';return {name,position:p.clone(),boundingBox:registry.blocksByName[name].boundingBox,getProperties:()=>({})}}
 bot.findBlock=()=>null
 bot.entities={8:{id:8,uuid:'10000000-0000-0000-0000-000000000008',type:'mob',name:'blaze',position:new Vec3(4.5,64,2.5)}}
 void c.seekSafety(THREAT_INTERRUPTION);await new Promise(res=>setTimeout(res,100))
 const acts=r.commands.map(x=>x.action).filter(a=>a==='hut'||a==='burrow');c.cancel?.(true);return {acts,said:c.messages.map(m=>m.text)}
}
test('on a trip in a one-wide tunnel the open ends are walled before any burrow; off a trip, the burrow first as before',async()=>{
 const trip=await tunnelCover({});assert.equal(trip.acts[0],'hut',trip.acts.join(' ')+' :: '+trip.said.join(' | '))
 const bare=await tunnelCover({kit:false});assert.equal(bare.acts[0],'burrow',bare.acts.join(' ')+' :: '+bare.said.join(' | '))
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
// Lab run 147, the second crossing: the hut held, a wither skeleton lingered about thirteen
// blocks off, and after four minutes "leaving the area" took the portal home with health 20
// and 128 arrows. On a kitted trip, strong and past the standoff, leaving means going on.
function lingeringHut({health=20,arrows=40,pending=[],eligible=true}={}){
 const t=tripTeammate({});const {bot,r,c}=t;bot.health=health;bot.inventory.items()[1].count=arrows
 // Walled in on open netherrack: walls at feet and head, a roof, open ground beyond.
 const wall=p=>p.y===63||p.y===66&&(p.x===0||p.x===1)&&p.z===0||(p.y===64||p.y===65)&&Math.abs(p.x)+Math.abs(p.z)===1
 bot.blockAt=p=>{const name=wall(p)?'netherrack':'air';return {name,position:p.clone(),boundingBox:registry.blocksByName[name].boundingBox,getProperties:()=>({})}}
 bot.entities={8:{id:8,type:'mob',name:'wither_skeleton',position:new Vec3(12.5,64,.5)}}
 c.requestProgress.status='interrupted';c.requestProgress.pending=pending
 c.safety={status:'burrowed',retreat:{shelterName:'hut',surface:{x:0,y:64,z:0}}};c.shelterPlanning=false
 c.burrowWait={quietMs:50,limitMs:1500,patienceMs:100,relocateAfterMs:100,watches:1}
 const commands=[],resumed=[];c.execute=async command=>{commands.push(command);r.task={kind:command.action,status:'completed',result:command.action==='use_portal'?crossTo(bot,'overworld'):{receipt:command.action}}}
 c.resume=async o=>{resumed.push(o)}
 return {...t,commands,resumed,run:()=>c.waitInBurrow(c.epoch,new AbortController().signal,bot,eligible)}
}
test('on a kitted trip, strong and past the standoff, a mob that will not move on means going on: the hut opens toward the next step and the request resumes',async()=>{
 const ahead=lingeringHut({pending:[{action:'shoot',item:'blaze'},{action:'goto',target:{x:-3,y:64,z:-30}}]});await ahead.run()
 const acts=ahead.commands.map(x=>x.action),said=ahead.c.messages.map(m=>m.text).join(' | ')
 assert.ok(!acts.includes('use_portal'),acts.join(' ')+' :: '+said);assert.ok(!acts.includes('flee'),acts.join(' '))
 assert.deepEqual(ahead.commands.find(x=>x.action==='unhut').goal.toward,{x:-3,z:-30})
 assert.equal(ahead.resumed.length,1);assert.equal(ahead.resumed[0].automatic,true);assert.equal(canResume(ahead.c.requestProgress),true);assert.equal(over(ahead.c).length,0)
 // No step ahead with a place in it: the side away from the mob, and never the side facing it.
 const away=lingeringHut();await away.run()
 const goal=away.commands.find(x=>x.action==='unhut').goal
 assert.ok(goal.toward.x<0,JSON.stringify(goal));assert.deepEqual(goal.from,[{x:12,z:0}]);assert.equal(away.resumed.length,1)
 // The next step lies past the mob: the wall that opens still faces away from it.
 const behind=lingeringHut({pending:[{action:'goto',target:{x:30,y:64,z:0}}]});await behind.run()
 const past=behind.commands.find(x=>x.action==='unhut').goal
 assert.ok(past.toward.x<0,JSON.stringify(past));assert.deepEqual(past.from,[{x:12,z:0}]);assert.equal(behind.resumed.length,1)
})
// Review of the above: going on opened the wall and then nothing resumed when the
// continuation was not due, leaving the bot in an open hut with the mob near.
test('going on needs the request to resume: with the continuation spent or not eligible, the old way out',async()=>{
 const spent=lingeringHut();spent.c.requestProgress.safetyContinuations=[{requestId:'trip',resumeSerial:0}];await spent.run()
 assert.ok(spent.commands.some(x=>x.action==='use_portal'),spent.commands.map(x=>x.action).join(' '));assert.equal(spent.resumed.length,0)
 assert.ok(!spent.commands.some(x=>x.goal?.from),'no going-on exit')
 const idle=lingeringHut({eligible:false});await idle.run()
 assert.ok(idle.commands.some(x=>x.action==='use_portal'),idle.commands.map(x=>x.action).join(' '));assert.equal(idle.resumed.length,0)
})
test('with no wall away from the mob to open, going on falls back to the old way out',async()=>{
 const shut=lingeringHut();const execute=shut.c.execute
 shut.c.execute=async command=>{if(command.action==='unhut'&&command.goal?.from){shut.commands.push(command);throw new Error('No wall to open away from the mob')}return execute(command)}
 await shut.run()
 const acts=shut.commands.map(x=>x.action)
 assert.deepEqual(acts.filter(a=>a==='unhut').length,2,acts.join(' '));assert.ok(acts.includes('use_portal'),acts.join(' '));assert.equal(shut.resumed.length,0)
})
test('hurt, short of the kit, or with no request, the burrow wait still holds or goes home as before',async()=>{
 // Twelve health with food to heal on: not strong enough to walk out, so the hut holds.
 const hurt=lingeringHut({health:12});await hurt.run()
 assert.ok(!hurt.commands.some(x=>['use_portal','unhut'].includes(x.action)),hurt.commands.map(x=>x.action).join(' '));assert.equal(hurt.resumed.length,0)
 // The arrows spent: the kit is short, so home through the portal, and the trip is over.
 const spent=lingeringHut({arrows:3});spent.c.resume=async()=>{throw new Error('resumed an ended trip')};await spent.run()
 assert.ok(spent.commands.some(x=>x.action==='use_portal'),spent.commands.map(x=>x.action).join(' '));assert.equal(over(spent.c).length,1)
 // No live request: no trip, so home through the portal.
 const none=lingeringHut();none.c.requestProgress.status='cancelled';await none.run()
 assert.ok(none.commands.some(x=>x.action==='use_portal'),none.commands.map(x=>x.action).join(' '))
})
// Lab run 148, 15 October: kitted, health 20, the bot held its portal-room hut for fifteen
// minutes over one wither skeleton 11 blocks off behind netherrack, its open route about 21.
// Out of the fight rule's ten and not a shooter, nothing could answer it but cover, and cover
// never ends a mob that stays. The kit beats a lone one at health 18 and up (lab run 142), so
// on a trip one such mob, out of sight and past arm's reach, lets the work walk on.
// A tunnel one wide and two high: z 0 to 5 at x 0, x 0 to 11 at z 5, z 5 back to 0 at x 11.
const tunnel=new Set();for(let i=0;i<=11;i++)for(const y of [64,65]){if(i<=5){tunnel.add(`0,${y},${i}`);tunnel.add(`11,${y},${i}`)}tunnel.add(`${i},${y},5`)}
const wither=(id,x,z)=>({id,type:'mob',name:'wither_skeleton',position:new Vec3(x+.5,64,z+.5)})
function walkOnTick({request='running',dimension='the_nether',sight='blocked',mobs=[wither(8,11,0)],...opts}={}){
 const bot=netherBot({hoglinAt:30,...opts});bot.game.dimension='minecraft:'+dimension
 if(opts.swordUsed)bot.inventory.items().find(i=>i.name==='iron_sword').durabilityUsed=opts.swordUsed
 bot.blockAt=p=>{const name=tunnel.has(`${p.x},${p.y},${p.z}`)?'air':'netherrack';return {name,position:p.clone(),boundingBox:registry.blocksByName[name].boundingBox,getProperties:()=>({})}}
 bot.world={raycast:()=>sight==='blocked'?{name:'netherrack'}:null,getColumn:()=>({})}
 bot.entities=Object.fromEntries(mobs.map(m=>[m.id,m]))
 const r=new EventEmitter();Object.assign(r,{bot,ready:true,profile:'trip-test',owner:'Sov',connectionId:'20000000-0000-0000-0000-000000000006',position:()=>bot.entity.position,commands:[],waitForIdle:async()=>{},command(c){r.commands.push(c)}})
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-trip-walk-')),'state.json'))
 if(request)c.requestProgress={id:'trip',request:'rods',status:request,feedback:[],completed:[]}
 const calls=[],logs=[];c.seekSafety=async why=>{calls.push(why)};c.stallRetry=async()=>false;r.log=(type,data)=>logs.push([type,data])
 r.emit('event',{type:'survival_tick'})
 return {bot,calls,logs}
}
test('on a kitted trip a lone wither skeleton out of sight past arm\'s reach is walked on: no alarm, logged with its route',()=>{
 const {calls,logs}=walkOnTick()
 assert.deepEqual(calls,[],JSON.stringify(logs))
 const walk=logs.find(([type])=>type==='threat_walk_on')
 assert.ok(walk,JSON.stringify(logs));assert.deepEqual(walk[1].threats,['wither_skeleton@11/0:open~21:blocked'])
 assert.deepEqual(walkOnTick({request:'interrupted'}).calls,[],'a request waiting to resume is still the trip')
})
test('the walk-on still alarms hurt below the mob\'s floor, without the kit, with two, in sight, at arm\'s reach, with no request, or in the Overworld',()=>{
 const cases={hurt:{health:16},bare:{kit:false},two:{mobs:[wither(8,11,0),wither(9,11,3)]},seen:{sight:'clear'},close:{mobs:[wither(8,0,5)]},
  // Inside the fight rule's ten a hidden one is the alarm's, which fights it: a wither skeleton
  // covers about four blocks a second, so a six-block line is one tick of warning.
  within:{mobs:[wither(8,6,5)]},
  // A blade the fight rule would not draw (under 16 uses) is no blade to walk on with.
  worn:{swordUsed:240},none:{request:null},ended:{request:'cancelled'},overworld:{dimension:'overworld'}}
 for(const [name,opts] of Object.entries(cases)){
  const {calls,logs}=walkOnTick(opts)
  assert.deepEqual(calls,[THREAT_INTERRUPTION],name);assert.ok(!logs.some(([type])=>type==='threat_walk_on'),name)
 }
})
test('from a hut on a kitted trip a lone wither skeleton out of sight of the exits neither holds the bot in nor sends it away',()=>{
 const {bot}=walkOnTick()
 const exits=[new Vec3(0,64,0),new Vec3(0,65,0)]
 const r=burrowClearance(bot,{exits,trip:true,lingeredMs:600000})
 assert.equal(r.clear,true,r.reason);assert.equal(r.relocate,undefined);assert.equal(r.confront,undefined)
 // Off the trip the wait is what it was: the mob lingers, and in time the bot moves away.
 assert.equal(burrowClearance(bot,{exits,trip:false,lingeredMs:1000}).lingering,true)
 assert.ok(burrowClearance(bot,{exits,trip:false,lingeredMs:600000}).relocate)
 // Two of them still hold the hut.
 bot.entities[9]=wither(9,11,3);assert.equal(burrowClearance(bot,{exits,trip:true,lingeredMs:1000}).clear,false)
})
// Lab run 156, 15 October: broken off at a firing port at 10 health and alight, the bot
// burned to death walling in. A port opens toward a shooter only on 16 health or more, not
// burning, and with the food to keep healing.
test('a firing port is ready only on 16 health or more, not on fire, and food 6 or more',()=>{
 const bot=(health,food,flags=0)=>({health,food,entity:{metadata:[flags]}})
 assert.deepEqual(portReady(bot(16,6)),{ready:true})
 for(const [why,b,re] of [['hurt',bot(15.5,20),/health 15.5 of 16/],['burning',bot(20,20,1),/on fire/],['hungry',bot(20,5),/food 5 of 6/],['unknown',bot(undefined,20),/health/]]){
  const r=portReady(b);assert.equal(r.ready,false,why);assert.match(r.reason,re,why)
 }
})
// Lab run 156, 15 October: the blazes the slit shot fell in a sealed room beside the hut,
// with three more still in it. On a trip the bot walks for what they dropped only once no
// shooter has been near for a minute, on 16 health or more, and only to kills within eight
// blocks of the hut.
test('on a trip the rods are walked for only after a quiet minute, on 16 health, and within eight blocks of the hut',()=>{
 const now=1e6,hut={x:0,y:64,z:0},near={at:{x:5.5,y:62,z:.5}},far={at:{x:12.5,y:64,z:.5}}
 assert.deepEqual(tripPickup({health:16,shooterSeenAt:now-60000,now,hut,sites:[near,far]}),{ok:true,sites:[near]})
 assert.deepEqual(tripPickup({health:20,now,hut,sites:[near]}).sites,[near],'no shooter seen at all')
 for(const [why,args,re] of [
  ['a shooter seen 59 s ago',{health:20,shooterSeenAt:now-59000},/shooter .*59 seconds/],
  ['hurt',{health:15},/health 15 of 16/],
  ['nothing near the hut',{health:20,sites:[far]},/within 8 blocks of the hut/],
  ['burning',{health:20,onFire:true},/on fire/]]){
  const r=tripPickup({now,hut,sites:[near,far],...args});assert.equal(r.ok,false,why);assert.match(r.reason,re,why);assert.deepEqual(r.sites,[],why)
 }
})
// Review of the above: a trip's kills and the last shooter seen belong to the dimension they
// were in. Through a portal, either way, both are dropped.
test('a dimension change drops the trip\'s kills and the last shooter seen, and keeps other kills',()=>{
 const {bot,r,c}=tripTeammate({})
 r.emit('event',{type:'spawn'})
 const trip={at:{x:5.5,y:64,z:.5},time:Date.now(),trip:true},home={at:{x:1,y:64,z:1},time:Date.now()}
 c.killSites=[trip,home];c.shooterSeenAt=Date.now()
 r.emit('event',{type:'spawn'})
 assert.deepEqual(c.killSites,[trip,home],'the same dimension keeps them')
 bot.game.dimension='minecraft:overworld';r.emit('event',{type:'spawn'})
 assert.deepEqual(c.killSites,[home]);assert.equal(c.shooterSeenAt,null)
 clearInterval(c.dawnTimer)
})
