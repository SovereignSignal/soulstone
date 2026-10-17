import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {Vec3} from 'vec3'
import {adaptiveRecovery,validateRecovery} from '../src/companion/adaptive-recovery.js'
import {recoveryState,recoveryContext,recentRecovery} from '../src/companion/recovery-context.js'
import {Teammate} from '../src/companion/controller.js'
import {threatState} from '../src/threat-judgement.js'
import {survivalObservation} from '../src/survival.js'

const limits={rounds:3,budgetMs:150,decisionMs:60,pollMs:1,quietMs:1,clearanceMs:6}
function fixture(choose,act=()=>{}){
 const mob={id:2,uuid:'12345678-1234-1234-1234-123456789012',name:'zombie',type:'hostile',position:new Vec3(8,64,0),equipment:[null,null,null,null,null,{name:'carved_pumpkin'}]}
 const bot={entity:{position:new Vec3(0,64,0),onGround:true},entities:{2:mob},game:{gameMode:'survival',difficulty:'easy'},time:{timeOfDay:6000},health:20,food:20,
  inventory:{items:()=>[{name:'stone_axe',count:1,maxDurability:131,durabilityUsed:0}],slots:[]},world:{getColumn:()=>({})}}
 const events=[],commands=[],runner=new EventEmitter()
 Object.assign(runner,{bot,ready:true,profile:'test',connectionId:'aaaaaaaa-1234-1234-1234-123456789012',position:()=>bot.entity.position,waitForIdle:async()=>{},log:(type,data)=>events.push({type,...data})})
 runner.command=command=>{
  if(command.action==='stop')return
  commands.push(command);runner.task={id:String(commands.length),kind:command.action,status:'running'}
  queueMicrotask(()=>{
   try{act(command,bot);runner.task={...runner.task,status:'completed',result:{receipt:command.action==='defend'?'target_death_observed':'fled'}}}
   catch(e){runner.task={...runner.task,status:'failed',reason:e.message}}
   runner.emit('event',{type:'task_finished',task:runner.task})
  })
 }
 const c={runner,epoch:1,projects:{},safety:{status:'retreating'},recoveryHistory:[],threatContextMode:'rich',requestProgress:{id:'r1',request:'Collect eight logs',completed:[],verification:{missing:['Eight retained logs']}},
  planner:{recover:choose},judgementContext:Teammate.prototype.judgementContext,execute:Teammate.prototype.execute,dispatch:x=>runner.command(x),leaveOccupiedShelter:async()=>{},persist(){}}
 const abort=new AbortController()
 return {c,bot,mob,events,commands,abort,run:(overrides={})=>adaptiveRecovery(c,1,abort.signal,bot,{...limits,...overrides})}
}
test('target equipment preserves unknown versus observed empty, and rich context includes actual objective',()=>{
 const {c,bot,mob}=fixture()
 assert.equal(recoveryState(bot).threats[0].headEquipment,'carved_pumpkin')
 mob.equipment[5]=null;assert.equal(recoveryState(bot).threats[0].headEquipment,'none')
 mob.equipment=[];assert.equal(recoveryState(bot).threats[0].headEquipment,null)
 const context=c.judgementContext(bot)
 assert.equal(threatState(survivalObservation(bot),context).decisionContext.objective.request,'Collect eight logs')
 assert.equal(threatState(survivalObservation(bot),{...context,contextMode:'legacy'}).decisionContext,undefined)
})
test('a failed escape reaches the next planning round; defense then verifies clearance',async()=>{
 let calls=0
 const f=fixture(async state=>{
  if(++calls===1)return {action:'flee',expectation:'Reach clear ground'}
  assert.equal(state.recentAttempts.at(-1).status,'failed')
  assert.match(state.recentAttempts.at(-1).reason,/No route/)
  assert.equal(state.observed.threats[0].headEquipment,'carved_pumpkin')
  assert.equal(state.capabilities.defend.engage,true)
  return {action:'defend',expectation:'Target death and clear area'}
 },(command,bot)=>{if(command.action==='flee')throw new Error('No route away');if(command.action==='defend')bot.entities={}})
 assert.equal(await f.run(),'cleared');assert.deepEqual(f.commands.map(c=>c.action),['flee','defend'])
 assert.equal(f.c.recoveryHistory.at(-1).after.threats.length,0)
})
test('a response cannot resume work without fresh clearance; failed verification informs reconsideration',async()=>{
 let calls=0
 const f=fixture(async state=>{
  if(++calls===1)return {action:'resume',expectation:'No threat remains'}
  assert.match(state.feedback.outcome,/Clearance was not established/)
  return {action:'shelter',expectation:'Verified enclosure'}
 })
 assert.equal(await f.run(),'shelter');assert.equal(f.commands.length,0)
})
test('fresh execution rejects a fight after equipment changes during planning',async()=>{
 const f=fixture(async()=>{f.bot.inventory.items=()=>[];return {action:'defend',expectation:'Kill the zombie'}})
 assert.equal(await f.run({rounds:1}),'fallback');assert.equal(f.commands.length,0)
 assert.match(f.events.find(e=>e.type==='recovery_action_rejected').outcome,/weapon/)
})
test('Stop and reconnect invalidate late responses without dispatching actions',async()=>{
 for(const type of ['stop','reconnect','disconnect']){
  let resolve
  const f=fixture(()=>new Promise(r=>{resolve=r}))
  const pending=f.run();await new Promise(r=>setTimeout(r,3))
  if(type==='stop'){f.c.epoch++;f.abort.abort()}else if(type==='reconnect')f.c.runner.connectionId='new';else f.c.runner.ready=false
  resolve({action:'defend',expectation:'Target death'})
  assert.equal(await pending,'cancelled');assert.equal(f.commands.length,0)
 }
})
test('slow or invalid models yield a bounded labelled fallback',async()=>{
 const slow=fixture(()=>new Promise(()=>{}))
 assert.equal(await slow.run({decisionMs:5}),'fallback')
 assert.match(slow.events.at(-1).reason,/budget/)
 const invalid=fixture(async()=>({action:'exec',expectation:'run arbitrary code'}))
 assert.equal(await invalid.run(),'fallback');assert.equal(invalid.commands.length,0)
})
test('imminent danger cancels slow deliberation without repeated protective escapes',async()=>{
 let signal
 const f=fixture((state,s)=>{signal=s;return new Promise(()=>{})})
 setTimeout(()=>{f.mob.position=new Vec3(4,64,0)},3)
 assert.equal(await f.run(),'fallback')
 assert.match(f.events.at(-1).reason,/Immediate proximity/)
 assert.equal(f.commands.length,0);assert.equal(signal.aborted,true)
})
test('inspection returns new facts and its outcome to the next decision',async()=>{
 let calls=0
 const f=fixture(async state=>{
  if(++calls===1)return {action:'inspect',expectation:'Identify nearby work resources and pursuing threats'}
  assert.equal(state.recentAttempts.at(-1).action,'inspect')
  assert.equal(state.feedback.changed,false)
  assert.match(state.feedback.outcome,/unverified/)
  assert.deepEqual(state.feedback.resources,[])
  return {action:'shelter',expectation:'Verified enclosure'}
 })
 assert.equal(await f.run(),'shelter');assert.equal(calls,2)
})
test('history is bounded, survives clear local outcomes, and cannot cross connection or objective boundaries',async()=>{
 const f=fixture()
 for(let i=0;i<20;i++)await f.c.execute({action:'flee',goal:{}},f.abort.signal)
 assert.equal(f.c.recoveryHistory.length,16);assert.equal(recentRecovery(f.c).length,8)
 assert.equal(recoveryContext(f.c,f.bot).recentAttempts[0].after.threats[0].id,f.mob.uuid)
 f.c.requestProgress.id='new request';assert.equal(recentRecovery(f.c).length,0)
 f.c.requestProgress.id='r1';f.c.runner.connectionId='new connection';assert.equal(recentRecovery(f.c).length,0)
})
test('the recovery boundary rejects unsupported actions and unbounded explanations',()=>{
 for(const value of [null,{action:'exec',expectation:'x'},{action:'inspect',expectation:''},{action:'inspect',expectation:'x'.repeat(501)},{action:'inspect',expectation:'x',code:'anything'}])assert.throws(()=>validateRecovery(value))
})

test('general planning receives the same recovery context after an interruption',async()=>{
 const f=fixture();f.c.runner.owner='Player'
 let observed
 const planner={model:'test',plan:async(text,state)=>{observed=state;return {reply:'Observed.',steps:[]}}}
 const c=new Teammate(f.c.runner,planner,join(mkdtempSync(join(tmpdir(),'recovery-context-')),'state.json'))
 await c.submit('make supplies')
 assert.equal(observed.recovery.objective.request,'make supplies')
 assert.equal(observed.recovery.observed.threats[0].headEquipment,'carved_pumpkin')
})
