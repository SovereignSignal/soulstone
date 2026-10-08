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

// Step 5: the controller's side of use_portal.
import {Vec3} from 'vec3'
import minecraftData from 'minecraft-data'
const registry=minecraftData('1.21.4')
class PortalRunner extends EventEmitter{
 constructor(){super();this.profile='lab';this.owner='Sov';this.ready=true;this.commands=[]
  this.bot={registry,game:{dimension:'minecraft:overworld',gameMode:'survival',difficulty:'normal'},time:{timeOfDay:6000},health:20,food:20,entities:{},players:{},inventory:{items:()=>[]},
   entity:{position:new Vec3(0.5,64,0.5),onGround:true,metadata:{0:0}},findBlocks:()=>[],findBlock:()=>null,
   blockAt:p=>{const name=p.y===63?'stone':this.inPortal&&p.x===0&&p.z===0&&p.y>=64&&p.y<=65?'nether_portal':'air';return {name,position:p.clone(),boundingBox:name==='stone'?'block':'empty'}}}}
 position(){return {x:0,y:64,z:0}}
 command(c){this.commands.push(c);this.task={id:String(this.commands.length),kind:c.action,status:'running',goal:c.goal}}
}
const companion=(plan)=>{const r=new PortalRunner();return [r,new Teammate(r,{model:'fake',plan},join(mkdtempSync(join(tmpdir(),'mc-companion-')),'state.json'))]}
test('a planned use_portal is refused while the switch is off, and dispatched when it is on',async()=>{
 const [r,c]=companion(async()=>({reply:'Going through.',steps:[{action:'use_portal',name:'',count:0,item:''}]}))
 await c.submit('go through the portal')
 assert.ok(!r.commands.some(x=>x.action==='use_portal'));assert.ok(c.messages.some(m=>/off for this world/.test(m.text)),JSON.stringify(c.messages.map(m=>m.text)))
 r.portalTravel=new PortalTravel(join(mkdtempSync(join(tmpdir(),'mc-portal-travel-')),'portal-travel.json'));r.portalTravel.save({nether:'on'})
 void c.submit('go through the portal');await new Promise(res=>setTimeout(res,50))
 assert.ok(r.commands.some(x=>x.action==='use_portal'),JSON.stringify(r.commands))
})
test('a finished crossing records both ends of the portal',()=>{
 const [r,c]=companion(async()=>({reply:'',steps:[]}))
 r.emit('event',{type:'task_finished',task:{id:'p',kind:'use_portal',status:'completed',goal:{},result:{receipt:'crossed',from:{dimension:'overworld',portal:{x:-560,y:64,z:-420}},to:{dimension:'the_nether',portal:{x:-70,y:70,z:-52}}}}})
 assert.deepEqual(c.projects.portal_link.pairs,[{overworld:{x:-560,y:64,z:-420},the_nether:{x:-70,y:70,z:-52}}])
 r.emit('event',{type:'task_finished',task:{id:'q',kind:'use_portal',status:'completed',goal:{},result:{receipt:'crossed',from:{dimension:'the_nether',portal:{x:-70,y:70,z:-53}},to:{dimension:'overworld',portal:{x:-560,y:64,z:-421}}}}})
 assert.equal(c.projects.portal_link.pairs.length,1,'the way back through the same portal updates that pair')
})
test('standing in the portal during use_portal is not an emergency; anywhere else it still is',async()=>{
 const [r,c]=companion(async()=>({reply:'',steps:[]}))
 r.inPortal=true;r.task={id:'x',kind:'use_portal',status:'running',goal:{}}
 r.emit('event',{type:'survival_tick'});await new Promise(res=>setTimeout(res,20))
 assert.equal(c.safety,null,'no emergency while crossing on purpose')
 r.task={id:'y',kind:'goto',status:'running',goal:{}}
 r.emit('event',{type:'survival_tick'});await new Promise(res=>setTimeout(res,20))
 assert.equal(c.safety?.reason,'Standing in a portal')
})
