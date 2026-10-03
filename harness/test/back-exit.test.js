import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {shaftCell} from '../src/back-exit.js'
import {insideBase} from '../src/retreat.js'
// Step 1 of workstreams/minecraft/back-exit-plan.md: the reserved interior
// floor cell a back exit goes down through, and the base still counting the
// bot as inside while it is in that shaft.
const design=[]
for(let x=0;x<4;x++)for(let z=0;z<4;z++)for(let y=0;y<3;y++)if((y===2||x===0||x===3||z===0||z===3)&&!(x===1&&z===0&&y<2))design.push({x,y,z,block:'cobblestone'})
const base=(stations={})=>({build:{origin:{x:10,y:64,z:20},design},stations})
test('the shaft cell is the interior floor cell farthest from the door that no station stands on',()=>{
 // Door at (1,0) relative; interior is (1..2, 1..2). Farthest from the door: (2,2).
 assert.deepEqual(shaftCell(base()),{x:12,y:64,z:22})
 assert.deepEqual(shaftCell(base({torch:{position:{x:12,y:64,z:22},confirmed:true}})),{x:11,y:64,z:22},'a torch on that cell moves it to the next farthest')
 assert.throws(()=>shaftCell(base({a:{position:{x:11,y:64,z:21}},b:{position:{x:12,y:64,z:21}},c:{position:{x:11,y:64,z:22}},d:{position:{x:12,y:64,z:22}}})),/free interior floor cell/)
 assert.throws(()=>shaftCell({build:null}),/saved base/)
 assert.deepEqual(shaftCell({...base(),backExit:{cell:{x:11,y:64,z:21}}}),{x:11,y:64,z:21},'a shaft already chosen is kept, wherever it is')
})
test('down the shaft the bot is still inside its base; anywhere else below the floor it is not',()=>{
 const project={...base(),backExit:{cell:{x:12,y:64,z:22},bottom:55}}
 const at=(x,y,z)=>insideBase({entity:{position:new Vec3(x,y,z)}},project)
 assert.equal(at(12.5,64,22.5),true,'standing on the shaft cell')
 assert.equal(at(12.5,60,22.5),true,'in the shaft')
 assert.equal(at(12.5,55,22.5),true,'at its bottom')
 assert.equal(at(12.5,54,22.5),false,'below the recorded bottom is somewhere else')
 assert.equal(at(11.5,60,21.5),false,'another column under the floor is not the base')
 assert.equal(insideBase({entity:{position:new Vec3(12.5,60,22.5)}},base()),false,'no shaft recorded, no column')
})

// Step 2: opening the back exit. The fake world is the quarry test's: a 4 by 4
// cobblestone hut at y 64 on grass over dirt over stone, and a dig of the block
// under the bot drops it one cell.
import minecraftData from 'minecraft-data'
import {tunnelOut,BACK_EXIT_DEPTH,BACK_EXIT_MIN_DEPTH} from '../src/back-exit.js'
const registry=minecraftData('1.21.4')
function world({pickaxe=true,at=[12.5,64,22.5]}={}){
 const cells=new Map(),inventory=pickaxe?[{name:'stone_pickaxe',count:1,type:registry.itemsByName.stone_pickaxe.id}]:[],dug=[]
 for(const d of design)cells.set(new Vec3(10+d.x,64+d.y,20+d.z).toString(),d.block)
 const bot={registry,entity:{position:new Vec3(...at),onGround:true},inventory:{items:()=>inventory},
  blockAt(p){const name=cells.get(p.toString())??(p.y>=64?'air':p.y===63?'grass_block':p.y>60?'dirt':'stone');return {name,position:p.clone(),boundingBox:registry.blocksByName[name]?.boundingBox}},
  pathfinder:{setGoal(){},async goto(g){bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}},clearControlStates(){},setControlState(){},
  tool:{async equipForBlock(){}},
  async dig(block){dug.push(block.position.toString());cells.set(block.position.toString(),'air');const p=bot.entity.position;if(block.position.x===Math.floor(p.x)&&block.position.z===Math.floor(p.z)&&block.position.y<p.y)bot.entity.position=block.position.offset(.5,0,.5)}}
 return {bot,cells,dug}
}
const api=()=>{const stages=[];return {check(){},stage(s){stages.push(s)},progress(){},persist(){},stages}}
test('the back exit digs the shaft cell down to depth and leaves the bot at the bottom, recorded on the project',async()=>{
 const w=world(),project=base({torch:{position:{x:12,y:64,z:22},confirmed:true}}),a=api()
 const result=await tunnelOut(w.bot,{goal:{project}},a)
 assert.equal(result.receipt,'back_exit_open');assert.deepEqual(result.cell,{x:11,y:64,z:22});assert.equal(result.depth,BACK_EXIT_DEPTH)
 assert.equal(result.bottom,64-BACK_EXIT_DEPTH);assert.deepEqual(project.backExit,{cell:{x:11,y:64,z:22},bottom:64-BACK_EXIT_DEPTH})
 assert.equal(Math.floor(w.bot.entity.position.y),64-BACK_EXIT_DEPTH);assert.equal(w.dug.length,BACK_EXIT_DEPTH)
 assert.ok(w.dug.every(k=>k.startsWith('(11, ')&&k.endsWith(', 22)')),'only the shaft column was dug: '+w.dug.join(' '))
 assert.ok(insideBase(w.bot,project),'at the bottom the bot still counts as inside its base')
 assert.ok(!w.dug.includes(new Vec3(11,64,22).toString()),'the floor cell itself is air inside the hut; digging starts below it')
})
test('the back exit is refused from outside the base, without a pickaxe, and over liquid, before any block is dug',async()=>{
 const outside=world({at:[20.5,64,30.5]})
 await assert.rejects(tunnelOut(outside.bot,{goal:{project:base()}},api()),/inside the base/);assert.equal(outside.dug.length,0)
 const bare=world({pickaxe:false})
 await assert.rejects(tunnelOut(bare.bot,{goal:{project:base()}},api()),/pickaxe/);assert.equal(bare.dug.length,0)
 const lake=world();lake.cells.set(new Vec3(12,62,22).toString(),'water');const project=base()
 await assert.rejects(tunnelOut(lake.bot,{goal:{project}},api()),/Liquid/);assert.equal(lake.dug.length,0)
 assert.equal(project.backExit?.bottom,undefined,'nothing recorded as open')
})
test('a shaft that meets a cave past the minimum depth stops there and reports it; one that meets it early climbs back and fails',async()=>{
 const late=world();late.cells.set(new Vec3(13,58,22).toString(),'air');const p1=base()
 const result=await tunnelOut(late.bot,{goal:{project:p1}},api())
 assert.equal(result.depth,5,'dug to 59; the 58 cell has an open side');assert.match(result.stoppedBy,/open/);assert.equal(p1.backExit.bottom,59)
 const early=world();early.cells.set(new Vec3(13,62,22).toString(),'air');const p2=base(),a=api()
 early.bot.pathfinder.goto=async g=>{early.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}
 await assert.rejects(tunnelOut(early.bot,{goal:{project:p2}},a),/at least/)
 assert.equal(p2.backExit?.bottom,undefined,'a failed exit records no bottom');assert.ok(a.stages.includes('surfacing'))
})
import {Runner} from '../src/runner.js'
import {STATION_ACTIONS} from '../src/stations.js'
import {EXPEDITION_ACTIONS} from '../src/prospecting.js'
test('every station and expedition action the planner may choose is one the runner accepts',()=>{
 // Lab run 18, 3 October: the planner chose tunnel_out and the runner answered
 // "allowed actions: navigate, follow, ..." from a case list kept by hand.
 for(const action of [...STATION_ACTIONS,...EXPEDITION_ACTIONS]){
  const calls=[];Runner.prototype.command.call({emit(){},skill:(...a)=>calls.push(a)},{action,goal:{},timeoutMs:1})
  assert.deepEqual(calls.map(c=>c[0]),[action],action)
 }
 assert.throws(()=>Runner.prototype.command.call({emit(){},skill(){}},{action:'dance',goal:{}}),/allowed actions/)
})
