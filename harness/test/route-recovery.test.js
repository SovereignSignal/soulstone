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
