import {Vec3} from 'vec3'
import {readFileSync} from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validatePlan, schema } from '../src/companion/planner.js'
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
 assert.deepEqual(c.places.meeting,{x:1,y:64,z:2,dimension:'overworld'});assert.deepEqual(r.commands.find(x=>x.action==='navigate').goal,{x:1,y:64,z:2})
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

// Lab, 5 October: a creeper cratered the base floor and blew the door out.
// Every retreat refused the base for an hour, and the planner, reading only
// built:true in projects, never thought of repairing it.
test('the planner is told when the saved base no longer passes the retreat inspection',async()=>{
 const design=[]
 for(let x=0;x<4;x++)for(let z=0;z<4;z++)for(let y=0;y<3;y++)if((y===2||x===0||x===3||z===0||z===3)&&!(x===1&&z===0&&y<2))design.push({x,y,z,block:'cobblestone'})
 const cells=new Map(design.map(d=>[new Vec3(10+d.x,64+d.y,20+d.z).toString(),d.block]))
 cells.set(new Vec3(11,63,21).toString(),'air')
 const registry=(await import('minecraft-data')).default('1.21.4')
 let observed
 const [r,c]=setup(async(_,o)=>{observed=o;return {reply:'Noted.',steps:[]}})
 r.bot.registry=registry;r.bot.findBlocks=()=>[]
 r.bot.blockAt=p=>{const name=cells.get(p.toString())??(p.y>=64?'air':'dirt');return {name,position:p.clone(),boundingBox:registry.blocksByName[name]?.boundingBox}}
 c.projects.base={build:{origin:{x:10,y:64,z:20},wood:'oak_log',design},built:true,stations:{torch:{position:{x:12,y:64,z:22},confirmed:true}}}
 await c.submit('how is the house')
 assert.equal(observed.baseCondition.usable,false);assert.match(observed.baseCondition.reason,/lacks support at 11,64,21/)
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
test('the agent remembers where it died so a recovery trip can be planned after respawn',async()=>{
 // The drop pile is the whole point: a real death cost a full kit because
 // nothing retained where it happened. deathPosition is captured today
 // (controller.js:154) but lives on `safety`, which the respawn branch nulls
 // before anything reads it, and which observe() never destructures.
 const [r,c]=setup(async()=>({reply:'ok',steps:[]}))
 c.phase='blocked';c.requestProgress={id:'diamond',request:'get a diamond',status:'blocked'}
 r.position=()=>({x:-249,y:63,z:264})
 r.ready=false;r.bot.health=0;r.bot.isAlive=false
 r.emit('event',{type:'death'})
 assert.deepEqual(c.snapshot().lastDeath?.position,{x:-249,y:63,z:264},'the death position is recorded where a reader can reach it')
 r.respawn=()=>{r.respawnPending=true};c.respawn()
 r.bot.health=20;r.bot.isAlive=true;r.respawnPending=false;r.ready=true;r.emit('event',{type:'spawn'})
 assert.deepEqual(c.snapshot().lastDeath?.position,{x:-249,y:63,z:264},'and it survives the respawn that clears safety')
})
test('the planner is told where the agent died so it can plan the recovery trip',async()=>{
 // Recording the position is useless if the model never receives it. observe()
 // destructures a fixed field list from snapshot(); anything absent from that
 // list cannot be planned against.
 let observed
 const [r,c]=setup(async(_,observation)=>{observed=observation;return {reply:'Understood.',steps:[]}})
 r.position=()=>({x:-249,y:63,z:264})
 r.ready=false;r.bot.health=0;r.bot.isAlive=false
 r.emit('event',{type:'death'})
 r.respawn=()=>{r.respawnPending=true};c.respawn()
 r.bot.health=20;r.bot.isAlive=true;r.respawnPending=false;r.ready=true
 r.position=()=>({x:0,y:64,z:0})
 r.emit('event',{type:'spawn'})
 await c.submit('go get my stuff back')
 assert.deepEqual(observed.lastDeath?.position,{x:-249,y:63,z:264},'the planner sees the death site, not the respawn point')
})
test('a death during a resumable request respawns without waiting for an operator',async()=>{
 // The whole cost of the 20 September death was that nobody was watching:
 // the agent sat dead while its drop pile despawned. No model call happens
 // while dead, so recovery cannot be a planner verb; it has to be automatic.
 const [r,c]=setup(async()=>({reply:'ok',steps:[]}))
 c.phase='blocked';c.requestProgress={id:'d',request:'get a diamond',status:'blocked'}
 let respawns=0;r.respawn=()=>{respawns++;r.respawnPending=true}
 r.ready=false;r.bot.health=0;r.bot.isAlive=false
 r.emit('event',{type:'death'})
 assert.equal(respawns,1,'the agent brings itself back')
})

// Fresh-world test on pi2, 9 October: killed at night, the bot said it would
// come back at daylight and then lay dead through the whole day. The dawn
// check ran on the survival tick, which comes from physics ticks, and a dead
// player has none. Daylight is watched on a clock of its own.
test('a bot that died at night comes back at daylight with no physics ticks while dead',async()=>{
 // Live on the test world the dead bot's clock also stayed frozen: no time
 // packet reached it, not even after a /time set. So dawn is worked out from
 // the time of death at twenty ticks a second, and an update that does arrive
 // still counts.
 const wait=ms=>new Promise(res=>setTimeout(res,ms))
 const night=()=>{const [r,c]=setup(async()=>({reply:'ok',steps:[]}));let now=0;c.now=()=>now;c.dawnPollMs=5
  c.phase='blocked';c.requestProgress={id:'d',request:'get a diamond',status:'blocked'}
  const n={r,c,respawns:0,advance:ms=>{now+=ms}};r.respawn=()=>{n.respawns++;r.respawnPending=true}
  r.bot.time={timeOfDay:15000};r.ready=false;r.bot.health=0;r.bot.isAlive=false;r.emit('event',{type:'death'});return n}
 const frozen=night()
 await wait(30);assert.equal(frozen.respawns,0,'not empty-handed into the dark')
 frozen.advance(8.2*60000);await wait(30);assert.equal(frozen.respawns,0,'10000 ticks (8.3 minutes) to dawn have not passed')
 frozen.advance(0.2*60000);await wait(30);assert.equal(frozen.respawns,1,'dawn by the clock brings it back with the bot clock frozen')
 await wait(30);assert.equal(frozen.respawns,1,'once')
 const told=night()
 told.r.bot.time.timeOfDay=2000;await wait(30);assert.equal(told.respawns,1,'a time update that does arrive counts at once')
})

test('automatic respawn is bounded so a spawn camp cannot loop it',async()=>{
 // Respawning into the thing that just killed you, forever, is worse than
 // stopping. After the budget the agent waits for a human.
 const {AUTO_RESPAWN_LIMIT}=await import('../src/companion/continuity.js')
 const [r,c]=setup(async()=>({reply:'ok',steps:[]}))
 c.phase='blocked';c.requestProgress={id:'d',request:'get a diamond',status:'blocked'}
 let respawns=0;r.respawn=()=>{respawns++;r.respawnPending=true}
 for(let i=0;i<AUTO_RESPAWN_LIMIT+2;i++){
  r.ready=false;r.bot.health=0;r.bot.isAlive=false
  r.emit('event',{type:'death'})
  r.bot.health=20;r.bot.isAlive=true;r.respawnPending=false;r.ready=true
  r.emit('event',{type:'spawn'})
 }
 assert.equal(respawns,AUTO_RESPAWN_LIMIT,'it stops after the budget instead of dying in a loop')
 assert.match(c.messages.at(-1).text,/next sunrise/,'and it says when it will try again')
 c.cancel?.(true)
})

// Fresh-world round 3 on pi1, 9 October: a creeper, a pillager and a creeper
// killed the empty-handed bot three times in two minutes at its spawn. After
// the budget it waited for a person who was not there, and lay dead for the
// rest of the run. It now waits for the next sunrise, a whole day for the
// crowd to move or burn, and tries again with a fresh budget.
test('after the respawn budget the bot tries again at the next sunrise with a fresh budget',async()=>{
 const {AUTO_RESPAWN_LIMIT}=await import('../src/companion/continuity.js')
 const wait=ms=>new Promise(res=>setTimeout(res,ms))
 const [r,c]=setup(async()=>({reply:'ok',steps:[]}));let now=0;c.now=()=>now;c.dawnPollMs=5
 c.phase='blocked';c.requestProgress={id:'d',request:'get a diamond',status:'blocked'}
 let respawns=0;r.respawn=()=>{respawns++;r.respawnPending=true}
 r.bot.time={timeOfDay:2000}
 const die=()=>{r.ready=false;r.bot.health=0;r.bot.isAlive=false;r.emit('event',{type:'death'})}
 const live=()=>{r.bot.health=20;r.bot.isAlive=true;r.respawnPending=false;r.ready=true;r.emit('event',{type:'spawn'})}
 for(let i=0;i<AUTO_RESPAWN_LIMIT;i++){die();live()}
 die();assert.equal(respawns,AUTO_RESPAWN_LIMIT)
 now+=10*60000;await wait(30);assert.equal(respawns,AUTO_RESPAWN_LIMIT,'not in the same day, even with the clock reading daylight')
 now+=10*60000;await wait(30);assert.equal(respawns,AUTO_RESPAWN_LIMIT+1,'at the next sunrise it comes back')
 assert.equal(c.requestProgress.autoRespawns,1,'with a fresh budget')
 c.cancel?.(true)
})
test('the brief tells the planner that death now recovers itself, and where the drop pile is',()=>{
 // A source-text assertion is the right shape here and only here: the prompt IS
 // data sent to the model, so its text is the behaviour. An observation field
 // the brief never names is a field the planner will not use.
 const brief=readFileSync(new URL('../src/companion/teammate-prompt.txt',import.meta.url),'utf8')
 assert.match(brief,/observation\.lastDeath/,'the death site is named so a recovery can be planned against it')
 assert.doesNotMatch(brief,/Death requires explicit Respawn agent/,'the brief no longer contradicts the controller')
})
test('the target guard rejects a target on an action that is not travel',()=>{
 // planner.js's travel-only target exclusivity is load-bearing and untested.
 // The `use` action will need a target, so this pins the current rule before
 // anything touches it.
 assert.throws(()=>validatePlan({reply:'x',steps:[{action:'gather',name:'',count:4,item:'oak_log',design:[],target:{x:1,y:2,z:3}}]}),/Only travel/)
})
test('water recovery preempts failed shelter logic and never waits for a model or lit base',async()=>{
 const {WATER_EMERGENCY}=await import('../src/survival.js')
 const [r,c]=setup(async()=>{throw new Error('No model call for air recovery')});r.bot.setControlState=()=>{}
 c.safety={status:'failed',reason:'Health is at or below half'};c.requestProgress={id:'diamond',request:'mine diamond',status:'running'}
 const calls=[];c.execute=async command=>{calls.push(command.action);r.task={result:{receipt:'dry_ground_reached'}}}
 await c.seekSafety(WATER_EMERGENCY)
 assert.deepEqual(calls,['surface']);assert.equal(c.requestProgress.status,'interrupted');assert.equal(c.requestProgress.feedback.at(-1).result.receipt,'dry_ground_reached');assert.equal(c.safety,null)
})
test('fire recovery preempts a shelter attempt, runs only the douse, then continues the request',async()=>{
 // Trial 21 died burning while the chain tried retreat, burrow, hut and descend
 // four times over: every one an answer to mobs, and walling in beside lava is refused.
 const {FIRE_EMERGENCY}=await import('../src/survival.js')
 const [r,c]=setup(async()=>{throw new Error('No model call for fire recovery')});r.bot.setControlState=()=>{}
 c.safety={status:'retreating',reason:'Health is at or below half'};c.requestProgress={id:'obsidian',request:'get 10 obsidian',status:'running'}
 c.lastDamageAt=Date.now();let resumed=false;c.resume=async()=>{resumed=true}
 const calls=[];c.execute=async command=>{calls.push(command.action);r.task={result:{receipt:'extinguished',method:'poured_water'}}}
 await c.seekSafety(FIRE_EMERGENCY)
 assert.deepEqual(calls,['douse']);assert.equal(c.safety,null)
 assert.equal(c.requestProgress.feedback.find(f=>f.action==='douse').result.method,'poured_water')
 assert.equal(c.lastDamageAt,null,'the damage came from the fire just put out, so it no longer reads as an attack')
 assert.equal(resumed,true)
})
test('a portal underfoot preempts even a fire and runs only the step out',async()=>{
 // Sov's limit: never enter the Nether. Four seconds in a lit portal carries a player through.
 const {PORTAL_EMERGENCY,FIRE_EMERGENCY}=await import('../src/survival.js')
 const [r,c]=setup(async()=>{throw new Error('No model call for a portal')});r.bot.setControlState=()=>{}
 c.safety={status:'retreating',reason:FIRE_EMERGENCY};c.requestProgress={id:'portal',request:'build and light a nether portal',status:'running'}
 let resumed=false;c.resume=async()=>{resumed=true}
 const calls=[];c.execute=async command=>{calls.push(command.action);r.task={result:{receipt:'out_of_portal'}}}
 await c.seekSafety(PORTAL_EMERGENCY)
 assert.deepEqual(calls,['leave_portal']);assert.equal(c.safety,null);assert.equal(resumed,true)
})
test('a douse that fails leaves safety failed for the bounded retry, not in a shelter',async()=>{
 const {FIRE_EMERGENCY}=await import('../src/survival.js')
 const [r,c]=setup(async()=>{throw new Error('No model call')});r.bot.setControlState=()=>{}
 c.requestProgress={id:'obsidian',request:'get 10 obsidian',status:'running'}
 const calls=[];c.execute=async command=>{calls.push(command.action);throw new Error('Still burning after 15 s')}
 await c.seekSafety(FIRE_EMERGENCY)
 assert.deepEqual(calls,['douse']);assert.equal(c.safety.status,'failed');assert.match(c.safety.error,/Still burning/)
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

import {shouldContinueAfterBudget,BUDGET_CONTINUATIONS,shouldRetryPlanning,PLAN_RETRIES,canResume as canResumeRequest} from '../src/companion/continuity.js'
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

// Lab, 5 October 02:52Z: a failed repair carried a design with a solid
// bottom layer (filling the room and its doorway), and the saved design was
// replaced by it; every retreat after that refused the base as malformed.
test('a failed build at the saved base keeps the saved design; a completed one replaces it',()=>{
 const [r,c]=setup(async()=>({reply:'',steps:[]}))
 const good={design:[{x:0,y:1,z:0,block:'cobblestone'}],origin:{x:4,y:64,z:5},near:{x:1,y:64,z:2},wood:'oak_log',purpose:'shelter'}
 r.emit('event',{type:'task_finished',task:{id:'b1',kind:'build',status:'completed',goal:good}})
 const bad={...good,design:[{x:0,y:0,z:0,block:'cobblestone'},{x:0,y:1,z:0,block:'cobblestone'}]}
 r.emit('event',{type:'task_finished',task:{id:'b2',kind:'build',status:'failed',goal:bad}})
 assert.deepEqual(c.projects.base.build.design,good.design);assert.equal(c.projects.base.built,true)
 r.emit('event',{type:'task_finished',task:{id:'b3',kind:'build',status:'completed',goal:bad}})
 assert.deepEqual(c.projects.base.build.design,bad.design)
})

test('only a shelter build becomes the base, and it counts as shelter only once it completed',()=>{
 const [r,c]=setup(async()=>({reply:'',steps:[]}))
 const goal={design:[{x:0,y:0,z:0,block:'wood_planks'}],origin:{x:4,y:64,z:5},near:{x:1,y:64,z:2},wood:'oak_log',purpose:'shelter'}
 r.emit('event',{type:'task_finished',task:{id:'b1',kind:'build',status:'failed',goal}})
 assert.equal(c.projects.base.built,false)
 r.emit('event',{type:'task_finished',task:{id:'b2',kind:'build',status:'completed',goal}})
 assert.equal(c.projects.base.built,true)
 r.emit('event',{type:'task_finished',task:{id:'b3',kind:'build',status:'failed',goal}})
 assert.equal(c.projects.base.built,true,'a later failed repair on the same site does not unbuild it')
 // Any other build used to be adopted as the base, wiping the station records
 // and leaving every place, deposit and check_base throwing afterwards.
 const before=JSON.stringify(c.projects.base)
 c.projects.base.stations={crafting_table:{position:{x:4,y:64,z:6},confirmed:true}}
 r.emit('event',{type:'task_finished',task:{id:'w1',kind:'build',status:'completed',goal:{design:[{x:0,y:0,z:0,block:'cobblestone'}],origin:{x:40,y:64,z:40},near:{x:1,y:64,z:2},wood:'oak_log'}}})
 assert.deepEqual(c.projects.base.build.origin,{x:4,y:64,z:5},'a wall built elsewhere is not the base')
 assert.deepEqual(Object.keys(c.projects.base.stations),['crafting_table'],'and its stations survive')
 assert.ok(before)
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
 // Derived from the schema, not listed by hand: a hardcoded list cannot notice
 // a new action, so it would let one ship with no spoken label and no way for
 // the planner to read its own refusal.
 // gather_and_return is rewritten before dispatch (planner.js) and never reaches the map.
 for(const action of schema.properties.steps.items.properties.action.enum.filter(a=>a!=='gather_and_return'))assert.ok(line.includes(action+':'),action+' label')
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

test('a new base origin drops the station records of the old one',()=>{
 // The wipe that made the origin choice matter: a fresh origin drops the torch
 // record, and unrecorded light is what produced 140 of 143 refusals in a session.
 // Still a source assertion, which proves only that the line reads this way. The
 // origin choice itself is now covered behaviourally by the two tests below.
 const source=readFileSync(new URL('../src/companion/controller.js',import.meta.url),'utf8')
 assert.match(source,/stations:sameSite\?\(this\.projects\.base\?\.stations\|\|\{\}\):\{\}/)
})

test('a shelter build far from the saved base builds where the agent is',async()=>{
 // A base 400 blocks away cannot shelter the agent tonight. Binding the build to
 // its origin sent a real run on a 387-block walk to a base that had gone stale,
 // and left no legal fallback: the contract that mandates the build action also
 // forbids named construction. Distance decides, so the lit-base repair below survives.
 const design=[{x:0,y:0,z:0,block:'wood_planks'}];let calls=0
 const [r,c]=setup(async()=>++calls===1?{reply:'Making camp.',steps:[{action:'build',design}]}:{reply:'Checked.',steps:[]})
 c.projects.base={build:{origin:{x:400,y:64,z:400},wood:'spruce_log',design},stations:{}}
 await c.submit('build me a shelter')
 const command=r.commands.find(x=>x.action==='build')
 assert.notDeepEqual(command.goal.origin,{x:400,y:64,z:400},'a distant base must not anchor tonight\u2019s shelter')
 assert.equal(command.goal.origin,undefined,'no origin means the builder surveys a fresh site here')
 assert.equal(command.goal.purpose,'shelter')
 assert.ok(command.goal.protectedSites,'the distant base is still protected from being built over')
})

test('a shelter build beside the saved base still repairs it',async()=>{
 // The repair this guards: a fresh site wipes the station records, and 140 of 143
 // 'no recorded light' refusals in one session followed exactly that.
 const design=[{x:0,y:0,z:0,block:'wood_planks'}];let calls=0
 const [r,c]=setup(async()=>++calls===1?{reply:'Repairing the base.',steps:[{action:'build',design}]}:{reply:'Checked.',steps:[]})
 c.projects.base={build:{origin:{x:4,y:64,z:5},wood:'spruce_log',design},stations:{}}
 await c.submit('build me a shelter')
 const command=r.commands.find(x=>x.action==='build')
 assert.deepEqual(command.goal.origin,{x:4,y:64,z:5},'a base within reach still supplies the origin')
 assert.equal(command.goal.wood,'spruce_log')
})

test('a planning call gets a budget of its own, larger than the generic client default',async()=>{
 const {PLAN_TIMEOUT_MS}=await import('../src/companion/subscriptions.js')
 assert.ok(PLAN_TIMEOUT_MS>=240000,`planning has room for a slow model call (${PLAN_TIMEOUT_MS}ms)`)
 const source=readFileSync(new URL('../src/companion/subscriptions.js',import.meta.url),'utf8')
 assert.match(source,/input:prompt,signal,timeout:PLAN_TIMEOUT_MS/,'the plan request passes it')
 assert.match(source,/timeout=120000/,'and the generic default is unchanged for status checks')
})

test('a client failure names its own cause, and stderr chatter never becomes a timeout',async()=>{
 const {runClient}=await import('../src/companion/subscriptions.js')
 const source=readFileSync(new URL('../src/companion/subscriptions.js',import.meta.url),'utf8')
 assert.match(source,/exceeded its \$\{Math\.round\(timeout\/1000\)\} second budget/,'a real timeout says so')
 assert.match(source,/returned more output than the harness will read/,'an oversized payload says so')
 assert.match(source,/err=err\.slice\(-200000\)/,'stderr is trimmed rather than aborted on')
 assert.doesNotMatch(source,/if\(err\.length>1000000\)abort\(\)/,'chatter no longer kills the call')
 // A client that writes a lot to stderr and then succeeds still succeeds.
 const noisy=await runClient('/bin/sh',['-c','i=0; while [ $i -lt 200 ]; do printf "%06000d" 1 >&2; i=$((i+1)); done; echo done'],{timeout:20000})
 assert.equal(noisy.code,0);assert.match(noisy.out,/done/)
 assert.ok(noisy.err.length<=400000,`stderr is capped, kept ${noisy.err.length} bytes`)
 await assert.rejects(runClient('/bin/sh',['-c','sleep 5'],{timeout:1000}),/exceeded its 1 second budget/)
})

test('a planner that never answered is asked again; one that answered and failed is not',async()=>{
 // An unattended hour was lost to a single slow planning call: the request went
 // blocked with nothing tried, and nothing ever asked again. No step ran, so the
 // timeout says nothing about whether the request can be done.
 const fresh=()=>({status:'blocked',completed:[],planRetries:0})
 assert.equal(shouldRetryPlanning(fresh(),0,'Subscription client exceeded its 300 second budget'),true)
 assert.equal(shouldRetryPlanning(fresh(),0,'The selected model could not be reached.'),true)
 assert.equal(shouldRetryPlanning(fresh(),0,'fetch failed'),true)
 // Work that actually ran is the budget rule's business, not this one.
 assert.equal(shouldRetryPlanning({status:'blocked',completed:[{},{}],planRetries:0},1,'Subscription client exceeded its 300 second budget'),false)
 // A planner that answered and produced an unusable plan is not a timeout.
 assert.equal(shouldRetryPlanning(fresh(),0,'I could not validate the proposed actions against your request.'),false)
 assert.equal(shouldRetryPlanning(fresh(),0,'Planning limit reached after 24 rounds.'),false)
 // Bounded: it does not retry for ever.
 assert.equal(shouldRetryPlanning({status:'blocked',completed:[],planRetries:PLAN_RETRIES},0,'fetch failed'),false)
 assert.ok(PLAN_RETRIES>=1&&PLAN_RETRIES<=3,'a small bound')
 // A request needing review is never retried automatically.
 assert.equal(canResumeRequest({status:'blocked',reviewRequired:true}),false,'a request needing review is never resumed automatically')
})


test('exhausted safety reacts to a new hostile and changed health, without reopening unchanged failures or Stop',()=>{
 const [r,c]=setup(async()=>({reply:'',steps:[]}))
 r.bot.game={gameMode:'survival',difficulty:'easy'};r.bot.time={timeOfDay:15000};r.bot.health=20;r.bot.food=20
 r.bot.entity={position:new Vec3(0,64,0),onGround:true};r.bot.entities={}
 const night='Night with no shelter'
 const {reason}=c.safety={status:'failed',reason:night,retries:3,failedAt:0}
 c.unsafeSignature={reason,key:c.safetyBlockKey()}
 const calls=[];c.seekSafety=async why=>{calls.push(why);c.safety={status:'retreating',reason:why}}
 const actual=night
 r.emit('event',{type:'survival_tick'});assert.equal(calls.length,0)
 r.bot.entities={1:{id:1,name:'zombie',position:new Vec3(3,64,0)}}
 r.emit('event',{type:'survival_tick'});assert.equal(calls.length,1);assert.match(calls[0],/hostile/)
 c.safety={status:'failed',reason:calls[0],retries:3,failedAt:0};c.unsafeSignature={reason:calls[0],key:c.safetyBlockKey()}
 r.emit('event',{type:'survival_tick'});assert.equal(calls.length,1)
 r.bot.health=12;r.emit('event',{type:'survival_tick'});assert.equal(calls.length,2)
 c.safety={status:'cancelled',reason:'Operator stop'};r.bot.health=8
 r.emit('event',{type:'survival_tick'});assert.equal(calls.length,2)
 c.safety={status:'failed',reason:actual,retries:3};r.bot.health=0;r.bot.isAlive=false
 r.emit('event',{type:'survival_tick'});assert.equal(calls.length,2)
})


test('retaining a mineral-named tool does not turn wood gathering into ore mining',async()=>{
 const {guardIntent}=await import('../src/companion/intent.js')
 const plan={reply:'Gathering',steps:[{action:'gather',item:'oak_log',count:8}]}
 for(const tool of ['stone axe','iron sword','diamond pickaxe','iron helmet'])assert.equal(guardIntent(plan,`Collect eight oak logs and retain your ${tool} and four bread.`).steps.length,1,tool)
 for(const request of ['mine diamonds','collect eight oak logs and iron ore','gather coal with a stone axe'])assert.equal(guardIntent(plan,request).steps.length,0,request)
})

test('a prepared shelter plan is consumed once only for its request, connection and freshness',async()=>{
 for(const mismatch of ['none','request','connection','expired']){
  let calls=0
  const [r,c]=setup(async()=>{calls++;return {reply:'Fresh plan',steps:[{action:'follow',name:'',count:0}]}})
  r.connectionId='live'
  c.requestProgress={id:'saved',request:'follow me',status:'interrupted',completed:[],pending:[],feedback:[]}
  const prepared={requestId:mismatch==='request'?'old':'saved',connectionId:mismatch==='connection'?'old':'live',createdAt:Date.now()-(mismatch==='expired'?90001:0),plan:{reply:'Prepared plan',steps:[{action:'follow',name:'',count:0}]}}
  await c.resume({automatic:true,prepared})
  assert.equal(calls,mismatch==='none'?0:1,mismatch)
  assert.equal(r.commands.filter(x=>x.action==='follow').length,1,mismatch)
 }
})


test('safety interruption preserves partial work once before recovery replaces the runner task',()=>{
 const [r,c]=setup(async()=>({reply:'',steps:[]}))
 const step={action:'hunt',item:'beef',count:4,name:''}
 c.requestProgress={id:'request',status:'running',completed:[],feedback:[],inFlight:{taskId:'search',step}}
 r.task={id:'search',kind:'hunt',status:'running',hunt:{legs:3,kills:0,attacks:0}}
 c.interrupt('Safety interruption: nearby hostile')
 r.task.hunt.legs=6;r.task={id:'escape',kind:'flee',status:'running'}
 c.interrupt('Recovery changed')
 const f=c.requestProgress.feedback
 assert.equal(f.length,1);assert.equal(f[0].status,'interrupted');assert.equal(f[0].observed.hunt.legs,3)
 assert.equal(f[0].taskId,'search');assert.equal(f[0].reason,'Safety interruption: nearby hostile')
 assert.equal(c.requestProgress.completed.length,0)
})
test('interruptions do not attribute an unrelated runner task to the current request',()=>{
 const [r,c]=setup(async()=>({reply:'',steps:[]}))
 c.requestProgress={id:'request',status:'running',feedback:[],inFlight:{taskId:'search',step:{action:'hunt'}}}
 r.task={id:'other',kind:'hunt',status:'running',hunt:{legs:6}}
 c.interrupt('Safety interruption')
 assert.deepEqual(c.requestProgress.feedback,[])
})


test('terrain recovery is validated, selected from local footing and returns a durable receipt',async()=>{
 const {schema}=await import('../src/companion/planner.js')
 const {guardIntent}=await import('../src/companion/intent.js')
 for(const action of ['descend','climb']){
  assert.ok(schema.properties.steps.items.properties.action.enum.includes(action))
  for(const bad of [{count:1},{item:'dirt'},{name:'base'},{design:[{x:0}]}])assert.throws(()=>validatePlan({reply:'Recovering',steps:[{action,name:'',item:'',count:0,design:[],...bad}]}))
 }
 let rounds=0,receipt
 const [r,c]=setup(async(_text,observation)=>{
  rounds++
  if(rounds===1){assert.equal(observation.footing.support.name,'oak_leaves');return guardIntent(validatePlan({reply:'Descending to observed ground',steps:[{action:'descend',name:'',item:'',count:0,design:[]}]}),_text)}
  receipt=observation.feedback.find(f=>f.action==='descend')
  return {reply:'Ground reached',steps:[]}
 })
 r.bot.entity={position:new Vec3(0,75,0),onGround:true};r.bot.blockAt=p=>({name:p.y===74?'oak_leaves':'air',boundingBox:p.y===74?'block':'empty'})
 r.command=function(command){this.emit('operator_command',command);this.commands.push(command);this.task={id:String(this.commands.length),kind:command.action,status:'running'};if(command.action!=='stop')queueMicrotask(()=>{this.task={...this.task,status:'completed',result:{receipt:'descended_to_ground',position:{x:6,y:65,z:0}}};this.emit('event',{type:'task_finished',task:this.task})})}
 await c.submit('Reach usable ground before continuing resources')
 assert.deepEqual(r.commands.filter(x=>x.action!=='stop'),[{action:'descend',goal:{},timeoutMs:45000}],JSON.stringify(c.messages))
 assert.equal(receipt.status,'completed');assert.equal(receipt.result.receipt,'descended_to_ground');assert.equal(rounds,2)
})

test('an inspect naming blocks widens the next round\'s world scan to them',async()=>{
 const {guardIntent}=await import('../src/companion/intent.js')
 let rounds=0,second
 const [r,c]=setup(async(_text,observation)=>{
  rounds++
  if(rounds===1){assert.ok(observation.world?.column,'the world channel reaches the planner');return guardIntent(validatePlan({reply:'Looking for obsidian',steps:[{action:'inspect',name:'',item:'obsidian',count:0,design:[]}]}),_text)}
  second=observation;return {reply:'Seen',steps:[]}
 })
 r.bot.entity={position:new Vec3(0.5,64,0.5),onGround:true};r.bot.entities={}
 r.bot.blockAt=p=>p.x===12&&p.y===64&&p.z===0?{name:'obsidian',boundingBox:'block'}:p.y<64?{name:'stone',boundingBox:'block'}:{name:'air',boundingBox:'empty',skyLight:15}
 await c.submit('Find obsidian nearby')
 assert.equal(rounds,2,JSON.stringify(c.messages))
 assert.deepEqual(c.requestProgress.requestedBlocks,['obsidian'])
 // Twelve blocks out is beyond the default look; only the request brings it into view.
 assert.ok(second.world.blocks.blocks.some(b=>b.name==='obsidian'&&b.x===12),JSON.stringify(second.world.blocks))
 assert.equal(second.world.blocks.scanned.radius,16)
})

test('a gather step carries the saved base footprint, since gather may dig toward a log',async()=>{
 const {guardIntent}=await import('../src/companion/intent.js')
 let rounds=0
 const [r,c]=setup(async(_text)=>{
  if(++rounds===1)return guardIntent(validatePlan({reply:'Getting wood',steps:[{action:'gather',name:'',item:'logs',count:3,design:[],target:null}]}),_text)
  return {reply:'Gathered',steps:[]}
 })
 c.projects={base:{build:{origin:{x:10,y:64,z:0},design:[{x:0,y:0,z:0,block:'cobblestone'}]}}}
 r.bot.entity={position:new Vec3(0.5,64,0.5),onGround:true};r.bot.entities={};r.bot.blockAt=p=>({name:p.y<64?'stone':'air',boundingBox:p.y<64?'block':'empty'})
 r.command=function(command){this.commands.push(command);this.task={id:String(this.commands.length),kind:command.action,status:'running'};if(command.action!=='stop')queueMicrotask(()=>{this.task={...this.task,status:'completed',result:{item:'logs',count:3}};this.emit('event',{type:'task_finished',task:this.task})})}
 await c.submit('Get three logs')
 const command=r.commands.find(x=>x.action==='gather')
 assert.ok(command,JSON.stringify(c.messages))
 assert.deepEqual(command.goal.protectedSites,[{minX:10,maxX:10,minZ:0,maxZ:0,minY:63}])
})

test('a collect step carries the saved base footprint, since collect may dig',async()=>{
 const {guardIntent}=await import('../src/companion/intent.js')
 let rounds=0
 const [r,c]=setup(async(_text)=>{
  if(++rounds===1)return guardIntent(validatePlan({reply:'Picking up the iron',steps:[{action:'collect',name:'',item:'raw_iron',count:1,design:[],target:null}]}),_text)
  return {reply:'Collected',steps:[]}
 })
 c.projects={base:{build:{origin:{x:10,y:64,z:0},design:[{x:0,y:0,z:0,block:'cobblestone'}]}}}
 r.bot.entity={position:new Vec3(0.5,64,0.5),onGround:true};r.bot.entities={};r.bot.blockAt=p=>({name:p.y<64?'stone':'air',boundingBox:p.y<64?'block':'empty'})
 r.command=function(command){this.commands.push(command);this.task={id:String(this.commands.length),kind:command.action,status:'running'};if(command.action!=='stop')queueMicrotask(()=>{this.task={...this.task,status:'completed',result:{receipt:'collected',gained:1}};this.emit('event',{type:'task_finished',task:this.task})})}
 await c.submit('Pick up the raw iron')
 const command=r.commands.find(x=>x.action==='collect')
 assert.ok(command,JSON.stringify(c.messages))
 assert.deepEqual(command.goal.protectedSites,[{minX:10,maxX:10,minZ:0,maxZ:0,minY:63}])
})

test('failed shelter retry carries only the same interrupted request eligibility and respects Stop',()=>{
 const [r,c]=setup(async()=>({reply:'',steps:[]}))
 r.bot.game={gameMode:'survival',difficulty:'normal'};r.bot.time={timeOfDay:6000};r.bot.health=20;r.bot.food=20;r.bot.entity={position:new Vec3(0,64,0),onGround:true};r.bot.entities={1:{name:'zombie',position:new Vec3(5,64,0)}}
 const calls=[];c.seekSafety=async(reason,options)=>calls.push(options)
 for(const [status,marker,review,expected] of [['interrupted','r1',null,true],['interrupted','old',null,false],['blocked','r1',null,false],['cancelled','r1',null,false],['interrupted','r1','Uncertain effect',false]]){
  c.requestProgress={id:'r1',status,reviewRequired:review,completed:[]}
  c.safety={status:'failed',error:'Protection unavailable',failedAt:Date.now()-4000,retries:0,resumeRequestId:marker}
  r.emit('event',{type:'survival_tick'});assert.equal(calls.at(-1).resumeInterrupted,expected);assert.equal(calls.at(-1).retries,1)
 }
 c.stop();const before=calls.length;r.emit('event',{type:'survival_tick'});assert.equal(calls.length,before)
})

test('an eligible shelter watch retains request identity even when protection verification fails',async()=>{
 const [r,c]=setup(async()=>({reply:'',steps:[]}))
 r.bot.entity={position:new Vec3(0,64,0),onGround:true};r.bot.blockAt=()=>null;r.bot.health=20;r.bot.time={timeOfDay:6000};r.bot.entities={}
 c.requestProgress={id:'work',status:'interrupted',completed:[]};c.safety={status:'burrowed',retreat:{shelterName:'burrow',surface:{x:0,y:70,z:0}}};c.shelterPlanning=false
 await c.waitInBurrow(c.epoch,new AbortController().signal,r.bot,true)
 assert.equal(c.safety.status,'failed');assert.equal(c.safety.resumeRequestId,'work');assert.equal(c.requestProgress.status,'interrupted')
})


test('shelter restoration waits for local chunks and Stop prevents delayed recovery',async()=>{
 const [r,c]=setup(async()=>({reply:'',steps:[]}));let loaded
 r.bot.entity={position:new Vec3(0,64,0),onGround:true};r.bot.blockAt=()=>null;r.bot.health=20
 r.bot.waitForChunksToLoad=()=>new Promise(resolve=>{loaded=resolve})
 c.requestProgress={id:'saved',status:'interrupted',completed:[]};c.safety={status:'burrowed',retreat:{shelterName:'burrow',surface:{x:0,y:68,z:0}}}
 const run=c.waitInBurrow(c.epoch,new AbortController().signal,r.bot,true)
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(c.safety.status,'burrowed');assert.equal(c.safety.resumeRequestId,'saved');assert.equal(r.commands.length,0)
 c.stop();loaded();await run;assert.equal(c.safety.status,'cancelled');assert.equal(c.requestProgress.status,'cancelled');assert.ok(r.commands.every(x=>x.action==='stop'))
})


test('brief clear readings do not erase shelter patience before the quiet window verifies departure',async()=>{
 const {default:minecraftData}=await import('minecraft-data')
 const [r,c]=setup(async()=>({reply:'',steps:[]}));const registry=minecraftData('1.21.4')
 Object.assign(r.bot,{registry,entity:{position:new Vec3(.5,64,.5),onGround:true},game:{gameMode:'survival',difficulty:'easy'},time:{timeOfDay:6000},health:17,food:11,
  blockAt(p){const name=p.x===0&&p.z===0&&p.y>=64&&p.y<=65||p.y>=68?'air':'dirt';return {name,position:p.clone(),boundingBox:registry.blocksByName[name].boundingBox}}})
 const hostile={1:{name:'skeleton',position:new Vec3(20,68,.5)}};r.bot.entities=hostile
 c.requestProgress={id:'work',status:'interrupted',completed:[],feedback:[]};c.safety={status:'burrowed',retreat:{shelterName:'burrow',surface:{x:0,y:68,z:0}}};c.shelterPlanning=false
 c.burrowWait={quietMs:1100,limitMs:2700,relocateAfterMs:400,watches:1}
 const commands=[];let resumed=0;c.execute=async command=>{commands.push(command.action);r.task={result:{receipt:command.action}}};c.resume=async()=>{resumed++}
 const gone=setTimeout(()=>{r.bot.entities={}},900),back=setTimeout(()=>{r.bot.entities=hostile},1400)
 try{await c.waitInBurrow(c.epoch,new AbortController().signal,r.bot,true)}finally{clearTimeout(gone);clearTimeout(back)}
 assert.equal(resumed,1);assert.deepEqual(commands,['unburrow','climb','flee']);assert.equal(c.requestProgress.safetyContinuations.length,1)
})


test('planner travel preserves its typed target through normalization, intent and execution',async()=>{
 const {guardIntent}=await import('../src/companion/intent.js'),{default:minecraftData}=await import('minecraft-data')
 const raw={reply:'Relocating to observed clear ground',steps:[{action:'travel',name:'',count:0,item:'',design:[],target:{x:16,y:64,z:0}}]}
 const plan=guardIntent(validatePlan(raw),'Find usable ground for the work');assert.deepEqual(validatePlan(plan),plan)
 for(const target of [null,{x:16,y:64},{x:16.5,y:64,z:0},{x:16,y:64,z:0,code:'no'},{x:16,y:64,z:0,how:'click'},{x:16,y:64,z:0,how:'click',dimension:'overworld'}])assert.throws(()=>validatePlan({...raw,steps:[{...raw.steps[0],target}]}),/Travel needs a target/,'travel keeps its three-key shape even though use has five')
 assert.throws(()=>validatePlan({...raw,steps:[{...raw.steps[0],action:'climb'}]}),/Only travel/)
 let count=0;const [r,c]=setup(async()=>++count===1?plan:{reply:'Arrived',steps:[]})
 Object.assign(r.bot,{registry:minecraftData('1.21.4'),findBlocks:()=>[],entity:{position:new Vec3(.5,64,.5),onGround:true},blockAt:p=>({name:p.y<=63?'dirt':'air',boundingBox:p.y<=63?'block':'empty'})})
 await c.submit('Find usable ground for the work')
 assert.deepEqual(r.commands.filter(x=>x.action!=='stop'),[{action:'travel',goal:{x:16,y:64,z:0},timeoutMs:180000}],JSON.stringify(c.messages))
})


test('automatic continuation retains failed prerequisites instead of authorizing unchanged retries',async()=>{
 let seen
 const [r,c]=setup(async(text,o)=>{seen=o;return {reply:'Current blocker retained.',steps:[]}})
 c.requestProgress={id:'saved',request:'find food',status:'interrupted',completed:[],pending:[],rounds:2,feedback:[{action:'harvest',status:'failed',reason:'No ripe bushes'},{action:'hunt',status:'failed',reason:'No animals',beforeResume:true}]}
 await c.resume({automatic:true})
 assert.equal(seen.feedback[0].beforeResume,undefined)
 assert.equal(seen.feedback[1].beforeResume,true,'an earlier explicit Resume marker is preserved')
 assert.match(seen.feedback.at(-1).reason,/preserves earlier failure evidence/)
 assert.equal(r.commands.length,0);assert.equal(c.requestProgress.id,'saved')
})
test('ordinary planning observes new ripe food while retaining its earlier failed harvest',async()=>{
 let calls=0,food=0
 const [r,c]=setup(async(text,o)=>{
  calls++;assert.equal(o.feedback[0].beforeResume,undefined)
  assert.equal(o.foraging.status,'observed');assert.equal(o.foraging.ripeCount,1)
  return calls===1?{reply:'A newly ripe bush supplies the missing food.',steps:[{action:'harvest',name:'',item:'sweet_berries',count:3}]}:{reply:'Food retained.',steps:[]}
 })
 const p=new Vec3(3,64,0)
 Object.assign(r.bot,{entity:{position:new Vec3(0,64,0),onGround:true},registry:{blocksByName:{sweet_berry_bush:{id:1}}},findBlocks:()=>[p],blockAt:q=>({name:q.equals(p)?'sweet_berry_bush':'air',boundingBox:'empty',getProperties:()=>({age:'3'})}),inventory:{items:()=>food?[{name:'sweet_berries',count:food}]:[]}})
 c.execute=async command=>{r.commands.push(command);food=3;r.task={id:'food',kind:'harvest',status:'completed',result:{item:'sweet_berries',count:3}}}
 c.requestProgress={id:'food-request',request:'find food',status:'interrupted',completed:[],pending:[],feedback:[{action:'harvest',status:'failed',reason:'No ripe bushes'}]}
 await c.resume({automatic:true})
 assert.equal(r.commands.filter(c=>c.action==='harvest').length,1);assert.equal(c.snapshot().inventory.sweet_berries,3)
})

const starterMission=()=>({kind:'task',summary:'Get fed, prepare tools and build a usable shelter.',projectMode:'none',milestones:['Food','Tools','Shelter'],constraints:[],criteria:[goalCriterion('hunger','',18),goalCriterion('tools','stone_pickaxe',1),goalCriterion('shelter','',1)],milestonePlan:[
 {id:'food',description:'Get fed',dependsOn:[],criteria:[0]},
 {id:'tools',description:'Prepare a usable pickaxe',dependsOn:['food'],criteria:[1]},
 {id:'shelter',description:'Build a usable shelter',dependsOn:['tools'],criteria:[2]}]})
const starterSteps=[{action:'eat',item:'sweet_berries',count:4},{action:'prepare',item:'stone_pickaxe',count:1},{action:'build',name:'shelter',design:[{x:0,y:0,z:0,block:'wood_planks'}]}]
function starterExecutor(r){
 let inventory=[{name:'sweet_berries',count:4}];r.bot.food=10;r.bot.health=20;r.bot.inventory.items=()=>inventory
 r.command=function(command){
  this.commands.push(command);this.task={id:String(this.commands.length),kind:command.action,status:'running',goal:command.goal}
  if(command.action==='stop')return
  if(command.action==='eat'){this.bot.food=20;inventory=inventory.filter(i=>i.name!=='sweet_berries')}
  if(command.action==='prepare')inventory.push({name:'stone_pickaxe',count:1,maxDurability:131,durabilityUsed:0})
  const result=command.action==='build'?{usability:{status:'usable'}}:{receipt:command.action==='eat'?'ate':'serviceable_tools_verified',count:1}
  queueMicrotask(()=>{this.task={...this.task,status:'completed',result};this.emit('event',{type:'task_finished',task:this.task})})
 }
}

test('compound mission replans at each verified stage and finishes only on original checks',async()=>{
 const stages=[],[r,c]=setup(async(_,o)=>{
  stages.push(o.activeMilestone?.id||null)
  const index=['food','tools','shelter'].indexOf(o.activeMilestone?.id)
  return {reply:index<0?'Verified.':'Continuing the active milestone.',steps:index<0?[]:starterSteps.slice(index)}
 });starterExecutor(r);c.planner.formulate=async()=>starterMission()
 await c.submit('Get me fed, equipped with a stone pickaxe and a usable shelter')
 assert.deepEqual(stages,['food','tools','shelter',null],JSON.stringify(c.requestProgress.feedback));assert.equal(c.requestProgress.status,'verified')
 assert.deepEqual(r.commands.filter(x=>x.action!=='stop').map(x=>x.action),['eat','prepare','build'])
 const saved=JSON.parse(readFileSync(c.statePath)).requestProgress
 assert.equal(saved.mission.nodes.every(n=>n.status==='verified'),true);assert.equal(saved.mission.requiresObservation,false)
 assert.equal(saved.verification.verdict,'passed');assert.equal(saved.goal.criteria.length,3)
})

test('mission reload resumes remaining work, preserves root goal and never repeats verified feeding',async()=>{
 let suspended,resolve
 const [r,c]=setup(async(_,o)=>o.activeMilestone.id==='food'?{reply:'Eating.',steps:[starterSteps[0]]}:new Promise(done=>{suspended=o;resolve=done}))
 starterExecutor(r);c.planner.formulate=async()=>starterMission()
 const run=c.submit('Get food, a pickaxe and shelter')
 while(!resolve)await new Promise(done=>setTimeout(done,2))
 const root=structuredClone(c.requestProgress.goal),id=c.requestProgress.id
 c.interrupt('Service restarted');resolve({reply:'Stale reply',steps:[starterSteps[1]]});await run
 assert.equal(suspended.activeMilestone.id,'tools')
 const reloaded=new Teammate(r,{model:'fake',formulate:async()=>{throw new Error('Must not reinterpret saved goal')},plan:async(_,o)=>({reply:'Continuing.',steps:o.activeMilestone?[starterSteps[['food','tools','shelter'].indexOf(o.activeMilestone.id)]]:[]})},c.statePath)
 assert.equal(reloaded.requestProgress.mission.requiresObservation,true)
 await reloaded.resume()
 assert.equal(reloaded.requestProgress.id,id);assert.deepEqual(reloaded.requestProgress.goal,root)
 assert.equal(reloaded.requestProgress.status,'verified');assert.equal(r.commands.filter(x=>x.action==='eat').length,1)
})

test('Stop cancels a mission and rejects a late planner reply without scheduling another stage',async()=>{
 let resolve;const [r,c]=setup(()=>new Promise(done=>resolve=done));starterExecutor(r);c.planner.formulate=async()=>starterMission()
 const run=c.submit('Get food, a pickaxe and shelter')
 while(!resolve)await new Promise(done=>setTimeout(done,2))
 c.stop();resolve({reply:'Eating.',steps:starterSteps});await run
 assert.equal(c.requestProgress.status,'cancelled');assert.equal(c.requestProgress.mission.status,'cancelled')
 assert.equal(r.commands.filter(x=>x.action!=='stop').length,0);await assert.rejects(c.resume(),/No interrupted request/)
})


test('a hard restart marks saved milestone evidence stale before Resume observes the world',()=>{
 const [r,c]=setup(async()=>({reply:'',steps:[]}));starterExecutor(r)
 c.requestProgress={id:'hard-restart',request:'Get food, a pickaxe and shelter',status:'running',goal:starterMission(),feedback:[],completed:[],pending:[]}
 c.verifyGoal();c.persist();assert.equal(c.requestProgress.mission.requiresObservation,false)
 const restored=new Teammate(r,c.planner,c.statePath)
 assert.equal(restored.requestProgress.status,'interrupted');assert.equal(restored.requestProgress.mission.requiresObservation,true)
 assert.equal(restored.requestProgress.mission.status,'interrupted');assert.match(restored.requestProgress.mission.blocker,/restarted/)
})

test('plain team regroup uses current owner observations without any model call',async()=>{
 const {LocalPlanner}=await import('../src/companion/planner.js')
 const [r,c]=setup(null);c.planner=new LocalPlanner({url:'http://127.0.0.1:1/v1/chat/completions'})
 r.position=()=>({x:0,y:64,z:0});r.bot.players.Sov.entity.position={x:15,y:64,z:0}
 r.command=function(command){this.commands.push(command);this.task={id:String(this.commands.length),status:'running',kind:command.action,goal:command.goal};if(command.action==='travel')queueMicrotask(()=>{r.position=()=>({x:15,y:64,z:0});this.task={...this.task,status:'completed',result:{receipt:'arrived'}};this.emit('event',{type:'task_finished',task:this.task})})}
 await c.submit('come to where all of us are playing')
 assert.equal(c.phase,'ready');assert.deepEqual(r.commands.filter(x=>x.action!=='stop').map(x=>x.action),['travel'])
 assert.equal(r.commands.find(x=>x.action==='travel').goal.player,'Sov');assert.match(c.messages.at(-1).text,/regrouped with Sov/)
})

test('regroup distinguishes unknown location, blocked terrain and bounded recovery without broadening intent',async()=>{
 const {regroupPlan}=await import('../src/companion/direct-plan.js')
 const o={owner:'Sov',position:{x:0,y:64,z:0},ownerPosition:{x:40,y:70,z:0},footing:{onGround:true,support:{name:'oak_leaves'}},feedback:[]}
 for(const text of ['regroup','regroup with the team','come to us','join us','meet me'])assert.equal(regroupPlan(text,o).steps[0].action,'come')
 for(const text of ['do not come to us','come to us and build a house','come to Alex','if I ask, regroup'])assert.equal(regroupPlan(text,o),null)
 assert.match(regroupPlan('regroup',{...o,ownerPosition:null}).reply,/cannot currently locate/)
 o.feedback.push({action:'come',status:'failed',reason:'No route'});assert.equal(regroupPlan('regroup',o).steps[0].action,'descend')
 o.feedback.push({action:'descend',status:'completed'});assert.equal(regroupPlan('regroup',o).steps[0].action,'come')
 o.feedback.push({action:'come',status:'failed',reason:'No route'});assert.equal(regroupPlan('regroup',o).steps.length,0)
 assert.match(regroupPlan('regroup',o).reply,/can locate Sov, but the route is blocked/)
})

test('a blocked request retries itself when the agent is healthy, bounded, instead of sitting forever',async()=>{
 // On the persistent Proxmox world "get a diamond" blocked on its first step
 // and sat for eight hours: alive, connected, full health, nothing watching.
 // Blocked meaning "a human should look" is right for an attended session and
 // fatal for a continuous one, so it retries a few times and then stops loudly.
 const {STALL_CONTINUATIONS}=await import('../src/companion/continuity.js')
 let resumes=0
 const [r,c]=setup(async()=>({reply:'ok',steps:[]}))
 c.resume=async()=>{resumes++}
 c.phase='blocked'
 c.requestProgress={id:'d',request:'get a diamond',status:'blocked',blocker:'The goal was changed before it could be completed!'}
 // the stall clock is only consulted on a survival tick, so drive ticks
 for(let i=0;i<STALL_CONTINUATIONS+3;i++){
  c.blockedSince=1                                  // long past the delay
  await c.stallRetry()
 }
 assert.equal(resumes,STALL_CONTINUATIONS,`bounded at ${STALL_CONTINUATIONS}, got ${resumes}`)
 assert.match(c.messages.at(-1).text,/blocked/i,'and it says why it stopped trying')
})

test('a stall retry never fires while the agent is dead, disconnected or needs review',async()=>{
 let resumes=0
 const [r,c]=setup(async()=>({reply:'ok',steps:[]}))
 c.resume=async()=>{resumes++}
 c.phase='blocked';c.blockedSince=1
 c.requestProgress={id:'d',request:'x',status:'blocked',reviewRequired:'An interrupted use may have charged the item'}
 await c.stallRetry();assert.equal(resumes,0,'a request needing review is not retried behind a human')
 c.requestProgress={id:'d',request:'x',status:'blocked'}
 r.ready=false;await c.stallRetry();assert.equal(resumes,0,'nor while disconnected')
 r.ready=true;r.bot.health=0;r.bot.isAlive=false
 await c.stallRetry();assert.equal(resumes,0,'nor while dead')
})

test('real progress refills the stall budget, so a long run is not capped at three recoveries',async()=>{
 // The budget was per-request and never reset. On the persistent world the
 // agent worked for hours, mining cobblestone 17 -> 54 and descending y 82 ->
 // 49, spent its three recoveries on transient blocks along the way, and then
 // parked permanently while still making progress. Three is the right cap for
 // "stuck"; it is the wrong cap for "has been working all afternoon".
 const {STALL_CONTINUATIONS}=await import('../src/companion/continuity.js')
 let resumes=0
 const [r,c]=setup(async()=>({reply:'ok',steps:[]}))
 c.resume=async()=>{resumes++}
 c.phase='blocked'
 c.requestProgress={id:'d',request:'get a diamond',status:'blocked',blocker:'Route blocked'}
 for(let i=0;i<STALL_CONTINUATIONS;i++){c.blockedSince=1;await c.stallRetry()}
 assert.equal(resumes,STALL_CONTINUATIONS,'budget spent')
 c.blockedSince=1;await c.stallRetry()
 assert.equal(resumes,STALL_CONTINUATIONS,'and exhausted')
 // now the agent actually gets somewhere
 r.bot.inventory={items:()=>[{name:'cobblestone',count:54}]}
 c.noteProgress()
 c.blockedSince=1;await c.stallRetry()
 assert.equal(resumes,STALL_CONTINUATIONS+1,'observable progress earns the budget back')
})

test('the progress fingerprint ignores sub-block drift, so the stop rules can actually fire',async()=>{
 // progressFingerprint ended with the raw float position, and runner.js returns
 // raw floats, so a bot standing still on a pillar changed its own fingerprint
 // by micrometres between physics packets. That defeated BOTH planner stop
 // rules: the repeat-failure signature needs two identical ones, and stagnation
 // needs three. The live run churned 239 rounds without either firing.
 const {progressFingerprint}=await import('../src/companion/continuity.js')
 const base={inventory:{},tools:[],places:{},projects:{},requestProgress:{completed:[],verification:{checks:[]}}}
 const a=progressFingerprint({...base,position:{x:-726.6861273589012,y:53,z:-276.3111473889956}})
 const b=progressFingerprint({...base,position:{x:-726.6861273589099,y:53,z:-276.3111473889812}})
 assert.equal(a,b,'a bot that has not left its block has not made progress')
 const moved=progressFingerprint({...base,position:{x:-725.1,y:53,z:-276.3}})
 assert.notEqual(a,moved,'but leaving the block still counts')
})
test('every command timeout the controller writes is one the runner accepts',async()=>{
 // Trial 22: make_obsidian went out with timeoutMs 900000, the runner accepts at
 // most 600000, and all five calls failed at once, so the planner fell back to
 // composing goto and use for eighteen minutes. The planner validation and the
 // skill were both tested; the command between them was not.
 const {TASK_TIMEOUT_MAX_MS}=await import('../src/runner.js')
 const source=readFileSync(new URL('../src/companion/controller.js',import.meta.url),'utf8')
 const literals=[...source.matchAll(/timeoutMs:\s*(\d+)/g)].map(m=>Number(m[1]))
 assert.ok(Number.isInteger(TASK_TIMEOUT_MAX_MS),'the runner exports its limit')
 assert.ok(literals.length>20,'the scan found the command table')
 assert.deepEqual(literals.filter(ms=>ms<1000||ms>TASK_TIMEOUT_MAX_MS),[])
})

// Lab runs 99 to 101, 10 October: a blaze-rod request continues after a safety
// interruption only twice without a new completed step, and fights are not
// steps. A rod picked up is verified progress all the same.
import {noteAdvance,canContinueAfterCombat,continuationMark} from '../src/companion/continuity.js'
test('a criterion item gained counts as progress for the safety and combat continuation budgets',()=>{
 const r={completed:[],safetyContinuations:[],combatContinuations:[],goal:{criteria:[{kind:'inventory',item:'blaze_rod',count:3},{kind:'at_base',target:'base'}]}}
 assert.equal(noteAdvance(r,{blaze_rod:0}),false,'the first look sets the baseline')
 r.safetyContinuations.push({...continuationMark(r)},{...continuationMark(r)})
 assert.equal(canContinueAfterSafety(r),false,'two idle continuations and nothing gained')
 assert.equal(noteAdvance(r,{blaze_rod:1,cobblestone:9}),true,'a rod picked up')
 assert.equal(canContinueAfterSafety(r),true,'continues after the rod')
 assert.equal(noteAdvance(r,{blaze_rod:1}),false,'the same rod is not progress twice')
 assert.equal(noteAdvance(r,{blaze_rod:0}),false);assert.equal(noteAdvance(r,{blaze_rod:1}),false,'dropping and regaining is not progress')
 assert.equal(noteAdvance(r,{blaze_rod:9}),true);assert.equal(noteAdvance(r,{blaze_rod:12}),false,'nothing past the criterion counts')
 for(let i=0;i<3;i++){assert.equal(canContinueAfterCombat(r),true,'fight '+i);r.combatContinuations.push({...continuationMark(r)})}
 assert.equal(canContinueAfterCombat(r),false,'three fights with nothing gained')
 r.goal.criteria[0].count=4;assert.equal(noteAdvance(r,{blaze_rod:4}),true);assert.equal(canContinueAfterCombat(r),true,'a fight that gained resets the fight budget')
 const old={completed:[],combatContinuations:[{},{},{}]};assert.equal(canContinueAfterCombat(old),false,'entries with no mark still count')
 const six={completed:[],goal:r.goal,safetyContinuations:Array.from({length:SAFETY_CONTINUATIONS},(_,i)=>({completedAt:i,advancedAt:0})),advances:1}
 assert.equal(canContinueAfterSafety(six),true,'the six-episode cap counts from the last advance')
})
