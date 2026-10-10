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

// Run 68, 8 October: the first live use_portal plan was thrown out by the
// intent guard ("I could not validate the proposed actions"), whose list of
// open-ended actions had no use_portal.
import {guardIntent} from '../src/companion/intent.js'
test('the intent guard lets a use_portal plan through',()=>{
 const plan={reply:'Through and back.',steps:[{action:'use_portal',name:'',count:0,item:''},{action:'use_portal',name:'',count:0,item:''}]}
 assert.deepEqual(guardIntent(plan,'go through the portal, wait 30 seconds on the other side, then come back through it'),plan)
})

// Run 70, 8 October: the first crossing landed beside a Nether fortress, and a
// blaze set the bot alight from out of sight. Retreat refused (the base is in
// the Overworld), burrow refused (nether bricks), hut refused (the portal in
// the way), and it died a block from the way home. In the Nether a lit portal
// close by is the first shelter.
import {HEALTH_EMERGENCY} from '../src/survival.js'
test('in the Nether danger sends the bot back through a nearby portal before any other shelter',async()=>{
 const r=new PortalRunner();r.bot.game.dimension='minecraft:the_nether';r.bot.health=8
 r.bot.findBlock=({matching})=>matching===registry.blocksByName.nether_portal.id?{name:'nether_portal',position:new Vec3(1,64,0)}:null
 r.command=function(c){this.commands.push(c);this.task={id:String(this.commands.length),kind:c.action,status:'running',goal:c.goal}
  if(c.action==='use_portal')this.bot.game.dimension='minecraft:overworld'
  if(c.action!=='stop')setTimeout(()=>this.emit('event',{type:'task_finished',task:{...this.task,status:'completed',result:{receipt:c.action==='use_portal'?'crossed':'done'}}}),1)}
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-companion-')),'state.json'))
 c.projects.base={build:{origin:{x:100,y:64,z:100},design:[{x:0,y:0,z:0,block:'cobblestone'}]}}
 await c.seekSafety(HEALTH_EMERGENCY)
 const acts=r.commands.map(x=>x.action).filter(a=>a!=='stop')
 assert.equal(acts[0],'use_portal',acts.join(' '));assert.ok(!acts.includes('retreat'),'no walk toward an Overworld base from the Nether')
 assert.equal(c.safety,null,'safe on the Overworld side')
})

// Run 72, 8 October: twice the bot reached the portal, began stepping in, and
// a creeper's interruption cancelled the crossing a second later. Stepping
// into the portal is the fastest way out: nothing follows to the far side.
import {THREAT_INTERRUPTION} from '../src/survival.js'
test('a hostile nearby does not stop a crossing already stepping in; on the walk there it still does',async()=>{
 const [r,c]=companion(async()=>({reply:'',steps:[]}))
 r.bot.entities={9:{name:'creeper',position:new Vec3(5.5,64,0.5)}}
 r.task={id:'x',kind:'use_portal',status:'running',goal:{}};r.work={stage:'entering'}
 r.emit('event',{type:'survival_tick'});await new Promise(res=>setTimeout(res,20))
 assert.equal(c.safety,null,'stepping in: carry on')
 r.work={stage:'walking'}
 r.emit('event',{type:'survival_tick'});await new Promise(res=>setTimeout(res,20))
 assert.equal(c.safety?.reason,THREAT_INTERRUPTION)
})

// Run 84, 9 October: arriving among hoglins, every threat sent the bot straight
// home, so the room it was asked to build at the arrival portal never began.
// Beside the portal with blocks to close a portal room and the nearest hostile
// not yet close, it walls in there; with one close, the portal is still first.
test('beside the arrival portal with a hostile still eight blocks off, the bot walls in instead of leaving',async()=>{
 const run=async distance=>{
  const r=new PortalRunner();r.bot.game.dimension='minecraft:the_nether'
  r.bot.inventory={items:()=>[{name:'cobblestone',count:64,type:registry.itemsByName.cobblestone.id}]}
  // Frame in the z=-1 plane: obsidian x -1..2, y 63..67; portal x 0..1, y 64..66. Stone floor at y 63.
  r.bot.blockAt=p=>{const frame=p.z===-1&&p.x>=-1&&p.x<=2&&p.y>=63&&p.y<=67
   const name=frame?((p.x===-1||p.x===2||p.y===63||p.y===67)?'obsidian':'nether_portal'):p.y===63?'stone':'air'
   return {name,position:p.clone(),boundingBox:(name==='stone'||name==='obsidian')?'block':'empty'}}
  r.bot.findBlock=({matching})=>matching===registry.blocksByName.nether_portal.id?{name:'nether_portal',position:new Vec3(0,64,-1)}:null
  r.bot.entities={7:{name:'hoglin',position:new Vec3(0.5,64,0.5+distance)}}
  r.command=function(c){this.commands.push(c);this.task={id:String(this.commands.length),kind:c.action,status:'running',goal:c.goal}}
  const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-companion-')),'state.json'))
  void c.seekSafety(THREAT_INTERRUPTION);await new Promise(res=>setTimeout(res,60))
  const acts=r.commands.map(x=>x.action).filter(a=>a!=='stop');c.cancel?.(true);return acts
 }
 const far=await run(8);assert.notEqual(far[0],'use_portal','eight blocks off: wall in here, '+far.join(' '))
 // Lab run 106 staging, 10 October: at 9 health under a skeleton's arrows the walk to an
 // Overworld base (always refused from the Nether) and a burrow check on nether bricks
 // came first, and the bot was shot dead two seconds into building the room.
 assert.equal(far[0],'hut','the room is built first, nothing tried before it: '+far.join(' '))
 const near=await run(3);assert.equal(near[0],'use_portal','three blocks off: the portal is still the way out, '+near.join(' '))
})

// Lab, 10 October: shooting a blaze, the bot was set alight by its fireball and
// the fire emergency cancelled the shot twice; the blaze was left on 4 health.
// Flames from a fireball burn out in seconds and cost a heart; stopping the duel
// lets the blaze keep firing. While shooting, fire alone does not interrupt it;
// lava, or health at or under half, still does.
import {FIRE_EMERGENCY} from '../src/survival.js'
test('being on fire does not stop a bow duel under way; lava or low health still does',async()=>{
 const tick=async({health=18,shooting=true}={})=>{
  const [r,c]=companion(async()=>({reply:'',steps:[]}))
  r.bot.health=health;r.bot.entity.metadata[0]=1
  if(shooting){r.task={id:'s',kind:'shoot',status:'running',goal:{type:'blaze'}};r.work={stage:'drawing'}}
  r.emit('event',{type:'survival_tick'});await new Promise(res=>setTimeout(res,20))
  const reason=c.safety?.reason;c.cancel?.(true);return reason
 }
 assert.equal(await tick(),undefined,'alight but shooting at 18 health: keep shooting')
 assert.equal(await tick({health:8}),FIRE_EMERGENCY,'at 8 health the fire comes first')
 assert.equal(await tick({shooting:false}),FIRE_EMERGENCY,'not shooting: the fire comes first')
})

// Lab run 101, 10 October: home from the fortress for a moment, the planner put
// "acquire flint_and_steel" before use_portal with the portal lit, spent its
// rounds on a gravel search that failed, and only then went back for the rods.
// The brief's "before crossing carry flint_and_steel" read as a precondition.
import {readFileSync as readBrief} from 'node:fs'
test('the brief makes flint and steel a thing to carry, never a precondition for crossing a lit portal',()=>{
 const brief=readBrief(new URL('../src/companion/teammate-prompt.txt',import.meta.url),'utf8')
 const line=brief.split('\n').find(l=>l.startsWith('Action use_portal'))
 assert.ok(line)
 assert.doesNotMatch(line,/Before crossing from the Overworld carry flint_and_steel/)
 assert.match(line,/never a precondition/)
 assert.match(line,/portal_link/)
})

test('two steps from the portal with hoglins ten blocks off, the bot steps back and walls in, not home',async()=>{
 const run=async distance=>{
  const r=new PortalRunner();r.bot.game.dimension='minecraft:the_nether'
  r.bot.inventory={items:()=>[{name:'cobblestone',count:64,type:registry.itemsByName.cobblestone.id}]}
  r.bot.blockAt=p=>{const frame=p.z===-1&&p.x>=-1&&p.x<=2&&p.y>=63&&p.y<=67
   const name=frame?((p.x===-1||p.x===2||p.y===63||p.y===67)?'obsidian':'nether_portal'):p.y===63?'stone':'air'
   return {name,position:p.clone(),boundingBox:(name==='stone'||name==='obsidian')?'block':'empty'}}
  r.bot.findBlock=({matching})=>matching===registry.blocksByName.nether_portal.id?{name:'nether_portal',position:new Vec3(0,64,-1)}:null
  r.bot.entity.position=new Vec3(0.5,64,2.5)
  r.bot.entities={7:{name:'hoglin',position:new Vec3(0.5,64,2.5+distance)}}
  r.command=function(c){this.commands.push(c);this.task={id:String(this.commands.length),kind:c.action,status:'running',goal:c.goal}}
  const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-companion-')),'state.json'))
  void c.seekSafety(THREAT_INTERRUPTION);await new Promise(res=>setTimeout(res,60))
  const cmds=r.commands.filter(x=>x.action!=='stop');c.cancel?.(true);return cmds
 }
 const far=await run(10);assert.equal(far[0]?.action,'hut',far.map(x=>x.action).join(' '));assert.equal(far[0].goal.portalRoom,true)
 const near=await run(4);assert.equal(near[0]?.action,'use_portal','four blocks off: no time to build, the portal is the way out')
})

// Lab run 105, 10 October: beside the portal with a skeleton shooting from three
// blocks behind obsidian, the bow had no line and the bot went home, arriving at
// night at half health with another skeleton at arm's length. Against a shooter
// the portal room is cover; only a mob that closes to melee makes home the way out.
test('with only a shooter near, the bot walls in at the portal instead of going home',async()=>{
 const run=async(mob,distance)=>{
  const r=new PortalRunner();r.bot.game.dimension='minecraft:the_nether'
  r.bot.inventory={items:()=>[{name:'cobblestone',count:64,type:registry.itemsByName.cobblestone.id}]}
  r.bot.blockAt=p=>{const frame=p.z===-1&&p.x>=-1&&p.x<=2&&p.y>=63&&p.y<=67
   const name=frame?((p.x===-1||p.x===2||p.y===63||p.y===67)?'obsidian':'nether_portal'):p.y===63?'stone':'air'
   return {name,position:p.clone(),boundingBox:(name==='stone'||name==='obsidian')?'block':'empty'}}
  r.bot.findBlock=({matching})=>matching===registry.blocksByName.nether_portal.id?{name:'nether_portal',position:new Vec3(0,64,-1)}:null
  r.bot.entities={7:{name:mob,position:new Vec3(0.5,64,0.5+distance)}}
  r.command=function(c){this.commands.push(c);this.task={id:String(this.commands.length),kind:c.action,status:'running',goal:c.goal}}
  const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-companion-')),'state.json'))
  void c.seekSafety(THREAT_INTERRUPTION);await new Promise(res=>setTimeout(res,60))
  const acts=r.commands.map(x=>x.action).filter(a=>a!=='stop');c.cancel?.(true);return acts
 }
 const skeleton=await run('skeleton',3);assert.notEqual(skeleton[0],'use_portal','a skeleton three blocks off: cover here, '+skeleton.join(' '))
 const blaze=await run('blaze',4);assert.notEqual(blaze[0],'use_portal','a blaze four blocks off: cover here, '+blaze.join(' '))
 const wither=await run('wither_skeleton',3);assert.equal(wither[0],'use_portal','a wither skeleton walks up and swings: home')
})

test('the Nether shelter choice is logged with what decided it',async()=>{
 const r=new PortalRunner();r.bot.game.dimension='minecraft:the_nether'
 r.bot.inventory={items:()=>[{name:'cobblestone',count:64,type:registry.itemsByName.cobblestone.id}]}
 r.bot.blockAt=p=>{const frame=p.z===-1&&p.x>=-1&&p.x<=2&&p.y>=63&&p.y<=67
  const name=frame?((p.x===-1||p.x===2||p.y===63||p.y===67)?'obsidian':'nether_portal'):p.y===63?'stone':'air'
  return {name,position:p.clone(),boundingBox:(name==='stone'||name==='obsidian')?'block':'empty'}}
 r.bot.findBlock=({matching})=>matching===registry.blocksByName.nether_portal.id?{name:'nether_portal',position:new Vec3(0,64,-1)}:null
 r.bot.entities={7:{name:'hoglin',position:new Vec3(0.5,64,3.5)}}
 const logged=[];r.log=(type,data)=>logged.push({type,...data})
 r.command=function(c){this.commands.push(c);this.task={id:String(this.commands.length),kind:c.action,status:'running',goal:c.goal}}
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-companion-')),'state.json'))
 void c.seekSafety(THREAT_INTERRUPTION);await new Promise(res=>setTimeout(res,60));c.cancel?.(true)
 const entry=logged.find(e=>e.type==='nether_shelter')
 assert.ok(entry,'logged');assert.equal(entry.wallInFirst,false);assert.equal(entry.portalRoom,true);assert.equal(entry.nearestMelee,3)
})

// Lab run 107, 10 October: carrying two blaze rods, fifteen blocks from the portal
// with a blaze close, use_portal stopped four blocks short; the fallback hut was a
// plain one on the bridge and came up two blocks short; then "moving away" descended
// and sprinted twenty-four blocks into the fortress, where a wither skeleton killed it.
function strandedNearPortal(fail){
 const r=new PortalRunner();r.bot.game.dimension='minecraft:the_nether'
 r.bot.inventory={items:()=>[{name:'cobblestone',count:64,type:registry.itemsByName.cobblestone.id}]}
 r.bot.blockAt=p=>{const frame=p.z===-1&&p.x>=-1&&p.x<=2&&p.y>=63&&p.y<=67
  const name=frame?((p.x===-1||p.x===2||p.y===63||p.y===67)?'obsidian':'nether_portal'):p.y===63?'nether_bricks':'air'
  return {name,position:p.clone(),boundingBox:(name==='nether_bricks'||name==='obsidian')?'block':'empty'}}
 r.bot.findBlock=({matching})=>matching===registry.blocksByName.nether_portal.id?{name:'nether_portal',position:new Vec3(0,64,-1)}:null
 r.bot.entity.position=new Vec3(3.5,64,1.5)
 r.bot.entities={7:{name:'hoglin',position:new Vec3(3.5,64,8.5)}}
 r.command=function(c){this.commands.push(c);const task=this.task={id:String(this.commands.length),kind:c.action,status:'running',goal:c.goal}
  if(c.action==='stop')return
  setTimeout(()=>{if(this.task!==task)return
   if(fail.includes(c.action)){task.status='failed';task.reason=c.action+' refused'}else{task.status='completed';task.result=c.action==='hut'?{item:'safety',count:1,receipt:'walled_in',shelterName:'hut',capped:true}:{receipt:'done'}}
   this.emit('event',{type:'task_finished',task})},2)}
 return r
}
test('in the Nether a failed crossing falls back to the portal room, then the portal again, never a run into the fortress',async()=>{
 const run=async fail=>{
  const r=strandedNearPortal(fail)
  const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-companion-')),'state.json'))
  void c.seekSafety(THREAT_INTERRUPTION);await new Promise(res=>setTimeout(res,400));c.cancel?.(true)
  return r.commands.filter(x=>x.action!=='stop')
 }
 const roomed=await run(['use_portal','burrow'])
 const hut=roomed.find(x=>x.action==='hut');assert.ok(hut,roomed.map(x=>x.action).join(' '));assert.equal(hut.goal.portalRoom,true,'the fallback hut is the portal room a step away')
 const stuck=await run(['use_portal','burrow','hut'])
 const acts=stuck.map(x=>x.action)
 assert.ok(!acts.some(a=>['flee','descend','climb'].includes(a)),'no run into the fortress: '+acts.join(' '))
 assert.ok(acts.filter(a=>a==='use_portal').length>=2,'the portal is tried again: '+acts.join(' '))
})
