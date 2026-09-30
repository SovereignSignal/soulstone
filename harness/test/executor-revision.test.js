import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {sourceRevision} from '../src/revision.js'
import {ExperienceStore} from '../src/companion/experience.js'

test('a source hotfix invalidates prior experience without a package revision change or history deletion',()=>{
 const root=mkdtempSync(join(tmpdir(),'executor-revision-'))
 try{
  const src=join(root,'src');mkdirSync(join(src,'companion'),{recursive:true})
  writeFileSync(join(src,'revision.json'),JSON.stringify({revision:'bundle-108'}))
  writeFileSync(join(src,'use-item.js'),'reject protected targets')
  writeFileSync(join(src,'companion/capabilities.txt'),'saved projects are protected')
  const before=sourceRevision(src),store=new ExperienceStore(join(root,'experience.json'),'test')
  store.record({requestId:'old',summary:'Light a portal',criteria:[],version:'1.21.4',executor:before,evidence:[{action:'use',status:'failed',reason:'saved project footprint'}],reflection:{lessons:[]},verdict:'blocked'})
  assert.equal(store.retrieve('Light a portal',null,'1.21.4',{executor:before})[0].stale,false)
  writeFileSync(join(src,'use-item.js'),'allow verified protected portal ignition')
  const after=sourceRevision(src);assert.notEqual(after,before)
  const found=new ExperienceStore(join(root,'experience.json'),'test').retrieve('Light a portal',null,'1.21.4',{executor:after})
  assert.equal(found[0].stale,true);assert.equal(found[0].evidence[0].reason,'saved project footprint')
  writeFileSync(join(src,'revision.json'),JSON.stringify({revision:'bundle-109'}))
  assert.equal(sourceRevision(src),after,'build labels do not stand in for runtime content')
  writeFileSync(join(src,'companion/capabilities.txt'),'verified saved-frame ignition is supported')
  assert.notEqual(sourceRevision(src),after,'planner capability changes also invalidate experience')
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('lessons without executor provenance are stale and cannot outrank current evidence',()=>{
 const root=mkdtempSync(join(tmpdir(),'executor-unknown-'))
 try{
  const store=new ExperienceStore(join(root,'experience.json'),'test')
  for(const [requestId,executor] of [['unknown',null],['current','source-current']])store.record({requestId,summary:'Light portal',criteria:[],version:'1.21.4',executor,evidence:[{action:'use',status:'failed',reason:'blocked'}],reflection:{lessons:[]},verdict:'blocked'})
  const found=store.retrieve('Light portal',null,'1.21.4',{executor:'source-current'})
  assert.equal(found[0].executor,'source-current');assert.equal(found[0].stale,false)
  assert.equal(found[1].executor,null);assert.equal(found[1].stale,true)
 }finally{rmSync(root,{recursive:true,force:true})}
})
