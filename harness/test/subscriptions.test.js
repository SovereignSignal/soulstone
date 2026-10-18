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

test('muse processes keep XDG locations but never inherit the Meta API key',()=>{
 const env=subscriptionEnv({HOME:'/home/test',PATH:'/bin',XDG_CONFIG_HOME:'/home/test/cfg',XDG_DATA_HOME:'/home/test/data',META_API_KEY:'secret'})
 assert.deepEqual(env,{HOME:'/home/test',PATH:'/bin',XDG_CONFIG_HOME:'/home/test/cfg',XDG_DATA_HOME:'/home/test/data'})
})
test('muse profiles need no API credentials and keep exact Muse model IDs',()=>{
 for(const model of ['muse-wonder-1.0','muse-wonder-full-1.0','muse-spark-1.3']){
  const p={id:'muse-sub',kind:'muse',label:'Muse subscription',model,url:'',maxTokens:4096}
  assert.equal(validateProfile(p).model,model)
  assert.equal(validateProfile(p).url,'')
 }
})
test('muse login lives under the XDG config directory, defaulting to ~/.config',async()=>{
 const {museLoginPath}=await import('../src/companion/subscriptions.js')
 assert.equal(museLoginPath({env:{},home:'/home/test'}),'/home/test/.config/muse/auth.json')
 assert.equal(museLoginPath({env:{XDG_CONFIG_HOME:'/cfg'},home:'/home/test'}),'/cfg/muse/auth.json')
})
test('muse planning runs headless with no tools, a prompt file and a strict output schema',async()=>{
 const {museExecArgs}=await import('../src/companion/subscriptions.js')
 const args=museExecArgs('muse-wonder-full-1.0',{schemaPath:'/tmp/x/schema.json',promptPath:'/tmp/x/prompt.txt'})
 assert.equal(args[0],'exec')
 for(const flag of ['--preset','--output-schema','--prompt-file','--model','--no-session-log','--disable-shell','--disable-write','--disable-web-tools','--disable-request-user-input','--max-model-steps'])assert.ok(args.includes(flag),flag)
 assert.equal(args[args.indexOf('--preset')+1],'empty')
 assert.equal(args[args.indexOf('--model')+1],'muse-wonder-full-1.0')
 assert.equal(args[args.indexOf('--output-schema')+1],'/tmp/x/schema.json')
 assert.equal(args[args.indexOf('--prompt-file')+1],'/tmp/x/prompt.txt')
})
test('subscription discovery supports standard package-manager installations without shell PATH',()=>{
 for(const kind of ['codex','claude','muse']){
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
