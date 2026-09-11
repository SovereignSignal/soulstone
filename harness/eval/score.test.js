import {test} from 'node:test'
import assert from 'node:assert/strict'
import {scorePlan} from './score.js'
const score=(steps,checks)=>scorePlan({reply:'',steps},checks).every(c=>c.passed)
test('here must be captured before leaving and matched after acquisition',()=>{
 const checks=[{type:'save-before-return'}]
 const save={action:'remember',name:'meeting'},acquire={action:'acquire',item:'stone_pickaxe',count:1},ret={action:'return',name:'meeting'}
 assert.equal(score([save,acquire,ret],checks),true)
 assert.equal(score([acquire,save,ret],checks),false)
 assert.equal(score([save,acquire,{...ret,name:'camp'}],checks),false)
})
test('total quantity and specific species must match',()=>{
 const checks=[{type:'acquire-or-gather',item:'spruce_log',count:7}]
 assert.equal(score([{action:'gather',item:'spruce_log',count:7}],checks),true)
 assert.equal(score([{action:'acquire',item:'spruce_log',count:7}],checks),true)
 assert.equal(score([{action:'gather',item:'spruce_log',count:4}],checks),false)
 assert.equal(score([{action:'gather',item:'oak_log',count:7}],checks),false)
})
test('failed target is prohibited without prohibiting inspection',()=>{
 const checks=[{type:'no-action',action:'acquire',item:'stone_pickaxe'}]
 assert.equal(score([{action:'inspect'}],checks),true)
 assert.equal(score([{action:'acquire',item:'stone_pickaxe',count:1}],checks),false)
})
test('empty plan is a structural check, not a semantic truth claim',()=>{
 assert.equal(score([],[{type:'no-steps'}]),true)
 assert.equal(score([{action:'follow'}],[{type:'no-steps'}]),false)
 assert.throws(()=>score([],[{type:'unknown'}]),/Unknown check/)
})
