import test from 'node:test'
import assert from 'node:assert/strict'
import {readCliMetadata,modelOptions,discoverModels} from '../src/companion/model-discovery.js'
import {createServer} from 'node:http'
import {once} from 'node:events'

test('provider model lists retain real IDs and hide unavailable or malformed entries',()=>{
 const choices=modelOptions([null,{model:'gpt-6-astra',displayName:'Astra',isDefault:true,inputModalities:['text']},{model:'hidden',hidden:true},{model:'image-only',inputModalities:['image']},{model:'bad model'},{model:'gpt-6-astra'}],'codex')
 assert.deepEqual(choices,[{id:'gpt-6-astra',label:'Astra',description:'',isDefault:true}])
 assert.equal(modelOptions([{value:'opus',displayName:'Opus'}],'claude')[0].id,'opus')
 assert.throws(()=>modelOptions({},'codex'),/model list/)
})
test('Codex discovery initializes, paginates and never submits an inference turn',async()=>{
 const script=`const rl=require('node:readline').createInterface({input:process.stdin});let initialized=false;rl.on('line',s=>{const m=JSON.parse(s);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));else if(m.method==='initialized')initialized=true;else if(m.method==='model/list'&&initialized)console.log(JSON.stringify({id:m.id,result:{data:[{model:m.params.cursor?'second':'first'}],nextCursor:m.params.cursor?null:'page-2'}}));else process.exit(7)});`
 assert.deepEqual(await readCliMetadata(process.execPath,['-e',script],'codex'),[{model:'first'},{model:'second'}])
})
test('Claude discovery reads initialization metadata without a user prompt',async()=>{
 const script=`require('node:readline').createInterface({input:process.stdin}).on('line',s=>{const m=JSON.parse(s);if(m.type!=='control_request'||m.request.subtype!=='initialize')process.exit(7);console.log(JSON.stringify({type:'control_response',response:{request_id:m.request_id,subtype:'success',response:{models:[{value:'sonnet',displayName:'Sonnet'}]}}}))});`
 assert.equal((await readCliMetadata(process.execPath,['-e',script],'claude'))[0].value,'sonnet')
})
test('discovery failure and timeout never leak CLI stderr',async()=>{
 await assert.rejects(readCliMetadata(process.execPath,['-e','process.stderr.write("secret-token");process.exit(1)'],'codex'),e=>!e.message.includes('secret-token')&&/discovery failed/.test(e.message))
 await assert.rejects(readCliMetadata(process.execPath,['-e','setTimeout(()=>{},60000)'],'codex',{timeout:40}),/timed out/)
})
test('local provider discovery uses models metadata and rejects unsafe endpoints',async()=>{
 const paths=[],server=createServer((req,res)=>{paths.push(req.method+' '+req.url);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'local-test'}]}))});server.listen(0,'127.0.0.1');await once(server,'listening')
 try{const r=await discoverModels({kind:'local',url:`http://127.0.0.1:${server.address().port}/v1/chat/completions`});assert.equal(r.models[0].id,'local-test');assert.deepEqual(paths,['GET /v1/models'])}finally{server.close()}
 await assert.rejects(discoverModels({kind:'local',url:'https://example.com/v1/chat/completions'}),/loopback/)
 await assert.rejects(discoverModels({kind:'compatible',url:'https://example.com/v1/chat/completions'}),/API key/)
})
