import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {CompanionService} from '../service.js'

test('real harness starts with isolated state, requires its token, rejects browser origins, and closes cleanly',async()=>{
 const root=mkdtempSync(join(tmpdir(),'soulstone-desktop-test-'))
 const service=new CompanionService({harness:resolve('../harness'),root,environment:{HOME:root,USERPROFILE:root,PATH:root,SystemRoot:process.env.SystemRoot||''},fork:(file,_args,options)=>spawn(process.execPath,[file],{cwd:options.cwd,env:options.env,stdio:['ignore','pipe','pipe']}),killTree:child=>child.kill()})
 const id=randomUUID()
 try{
  // Port 1 on loopback is deliberately unavailable. No live world or model is used.
  await service.start({id,identity:JSON.stringify(['world',id]),host:'127.0.0.1',port:1,owner:'FixtureOwner',username:'FixtureBot',auth:'offline',version:'1.21.4',provider:'codex',model:'fixture'})
  const state=await service.request('/state');assert.equal(state.connected,false);assert.equal(state.worldId,id)
  assert.equal((await fetch(service.url+'/state')).status,403)
  assert.equal((await fetch(service.url+'/state',{headers:{Authorization:'Bearer '+service.token,Origin:'https://untrusted.example'}})).status,403)
  assert.equal((await service.request('/stop',{})).ok,true)
  const setup=join(root,'worlds',id,'connection.json');assert.ok(existsSync(setup));assert.equal(JSON.parse(readFileSync(setup)).id,id)
  await service.shutdown();assert.equal(service.child,null);assert.equal(service.url,null);assert.ok(existsSync(setup))
 }finally{await service.shutdown();rmSync(root,{recursive:true,force:true})}
})
