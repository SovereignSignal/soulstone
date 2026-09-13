import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {executeSkill} from '../src/skills.js'
const pause=ms=>new Promise(r=>setTimeout(r,ms))
function fixture(collect) {
 let inventory=[];const positions=[new Vec3(1,64,1),new Vec3(2,64,1)]
 const bot={registry:{blocksByName:{spruce_log:{id:1}}},inventory:{items:()=>inventory},
 findBlocks:()=>positions,blockAt:position=>({position,name:'spruce_log'}),
 pathfinder:{setGoal(){},setMovements(){},async goto(){}},canDigBlock:()=>true,tool:{async equipForBlock(){}},dig:async block=>collect(block,items=>inventory=items)}
 return bot
}
test('collection re-observes inventory after a pickup path timeout',async()=>{
 let calls=0
 const bot=fixture(async(block,set)=>{calls++;set([{name:'spruce_log',count:1}]);throw Object.assign(new Error('path timeout'),{name:'Timeout'})})
 const result=await executeSkill(bot,{kind:'gather',goal:{item:'logs',count:1}},{check(){},progress(){},stage(){},movements:{}})
 assert.equal(result.count,1);assert.equal(calls,1)
})
test('an unreachable log is skipped without replaying it or cancelling the job',async()=>{
 const targets=[]
 const bot=fixture(async(block,set)=>{targets.push(block.position.x);if(block.position.x===1)throw Object.assign(new Error('blocked'),{name:'NoPath'});set([{name:'spruce_log',count:1}])})
 await executeSkill(bot,{kind:'gather',goal:{item:'logs',count:1}},{check(){},progress(){},stage(){},movements:{}})
 assert.deepEqual(targets,[1,2])
})
test('stop during collection prevents retrying another target',async()=>{
 let stopped=false,calls=0
 const bot=fixture(async()=>{calls++;await pause(1);stopped=true;throw Object.assign(new Error('blocked'),{name:'NoPath'})})
 await assert.rejects(executeSkill(bot,{kind:'gather',goal:{item:'logs',count:1}},{check(){if(stopped)throw new Error('cancelled')},progress(){},stage(){},movements:{}}),/cancelled/)
 assert.equal(calls,1)
})

test('grounded trunks outrank nearby floating remnants and failed columns are skipped together',async()=>{
 const {gatherCandidates}=await import('../src/resources.js')
 const positions=[...Array.from({length:12},(_,i)=>new Vec3(1,70+i,1)),new Vec3(12,65,1)]
 const bot={entity:{position:new Vec3(0,65,0)},blockAt:p=>({position:p,name:p.x===12&&p.y===64?'grass_block':'spruce_log'})}
 const candidates=gatherCandidates(bot,positions)
 assert.equal(candidates.length,2);assert.equal(candidates[0].position.x,12)
 assert.deepEqual(gatherCandidates(bot,positions,{skippedColumns:new Set(['1,1'])}).map(b=>b.position.x),[12])
})

test('gathering walks toward a trunk sighted beyond the collection radius before giving up',async()=>{
 let inventory=[],walked=[],messages=[]
 const trunk=new Vec3(90,64,0)
 const bot={registry:{blocksByName:{spruce_log:{id:1}}},inventory:{items:()=>inventory},entity:{position:new Vec3(0,64,0)},
  findBlocks:({maxDistance})=>bot.entity.position.distanceTo(trunk)<=maxDistance?[trunk]:[],
  blockAt:position=>({position,name:position.equals(trunk)?'spruce_log':'grass_block'}),
  pathfinder:{setGoal(){},setMovements(){},async goto(goal){walked.push([goal.x,goal.z]);bot.entity.position=new Vec3(goal.x,64,goal.z)}},
  canDigBlock:()=>true,tool:{async equipForBlock(){}},dig:async()=>{inventory=[{name:'spruce_log',count:1}]}}
 const result=await executeSkill(bot,{kind:'gather',goal:{item:'logs',count:1}},{check(){},progress:m=>messages.push(m),stage(){},movements:{}})
 assert.equal(result.count,1)
 assert.deepEqual(walked[0],[32,0])
 assert.ok(messages.some(m=>/sighted 90 blocks away/.test(m)),messages.join(' | '))
})
test('exploration for trunks is bounded and ends with an explicit blocker',async()=>{
 const walked=[]
 const bot={registry:{blocksByName:{spruce_log:{id:1}}},inventory:{items:()=>[]},entity:{position:new Vec3(0,64,0)},findBlocks:()=>[],blockAt:()=>null,
  pathfinder:{setGoal(){},setMovements(){},async goto(goal){walked.push([goal.x,goal.z]);bot.entity.position=new Vec3(goal.x,64,goal.z)}},canDigBlock:()=>true,tool:{async equipForBlock(){}},dig:async()=>{}}
 await assert.rejects(executeSkill(bot,{kind:'gather',goal:{item:'logs',count:1}},{check(){},progress(){},stage(){},movements:{}}),/no logs within 48 blocks after exploring 8 legs/)
 assert.deepEqual(walked,[[32,0],[0,32],[-32,0],[0,-32],[64,0],[0,64],[-64,0],[0,-64]])
})
test('twelve unreachable trunks send the bot somewhere else instead of ending the job',async()=>{
 const walked=[],messages=[]
 let here=new Vec3(0,64,0)
 // Fifteen distinct trunks are always in view and none can be reached.
 const bot={registry:{blocksByName:{spruce_log:{id:1}}},inventory:{items:()=>[]},entity:{position:here},
  findBlocks:()=>Array.from({length:15},(_,i)=>here.offset(5+i,0,3)),blockAt:position=>({position,name:'spruce_log'}),
  canDigBlock:()=>false,tool:{async equipForBlock(){}},dig:async()=>{},
  pathfinder:{setGoal(){},setMovements(){},async goto(goal){
   if(goal.y===undefined&&goal.x!==undefined&&goal.z!==undefined){walked.push([goal.x,goal.z]);here=new Vec3(goal.x,64,goal.z);bot.entity.position=here;return}
   throw Object.assign(new Error('No path'),{name:'NoPath'})
  }}}
 await assert.rejects(executeSkill(bot,{kind:'gather',goal:{item:'logs',count:1}},{check(){},progress:m=>messages.push(m),stage(){},movements:{},gatheringMovements:{}}),/no (reachable )?logs/)
 assert.ok(messages.some(m=>/Twelve unreachable logs here; looking somewhere else/.test(m)),'it announced the move: '+messages.slice(-3).join(' | '))
 assert.ok(walked.length>0,'and it actually walked somewhere new')
})
