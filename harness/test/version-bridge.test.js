import test from 'node:test'
import assert from 'node:assert/strict'
import {sessionJoinAuthorizer} from '../src/companion/version-bridge.js'
const uuid='a'.repeat(32),java={profile:{id:uuid,name:'Player'},token:'fixture-private-token'}
function fixture(result=java){let logins=0;return {store:{read:()=>({uuid,name:'Player'}),login:()=>{logins++;return {getMinecraftJavaToken:async()=>({...result}),mca:{fetchProfile:async()=>result.profile}}}},logins:()=>logins}}
test('bridge delegates only a validated identity and server hash to the fixed Mojang endpoint',async()=>{
 const f=fixture();let observed
 const authorize=sessionJoinAuthorizer(f.store,'fixture',{request:async(url,options)=>{observed={url,options};return {status:204}}})
 await authorize({uuid,hash:'-0123abcdef'})
 assert.equal(observed.url,'https://sessionserver.mojang.com/session/minecraft/join')
 assert.deepEqual(JSON.parse(observed.options.body),{accessToken:java.token,selectedProfile:uuid,serverId:'-0123abcdef'})
 assert.equal(observed.options.redirect,'error')
 for(const value of [{uuid:'b'.repeat(32),hash:'123'},{uuid,hash:'https://elsewhere/'},{uuid,hash:''},{uuid,hash:'a'.repeat(41)}])await assert.rejects(authorize(value),/Invalid bridge/)
 assert.equal(f.logins(),1)
})
test('bridge rejects changed account credentials and unsuccessful session authorization',async()=>{
 const f=fixture({...java,profile:{...java.profile,id:'b'.repeat(32)}});let sent=false
 await assert.rejects(sessionJoinAuthorizer(f.store,'fixture',{request:async()=>{sent=true}})({uuid,hash:'a'}),/different Minecraft/)
 assert.equal(sent,false)
 const valid=fixture();await assert.rejects(sessionJoinAuthorizer(valid.store,'fixture',{request:async()=>({status:403})})({uuid,hash:'123'}),/rejected/)
})

test('26.2 is a bounded translated route with explicit missing-runtime and version outcomes',async()=>{
 const {describeServer,connectionFailure}=await import('../src/companion/connection-check.js')
 const {validateServer}=await import('../src/companion/setup.js')
 assert.equal(validateServer({host:'localhost',port:25565,version:'26.2'}).version,'26.2')
 const status={version:{name:'26.2',protocol:776}}
 assert.equal(describeServer(status,'auto',true).route,'bridge')
 assert.equal(describeServer(status,'26.2',true).clientVersion,'1.21.4')
 assert.equal(describeServer(status,'26.2',false).status,'unsupported')
 assert.equal(describeServer({version:{name:'26.1',protocol:775}},'26.2',true).status,'mismatch')
 assert.equal(describeServer({version:{name:'future',protocol:9999}},'auto',true).status,'unsupported')
 assert.match(connectionFailure('multiplayer.disconnect.name_taken'),/already playing/)
})

test('an unsupported future version is an actionable update failure and never starts account authentication',async()=>{
 const {describeServer}=await import('../src/companion/connection-check.js')
 const {startVersionBridge}=await import('../src/companion/version-bridge.js')
 const result=describeServer({version:{name:'99.9',protocol:9999}},'auto',true)
 assert.equal(result.status,'unsupported')
 assert.match(result.message,/compatibility update/)
 let accountRead=false
 await assert.rejects(startVersionBridge({host:'127.0.0.1',port:1,serverVersion:'99.9',store:{read(){accountRead=true}}}),/no verified compatibility route/)
 assert.equal(accountRead,false)
})

test('all pinned routes retain version selection and cannot be mistaken for a different server',async()=>{
 const {bridgeRoutes,bridgeClientVersion}=await import('../src/companion/version-bridge.js')
 const {describeServer}=await import('../src/companion/connection-check.js')
 const {validateServer}=await import('../src/companion/setup.js')
 for(const route of bridgeRoutes){
  assert.equal(validateServer({host:'localhost',port:25565,version:route.version}).version,route.version)
  const status={version:{name:route.version,protocol:route.protocol}}
  for(const selected of ['auto',route.version]){
   const result=describeServer(status,selected,true)
   assert.equal(result.route,'bridge');assert.equal(result.serverVersion,route.version);assert.equal(result.clientVersion,bridgeClientVersion)
  }
  assert.equal(describeServer(status,route.version,false).status,'unsupported')
  assert.equal(describeServer({version:{name:'different',protocol:9999}},route.version,true).status,'mismatch')
 }
})
