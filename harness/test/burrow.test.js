import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {burrowSite,burrowIn,burrowClearance,unburrow} from '../src/burrow.js'
import {executeSkill} from '../src/skills.js'
import {validateTaskGoal} from '../src/task-store.js'
import {Teammate} from '../src/companion/controller.js'
const registry=minecraftData('1.21.4')
function world(ground='dirt'){
 const cells=new Map(),inventory=[],placed=[],dug=[],equipped=[]
 const bot={registry,game:{gameMode:'survival',difficulty:'normal'},time:{timeOfDay:15000},health:14,food:18,entities:{},players:{},
  entity:{position:new Vec3(10.5,64,10.5),onGround:true},inventory:{items:()=>inventory},
  blockAt(p){const name=cells.get(p.toString())??(p.y>=64?'air':p.y===63?'grass_block':ground);return {name,position:p.clone(),boundingBox:registry.blocksByName[name]?.boundingBox}},
  pathfinder:{setGoal(){},setMovements(){},async goto(){}},clearControlStates(){},
  async equip(item){equipped.push(item.name)},
  async dig(block){dug.push(block.position.toString());cells.set(block.position.toString(),'air');const drop=block.name==='grass_block'?'dirt':block.name;const slot=inventory.find(i=>i.name===drop);slot?slot.count++:inventory.push({name:drop,count:1});bot.entity.position=block.position.offset(.5,0,.5)},
  async placeBlock(ref,face){const p=ref.position.plus(face);placed.push(p.toString());cells.set(p.toString(),equipped.at(-1));const slot=inventory.find(i=>i.name===equipped.at(-1));if(slot)slot.count--}}
 return {bot,cells,inventory,placed,dug,equipped}
}
const api={check(){},stage(){},progress(){},persist(){},movements:{}}
test('a burrow needs diggable ground, solid walls on every level and a solid floor',()=>{
 assert.equal(world().bot&&burrowSite(world().bot).ok,true)
 const cave=world();cave.cells.set(new Vec3(11,62,10).toString(),'air');assert.match(burrowSite(cave.bot).reason,/wall/)
 const lake=world();lake.cells.set(new Vec3(9,61,10).toString(),'water');assert.match(burrowSite(lake.bot).reason,/Liquid/)
 const hollow=world();hollow.cells.set(new Vec3(10,60,10).toString(),'air');assert.match(burrowSite(hollow.bot).reason,/floor/)
 const rock=world('stone');assert.match(burrowSite(rock.bot).reason,/stone/)
 rock.inventory.push({name:'wooden_pickaxe',count:1});assert.equal(burrowSite(rock.bot).ok,true)
 const airborne=world();airborne.bot.entity.onGround=false;assert.match(burrowSite(airborne.bot).reason,/ground/)
 // The cap level is refilled, so a hillside with one open side there still works; the deeper cells need every wall.
 const slope=world();slope.cells.set(new Vec3(11,63,10).toString(),'air');assert.equal(burrowSite(slope.bot).ok,true)
 const bare=world();for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]])bare.cells.set(new Vec3(10+dx,63,10+dz).toString(),'short_grass');assert.match(burrowSite(bare.bot).reason,/cap/)
})
test('a rejected column steps to a sound neighbouring column before digging',async()=>{
 const w=world();w.cells.set(new Vec3(11,62,10).toString(),'air')
 let walked
 w.bot.pathfinder.goto=async g=>{walked=[g.x,g.y,g.z];w.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}
 const result=await burrowIn(w.bot,{kind:'burrow',goal:{}},api)
 assert.ok(walked,'should have moved');assert.notDeepEqual([walked[0],walked[2]],[10,10]);assert.equal(walked[1],64)
 assert.equal(result.receipt,'burrowed_capped');assert.deepEqual(result.surface,{x:walked[0],y:64,z:walked[2]})
})
test('digging in goes three deep, caps the shaft with dug earth and reports the surface cell',async()=>{
 const w=world()
 const result=await executeSkill(w.bot,{kind:'burrow',goal:{}},api)
 assert.deepEqual(w.dug,[new Vec3(10,63,10).toString(),new Vec3(10,62,10).toString(),new Vec3(10,61,10).toString()])
 assert.equal(w.bot.entity.position.y,61)
 assert.deepEqual(w.placed,[new Vec3(10,63,10).toString()]);assert.equal(w.cells.get(new Vec3(10,63,10).toString()),'dirt')
 assert.equal(result.receipt,'burrowed_capped');assert.equal(result.shelterName,'burrow');assert.deepEqual(result.surface,{x:10,y:64,z:10})
 assert.equal(w.inventory.find(i=>i.name==='dirt').count,2)
})
test('a hit that knocks the bot off the shaft is answered by stepping back over it',async()=>{
 const w=world();let knocked=false,walked=[]
 const dig=w.bot.dig;w.bot.dig=async block=>{await dig(block);if(!knocked){knocked=true;w.bot.entity.position=new Vec3(11.5,64,10.5)}}
 w.bot.pathfinder.goto=async g=>{walked.push([g.x,g.y,g.z]);w.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}
 const messages=[];const result=await burrowIn(w.bot,{kind:'burrow',goal:{}},{...api,progress:m=>messages.push(m)})
 assert.deepEqual(walked,[[10,63,10]]);assert.equal(result.receipt,'burrowed_capped');assert.equal(w.bot.entity.position.y,61)
 assert.ok(messages.some(m=>/Dug 3\/3/.test(m)),messages.join(' | '))
})
test('a gravity block never becomes the cap, so a sand burrow stays open and says so',async()=>{
 const w=world('sand');w.cells.set(new Vec3(10,63,10).toString(),'sand')
 const result=await burrowIn(w.bot,{kind:'burrow',goal:{}},api)
 assert.equal(result.receipt,'burrowed_open');assert.deepEqual(w.placed,[])
})
test('burrow clearance waits for daylight, health and an empty neighbourhood',()=>{
 const w=world();assert.match(burrowClearance(w.bot).reason,/daylight/)
 w.bot.time.timeOfDay=6000;w.bot.health=8;assert.match(burrowClearance(w.bot).reason,/Health/)
 w.bot.health=16;w.bot.entities={1:{name:'zombie',position:new Vec3(14.5,64,10.5)}};assert.match(burrowClearance(w.bot).reason,/hostile/)
 w.bot.entities={1:{name:'zombie',position:new Vec3(40.5,64,10.5)},2:{name:'cow',position:new Vec3(11.5,64,10.5)}};assert.equal(burrowClearance(w.bot).clear,true)
})
test('digging out lets the pathfinder tunnel and pillar back to the recorded surface cell',async()=>{
 const w=world();w.bot.entity.position=new Vec3(10.5,61,10.5);w.inventory.push({name:'dirt',count:2})
 let movements,goal
 w.bot.pathfinder={setMovements(m){movements=m},setGoal(){},async goto(g){goal=g;w.bot.entity.position=new Vec3(10.5,64,10.5)}}
 const result=await executeSkill(w.bot,{kind:'unburrow',goal:validateTaskGoal('unburrow',{surface:{x:10,y:64,z:10}})},api)
 assert.equal(movements.canDig,true);assert.equal(movements.allow1by1towers,true);assert.ok(movements.scafoldingBlocks.includes(registry.blocksByName.dirt.id))
 assert.deepEqual([goal.x,goal.y,goal.z],[10,64,10]);assert.equal(result.receipt,'surfaced')
 assert.throws(()=>validateTaskGoal('unburrow',{}),/finite/)
})
test('with no shelter to retreat to, safety digs in, waits for day, digs out and continues the request',async()=>{
 const w=world();const runner=new EventEmitter();runner.bot=w.bot;runner.ready=true;runner.connectionId='c1';runner.profile='p';runner.owner='Sov'
 const commands=[]
 runner.command=c=>{commands.push(c.action);if(c.action==='stop')return;runner.task={id:String(commands.length),kind:c.action,status:'running'}
  const result=c.action==='burrow'?{receipt:'burrowed_capped',shelterName:'burrow',surface:{x:10,y:64,z:10}}:c.action==='unburrow'?{receipt:'surfaced'}:{}
  setTimeout(()=>{runner.task={...runner.task,status:'completed',result};runner.emit('event',{type:'task_finished',task:runner.task})},1)}
 runner.waitForIdle=async()=>{};runner.position=()=>({x:10,y:64,z:10})
 const said=[];let resumed=0
 const c={runner,projects:{},epoch:1,abort:null,phase:'acting',activity:'',requestProgress:{id:'r1',status:'running',feedback:[],completed:[]},safety:null,burrowWait:{quietMs:20,limitMs:2000},
  say:t=>said.push(t),persist(){},emit(){},cancel(){},interrupt(){this.requestProgress.status='interrupted'},dispatch(cmd){runner.command(cmd)},
  execute:Teammate.prototype.execute,leaveOccupiedShelter:async()=>{},seekSafety:Teammate.prototype.seekSafety,waitInBurrow:Teammate.prototype.waitInBurrow,
  async resume(){resumed++;this.requestProgress.status='running'}}
 const started=c.seekSafety('A potential hostile is within six blocks')
 await new Promise(r=>setTimeout(r,300));w.bot.time.timeOfDay=6000;w.bot.health=20
 await started
 assert.deepEqual(commands.filter(a=>a!=='stop'),['burrow','unburrow'])
 assert.equal(resumed,1);assert.equal(c.requestProgress.safetyContinuations.length,1);assert.equal(c.safety,null)
 assert.ok(said.some(t=>/digging in/i.test(t)),said.join(' | '))
})
