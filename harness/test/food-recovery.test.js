import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Vec3} from 'vec3'
import {Teammate} from '../src/companion/controller.js'
import {FOOD_EMERGENCY} from '../src/survival.js'

function fixture(){
 let stock=2
 const runner=new EventEmitter();Object.assign(runner,{profile:'food-fixture',owner:'tester',ready:true,connectionId:'one',commands:[],position:()=>runner.bot.entity.position,
  command(c){this.emit('operator_command',c);this.task={id:'stop',kind:c.action,status:'cancelled'}},
  bot:{entity:{position:new Vec3(0,64,0),onGround:true},entities:{},players:{},health:17,food:5,time:{timeOfDay:3000},game:{gameMode:'survival',difficulty:'easy'},
   blockAt:p=>({name:p.y<64?'stone':'air',boundingBox:p.y<64?'block':'empty',position:p,getProperties:()=>({})}),inventory:{items:()=>stock?[{name:'sweet_berries',count:stock}]:[]}}})
 const c=new Teammate(runner,{model:'fixture'},join(mkdtempSync(join(tmpdir(),'mc-food-')),'state.json'))
 c.requestProgress={id:'saved',request:'recover food',status:'running',completed:[],feedback:[],pending:[]};let resumed=0,burrowEligible=null
 c.resume=async()=>resumed++
 c.waitInBurrow=async(epoch,signal,bot,eligible)=>{burrowEligible=eligible}
 c.execute=async cmd=>{
  runner.commands.push(cmd.action)
  if(cmd.action==='eat'){stock=0;runner.bot.food=9;runner.task={result:{receipt:'food_consumption_verified',item:'sweet_berries',count:2,food:9}}}
  else if(cmd.action==='burrow')runner.task={result:{shelterName:'burrow',capped:true,surface:{x:0,y:64,z:0}}}
  else throw Error('Unexpected recovery action: '+cmd.action)
 }
 return {runner,c,resumed:()=>resumed,burrowEligible:()=>burrowEligible}
}
function enclose(bot){
 bot.registry={blocksByName:{stone:{boundingBox:'block',diggable:true}},blockCollisionShapes:{blocks:{stone:1},shapes:{1:[[0,0,0,1,1,1]]}}}
 bot.blockAt=p=>({name:p.x===0&&p.z===0&&p.y>=64&&p.y<=66?'air':'stone',position:p,getProperties:()=>({})})
}
test('critical hunger eats on clear daylight ground and resumes the original request without building a shelter',async()=>{
 const {runner,c,resumed}=fixture();const request=c.requestProgress
 await c.seekSafety(FOOD_EMERGENCY)
 assert.deepEqual(runner.commands,['eat']);assert.equal(resumed(),1);assert.equal(c.requestProgress,request)
 assert.equal(request.safetyContinuations[0].shelter,'fed_on_clear_ground');assert.equal(request.feedback.find(f=>f.action==='eat').result.food,9)
 assert.equal(request.status,'interrupted');assert.equal(c.safety,null)
})
test('food recovery preserves continuation caps and manual cancellation',async()=>{
 for(const cancelled of [false,true]){
  const {runner,c,resumed}=fixture()
  if(cancelled)c.requestProgress.status='cancelled'
  else c.requestProgress.safetyContinuations=Array.from({length:6},()=>({resumeSerial:0,completedAt:0}))
  await c.seekSafety(FOOD_EMERGENCY)
  assert.deepEqual(runner.commands,['eat']);assert.equal(resumed(),0)
 }
})
test('night, a close hostile, low health, water and uncertain footing retain shelter-first recovery',async()=>{
 for(const change of [b=>b.time.timeOfDay=14000,b=>b.entities={1:{name:'skeleton',position:new Vec3(12,64,0)}},b=>b.health=10,b=>b.entity.isInWater=true,b=>delete b.entity.onGround]){
  const {runner,c,resumed,burrowEligible}=fixture();change(runner.bot)
  await c.seekSafety(FOOD_EMERGENCY)
  assert.deepEqual(runner.commands,['burrow','eat']);assert.equal(resumed(),0);assert.equal(burrowEligible(),true)
 }
})
test('Stop during recovery eating prevents late resumption',async()=>{
 const {runner,c,resumed}=fixture();let entered
 const started=new Promise(r=>entered=r)
 c.execute=async(cmd,signal)=>{runner.commands.push(cmd.action);entered();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('Cancelled')),{once:true}))}
 const work=c.seekSafety(FOOD_EMERGENCY);await started;c.stop();await work
 assert.equal(resumed(),0);assert.equal(c.requestProgress.status,'cancelled');assert.deepEqual(runner.commands,['eat'])
})
test('a connection replacement during eating cannot resume or shelter on a new bot',async()=>{
 const {runner,c,resumed}=fixture()
 c.execute=async()=>{runner.connectionId='two';runner.ready=false}
 await c.seekSafety(FOOD_EMERGENCY)
 assert.equal(resumed(),0);assert.equal(c.requestProgress.status,'interrupted');assert.match(c.safety.error,/Connection changed/)
})
test('an approaching hostile cancels eating and uses ordinary shelter recovery',async()=>{
 const {runner,c,resumed}=fixture(),execute=c.execute;let first=true
 c.execute=async(cmd,signal)=>{
  if(cmd.action==='eat'&&first){first=false;runner.commands.push('eat');runner.bot.entities={1:{name:'creeper',position:new Vec3(5,64,0)}};await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('New threat')),{once:true}))}
  else await execute(cmd,signal)
 }
 await c.seekSafety(FOOD_EMERGENCY)
 // The creeper arrives five blocks away: distance first, then the burrow.
 assert.equal(resumed(),0);assert.deepEqual(runner.commands,['eat','flee','burrow','eat'])
})
test('uncertain consumption survives shelter fallback and forbids a second eating attempt',async()=>{
 const {runner,c,resumed}=fixture(),execute=c.execute
 c.execute=async(cmd,signal)=>{if(cmd.action==='eat'){runner.commands.push('eat');runner.task={consumption:{uncertain:true}};throw Error('No inventory receipt')}else await execute(cmd,signal)}
 await c.seekSafety(FOOD_EMERGENCY)
 assert.deepEqual(runner.commands,['eat','burrow']);assert.equal(resumed(),0);assert.match(c.requestProgress.reviewRequired,/eating/)
})
test('health loss during clear-ground eating cancels consumption and falls back to shelter',async()=>{
 const {runner,c,resumed}=fixture(),execute=c.execute;let first=true
 c.execute=async(cmd,signal)=>{
  if(cmd.action==='eat'&&first){first=false;runner.commands.push('eat');runner.bot.health=15;await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('Health fell')),{once:true}))}
  else await execute(cmd,signal)
 }
 await c.seekSafety(FOOD_EMERGENCY)
 assert.deepEqual(runner.commands,['eat','burrow','eat']);assert.equal(resumed(),0)
})
test('uncertain sheltered eating also blocks continuation after the task is replaced',async()=>{
 const {runner,c}=fixture(),execute=c.execute;runner.bot.time.timeOfDay=14000
 c.execute=async(cmd,signal)=>{if(cmd.action==='eat'){runner.commands.push('eat');runner.task={consumption:{uncertain:true}};throw Error('Missing receipt')}else await execute(cmd,signal)}
 await c.seekSafety(FOOD_EMERGENCY);assert.match(c.requestProgress.reviewRequired,/eating/)
})
test('interruption preserves harvest stage evidence without turning inventory gain into verified harvesting',()=>{
 const {runner,c}=fixture();const step={action:'harvest',item:'sweet_berries',count:16}
 runner.task={id:'harvest',kind:'harvest',status:'running',harvestAttempt:{position:{x:1,y:64,z:0},status:'approaching'},harvested:[],harvestRejected:[]};c.requestProgress.inFlight={taskId:'harvest',step}
 c.interrupt('Food needed')
 const evidence=c.requestProgress.feedback[0]
 assert.equal(evidence.status,'interrupted');assert.equal(evidence.observed.harvest.attempt.status,'approaching');assert.equal(evidence.observed.harvest.carried,2);assert.deepEqual(evidence.observed.harvest.completed,[])
})
test('a blocked request is durable before reflection, including shutdown during that reflection',async()=>{
 const {c}=fixture();let entered,release
 const started=new Promise(r=>entered=r),pending=new Promise(r=>release=r)
 c.planner.plan=async()=>{throw Error('No usable next action')}
 c.planner.reflect=async()=>{entered();await pending;return {lessons:[]}}
 const saved={id:'saved',request:'recover food',status:'interrupted',completed:[],feedback:[{action:'harvest',status:'failed',reason:'No ripe bush'}],goal:{kind:'task',summary:'Recover hunger',criteria:[{kind:'hunger',count:18,description:'Hunger at least 18'}]}}
 const work=c.submit('recover food',saved,{automatic:true});await started
 try{
  const disk=JSON.parse(readFileSync(c.statePath,'utf8'));assert.equal(disk.requestProgress.status,'blocked');assert.equal(disk.requestProgress.blocker,'No usable next action');assert.equal(disk.canResume,true)
 }finally{c.interrupt();release();await work}
 assert.equal(JSON.parse(readFileSync(c.statePath,'utf8')).requestProgress.status,'blocked')
})
test('the safety observation records an achieved goal while staying protected, without a Resume',()=>{
 const {runner,c,resumed}=fixture();runner.bot.food=20;runner.bot.health=20
 enclose(runner.bot)
 c.requestProgress.status='interrupted';c.requestProgress.goal={kind:'task',criteria:[{kind:'health',count:20},{kind:'hunger',count:18}]}
 c.safety={status:'burrowed',protection:{verified:true}};c.phase='blocked'
 runner.emit('event',{type:'survival_tick'})
 assert.equal(c.requestProgress.status,'verified');assert.equal(c.requestProgress.verification.verdict,'passed');assert.equal(c.safety.status,'burrowed');assert.equal(resumed(),0);assert.deepEqual(runner.commands,[])
 assert.equal(JSON.parse(readFileSync(c.statePath,'utf8')).requestProgress.status,'verified')
})
test('recovery verification respects missing health, cancelled requests, review blockers and unverified protection',()=>{
 for(const change of [c=>c.runner.bot.health=19,c=>c.requestProgress.status='cancelled',c=>c.requestProgress.reviewRequired='Check uncertain eating',c=>c.safety.protection.verified=false,c=>c.runner.bot.blockAt=()=>null]){
  const {runner,c}=fixture();runner.bot.food=20;runner.bot.health=20
  enclose(runner.bot)
  c.requestProgress.status='interrupted';c.requestProgress.goal={kind:'task',criteria:[{kind:'health',count:20},{kind:'hunger',count:18}]};c.safety={status:'burrowed',protection:{verified:true}}
  change(c);runner.emit('event',{type:'survival_tick'});assert.notEqual(c.requestProgress.status,'verified')
 }
})
