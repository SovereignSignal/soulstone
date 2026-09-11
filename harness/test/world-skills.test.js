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
