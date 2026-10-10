import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {Vec3} from 'vec3'
import {executeWorldSkill,playerIntersectsSite,approachPlacement,findBuildSite,jumpPlacement} from '../src/world-skills.js'
import {shelterLayout,inspectShelterSite} from '../src/shelter.js'
import {validateTaskGoal} from '../src/task-store.js'
import minecraftData from 'minecraft-data'

function jumpFixture(){
 const controls=[],face={ref:new Vec3(0,65,0),face:new Vec3(0,-1,0)}
 let tick=0,walked=false
 const bot={registry:minecraftData('1.21.4'),players:{},entity:{position:new Vec3(-.5,64,.5),onGround:true},
  blockAt:p=>({position:p,name:p.x===-1&&p.y===63&&p.z===0?'stone':'air'}),clearControlStates(){},
  setControlState:(key,value)=>controls.push([key,value]),async waitForTicks(){tick++;bot.entity.position.y=64+tick*.3;bot.entity.onGround=false}}
 const goal={pos:new Vec3(0,66,0),getFaceAndRef:eye=>eye.y>66?face:null}
 const api={check(){},async walk(g){walked=true;bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)},async place(actual){assert.equal(actual,face);assert.ok(bot.entity.position.y>64.3)}}
 return {bot,goal,api,controls,walked:()=>walked}
}
test('roof placement jumps from checked ground and uses an actual visible face',async()=>{
 const f=jumpFixture();let placed=0;const place=f.api.place;f.api.place=async face=>{await place(face);placed++}
 assert.equal(await jumpPlacement(f.bot,f.goal,f.api),true);assert.equal(placed,1);assert.ok(f.walked())
 assert.equal(f.controls.filter(([key,value])=>key==='jump'&&value).length,1)
 assert.deepEqual(f.controls.at(-1),['jump',false])
})
test('jump placement rejects low ceilings, lost support and another player in its stance',async()=>{
 for(const obstruction of ['ceiling','support','player']){
  const f=jumpFixture(),blockAt=f.bot.blockAt;let placed=false;f.api.place=async()=>{placed=true}
  if(obstruction==='ceiling')f.bot.blockAt=p=>p.y===66?{name:'stone'}:blockAt(p)
  if(obstruction==='support'){const walk=f.api.walk;f.api.walk=async g=>{await walk(g);f.bot.blockAt=p=>p.y===63?{name:'water'}:blockAt(p)}}
  if(obstruction==='player')f.bot.players.owner={entity:{position:new Vec3(-.5,64,.5)}}
  assert.equal(await jumpPlacement(f.bot,f.goal,f.api),false);assert.equal(placed,false);assert.equal(f.controls.length,0)
 }
})
test('jump placement rechecks visibility and releases jump on cancellation or failed placement',async()=>{
 for(const failure of ['cancel','blocked','server']){
  const f=jumpFixture();let placed=false
  if(failure==='cancel')f.api.check=()=>{if(!f.bot.entity.onGround)throw new Error('Cancelled')}
  if(failure==='blocked'){const visible=f.goal.getFaceAndRef;f.goal.getFaceAndRef=eye=>f.walked()?null:visible(eye)}
  f.api.place=async()=>{placed=true;throw new Error('Server rejected')}
  if(failure==='blocked')assert.equal(await jumpPlacement(f.bot,f.goal,f.api),false)
  else await assert.rejects(jumpPlacement(f.bot,f.goal,f.api),failure==='cancel'?/Cancelled/:/Server rejected/)
  assert.equal(placed,failure==='server');assert.deepEqual(f.controls.at(-1),['jump',false])
 }
})

function starterHouse(){
 const design=[]
 for(let x=0;x<4;x++)for(let z=0;z<4;z++)for(let y=0;y<3;y++){
  if(y===2||((x===0||x===3||z===0||z===3)&&!(x===1&&z===0)))design.push({x,y,z,block:'wood_planks'})
 }
 return design
}
test('starter house finds lower ground beyond the old radius and verifies door access',()=>{
 const design=starterHouse(),layout=shelterLayout(design),near=new Vec3(0,69,0)
 const bot={players:{},blockAt:p=>{const solid=p.y<=63&&p.x>=14&&p.x<=23&&p.z>=-5&&p.z<=8;return {position:p,name:solid?'grass_block':'air',boundingBox:solid?'block':'empty'}}}
 const origin=findBuildSite(bot,design,near,{layout})
 assert.ok(origin);assert.equal(origin.y,64);assert.ok(origin.x>=14)
 // Nothing flat within 24 blocks: the search widens to 48 before giving up.
 const far={players:{},blockAt:p=>{const solid=p.y<=63&&p.x>=30&&p.x<=39&&p.z>=-5&&p.z<=8;return {position:p,name:solid?'grass_block':'air',boundingBox:solid?'block':'empty'}}}
 const distant=findBuildSite(far,design,near,{layout});assert.ok(distant);assert.ok(distant.x>=30)
 assert.doesNotThrow(()=>inspectShelterSite(bot,origin,layout))
 assert.equal(findBuildSite(bot,design,near,{layout,protectedSites:[{minX:14,maxX:23,minZ:-5,maxZ:8}]}),null)
 bot.players.visitor={entity:{position:origin.offset(1,0,1)}}
 const alternate=findBuildSite(bot,design,near,{layout})
 assert.ok(alternate);assert.equal(playerIntersectsSite(bot.players.visitor.entity.position,alternate,{minX:0,maxX:3,minZ:0,maxZ:3,height:2}),false)
})
test('starter house rejects water, player masonry and unsupported entrances',()=>{
 const design=starterHouse(),near=new Vec3(0,64,0),layout=shelterLayout(design)
 for(const floor of ['water','oak_planks']){
  const bot={blockAt:p=>({position:p,name:p.y<=63?floor:'air',boundingBox:p.y<=63?'block':'empty'})}
  assert.equal(findBuildSite(bot,design,near,{layout}),null)
 }
 const bot={blockAt:p=>{const solid=p.y<=63&&p.x>=8&&p.x<=11&&p.z>=0&&p.z<=3;return {position:p,name:solid?'stone':'air',boundingBox:solid?'block':'empty'}}}
 assert.equal(findBuildSite(bot,design,near,{layout}),null)
})
test('starter house protected footprints survive task validation',()=>{
 const goal={design:starterHouse(),near:{x:0,y:69,z:0},protectedSites:[{minX:1,maxX:4,minZ:2,maxZ:6}]}
 assert.deepEqual(validateTaskGoal('build',goal).protectedSites,goal.protectedSites)
 assert.throws(()=>validateTaskGoal('build',{...goal,protectedSites:[{minX:5,maxX:1,minZ:0,maxZ:1}]}),/rectangle/)
})

test('acquisition replenishes shared ingredients consumed by a prerequisite recipe',async()=>{
 const names=['oak_log','oak_planks','stick','wooden_pickaxe','crafting_table']
 const items=names.map((name,id)=>({id,name})),itemsByName=Object.fromEntries(items.map(i=>[i.name,i]))
 const recipe=(id,count,ingredients,requiresTable=false)=>({result:{id,count},requiresTable,delta:[...ingredients.map(([id,count])=>({id,count:-count})),{id,count}]})
 const recipes={1:[recipe(1,4,[[0,1]])],2:[recipe(2,4,[[1,2]])],3:[recipe(3,1,[[1,3],[2,2]],true)]}
 const inventory=new Map([[0,3]]),client=new EventEmitter(),table={name:'crafting_table',position:new Vec3(0,64,0)}
 const bot={registry:{items,itemsByName,blocksByName:{oak_log:{id:0},crafting_table:{id:4}}},_client:client,
  inventory:{items:()=>[...inventory].filter(([,count])=>count>0).map(([id,count])=>({type:id,name:names[id],count}))},
  findBlocks:()=>[],findBlock:()=>table,
  entity:{position:new Vec3(1.5,64,0.5)},world:{raycast:()=>({position:table.position})},
  pathfinder:{setMovements(){},setGoal(){},async goto(){}},
  recipesAll:id=>recipes[id]||[],
  recipesFor:id=>(recipes[id]||[]).filter(r=>r.delta.filter(d=>d.count<0).every(d=>(inventory.get(d.id)||0)>=-d.count)),
  async craft(r){for(const d of r.delta)inventory.set(d.id,(inventory.get(d.id)||0)+d.count);client.emit('packet',{}, {name:'set_slot'})}
 }
 Object.setPrototypeOf(bot,new EventEmitter())
 const progress=[]
 const result=await executeWorldSkill(bot,{kind:'acquire',goal:{item:'wooden_pickaxe',count:1}},{check(){},stage(){},persist(){},progress:m=>progress.push(m),movements:{}},()=>{throw new Error('Existing logs should suffice')})
 assert.equal(result.item,'wooden_pickaxe');assert.equal(inventory.get(3),1)
 assert.ok(progress.some(m=>m.startsWith('Rechecking wooden_pickaxe')))
 assert.equal(client.listenerCount('packet'),0)
})

test('an unreachable distant table gives way at once to the one the agent carries',async()=>{
 // Trial 7, 23 September: three stone pickaxe acquires failed "Walking attempt
 // timed out" walking to a table outside the pit, one just after crafting a
 // table of its own. A carried table beats a terrain watch toward a far one.
 const names=['oak_planks','stick','stone_pickaxe','crafting_table','cobblestone']
 const items=names.map((name,id)=>({id,name})),itemsByName=Object.fromEntries(items.map(i=>[i.name,i]))
 const recipes={2:[{result:{id:2,count:1},requiresTable:true,delta:[{id:4,count:-3},{id:1,count:-2},{id:2,count:1}]}]}
 const inventory=new Map([[1,2],[3,1],[4,3]]),far={name:'crafting_table',position:new Vec3(30,64,0)}
 const walks=[]
 const bot={registry:{items,itemsByName,blocksByName:{crafting_table:{id:3},stone:{id:9}}},_client:new EventEmitter(),
  inventory:{items:()=>[...inventory].filter(([,count])=>count>0).map(([id,count])=>({type:id,name:names[id],count}))},
  findBlocks:()=>[],findBlock:()=>far,blockAt:()=>({name:'stone',boundingBox:'block'}),
  entity:{position:new Vec3(0.5,64,0.5),onGround:true},world:{raycast:()=>null},clearControlStates(){},
  pathfinder:{setMovements(){},setGoal(){},async goto(goal){walks.push(goal);throw Object.assign(new Error('No path to the goal!'),{name:'NoPath'})}},
  recipesAll:id=>recipes[id]||[],recipesFor:id=>recipes[id]||[],async craft(){throw new Error('must not craft without a table')}
 }
 Object.setPrototypeOf(bot,new EventEmitter())
 const progress=[],started=Date.now()
 await assert.rejects(
  executeWorldSkill(bot,{kind:'acquire',goal:{item:'stone_pickaxe',count:1}},{check(){},stage(){},persist(){},progress:m=>progress.push(m),movements:{}},()=>{throw new Error('must not gather')}),
  /No clear place for a crafting table/,'the fallback to its own table ran; the far walk failure did not end the acquire')
 assert.equal(walks.length,1,'one attempt at the far table, no terrain watch and retry')
 assert.ok(Date.now()-started<5000,`gave up on the far table promptly (${Date.now()-started} ms)`)
 assert.ok(progress.some(m=>/30,64,0/.test(m)&&/placing/i.test(m)),JSON.stringify(progress))
})

test('log acquisition bounds the per-trip shortfall, not the carry target',async()=>{
 function fixture(carried){
  const items=[{id:0,name:'spruce_log'}],inventory=new Map([[0,carried]])
  const bot={registry:{items,itemsByName:{spruce_log:items[0]},blocksByName:{spruce_log:{id:0}}},_client:new EventEmitter(),
   inventory:{items:()=>[...inventory].filter(([,count])=>count>0).map(([id,count])=>({type:id,name:'spruce_log',count}))},
   findBlocks:()=>[],findBlock:()=>null,entity:{position:new Vec3(0.5,64,0.5)},pathfinder:{setMovements(){},setGoal(){},async goto(){}},recipesAll:()=>[],recipesFor:()=>[]}
  Object.setPrototypeOf(bot,new EventEmitter())
  return {bot,inventory}
 }
 const context={check(){},stage(){},persist(){},progress(){},movements:{}}
 const calls=[]
 const partial=fixture(32)
 const result=await executeWorldSkill(partial.bot,{kind:'acquire',goal:{item:'spruce_log',count:40}},context,async(total,name)=>{calls.push([total,name]);partial.inventory.set(0,total)})
 assert.deepEqual(calls,[[40,'spruce_log']]);assert.equal(result.count,40)
 const empty=fixture(0)
 await assert.rejects(executeWorldSkill(empty.bot,{kind:'acquire',goal:{item:'spruce_log',count:40}},context,async()=>{throw new Error('must not gather')}),/32 logs per trip: carrying 0 spruce_log, 40 more needed/)
})

import {tableSite} from '../src/world-skills.js'
test('a crafting table site is found nearest-first in a small volume, not six fixed cells',()=>{
 const solid=new Set(),air=new Set(),p=new Vec3(0,64,0)
 const bot={entity:{position:new Vec3(.5,64,.5)},blockAt(q){if(air.has(q.toString()))return {name:'air'};if(solid.has(q.toString()))return {name:'stone',boundingBox:'block'};return {name:'oak_leaves',boundingBox:'block'}}}
 assert.equal(tableSite(bot),null)
 // A ledge one block down and two away: air at the cell and above it, stone under it.
 for(const q of [new Vec3(2,63,0),new Vec3(2,64,0)])air.add(q.toString());solid.add(new Vec3(2,62,0).toString())
 assert.deepEqual(tableSite(bot),new Vec3(2,63,0))
 // A closer valid cell wins.
 for(const q of [new Vec3(0,64,1),new Vec3(0,65,1)])air.add(q.toString());solid.add(new Vec3(0,63,1).toString())
 assert.deepEqual(tableSite(bot),new Vec3(0,64,1))
})
import {requireReachedGoal,supportsPlayer} from '../src/navigation.js'
import pathfinding from 'mineflayer-pathfinder'
test('navigation cannot report arrival for an empty failed path and mining excludes foot support',()=>{
 const bot={entity:{position:new Vec3(0.5,59,0.5)}},goal=new pathfinding.goals.GoalNear(0,65,0,2)
 assert.throws(()=>requireReachedGoal(bot,goal),/without reaching/)
 bot.entity.position.y=65;requireReachedGoal(bot,goal)
 assert.equal(supportsPlayer(new Vec3(0,64,0),bot.entity.position),true)
 assert.equal(supportsPlayer(new Vec3(1,64,0),bot.entity.position),false)
 assert.equal(supportsPlayer(new Vec3(0,66,0),bot.entity.position),false)
})


test('a clear block footprint is rejected when it overlaps a player',()=>{
 const origin={x:26,y:251,z:8},bounds={minX:0,maxX:4,minZ:0,maxZ:4,height:2}
 assert.equal(playerIntersectsSite({x:30.5,y:251,z:8.5},origin,bounds),true)
 assert.equal(playerIntersectsSite({x:33,y:251,z:8.5},origin,bounds),false)
 assert.equal(playerIntersectsSite({x:30.5,y:260,z:8.5},origin,bounds),false)
})


test('placement chooses another stance when actual visibility differs from the planned view',async()=>{
 const bot={entity:{position:new Vec3(0.5,64,0.5)}};let approaches=0
 const face={ref:new Vec3(2,64,0),face:new Vec3(1,0,0)}
 const goal={pos:new Vec3(3,64,0),isEnd:()=>true,heuristic:()=>0,hasChanged:()=>false,isValid:()=>true,getFaceAndRef:p=>p.x===1.5?face:null}
 const actual=await approachPlacement(bot,goal,async composite=>{
  if(++approaches===2){assert.equal(composite.isEnd(new Vec3(0,64,0)),false);assert.equal(composite.isEnd(new Vec3(1,64,0)),true);bot.entity.position=new Vec3(1.5,64,0.5)}
 },()=>{})
 assert.equal(actual,face);assert.equal(approaches,2)
})

test('unsupported placements never enter navigation or terrain recovery',async()=>{
 const goal=new pathfinding.goals.GoalPlaceBlock(new Vec3(0,4,0),{getBlock:()=>({shapes:[]})},{range:4.5})
 let walked=false
 await assert.rejects(approachPlacement({},goal,async()=>{walked=true;throw new Error('Navigation entered')},()=>{}),/No adjacent placement face/)
 assert.equal(walked,false)
 await assert.rejects(approachPlacement({},goal,async()=>{},()=>{throw new Error('Cancelled')}),/Cancelled/)
})

test('placement on a fractional-height bed uses actual eye visibility and body clearance',async()=>{
 const bot={entity:{position:new Vec3(.5,64.5625,.5)}}
 const face={ref:new Vec3(2,65,0),face:new Vec3(0,-1,0)}
 const goal={pos:new Vec3(2,66,0),getFaceAndRef:eye=>eye.y>66?face:null}
 const result=await approachPlacement(bot,goal,async()=>{throw Object.assign(new Error('Voxel goal was not reached'),{code:'NAVIGATION_INCOMPLETE'})},()=>{})
 assert.equal(result,face)
 // The same eye ray cannot authorize placing a block through the player's head.
 goal.pos=new Vec3(0,66,0)
 await assert.rejects(approachPlacement(bot,goal,async()=>{},()=>{}),/No reachable placement face/)
 // Cancellation and other navigation failures are never swallowed.
 await assert.rejects(approachPlacement(bot,goal,async()=>{throw new Error('Cancelled')},()=>{}),/Cancelled/)
})

test('an unusable fractional placement stance excludes both possible voxel heights before retry',async()=>{
 const bot={entity:{position:new Vec3(.5,64.5625,.5)}};let attempts=0
 const face={ref:new Vec3(3,65,0),face:new Vec3(0,-1,0)}
 const goal={pos:new Vec3(3,66,0),isEnd:()=>true,heuristic:()=>0,hasChanged:()=>false,isValid:()=>true,getFaceAndRef:eye=>eye.x>1?face:null}
 await approachPlacement(bot,goal,async g=>{
  if(++attempts===1)throw Object.assign(new Error('Voxel mismatch'),{code:'NAVIGATION_INCOMPLETE'})
  assert.equal(g.isEnd(new Vec3(0,64,0)),false);assert.equal(g.isEnd(new Vec3(0,65,0)),false)
  bot.entity.position=new Vec3(1.5,65,.5)
 },()=>{})
 assert.equal(attempts,2)
})

test('a build failure names the first thing that went wrong, not the top layer deferral',async()=>{
 // The queue is sorted y-ascending and every deferred block is pushed back, so
 // the LAST error of a no-progress pass is structurally always the top layer's
 // PLACEMENT_UNSUPPORTED deferral. Every build failure in the six-hour run
 // therefore read "No adjacent placement face" and not one of them said what
 // actually stopped the build.
 const registry=minecraftData('1.21.4')
 const obstructed=new Map([['10,64,10','stone'],['10,65,10','dirt']])
 const bot={registry,players:{},_client:new EventEmitter(),world:{},
  entity:{position:new Vec3(10.5,64,12.5),onGround:true},
  inventory:{items:()=>[{name:'oak_planks',count:8,type:registry.itemsByName.oak_planks.id}]},
  blockAt:p=>({position:p,name:obstructed.get(`${p.x},${p.y},${p.z}`)||'air',boundingBox:'empty',shapes:[]}),
  findBlock:()=>null,findBlocks:()=>[],recipesAll:()=>[],recipesFor:()=>[],
  pathfinder:{setMovements(){},setGoal(){},async goto(){}},clearControlStates(){}}
 Object.setPrototypeOf(bot,new EventEmitter())
 const task={kind:'build',goal:{design:[{x:0,y:0,z:0,block:'oak_planks'},{x:0,y:1,z:0,block:'oak_planks'}],near:{x:10,y:64,z:10},origin:{x:10,y:64,z:10}}}
 await assert.rejects(executeWorldSkill(bot,task,{check(){},stage(){},progress(){},persist(){},movements:{}}),
  e=>{assert.match(e.message,/obstructed by stone/,`the first failure of the pass, got: ${e.message}`);return true})
})

test('flint is mined from gravel, keeping every gravel drop until the flint arrives',async()=>{
 // The portal rung needs flint and steel. Flint had no mining source, so
 // acquire flint failed, and gravel drops flint only about one time in ten:
 // requiring flint from each dig would have failed on the first gravel.
 const {default:minecraftData}=await import('minecraft-data'),{default:blockLoader}=await import('prismarine-block')
 const registry=minecraftData('1.21.4'),Block=blockLoader(registry)
 const world=new Map([['3,64,0','gravel'],['-3,64,0','gravel'],['0,64,3','gravel'],['0,66,0','gravel']])
 const name=p=>world.get(`${p.x},${p.y},${p.z}`)??(p.y<64?'stone':'air')
 const inventory=new Map(),count=n=>inventory.get(n)||0
 let digs=0,target=null
 const bot={registry,_client:new EventEmitter(),entity:{position:new Vec3(0.5,64,0.5),onGround:true},
  inventory:{items:()=>[...inventory].filter(([,c])=>c>0).map(([n,c])=>({name:n,count:c,type:registry.itemsByName[n].id}))},
  blockAt(p){const f=p.floored(),b=Block.fromStateId(registry.blocksByName[name(f)].defaultState,0);b.position=f;return b},
  findBlocks({matching,useExtraInfo}){return [...world].filter(([,n])=>[matching].flat().includes(registry.blocksByName[n].id)).map(([k])=>new Vec3(...k.split(',').map(Number))).filter(p=>!useExtraInfo||useExtraInfo(bot.blockAt(p)))},
  findBlock:()=>null,world:{raycast:()=>target&&{position:target}},clearControlStates(){},entities:{},
  pathfinder:{setMovements(){},setGoal(){},async goto(goal){const near=(goal.goals||[goal]).find(g=>g.rangeSq!==undefined);if(near){target=new Vec3(near.x,near.y,near.z);bot.entity.position=new Vec3(near.x+1.5,64,near.z+0.5)}}},
  tool:{async equipForBlock(){}},
  async dig(block){digs++;world.delete(`${block.position.x},${block.position.y},${block.position.z}`);const drop=digs%3===0?'flint':'gravel';inventory.set(drop,count(drop)+1)},
  recipesAll:()=>[],recipesFor:()=>[]}
 Object.setPrototypeOf(bot,new EventEmitter())
 const result=await executeWorldSkill(bot,{kind:'acquire',goal:{item:'flint',count:1}},{check(){},stage(){},persist(){},progress(){},movements:{}},()=>{throw new Error('must not gather logs')})
 assert.equal(result.item,'flint');assert.equal(count('flint'),1);assert.equal(count('gravel'),2,'the gravel it dug on the way is kept')
 assert.ok(world.has('0,66,0'),'gravel straight above its own column is never dug: it would fall on its head')
})

import {miningGoal} from '../src/world-skills.js'
test('shapeless resources have a reachable mining stance without inventing a visible collision face',()=>{
 const position=new Vec3(3,64,0),world={raycast:()=>null}
 const plant={position,shapes:[]},stone={position,shapes:[[0,0,0,1,1,1]]}
 assert.equal(miningGoal(plant,world).isEnd(new Vec3(2,64,0)),true)
 assert.equal(miningGoal(stone,world).isEnd(new Vec3(2,64,0)),false,'solid mining still requires a visible face')
 assert.equal(miningGoal(plant,world).isEnd(new Vec3(0,64,0)),false,'plant stance must remain in pickup range')
})

// Family run 6, 6 October: mining took any exposed block of the kind within 32
// blocks. The saved base's own footprint, a portal frame among it, is never a mine.
test('mining never takes a block inside the saved base',async()=>{
 const registry=(await import('minecraft-data')).default('1.21.4')
 const inside=new Vec3(1,64,1),seen=[]
 const bot={registry,_client:new EventEmitter(),inventory:{items:()=>[{name:'diamond_pickaxe',type:registry.itemsByName.diamond_pickaxe.id,count:1}]},
  findBlocks:({useExtraInfo})=>[inside].filter(p=>{if(!useExtraInfo)return true;const b=bot.blockAt(p),ok=useExtraInfo(b);seen.push(ok);return ok}),findBlock:()=>null,
  blockAt:p=>({name:p.equals(inside)?'obsidian':p.y===65&&p.x===1&&p.z===1?'air':'stone',position:p.clone(),boundingBox:'block',getProperties:()=>({})}),
  entity:{position:new Vec3(5.5,64,5.5),onGround:true},world:{raycast:()=>null},clearControlStates(){},
  pathfinder:{setMovements(){},setGoal(){},async goto(){}},recipesAll:()=>[],recipesFor:()=>[]}
 Object.setPrototypeOf(bot,new EventEmitter())
 const base={build:{origin:{x:0,y:64,z:0},design:[{x:0,y:0,z:0,block:'cobblestone'},{x:3,y:2,z:3,block:'dirt'}]}}
 await assert.rejects(executeWorldSkill(bot,{kind:'acquire',goal:{item:'obsidian',count:1}},{check(){},stage(){},persist(){},progress(){},movements:{},shelterProject:base},()=>{throw new Error('must not gather')}),/No reachable obsidian/)
 assert.deepEqual(seen,[false],'the block inside the footprint was offered and refused')
})

test('an item that only a furnace makes is refused with the smelt step, not a recipe cycle',async()=>{
 // Lab run 94, 10 October: acquire flint_and_steel with no iron failed with
 // "Recipe dependency cycle for iron_ingot". Its only crafting recipes need
 // ingots (from nuggets, from a block); ingots come from the furnace.
 const names=['iron_ingot','iron_nugget','iron_block','flint','flint_and_steel']
 const items=names.map((name,id)=>({id,name})),itemsByName=Object.fromEntries(items.map(i=>[i.name,i]))
 const recipe=(id,count,ingredients)=>({result:{id,count},requiresTable:false,delta:[...ingredients.map(([id,count])=>({id,count:-count})),{id,count}]})
 const recipes={0:[recipe(0,1,[[1,9]]),recipe(0,9,[[2,1]])],1:[recipe(1,9,[[0,1]])],2:[recipe(2,1,[[0,9]])],4:[recipe(4,1,[[0,1],[3,1]])]}
 const inventory=new Map([[3,1]])
 const bot={registry:{items,itemsByName,blocksByName:{}},_client:new EventEmitter(),
  inventory:{items:()=>[...inventory].filter(([,count])=>count>0).map(([id,count])=>({type:id,name:names[id],count}))},
  findBlocks:()=>[],findBlock:()=>null,entity:{position:new Vec3(0.5,64,0.5)},world:{raycast:()=>null},
  pathfinder:{setMovements(){},setGoal(){},async goto(){}},recipesAll:id=>recipes[id]||[],recipesFor:()=>[],async craft(){assert.fail('nothing to craft')}}
 Object.setPrototypeOf(bot,new EventEmitter())
 await assert.rejects(executeWorldSkill(bot,{kind:'acquire',goal:{item:'flint_and_steel',count:1}},{check(){},stage(){},persist(){},progress(){},movements:{}},()=>{throw new Error('must not gather')}),
  /iron_ingot comes from a furnace: smelt raw_iron/)
})

// A bow and arrows from scratch: feathers come from chickens and string from
// spiders, and neither has a recipe or a block to mine. acquire said "No mining
// source for feather" and stopped; it now hunts a drop that only an animal gives.
function arrowFixture({entities={},time=3000,carried=[['flint',1],['stick',1]]}={}){
 const registry=minecraftData('1.21.4'),id=n=>registry.itemsByName[n].id,name=i=>registry.items[i].name
 const recipe=(result,count,ingredients)=>({result:{id:id(result),count},requiresTable:true,delta:[...ingredients.map(([n,c])=>({id:id(n),count:-c})),{id:id(result),count}]})
 const recipes={[id('arrow')]:[recipe('arrow',4,[['flint',1],['stick',1],['feather',1]])],[id('bow')]:[recipe('bow',1,[['stick',3],['string',3]])]}
 const inventory=new Map(carried),client=new EventEmitter(),table={name:'crafting_table',position:new Vec3(0,64,0)}
 const bot={registry,_client:client,health:20,food:20,
  game:{gameMode:'survival',difficulty:'normal'},time:{timeOfDay:time},
  inventory:{items:()=>[...inventory].filter(([,count])=>count>0).map(([n,count])=>({type:id(n),name:n,count,...(n.endsWith('_sword')?{maxDurability:131,durabilityUsed:0}:{})}))},
  findBlocks:()=>[],findBlock:()=>table,blockAt:p=>({name:'air',position:p}),entities,
  entity:{id:1,type:'player',position:new Vec3(1.5,64,0.5),onGround:true,eyeHeight:1.62},clearControlStates(){},setControlState(){},
  // Only the table stops a ray: the walk to it can see it, and the animals are in the open.
  world:{raycast(s,d,len){const v=table.position.offset(.5,.5,.5).minus(s),along=v.dot(d);return along>=0&&along<=len&&v.minus(d.scaled(along)).norm()<.9?{position:table.position,name:'crafting_table'}:null}},
  pathfinder:{setMovements(){},setGoal(g){if(g&&g.entity)bot.entity.position=new Vec3(g.entity.position.x-1,64,g.entity.position.z)},async goto(g){if(g?.pos)bot.entity.position=new Vec3(g.pos.x+1.5,64,g.pos.z+.5)}},
  async equip(){},async lookAt(){},
  attack(e){e.health-=7;if(e.health<=0){delete bot.entities[e.id];bot.emit('entityDead',e);const drop=e.name==='chicken'?'feather':'string';inventory.set(drop,(inventory.get(drop)||0)+(e.name==='chicken'?1:2))}},
  recipesAll:i=>recipes[i]||[],
  recipesFor:i=>(recipes[i]||[]).filter(r=>r.delta.filter(d=>d.count<0).every(d=>(inventory.get(name(d.id))||0)>=-d.count)),
  async craft(r){for(const d of r.delta)inventory.set(name(d.id),(inventory.get(name(d.id))||0)+d.count);client.emit('packet',{},{name:'set_slot'})}
 }
 Object.setPrototypeOf(bot,new EventEmitter())
 return {bot,inventory}
}
test('acquire hunts a chicken for the feather an arrow needs, then crafts the arrows',async()=>{
 const {bot,inventory}=arrowFixture({entities:{8:{id:8,uuid:'c',type:'animal',name:'chicken',height:0.7,position:new Vec3(5,64,0),health:4}}})
 const result=await executeWorldSkill(bot,{kind:'acquire',goal:{item:'arrow',count:4}},{check(){},stage(){},persist(){},progress(){},movements:{}},()=>{throw new Error('no logs needed')})
 assert.equal(result.item,'arrow');assert.equal(inventory.get('arrow'),4)
})
test('acquire for string hunts a calm spider, and at night says when and how string comes instead of "no mining source"',async()=>{
 const spider=()=>({8:{id:8,uuid:'s',type:'hostile',name:'spider',height:0.9,position:new Vec3(5,64,0),health:16}})
 const ctx={check(){},stage(){},persist(){},progress(){},movements:{}},noLogs=()=>{throw new Error('no logs needed')}
 const day=arrowFixture({entities:spider(),carried:[['stick',3],['stone_sword',1],['string',1]]})
 await executeWorldSkill(day.bot,{kind:'acquire',goal:{item:'bow',count:1}},ctx,noLogs)
 assert.equal(day.inventory.get('bow'),1,'bow crafted from hunted string')
 const night=arrowFixture({entities:spider(),time:15000,carried:[['stick',3],['stone_sword',1]]})
 await assert.rejects(executeWorldSkill(night.bot,{kind:'acquire',goal:{item:'bow',count:1}},ctx,noLogs),e=>{
  assert.doesNotMatch(e.message,/mining source/);assert.match(e.message,/spiders/);assert.match(e.message,/daylight/);return true})
 const unarmed=arrowFixture({entities:spider(),carried:[['stick',3]]})
 await assert.rejects(executeWorldSkill(unarmed.bot,{kind:'acquire',goal:{item:'bow',count:1}},ctx,noLogs),/stone_sword/,'arms itself before a spider hunt')
 const none=arrowFixture({carried:[['flint',1],['stick',1]]})
 await assert.rejects(executeWorldSkill(none.bot,{kind:'acquire',goal:{item:'arrow',count:4}},ctx,noLogs),e=>{
  assert.doesNotMatch(e.message,/mining source/);assert.match(e.message,/feather/);return true})
})
