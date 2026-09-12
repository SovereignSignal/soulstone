import {test,mock} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Runner,MAX_TASK_MS} from '../src/runner.js'
import {saveTask,loadTask} from '../src/task-store.js'
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
function fixture(){
 const bot={isAlive:true,pathfinder:{setGoal(){}},clearControlStates(){},stopDigging(){},deactivateItem(){},end(){assert.fail('Must stay connected')}}
 const runner=Object.assign(Object.create(Runner.prototype),{bot,ready:true,task:null,work:null,log(){},persist(){},say(){},applyGoal(){}})
 return {runner,bot}
}
test('a skill task carries an idle window and a hard ceiling; progress slides the deadline but never past the ceiling',()=>{
 mock.timers.enable({apis:['Date'],now:1_000_000})
 try{
  const {runner}=fixture()
  runner.skill('gather',{item:'oak_log',count:4},60000)
  assert.equal(runner.task.deadline,1_060_000);assert.equal(runner.task.idleMs,60000);assert.equal(runner.task.hardDeadline,1_180_000)
  mock.timers.tick(45000);runner.extend();assert.equal(runner.task.deadline,1_105_000)
  mock.timers.tick(100000);runner.extend();assert.equal(runner.task.deadline,1_180_000)
  runner.task.status='completed';mock.timers.tick(1000);runner.extend();assert.equal(runner.task.deadline,1_180_000)
  runner.skill('gather',{item:'oak_log',count:4},600000)
  assert.equal(runner.task.hardDeadline-runner.task.deadline,MAX_TASK_MS-600000)
  const legacy=fixture().runner;legacy.task={id:'old',kind:'gather',status:'running',goal:{item:'oak_log',count:4},deadline:1_500_000}
  legacy.extend();assert.equal(legacy.task.deadline,1_500_000)
 }finally{mock.timers.reset()}
})
test('resume refreshes the idle window from the moment of resumption',()=>{
 mock.timers.enable({apis:['Date'],now:1_000_000})
 try{
  const {runner}=fixture()
  runner.skill('gather',{item:'oak_log',count:4},60000)
  runner.task.status='paused';mock.timers.tick(50000)
  runner.resume();assert.equal(runner.task.status,'running');assert.equal(runner.task.deadline,1_110_000)
  runner.task.status='paused';mock.timers.tick(200000)
  runner.resume();assert.equal(runner.task.status,'failed');assert.equal(runner.task.reason,'task deadline exceeded')
 }finally{mock.timers.reset()}
})
test('skill persistence and progress callbacks extend the running task',async()=>{
 mock.timers.enable({apis:['Date'],now:1_000_000})
 try{
  const eating=deferred(),{runner,bot}=fixture()
  bot.game={gameMode:'survival'};bot.food=10;bot.inventory={items:()=>[{name:'bread',count:2}]}
  bot.collectBlock={movements:{}};bot.equip=async()=>{};bot.consume=()=>eating.promise
  runner.task={id:'eat',kind:'eat',status:'running',goal:{item:'bread',count:2},deadline:1_030_000,idleMs:30000,hardDeadline:1_090_000}
  mock.timers.tick(20000)
  const pending=runner.runSkill();await new Promise(r=>setImmediate(r))
  assert.equal(runner.task.deadline,1_050_000)
  // The fake bot never confirms consumption; Stop unwinds the skill's poll.
  runner.stop();eating.resolve();await pending;assert.equal(runner.task.status,'cancelled')
 }finally{mock.timers.reset()}
})
test('task state accepts the idle fields and rejects malformed ones',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'soulstone-task-')),'task.json')
 const base={id:'t',kind:'gather',status:'running',goal:{item:'oak_log',count:4},deadline:9_000_000}
 saveTask(path,'p',{...base,idleMs:60000,hardDeadline:9_500_000})
 const loaded=loadTask(path,'p',1000);assert.equal(loaded.idleMs,60000);assert.equal(loaded.hardDeadline,9_500_000)
 saveTask(path,'p',base);assert.equal(loadTask(path,'p',1000).idleMs,undefined)
 saveTask(path,'p',{...base,idleMs:'soon'});assert.throws(()=>loadTask(path,'p',1000),/invalid task state/)
 saveTask(path,'p',{...base,hardDeadline:null});assert.throws(()=>loadTask(path,'p',1000),/invalid task state/)
})
