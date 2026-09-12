import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {Vec3} from 'vec3'
import minecraftData from 'minecraft-data'
import {fleeTarget,fleeFrom,validateFleeGoal} from '../src/flee.js'
import {executeSkill} from '../src/skills.js'
import {validateTaskGoal} from '../src/task-store.js'
import {Teammate} from '../src/companion/controller.js'
import {THREAT_INTERRUPTION} from '../src/survival.js'
const registry=minecraftData('1.21.4')
test('the flee target lies directly away from the threat at the requested distance',()=>{
 assert.deepEqual(fleeTarget({x:0,z:0},{x:-6,z:0},24),{x:24,z:0})
 assert.deepEqual(fleeTarget({x:10,z:10},{x:10,z:10.2},8),{x:10,z:2})
 assert.deepEqual(validateTaskGoal('flee',{from:{x:1,y:64,z:2},distance:24}),{from:{x:1,y:64,z:2},distance:24})
 assert.throws(()=>validateFleeGoal({from:{x:1,y:64}}),/threat position/);assert.throws(()=>validateFleeGoal({from:{x:1,y:64,z:2},distance:4}),/8–48/)
})
test('fleeing sprints to an XZ goal away from the threat and reports the distance gained',async()=>{
 let goal,sprint=[],moves
 const bot={registry,food:20,entity:{position:new Vec3(0.5,64,0),onGround:true},setControlState:(k,v)=>sprint.push([k,v]),
  pathfinder:{setMovements(m){moves??=m},setGoal(){},async goto(g){goal=g;bot.entity.position=new Vec3(g.x+.5,64,g.z)}}}
 const result=await executeSkill(bot,{kind:'flee',goal:{from:{x:-5,y:64,z:0},distance:24}},{check(){},stage(){},progress(){},persist(){},movements:{}})
 assert.deepEqual([goal.x,goal.z],[25,0]);assert.equal(moves.allowSprinting,true);assert.deepEqual(sprint,[['sprint',true],['sprint',false]])
 assert.equal(result.receipt,'fled');assert.equal(result.gained,25)
 bot.food=5;await assert.rejects(fleeFrom(bot,{kind:'flee',goal:{from:{x:-5,y:64,z:0}}},{check(){},stage(){},progress(){}}),/hungry/)
})
test('an unarmed bot sprints clear of a creeper before digging in',async()=>{
 const bot={registry,game:{gameMode:'survival',difficulty:'normal'},time:{timeOfDay:15000},health:20,food:20,players:{},entity:{position:new Vec3(10.5,64,10.5),onGround:true},inventory:{items:()=>[]},
  entities:{1:{id:1,name:'creeper',type:'hostile',position:new Vec3(22.5,64,10.5)}},blockAt:()=>({name:'dirt',boundingBox:'block'})}
 const runner=new EventEmitter();runner.bot=bot;runner.ready=true;runner.connectionId='c1';runner.profile='p';runner.owner='Sov'
 const commands=[]
 runner.command=c=>{commands.push(c.action);if(c.action==='stop')return;runner.task={id:String(commands.length),kind:c.action,status:'running'}
  if(c.action==='flee')bot.entities={}
  const result=c.action==='flee'?{receipt:'fled',gained:24}:c.action==='burrow'?{receipt:'burrowed_capped',shelterName:'burrow',surface:{x:10,y:64,z:10}}:c.action==='unburrow'?{receipt:'surfaced'}:{}
  setTimeout(()=>{runner.task={...runner.task,status:'completed',result};runner.emit('event',{type:'task_finished',task:runner.task})},1)}
 runner.waitForIdle=async()=>{};runner.position=()=>({x:10,y:64,z:10})
 const said=[]
 const c={runner,projects:{},epoch:1,abort:null,phase:'acting',activity:'',requestProgress:{id:'r1',status:'running',feedback:[],completed:[]},safety:null,burrowWait:{quietMs:20,limitMs:2000},
  say:t=>said.push(t),persist(){},emit(){},cancel(){},interrupt(){this.requestProgress.status='interrupted'},dispatch(cmd){runner.command(cmd)},
  execute:Teammate.prototype.execute,leaveOccupiedShelter:async()=>{},seekSafety:Teammate.prototype.seekSafety,lastResortShelter:Teammate.prototype.lastResortShelter,moveOutOfDanger:Teammate.prototype.moveOutOfDanger,leaveOnOpenGround:Teammate.prototype.leaveOnOpenGround,waitInBurrow:Teammate.prototype.waitInBurrow,async resume(){this.requestProgress.status='running'}}
 const started=c.seekSafety(THREAT_INTERRUPTION);await new Promise(r=>setTimeout(r,300));bot.time.timeOfDay=6000;await started
 assert.deepEqual(commands.filter(a=>a!=='stop'),['flee','burrow','unburrow'])
 assert.ok(said.some(t=>/creeper is 12 blocks away/i.test(t)),said.join(' | '))
})
test('in daylight a lone zombie the bot cannot strike is left behind on open ground, and the request continues without digging in',async()=>{
 const bot={registry,game:{gameMode:'survival',difficulty:'normal'},time:{timeOfDay:6000},health:20,food:20,players:{},entity:{position:new Vec3(10.5,64,10.5),onGround:true},inventory:{items:()=>[]},
  entities:{1:{id:1,name:'zombie',type:'hostile',position:new Vec3(16.5,64,10.5)}},blockAt:()=>({name:'dirt',boundingBox:'block'})}
 const runner=new EventEmitter();runner.bot=bot;runner.ready=true;runner.connectionId='c1';runner.profile='p';runner.owner='Sov'
 const commands=[]
 runner.command=c=>{commands.push(c.action);if(c.action==='stop')return;runner.task={id:String(commands.length),kind:c.action,status:'running'}
  if(c.action==='flee')bot.entities={}
  const result=c.action==='flee'?{receipt:'fled',gained:24}:{}
  setTimeout(()=>{runner.task={...runner.task,status:'completed',result};runner.emit('event',{type:'task_finished',task:runner.task})},1)}
 runner.waitForIdle=async()=>{};runner.position=()=>({x:10,y:64,z:10})
 const said=[];let resumed=0
 const c={runner,projects:{},epoch:1,abort:null,phase:'acting',activity:'',requestProgress:{id:'r1',status:'running',feedback:[],completed:[]},safety:null,openGroundWait:{quietMs:20,limitMs:2000},
  say:t=>said.push(t),persist(){},emit(){},cancel(){},interrupt(){this.requestProgress.status='interrupted'},dispatch(cmd){runner.command(cmd)},
  execute:Teammate.prototype.execute,leaveOccupiedShelter:async()=>{},seekSafety:Teammate.prototype.seekSafety,lastResortShelter:Teammate.prototype.lastResortShelter,moveOutOfDanger:Teammate.prototype.moveOutOfDanger,leaveOnOpenGround:Teammate.prototype.leaveOnOpenGround,waitInBurrow:Teammate.prototype.waitInBurrow,async resume(){resumed++;this.requestProgress.status='running'}}
 await c.seekSafety(THREAT_INTERRUPTION)
 assert.deepEqual(commands.filter(a=>a!=='stop'),['flee'])
 assert.equal(resumed,1);assert.equal(c.requestProgress.safetyContinuations[0].shelter,'open_ground');assert.equal(c.safety,null)
 assert.ok(said.some(t=>/lone zombie 6 blocks away that I cannot strike. Moving to open ground/.test(t)),said.join(' | '))
 assert.ok(said.some(t=>/stayed behind in daylight. I am continuing/.test(t)),said.join(' | '))
 // The same zombie following into the open sends the bot to shelter instead.
 const followed=[];bot.time.timeOfDay=6000;bot.entities={1:{id:1,name:'zombie',type:'hostile',position:new Vec3(16.5,64,10.5)}}
 runner.command=c=>{followed.push(c.action);if(c.action==='stop')return;runner.task={id:String(followed.length),kind:c.action,status:'running'}
  const result=c.action==='flee'?{receipt:'fled',gained:24}:c.action==='burrow'?{receipt:'burrowed_capped',shelterName:'burrow',surface:{x:10,y:64,z:10}}:c.action==='unburrow'?{receipt:'surfaced'}:{}
  setTimeout(()=>{runner.task={...runner.task,status:'completed',result};runner.emit('event',{type:'task_finished',task:runner.task})},1)}
 c.requestProgress={id:'r2',status:'running',feedback:[],completed:[]};c.safety=null;c.burrowWait={quietMs:20,limitMs:1500,patienceMs:100}
 const started=c.seekSafety(THREAT_INTERRUPTION);await new Promise(r=>setTimeout(r,2500));bot.entities={};await started
 assert.deepEqual(followed.filter(a=>a!=='stop'),['flee','burrow','unburrow'],followed.join(','))
 assert.ok(said.some(t=>/followed me into the open/.test(t)),said.join(' | '))
})
