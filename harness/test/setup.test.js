import test from 'node:test'
import assert from 'node:assert/strict'
import {validateSetup,validateSavedConnection} from '../src/companion/setup.js'
import {Runner} from '../src/runner.js'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const base={host:'localhost',port:25565,owner:'Player',username:'SoulBot',auth:'offline',version:'auto',provider:'codex',model:'gpt-6-astra'}
test('unfinished connections save without an account but remain invalid for runtime startup',()=>{
 const pending={...base,auth:'microsoft',username:'',owner:'',model:''}
 const saved=validateSavedConnection(pending)
 assert.equal(saved.host,'localhost');assert.equal(saved.username,'');assert.equal(saved.owner,'')
 assert.equal(saved.minecraftAccountId,undefined)
 assert.throws(()=>validateSetup(saved),/player name/)
 assert.throws(()=>validateSetup({...saved,owner:'Player',model:'gpt-6-astra'}),/bot login/)
 for(const patch of [{host:'https://example.com'},{port:0},{minecraftAccountId:'../other'},{owner:'bad name'},{model:'bad model'},{provider:'unknown'}])assert.throws(()=>validateSavedConnection({...pending,...patch}))
})
test('setup rejects URL injection, invalid ports, same-player login and invalid providers',()=>{
 for(const change of [{host:'https://example.com'},{host:'host\nMC_PASSWORD=secret'},{port:0},{port:65536},{port:1.5},{username:'Player'},{owner:'bad name'},{version:'../state'},{auth:'unknown'},{provider:'unknown'},{model:'bad model'}])assert.throws(()=>validateSetup({...base,...change}))
 assert.equal(validateSetup({...base,host:' ::1 '}).host,'::1')
 assert.equal(validateSetup({...base,provider:'muse',model:'muse-wonder-full-1.0'}).provider,'muse')
})
test('Microsoft login accepts account identifier without weakening offline names',()=>{
 const value={...base,auth:'microsoft',username:'bot@example.com'}
 assert.equal(validateSetup(value).username,'bot@example.com')
 assert.throws(()=>validateSetup({...value,auth:'offline'}))
 assert.throws(()=>validateSetup({...value,username:'\n'}))
})
test('version selection accepts bundled old and new releases and rejects unknown protocols',()=>{
 for(const version of ['auto','1.16.5','1.21','1.21.4','1.21.11','26.1','26.2','26.3'])assert.equal(validateSetup({...base,version}).version,version)
 // 26.3 joined with ViaProxy 3.4.13; the next unreleased version stays refused.
 for(const version of ['1.7.10','1.99.9','26.4','99.1','26.1-snapshot','26.1\nsecret'])assert.throws(()=>validateSetup({...base,version}))
})
test('runner preserves legacy offline profile keys and isolates Microsoft identity',()=>{
 const dir=mkdtempSync(join(tmpdir(),'soul-setup-'))
 try {
  const options={...base,statePath:join(dir,'task.json')}
  const offline=new Runner(options)
  assert.equal(offline.profile,JSON.stringify(['localhost',25565,'SoulBot','auto']))
  assert.throws(()=>new Runner({...options,auth:'microsoft'}),/different profile/)
  const code=()=>{}, online=new Runner({...options,statePath:join(dir,'online.json'),auth:'microsoft',profilesFolder:join(dir,'auth'),onMsaCode:code})
  assert.notEqual(online.profile,offline.profile)
  assert.equal(online.options.onMsaCode,code)
  assert.equal(online.options.auth,'microsoft')
  assert.equal(online.options.version,false)
 } finally {rmSync(dir,{recursive:true,force:true})}
})
