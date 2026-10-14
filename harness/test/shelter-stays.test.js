import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {THREAT_INTERRUPTION} from '../src/survival.js'
import {insideBase} from '../src/retreat.js'
import {Teammate,topUpWhileSheltered,eatAfterPortalEscape,STOP_HOLD_MS} from '../src/companion/controller.js'
const registry=minecraftData('1.21.4')
// Lab, 2 October 2026, Normal difficulty at night: inside its lit base with a
// creeper 2.8 blocks away beyond the door, the bot answered the threat with
// "sprinting clear", and every action first walked it out of the base. It
// opened the door, met the creeper and died three seconds later.
const design=[]
for(let x=0;x<4;x++)for(let z=0;z<4;z++)for(let y=0;y<3;y++)if((y===2||x===0||x===3||z===0||z===3)&&!(x===1&&z===0&&y<2))design.push({x,y,z,block:'cobblestone'})
const base=()=>({build:{origin:{x:0,y:64,z:0},near:{x:0,y:64,z:0},purpose:'shelter',design},stations:{torch:{position:{x:2,y:64,z:2},confirmed:true}},built:true})
function world(position){
 const shell=new Set(design.map(b=>`${b.x},${b.y+64},${b.z}`))
 const bot={registry,username:'SoulStone303',game:{gameMode:'survival',difficulty:'normal',dimension:'overworld'},time:{timeOfDay:18000},health:20,food:20,oxygenLevel:20,players:{},
  entity:{position,onGround:true,eyeHeight:1.62,isInWater:false,metadata:[0]},inventory:{items:()=>[]},
  entities:{1:{id:1,name:'creeper',position:new Vec3(1.5,64,-1.3)}},
  blockAt:p=>{const name=p.y<64||shell.has(`${p.x},${p.y},${p.z}`)?'cobblestone':'air';return {name,position:p,boundingBox:name==='air'?'empty':'block',getProperties:()=>({})}},
  world:{raycast:()=>({name:'cobblestone'})},clearControlStates(){},setControlState(){}}
 const r=new EventEmitter();Object.assign(r,{profile:'lab',owner:'Sov',ready:true,connectionId:'c1',bot,commands:[],position:()=>({x:position.x,y:position.y,z:position.z}),waitForIdle:async()=>{}})
 r.command=c=>{r.commands.push(c.action);if(c.action==='stop')return
  r.task={id:String(r.commands.length),kind:c.action,status:'running'}
  setTimeout(()=>{r.task={...r.task,status:'completed',result:c.action==='retreat'?{item:'safety',count:1,receipt:'sheltered_door_closed'}:{item:'safety',count:1,receipt:c.action}};r.emit('event',{type:'task_finished',task:r.task})},1)}
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-stays-')),'state.json'))
 c.projects.base=base()
 return {r,c,bot}
}
test('inside the base with a creeper at the door, safety closes up and stays; it does not run out past it',async()=>{
 const {r,c,bot}=world(new Vec3(1.5,64,1.5))
 assert.equal(insideBase(bot,c.projects.base),true)
 await c.seekSafety(THREAT_INTERRUPTION)
 const acted=r.commands.filter(a=>a!=='stop')
 assert.ok(!acted.includes('leave_base'),`never leaves the base for a safety action: ${acted.join(',')}`)
 assert.ok(!acted.includes('flee'),`does not sprint from behind its own door: ${acted.join(',')}`)
 assert.deepEqual(acted,['retreat']);assert.equal(c.safety.status,'sheltered')
})
test('outside the base the creeper sprint and the walk home are unchanged',async()=>{
 const {r,c}=world(new Vec3(8.5,64,-6.5))
 await c.seekSafety(THREAT_INTERRUPTION)
 const acted=r.commands.filter(a=>a!=='stop')
 assert.equal(acted[0],'flee');assert.ok(acted.includes('retreat'))
})
test('a safety action issued from inside any shelter never walks out of it first',async()=>{
 for(const action of ['flee','hut','climb','descend','burrow','defend']){
  const {r,c}=world(new Vec3(1.5,64,1.5))
  await c.executeCommand({action,goal:action==='flee'?{from:{x:1.5,y:64,z:-1.3},distance:24}:{},timeoutMs:5000},new AbortController().signal)
  assert.deepEqual(r.commands,[action],action)
 }
 const work=world(new Vec3(1.5,64,1.5));work.bot.time.timeOfDay=6000;work.bot.entities={}
 await work.c.executeCommand({action:'goto',goal:{x:20,y:64,z:20},timeoutMs:5000},new AbortController().signal)
 assert.deepEqual(work.r.commands,['leave_base','goto'],'ordinary work still leaves by the checked door, by day')
})
test('a base whose blocks have not arrived after login is not a destroyed base',()=>{
 // After a restart the lab bot stood in its base while the base read as
 // "missing or changed: unloaded". That made it unsheltered, the creeper beyond
 // the wall became an emergency, and the response walked it out to die.
 const {r,c,bot}=world(new Vec3(1.5,64,1.5)),loaded=bot.blockAt
 bot.blockAt=p=>p.y>=64&&p.y<=66&&p.x>=0&&p.x<=3&&p.z>=0&&p.z<=3?null:loaded(p)
 const calls=[];c.seekSafety=async why=>{calls.push(why);c.safety={status:'retreating',reason:why}}
 r.emit('event',{type:'survival_tick'});assert.deepEqual(calls,[],'unknown for now, neither a threat indoors nor a night with no shelter')
 c.unloadedSince=Date.now()-21000
 r.emit('event',{type:'survival_tick'});assert.equal(calls.length,1,'blocks that never arrive stop being an excuse')
})
test('with no shelter to reach and hostiles already close, safety runs before it digs',async()=>{
 // Lab death, 2 October 18:44Z: two zombies at 2.7 and 4.3 blocks, the base
 // wrecked, and the burrow started under their fists. Sixteen health in six seconds.
 const {r,c,bot}=world(new Vec3(30.5,64,30.5));c.projects={}
 bot.entities={1:{id:1,name:'zombie',position:new Vec3(33.2,64,30.5)},2:{id:2,name:'zombie',position:new Vec3(30.5,64,34.8)}}
 await c.seekSafety(THREAT_INTERRUPTION)
 const acted=r.commands.filter(a=>a!=='stop')
 assert.deepEqual(acted.slice(0,2),['flee','burrow'],acted.join(','))
 // Nothing within reach: dig in where it stands, as before.
 const far=world(new Vec3(30.5,64,30.5));far.c.projects={};far.bot.entities={1:{id:1,name:'zombie',position:new Vec3(39.5,64,30.5)},2:{id:2,name:'zombie',position:new Vec3(30.5,64,40)}}
 await far.c.seekSafety(THREAT_INTERRUPTION)
 assert.equal(far.r.commands.filter(a=>a!=='stop')[0],'burrow')
})
test('rebuilding a base lists the ground a crater took from under it instead of refusing the site',async()=>{
 // Lab, 2 October: the creeper at the door left air under the doorway, the
 // shelter builder refused the "unsupported approach", and nothing the planner
 // had could put the ground back.
 const {shelterLayout,inspectShelterSite}=await import('../src/shelter.js')
 const layout=shelterLayout(design),origin=new Vec3(0,64,0)
 const crater=new Set(['1,63,0','1,63,-1','1,63,-2'])
 const bot={blockAt:p=>{const name=p.y<64&&!crater.has(`${p.x},${p.y},${p.z}`)?'cobblestone':'air';return {name,position:p,boundingBox:name==='air'?'empty':'block'}}}
 assert.throws(()=>inspectShelterSite(bot,origin,layout,{repair:true}),/lacks support at/)
 const support=[];inspectShelterSite(bot,origin,layout,{repair:true,support})
 assert.deepEqual(support.map(p=>`${p.x},${p.y},${p.z}`).sort(),[...crater].sort())
 const intact={blockAt:p=>({name:p.y<64?'cobblestone':'air',position:p,boundingBox:p.y<64?'block':'empty'})},none=[]
 inspectShelterSite(intact,origin,layout,{repair:true,support:none});assert.deepEqual(none,[])
})
test('Stop holds for the situation it was given in, not for the rest of the night',()=>{
 // Lab, 2 October 19:27Z: stopped by its watcher in daylight, the bot stood idle
 // through dusk with safety switched off and a creeper blew it up.
 const {r,c,bot}=world(new Vec3(30.5,64,30.5));c.projects={};bot.entities={};bot.time.timeOfDay=6000
 const calls=[];c.seekSafety=async why=>{calls.push(why);c.safety={status:'retreating',reason:why}}
 c.stop();assert.equal(c.safety.status,'cancelled')
 r.emit('event',{type:'survival_tick'});assert.equal(c.safety,null,'nothing was wrong, so the stop has nothing left to hold')
 bot.time.timeOfDay=13000
 r.emit('event',{type:'survival_tick'});assert.deepEqual(calls,['Night with no shelter'])
 // Stopped in the middle of an emergency: the stop stands while that emergency lasts.
 const held=world(new Vec3(30.5,64,30.5));held.c.projects={};held.bot.entities={1:{id:1,name:'zombie',position:new Vec3(34.5,64,30.5)}}
 const again=[];held.c.seekSafety=async why=>{again.push(why)}
 held.c.stop();held.r.emit('event',{type:'survival_tick'});held.r.emit('event',{type:'survival_tick'})
 assert.deepEqual(again,[]);assert.equal(held.c.safety.status,'cancelled')
})
test('killed at night, the bot comes back at daylight instead of empty-handed into the dark',async()=>{
 // Lab, 2 October: respawned at night onto a spawn point a zombie villager was
 // standing on, three times, with nothing in its hands. A dead player gets no
 // physics ticks, so this test sends none (pi2, 9 October).
 const wait=ms=>new Promise(res=>setTimeout(res,ms))
 const {r,c,bot}=world(new Vec3(30.5,64,30.5));c.projects={};bot.entities={};bot.time.timeOfDay=18000;c.dawnPollMs=5
 c.phase='blocked';c.requestProgress={id:'d',request:'mine iron',status:'blocked'}
 let respawns=0;r.respawn=()=>{respawns++;r.respawnPending=true}
 bot.health=0;bot.isAlive=false;r.emit('event',{type:'death'})
 assert.equal(respawns,0,'not into the night');assert.match(c.messages.at(-1).text,/daylight/)
 await wait(30);assert.equal(respawns,0)
 bot.time.timeOfDay=1200;await wait(30);assert.equal(respawns,1,'at daylight it brings itself back')
 await wait(30);assert.equal(respawns,1,'once')
 const day=world(new Vec3(30.5,64,30.5));day.c.projects={};day.bot.time.timeOfDay=6000
 day.c.phase='blocked';day.c.requestProgress={id:'d',request:'mine iron',status:'blocked'}
 let now=0;day.r.respawn=()=>{now++;day.r.respawnPending=true};day.bot.health=0;day.bot.isAlive=false;day.r.emit('event',{type:'death'})
 assert.equal(now,1,'in daylight the drop pile is worth going straight back for')
})
test('indoors at night with the work unfinished is a wait for daylight, not a stall to retry',async()=>{
 // Lab run 15, 2 October: asked to use the base at night, the planner stopped
 // with "Goal still incomplete... it is night". The stall retry restarted it
 // every ninety seconds to hear the same answer, and after three the request
 // was dead before dawn.
 const {r,c,bot}=world(new Vec3(1.5,64,1.5));bot.entities={}
 let resumes=0;c.resume=async()=>{resumes++};c.phase='blocked'
 c.requestProgress={id:'d',request:'mine iron',status:'blocked',blocker:'Goal still incomplete. It is night.'}
 c.blockedSince=1;assert.equal(await c.stallRetry(),false);c.blockedSince=1;await c.stallRetry()
 assert.equal(resumes,0);assert.equal(c.requestProgress.stallContinuations,undefined,'the night spends none of the retry budget')
 assert.equal(c.messages.filter(m=>/daylight/.test(m.text)).length,1,'and it says so once')
 bot.time.timeOfDay=1500;c.blockedSince=1
 assert.equal(await c.stallRetry(),true);assert.equal(resumes,1,'at daylight it picks the request back up')
 // Blocked outdoors or underground at night is still an ordinary stall.
 const out=world(new Vec3(30.5,64,30.5));out.bot.entities={};let again=0;out.c.resume=async()=>{again++};out.c.phase='blocked'
 out.c.requestProgress={id:'e',request:'mine iron',status:'blocked',blocker:'No path'};out.c.blockedSince=1
 await out.c.stallRetry();assert.equal(again,1)
})
test('work does not leave the base with dusk a minute away; by day it leaves as before',async()=>{
 // Lab run 15, 2 October 20:19Z: the bot stepped out to the furnace at dusk,
 // eighteen blocks from the door, and met a zombie and a skeleton on the way.
 const late=world(new Vec3(1.5,64,1.5));late.bot.time.timeOfDay=11600;late.bot.entities={}
 await assert.rejects(late.c.executeCommand({action:'goto',goal:{x:20,y:64,z:20},timeoutMs:5000},new AbortController().signal),/daylight/)
 assert.deepEqual(late.r.commands,[],'it stays behind the door')
 const night=world(new Vec3(1.5,64,1.5));night.bot.time.timeOfDay=15000;night.bot.entities={}
 await assert.rejects(night.c.executeCommand({action:'smelt',goal:{},timeoutMs:5000},new AbortController().signal),/daylight/)
 const day=world(new Vec3(1.5,64,1.5));day.bot.time.timeOfDay=6000;day.bot.entities={}
 await day.c.executeCommand({action:'goto',goal:{x:20,y:64,z:20},timeoutMs:5000},new AbortController().signal)
 assert.deepEqual(day.r.commands,['leave_base','goto'])
 const out=world(new Vec3(30.5,64,30.5));out.bot.time.timeOfDay=11600
 await out.c.executeCommand({action:'goto',goal:{x:20,y:64,z:20},timeoutMs:5000},new AbortController().signal)
 assert.deepEqual(out.r.commands,['goto'],'outside the base nothing changes; the safety rules own dusk there')
})
test('the door does not open for work onto a hostile inside its interruption radius, and waiting on it spends no retry budget',async()=>{
 // Lab run 16, 2 October 23:48Z: at sunrise the retry restarted the planner,
 // the bot walked out past a creeper at 13 blocks and skeletons at 14, and was
 // interrupted ten seconds later. Same loop as the wait, through another door.
 const {r,c,bot}=world(new Vec3(1.5,64,1.5));bot.time.timeOfDay=6000
 bot.entities={1:{id:1,name:'creeper',position:new Vec3(10,64,10)}}
 await assert.rejects(c.executeCommand({action:'goto',goal:{x:20,y:64,z:20},timeoutMs:5000},new AbortController().signal),/creeper/)
 assert.deepEqual(r.commands,[])
 let resumes=0;c.resume=async()=>{resumes++};c.phase='blocked';c.requestProgress={id:'d',request:'mine iron',status:'blocked',blocker:'A creeper is outside'}
 c.blockedSince=1;assert.equal(await c.stallRetry(),false);assert.equal(c.requestProgress.stallContinuations,undefined)
 bot.entities={};c.blockedSince=1;assert.equal(await c.stallRetry(),true);assert.equal(resumes,1,'gone, and the work resumes')
 const zombie=world(new Vec3(1.5,64,1.5));zombie.bot.time.timeOfDay=6000;zombie.bot.entities={1:{id:1,name:'zombie',position:new Vec3(10,64,10)}}
 await zombie.c.executeCommand({action:'goto',goal:{x:20,y:64,z:20},timeoutMs:5000},new AbortController().signal)
 assert.deepEqual(zombie.r.commands,['leave_base','goto'],'a zombie at 12 is outside its ten-block radius')
})
test('down the back exit, work starts without the door and the night hold does not apply',async()=>{
 // The back exit (back-exit-plan.md) puts the bot at the bottom of a shaft
 // under its own floor. From there a work action must not walk back up to a
 // door the night refuses, and a stall there is an ordinary stall.
 const {r,c,bot}=world(new Vec3(1.5,58,2.5));bot.entities={};bot.time.timeOfDay=18000
 c.projects.base.backExit={cell:{x:1,y:64,z:2},bottom:56}
 assert.equal(insideBase(bot,c.projects.base),true,'the shaft still counts as the base for safety')
 await c.executeCommand({action:'goto',goal:{x:20,y:58,z:20,dig:true},timeoutMs:5000},new AbortController().signal)
 assert.deepEqual(r.commands,['goto'],'no leave_base, no dusk refusal: the work goes on through rock')
 let resumes=0;c.resume=async()=>{resumes++};c.phase='blocked'
 c.requestProgress={id:'f',request:'mine iron',status:'blocked',blocker:'No path'};c.blockedSince=1
 assert.equal(await c.stallRetry(),true);assert.equal(resumes,1,'a stall at the shaft bottom at night retries like any other')
 // Standing on the shaft cell at floor level is still behind the door.
 const up=world(new Vec3(1.5,64,2.5));up.bot.entities={};up.bot.time.timeOfDay=18000;up.c.projects.base.backExit={cell:{x:1,y:64,z:2},bottom:56}
 await assert.rejects(up.c.executeCommand({action:'goto',goal:{x:20,y:64,z:20},timeoutMs:5000},new AbortController().signal),/Dusk is here/)
})
test('the planner\'s own leave_base step meets the same refusals as the automatic exit',async()=>{
 // Lab run 17, 3 October 00:42 UTC: at 15500 with a spider six blocks out, the
 // planner chose leave_base itself. That step was exempt from the automatic
 // departure, and the dusk and hostile refusals lived only there.
 const night=world(new Vec3(1.5,64,1.5));night.bot.entities={};night.bot.time.timeOfDay=15500
 await assert.rejects(night.c.executeCommand({action:'leave_base',goal:{project:night.c.projects.base},timeoutMs:5000},new AbortController().signal),/Dusk is here.*tunnel_out/)
 assert.deepEqual(night.r.commands,[],'the door never opened')
 const camped=world(new Vec3(1.5,64,1.5));camped.bot.time.timeOfDay=6000 // creeper 2.8 blocks out, from the fixture
 await assert.rejects(camped.c.executeCommand({action:'leave_base',goal:{project:camped.c.projects.base},timeoutMs:5000},new AbortController().signal),/creeper.*interruption radius/)
 assert.deepEqual(camped.r.commands,[])
 const day=world(new Vec3(1.5,64,1.5));day.bot.entities={};day.bot.time.timeOfDay=6000
 await day.c.executeCommand({action:'leave_base',goal:{project:day.c.projects.base},timeoutMs:5000},new AbortController().signal)
 assert.deepEqual(day.r.commands,['leave_base'],'by day with nothing pressing it leaves as before')
 const outside=world(new Vec3(30.5,64,30.5));outside.bot.entities={};outside.bot.time.timeOfDay=15500
 await outside.c.executeCommand({action:'leave_base',goal:{project:outside.c.projects.base},timeoutMs:5000},new AbortController().signal)
 assert.deepEqual(outside.r.commands,['leave_base'],'not inside anything, there is no door to refuse')
})

test('with a back exit, the indoor hold gives the planner one round first; a second stall then holds',async()=>{
 // Lab run 29, 3 October: after a safety retreat the bot held indoors by day
 // on a skeleton twelve blocks out, and the planner never got the round in
 // which runs 24 to 27 had chosen tunnel_out.
 const {r,c,bot}=world(new Vec3(1.5,64,1.5));bot.time.timeOfDay=6000 // creeper 2.8 blocks out, from the fixture
 c.projects.base.backExit={cell:{x:1,y:64,z:2}}
 let resumes=0;c.resume=async()=>{resumes++};c.phase='blocked'
 c.requestProgress={id:'g',request:'mine iron',status:'blocked',blocker:'Safety interruption'};c.blockedSince=Date.now()
 assert.equal(await c.stallRetry(),true);assert.equal(resumes,1,'one round for the planner, at once');assert.equal(c.requestProgress.stallContinuations,0,'it spends no stall budget')
 assert.ok(c.messages.some(m=>/back exit/.test(m.text)))
 c.phase='blocked';c.blockedSince=1
 assert.equal(await c.stallRetry(),false);assert.equal(resumes,1,'the second stall holds as before');assert.equal(c.messages.filter(m=>/moved on/.test(m.text)).length,1)
 // The hostile gone, the hold clears and the next hold would ask again.
 bot.entities={};c.blockedSince=1;assert.equal(await c.stallRetry(),true);assert.equal(resumes,2);assert.equal(c.backExitAsked,false)
 // Without a back exit the hold is unchanged.
 const plain=world(new Vec3(1.5,64,1.5));plain.bot.time.timeOfDay=6000;let again=0;plain.c.resume=async()=>{again++};plain.c.phase='blocked'
 plain.c.requestProgress={id:'h',request:'mine iron',status:'blocked',blocker:'x'};plain.c.blockedSince=1
 assert.equal(await plain.c.stallRetry(),false);assert.equal(again,0)
})

test('a hostile sealed off from the door does not hold it shut; one with a route to the doorstep still does',async()=>{
 // Lab run 32, 3 October: the camping creeper gone and daylight up, skeletons
 // sealed in caves under the base kept "staying in until it moves on" going.
 const {r,c,bot}=world(new Vec3(1.5,64,1.5));bot.time.timeOfDay=6000
 bot.entities={1:{id:1,name:'skeleton',position:new Vec3(1.5,56,10.5)}} // eight blocks out, eight down, in rock
 await c.executeCommand({action:'goto',goal:{x:20,y:64,z:20},timeoutMs:5000},new AbortController().signal)
 assert.deepEqual(r.commands,['leave_base','goto'],'sealed under the ground, it is not at the door')
 const camped=world(new Vec3(1.5,64,1.5));camped.bot.time.timeOfDay=6000 // the fixture's creeper, 2.8 blocks past the door in the open
 await assert.rejects(camped.c.executeCommand({action:'goto',goal:{x:20,y:64,z:20},timeoutMs:5000},new AbortController().signal),/creeper.*interruption radius/)
 assert.deepEqual(camped.r.commands,[])
})

// Lab run 138, 13 October: a creeper, a zombie and a spider by the door in daylight, and
// the bot, with a bow, 128 arrows and full iron, held in its base in silence through a
// whole day. A lone camper the melee rules engage is fought; anything else holds with the
// reason repeated, and after fifteen minutes of daylight the planner gets a round.
test('by day a lone camper the melee rules engage is fought from the base; a creeper holds, is said again, and ends in a planner round after fifteen minutes',async()=>{
 const {r,c,bot}=world(new Vec3(1.5,64,1.5));bot.time.timeOfDay=6000
 const sword={name:'iron_sword',count:1,maxDurability:250,durabilityUsed:0,slot:36};bot.inventory={items:()=>[sword],slots:[]}
 bot.entities={1:{id:1,uuid:'10000000-0000-0000-0000-000000000001',type:'mob',name:'zombie',position:new Vec3(1.5,64,-1.3)}}
 let sought=[];c.seekSafety=async reason=>{sought.push(reason)};c.phase='blocked'
 c.requestProgress={id:'z',request:'mine iron',status:'blocked',blocker:'x'};c.blockedSince=1
 assert.equal(await c.stallRetry(),true);assert.deepEqual(sought,[THREAT_INTERRUPTION],'the zombie is fought, through the door')
 assert.ok(c.messages.some(m=>/It is daylight and I can fight it/.test(m.text)),c.messages.map(m=>m.text).join(' | '))
 // The fixture's creeper: not fightable by the rules, so a hold, said once, then again after ten minutes.
 const held=world(new Vec3(1.5,64,1.5));held.bot.time.timeOfDay=6000;let resumes=0;held.c.resume=async()=>{resumes++};held.c.phase='blocked'
 held.c.requestProgress={id:'c',request:'mine iron',status:'blocked',blocker:'x'};held.c.blockedSince=1
 assert.equal(await held.c.stallRetry(),false);assert.equal(held.c.messages.filter(m=>/moved on/.test(m.text)).length,1)
 assert.equal(await held.c.stallRetry(),false);assert.equal(held.c.messages.filter(m=>/moved on/.test(m.text)).length,1,'not repeated at once')
 held.c.holdSaidAt=Date.now()-11*60*1000;assert.equal(await held.c.stallRetry(),false);assert.equal(held.c.messages.filter(m=>/moved on/.test(m.text)).length,2,'said again after ten minutes')
 held.c.dayHoldSince=Date.now()-16*60*1000;held.c.phase='blocked'
 assert.equal(await held.c.stallRetry(),true);assert.equal(resumes,1,'after fifteen minutes of daylight the planner gets a round')
 assert.ok(held.c.messages.some(m=>/Asking the planner what to do about it/.test(m.text)))
})

test('hurt in a shelter below healing hunger, it eats what it carries, at most every 30 seconds',async()=>{
 const eaten=[],fake={runner:{task:null,log(){}},execute:async c=>{eaten.push(c.goal)},topUpAt:0}
 const bot={health:12,food:17,game:{gameMode:'survival',difficulty:'normal'},inventory:{items:()=>[{name:'sweet_berries',count:9}]},entity:{position:new Vec3(0,64,0)},entities:{},blockAt:()=>null,registry}
 await topUpWhileSheltered(fake,null,bot)
 assert.deepEqual(eaten,[{item:'sweet_berries',count:8}])
 await topUpWhileSheltered(fake,null,bot);assert.equal(eaten.length,1,'not again within 30 seconds')
 fake.topUpAt=0;bot.food=18;await topUpWhileSheltered(fake,null,bot);assert.equal(eaten.length,1,'hunger 18 already heals')
 bot.food=10;bot.health=20;await topUpWhileSheltered(fake,null,bot);assert.equal(eaten.length,1,'at full health there is nothing to heal')
 bot.health=12;fake.runner.task={status:'running'};await topUpWhileSheltered(fake,null,bot);assert.equal(eaten.length,1,'never over a running task')
})

// Lab run 120, 13 October: home through the portal at 4.5 health and hunger 17 with
// 16 cooked beef carried, the bot walked 30 blocks to the base without healing (hunger
// below 18 heals nothing) and a spider killed it two blocks from the door.
test('back through the portal hurt, it eats to full hunger before the walk home, unless a melee mob is close',async()=>{
 const eaten=[],fake={runner:{task:null,log(){}},execute:async c=>{eaten.push(c.goal)}}
 const bot={health:4.5,food:17,game:{gameMode:'survival',difficulty:'normal'},inventory:{items:()=>[{name:'cooked_beef',count:16}]},entity:{position:new Vec3(0,64,0)},entities:{1:{id:1,name:'skeleton',position:new Vec3(13,64,0)}},blockAt:()=>null,registry}
 assert.equal(await eatAfterPortalEscape(fake,null,bot),true)
 assert.deepEqual(eaten,[{item:'cooked_beef',count:2}],'two bites at most: enough for full hunger, short enough to keep walking')
 bot.entities[2]={id:2,name:'spider',position:new Vec3(2.2,64,0)};bot.time={timeOfDay:13000}
 assert.equal(await eatAfterPortalEscape(fake,null,bot),false);assert.equal(eaten.length,1,'a melee mob within reach comes first')
 delete bot.entities[2];bot.food=20;assert.equal(await eatAfterPortalEscape(fake,null,bot),false,'full hunger already heals fastest')
 bot.food=17;bot.health=20;assert.equal(await eatAfterPortalEscape(fake,null,bot),false,'nothing to heal')
 bot.health=4.5;fake.execute=async()=>{throw new Error('Eating interrupted')}
 assert.equal(await eatAfterPortalEscape(fake,null,bot),false,'a failed bite is not a failed escape')
 const src=readFileSync(new URL('../src/companion/controller.js',import.meta.url),'utf8')
 // Every crossing safety makes (portal home, portal home again, relocating out of a shelter) eats after it.
 const crossings=src.match(/this\.execute\(\{action:'use_portal',goal:\{\},timeoutMs:45000\}/g).length
 assert.equal(crossings,3);assert.equal(src.match(/await eatAfterPortalEscape\(this,/g).length,crossings,'wired after every safety crossing')
})

test('a Stop holds safety off for a minute, not for as long as the danger lasts',async()=>{
 const {r,c,bot}=world(new Vec3(30.5,64,30.5));bot.time.timeOfDay=18000
 c.stop();assert.equal(c.safety.status,'cancelled');assert.ok(Number.isFinite(c.safety.at))
 c.safety.at=Date.now()-STOP_HOLD_MS-1
 const reasons=[];c.seekSafety=async reason=>{reasons.push(reason)}
 r.emit('event',{type:'survival_tick'});await new Promise(res=>setTimeout(res,20))
 assert.notEqual(c.safety?.status,'cancelled','after the hold the cancelled record is gone, so the watch can act again')
 // Within the hold it stays off.
 c.stop();r.emit('event',{type:'survival_tick'});await new Promise(res=>setTimeout(res,20))
 assert.equal(c.safety?.status,'cancelled')
})

// Lab run 139, 13 October: the hold went out for a "zombie 7.4 blocks from the base" that
// stood in a dark pocket seven blocks under the floor. The door opened on nothing, the
// strike never came, the retreat shut the door and marked the request ready, and the bot
// sat silent for a hundred minutes with a skeleton and a creeper in the same pocket.
test('a failed fight from the base hands the hold back, and a camper under the floor is held, not fought',async()=>{
 const sword={name:'iron_sword',count:1,maxDurability:250,durabilityUsed:0,slot:36}
 const {r,c,bot}=world(new Vec3(1.5,64,1.5));bot.time.timeOfDay=6000;bot.inventory={items:()=>[sword],slots:[]}
 bot.entities={1:{id:1,uuid:'10000000-0000-0000-0000-000000000001',type:'mob',name:'zombie',position:new Vec3(1.5,64,-1.3)}}
 // The defense loop gives up without a strike; the retreat then closes the door as before.
 r.command=cmd=>{r.commands.push(cmd.action);if(cmd.action==='stop')return
  r.task={id:String(r.commands.length),kind:cmd.action,status:'running'}
  setTimeout(()=>{r.task=cmd.action==='defend'?{...r.task,status:'failed',reason:'Cannot reach a clear melee strike; retreat required'}:{...r.task,status:'completed',result:{item:'safety',count:1,receipt:'sheltered_door_closed'}};r.emit('event',{type:'task_finished',task:r.task})},1)}
 c.phase='blocked';c.requestProgress={id:'z',request:'mine iron',status:'blocked',blocker:'x'};c.blockedSince=1
 const original=c.seekSafety.bind(c);let settled;c.seekSafety=reason=>(settled=original(reason))
 assert.equal(await c.stallRetry(),true);await settled
 assert.deepEqual(r.commands.filter(a=>a!=='stop'),['defend','retreat'])
 assert.equal(c.safety.status,'sheltered');assert.equal(c.phase,'blocked','a resumable request is still blocked after the retreat, so the hold keeps running')
 // The hold runs again and the sheltered record does not stop the next fight.
 c.blockedSince=1;assert.equal(await c.stallRetry(),true);await settled
 assert.equal(r.commands.filter(a=>a==='defend').length,2,'fought again, not left to camp')
 // A zombie seven blocks under the doorstep, joined to it by a shaft: in reach, so a hold, never a fight.
 const cave=world(new Vec3(1.5,64,1.5));cave.bot.time.timeOfDay=6000;cave.bot.inventory={items:()=>[sword],slots:[]}
 const loaded=cave.bot.blockAt;cave.bot.blockAt=p=>p.x===1&&p.z===-1&&p.y>=57&&p.y<64?{name:'air',position:p,boundingBox:'empty',getProperties:()=>({})}:loaded(p)
 cave.bot.entities={1:{id:1,uuid:'10000000-0000-0000-0000-000000000001',type:'mob',name:'zombie',position:new Vec3(1.5,57,-0.7)}}
 const sought=[];cave.c.seekSafety=async reason=>{sought.push(reason)};cave.c.phase='blocked'
 cave.c.requestProgress={id:'u',request:'mine iron',status:'blocked',blocker:'x'};cave.c.blockedSince=1
 assert.equal(await cave.c.stallRetry(),false);assert.deepEqual(sought,[],'the defense loop would go down the shaft')
 assert.ok(cave.c.messages.some(m=>/below its floor/.test(m.text)&&/moved on/.test(m.text)),cave.c.messages.map(m=>m.text).join(' | '))
})

// Lab run 139, 13 October, after the fixes above: daylight came, the hold moved from the
// night to the creeper under the floor, and said nothing for ten minutes, because the
// night's "already said" flag throttled the new reason. A new reason is said at once.
test('a hold whose reason changes says the new reason at once; the same reason is still throttled',async()=>{
 const {c,bot}=world(new Vec3(1.5,64,1.5));bot.time.timeOfDay=18000;c.phase='blocked'
 c.requestProgress={id:'n',request:'mine iron',status:'blocked',blocker:'x'};c.blockedSince=1
 const said=re=>c.messages.filter(m=>re.test(m.text)).length
 assert.equal(await c.stallRetry(),false);assert.equal(said(/at daylight/),1)
 bot.time.timeOfDay=6000;assert.equal(await c.stallRetry(),false);assert.equal(said(/moved on/),1,'the creeper is named as soon as the night ends')
 assert.equal(await c.stallRetry(),false);assert.equal(said(/moved on/),1,'and not again at once')
 bot.time.timeOfDay=18000;assert.equal(await c.stallRetry(),false);assert.equal(said(/at daylight/),2,'dusk is said again too')
})
