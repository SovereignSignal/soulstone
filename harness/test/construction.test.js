import test from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {compileArchitecture,executeConstruction,projectName} from '../src/construction.js'
import {validatePlan} from '../src/companion/planner.js'
import {validateTaskGoal} from '../src/task-store.js'
const region=(x,y,z,x2,y2,z2,block)=>({x,y,z,x2,y2,z2,block})
const design=[region(0,0,0,8,0,8,'stone_bricks'),region(1,1,1,1,1,1,'checkpoint'),region(2,1,1,2,1,1,'checkpoint')]
test('compact architecture carves ordered regions and requires walkable headroom',()=>{
 const b=compileArchitecture([...design,region(0,0,0,0,0,0,'air')]);assert.equal(b.blocks.length,80)
 assert.throws(()=>compileArchitecture([...design,region(1,2,1,1,2,1,'cobblestone')]),/headroom/)
 assert.throws(()=>compileArchitecture([region(0,0,0,17,0,0,'stone')]),/bounds/)
 assert.throws(()=>compileArchitecture([...design,region(-16,0,-16,16,16,16,'stone')]),/budget/)
 assert.equal(projectName('base'),false);assert.equal(projectName('__proto__'),false)
})
test('construct passes planner and durable task validation without becoming base',()=>{
 const s={action:'construct',name:'castle',item:'',count:0,design}
 assert.equal(validatePlan({reply:'Building.',steps:[s]}).steps[0].action,'construct')
 assert.deepEqual(validateTaskGoal('construct',{...s,near:{x:0,y:64,z:0}}).design,design)
 assert.throws(()=>validatePlan({reply:'Building.',steps:[{...s,name:'base'}]}),/project/)
})
test('construction resumes in bounded batches and verifies actual walkthrough',async()=>{
 const world=new Map(),key=p=>[p.x,p.y,p.z].join(',');let stock=100,placements=0,walks=0
 const bot={registry:{blockCollisionShapes:{blocks:{stone_bricks:1},shapes:{1:[[0,0,0,1,1,1]]}},blocksByName:{stone_bricks:{boundingBox:'block'}},itemsByName:{stone_bricks:{}}},entity:{position:new Vec3(0,65,0)},inventory:{items:()=>[{name:'stone_bricks',count:stock}]},blockAt:p=>world.get(key(p))||{name:'air',boundingBox:'empty'}}
 const task={kind:'construct',goal:{name:'castle',design,near:{x:0,y:64,z:0},origin:{x:0,y:64,z:0}}}
 const api={check(){},progress(){},persist(){},async place(p,name){world.set(key(p),{name,boundingBox:'block'});stock--;placements++},async walk(g){bot.entity.position=new Vec3(g.x,g.y,g.z);bot.entity.onGround=true;walks++},async settle(predicate){assert.ok(predicate())}}
 const first=await executeConstruction(bot,task,api);assert.equal(first.partial,true);assert.equal(placements,64);assert.equal(walks,0)
 const last=await executeConstruction(bot,task,api);assert.equal(last.partial,false);assert.equal(placements,81);assert.equal(walks,2)
 await executeConstruction(bot,task,api);assert.equal(placements,81)
 world.set('1,66,1',{name:'stone',boundingBox:'block'})
 await assert.rejects(executeConstruction(bot,task,api),/access/)
})
test('construction reports missing materials and never removes unexpected blocks',async()=>{
 let placed=0
 const bot={registry:{blockCollisionShapes:{blocks:{stone_bricks:1},shapes:{1:[[0,0,0,1,1,1]]}},blocksByName:{stone_bricks:{boundingBox:'block'}},itemsByName:{stone_bricks:{}}},inventory:{items:()=>[]},blockAt:()=>({name:'air',boundingBox:'empty'})}
 const task={goal:{name:'castle',design,near:{x:0,y:64,z:0},origin:{x:0,y:64,z:0}}},api={check(){},progress(){},persist(){},place(){placed++}}
 const r=await executeConstruction(bot,task,api);assert.equal(r.partial,true);assert.equal(r.verifiedBlocks,0);assert.equal(placed,0)
 bot.blockAt=()=>({name:'chest',boundingBox:'block'})
 // Wall cells now accept any full block; the walk cells still refuse the chests, and nothing is removed.
 await assert.rejects(executeConstruction(bot,task,api),/obstruction|access/);assert.equal(placed,0)
})

test('construction reaches a late support and stops after a whole pass without progress',async()=>{
 const registry=minecraftData('1.21.4'),world=new Map(),key=p=>`${p.x},${p.y},${p.z}`
 const roof=[region(0,4,0,10,4,0,'oak_planks'),region(10,0,0,10,3,0,'oak_planks'),region(0,0,2,0,0,2,'checkpoint'),region(1,0,2,1,0,2,'checkpoint')]
 for(let y=0;y<4;y++)world.set(`10,${y},0`,{name:'oak_planks',boundingBox:'block'})
 const bot={registry,inventory:{items:()=>[{name:'oak_planks',count:11}]},entity:{position:new Vec3(0,0,2),onGround:true},blockAt:p=>world.get(key(p))||{name:p.y===-1?'stone':'air',boundingBox:p.y===-1?'block':'empty'}}
 const attempts=[],task={goal:{name:'roof',design:roof,origin:{x:0,y:0,z:0}}}
 const api={check(){},persist(){},progress(){},async place(p,name){
  attempts.push(key(p))
  if(![[1,0,0],[-1,0,0],[0,-1,0]].some(d=>world.has(key(p.offset(...d)))))throw new Error('No adjacent support')
  world.set(key(p),{name,boundingBox:'block'})
 },async walk(g){bot.entity.position=new Vec3(g.x,g.y,g.z)},async settle(predicate){assert.ok(predicate())}}
 const result=await executeConstruction(bot,task,api)
 assert.equal(result.partial,false);assert.equal(result.verifiedBlocks,15)
 assert.ok(attempts.indexOf('10,4,0')>=10)
 world.clear();attempts.length=0
 api.place=async p=>{attempts.push(key(p));throw new Error('Blocked')}
 await assert.rejects(executeConstruction(bot,task,api),/Construction paused: Blocked/)
 assert.equal(attempts.length,15,'Every candidate tried once before declaring no progress')
})

import {reviewArchitecture} from '../src/construction.js'
test('design review catches an inaccessible upper floor even when checkpoint headroom is clear',()=>{
 const b=compileArchitecture([...design,region(4,4,4,5,4,5,'stone_bricks'),region(4,5,4,4,5,4,'checkpoint')])
 assert.deepEqual(reviewArchitecture(b).unreachable,[new Vec3(4,5,4)])
})

import {guardIntent} from '../src/companion/intent.js'
test('castle requests reach the construction tool instead of being rejected as unknown intent',()=>{
 const plan=validatePlan({reply:'Building.',steps:[{action:'construct',name:'castle',count:0,item:'',design}]})
 assert.deepEqual(guardIntent(plan,'build a castle'),plan)
 assert.equal(validatePlan({reply:'Continue.',steps:[{action:'construct',name:'castle',count:0,item:'',design:[]}]}).steps[0].design.length,0)
})

import minecraftData from 'minecraft-data'
import {fullCube} from '../src/construction.js'
test('solid architecture checks actual collision shapes, not the misleading bounding-box label',()=>{
 const registry=minecraftData('1.21.4')
 for(const name of ['stone_bricks','glowstone','spruce_planks','cobblestone'])assert.equal(fullCube(registry,name),true,name)
 for(const name of ['stone_brick_stairs','oak_slab','oak_door','oak_fence','torch'])assert.equal(fullCube(registry,name),false,name)
})

// The creative world, 14 October 2026: a child set an oak log on the roof of the castle the
// bot was building, and the build stopped for ten minutes asking her to remove it. A plain
// wall cell holding someone's full block is filled; an air cell holding one is still blocked.
test('a full block someone else placed in a plain wall cell counts as part of the build',async()=>{
 const world=new Map(),key=p=>[p.x,p.y,p.z].join(',');let placements=0
 const bot={registry:{blockCollisionShapes:{blocks:{stone_bricks:1,oak_log:1},shapes:{1:[[0,0,0,1,1,1]]}},blocksByName:{stone_bricks:{boundingBox:'block'},oak_log:{boundingBox:'block'}},itemsByName:{stone_bricks:{}}},entity:{position:new Vec3(0,65,0),onGround:true},inventory:{items:()=>[{name:'stone_bricks',count:200}]},blockAt:p=>world.get(key(p))||{name:'air',boundingBox:'empty'}}
 const task={kind:'construct',goal:{name:'castle',design,near:{x:0,y:64,z:0},origin:{x:0,y:64,z:0}}}
 const api={check(){},progress(){},persist(){},async place(p,name){world.set(key(p),{name,boundingBox:'block'});placements++},async walk(g){bot.entity.position=new Vec3(g.x,g.y,g.z)},async settle(){}}
 const wall=compileArchitecture(design).blocks[0];world.set(key(new Vec3(wall.x,64+wall.y,wall.z)),{name:'oak_log',boundingBox:'block'})
 const r=await executeConstruction(bot,task,api)
 assert.equal(r.partial,true,'first batch');assert.equal(placements,64,'the log cell was not placed over')
 world.set('1,66,1',{name:'oak_log',boundingBox:'block'})
 await assert.rejects(executeConstruction(bot,task,api),/obstruction|access/,'a log in a walk cell is still in the way')
})
