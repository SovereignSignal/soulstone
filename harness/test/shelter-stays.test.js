import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {THREAT_INTERRUPTION} from '../src/survival.js'
import {insideBase} from '../src/retreat.js'
import {Teammate} from '../src/companion/controller.js'
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
test('killed at night, the bot comes back at daylight instead of empty-handed into the dark',()=>{
 // Lab, 2 October: respawned at night onto a spawn point a zombie villager was
 // standing on, three times, with nothing in its hands.
 const {r,c,bot}=world(new Vec3(30.5,64,30.5));c.projects={};bot.entities={};bot.time.timeOfDay=18000
 c.phase='blocked';c.requestProgress={id:'d',request:'mine iron',status:'blocked'}
 let respawns=0;r.respawn=()=>{respawns++;r.respawnPending=true}
 bot.health=0;bot.isAlive=false;r.emit('event',{type:'death'})
 assert.equal(respawns,0,'not into the night');assert.match(c.messages.at(-1).text,/daylight/)
 r.emit('event',{type:'survival_tick'});assert.equal(respawns,0)
 bot.time.timeOfDay=1200;r.emit('event',{type:'survival_tick'});assert.equal(respawns,1,'at daylight it brings itself back')
 r.emit('event',{type:'survival_tick'});assert.equal(respawns,1,'once')
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
