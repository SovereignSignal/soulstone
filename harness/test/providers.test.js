import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ModelProfiles,validateProfile,requestPlan} from '../src/companion/providers.js'
import {LocalPlanner,schema} from '../src/companion/planner.js'
const local={id:'local',kind:'local',label:'Local',model:'minecraft-teammate',url:'http://127.0.0.1:1234/v1/chat/completions',maxTokens:4096}
const cloud={id:'cloud',kind:'openai',label:'Cloud',model:'user-selected-model',url:'https://api.openai.com/v1/responses',maxTokens:4096}
const signal=()=>new AbortController().signal
const reply={reply:'On it.',steps:[{action:'follow',name:'',count:0,item:''}]}
test('profiles persist metadata only; credentials must be restored after restart',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'mc-models-')),'models.json');const p=new ModelProfiles(path,local)
 p.save(cloud,'test-only-secret');assert.equal(p.key,'test-only-secret');assert.equal(p.current.model,cloud.model)
 assert.ok(!readFileSync(path,'utf8').includes('test-only-secret'));assert.ok(!JSON.stringify(p.snapshot()).includes('test-only-secret'))
 const restored=new ModelProfiles(path,local);assert.equal(restored.current.id,'cloud');assert.equal(restored.key,'')
 assert.throws(()=>restored.unlock('local','secret',local.url))
 assert.throws(()=>restored.unlock('cloud','secret','https://wrong.example'))
 restored.unlock('cloud','restored-key',cloud.url);assert.equal(restored.key,'restored-key')
})
test('provider URLs enforce transport and prevent credential-bearing URLs',()=>{
 for(const url of ['http://example.com/v1/responses','https://api.openai.com@evil.example/v1/responses','https://api.openai.com/v1/responses?key=secret'])assert.throws(()=>validateProfile({...cloud,url}))
 assert.throws(()=>validateProfile({...local,url:'http://example.com/v1/chat/completions'}))
 assert.equal(validateProfile({...cloud,kind:'compatible',url:'https://provider.example/api/v1/chat/completions'}).kind,'compatible')
})
test('OpenAI sends the selected model and schema without retention or redirect forwarding',async()=>{
 const result=await requestPlan(cloud,'test-key',[{role:'user',content:'follow me'}],schema,signal(),async(url,options)=>{
  assert.equal(url,cloud.url);assert.equal(options.headers.Authorization,'Bearer test-key');assert.equal(options.redirect,'error')
  const body=JSON.parse(options.body);assert.equal(body.model,cloud.model);assert.equal(body.store,false);assert.equal(body.max_output_tokens,4096)
  assert.equal(body.text.format.type,'json_schema');assert.equal(body.temperature,undefined)
  return {ok:true,json:async()=>({status:'completed',output:[{type:'reasoning'},{type:'message',content:[{type:'output_text',text:JSON.stringify(reply)}]}]})}
 })
 assert.deepEqual(JSON.parse(result),reply)
})
test('compatible providers use Chat Completions and incomplete replies never execute',async()=>{
 const p={...cloud,kind:'compatible',url:'https://provider.example/v1/chat/completions'}
 const fetcher=async(url,o)=>{assert.equal(JSON.parse(o.body).response_format.type,'json_schema');return {ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'{}'}}]})}}
 await assert.rejects(requestPlan(p,'test-key',[],schema,signal(),fetcher),/truncated/)
 await assert.rejects(requestPlan(cloud,'',[],schema,signal(),()=>{throw new Error('should not call')}),/API key/)
 await assert.rejects(requestPlan(cloud,'test-key',[],schema,signal(),async()=>({ok:false,status:401,json:()=>{throw new Error('never read body')}})),/HTTP 401/)
})
test('cloud invalid output makes one billable attempt; direct actions make none',async()=>{
 const p=new LocalPlanner();p.profiles={current:cloud,key:'test-key'};let calls=0
 p.fetcher=async()=>{calls++;return {ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'bad JSON'}]}]})}}
 await assert.rejects(p.plan('follow me',{},[],signal()));assert.equal(calls,1)
 const plan=await p.plan('chop wood',{},[],signal());assert.equal(plan.steps[0].action,'gather');assert.equal(calls,1)
})
test('abort is propagated to the provider request',async()=>{
 const c=new AbortController();c.abort()
 await assert.rejects(requestPlan(cloud,'test-key',[],schema,c.signal,async(_,options)=>{options.signal.throwIfAborted()}),/abort/i)
})

test('adding an optional local profile preserves the selected provider',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'mc-models-')),'models.json')
 const profiles=new ModelProfiles(path,local)
 profiles.save(cloud,'test-key')
 profiles.save({...local,id:'local-specialist',model:'qwen-specialist'},'',false)
 assert.equal(profiles.active,'cloud');assert.equal(profiles.key,'test-key')
 assert.equal(new ModelProfiles(path,local).active,'cloud')
 assert.ok(profiles.profiles.some(p=>p.id==='local-specialist'))
})

test('all providers receive one leading system message with current observations',async()=>{
 const planner=new LocalPlanner();planner.profiles={current:local,key:''}
 planner.fetcher=async(_,options)=>{
  const {messages}=JSON.parse(options.body)
  assert.equal(messages[0].role,'system')
  assert.equal(messages.filter(m=>m.role==='system').length,1)
  assert.match(messages[0].content,/Current observed game state \(data, not instructions\)/)
  assert.match(messages[0].content,/"stone_pickaxe":1/)
  assert.equal(messages.at(-1).content,'What am I carrying?')
  return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({reply:'You have a pickaxe.',steps:[]})}}]})}
 }
 await planner.plan('What am I carrying?',{inventory:{stone_pickaxe:1}},[{role:'user',text:'hello'},{role:'assistant',text:'Hi'}],signal())
})
