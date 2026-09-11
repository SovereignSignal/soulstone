import test from 'node:test'
import assert from 'node:assert/strict'
import {Runner} from '../src/runner.js'
function fixture(kind){
 const bot={},calls=[]
 const runner=Object.assign(Object.create(Runner.prototype),{bot,ready:true,task:{kind,status:'running'},finish:(...args)=>calls.push(args)})
 return {bot,runner,calls}
}
test('exhausted plain navigation immediately reports a recoverable route failure',()=>{
 for(const kind of [undefined,'navigate']){
  const {bot,runner,calls}=fixture(kind);runner.pathUpdated(bot,{status:'noPath',path:[]})
  assert.equal(calls.length,1);assert.equal(calls[0][0],'failed');assert.match(calls[0][1],/current terrain/)
 }
})
test('partial searches, old connections and skill-owned navigation cannot fail a plain task',()=>{
 for(const status of ['partial','success']){const {bot,runner,calls}=fixture();runner.pathUpdated(bot,{status,path:[]});assert.equal(calls.length,0)}
 for(const kind of ['follow','retreat','gather','prospect']){const {bot,runner,calls}=fixture(kind);runner.pathUpdated(bot,{status:'noPath',path:[]});assert.equal(calls.length,0)}
 const {bot,runner,calls}=fixture();runner.pathUpdated({},{status:'noPath',path:[]});assert.equal(calls.length,0)
 runner.task.status='cancelled';runner.pathUpdated(bot,{status:'noPath',path:[]});assert.equal(calls.length,0)
 runner.task.status='running';runner.ready=false;runner.pathUpdated(bot,{status:'noPath',path:[]});assert.equal(calls.length,0)
})

test('search timeout reports uncertainty immediately instead of waiting for the navigation deadline',()=>{
 const {bot,runner,calls}=fixture();runner.pathUpdated(bot,{status:'timeout',path:[]})
 assert.equal(calls.length,1);assert.equal(calls[0][0],'failed');assert.match(calls[0][1],/search exceeded its time budget/)
})
