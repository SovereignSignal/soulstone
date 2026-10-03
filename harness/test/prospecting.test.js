import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {Vec3} from 'vec3'
import {ExcavationMovements,executeExpedition,excavationPath,remainingDurability,expeditionObservation,excavationStepSafe,invalidKnownWaypoint,starterBounds,insideBounds} from '../src/prospecting.js'
import {validateTaskGoal} from '../src/task-store.js'
import {validatePlan} from '../src/companion/planner.js'
const require=createRequire(import.meta.url),registry=require('minecraft-data')('1.21.4'),Block=require('prismarine-block')(registry)
const project={build:{origin:{x:30,y:64,z:30},near:{x:28,y:64,z:28},wood:'oak_log',design:[{x:0,y:0,z:0,block:'wood_planks'}]},stations:{}}
function fixture(){
 const cells=new Map(),stoneTool={type:registry.itemsByName.stone_pickaxe.id,name:'stone_pickaxe',maxDurability:131,durabilityUsed:0}
 const bot={registry,players:{},entity:{position:new Vec3(-2.5,64,.5),effects:{}},inventory:{items:()=>[stoneTool]},game:{minY:-64},pathfinder:{bestHarvestTool:()=>stoneTool},
  blockAt:p=>{const name=cells.get(p.toString())||'stone';if(name==='unknown')return null;const b=Block.fromStateId(registry.blocksByName[name].defaultState);b.position=p;return b}}
 return {bot,cells,stoneTool,movement:new ExcavationMovements(bot,project)}
}
test('excavation rejects fluids, unknown neighbours, falling ceilings, builds and inadequate tools',()=>{
 const f=fixture(),p=new Vec3(0,64,0)
 assert.equal(f.movement.safeToBreak(f.bot.blockAt(p)),true)
 for(const name of ['water','lava','unknown']){f.cells.set(p.offset(0,-1,0).toString(),name);assert.equal(f.movement.safeToBreak(f.bot.blockAt(p)),false)}
 f.cells.clear();f.cells.set(p.offset(0,1,0).toString(),'gravel');assert.equal(f.movement.safeToBreak(f.bot.blockAt(p)),true,'gravel above a cell beside the bot drops into the cut and is cut again')
 const overhead=new Vec3(-3,65,0);f.cells.set(overhead.offset(0,1,0).toString(),'gravel');assert.equal(f.movement.safeToBreak(f.bot.blockAt(overhead)),false,'never cut under gravel in the bot\'s own column')
 f.cells.clear();f.cells.set(p.toString(),'sandstone');assert.equal(f.movement.safeToBreak(f.bot.blockAt(p)),true,'sandstone is natural terrain')
 f.cells.clear();assert.equal(f.movement.safeToBreak(f.bot.blockAt(new Vec3(30,63,30))),false)
 f.cells.set(p.toString(),'oak_planks');assert.equal(f.movement.safeToBreak(f.bot.blockAt(p)),false)
 f.cells.set(p.toString(),'diamond_ore');assert.equal(f.movement.safeToBreak(f.bot.blockAt(p)),false)
 f.cells.set(p.toString(),'iron_ore');assert.equal(f.movement.safeToBreak(f.bot.blockAt(p)),true)
 f.stoneTool.durabilityUsed=124;assert.equal(remainingDurability(f.stoneTool),7);assert.equal(f.movement.safeToBreak(f.bot.blockAt(p)),false)
})
test('excavation preserves return floor, player support and forbids shafts/diagonal shortcuts',()=>{
 const f=fixture(),p=new Vec3(0,64,0)
 f.movement.trail.push({x:0,y:65,z:0});assert.equal(f.movement.safeToBreak(f.bot.blockAt(p)),false)
 f.movement.trail=[];f.bot.players.owner={entity:{position:new Vec3(.5,65,.5)}};assert.equal(f.movement.safeToBreak(f.bot.blockAt(p)),false)
 const nodes=[];f.movement.getMoveDown({},nodes);f.movement.getMoveDiagonal({},new Vec3(1,0,1),nodes);assert.deepEqual(nodes,[])
 assert.equal(f.movement.maxDropDown,1);assert.deepEqual(f.movement.scafoldingBlocks,[])
})
test('prospect contracts bound resources and saved routes across planner and executor',()=>{
 const step={action:'prospect',name:'base',item:'raw_iron',count:3,design:[]}
 assert.equal(validatePlan({reply:'Searching.',steps:[step]}).steps[0].action,'prospect')
 assert.equal(validateTaskGoal('prospect',{project,item:'raw_iron',count:3}).count,3)
 for(const item of ['tnt','command_block','iron_ingot'])assert.throws(()=>validatePlan({reply:'Searching.',steps:[{...step,item}]}))
 assert.throws(()=>validateTaskGoal('prospect',{project,item:'diamond',count:99}))
 assert.throws(()=>validateTaskGoal('prospect',{project:{...project,expedition:{trail:Array(400).fill({x:0,y:64,z:0}),frontier:[]}},item:'diamond',count:1}))
 assert.equal(validatePlan({reply:'Opening starter access.',steps:[{...step,item:'cobblestone',count:14}]}).steps[0].item,'cobblestone')
 assert.equal(validateTaskGoal('prospect',{project,item:'cobblestone',count:14}).count,14)
})

test('torch-free starter mining stays shallow and never authorizes an iron or diamond expedition',async()=>{
 const {bot,movement}=fixture(),origin={x:0,y:64,z:0}
 const bounds=starterBounds(bot,'cobblestone',origin)
 assert.ok(insideBounds({x:24,y:56,z:0},bounds))
 for(const p of [{x:25,y:64,z:0},{x:0,y:55,z:0},{x:0,y:68,z:0}])assert.equal(insideBounds(p,bounds),false)
 assert.equal(starterBounds(bot,'diamond',origin),null);assert.equal(starterBounds(bot,'raw_iron',origin),null)
 movement.limits=bounds
 assert.equal(movement.safeToBreak(bot.blockAt(new Vec3(0,55,0))),false)
 bot.pathfinder.getPathFromTo=function*(){yield {result:{status:'success',path:[{x:0,y:55,z:0,toPlace:[],toBreak:[]}]}}}
 await assert.rejects(excavationPath(bot,movement,new Vec3(0,64,0),{},()=>{}),/shallow access bounds/)
 bot.pathfinder.getPathFromTo=function*(){yield {result:{status:'success',path:[{x:0,y:56,z:0,toPlace:[],toBreak:[new Vec3(0,55,0)]}]}}}
 await assert.rejects(excavationPath(bot,movement,new Vec3(0,64,0),{},()=>{}),/shallow access bounds/)
})
test('return interruption retains unvisited route and a fresh instruction resumes it without digging',async()=>{
 const p=structuredClone(project);p.expedition={trail:[{x:0,y:64,z:0},{x:1,y:63,z:0},{x:2,y:62,z:0}],frontier:[],surveys:[],rejected:[]}
 let stopped=false,calls=0,saves=0
 const bot={entity:{position:new Vec3(2.5,62,.5)},inventory:{items:()=>[]},world:{}}
 const api={check(){if(stopped)throw new Error('Cancelled')},progress(){},stage(){},persist(){saves++},async walk(g){calls++;if(calls===2){stopped=true;throw new Error('Cancelled')}bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}}
 const task={kind:'return_base',goal:{project:p}}
 await assert.rejects(executeExpedition(bot,task,api),/Cancelled/);assert.equal(p.expedition.trail.length,2);assert.ok(saves)
 stopped=false;calls=0;api.walk=async g=>{calls++;bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}
 const result=await executeExpedition(bot,task,api);assert.equal(result.returned,true);assert.equal(p.expedition.trail.length,0)
})
test('excavation planner awaits partial search and rejects failed empty paths and bridging',async()=>{
 const bot={pathfinder:{*getPathFromTo(){yield {result:{status:'partial',path:[]}};yield {result:{status:'success',path:[{toPlace:[]}]}}}}}
 assert.equal((await excavationPath(bot,{},new Vec3(0,0,0),{},()=>{})).length,1)
 bot.pathfinder.getPathFromTo=function*(){yield {result:{status:'noPath',path:[]}}}
 await assert.rejects(excavationPath(bot,{},new Vec3(0,0,0),{},()=>{}),/noPath/)
 bot.pathfinder.getPathFromTo=function*(){yield {result:{status:'success',path:[{toPlace:[{}]}]}}}
 await assert.rejects(excavationPath(bot,{},new Vec3(0,0,0),{},()=>{}),/bridging/)
})

test('solid terrain yields a one-block descending stair with reverse headroom',()=>{
 const f=fixture(),node=new Vec3(0,64,0);node.remainingBlocks=0
 const neighbours=[];f.movement.getMoveDropDown(node,{x:1,z:0},neighbours)
 assert.equal(neighbours.length,1);assert.equal(neighbours[0].y,63)
 assert.deepEqual(neighbours[0].toBreak.map(p=>p.y),[65,64,63])
 f.cells.set(new Vec3(1,62,0).toString(),'air');const none=[];f.movement.getMoveDropDown(node,{x:1,z:0},none);assert.equal(none.length,0)
})

import {DoorAwareMovements} from '../src/navigation.js'
test('ordinary no-dig movement traverses cleared one-block stairs and rejects deeper falls',()=>{
 const f=fixture(),m=new DoorAwareMovements(f.bot);m.canDig=false;m.maxDropDown=1;m.scafoldingBlocks=[]
 for(const y of [65,64,63])f.cells.set(new Vec3(1,y,0).toString(),'air')
 const n=new Vec3(0,64,0);n.remainingBlocks=0
 const paths=[];m.getMoveDropDown(n,{x:1,z:0},paths);assert.equal(paths.length,1);assert.equal(paths[0].y,63);assert.equal(paths[0].toBreak.length,0)
 f.cells.set(new Vec3(1,62,0).toString(),'air');const none=[];m.getMoveDropDown(n,{x:1,z:0},none);assert.equal(none.length,0)
})

test('model observations summarize routes without mutating durable expedition state',()=>{
 const p={projects:{base:{...project,expedition:{trail:[{x:1,y:63,z:0}],frontier:[{x:2,y:62,z:0}],surveys:[],rejected:[]}}}}
 const result=expeditionObservation(p);assert.equal(result.projects.base.expedition.trailSteps,1);assert.equal(result.projects.base.expedition.trail,undefined);assert.equal(p.projects.base.expedition.trail.length,1)
})

test('a planned switchback is rechecked against floors added to the return route since planning',()=>{
 const f=fixture(),p=new Vec3(0,64,0),node={toBreak:[p]}
 assert.equal(excavationStepSafe(f.bot,f.movement,node),true)
 f.movement.trail.push({x:0,y:65,z:0});assert.equal(excavationStepSafe(f.bot,f.movement,node),false)
 f.cells.set(p.toString(),'air');assert.equal(excavationStepSafe(f.bot,f.movement,node),true)
})

test('route replay skips known removed support, preserves unknown waypoints and rejects blocked headroom',()=>{
 const f=fixture(),p=new Vec3(0,64,0)
 f.cells.set(p.toString(),'air');f.cells.set(p.offset(0,1,0).toString(),'air');assert.equal(invalidKnownWaypoint(f.bot,p),false)
 f.cells.set(p.offset(0,-1,0).toString(),'air');assert.equal(invalidKnownWaypoint(f.bot,p),true)
 f.cells.set(p.offset(0,-1,0).toString(),'unknown');assert.equal(invalidKnownWaypoint(f.bot,p),false)
 f.cells.set(p.offset(0,-1,0).toString(),'stone');f.cells.set(p.offset(0,1,0).toString(),'stone');assert.equal(invalidKnownWaypoint(f.bot,p),true)
})

test('a previously planned break becoming fluid is rejected before execution',()=>{
 const f=fixture(),p=new Vec3(0,64,0),node={toBreak:[p]}
 for(const fluid of ['water','lava']){f.cells.set(p.toString(),fluid);assert.equal(excavationStepSafe(f.bot,f.movement,node),false)}
 f.cells.set(p.toString(),'air');assert.equal(excavationStepSafe(f.bot,f.movement,node),true)
})

test('checked three-block descents accept full safe landings while an explicit one-block policy stays limited',()=>{
 const f=fixture(),ordinary=new DoorAwareMovements(f.bot);ordinary.canDig=false;ordinary.maxDropDown=1;ordinary.scafoldingBlocks=[]
 const construction=Object.assign(Object.create(ordinary),{maxDropDown:3}),node=new Vec3(0,64,0);node.remainingBlocks=0
 for(let y=61;y<=65;y++)f.cells.set(new Vec3(1,y,0).toString(),'air')
 const paths=[];construction.getMoveDropDown(node,{x:1,z:0},paths);assert.equal(paths.length,1);assert.equal(paths[0].y,61);assert.equal(paths[0].toBreak.length,0)
 const normal=[];ordinary.getMoveDropDown(node,{x:1,z:0},normal);assert.equal(normal.length,0);assert.equal(ordinary.maxDropDown,1)
 for(const floor of ['air','water','lava','unknown','red_bed','cactus']){
  f.cells.set(new Vec3(1,60,0).toString(),floor);const rejected=[];construction.getMoveDropDown(node,{x:1,z:0},rejected);assert.equal(rejected.length,0,floor)
 }
})

test('the trip clock starts at new excavation, not during the walk back out to the saved frontier',async()=>{
 const {mock}=await import('node:test')
 mock.timers.enable({apis:['Date'],now:5_000_000})
 try{
  const {bot,cells,stoneTool}=fixture()
  const p=structuredClone(project);p.expedition={trail:[],frontier:[{x:0,y:63,z:0},{x:1,y:62,z:0},{x:2,y:61,z:0}],surveys:[],rejected:[]}
  for(const w of [...p.expedition.frontier,{x:3,y:60,z:0}]){cells.set(new Vec3(w.x,w.y,w.z).toString(),'air');cells.set(new Vec3(w.x,w.y+1,w.z).toString(),'air')}
  let found=false;bot.inventory.items=()=>[stoneTool,{name:'torch',count:4},...(found?[{name:'diamond',count:1}]:[])]
  bot.findBlocks=()=>[new Vec3(6,58,0)]
  bot.pathfinder.getPathFromTo=function*(){yield {result:{status:'success',path:[{x:3,y:60,z:0,toPlace:[],toBreak:[]}]}}}
  bot.entity.position=new Vec3(28.5,64,28.5)
  const walks=[]
  const api={check(){},progress(){},stage(){},persist(){},async settle(){},async walk(g){
   walks.push([g.x,g.y,g.z]);bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)
   if(walks.length<=3)mock.timers.tick(200_000)
   if(g.x===3&&g.y===60)found=true
  }}
  const result=await executeExpedition(bot,{kind:'prospect',goal:{project:p,item:'diamond',count:1}},api)
  assert.deepEqual(walks.slice(0,3),[[0,63,0],[1,62,0],[2,61,0]])
  assert.equal(result.acquired,true);assert.equal(result.partial,false);assert.equal(result.steps,1)
  assert.equal(result.returned,true);assert.equal(p.expedition.trail.length,0)
 }finally{mock.timers.reset()}
})

test('a sand cell that refills after the cut is cut again and counted, and a sandy start explains the planner refusal',async()=>{
 const {bot,cells,stoneTool}=fixture()
 const p=structuredClone(project);p.expedition={trail:[],frontier:[],surveys:[],rejected:[]}
 const cut=new Vec3(-1,63,0);cells.set(cut.offset(0,1,0).toString(),'air');cells.set(new Vec3(-1,64,0).toString(),'air')
 let found=false,digs=0;bot.inventory.items=()=>[stoneTool,{name:'torch',count:4},...(found?[{name:'diamond',count:1}]:[])]
 bot.findBlocks=()=>[new Vec3(6,58,0)]
 bot.equip=async()=>{};bot.dig=async block=>{digs++;cells.set(block.position.toString(),'air');if(digs===1)setTimeout(()=>cells.set(cut.toString(),'sand'),120)}
 bot.pathfinder.getPathFromTo=function*(){yield {result:{status:'success',path:[{x:-1,y:63,z:0,toPlace:[],toBreak:[cut]}]}}}
 const messages=[]
 const api={check(){},progress:m=>messages.push(m),stage(){},persist(){},async settle(){},async walk(g){bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5);if(g.x===-1)found=true}}
 const result=await executeExpedition(bot,{kind:'prospect',goal:{project:p,item:'diamond',count:1}},api)
 assert.equal(digs,2);assert.equal(result.broken,2);assert.equal(result.acquired,true)
 assert.ok(messages.some(m=>/Fallen sand refilled -1,63,0; cutting it again/.test(m)),messages.join(' | '))
 const sandy={blockAt:()=>({name:'water'}),pathfinder:{*getPathFromTo(){yield {result:{status:'noPath',path:[]}}}}}
 await assert.rejects(excavationPath(sandy,{},new Vec3(0,64,0),{},()=>{}),/standing on water, which the planner never cuts/)
})

test('an expedition begun from the back exit drops the saved surface trail and starts underground',async()=>{
 // Lab run 25, 3 October: prospect from nine under the base began with
 // "Retracing the cleared route to base" along a trail saved from the door,
 // could not walk it from down there, and failed.
 const p=structuredClone(project);p.backExit={cell:{x:31,y:64,z:31},bottom:55}
 p.expedition={trail:[{x:25,y:64,z:25},{x:20,y:64,z:20}],frontier:[{x:20,y:64,z:20}],surveys:[],rejected:[],phase:'at_base'}
 const bot={entity:{position:new Vec3(31.5,55,31.5)},inventory:{items:()=>[]},world:{}}
 const walked=[],said=[];let saves=0
 const api={check(){},progress(m){said.push(m)},stage(){},persist(){saves++},async walk(g){walked.push([g.x,g.y,g.z]);throw new Error('stop here')}}
 await assert.rejects(executeExpedition(bot,{kind:'prospect',goal:{project:p,item:'raw_iron',count:8}},api))
 // With nothing carried the trip then heads home for supplies (to `near`), which is not the old trail.
 assert.ok(!walked.some(w=>w[0]===25||w[0]===20),'no walk along the old trail: '+JSON.stringify(walked));assert.deepEqual(p.expedition.trail,[]);assert.deepEqual(p.expedition.frontier,[]);assert.ok(saves)
 // Up on the surface the saved trail is still walked home first.
 const q=structuredClone(project);q.expedition={trail:[{x:25,y:64,z:25}],frontier:[],surveys:[],rejected:[]}
 const up={entity:{position:new Vec3(28.5,64,28.5)},inventory:{items:()=>[]},world:{}};const went=[]
 await assert.rejects(executeExpedition(up,{kind:'prospect',goal:{project:q,item:'raw_iron',count:8}},{...api,async walk(g){went.push([g.x,g.y,g.z]);throw new Error('stop here')}}))
 assert.deepEqual(went,[[25,64,25]])
})
