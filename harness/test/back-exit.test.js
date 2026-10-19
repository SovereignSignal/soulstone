import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {shaftCell} from '../src/back-exit.js'
import {insideBase} from '../src/retreat.js'
// Step 1 of the back-exit plan: the reserved interior
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
 assert.equal(at(12.5,52,22.5),true,'a burrow from the shaft bottom is still under the floor')
 assert.equal(at(12.5,50,22.5),false,'deeper than the exit and a burrow can dig is somewhere else')
 assert.equal(at(11.5,60,21.5),false,'another column under the floor is not the base')
 assert.equal(insideBase({entity:{position:new Vec3(12.5,60,22.5)}},base()),false,'no shaft recorded, no column')
 assert.equal(insideBase({entity:{position:new Vec3(12.5,60,22.5)}},{...base(),backExit:{cell:{x:12,y:64,z:22}}}),true,'the recorded cell is enough; the bottom is a receipt, not a gate')
})

// Step 2: opening the back exit. The fake world is the quarry test's: a 4 by 4
// cobblestone hut at y 64 on grass over dirt over stone, and a dig of the block
// under the bot drops it one cell.
import minecraftData from 'minecraft-data'
import {tunnelOut,BACK_EXIT_DEPTH,BACK_EXIT_MIN_DEPTH} from '../src/back-exit.js'
const registry=minecraftData('1.21.4')
function world({pickaxe=true,at=[12.5,64,22.5],gravity=false}={}){
 const cells=new Map(),inventory=pickaxe?[{name:'stone_pickaxe',count:1,type:registry.itemsByName.stone_pickaxe.id}]:[],dug=[],placed=[]
 for(const d of design)cells.set(new Vec3(10+d.x,64+d.y,20+d.z).toString(),d.block)
 const bot={registry,entity:{position:new Vec3(...at),onGround:true},inventory:{items:()=>inventory},
  blockAt(p){const name=cells.get(p.toString())??(p.y>=64?'air':p.y===63?'grass_block':p.y>60?'dirt':'stone');return {name,position:p.clone(),boundingBox:registry.blocksByName[name]?.boundingBox}},
  pathfinder:{setGoal(){},setMovements(){},async goto(g){bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}},clearControlStates(){},setControlState(){},
  tool:{async equipForBlock(){}},heldItem:null,
  async equip(item){bot.heldItem=item},
  async placeBlock(ref,face){const at=ref.position.plus(face);const item=inventory.find(i=>i.name==='cobblestone');if(!item||item.count<1)throw new Error('nothing to place');item.count--;cells.set(at.toString(),'cobblestone');placed.push(at.toString())},
  async dig(block){dug.push(block.position.toString());cells.set(block.position.toString(),'air');if(block.name==='stone'){const c=inventory.find(i=>i.name==='cobblestone');c?c.count++:inventory.push({name:'cobblestone',count:1,type:registry.itemsByName.cobblestone.id})}const p=bot.entity.position;if(block.position.x===Math.floor(p.x)&&block.position.z===Math.floor(p.z)&&block.position.y<p.y)bot.entity.position=block.position.offset(.5,0,.5)}}
 if(gravity){
  // A bot over open cells falls to the next solid one, as the live bot does.
  let pos=bot.entity.position
  Object.defineProperty(bot.entity,'position',{get(){while(pos.y>0&&bot.blockAt(pos.floored().offset(0,-1,0)).name==='air')pos=pos.offset(0,-1,0);return pos},set(v){pos=v},configurable:true})
 }
 return {bot,cells,dug,placed,inventory}
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
test('a shaft that meets liquid past the minimum depth stops there and reports it; one that meets it early climbs back and fails',async()=>{
 const late=world();late.cells.set(new Vec3(13,58,22).toString(),'water');const p1=base()
 const result=await tunnelOut(late.bot,{goal:{project:p1}},api())
 assert.equal(result.depth,5,'dug to 59; water beside the 58 cell');assert.match(result.stoppedBy,/Liquid/);assert.equal(p1.backExit.bottom,59)
 const early=world();early.cells.set(new Vec3(13,62,22).toString(),'water');const p2=base(),a=api()
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

test('a reserved shaft cell that was never opened and cannot open is re-reserved on a sound column; an opened shaft is never moved',async()=>{
 // Live rehearsal, 19 October: the reserved cell stood over an old burrow
 // gallery ("No solid floor below" at its first cell) while every other
 // interior column was solid, so a witch camping the door held the bot in.
 const w=world();w.inventory.push({name:'cobblestone',count:4,type:registry.itemsByName.cobblestone.id})
 w.cells.set(new Vec3(12,62,22).toString(),'air') // the reserved column's floor hangs over air
 const project={...base(),backExit:{cell:{x:12,y:64,z:22}}}
 const result=await tunnelOut(w.bot,{goal:{project}},api())
 assert.deepEqual(result.cell,{x:11,y:64,z:22},'the next farthest sound column is reserved instead')
 assert.deepEqual(project.backExit.cell,{x:11,y:64,z:22});assert.equal(project.backExit.bottom,64-BACK_EXIT_DEPTH)
 assert.ok(w.dug.every(k=>k.startsWith('(11, ')),'only the new column was dug: '+w.dug.join(' '))
 const opened=world();opened.cells.set(new Vec3(12,62,22).toString(),'air')
 const p2={...base(),backExit:{cell:{x:12,y:64,z:22},bottom:56}}
 await assert.rejects(tunnelOut(opened.bot,{goal:{project:p2}},api()),/No solid floor below/)
 assert.deepEqual(p2.backExit.cell,{x:12,y:64,z:22},'a shaft that was really dug keeps its cell')
})
test('an open side beside the shaft is sealed with a carried block and the dig goes on; a cave of open sides stops it',async()=>{
 // Lab run 19, 3 October 00:57 UTC: the bot's earlier burrows left a gallery of
 // air two and three blocks under the base floor. The shaft met it at depth 2
 // ("Shaft side is open at -624,66,-365") and gave up with a block in hand.
 const w=world();w.inventory.push({name:'cobblestone',count:4,type:registry.itemsByName.cobblestone.id})
 for(const y of [62,61])w.cells.set(new Vec3(12,y,23).toString(),'air') // beside the shaft at depths 2 and 3, like the lab
 const project=base(),result=await tunnelOut(w.bot,{goal:{project}},api())
 assert.equal(result.depth,BACK_EXIT_DEPTH);assert.equal(result.sealed,2)
 assert.deepEqual(w.placed,[new Vec3(12,62,23).toString(),new Vec3(12,61,23).toString()],'each open side closed before that cell was dug')
 assert.equal(w.bot.blockAt(new Vec3(12,62,23)).name,'cobblestone')
 const cave=world();cave.inventory.push({name:'cobblestone',count:64,type:registry.itemsByName.cobblestone.id})
 for(let y=59;y>=54;y--)for(const [dx,dz] of [[1,0],[-1,0],[0,1]])cave.cells.set(new Vec3(12+dx,y,22+dz).toString(),'air') // three open sides a level from depth 5 down
 const p2=base(),r2=await tunnelOut(cave.bot,{goal:{project:p2}},api())
 assert.equal(r2.depth,6,'eight seals close depths 5 and 6; the ninth opening at depth 7 is a cave');assert.match(r2.stoppedBy,/Too many open sides/);assert.equal(r2.sealed,8);assert.equal(p2.backExit.bottom,58)
 const bare=world();bare.cells.set(new Vec3(12,62,23).toString(),'air') // nothing carried to seal with
 await assert.rejects(tunnelOut(bare.bot,{goal:{project:base()}},api()),/Could not seal the open side at 12,62,23|at least/)
})

test('the shaft digs back through blocks the bot put there, never through a container or bedrock',async()=>{
 // Lab run 20, 3 October 01:04 UTC: run 19's climb back had placed a spruce
 // plank in the first shaft cell, and "Cannot quarry through spruce_planks"
 // closed the back exit for good. The cap on re-entry would do the same.
 const w=world();w.cells.set(new Vec3(12,63,22).toString(),'spruce_planks');w.cells.set(new Vec3(12,62,22).toString(),'cobblestone')
 const result=await tunnelOut(w.bot,{goal:{project:base()}},api())
 assert.equal(result.depth,BACK_EXIT_DEPTH);assert.ok(w.dug.includes(new Vec3(12,63,22).toString())&&w.dug.includes(new Vec3(12,62,22).toString()))
 const chest=world();chest.cells.set(new Vec3(12,63,22).toString(),'chest')
 await assert.rejects(tunnelOut(chest.bot,{goal:{project:base()}},api()),/Cannot quarry through chest/)
 const rock=world();rock.cells.set(new Vec3(12,63,22).toString(),'bedrock')
 await assert.rejects(tunnelOut(rock.bot,{goal:{project:base()}},api()),/Cannot quarry through bedrock/)
})

test('the first cell\'s sides are sealed too: an old burrow beside the floor is not a route to the surface',async()=>{
 // Lab run 21, 3 October 01:10 UTC: an air pocket beside the first shaft cell
 // joined the old gallery, the gallery reached the surface, and the threat
 // rule fired at depth 1 with a creeper ten blocks away.
 const w=world();w.inventory.push({name:'cobblestone',count:4,type:registry.itemsByName.cobblestone.id})
 w.cells.set(new Vec3(13,63,22).toString(),'air')
 const result=await tunnelOut(w.bot,{goal:{project:base()}},api())
 assert.equal(result.depth,BACK_EXIT_DEPTH);assert.equal(result.sealed,1);assert.equal(w.placed[0],new Vec3(13,63,22).toString())
})
import {inspectRetreatShelter,retreatToShelter,shelteredObservation,backExitObservation} from '../src/retreat.js'
function hut({shaftOpen=false,backExit=null,at=[12.5,64,22.5]}={}){
 // The back-exit fixture's hut with a spruce door in its gap, a torch inside
 // and the retreat's entity list, so inspectRetreatShelter runs for real.
 const w=world({at});w.inventory.push({name:'cobblestone',count:32,type:registry.itemsByName.cobblestone.id})
 w.cells.set(new Vec3(11,64,22).toString(),'torch');if(shaftOpen)w.cells.set(new Vec3(12,63,22).toString(),'air')
 let open=false,toggles=0;const inner=w.bot.blockAt
 w.bot.blockAt=p=>{if(p.x===11&&p.z===20&&(p.y===64||p.y===65))return {name:'spruce_door',position:p.clone(),boundingBox:'block',shapes:[[0,0,0,1,1,.2]],getProperties:()=>({open,half:p.y===64?'lower':'upper'})};const b=inner(p);return {...b,shapes:[],getProperties:()=>({})}}
 w.bot.world={getBlock:w.bot.blockAt};w.bot.entities={};w.bot.unequip=async()=>{};w.bot.activateBlock=async()=>{open=!open;toggles++}
 // A jump lifts the bot one cell at once, so the burrow's climb (jump, place beneath, land) runs without physics.
 w.bot.setControlState=(name,on)=>{if(name==='jump'&&on)w.bot.entity.position=w.bot.entity.position.offset(0,1,0)};w.bot.lookAt=async()=>{}
 const project={...base({torch:{position:{x:11,y:64,z:22},confirmed:true}}),backExit};project.build.wood='spruce_log'
 const api={check(){},progress(){},stage(){},settle:async fn=>assert.ok(fn()),walk:async g=>{w.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}}
 return {w,project,api,toggles:()=>toggles,isOpen:()=>open}
}
test('the base inspection accepts the recorded shaft cell open, and only that cell',()=>{
 const open=hut({shaftOpen:true,backExit:{cell:{x:12,y:64,z:22},bottom:56}})
 assert.doesNotThrow(()=>inspectRetreatShelter(open.w.bot,open.project))
 const unknown=hut({shaftOpen:true})
 assert.throws(()=>inspectRetreatShelter(unknown.w.bot,unknown.project),/lacks support at 12,64,22/)
})
test('retreat from down the back exit climbs up through a burrow cap, leaves the door shut and closes the shaft',async()=>{
 // Lab run 21 left the bot burrowed four cells below the shaft's recorded
 // bottom with a cap overhead; run 22's goto could not path up the column.
 const {w,project,api,toggles,isOpen}=hut({shaftOpen:true,backExit:{cell:{x:12,y:64,z:22},bottom:56},at:[12.5,58,22.5]})
 for(let y=62;y>=59;y--)w.cells.set(new Vec3(12,y,22).toString(),'air');w.cells.set(new Vec3(12,60,22).toString(),'cobblestone') // open column with a burrow cap two above the head
 // The cap is the bot's own, as the burrow records it (natural.js claimPlaced); a player's block would stop the climb.
 w.bot.ownBlocks=new OwnBlocks(null);w.bot.ownBlocks.add(new Vec3(12,60,22),'cobblestone',null)
 assert.equal(insideBase(w.bot,project),true)
 const result=await retreatToShelter(w.bot,{kind:'retreat',goal:{project}},api)
 assert.equal(result.receipt,'sheltered_door_closed')
 assert.equal(toggles(),0,'the door was never touched');assert.equal(isOpen(),false)
 assert.ok(w.dug.includes(new Vec3(12,60,22).toString()),'the cap overhead was dug on the way up')
 assert.equal(w.bot.blockAt(new Vec3(12,63,22)).name,'cobblestone','the floor is back over the shaft (the climb pillars it closed)')
 assert.equal(project.backExit.bottom,undefined,'the shaft is closed; the cell stays reserved');assert.deepEqual(project.backExit.cell,{x:12,y:64,z:22})
 assert.deepEqual(w.bot.entity.position,new Vec3(11.5,64,21.5),'standing just inside the door')
 // Already inside at floor level with the shaft capped: nothing to place, door still shut.
 const again=await retreatToShelter(w.bot,{kind:'retreat',goal:{project}},api)
 assert.equal(again.capped,undefined);assert.equal(toggles(),0)
 // From outside the old path still opens and closes the door.
 const out=hut({at:[11.5,64,18.5]});await retreatToShelter(out.w.bot,{kind:'retreat',goal:{project:out.project}},out.api)
 assert.equal(out.toggles(),2);assert.equal(out.isOpen(),false)
})

test('down the back exit under the closed base the bot is sheltered; with the door open or a hostile in the hut it is not',()=>{
 const down=hut({shaftOpen:true,backExit:{cell:{x:12,y:64,z:22},bottom:56},at:[12.5,58,22.5]})
 const o=shelteredObservation(down.w.bot,down.project)
 assert.equal(o.passed,true,JSON.stringify(o));assert.equal(o.inside,true);assert.equal(o.closed,true)
 const ajar=hut({shaftOpen:true,backExit:{cell:{x:12,y:64,z:22},bottom:56},at:[12.5,58,22.5]});ajar.w.bot.activateBlock()
 assert.equal(shelteredObservation(ajar.w.bot,ajar.project).passed,false,'door open')
 const guest=hut({shaftOpen:true,backExit:{cell:{x:12,y:64,z:22},bottom:56},at:[12.5,58,22.5]});guest.w.bot.entities={1:{id:1,name:'zombie',position:new Vec3(11.5,64,22.5)}}
 assert.equal(shelteredObservation(guest.w.bot,guest.project).passed,false,'a zombie in the hut')
 const elsewhere=hut({at:[12.5,58,23.5]});elsewhere.project.backExit={cell:{x:12,y:64,z:22}}
 assert.equal(shelteredObservation(elsewhere.w.bot,elsewhere.project).inside,false,'another column under the floor is not the shaft')
})

test('the planner is told where the back exit is and whether the bot stands at its foot; climbing in the shaft is still inside',()=>{
 const none=hut();assert.equal(backExitObservation(none.w.bot,none.project),null)
 const shut=hut({backExit:{cell:{x:12,y:64,z:22}}});assert.deepEqual(backExitObservation(shut.w.bot,shut.project),{cell:{x:12,y:64,z:22},open:false,inShaft:false,atFoot:false,depthBelowFloor:0})
 const foot=hut({shaftOpen:true,backExit:{cell:{x:12,y:64,z:22},bottom:56},at:[12.5,56,22.5]})
 assert.deepEqual(backExitObservation(foot.w.bot,foot.project),{cell:{x:12,y:64,z:22},bottom:56,open:true,inShaft:true,atFoot:true,depthBelowFloor:8})
 const mid=hut({shaftOpen:true,backExit:{cell:{x:12,y:64,z:22},bottom:56},at:[12.5,60,22.5]});mid.w.bot.entity.onGround=false
 assert.equal(backExitObservation(mid.w.bot,mid.project).atFoot,false)
 assert.equal(shelteredObservation(mid.w.bot,mid.project).passed,true,'mid-jump in the shaft the bot is still behind its walls (run 26: the close-floors rule fired on a skeleton outside while it climbed)')
})

test('from a tunnel beside an open back exit the retreat walks to the shaft foot, climbs and never uses the door',async()=>{
 // Lab run 28, 3 October: one cell beside the shaft column at y 57, "base is
 // unavailable: Navigation ended without reaching the target", and the bot
 // dug in instead of going home up the shaft eight blocks away.
 const {w,project,api,toggles}=hut({shaftOpen:true,backExit:{cell:{x:12,y:64,z:22},bottom:56},at:[14.5,57,22.5]})
 for(let y=56;y<=63;y++)w.cells.set(new Vec3(12,y,22).toString(),'air');for(const x of [13,14])w.cells.set(new Vec3(x,57,22).toString(),'air') // the shaft and a side tunnel
 const walked=[];const goto=w.bot.pathfinder.goto;w.bot.pathfinder.goto=async g=>{walked.push([g.x,g.y,g.z]);return goto(g)}
 assert.equal(insideBase(w.bot,project),false,'beside the column is not inside')
 const result=await retreatToShelter(w.bot,{kind:'retreat',goal:{project}},api)
 assert.equal(result.receipt,'sheltered_door_closed');assert.deepEqual(walked[0],[12,56,22],'first to the shaft foot, by a digging pathfinder leg');assert.equal(toggles(),0)
 assert.deepEqual(w.bot.entity.position,new Vec3(11.5,64,21.5));assert.equal(w.bot.blockAt(new Vec3(12,63,22)).name,'cobblestone')
 // With the shaft shut (no bottom) the underground retreat is the door path as before.
 const shut=hut({backExit:{cell:{x:12,y:64,z:22}},at:[14.5,57,22.5]});const went=[];const g2=shut.w.bot.pathfinder.goto;shut.w.bot.pathfinder.goto=async g=>{went.push([g.x,g.y,g.z]);return g2(g)}
 await retreatToShelter(shut.w.bot,{kind:'retreat',goal:{project:shut.project}},shut.api)
 assert.deepEqual(went,[],'no digging leg when the shaft is shut');assert.equal(shut.toggles(),2)
})

test('the leave routine itself refuses at night and with a hostile in radius, whoever calls it',async()=>{
 // Lab run 30, 3 October: the plan was "prepare a pickaxe, then tunnel_out";
 // prepare's departure is deferred to the skill, whose own call to the leave
 // routine had no refusal. It walked out at 20000 into a creeper.
 const night=hut();night.w.bot.time={timeOfDay:20000};night.w.bot.game={difficulty:'normal'}
 await assert.rejects(retreatToShelter(night.w.bot,{kind:'leave_base',goal:{project:night.project}},night.api),/Dusk is here.*tunnel_out/);assert.equal(night.toggles(),0)
 const day=hut();day.w.bot.time={timeOfDay:6000};day.w.bot.game={difficulty:'normal'}
 const r=await retreatToShelter(day.w.bot,{kind:'leave_base',goal:{project:day.project}},day.api);assert.equal(r.receipt,'left_base_door_closed')
})

import {inspectShelterSite,shelterLayout,finishShelter} from '../src/shelter.js'
import {OwnBlocks} from '../src/natural.js'
test('finishing the saved base accepts its open back exit and never walks onto it',async()=>{
 // Lab run 60, 5 October: the repair put back a creeper-cratered floor, then
 // refused its own back exit ("lacks support at -624,68,-364") before the door
 // went back. The walkthrough would also have stepped into the shaft.
 const h=hut({shaftOpen:true,backExit:{cell:{x:12,y:64,z:22},bottom:63}})
 const o=new Vec3(10,64,20),layout=shelterLayout(design),walked=[]
 const api={...h.api,acquire:async()=>{},persist(){},walk:async g=>{walked.push([g.x,g.y,g.z]);h.w.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}}
 const r=await finishShelter(h.w.bot,o,layout,'spruce_log',{...api,shaft:h.project.backExit.cell})
 assert.equal(r.status,'usable');assert.ok(!walked.some(([x,y,z])=>x===12&&y===64&&z===22),'never stands on the open shaft')
 await assert.rejects(finishShelter(h.w.bot,o,layout,'spruce_log',api),/lacks support at 12,64,22/)
})
test('a repair of the saved base may clear a foreign block from its interior; otherwise it obstructs',()=>{
 // 3 October, play world: a climb left a cobblestone pillar block in the
 // cell just inside the door, and every repair refused it as "obstructed".
 const h=hut();h.w.cells.set(new Vec3(11,64,21).toString(),'cobblestone')
 const o=new Vec3(10,64,20),layout=shelterLayout(design)
 assert.throws(()=>inspectShelterSite(h.w.bot,o,layout,{repair:true}),/obstructed by cobblestone at 11,64,21/)
 const removed=inspectShelterSite(h.w.bot,o,layout,{repair:true,clear:b=>b.name==='cobblestone'})
 assert.ok(removed.some(c=>c.equals(new Vec3(11,64,21))))
})

test('a back exit left open by an earlier trip is dropped into, not refused, and the rest is dug as usual',async()=>{
 // Test run 50, 4 October: "Cannot open the back exit at -624,67,-364: Cannot
 // quarry through air", because the shaft from an earlier trip was never capped.
 const w=world({gravity:true,at:[11.5,64,21.5]});for(let y=61;y<=63;y++)w.cells.set(new Vec3(12,y,22).toString(),'air')
 const project=base(),r=await tunnelOut(w.bot,{goal:{project}},api())
 assert.equal(r.receipt,'back_exit_open');assert.equal(r.depth,BACK_EXIT_DEPTH);assert.equal(project.backExit.bottom,64-BACK_EXIT_DEPTH)
 assert.ok(!w.dug.some(k=>/, (61|62|63), /.test(k)),'the open cells were not dug: '+w.dug.join(' '))
 assert.equal(w.dug.length,BACK_EXIT_DEPTH-3)
})
// Play-world rehearsal, 16 October: one dirt roof block of the base was gone. The inspection
// threw on it, every retreat refused the base, and the bot dug in through its own floor
// with the dirt to mend it in its bag. The base is the bot's own build: a few air cells of
// it are put back from inside, door shut, with the design's own block, and never by digging.
const ROOF=new Vec3(12,66,22)
function holed({holes=[ROOF],dirt=1,...options}={}){
 const h=hut(options)
 h.project.build={...h.project.build,design:design.map(b=>b.y===2&&b.x>=1&&b.x<=2&&b.z>=1&&b.z<=2?{...b,block:'dirt'}:b)}
 for(const c of [new Vec3(11,66,21),new Vec3(12,66,21),new Vec3(11,66,22),ROOF])h.w.cells.set(c.toString(),'dirt')
 for(const c of holes)h.w.cells.set(c.toString(),'air')
 if(dirt)h.w.inventory.unshift({name:'dirt',count:dirt,type:registry.itemsByName.dirt.id})
 // The block placed is the one in hand, as the server has it.
 h.w.bot.placeBlock=async(ref,face)=>{const at=ref.position.plus(face),item=h.w.inventory.find(i=>i.name===h.w.bot.heldItem?.name);if(!item||item.count<1)throw new Error('nothing to place');item.count--;h.w.cells.set(at.toString(),item.name);h.w.placed.push(at.toString())}
 return h
}
test('the base inspection can list a few missing air cells instead of refusing; a foreign block or a crater still refuses',()=>{
 const one=holed(),missing=[]
 assert.throws(()=>inspectRetreatShelter(one.w.bot,one.project),/missing or changed at \(12, 66, 22\): air/,'strict as before without a list')
 assert.doesNotThrow(()=>inspectRetreatShelter(one.w.bot,one.project,{missing}))
 assert.deepEqual(missing.map(m=>[m.cell.toString(),m.block]),[[ROOF.toString(),'dirt']])
 const wool=holed();wool.w.cells.set(ROOF.toString(),'white_wool')
 assert.throws(()=>inspectRetreatShelter(wool.w.bot,wool.project,{missing:[]}),/missing or changed at \(12, 66, 22\): white_wool/)
 const crater=holed({holes:[ROOF,new Vec3(11,66,22),new Vec3(11,66,21),new Vec3(12,66,21),new Vec3(10,66,20)]})
 assert.throws(()=>inspectRetreatShelter(crater.w.bot,crater.project,{missing:[]}),/missing or changed/,'five is a rebuild for the build skill')
})
test('the retreat puts a missing roof block back from inside with the door shut, then verifies the base strictly',async()=>{
 const {w,project,api,isOpen}=holed({at:[11.5,64,18.5]})
 const r=await retreatToShelter(w.bot,{kind:'retreat',goal:{project}},api)
 assert.equal(r.receipt,'sheltered_door_closed');assert.deepEqual(r.repaired,[{x:12,y:66,z:22,block:'dirt'}])
 assert.equal(w.bot.blockAt(ROOF).name,'dirt');assert.equal(isOpen(),false);assert.deepEqual(w.dug,[],'nothing is dug')
 const bare=holed({dirt:0,at:[11.5,64,18.5]})
 await assert.rejects(retreatToShelter(bare.w.bot,{kind:'retreat',goal:{project:bare.project}},bare.api),/missing or changed at \(12, 66, 22\): air; I need 1 dirt/)
 assert.equal(bare.toggles(),0,'refused before the door is touched')
})
test('from the back exit\'s foot the retreat climbs, keeps the dirt for the roof, closes the shaft and repairs',async()=>{
 const {w,project,api,toggles}=holed({shaftOpen:true,backExit:{cell:{x:12,y:64,z:22},bottom:59},at:[12.5,59,22.5]})
 for(let y=59;y<=62;y++)w.cells.set(new Vec3(12,y,22).toString(),'air')
 const r=await retreatToShelter(w.bot,{kind:'retreat',goal:{project}},api)
 assert.equal(r.receipt,'sheltered_door_closed');assert.equal(r.repaired?.length,1);assert.equal(toggles(),0)
 assert.equal(w.bot.blockAt(ROOF).name,'dirt','the carried dirt went to the roof, not the climb');assert.equal(w.bot.blockAt(new Vec3(12,63,22)).name,'cobblestone')
 assert.deepEqual(w.bot.entity.position,new Vec3(11.5,64,21.5));assert.equal(project.backExit.bottom,undefined)
})
// Review of 16 October: only a full cube is put back; a missing slab, pane, door or torch is not
// a block a hole-filler restores, and the base is refused over it as before.
test('only a missing full cube is listed for repair; any other missing design block still refuses',()=>{
 const slab=holed();slab.project.build.design=slab.project.build.design.map(b=>b.x===2&&b.y===2&&b.z===2?{...b,block:'oak_slab'}:b)
 assert.throws(()=>inspectRetreatShelter(slab.w.bot,slab.project,{missing:[]}),/missing or changed at \(12, 66, 22\): air/)
})
// Review of 16 October: the climb's blocks and the repair's are one bag. A climb that would need
// the dirt kept for the roof fails before it starts, the dirt still carried and the bot still below.
test('a climb that would spend the blocks the repair needs fails before the climb',async()=>{
 const {w,project,api}=holed({shaftOpen:true,backExit:{cell:{x:12,y:64,z:22},bottom:59},at:[12.5,59,22.5]})
 for(let y=59;y<=62;y++)w.cells.set(new Vec3(12,y,22).toString(),'air')
 w.inventory.find(i=>i.name==='cobblestone').count=2
 await assert.rejects(retreatToShelter(w.bot,{kind:'retreat',goal:{project}},api),/takes 5 blocks/)
 assert.equal(w.inventory.find(i=>i.name==='dirt').count,1,'the dirt for the roof is untouched');assert.equal(Math.floor(w.bot.entity.position.y),59,'and the bot did not climb');assert.deepEqual(w.placed,[])
})
