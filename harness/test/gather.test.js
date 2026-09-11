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
