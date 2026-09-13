import {Vec3} from 'vec3'
import {readFileSync} from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validatePlan } from '../src/companion/planner.js'
import { Teammate } from '../src/companion/controller.js'
class FakeRunner extends EventEmitter {
  constructor(){ super(); this.profile='lab'; this.owner='Sov'; this.ready=true; this.commands=[]; this.bot={players:{Sov:{entity:{position:{x:1,y:64,z:2}}}},inventory:{items:()=>[]}} }
  position(){return {x:0,y:64,z:0}}
  command(c){this.emit('operator_command',c);this.commands.push(c);this.task={id:String(this.commands.length),status:'running'}; if(c.action!=='stop'&&c.action!=='follow')setTimeout(()=>this.emit('event',{type:'task_finished',task:{...this.task,status:'completed'}}),1)}
}
function setup(plan){const r=new FakeRunner();return [r,new Teammate(r,{model:'fake',plan},join(mkdtempSync(join(tmpdir(),'mc-companion-')),'state.json'))]}
test('status remains available while auto-version login has not initialized players or inventory',()=>{
 const [r,c]=setup(async()=>({reply:'Ready',steps:[]}));r.ready=false
 for(const bot of [{},{players:{}},null]){
  r.bot=bot
  const state=c.snapshot()
  assert.equal(state.connected,false);assert.equal(state.ownerVisible,false)
  assert.deepEqual(state.inventory,{});assert.equal(state.survival.health,null)
 }
})
test('plans reject arbitrary code, unbounded gathering and nonterminal following',()=>{
  for(const s of [[{action:'exec',name:'',count:0}],[{action:'gather',name:'',count:99}],[{action:'follow'},{action:'come'}]])assert.throws(()=>validatePlan({reply:'ok',steps:s}))
})
test('stop defeats a late model reply',async()=>{
  let resolve;const [r,c]=setup(()=>new Promise(x=>resolve=x)); const pending=c.submit('follow me');c.stop();resolve({reply:'following',steps:[{action:'follow',name:'',count:0}]});await pending;assert.equal(r.commands.filter(x=>x.action==='follow').length,0);assert.equal(c.phase,'ready')
})
test('remember, gather, return executes in order using owner coordinates',async()=>{
  const [r,c]=setup(async()=>({reply:'On it',steps:[{action:'remember',name:'camp',count:0},{action:'gather',name:'',count:5},{action:'return',name:'camp',count:0}]})); await c.submit('gather five and return here');assert.deepEqual(r.commands.map(x=>x.action),['stop','gather','navigate']);assert.deepEqual(r.commands.at(-1).goal,{x:1,y:64,z:2});assert.equal(c.phase,'ready')
})
test('questions preserve following and unknown destinations never move',async()=>{
  const [r,c]=setup(async()=>({reply:'Hi',steps:[]})); await c.submit('hello');assert.equal(r.commands.length,0)
  c.planner.plan=async()=>({reply:'Going',steps:[{action:'return',name:'unknown',count:0}]});await c.submit('go there');assert.equal(r.commands.filter(x=>x.action==='navigate').length,0);assert.equal(c.phase,'blocked')
})
test('in-game stop invalidates pending model work',async()=>{
  let resolve; const [r,c]=setup(()=>new Promise(x=>resolve=x));const pending=c.submit('follow me');r.command({action:'stop'});resolve({reply:'yes',steps:[{action:'follow',name:'',count:0}]});await pending;assert.equal(r.commands.filter(x=>x.action==='follow').length,0)
})
test('failed action blocks remaining steps and reports failure',async()=>{
  const [r,c]=setup(async()=>({reply:'On it',steps:[{action:'gather',name:'',count:5},{action:'follow',name:'',count:0}]}))
  r.command=function(command){this.commands.push(command);this.task={id:'failed',status:'running'};if(command.action==='gather')queueMicrotask(()=>this.emit('event',{type:'task_finished',task:{id:'failed',status:'failed',reason:'no reachable logs'}}))}
  await c.submit('gather and follow');assert.equal(c.phase,'blocked');assert.equal(r.commands.some(x=>x.action==='follow'),false);assert.match(c.messages.at(-1).text,/no reachable logs/)
})
test('an unavailable model does not cancel an existing follow task',async()=>{
  const [r,c]=setup(async()=>{throw new Error('fetch failed')});await c.submit('hello');assert.equal(r.commands.length,0);assert.match(c.messages.at(-1).text,/selected model could not be reached/)
})
test('compound gather-and-return always captures and returns to one location',()=>{
 const p=validatePlan({reply:'On it',steps:[{action:'gather_and_return',name:'',count:5}]});assert.deepEqual(p.steps.map(s=>s.action),['remember','gather','return']);assert.equal(p.steps[0].name,p.steps[2].name);assert.equal(p.steps[1].count,5)
 assert.throws(()=>validatePlan({reply:'On it',steps:[{action:'gather_and_return',count:33}]}))
})
test('a clarification never executes the action it is asking permission for',()=>{
 const p=validatePlan({reply:'I cannot build. Would you like me to gather wood instead?',steps:[{action:'gather',name:'',count:6}]});assert.deepEqual(p.steps,[])
})
test('a model cannot substitute gathering for an unrelated request or stale history',async()=>{
 const {guardIntent}=await import('../src/companion/intent.js')
 const plan={reply:'Collecting logs.',steps:[{action:'gather',name:'',count:32}]}
 assert.deepEqual(guardIntent(plan,'mine diamonds',[{role:'user',text:'collect wood'}]).steps,[])
 assert.deepEqual(guardIntent(plan,'mine coal').steps,[])
 assert.equal(guardIntent(plan,'collect five oak logs').steps.length,1)
 assert.equal(guardIntent(plan,'yes',[{role:'assistant',text:'Would you like me to collect five oak logs?'}]).steps.length,1)
})
test('chop wood executes despite false capability claims in history and an offline model', async () => {
 const {LocalPlanner} = await import('../src/companion/planner.js')
 const [r,c] = setup(null)
 c.planner = new LocalPlanner({url:'http://127.0.0.1:1/v1/chat/completions'})
 c.messages = [{role:'user',text:'mine diamonds'},{role:'assistant',text:"I can't chop wood or mine. I will follow you instead."}]
 await c.submit('chop wood')
 assert.equal(c.phase,'ready')
 assert.deepEqual(r.commands.map(x=>x.action),['stop','gather'])
 assert.deepEqual(r.commands[1].goal,{item:'logs',count:8})
})
test('direct wood requests preserve species, bounds and compound intent', async () => {
 const {directPlan} = await import('../src/companion/direct-plan.js')
 assert.equal(directPlan('Can you chop six birch logs for me?').steps[0].item,'birch_log')
 assert.equal(directPlan('collect six birch logs').steps[0].count,6)
 assert.equal(directPlan('chop wood',{inventory:{oak_log:5,birch_log:3}}).steps[0].count,16)
 assert.deepEqual(directPlan('collect 100 logs').steps,[])
 for(const text of ["don't chop wood",'stop chopping wood','chop wood and build a castle','if I ask, chop wood','mine diamonds','can you chop wood or mine?'])assert.equal(directPlan(text),null,text)
})
test('gather-and-return still returns when inventory already meets the target',async()=>{
 const {directPlan}=await import('../src/companion/direct-plan.js')
 const plan=directPlan('collect five spruce logs and come back here',{inventory:{spruce_log:7}})
 assert.deepEqual(plan.steps.map(s=>s.action),['remember','gather','return'])
 assert.equal(plan.steps[1].item,'spruce_log')
})
test('open-ended goals re-observe outcomes and let the selected planner decide the next step',async()=>{
 let calls=0
 const [r,c]=setup(async(text,observation)=>{
  calls++;assert.equal(text,'make supplies')
  if(calls===1)return {reply:'On it',steps:[{action:'acquire',item:'oak_planks',count:8}]}
  assert.equal(observation.feedback[0].status,'completed')
  return {reply:'Supplies checked.',steps:[]}
 })
 await c.submit('make supplies');assert.equal(calls,2);assert.equal(c.phase,'ready');assert.equal(r.commands[1].action,'acquire')
})
test('failed generic work is reported to the planner rather than replaced by following',async()=>{
 let calls=0
 const [r,c]=setup(async(text,o)=>{
  if(++calls===1)return {reply:'On it',steps:[{action:'acquire',item:'iron_ingot',count:1}]}
  assert.equal(o.feedback[0].status,'failed');assert.match(o.feedback[0].reason,/smelting/)
  return {reply:'I need a smelting capability to make iron ingots.',steps:[]}
 })
 r.command=function(command){this.commands.push(command);this.task={id:'failed',status:'running'};if(command.action==='acquire')queueMicrotask(()=>this.emit('event',{type:'task_finished',task:{id:'failed',status:'failed',reason:'smelting is unavailable'}}))}
 await c.submit('make iron');assert.equal(calls,2);assert.equal(r.commands.some(x=>x.action==='follow'),false)
})
test('construction designs reject duplicates and out-of-bounds blocks',async()=>{
 const {validateDesign}=await import('../src/world-skills.js')
 const b={x:0,y:0,z:0,block:'wood_planks'}
 assert.equal(validateDesign([b]).length,1)
 assert.throws(()=>validateDesign([b,b]));assert.throws(()=>validateDesign([{...b,y:5}]))
 assert.throws(()=>validatePlan({reply:'Building',steps:[{action:'build',design:[{...b,x:99}]}]}))
})

test('generic tool arguments keep their distinct limits',()=>{
 const steps=[{action:'inspect',count:0,item:'',name:'',design:[]},{action:'acquire',count:128,item:'oak_planks',name:'',design:[]},{action:'build',count:0,item:'',name:'',design:[{x:0,y:0,z:0,block:'wood_planks'}]}]
 assert.equal(validatePlan({reply:'On it',steps}).steps.length,3)
 assert.throws(()=>validatePlan({reply:'On it',steps:[{action:'acquire',count:129,item:'oak_planks'}]}))
 assert.throws(()=>validatePlan({reply:'On it',steps:[{action:'gather',count:33,item:'logs'}]}))
})
test('unchanged generic failures stop after two attempts',async()=>{
 let calls=0
 const [r,c]=setup(async()=>{calls++;return {reply:'Trying',steps:[{action:'acquire',item:'coal',count:1}]}})
 r.command=function(command){this.commands.push(command);this.task={id:String(this.commands.length),status:'running'};const task=this.task;if(command.action==='acquire')queueMicrotask(()=>this.emit('event',{type:'task_finished',task:{...task,status:'failed',reason:'No coal observed'}}))}
 await c.submit('get coal');assert.equal(calls,2);assert.equal(c.phase,'blocked')
})

test('a planner stops after three rounds with no observed progress',async()=>{
 let calls=0
 const [r,c]=setup(async()=>{calls++;return {reply:'Inspecting',steps:[{action:'inspect',count:0}]}})
 await c.submit('look around');assert.equal(calls,3);assert.equal(c.phase,'blocked');assert.match(c.messages.at(-1).text,/three planning rounds/)
})

test('partial construction remains visible when replanning abandons a site',async()=>{
 let calls=0
 const [r,c]=setup(async()=>++calls===1?{reply:'Building',steps:[{action:'build',design:[{x:0,y:0,z:0,block:'wood_planks'}]}]}:{reply:'I cannot reach the remaining blocks.',steps:[]})
 r.command=function(command){this.commands.push(command);if(command.action==='build'){this.task={id:'partial',kind:'build',status:'failed',goal:{...command.goal,origin:{x:1,y:64,z:2}},progress:{verifiedBlocks:1},reason:'No path'};queueMicrotask(()=>this.emit('event',{type:'task_finished',task:this.task}))}}
 await c.submit('build here');assert.match(c.messages.at(-1).text,/unfinished construction remains at 1, 64, 2/)
})

test('a later request resumes the saved build even if the model reorders its blocks',async()=>{
 const design=[{x:0,y:0,z:0,block:'wood_planks'},{x:1,y:0,z:0,block:'wood_planks'}]
 let calls=0
 const [r,c]=setup(async()=>++calls===1?{reply:'Finishing',steps:[{action:'build',design:[...design].reverse()}]}:{reply:'Checked.',steps:[]})
 r.task={id:'old',kind:'build',status:'failed',goal:{design,origin:{x:4,y:64,z:5},near:{x:1,y:64,z:2},wood:'spruce_log'}}
 await c.submit('finish that house')
 assert.deepEqual(r.commands.find(x=>x.action==='build').goal.origin,{x:4,y:64,z:5})
 assert.equal(r.commands.find(x=>x.action==='build').goal.wood,'spruce_log')
})
test('a failed site search cannot hide the house reserved and partially built after it',async()=>{
 const design=[{x:0,y:0,z:0,block:'wood_planks'}],origin={x:4,y:64,z:5}
 let calls=0
 const [r,c]=setup(async()=>++calls===1?{reply:'Continuing the saved structure.',steps:[{action:'build',design}]}:{reply:'Checked.',steps:[]})
 r.task={id:'partial',kind:'build',status:'cancelled',goal:{design,origin,near:{x:1,y:68,z:2},wood:'birch_log'},progress:{verifiedBlocks:1}}
 await c.submit('finish the structure',{id:'saved-house',request:'finish the structure',completed:[],pending:[],feedback:[{action:'build',status:'failed',task:{kind:'build',goal:{design,near:{x:1,y:68,z:2}}},reason:'No site'}]})
 const goal=r.commands.find(x=>x.action==='build').goal
 assert.deepEqual(goal.origin,origin);assert.equal(goal.wood,'birch_log');assert.equal(c.requestProgress.id,'saved-house')
})

test('stopping an already finished task preserves its evidence',async()=>{
 const {Runner}=await import('../src/runner.js')
 for(const status of ['failed','completed','cancelled']){
  const task={status,reason:'original evidence'};let halted=false
  Runner.prototype.stop.call({task,halt(){halted=true},finish(){throw new Error('Must not overwrite result')}})
  assert.equal(halted,true);assert.equal(task.reason,'original evidence');assert.equal(task.status,status)
 }
})

test('intent guards preserve mining completion and reject substitutions without stale capability denials',async()=>{
 const {guardIntent}=await import('../src/companion/intent.js')
 const completed={reply:'I have the requested cobblestone.',steps:[]}
 assert.deepEqual(guardIntent(completed,'mine three cobblestone'),completed)
 const rejected=guardIntent({reply:'Collecting wood',steps:[{action:'gather',item:'logs',count:3}]},'mine three cobblestone')
 assert.deepEqual(rejected.steps,[]);assert.doesNotMatch(rejected.reply,/not implemented|only|oak logs/i)
 const movement=guardIntent({reply:'Coming',steps:[{action:'come'}]},'return to the position I was standing here')
 assert.deepEqual(movement.steps,[]);assert.match(movement.reply,/validate/)
})

test('a confirmed handoff is not sent again when the planner repeats the give step',async()=>{
 let calls=0
 const [r,c]=setup(async()=>{calls++;return {reply:'Delivering',steps:[{action:'give',item:'stone_pickaxe',count:1}]}})
 r.command=function(command){
  this.commands.push(command);this.task={id:String(this.commands.length),status:'running'}
  if(command.action==='give'){
   this.task.result={item:'stone_pickaxe',count:1,player:'Sov',receipt:'recipient_pickup'}
   const task={...this.task,status:'completed'};queueMicrotask(()=>this.emit('event',{type:'task_finished',task}))
  }
 }
 await c.submit('bring me a stone pickaxe')
 assert.equal(calls,2);assert.equal(r.commands.filter(x=>x.action==='give').length,1)
 assert.equal(c.phase,'ready');assert.equal(c.requestProgress.completed[0].result.receipt,'recipient_pickup')
})
test('uncertain handoff stops planning instead of dropping a second item',async()=>{
 let calls=0
 const [r,c]=setup(async()=>{calls++;return {reply:'Delivering',steps:[{action:'give',item:'stone_pickaxe',count:1}]}})
 r.command=function(command){this.commands.push(command);this.task={id:String(this.commands.length),status:'running'};if(command.action==='give'){
  this.task.delivery={attempted:true,received:0}
  const task={...this.task,status:'failed',reason:'Recipient pickup not confirmed'};queueMicrotask(()=>this.emit('event',{type:'task_finished',task}))
 }}
 await c.submit('bring me a stone pickaxe');assert.equal(calls,1);assert.equal(c.phase,'blocked');assert.match(c.requestProgress.blocker,/not confirmed/)
})
test('completed meeting capture survives replanning after the owner moves',async()=>{
 let calls=0
 const [r,c]=setup(async()=>++calls===1?{reply:'Saving',steps:[{action:'remember',name:'meeting'},{action:'inspect'}]}:{reply:'Return',steps:[{action:'remember',name:'meeting'},{action:'return',name:'meeting'}]})
 const original=c.planner.plan;c.planner.plan=async(...args)=>{if(calls===1)r.bot.players.Sov.entity.position={x:30,y:64,z:30};return original(...args)}
 await c.submit('collect supplies and return here')
 assert.deepEqual(c.places.meeting,{x:1,y:64,z:2});assert.deepEqual(r.commands.find(x=>x.action==='navigate').goal,{x:1,y:64,z:2})
})
test('a false success reply cannot erase the last failed action',async()=>{
 let calls=0
 const [r,c]=setup(async()=>++calls===1?{reply:'Making',steps:[{action:'acquire',item:'stone_pickaxe',count:1}]}:{reply:'Everything is done.',steps:[]})
 r.command=function(command){this.task={id:'failed',status:'failed',reason:'No stone within range'};if(command.action==='acquire')queueMicrotask(()=>this.emit('event',{type:'task_finished',task:this.task}))}
 await c.submit('make a stone pickaxe');assert.equal(c.phase,'blocked');assert.match(c.messages.at(-1).text,/No stone/);assert.doesNotMatch(c.messages.at(-1).text,/Everything is done/)
})

test('completed prior delivery is excluded from a fresh request observation',async()=>{
 const [r,c]=setup(async(text,observation)=>{
  assert.equal(observation.task,null);assert.deepEqual(observation.feedback,[])
  assert.deepEqual(observation.requestProgress.completed,[])
  assert.ok(observation.requestProgress.id)
  return {reply:'Please come into view.',steps:[]}
 })
 r.task={id:'previous',kind:'give',status:'completed',result:{item:'stone_pickaxe',count:1,receipt:'recipient_pickup'}}
 await c.submit('Hand me one stone pickaxe.')
})

test('repair upgrades a completed shell at its original site and forces usability checks',async()=>{
 const design=[{x:0,y:0,z:0,block:'wood_planks'}];let calls=0,observed
 const [r,c]=setup(async(_,observation)=>{observed=observation;return ++calls===1?{reply:'Repairing the existing house.',steps:[{action:'build',design}]}:{reply:'Checked.',steps:[]}})
 r.task={id:'old',kind:'build',status:'completed',goal:{design,origin:{x:4,y:64,z:5},near:{x:1,y:64,z:2},wood:'spruce_log'}}
 await c.submit('Improve this house')
 const command=r.commands.find(x=>x.action==='build')
 assert.deepEqual(command.goal.origin,{x:4,y:64,z:5});assert.equal(command.goal.purpose,'shelter');assert.equal(command.goal.wood,'spruce_log')
 assert.equal(observed.existingBuild.id,'old')
})

test('a generic structure beside a house is not silently forced into a shelter',async()=>{
 let calls=0;const [r,c]=setup(async()=>++calls===1?{reply:'Building the garden marker.',steps:[{action:'build',design:[{x:0,y:0,z:0,block:'wood_planks'}]}]}:{reply:'Checked.',steps:[]})
 await c.submit('Build a garden marker beside my house')
 assert.equal(r.commands.find(x=>x.action==='build').goal.purpose,undefined)
})

test('base projects and station locations survive unrelated tasks and a controller restart',async()=>{
 const [r,c]=setup(async()=>({reply:'Hello.',steps:[]}))
 c.projects.base={build:{origin:{x:4,y:64,z:5},wood:'spruce_log',design:[{x:0,y:0,z:0,block:'wood_planks'}]},stations:{chest:{position:{x:2,y:64,z:5},confirmed:true}}};c.persist()
 r.task={id:'other',kind:'acquire',status:'completed',goal:{item:'stick',count:1}}
 await c.submit('hello');const reloaded=new Teammate(r,c.planner,c.statePath)
 assert.deepEqual(reloaded.projects,c.projects)
 let observed;reloaded.planner={model:'fake',plan:async(_,o)=>{observed=o;return {reply:'Remembered.',steps:[]}}}
 await reloaded.submit('Where is our base');assert.deepEqual(observed.existingBuild.goal.origin,{x:4,y:64,z:5});assert.ok(observed.projects.base.stations.chest)
})

test('partial prospecting feeds the same saved project into another model-selected expedition',async()=>{
 let calls=0
 const [r,c]=setup(async(text,o)=>{
  if(++calls===1)return {reply:'Searching.',steps:[{action:'prospect',name:'base',item:'diamond',count:1}]}
  if(calls===2){assert.equal(o.feedback[0].result.acquired,false);assert.equal(o.projects.base.expedition.frontierSteps,1);return {reply:'Continuing.',steps:[{action:'prospect',name:'base',item:'diamond',count:1}]}}
  return {reply:'Diamond checked.',steps:[]}
 })
 c.projects.base={build:{origin:{x:20,y:64,z:20}},stations:{}}
 let attempts=0
 r.command=function(command){this.emit('operator_command',command);this.commands.push(command);if(command.action==='stop')return
  attempts++;assert.ok(command.goal.project);const project=structuredClone(command.goal.project)
  if(attempts===2)assert.deepEqual(project.expedition.frontier,[{x:1,y:60,z:1}])
  project.expedition={trail:[],frontier:[{x:1,y:60,z:1}],surveys:[],rejected:[]}
  this.task={id:String(attempts),kind:'prospect',status:'running',goal:{...command.goal,project}}
  queueMicrotask(()=>{this.task.status='completed';this.task.result={item:'diamond',count:attempts-1,acquired:attempts===2,partial:attempts===1,returned:true};this.emit('event',{type:'task_finished',task:this.task})})
 }
 await c.submit('get a diamond');assert.equal(attempts,2);assert.equal(c.phase,'ready');assert.equal(c.requestProgress.completed.length,2)
})


test('a progressing request continues beyond six rounds with the same goal',async()=>{
 let calls=0,carried=0
 const [r,c]=setup(async(_,o)=>{calls++;return calls<=8?{reply:'Collecting.',steps:[{action:'acquire',item:'coal',count:calls}]}:{reply:'Eight coal confirmed.',steps:[]}})
 r.bot.inventory.items=()=>[{name:'coal',count:carried}]
 r.command=function(command){this.commands.push(command);if(command.action==='stop')return
  carried=command.goal.count;this.task={id:String(this.commands.length),status:'completed',result:{item:'coal',count:carried}}
  queueMicrotask(()=>this.emit('event',{type:'task_finished',task:this.task}))
 }
 await c.submit('get eight coal');assert.equal(calls,9);assert.equal(c.requestProgress.completed.length,8);assert.equal(c.requestProgress.status,'reviewed')
})

test('prospecting keeps eliminating different inaccessible routes instead of treating them as an unchanged retry',async()=>{
 let attempts=0,diamond=0
 const [r,c]=setup(async()=>diamond?{reply:'Diamond verified.',steps:[]}:{reply:'Trying the next untested route.',steps:[{action:'prospect',name:'base',item:'diamond',count:1}]})
 c.projects.base={build:{origin:{x:20,y:64,z:20}},stations:{},expedition:{trail:[],frontier:[],surveys:[],rejected:[]}}
 c.planner.formulate=async()=>({kind:'task',summary:'Mine a diamond.',projectMode:'none',criteria:[goalCriterion('inventory','diamond',1)],milestones:[],constraints:[]})
 r.bot.inventory.items=()=>diamond?[{name:'diamond',count:1}]:[]
 r.command=function(command){this.emit('operator_command',command);this.commands.push(command);if(command.action==='stop')return
  attempts++;const project=structuredClone(command.goal.project)
  project.expedition.rejected.push({item:'diamond',position:`${attempts},50,0`,reason:'No bounded excavation route'})
  this.task={id:String(attempts),kind:'prospect',goal:{...command.goal,project},status:'running'}
  queueMicrotask(()=>{diamond=attempts===3?1:0;this.task.status=diamond?'completed':'failed';this.task.reason='No bounded excavation route';if(diamond)this.task.result={item:'diamond',count:1,acquired:true,partial:false};this.emit('event',{type:'task_finished',task:this.task})})
 }
 await c.submit('Mine a diamond')
 assert.equal(attempts,3);assert.equal(c.requestProgress.status,'verified');assert.equal(c.projects.base.expedition.rejected.length,3)
})

test('restart plus Resume retains the request ID and a confirmed delivery without resending',async()=>{
 let resolve,first=true
 const [r,c]=setup(async()=>first?(first=false,{reply:'Delivering.',steps:[{action:'give',item:'coal',count:1}]}):new Promise(done=>resolve=done))
 r.command=function(command){this.commands.push(command);if(command.action==='stop')return
  this.task={id:String(this.commands.length),status:'completed',result:{item:'coal',count:1,receipt:'recipient_pickup'}}
  queueMicrotask(()=>this.emit('event',{type:'task_finished',task:this.task}))
 }
 const pending=c.submit('give me one coal')
 while(!resolve)await new Promise(done=>setTimeout(done,1))
 const id=c.requestProgress.id;c.interrupt();resolve({reply:'Done.',steps:[]});await pending
 const reloaded=new Teammate(r,{model:'fake',plan:async(_,o)=>{
  assert.equal(o.requestProgress.id,id);assert.equal(o.feedback[0].result.receipt,'recipient_pickup')
  return {reply:'Delivering.',steps:[{action:'give',item:'coal',count:1}]}
 }},c.statePath)
 assert.equal(reloaded.snapshot().canResume,true);await reloaded.resume()
 assert.equal(r.commands.filter(c=>c.action==='give').length,1);assert.equal(reloaded.requestProgress.id,id)
})

test('Stop cancels a blocked request and a late Resume cannot revive it',async()=>{
 const [r,c]=setup(async()=>{throw new Error('temporary model failure')})
 await c.submit('get coal');assert.equal(c.snapshot().canResume,true)
 c.stop();assert.equal(c.snapshot().canResume,false);await assert.rejects(()=>c.resume(),/Stop cancels/)
 const reloaded=new Teammate(r,c.planner,c.statePath);assert.equal(reloaded.requestProgress.status,'cancelled');assert.equal(reloaded.snapshot().canResume,false)
})

test('restart preserves uncertainty and refuses to replay a transfer',async()=>{
 const [r,c]=setup(async()=>({reply:'Ready.',steps:[]}))
 c.requestProgress={id:'unsafe',request:'give coal',status:'running',completed:[],pending:[],feedback:[]};c.persist()
 r.task={id:'transfer',status:'cancelled',transfer:{uncertain:true}}
 const reloaded=new Teammate(r,c.planner,c.statePath)
 assert.equal(reloaded.snapshot().canResume,false);await assert.rejects(()=>reloaded.resume(),/needs review/)
})

test('a completed effect is reconciled after a crash before its controller receipt',async()=>{
 const [r,c]=setup(async()=>({reply:'Checked.',steps:[]}))
 const step={action:'give',item:'coal',count:1}
 c.requestProgress={id:'durable',request:'give coal',status:'running',completed:[],pending:[step],feedback:[],inFlight:{taskId:'effect',step}};c.persist()
 r.task={id:'effect',status:'completed',result:{item:'coal',count:1,receipt:'recipient_pickup'}}
 const reloaded=new Teammate(r,c.planner,c.statePath)
 assert.equal(reloaded.requestProgress.feedback[0].result.receipt,'recipient_pickup')
 assert.equal(reloaded.requestProgress.completed.length,1);assert.equal(reloaded.snapshot().canResume,true)
})

test('a partial resupply return cannot be reported as goal completion',async()=>{
 let calls=0
 const [r,c]=setup(async()=>++calls===1?{reply:'Searching.',steps:[{action:'prospect',name:'base',item:'coal',count:8}]}:{reply:'All done.',steps:[]})
 c.projects.base={build:{origin:{x:20,y:64,z:20}},stations:{}}
 r.command=function(command){if(command.action==='stop')return;this.task={id:'partial',status:'completed',result:{item:'coal',count:0,acquired:false,partial:true,needs:['Acquire torches']}};queueMicrotask(()=>this.emit('event',{type:'task_finished',task:this.task}))}
 await c.submit('get eight coal');assert.equal(c.phase,'blocked');assert.match(c.messages.at(-1).text,/Acquire torches/);assert.doesNotMatch(c.messages.at(-1).text,/All done/)
})

test('partial expeditions replan before a dependent smelting step consumes resources',async()=>{
 let calls=0
 const [r,c]=setup(async(_,o)=>{
  if(++calls===1)return {reply:'Mining then smelting.',steps:[{action:'prospect',name:'base',item:'raw_iron',count:6},{action:'smelt',name:'base',item:'iron_ingot',count:6}]}
  assert.equal(o.feedback[0].result.count,4);assert.equal(o.requestProgress.pending[0].action,'smelt')
  return {reply:'More iron is still needed.',steps:[]}
 })
 c.projects.base={build:{origin:{x:20,y:64,z:20}},stations:{}}
 r.command=function(command){this.commands.push(command);if(command.action==='stop')return
  this.task={id:'partial',status:'completed',result:{item:'raw_iron',count:4,target:6,partial:true,acquired:false,returned:true,next:'Continue the frontier'}}
  queueMicrotask(()=>this.emit('event',{type:'task_finished',task:this.task}))
 }
 await c.submit('prepare iron supplies');assert.equal(calls,2);assert.equal(r.commands.some(c=>c.action==='smelt'),false);assert.equal(c.phase,'blocked')
})

test('named construction continues at its saved origin while preserving the original base',async()=>{
 const design=[{x:0,y:0,z:0,x2:2,y2:0,z2:2,block:'stone_bricks'},...[[1,1,1],[2,1,1]].map(([x,y,z])=>({x,y,z,x2:x,y2:y,z2:z,block:'checkpoint'}))]
 let round=0;const [r,c]=setup(async()=>++round===1?{reply:'Continuing.',steps:[{action:'construct',name:'castle',count:0,design:[]}]}:{reply:'Checked.',steps:[]})
 const base={build:{origin:{x:100,y:64,z:100}},stations:{chest:{position:{x:101,y:64,z:100}}}}
 c.projects.base=structuredClone(base);c.projects.castle={construction:{name:'castle',design,near:{x:0,y:64,z:0},origin:{x:10,y:64,z:10}}}
 r.command=function(command){this.commands.push(command);if(command.action==='construct'){this.task={id:'castle-1',kind:'construct',status:'completed',goal:command.goal,result:{partial:false,verifiedBlocks:9}};queueMicrotask(()=>this.emit('event',{type:'task_finished',task:this.task}))}}
 await c.submit('continue the castle');assert.equal(c.phase,'ready');assert.deepEqual(c.projects.base,base)
 const command=r.commands.find(x=>x.action==='construct');assert.deepEqual(command.goal.origin,{x:10,y:64,z:10});assert.deepEqual(command.goal.design,design);assert.equal(c.projects.castle.result.verifiedBlocks,9)
})

const goalCriterion=(kind,item,count)=>({kind,item,count,target:'',description:`Carry ${count} ${item}`})
test('unchanged incomplete plans preserve the actionable blocker instead of hiding a request for help',async()=>{
 const [r,c]=setup(async()=>({reply:'Both observed starter routes meet lava. Lead me to a dry stone face.',steps:[]}))
 c.planner.formulate=async()=>({kind:'task',summary:'Mine a diamond.',projectMode:'none',criteria:[goalCriterion('inventory','diamond',1)],milestones:[],constraints:[]})
 await c.submit('Mine a diamond')
 assert.equal(c.requestProgress.status,'blocked');assert.equal(c.requestProgress.rounds,2)
 assert.match(c.messages.at(-1).text,/Both observed starter routes meet lava/)
 assert.match(c.requestProgress.blocker,/Lead me to a dry stone face/)
 assert.equal(r.commands.filter(x=>x.action!=='stop').length,0)
})
test('real intermediate supplies reset an earlier premature completion without abandoning the goal',async()=>{
 let round=0,stone=0
 const [r,c]=setup(async()=>{round++;return round===2?{reply:'Opening stone access.',steps:[{action:'acquire',item:'cobblestone',count:8}]}:{reply:'Need another access route.',steps:[]}})
 c.planner.formulate=async()=>({kind:'task',summary:'Mine a diamond.',projectMode:'none',criteria:[goalCriterion('inventory','diamond',1)],milestones:[],constraints:[]})
 r.bot.inventory.items=()=>stone?[{name:'cobblestone',count:stone}]:[]
 r.command=function(command){this.commands.push(command);if(command.action==='acquire'){stone=8;this.task={id:'stone',kind:'acquire',status:'completed',goal:command.goal,result:{item:'cobblestone',count:8}};queueMicrotask(()=>this.emit('event',{type:'task_finished',task:this.task}))}}
 await c.submit('Mine a diamond')
 assert.equal(round,4);assert.equal(c.requestProgress.status,'blocked');assert.equal(c.requestProgress.goal.criteria[0].item,'diamond')
})
test('goal gate rejects a premature done response and forces the original missing work',async()=>{
 let round=0;const [r,c]=setup(async(text,o)=>{
  round++
  if(round===1)return {reply:'Done.',steps:[]}
  if(round===2){assert.equal(o.feedback.at(-1).action,'goal_check');return {reply:'Obtaining supplies.',steps:[{action:'acquire',item:'torch',count:8}]}}
  return {reply:'Eight torches checked.',steps:[]}
 })
 c.planner.formulate=async()=>({kind:'task',summary:'Prepare eight torches.',projectMode:'none',criteria:[goalCriterion('inventory','torch',8)],milestones:['Craft','Verify'],constraints:[]})
 let count=0;r.bot.inventory.items=()=>[{name:'torch',count}]
 r.command=function(command){this.commands.push(command);if(command.action==='acquire'){count=8;this.task={id:'supplies',kind:'acquire',status:'completed',goal:command.goal,result:{item:'torch',count}};queueMicrotask(()=>this.emit('event',{type:'task_finished',task:this.task}))}}
 await c.submit('prepare eight torches');assert.equal(c.requestProgress.status,'verified');assert.equal(round,3);assert.equal(c.requestProgress.verification.verdict,'passed');assert.equal(c.experience.entries.length,1)
})
test('status questions leave the active request and pending planner intact',async()=>{
 let resolve;const [r,c]=setup(()=>new Promise(x=>resolve=x));const running=c.submit('get supplies'),id=c.requestProgress.id,epoch=c.epoch
 await c.submit('What are you doing?');assert.equal(c.epoch,epoch);assert.equal(c.requestProgress.id,id);assert.equal(c.requestProgress.status,'running')
 resolve({reply:'Ready.',steps:[]});await running
})

test('stop invalidates a late goal interpretation before any action can start',async()=>{
 let resolve;const [r,c]=setup(async()=>{throw new Error('Planning should not start')})
 c.planner.formulate=()=>new Promise(done=>resolve=done)
 const pending=c.submit('Create a lookout');c.stop();resolve({kind:'task',summary:'Build it',projectMode:'none',milestones:[],constraints:[],criteria:[{kind:'inventory',description:'Carry planks',target:'',item:'oak_planks',count:8}]});await pending
 assert.equal(c.requestProgress.status,'cancelled');assert.equal(c.requestProgress.goal,undefined);assert.equal(r.commands.filter(c=>c.action!=='stop').length,0)
})

test('stop during reflection cannot mark the cancelled task verified or save late lessons',async()=>{
 let reflect;const [r,c]=setup(async()=>({reply:'Done',steps:[]}))
 c.planner.formulate=async()=>({kind:'task',summary:'Carry a torch',projectMode:'none',milestones:[],constraints:[],criteria:[{kind:'inventory',description:'Carry torch',target:'',item:'torch',count:1}]})
 r.bot.inventory.items=()=>[{name:'torch',count:1}]
 c.planner.reflect=()=>new Promise(done=>reflect=done)
 const original=c.planner.plan;c.planner.plan=async(...args)=>{c.requestProgress.feedback.push({action:'acquire',status:'completed',result:{count:1}});return original(...args)}
 const pending=c.submit('Get a torch');while(!reflect)await new Promise(r=>setImmediate(r));c.stop();reflect({lessons:[]});await pending
 assert.equal(c.requestProgress.status,'cancelled');assert.equal(c.experience.entries.length,0)
})

test('construction may revise a rejected unstarted design but preserves reserved geometry',async()=>{
 const design=[{x:0,y:0,z:0,x2:1,y2:0,z2:1,block:'oak_planks'},{x:0,y:1,z:0,x2:0,y2:1,z2:0,block:'checkpoint'},{x:1,y:1,z:1,x2:1,y2:1,z2:1,block:'checkpoint'}]
 for(const reserved of [false,true]){
  let calls=0;const [r,c]=setup(async()=>++calls===1?{reply:'Build the revised layout',steps:[{action:'construct',name:'lookout',count:0,design}]}:{reply:'Checked',steps:[]})
  c.projects.lookout={construction:{name:'lookout',design:[],near:{x:0,y:64,z:0},...(reserved?{origin:{x:2,y:64,z:2}}:{})}}
  await c.submit('Build a lookout')
  const command=r.commands.find(c=>c.action==='construct')
  if(reserved){assert.equal(command,undefined);assert.equal(c.phase,'blocked')}
  else assert.deepEqual(command.goal.design,design)
 }
})

test('revision dispatch saves previous geometry, keeps its origin and preserves other projects',async()=>{
 const design=[{x:0,y:0,z:0,x2:2,y2:0,z2:2,block:'stone_bricks'},...[[1,1,1],[2,1,1]].map(([x,y,z])=>({x,y,z,x2:x,y2:y,z2:z,block:'checkpoint'}))]
 let round=0;const [r,c]=setup(async()=>++round===1?{reply:'Revising.',steps:[{action:'revise',name:'room',count:0,design:[{x:0,y:0,z:0,x2:0,y2:0,z2:0,block:'glass'}]}]}:{reply:'Checked.',steps:[]})
 c.planner.formulate=async()=>({kind:'task',summary:'Replace one recorded stone block with glass.',projectMode:'modify',criteria:[{kind:'construction',target:'room',item:'',count:1,description:'Revised room verified'}],milestones:['Modify','Verify'],constraints:[]})
 c.projects.base={sentinel:'untouched'};c.projects.room={construction:{name:'room',design,near:{x:0,y:64,z:0},origin:{x:10,y:64,z:10}}}
 r.bot.blockAt=p=>({name:p.x===10&&p.z===10?'glass':'stone_bricks'})
 r.command=function(command){this.commands.push(command);if(command.action==='construct'){this.task={id:'revision-1',kind:'construct',status:'completed',goal:command.goal,result:{name:'room',partial:false,verifiedBlocks:9,walkthrough:[{},{}]}};queueMicrotask(()=>this.emit('event',{type:'task_finished',task:this.task}))}}
 await c.submit('Replace the recorded corner block in room with glass')
 const command=r.commands.find(x=>x.action==='construct');assert.ok(command);assert.deepEqual(command.goal.previousDesign,design);assert.deepEqual(command.goal.origin,{x:10,y:64,z:10});assert.deepEqual(c.projects.base,{sentinel:'untouched'});assert.equal(c.requestProgress.status,'verified')
 const reloaded=new Teammate(r,c.planner,c.statePath);assert.deepEqual(reloaded.projects.room.construction.previousDesign,design)
})

test('food plan reaches executor with a hunger observation and no base dependency',async()=>{
 let round=0,seen
 const [runner,c]=setup(async(_,observation)=>{seen=observation;return ++round===1?{reply:'Eating bread.',steps:[{action:'eat',name:'',item:'bread',count:1,design:[]}]}:{reply:'Done.',steps:[]}})
 runner.bot.food=10;runner.bot.foodSaturation=0;runner.bot.health=20;runner.bot.game={gameMode:'survival',difficulty:'peaceful'}
 await c.submit('Eat one bread')
 assert.equal(runner.commands.find(x=>x.action==='eat').goal.item,'bread');assert.equal(seen.survival.food,10)
})

test('safety preempts an active request, retains it for Resume and latches after shelter arrival',async()=>{
 const [runner,c]=setup(async()=>({reply:'Waiting.',steps:[]}));runner.bot.game={gameMode:'survival',difficulty:'peaceful'};runner.bot.food=20
 c.projects.base={build:{origin:{x:0,y:64,z:0}}};c.requestProgress={id:'original',status:'running',request:'gather supplies'}
 const commands=[];c.execute=async cmd=>{commands.push(cmd);runner.task={result:{receipt:'sheltered_door_closed'}}}
 await c.seekSafety('test critical health')
 assert.equal(c.requestProgress.id,'original');assert.equal(c.requestProgress.status,'interrupted');assert.equal(c.safety.status,'sheltered');assert.equal(commands[0].action,'retreat')
 await c.seekSafety('same hazard');assert.equal(commands.length,1)
})
test('operator stop cancels a pending safety continuation and prevents later movement',async()=>{
 const [runner,c]=setup(async()=>({reply:'',steps:[]}));runner.ready=false;c.projects.base={}
 let commands=0;c.execute=async()=>{commands++};const pending=c.seekSafety('test hazard');c.stop();runner.ready=true;await pending
 assert.equal(commands,0);assert.equal(c.safety.status,'cancelled');assert.equal(c.phase,'ready')
})
test('missing or damaged shelter produces an explicit failed safety state',async()=>{
 const [runner,c]=setup(async()=>({reply:'',steps:[]}));await c.seekSafety('test hazard');assert.equal(c.safety.status,'failed');assert.match(c.messages.at(-1).text,/Safety recovery failed/)
})

test('health event invokes the provider-independent supervisor without a model call',async()=>{
 const [runner,c]=setup(async()=>{throw new Error('Model must not be called')});runner.bot.health=9;runner.bot.food=20;runner.bot.game={gameMode:'survival',difficulty:'peaceful'};runner.bot.time={timeOfDay:13000};c.projects.base={build:{},stations:{torch:{position:{x:0,y:65,z:0},confirmed:true}},built:true}
 let called=0;c.execute=async cmd=>{assert.equal(cmd.action,'retreat');called++;runner.task={result:{receipt:'sheltered_door_closed'}}}
 runner.emit('event',{type:'survival_tick'});await new Promise(resolve=>setImmediate(resolve));assert.equal(called,1);assert.equal(c.safety.status,'sheltered')
})

test('death during recovery stops the pending safety action promptly',async()=>{
 const [runner,c]=setup(async()=>({reply:'',steps:[]}));runner.ready=false;c.projects.base={}
 const pending=c.seekSafety('test hazard');runner.emit('event',{type:'death'});await pending
 assert.equal(c.safety.status,'failed');assert.equal(c.safety.error,'Died during retreat');assert.equal(c.phase,'blocked')
})
test('death after a blocked task is visible and blocks Resume until explicit respawn',async()=>{
 const [r,c]=setup(async()=>{throw new Error('No model call while dead')})
 c.phase='blocked';c.requestProgress={id:'diamond',request:'mine diamond',status:'blocked'}
 r.ready=false;r.bot.health=0;r.bot.isAlive=false
 r.emit('event',{type:'death'})
 assert.equal(c.snapshot().dead,true);assert.equal(c.snapshot().canResume,false);assert.match(c.messages.at(-1).text,/Respawn agent/)
 await assert.rejects(c.resume(),/Respawn/)
 let respawns=0;r.respawn=()=>{respawns++;r.respawnPending=true};c.respawn();c.respawn();assert.equal(respawns,1)
 r.bot.health=20;r.bot.isAlive=true;r.respawnPending=false;r.ready=true;r.emit('event',{type:'spawn'})
 assert.equal(c.snapshot().dead,false);assert.equal(c.requestProgress.id,'diamond');assert.equal(c.requestProgress.status,'blocked');assert.equal(c.snapshot().canResume,true)
 assert.match(c.requestProgress.blocker,/Respawned/);assert.doesNotMatch(c.requestProgress.blocker,/Respawn first/)
})
test('water recovery preempts failed shelter logic and never waits for a model or lit base',async()=>{
 const {WATER_EMERGENCY}=await import('../src/survival.js')
 const [r,c]=setup(async()=>{throw new Error('No model call for air recovery')});r.bot.setControlState=()=>{}
 c.safety={status:'failed',reason:'Health is at or below half'};c.requestProgress={id:'diamond',request:'mine diamond',status:'running'}
 const calls=[];c.execute=async command=>{calls.push(command.action);r.task={result:{receipt:'dry_ground_reached'}}}
 await c.seekSafety(WATER_EMERGENCY)
 assert.deepEqual(calls,['surface']);assert.equal(c.requestProgress.status,'interrupted');assert.equal(c.requestProgress.feedback.at(-1).result.receipt,'dry_ground_reached');assert.equal(c.safety,null)
})
test('observed dry ground clears a stale water alarm without resuming mining',async()=>{
 const {WATER_EMERGENCY}=await import('../src/survival.js'),{Vec3}=await import('vec3')
 const [r,c]=setup(async()=>{throw new Error('No model call')});r.bot.entity={position:new Vec3(0,64,0),onGround:true,isInWater:false};r.bot.blockAt=()=>({name:'air'});r.bot.health=20;r.bot.oxygenLevel=0;r.bot.clearControlStates=()=>{}
 c.safety={reason:WATER_EMERGENCY,status:'failed'};c.requestProgress={id:'diamond',request:'mine diamond',status:'blocked'}
 r.emit('event',{type:'survival_tick'})
 assert.equal(c.safety,null);assert.equal(c.requestProgress.status,'blocked');assert.equal(r.commands.length,0);assert.match(c.messages.at(-1).text,/dry ground/)
 assert.match(c.requestProgress.blocker,/Review current inventory/)
})

test('recovery waits for fresh chunks after reconnect before inspecting shelter',async()=>{
 const [runner,c]=setup(async()=>({reply:'',steps:[]}));runner.bot.food=20;c.projects.base={}
 let resolve,executed=false;runner.bot.waitForChunksToLoad=()=>new Promise(r=>resolve=r);c.execute=async()=>{executed=true;runner.task={result:{receipt:'sheltered_door_closed'}}}
 const pending=c.seekSafety('test health');assert.equal(executed,false);await new Promise(r=>setImmediate(r));resolve();await pending;assert.equal(executed,true);assert.equal(c.safety.status,'sheltered')
})


test('retreat cannot acquire the bot until cancellation settles, and Stop defeats that handoff',async()=>{
 for(const stop of [false,true]){
  const [runner,c]=setup(async()=>({reply:'',steps:[]}));runner.bot.food=20;c.projects.base={}
  let release,executed=false;runner.waitForIdle=()=>new Promise(r=>release=r)
  c.execute=async()=>{executed=true;runner.task={result:{receipt:'sheltered_door_closed'}}}
  const pending=c.seekSafety('test health');assert.equal(executed,false)
  if(stop)c.stop()
  release();await pending;assert.equal(executed,!stop)
  assert.equal(c.safety.status,stop?'cancelled':'sheltered')
 }
})

test('safety falls back after primary rejection, retains base and original request',async()=>{
 const [runner,c]=setup(async()=>({reply:'',steps:[]}));runner.bot.food=20
 c.projects.base={build:{origin:{x:0,y:64,z:0}}}
 runner.bot.entity={position:{x:0,y:64,z:0}};c.projects.refuge={status:'completed',result:{partial:false},construction:{origin:{x:1,y:64,z:1},design:[]}}
 const original=structuredClone(c.projects.base);c.requestProgress={id:'keep',status:'running',request:'collect'}
 const calls=[];c.execute=async cmd=>{calls.push(cmd);if(cmd.goal.project)throw new Error('access obstructed');runner.task={result:{receipt:'sheltered_door_closed',shelterName:'refuge'}}}
 await c.seekSafety('test hostile')
 assert.equal(c.safety.status,'sheltered');assert.equal(calls.length,2);assert.equal(c.safety.attempts[0].status,'rejected');assert.equal(c.safety.retreat.shelterName,'refuge')
 assert.deepEqual(c.projects.base,original);assert.equal(c.requestProgress.id,'keep');assert.equal(c.requestProgress.status,'interrupted')
})
test('Stop after a rejected primary prevents fallback execution',async()=>{
 const [runner,c]=setup(async()=>({reply:'',steps:[]}));c.projects.base={};runner.bot.entity={position:{x:0,y:64,z:0}};c.projects.refuge={status:'completed',result:{partial:false},construction:{origin:{x:1,y:64,z:1},design:[]}}
 let calls=0;c.execute=async()=>{calls++;c.stop();throw new Error('cancelled')}
 await c.seekSafety('test hostile');assert.equal(calls,1);assert.equal(c.safety.status,'cancelled')
})

import {THREAT_INTERRUPTION} from '../src/companion/hazard-clearance.js'
test('a threat or health interruption of active work arms automatic continuation, once per episode',async()=>{
 for(const [status,reason,used,review,expected] of [['running',THREAT_INTERRUPTION,false,false,1],['blocked',THREAT_INTERRUPTION,false,false,0],['running','Health is at or below half',false,false,1],['running',THREAT_INTERRUPTION,true,false,0],['running',THREAT_INTERRUPTION,false,true,0]]){
  const [r,c]=setup(async()=>({reply:'',steps:[]}));r.bot.food=20;c.projects.base={};c.requestProgress={id:'saved',request:'supplies',status,safetyContinuations:used?[{}]:[]};if(review)r.task={consumption:{uncertain:true}}
  c.execute=async()=>{r.task={result:{receipt:'sheltered_door_closed'}}};let armed=0;c.continueAfterClearance=async()=>armed++
  await c.seekSafety(reason);assert.equal(armed,expected)
 }
})
test('Stop cancels an active clearance watch without Resume',async()=>{
 const [r,c]=setup(async()=>({reply:'',steps:[]}));const abort=new AbortController();c.abort=abort;c.safety={status:'sheltered',retreat:{}};c.requestProgress={id:'saved',status:'interrupted',feedback:[]}
 let resumed=0;c.resume=async()=>resumed++
 const pending=c.continueAfterClearance(c.epoch,abort.signal,r.bot);c.stop();await pending
 assert.equal(resumed,0);assert.equal(c.requestProgress.status,'cancelled');assert.equal(c.safety.status,'cancelled')
})
test('automatic continuation is labelled as an assistant event rather than a user instruction',async()=>{
 const [r,c]=setup(async()=>({reply:'Done.',steps:[]}));c.requestProgress={id:'saved',request:'inspect supplies',status:'interrupted',completed:[],pending:[],feedback:[],rounds:0}
 await c.resume({automatic:true});assert.equal(c.requestProgress.id,'saved');assert.ok(c.messages.some(m=>m.role==='assistant'&&m.text.startsWith('Automatically continuing')));assert.ok(!c.messages.some(m=>m.role==='user'))
})
test('extended continuation checks session and daylight before any maintenance or resume',async()=>{
 const [r,c]=setup(async()=>({reply:'',steps:[]}));c.safety={status:'sheltered',retreat:{}};c.requestProgress={id:'saved',status:'interrupted',feedback:[]}
 let actions=0;c.resume=async()=>actions++
 await c.continueAfterClearance(c.epoch,new AbortController().signal,r.bot,{check(){throw new Error('Insufficient daylight')},maintain:async()=>actions++})
 assert.equal(actions,0);assert.equal(c.safety.continuation.status,'paused');assert.match(c.safety.continuation.reason,/daylight/)
})

test('uncertain sheltered eating blocks manual Resume as well as automatic continuation',async()=>{
 const [r,c]=setup(async()=>({reply:'',steps:[]}));c.safety={status:'sheltered',retreat:{}};c.requestProgress={id:'saved',request:'morning supplies',status:'interrupted',feedback:[]}
 await c.continueAfterClearance(c.epoch,new AbortController().signal,r.bot,{maintain:async()=>{r.task={consumption:{uncertain:true}};throw new Error('Food consumption was not confirmed')}})
 assert.match(c.requestProgress.reviewRequired,/eating/)
 await assert.rejects(c.resume(),/eating/)
 assert.match(c.messages.at(-1).text,/Check inventory/)
})

test('playing as the owner does not report a second player or follow itself',async()=>{
 const [r,c]=setup(async()=>({reply:'Following',steps:[{action:'follow',name:'',count:0}]}))
 r.bot.username='sOV'
 const state=c.snapshot();assert.equal(state.ownerVisible,false);assert.equal(state.ownerPosition,null);assert.equal(state.playingAsOwner,true)
 await c.submit('follow me')
 assert.equal(r.commands.some(x=>x.action==='follow'),false)
 assert.match(c.messages.at(-1).text,/playing as your account/)
})
test('playing as the owner still allows ordinary gathering through the app',async()=>{
 const [r,c]=setup(async()=>({reply:'Gathering',steps:[{action:'gather',name:'',count:1,item:'spruce_log'}]}))
 r.bot.username='Sov';await c.submit('gather one spruce log')
 assert.equal(r.commands.some(x=>x.action==='gather'),true)
 assert.equal(c.phase,'ready')
})

import {buildSiteAnchor} from '../src/companion/continuity.js'
test('a shelter site anchors to the owner in view, else to the agent itself',()=>{
 const runner={owner:'Sov',bot:{players:{Sov:{entity:{position:{x:1,y:64,z:2}}}}},position:()=>({x:9,y:70,z:9})}
 assert.deepEqual(buildSiteAnchor(runner),{near:{x:1,y:64,z:2},anchor:'owner'})
 runner.bot.players={};assert.deepEqual(buildSiteAnchor(runner),{near:{x:9,y:70,z:9},anchor:'agent'})
 assert.equal(buildSiteAnchor({owner:'Sov',bot:{players:{}},position:()=>null}),null)
})

test('Resume marks earlier failures as pre-resume and tells the planner to retry once',async()=>{
 let seen
 const [r,c]=setup(async(text,observation)=>{seen=observation.feedback;return {reply:'Checked.',steps:[]}})
 const saved={id:'saved',request:'build a shelter',completed:[],pending:[],rounds:2,feedback:[{action:'build',status:'failed',reason:'Owner must be in view'},{action:'inspect',status:'completed'}]}
 await c.submit('build a shelter',saved)
 assert.equal(c.requestProgress.feedback[0].beforeResume,true);assert.equal(c.requestProgress.feedback[1].beforeResume,undefined)
 const marker=c.requestProgress.feedback.find(f=>f.action==='resume');assert.ok(marker);assert.match(marker.reason,/retry that prerequisite once/)
 assert.ok(seen.some(f=>f.action==='resume'),'planner saw the resume marker')
 await c.submit('build a shelter');assert.equal(c.requestProgress.feedback.some(f=>f.action==='resume'),false)
})

import {shouldContinueAfterBudget,BUDGET_CONTINUATIONS} from '../src/companion/continuity.js'
test('a request that ran out of rounds or time while completing steps continues automatically, at most twice',()=>{
 const r={completed:[{step:{action:'gather'}}],budgetContinuations:0}
 assert.equal(shouldContinueAfterBudget(r,0,'Planning limit reached after 24 rounds. Progress is saved; use Resume to continue.'),true)
 assert.equal(shouldContinueAfterBudget(r,0,'Active planning time limit reached. Progress is saved; use Resume to continue.'),true)
 assert.equal(shouldContinueAfterBudget(r,1,'Planning limit reached after 24 rounds.'),false)
 assert.equal(shouldContinueAfterBudget(r,0,'No observed progress for three planning rounds.'),false)
 assert.equal(shouldContinueAfterBudget({...r,budgetContinuations:BUDGET_CONTINUATIONS},0,'Planning limit reached after 24 rounds.'),false)
})

test('a request interrupted only by a service restart continues once automatically after spawn',async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'mc-restart-')),'state.json')
 const {writeFileSync}=await import('node:fs')
 const saved={profile:'lab',places:{},messages:[],projects:{},safety:null,requestProgress:{id:'r',request:'build a shelter',status:'interrupted',blocker:'Service restarted. Resume to re-observe and continue.',completed:[],pending:[],feedback:[]}}
 writeFileSync(path,JSON.stringify(saved))
 const r=new FakeRunner();r.bot.health=20;r.bot.game={gameMode:'survival'}
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},path)
 assert.equal(c.restoreRequest,true)
 let resumed=0;c.resume=async()=>{resumed++}
 r.emit('event',{type:'spawn'});await new Promise(res=>setTimeout(res,1700))
 assert.equal(resumed,1);assert.equal(c.requestProgress.restartContinuations,1)
 writeFileSync(path,JSON.stringify({...saved,requestProgress:{...saved.requestProgress,restartContinuations:1}}))
 const d=new Teammate(new FakeRunner(),{model:'fake',plan:async()=>({reply:'',steps:[]})},path);assert.equal(d.restoreRequest,false)
})

test('a base counts as shelter only once its build task completed',()=>{
 const [r,c]=setup(async()=>({reply:'',steps:[]}))
 const goal={design:[{x:0,y:0,z:0,block:'wood_planks'}],origin:{x:4,y:64,z:5},near:{x:1,y:64,z:2},wood:'oak_log'}
 r.emit('event',{type:'task_finished',task:{id:'b1',kind:'build',status:'failed',goal}})
 assert.equal(c.projects.base.built,false)
 r.emit('event',{type:'task_finished',task:{id:'b2',kind:'build',status:'completed',goal}})
 assert.equal(c.projects.base.built,true)
 r.emit('event',{type:'task_finished',task:{id:'b3',kind:'build',status:'failed',goal}})
 assert.equal(c.projects.base.built,true,'a later failed repair on the same site does not unbuild it')
})

import {canContinueAfterSafety,SAFETY_CONTINUATIONS} from '../src/companion/continuity.js'
test('a request continues after each safety episode while it keeps completing steps, at most six times',()=>{
 const r={completed:[{step:{action:'gather'}}],safetyContinuations:[]}
 assert.equal(canContinueAfterSafety(r),true)
 r.safetyContinuations.push({completedAt:1});assert.equal(canContinueAfterSafety(r),true,'one idle continuation is allowed when threats repeat before a step completes')
 r.safetyContinuations.push({completedAt:1});assert.equal(canContinueAfterSafety(r),false,'two idle continuations at the same step count require an explicit Resume')
 r.resumeSerial=1;assert.equal(canContinueAfterSafety(r),true,'an explicit Resume starts a fresh idle allowance')
 r.safetyContinuations.push({completedAt:1,resumeSerial:1});assert.equal(canContinueAfterSafety(r),true,'the six-episode cap also counts only the current run')
 r.safetyContinuations.push({completedAt:1,resumeSerial:1});assert.equal(canContinueAfterSafety(r),false,'two idle continuations in this run')
 r.completed.push({step:{action:'build'}});assert.equal(canContinueAfterSafety(r),true)
 r.resumeSerial=0;r.safetyContinuations=Array.from({length:SAFETY_CONTINUATIONS},(_,i)=>({completedAt:i}));r.completed=Array(20).fill({});assert.equal(canContinueAfterSafety(r),false,'six episodes in one run')
})

test('a built base counts as shelter for the dusk rule only once it has a torch station',()=>{
 const [r,c]=setup(async()=>({reply:'',steps:[]}))
 r.bot.game={gameMode:'survival',difficulty:'normal'};r.bot.time={timeOfDay:13000};r.bot.health=20;r.bot.food=20;r.bot.entity={position:{x:0,y:64,z:0},onGround:true};r.bot.entities={}
 let reasons=[];c.seekSafety=async reason=>{reasons.push(reason)}
 c.projects.base={build:{origin:{x:4,y:64,z:5}},stations:{},built:true}
 r.emit('event',{type:'survival_tick'});assert.deepEqual(reasons,['Night with no shelter'])
 c.projects.base.stations.torch={position:{x:5,y:65,z:5}};c.safety=null
 r.emit('event',{type:'survival_tick'});assert.deepEqual(reasons,['Night with no shelter','Night with no shelter'],'a torch station recorded before placement is not a light')
 c.projects.base.stations.torch.confirmed=true;c.safety=null
 r.emit('event',{type:'survival_tick'});assert.deepEqual(reasons,['Night with no shelter','Night with no shelter'],'a confirmed torch suppresses the dusk rule')
})

test('every planner action has a spoken label, and an unknown one falls back instead of ending the round',()=>{
 const src=readFileSync(new URL('../src/companion/controller.js',import.meta.url),'utf8')
 const line=src.split('\n').find(l=>l.includes('const labels={'))
 for(const action of ['hunt','harvest','eat','prospect','return_base','place','gather','acquire','build','construct','revise','give','inspect','remember','return','come','follow','retreat','leave_base','stow','prepare','deposit','withdraw','smelt','check_base'])assert.ok(line.includes(action+':'),action+' label')
 assert.ok(src.includes('labels[s.action]||'),'fallback label')
})

test('a failed safety recovery runs again after a short pause while the emergency persists, at most three times',()=>{
 const [r,c]=setup(async()=>({reply:'',steps:[]}))
 r.bot.game={gameMode:'survival',difficulty:'normal'};r.bot.time={timeOfDay:6000};r.bot.health=20;r.bot.food=20;r.bot.entity={position:{x:0,y:64,z:0},onGround:true}
 r.bot.entities={1:{name:'zombie',position:new Vec3(5,64,0)}}
 const calls=[];c.seekSafety=async(reason,options)=>{calls.push([reason,options?.retries])}
 c.safety={status:'failed',error:'No verified shelter reached',failedAt:Date.now()-4000,retries:0}
 r.emit('event',{type:'survival_tick'});assert.deepEqual(calls,[['A potential hostile is within ten blocks',1]])
 c.safety={status:'failed',error:'No verified shelter reached',failedAt:Date.now(),retries:1}
 r.emit('event',{type:'survival_tick'});assert.equal(calls.length,1,'no retry inside the pause')
 c.safety={status:'failed',error:'No verified shelter reached',failedAt:Date.now()-4000,retries:3}
 r.emit('event',{type:'survival_tick'});assert.equal(calls.length,1,'bounded')
 c.safety={status:'failed',error:'Agent died',failedAt:Date.now()-4000,retries:0}
 r.emit('event',{type:'survival_tick'});assert.equal(calls.length,1,'never after death')
})

test('after a night retreat into the lit base, which records no shelterName, the continuation still holds until daylight',async()=>{
 const {continueAfterClearance}=Teammate.prototype
 const bot={time:{timeOfDay:15000},entity:{position:new Vec3(0,64,0)},entities:{},inventory:{items:()=>[]},game:{gameMode:'survival',difficulty:'normal'},health:20,food:20}
 const updates=[];let resumed=0
 const c={runner:{ready:true,bot,connectionId:'c1'},projects:{},epoch:1,nightHoldMs:400,requestProgress:{id:'r1',status:'interrupted',completed:[],safetyContinuations:[]},safety:{retreat:{receipt:'sheltered_door_closed'}},
  persist(){},emit(){},say(){},async resume(){resumed++}}
 const {clearanceObservation:_}=await import('../src/companion/hazard-clearance.js')
 const signal=new AbortController().signal
 const run=continueAfterClearance.call(c,1,signal,bot,{limitMs:400,check(){}})
 await new Promise(r=>setTimeout(r,150));updates.push(c.safety.continuation?.reason)
 bot.time.timeOfDay=17000;await new Promise(r=>setTimeout(r,150));updates.push(c.safety.continuation?.reason)
 await run
 assert.ok(updates.some(u=>/Waiting in the lit base for daylight|Health or food is not ready|Nearby chunks|Survival difficulty/.test(u||'')),JSON.stringify(updates))
 assert.equal(resumed,0,'never continues into the night')
})
