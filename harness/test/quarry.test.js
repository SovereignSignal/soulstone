import {test} from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {quarryStone,quarryColumn,findQuarryColumn} from '../src/quarry.js'
const registry=minecraftData('1.21.4')
function world({stoneFrom=60,pickaxe=true}={}){
 const cells=new Map(),inventory=pickaxe?[{name:'wooden_pickaxe',count:1,type:registry.itemsByName.wooden_pickaxe.id}]:[],dug=[]
 const bot={registry,entity:{position:new Vec3(10.5,64,10.5),onGround:true},inventory:{items:()=>inventory},
  blockAt(p){const name=cells.get(p.toString())??(p.y>=64?'air':p.y===63?'grass_block':p.y>stoneFrom?'dirt':'stone');return {name,position:p.clone(),boundingBox:registry.blocksByName[name]?.boundingBox,harvestTools:name==='stone'?{[registry.itemsByName.wooden_pickaxe.id]:true}:undefined}},
  pathfinder:{setGoal(){},setMovements(){},async goto(g){bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}},clearControlStates(){},
  tool:{async equipForBlock(){}},
  async dig(block){dug.push(block.position.toString());cells.set(block.position.toString(),'air');const drop=block.name==='stone'?'cobblestone':block.name==='grass_block'?'dirt':block.name;const slot=inventory.find(i=>i.name===drop);slot?slot.count++:inventory.push({name:drop,count:1});const p=bot.entity.position;if(block.position.x===Math.floor(p.x)&&block.position.z===Math.floor(p.z)&&block.position.y<p.y)bot.entity.position=block.position.offset(.5,0,.5)}}
 const count=n=>inventory.filter(i=>i.name===n).reduce((a,i)=>a+i.count,0)
 return {bot,cells,inventory,dug,count}
}
const api=w=>({check(){},stage(){},progress(){},persist(){},count:w.count,async acquire(){throw new Error('no crafting in this test')}})
test('a quarry column is refused over liquid, an open side or without a pickaxe',()=>{
 const ok=world();assert.equal(quarryColumn(ok.bot,new Vec3(10,63,10)).ok,true)
 const lake=world();lake.cells.set(new Vec3(10,60,10).toString(),'water');assert.match(quarryColumn(lake.bot,new Vec3(10,61,10)).reason,/liquid|Liquid/)
 const cave=world();cave.cells.set(new Vec3(11,62,10).toString(),'air');assert.match(quarryColumn(cave.bot,new Vec3(10,62,10)).reason,/open/)
})
test('the quarry digs down to stone, mines the walls for cobblestone and climbs back out',async()=>{
 const w=world();let climbed
 w.bot.pathfinder.goto=async g=>{climbed=[g.x,g.y,g.z];w.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}
 const result=await quarryStone(w.bot,{name:'cobblestone',total:8,path:[]},api(w))
 assert.ok(w.count('cobblestone')>=8,'cobblestone '+w.count('cobblestone'))
 assert.ok(w.dug.some(k=>k===new Vec3(11,60,10).toString()||k===new Vec3(9,60,10).toString()),'mined a wall at the stone layer')
 assert.deepEqual(climbed,[10,64,10]);assert.equal(result.mined>=8,true);assert.equal(w.bot.entity.position.y,64)
})
test('the quarry stops at its depth bound and still climbs out with what it has',async()=>{
 const w=world({stoneFrom:40});let climbed=false
 w.bot.pathfinder.goto=async g=>{climbed=true;w.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}
 const result=await quarryStone(w.bot,{name:'cobblestone',total:8,path:[]},api(w))
 assert.equal(result.mined,0);assert.ok(result.depth<=12);assert.equal(climbed,true);assert.equal(w.bot.entity.position.y,64)
})
test('the quarry prepares a pickaxe through the acquisition callback when none is carried',async()=>{
 const w=world({pickaxe:false});const wanted=[]
 const a={...api(w),async acquire(name){wanted.push(name);w.inventory.push({name:'wooden_pickaxe',count:1,type:registry.itemsByName.wooden_pickaxe.id})}}
 await quarryStone(w.bot,{name:'cobblestone',total:3,path:[]},a)
 assert.deepEqual(wanted,['wooden_pickaxe']);assert.ok(w.count('cobblestone')>=3)
})

test('an open side at the surface cell is tolerated; deeper open sides move the shaft to a neighbour',async()=>{
 const slope=world();slope.cells.set(new Vec3(11,63,10).toString(),'air')
 assert.equal(quarryColumn(slope.bot,new Vec3(10,63,10),{top:true}).ok,true);assert.equal(findQuarryColumn(slope.bot).move,null)
 const cave=world();cave.cells.set(new Vec3(11,62,10).toString(),'air');const walked=[]
 cave.bot.pathfinder.goto=async g=>{walked.push([g.x,g.y,g.z]);cave.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}
 const found=findQuarryColumn(cave.bot);assert.ok(found.move);assert.notDeepEqual([found.surface.x,found.surface.z],[10,10])
 const result=await quarryStone(cave.bot,{name:'cobblestone',total:4,path:[]},api(cave))
 assert.ok(result.mined>=4);assert.equal(walked[0][1],64)
})

test('a refused quarry says why it was refused',async()=>{
 // `No sound quarry column here or beside it` was the whole message. The reason
 // quarryColumn had already computed was thrown away, and the reason matters:
 // "Shaft side is open at ..." is what standing on your own tower looks like
 // from below, and it never once reached the log.
 const tower=world()
 for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]])tower.cells.set(new Vec3(10+dx,62,10+dz).toString(),'air')
 const found=findQuarryColumn(tower.bot)
 assert.equal(found.surface,undefined,'nowhere here is usable')
 assert.match(found.reason,/Shaft side is open at 11,62,10/)
 await assert.rejects(quarryStone(tower.bot,{name:'cobblestone',total:4,path:[]},api(tower)),
  /No sound quarry column here or beside it: Shaft side is open at 11,62,10/)
})

test('a cancelled walk to the quarry column reports our own stopwatch, not the world',async()=>{
 // The deadline clears the goal, so goto REJECTS with GoalChanged. Unconverted,
 // the pathfinder's report of our own cancel escapes into a classifier that does
 // not list it, and a transient stall becomes a terminal failure.
 const cave=world();cave.cells.set(new Vec3(11,62,10).toString(),'air')
 cave.bot.pathfinder.goto=async()=>{throw Object.assign(new Error('The goal was changed before it could be completed!'),{name:'GoalChanged'})}
 const original=global.setTimeout
 global.setTimeout=fn=>{fn();return {unref(){}}}
 try{
  await assert.rejects(quarryStone(cave.bot,{name:'cobblestone',total:4,path:[]},api(cave)),e=>{
   assert.equal(e.name,'Timeout',`a stalled step must stay retryable, got ${e.name}: ${e.message}`)
   assert.match(e.message,/quarry/i)
   return true
  })
 }finally{global.setTimeout=original}
})
