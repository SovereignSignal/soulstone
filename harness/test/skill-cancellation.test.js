import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Runner} from '../src/runner.js'
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
function fixture(){
 const calls=[]
 const bot={pathfinder:{setGoal:g=>calls.push(['goal',g])},clearControlStates:()=>calls.push('clear'),stopDigging:()=>calls.push('dig-stop'),deactivateItem:()=>calls.push('item-stop'),end:()=>assert.fail('Must stay connected')}
 const runner=Object.assign(Object.create(Runner.prototype),{bot,ready:true,task:{id:'old'},work:{bot,finished:false,cancelled:false},log:()=>{}})
 return {runner,bot,calls}
}
test('halt stays connected and handoff waits for old work to settle',async()=>{
 const {runner,bot,calls}=fixture();runner.halt()
 assert.equal(runner.ready,true);assert.equal(runner.bot,bot);assert.equal(runner.work.cancelled,true)
 assert.ok(calls.includes('dig-stop'));assert.ok(calls.includes('item-stop'))
 let handedOff=false;const waiting=runner.waitForIdle().then(()=>{handedOff=true})
 await new Promise(r=>setTimeout(r,30));assert.equal(handedOff,false)
 runner.work.finished=true;await waiting;assert.equal(handedOff,true)
})
test('stuck old operation blocks new work without disconnecting; Stop aborts handoff',async()=>{
 const {runner}=fixture();runner.halt()
 await assert.rejects(runner.waitForIdle(undefined,25),/refusing overlapping/)
 const abort=new AbortController(),waiting=runner.waitForIdle(abort.signal);abort.abort()
 await assert.rejects(waiting);assert.equal(runner.ready,true)
 assert.throws(()=>runner.assertAvailable(),/Skill still active/)
})

test('actual skill unwind prevents late completion and overlapping recovery',async()=>{
 const eating=deferred(),events=[]
 const {runner,bot}=fixture()
 bot.game={gameMode:'survival'};bot.food=10;bot.inventory={items:()=>[{name:'bread',count:2}]}
 bot.collectBlock={movements:{}};bot.equip=async()=>{};bot.consume=()=>eating.promise
 runner.work=null;runner.task={id:'eat',kind:'eat',status:'running',goal:{item:'bread',count:2}}
 runner.persist=()=>{};runner.say=()=>{};runner.log=(type)=>events.push(type)
 const pending=runner.runSkill();await new Promise(r=>setImmediate(r))
 assert.equal(runner.task.consumption.uncertain,true)
 runner.stop();const cancelled=runner.task
 let acquired=false;const handoff=runner.waitForIdle().then(()=>{acquired=true})
 await new Promise(r=>setTimeout(r,30));assert.equal(acquired,false)
 eating.resolve();await pending;await handoff
 assert.equal(runner.task,cancelled);assert.equal(runner.task.status,'cancelled')
 assert.equal(runner.task.result,undefined);assert.equal(runner.ready,true)
 assert.equal(events.filter(e=>e==='task_finished').length,1)
 assert.equal(events.at(-1),'skill_cancelled')
})
