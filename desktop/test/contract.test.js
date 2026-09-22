import {test} from 'node:test'
import assert from 'node:assert/strict'
import {validateCommand,childStatus} from '../contract.js'
test('renderer bridge rejects arbitrary actions and oversized or invalid requests',()=>{
 for(const name of ['exec','fetch','open-url','credentials','survival-session'])assert.throws(()=>validateCommand(name,{}),/Unknown/)
 for(const value of ['',{},'x'.repeat(2001)])assert.throws(()=>validateCommand('message',value))
 assert.throws(()=>validateCommand('save',{host:'x'.repeat(10001)}),/too large/)
 assert.throws(()=>validateCommand('models','other'));assert.throws(()=>validateCommand('mute','false'))
})
test('Talk is unavailable before connection, while dead, or with no model',()=>{
 for(const value of [null,{connected:false},{connected:true,dead:true,modelReady:true},{connected:true,modelReady:false}])assert.equal(childStatus(value).ready,false)
 assert.equal(childStatus({connected:true,modelReady:true,phase:'ready'}).ready,true)
 assert.equal(childStatus({connected:true,modelReady:true,phase:'retreating'}).ready,true)
})
