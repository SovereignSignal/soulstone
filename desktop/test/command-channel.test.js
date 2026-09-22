import {test} from 'node:test'
import assert from 'node:assert/strict'
import {CommandChannel} from '../command-channel.js'
test('Stop overtakes a message awaiting readiness and prevents its late submission',async()=>{
 const calls=[],channel=new CommandChannel(async(path,body)=>{calls.push({path,body});return {ok:true}})
 const pendingMessage=channel.advance()
 await channel.send('/stop')
 assert.deepEqual(await channel.send('/message',{text:'Follow me'},pendingMessage),{superseded:true})
 assert.deepEqual(calls.map(c=>c.path),['/stop'])
})
test('requests that are already in flight carry a monotonic sequence for server-side rejection',async()=>{
 const calls=[],channel=new CommandChannel(async(path,body)=>calls.push({path,body}))
 await channel.send('/message',{text:'Follow me'});await channel.send('/stop')
 assert.ok(calls[1].body.sequence>calls[0].body.sequence);assert.equal(calls[1].body.client,calls[0].body.client)
})
