import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {once} from 'node:events'
import protocol from 'minecraft-protocol'
import minecraftData from 'minecraft-data'
import {Runner} from '../src/runner.js'
import {validateSetup} from '../src/companion/setup.js'
import {checkConnection,describeServer,connectionFailure} from '../src/companion/connection-check.js'

const base={host:'localhost',port:25565,owner:'Player',username:'SoulBot',auth:'offline',version:'auto',provider:'codex',model:'gpt-6-astra'}
test('world identity retains state across port/version edits and rejects another world',()=>{
 const dir=mkdtempSync(join(tmpdir(),'soul-world-'))
 try{
  const worldId=randomUUID(),statePath=join(dir,'task.json')
  const first=new Runner({...base,worldId,statePath})
  first.task={id:'completed',kind:'follow',status:'cancelled',goal:{player:'Player'},deadline:Date.now()+60000};first.persist()
  const edited=new Runner({...base,worldId,statePath,port:25566,version:'26.1'})
  assert.equal(edited.profile,first.profile);assert.deepEqual(edited.task,first.task)
  assert.throws(()=>new Runner({...base,worldId:randomUUID(),statePath}),/different profile/)
  const legacy=JSON.stringify(['localhost',25565,'SoulBot','auto'])
  const legacyPath=join(dir,'legacy.json');new Runner({...base,statePath:legacyPath})
  const migrated=new Runner({...base,worldId,statePath:legacyPath,port:25567,profileIdentity:legacy})
  assert.equal(migrated.profile,legacy)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
test('setup rejects ambiguous addresses, altered world identities and invalid names',()=>{
 for(const patch of [{host:'localhost:25565'},{host:'bad/path'},{id:'../elsewhere'},{id:randomUUID(),identity:'["world","another"]'},{id:randomUUID(),identity:'{}'},{name:'x'.repeat(81)},{name:'bad\nname'}])assert.throws(()=>validateSetup({...base,...patch}))
 const id=randomUUID();assert.equal(validateSetup({...base,id}).identity,JSON.stringify(['world',id]))
 assert.equal(validateSetup({...base,host:'::1'}).host,'::1')
})
test('connection check distinguishes advertised compatibility from login permission',()=>{
 const status={version:{name:'26.1',protocol:minecraftData('26.1').version.version}}
 assert.equal(describeServer(status).status,'reachable')
 assert.match(describeServer(status).message,/will be checked when connecting/)
 assert.equal(describeServer(status,'1.21.4').status,'mismatch')
 assert.equal(describeServer({version:{name:'Future server',protocol:99999}}).status,'unsupported')
 assert.equal(describeServer({}).status,'unknown')
 assert.match(connectionFailure('{"translate":"multiplayer.disconnect.not_whitelisted"}'),/allowlist/)
 assert.match(connectionFailure('Failed to verify username'),/sign-in/)
 assert.match(connectionFailure('ECONNREFUSED'),/port/)
 assert.match(connectionFailure('ETIMEDOUT'),/VPN/)
 assert.match(connectionFailure('ENOTFOUND'),/resolved/)
})
test('actual status pings recognize 1.21.4, 1.21.11 and 26.1 without logging in',async()=>{
 for(const version of ['1.21.4','1.21.11','26.1']){
  const server=protocol.createServer({host:'127.0.0.1',port:0,version,'online-mode':false,motd:'Protocol fixture'})
  let logins=0;server.on('login',()=>logins++)
  try{
   await once(server,'listening')
   const result=await checkConnection({host:'127.0.0.1',port:server.socketServer.address().port,version:'auto'})
   assert.equal(result.status,'reachable');assert.equal(result.protocol,minecraftData(version).version.version)
   assert.equal(logins,0)
  }finally{server.close()}
 }
})
test('explicit-version checks use that handshake on protocol-translating servers',async()=>{
 const server=protocol.createServer({host:'127.0.0.1',port:0,version:false,fallbackVersion:'1.21.4','online-mode':false})
 try{
  await once(server,'listening')
  const result=await checkConnection({host:'127.0.0.1',port:server.socketServer.address().port,version:'1.21.4'})
  assert.equal(result.status,'reachable');assert.equal(result.protocol,minecraftData('1.21.4').version.version)
 }finally{server.close()}
})
