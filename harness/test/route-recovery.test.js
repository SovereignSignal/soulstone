import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {Vec3} from 'vec3'
import {walkWithTerrainRecovery} from '../src/route-recovery.js'
function fixture(){
 const bot=new EventEmitter(),records=[],policies=[];let calls=0,cancelled=false
 bot.entity={position:new Vec3(0,65,0),onGround:true};bot.clearControlStates=()=>{}
 bot.pathfinder={setGoal(){},setMovements:m=>policies.push(m),async goto(){calls++;if(calls===1)throw Object.assign(new Error('No path'),{name:'NoPath'});bot.entity.position=new Vec3(2,65,0)}}
 const options={movements:{maxDropDown:1,canDig:false},check(){if(cancelled)throw new Error('Cancelled')},stage(){},progress(){},onRecovery:r=>records.push(r),attemptMs:100,waitMs:30}
 return {bot,records,policies,options,goal:{isEnd:p=>p.x===2},calls:()=>calls,cancel:()=>cancelled=true}
}
const block=(x,name)=>({position:new Vec3(x,65,0),name,boundingBox:name==='air'?'empty':'block',shapes:name==='air'?[]:[[0,0,0,1,1,1]]})
test('nearby collision change permits one verified retry under the same movement policy',async()=>{
 const f=fixture();f.options.onRecovery=r=>{f.records.push(r);if(r.status==='waiting')f.bot.emit('blockUpdate',block(1,'oak_leaves'),block(1,'air'))}
 await walkWithTerrainRecovery(f.bot,f.goal,f.options)
 assert.equal(f.calls(),2);assert.equal(f.records.at(-1).status,'recovered');assert.equal(f.records.at(-1).trigger,'nearby_collision_changed');assert.ok(f.policies.every(p=>p===f.options.movements));assert.equal(f.bot.listenerCount('blockUpdate'),0)
})
test('unchanged, distant and non-collision updates never authorize blind retries',async()=>{
 for(const [before,after] of [[null,null],[block(20,'stone'),block(20,'air')],[block(1,'oak_leaves'),block(1,'oak_leaves')]]){
  const f=fixture();f.options.onRecovery=r=>{f.records.push(r);if(r.status==='waiting')f.bot.emit('blockUpdate',before,after)}
  await assert.rejects(walkWithTerrainRecovery(f.bot,f.goal,f.options),/No path/)
  assert.equal(f.calls(),1);assert.equal(f.records.at(-1).status,'unchanged');assert.equal(f.bot.listenerCount('blockUpdate'),0)
 }
})
test('a changed standing block permits re-observation',async()=>{
 const f=fixture();f.options.onRecovery=r=>{f.records.push(r);if(r.status==='waiting')f.bot.entity.position.y--}
 await walkWithTerrainRecovery(f.bot,f.goal,f.options);assert.equal(f.records.at(-1).trigger,'standing_position_changed')
})
test('Stop during recovery prevents another attempt and removes listeners',async()=>{
 const f=fixture();f.options.onRecovery=r=>{if(r.status==='waiting')f.cancel()}
 await assert.rejects(walkWithTerrainRecovery(f.bot,f.goal,f.options),/Cancelled/);assert.equal(f.calls(),1);assert.equal(f.bot.listenerCount('blockUpdate'),0)
})
test('failed retry stops and a resolved goto without arrival is never success',async()=>{
 const f=fixture();f.bot.pathfinder.goto=async()=>{};f.options.onRecovery=r=>{f.records.push(r);if(r.status==='waiting')f.bot.emit('blockUpdate',block(1,'stone'),block(1,'air'))}
 await assert.rejects(walkWithTerrainRecovery(f.bot,f.goal,f.options),/without reaching/);assert.equal(f.records.at(-1).status,'failed');assert.equal(f.records.at(-1).attempts,2)
})
test('non-navigation errors do not enter recovery',async()=>{
 const f=fixture();f.bot.pathfinder.goto=async()=>{throw new Error('connection lost')}
 await assert.rejects(walkWithTerrainRecovery(f.bot,f.goal,f.options),/connection lost/);assert.deepEqual(f.records,[])
})

test('urgent retreat can bypass waiting so shelter selection can immediately try another candidate',async()=>{
 const f=fixture();await assert.rejects(walkWithTerrainRecovery(f.bot,f.goal,{...f.options,allowRecovery:false}),/No path/);assert.equal(f.calls(),1);assert.deepEqual(f.records,[]);assert.equal(f.bot.listenerCount('blockUpdate'),0)
})

import {Runner} from '../src/runner.js'
test('successful skill receipts retain a detached copy of recovery evidence for future planning',async()=>{
 const bot={registry:{itemsByName:{stone_shovel:{id:1}},blocksByName:{}},findBlocks:()=>[],collectBlock:{movements:{}},inventory:{items:()=>[{name:'stone_shovel',count:1,maxDurability:131,durabilityUsed:0}]},pathfinder:{setGoal(){}},clearControlStates(){}}
 const recovery={status:'recovered',attempts:2,trigger:'nearby_collision_changed'}
 const runner=Object.assign(Object.create(Runner.prototype),{bot,ready:true,closed:false,movements:{},task:{id:'prepare',kind:'prepare',status:'running',goal:{item:'stone_shovel',count:1},navigationRecovery:recovery},persist(){},log(){},say(){}})
 await runner.runSkill();assert.equal(runner.task.status,'completed',runner.task.reason);assert.deepEqual(runner.task.result.navigationRecovery,recovery);assert.notEqual(runner.task.result.navigationRecovery,recovery)
})

import {stepFree,MAX_CLIMB} from '../src/route-recovery.js'
test('a wedged bot steps toward an open neighbour before waiting on terrain, then retries at once',async()=>{
 const f=fixture();f.bot.entity.onGround=false
 f.bot.blockAt=p=>{const name=p.y<65?'stone':(p.x===1&&p.z===0)?'air':(p.y>=65&&p.x===0&&p.z===0)?'air':'stone';return {position:p,name,boundingBox:name==='air'?'empty':'block'}}
 f.bot.lookAt=async()=>{};f.bot.setControlState=(k,v)=>{if(k==='forward'&&v)f.bot.entity.position=f.bot.entity.position.offset(.6,0,0)}
 await walkWithTerrainRecovery(f.bot,f.goal,f.options)
 assert.equal(f.calls(),2);assert.equal(f.records.at(-1).status,'recovered');assert.equal(f.records.at(-1).trigger,'stepped_free')
 const g=fixture();g.bot.blockAt=()=>({name:'stone',boundingBox:'block'});g.bot.setControlState=()=>{}
 assert.equal(await stepFree(g.bot,{check(){},progress(){}}),false)
})
import {climbFree,pitExit} from '../src/route-recovery.js'
const pit=(placed=new Set(),rim=70)=>p=>{const name=placed.has(p.toString())?'cobblestone':(p.y>=rim||(p.x===0&&p.z===0&&p.y>=65))?'air':'stone';return {position:p,name,boundingBox:name==='air'?'empty':'block'}}
const carrying=(bot,count)=>{bot.inventory={items:()=>count?[{name:'cobblestone',count}]:[]};bot.registry={blocksByName:{cobblestone:{boundingBox:'block'}},blockCollisionShapes:{blocks:{cobblestone:1},shapes:{1:[[0,0,0,1,1,1]]}}}}
test('a bot at the bottom of a pit judges the first ledge, climbs with carried blocks, then retries',async()=>{
 const f=fixture();f.bot.blockAt=pit();carrying(f.bot,8)
 assert.deepEqual(pitExit(f.bot),{height:5,cell:new Vec3(1,70,0),roof:null})
 f.bot.lookAt=async()=>{};f.bot.setControlState=(k,v)=>{if(k==='forward'&&v)f.bot.entity.position=f.bot.entity.position.offset(.6,0,0)}
 const climbs=[]
 f.options.climb=async(bot,surface)=>{climbs.push(surface);bot.entity.position=new Vec3(bot.entity.position.x,surface.y,bot.entity.position.z)}
 const messages=[];f.options.progress=m=>messages.push(m)
 await walkWithTerrainRecovery(f.bot,f.goal,f.options)
 assert.deepEqual(climbs,[{x:1,y:70,z:0}]);assert.equal(f.calls(),2)
 assert.equal(f.records.at(-1).trigger,'climbed_free');assert.equal(f.records.at(-1).status,'recovered');assert.equal(f.records.at(-1).attempts,2)
 assert.ok(messages.some(m=>/Climbing 5 blocks out of a pit toward 1,70,0/.test(m)))
})
test('pit judgement refuses roofed columns, ledges beyond the climb limit and empty hands',async()=>{
 const f=fixture();carrying(f.bot,8);f.bot.setControlState=()=>{}
 f.bot.blockAt=p=>(p.x===0&&p.z===0&&(p.y===68||p.y===69))?{name:'stone',boundingBox:'block'}:pit()(p)
 assert.equal(pitExit(f.bot),null)
 f.bot.blockAt=pit(new Set(),65+MAX_CLIMB+1)
 assert.equal(pitExit(f.bot),null)
 f.bot.blockAt=pit();carrying(f.bot,3)
 const messages=[]
 assert.equal(await climbFree(f.bot,{check(){},stage(){},progress:m=>messages.push(m),climb:async()=>assert.fail('never climbs short')}),false)
 assert.match(messages.at(-1),/5 deep with 3 carried blocks/)
 f.bot.entity.onGround=false
 assert.equal(await climbFree(f.bot,{check(){},stage(){},progress(){},climb:async()=>assert.fail('never climbs airborne')}),false)
})
test('a stalled climb falls through to terrain observation and keeps the original route error',async()=>{
 const f=fixture();f.bot.blockAt=pit();carrying(f.bot,8);f.bot.setControlState=()=>{};f.bot.lookAt=async()=>{}
 f.options.climb=async()=>{throw new Error('Climb stalled at 0,67,0')}
 await assert.rejects(walkWithTerrainRecovery(f.bot,f.goal,f.options),/No path/)
 assert.equal(f.calls(),1);assert.equal(f.records.at(-1).status,'unchanged');assert.equal(f.records.at(-1).trigger,undefined)
})

test('one capped burrow ceiling with open air above is dug through on the climb; gravel, thick or wet ceilings end the column',()=>{
 const f=fixture();carrying(f.bot,8)
 const capped=(cap,over='air')=>p=>{if(p.x===0&&p.z===0&&p.y===68)return {position:p,name:cap,boundingBox:cap==='air'?'empty':'block'};if(p.x===0&&p.z===0&&p.y===69)return {position:p,name:over,boundingBox:over==='air'||over==='water'?'empty':'block'};return pit()(p)}
 f.bot.blockAt=capped('cobblestone')
 assert.deepEqual(pitExit(f.bot),{height:5,cell:new Vec3(1,70,0),roof:new Vec3(0,68,0)})
 f.bot.blockAt=capped('gravel');assert.equal(pitExit(f.bot),null)
 f.bot.blockAt=capped('cobblestone','stone');assert.equal(pitExit(f.bot),null)
 f.bot.blockAt=capped('cobblestone','water');assert.equal(pitExit(f.bot),null)
})

test("the cap over the bot's own shelter is climbed through, not read as a ceiling",()=>{
 // A hut roof and a burrow cap both sit exactly two above the feet, and climbOut
 // digs that block on the way up. Refusing to judge an exit there stranded the
 // bot inside a shelter whose side it had just opened: every self-help route was
 // blocked by its own roof and the walk home timed out in the hole.
 const f=fixture();carrying(f.bot,8)
 const overhead=(cap,over='air')=>p=>{
  if(p.x===0&&p.z===0&&p.y===67)return {position:p,name:cap,boundingBox:cap==='air'?'empty':'block'}
  if(p.x===0&&p.z===0&&p.y===68)return {position:p,name:over,boundingBox:over==='air'||over==='water'?'empty':'block'}
  return pit()(p)
 }
 f.bot.blockAt=overhead('cobblestone')
 assert.deepEqual(pitExit(f.bot),{height:5,cell:new Vec3(1,70,0),roof:new Vec3(0,67,0)})
 // Still refused when digging up is the wrong move.
 f.bot.blockAt=overhead('gravel');assert.equal(pitExit(f.bot),null,'sand and gravel fall back in')
 f.bot.blockAt=overhead('cobblestone','stone');assert.equal(pitExit(f.bot),null,'a thick roof is not a cap')
 f.bot.blockAt=overhead('cobblestone','water');assert.equal(pitExit(f.bot),null,'never dig up into water')
})

// A bot standing on the forest floor beside a spruce is not in a pit. On the
// persistent world it decided it was, pillared up on its own dirt, and spent
// 62% of a six-hour run on top of a one-wide tower it built itself.
const forest=p=>{
 const name = p.y<65 ? 'stone'
   : (p.x===1&&p.z===0&&p.y===66) ? 'spruce_leaves'
   : 'air'
 return {position:p,name,boundingBox:name==='air'?'empty':'block',shapes:name==='air'?[]:[[0,0,0,1,1,1]]}
}
test('foliage is not a pit rim: leaves have a block bounding box and are not ground',()=>{
 const f=fixture();f.bot.blockAt=forest;carrying(f.bot,8)
 // Without this, solid() sees spruce_leaves.boundingBox==='block' and offers a
 // ledge two blocks up whose floor is a leaf.
 assert.equal(pitExit(f.bot),null,'a tree beside the bot must not read as a ledge to climb onto')
})

test('a climb only succeeds if it reached ground it can walk off',async()=>{
 // Height gained was the whole receipt, so pillaring straight up on carried
 // dirt reported success while leaving the bot on a one-wide tower with air on
 // all four sides: no path out, and no quarry column either.
 const f=fixture()
 const placed=new Set()
 // a genuine stone ledge two up, so pitExit offers it
 f.bot.blockAt=p=>{
  // a real ledge: stone plateau at y=66 from x>=1, so the rim has ground beyond it
  const name = placed.has(p.toString()) ? 'dirt'
    : p.y<65 ? 'stone'
    : (p.x>=1&&p.y===66) ? 'stone'
    : 'air'
  return {position:p,name,boundingBox:name==='air'?'empty':'block',shapes:name==='air'?[]:[[0,0,0,1,1,1]]}
 }
 carrying(f.bot,8)
 const exit=pitExit(f.bot)
 assert.ok(exit,'a real stone ledge is still a rim')
 f.bot.lookAt=async()=>{};f.bot.setControlState=()=>{}
 // the climb gains the height but strands the bot on a tower: nothing walkable beside it
 const towerTop=new Vec3(0,67,0)
 const climbed=async()=>{f.bot.entity.position=towerTop.offset(.5,0,.5)
  f.bot.blockAt=p=>{const name=(p.x===0&&p.z===0&&p.y<=66)?'dirt':p.y<65?'stone':'air'
   return {position:p,name,boundingBox:name==='air'?'empty':'block',shapes:name==='air'?[]:[[0,0,0,1,1,1]]}}}
 const ok=await climbFree(f.bot,{check(){},stage(){},progress(){},climb:climbed})
 assert.equal(ok,false,'a tower with air on every side is not an escape')
})
