import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {EventEmitter} from 'node:events'
import {PortalTravel,validatePortalTravel} from '../src/portal-travel.js'
import {Teammate} from '../src/companion/controller.js'

// workstreams/minecraft/nether-plan.md, step 1: the per-world switch. Off is
// the harness as it was; the family world stays off until Sov turns it on.
test('nether travel is off unless saved on, and only off and on are accepted',()=>{
 assert.deepEqual(validatePortalTravel(),{nether:'off'})
 assert.deepEqual(validatePortalTravel({nether:'on'}),{nether:'on'})
 assert.throws(()=>validatePortalTravel({nether:'yes'}),/off, on/)
 const path=join(mkdtempSync(join(tmpdir(),'mc-portal-travel-')),'portal-travel.json')
 const t=new PortalTravel(path)
 assert.equal(t.snapshot().nether,'off');assert.equal(t.allows('the_nether'),false)
 assert.deepEqual(t.save({nether:'on'}),{nether:'on',settings:['off','on']})
 assert.equal(new PortalTravel(path).allows('the_nether'),true,'the setting survives a restart')
 assert.equal(t.allows('the_end'),false,'the End is not part of this switch')
 writeFileSync(path,'{"nether":"sideways"}');assert.equal(new PortalTravel(path).snapshot().nether,'off','a damaged file is off, not on')
})

test('the planner sees the portal travel setting, and off without one',async()=>{
 class Runner extends EventEmitter{constructor(){super();this.profile='lab';this.owner='Sov';this.ready=true;this.commands=[];this.bot={players:{},inventory:{items:()=>[]}}}position(){return {x:0,y:64,z:0}}command(c){this.commands.push(c);this.task={id:String(this.commands.length),status:'running'}}}
 const r=new Runner()
 let observed
 const c=new Teammate(r,{model:'fake',plan:async(_,o)=>{observed=o;return {reply:'Noted.',steps:[]}}},join(mkdtempSync(join(tmpdir(),'mc-companion-')),'state.json'))
 await c.submit('where can you go')
 assert.deepEqual(observed.portalTravel,{nether:'off'},'no switch at all reads as off')
 r.portalTravel=new PortalTravel(join(mkdtempSync(join(tmpdir(),'mc-portal-travel-')),'portal-travel.json'))
 r.portalTravel.save({nether:'on'});await c.submit('and now')
 assert.deepEqual(observed.portalTravel,{nether:'on'})
})
