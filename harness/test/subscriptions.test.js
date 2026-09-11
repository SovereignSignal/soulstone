import {test} from 'node:test'
import assert from 'node:assert/strict'
import {subscriptionEnv,runClient,clientBinary} from '../src/companion/subscriptions.js'
import {validateProfile,ModelProfiles} from '../src/companion/providers.js'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
test('subscription processes never inherit API billing keys or parent agent context',()=>{
 const env=subscriptionEnv({HOME:'/home/test',PATH:'/bin',OPENAI_API_KEY:'secret',CODEX_API_KEY:'secret',ANTHROPIC_API_KEY:'secret',ANTHROPIC_BASE_URL:'https://other',XAI_API_KEY:'secret',CODEX_THREAD_ID:'parent'})
 assert.deepEqual(env,{HOME:'/home/test',PATH:'/bin'})
})
test('subscription profiles need no API credentials and keep exact model IDs',()=>{
 const p={id:'subscription',kind:'codex',label:'Codex',model:'gpt-5.6-astra',url:'',maxTokens:4096}
 assert.equal(validateProfile(p).model,'gpt-5.6-astra')
 const store=new ModelProfiles(join(mkdtempSync(join(tmpdir(),'mc-sub-test-')),'settings.json'),p)
 store.save(p,'');assert.equal(store.key,'');assert.equal(store.current.url,'')
})
test('subscription process cancellation stops an in-flight client',async()=>{
 const c=new AbortController();const pending=runClient(process.execPath,['-e','setTimeout(()=>{},60000)'],{signal:c.signal})
 setTimeout(()=>c.abort(),30);await assert.rejects(pending,/Cancelled/)
})
test('subscription process reports failure without echoing secret stderr',async()=>{
 const result=await runClient(process.execPath,['-e','process.stderr.write("fixture");process.exit(2)'])
 assert.equal(result.code,2)
})

test('subscription discovery supports standard package-manager installations without shell PATH',()=>{
 for(const kind of ['codex','claude']){
  for(const binary of [`/opt/homebrew/bin/${kind}`,`/usr/local/bin/${kind}`]){
   assert.equal(clientBinary(kind,{searchPath:'',canExecute:path=>path===binary}),binary)
  }
 }
})
test('subscription discovery supports absolute custom PATH entries and skips relative entries',()=>{
 const binary='/tmp/fixture tools/bin/codex',visited=[]
 assert.equal(clientBinary('codex',{searchPath:':.:relative/bin:/tmp/fixture tools/bin',canExecute:path=>{visited.push(path);return path===binary}}),binary)
 assert.ok(visited.every(path=>path.startsWith('/')))
 assert.throws(()=>clientBinary('codex',{searchPath:'.:',canExecute:()=>false}),/Install the codex CLI/)
 assert.throws(()=>clientBinary('../other',{canExecute:()=>true}),/supported subscription/)
})
