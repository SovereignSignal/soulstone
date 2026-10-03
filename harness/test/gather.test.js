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
  blockAt:position=>({position,name:position.equals(trunk)?'spruce_log':position.y>66?'air':'grass_block'}),
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
  findBlocks:()=>Array.from({length:15},(_,i)=>here.offset(5+i,0,3)),blockAt:position=>({position,name:position.y>here.y+2?'air':'spruce_log'}),
  canDigBlock:()=>false,tool:{async equipForBlock(){}},dig:async()=>{},
  pathfinder:{setGoal(){},setMovements(){},async goto(goal){
   if(goal.y===undefined&&goal.x!==undefined&&goal.z!==undefined){walked.push([goal.x,goal.z]);here=new Vec3(goal.x,64,goal.z);bot.entity.position=here;return}
   throw Object.assign(new Error('No path'),{name:'NoPath'})
  }}}
 await assert.rejects(executeSkill(bot,{kind:'gather',goal:{item:'logs',count:1}},{check(){},progress:m=>messages.push(m),stage(){},movements:{},gatheringMovements:{}}),/no (reachable )?logs/)
 assert.ok(messages.some(m=>/Twelve unreachable logs here; looking somewhere else/.test(m)),'it announced the move: '+messages.slice(-3).join(' | '))
 assert.ok(walked.length>0,'and it actually walked somewhere new')
})

test('a forest of unreachable logs sends the bot past them, not back to them eight times',async()=>{
 // Trial 8, 23 September: the spawn forest, cut from the bottom by seven earlier
 // trials, held more floating trunks than eight rounds of twelve could skip.
 // explore() spent a leg and returned whenever any unskipped log lay within 40
 // blocks, so "looking somewhere else" fired eight times in five minutes
 // without a step taken, then reported checking "from 9 places".
 const walked=[],messages=[]
 let inventory=[]
 const near=Array.from({length:150},(_,i)=>new Vec3(-15+(i%15)*2,72,-15+Math.floor(i/15)*3))
 const far=new Vec3(60,64,0),logs=[...near,far]
 const bot={registry:{blocksByName:{spruce_log:{id:1}}},inventory:{items:()=>inventory},entity:{position:new Vec3(0,64,0)},
  findBlocks:({maxDistance,count})=>logs.filter(p=>p.distanceTo(bot.entity.position)<=maxDistance).sort((a,b)=>a.distanceTo(bot.entity.position)-b.distanceTo(bot.entity.position)).slice(0,count),
  blockAt:p=>({position:p,name:logs.some(l=>l.equals(p))?'spruce_log':p.x===60&&p.y===63&&p.z===0?'grass_block':'air'}),
  canDigBlock:b=>b.position.equals(far)&&bot.entity.position.distanceTo(far)<=6,tool:{async equipForBlock(){}},
  dig:async()=>{inventory=[{name:'spruce_log',count:1}]},
  pathfinder:{setGoal(){},setMovements(){},async goto(goal){
   if(goal.y===undefined&&Number.isFinite(goal.x)&&Number.isFinite(goal.z)){walked.push([goal.x,goal.z]);bot.entity.position=new Vec3(goal.x,64,goal.z);return}
   // Only the grounded trunk can be approached; every floating one refuses.
   if(goal.pos?.equals?.(far)){bot.entity.position=new Vec3(58,64,0);return}
   throw Object.assign(new Error('No path'),{name:'NoPath'})
  }}}
 const result=await executeSkill(bot,{kind:'gather',goal:{item:'logs',count:1}},{check(){},progress:m=>messages.push(m),stage(){},movements:{},gatheringMovements:{}})
 assert.equal(result.count,1,messages.slice(-4).join(' | '))
 assert.ok(walked.length>0&&walked.length<8,'it walked away from the unreachable cluster: '+JSON.stringify(walked))
})

test('a log the bot cannot reach says what the pathfinder and the server were doing',async()=>{
 // Trial 11: 36 minutes in five failed gathers, each about 36 "Cannot reach
 // that log" of fifteen seconds. gather has its own walk, so the stuck-leg
 // report never covered the stage that cost the most.
 const messages=[],handlers={}
 let inventory=[]
 const near=new Vec3(3,64,0),other=new Vec3(-3,64,0)
 const bot={registry:{blocksByName:{spruce_log:{id:1}}},inventory:{items:()=>inventory},entity:{position:new Vec3(0,64,0),onGround:false,velocity:new Vec3(0,0,0)},
  on:(e,f)=>{(handlers[e]||=[]).push(f)},off:(e,f)=>{handlers[e]=(handlers[e]||[]).filter(g=>g!==f)},
  findBlocks:()=>[near,other],blockAt:p=>({position:p,name:p.equals(near)||p.equals(other)?'spruce_log':p.y<64?'grass_block':'air',boundingBox:p.y<64||p.equals(near)||p.equals(other)?'block':'empty'}),
  canDigBlock:b=>b.position.equals(other),tool:{async equipForBlock(){}},dig:async()=>{inventory=[{name:'spruce_log',count:1}]},
  pathfinder:{setGoal(){},setMovements(){},async goto(goal){
   if(goal.pos?.equals?.(near)){for(let i=0;i<3;i++)(handlers.forcedMove||[]).forEach(f=>f());throw Object.assign(new Error('No path to the goal!'),{name:'NoPath'})}
  }}}
 const result=await executeSkill(bot,{kind:'gather',goal:{item:'logs',count:1}},{check(){},progress:m=>messages.push(m),stage(){},movements:{},gatheringMovements:{}})
 assert.equal(result.count,1)
 const line=messages.find(m=>/Cannot reach that log/.test(m))
 assert.ok(line,messages.join(' | '))
 assert.match(line,/server corrections 3/)
})

test('a log with no walking route is dug toward, within the saved footprints, before it is skipped',async()=>{
 // Trial 15, 24 September: 27 logs failed "No path to the goal!" on a 1-step
 // plan from inside the agent's own quarry pit. The gathering profile may break
 // only logs and leaves, so from a stone pit no tree is reachable; 11.7 minutes
 // went there before two manual digs let gather take five logs in 99 seconds.
 const messages=[],profiles=[]
 let inventory=[]
 const log=new Vec3(6,64,0)
 const registry=(await import('prismarine-registry')).default('1.21.4')
 const bot={registry,inventory:{items:()=>inventory},entity:{position:new Vec3(0,64,0),onGround:true,velocity:new Vec3(0,0,0)},
  on(){},off(){},findBlocks:()=>[log],world:{getBlock:p=>bot.blockAt(p)},
  blockAt:p=>({position:p,name:p.equals(log)?'spruce_log':p.y<64?'stone':'air',boundingBox:p.equals(log)||p.y<64?'block':'empty'}),
  canDigBlock:b=>b.position.equals(log)&&bot.entity.position.distanceTo(log)<=4,tool:{async equipForBlock(){}},dig:async()=>{inventory=[{name:'spruce_log',count:1}]},clearControlStates(){},
  pathfinder:{setGoal(){},setMovements(m){profiles.push(m)},async goto(goal){
   if(goal.pos)throw Object.assign(new Error('No path to the goal!'),{name:'NoPath'})
   bot.entity.position=new Vec3(4,64,0)
  }}}
 const protectedSites=[{minX:20,maxX:24,minZ:-2,maxZ:2}]
 const result=await executeSkill(bot,{kind:'gather',goal:{item:'logs',count:1,protectedSites}},{check(){},progress:m=>messages.push(m),stage(){},movements:{},gatheringMovements:{tag:'gathering'}})
 assert.equal(result.count,1,messages.join(' | '))
 assert.ok(messages.some(m=>/digging toward it/.test(m)),messages.join(' | '))
 const dig=profiles.find(m=>m?.canDig===true&&m.exclusionBreak)
 assert.ok(dig,'the fallback walk used the dig-capable profile')
 assert.ok(dig.exclusionBreak({name:'stone',boundingBox:'block',position:new Vec3(22,64,0),diggable:true})>=100,'never inside a saved footprint')
 assert.equal(profiles[profiles.indexOf(dig)+1]?.tag,'gathering','the gathering profile is restored right after the dig walk')
})

test('a gather goal carries saved footprints through the task store and rejects a malformed one',async()=>{
 const {validateTaskGoal}=await import('../src/task-store.js')
 const sites=[{minX:1,maxX:2,minZ:3,maxZ:4}]
 assert.deepEqual(validateTaskGoal('gather',{item:'logs',count:3,protectedSites:sites}),{item:'logs',count:3,protectedSites:sites})
 assert.deepEqual(validateTaskGoal('gather',{item:'logs',count:3}),{item:'logs',count:3})
 assert.throws(()=>validateTaskGoal('gather',{item:'logs',count:3,protectedSites:[{minX:5,maxX:1,minZ:0,maxZ:1}]}),/rectangle/)
})

test('a bot that cannot walk stops exploring and says so, instead of blaming the world',async()=>{
 // Eight legs against a wall cost seconds and zero displacement, then reported
 // "no logs within 48 blocks ... move me near trees" while a trunk stood 91
 // blocks away in plain sight. The blocker is navigation, and it should say so.
 const walked=[]
 const bot={registry:{blocksByName:{spruce_log:{id:1}}},inventory:{items:()=>[]},entity:{position:new Vec3(0,64,0)},findBlocks:()=>[],blockAt:()=>null,
  pathfinder:{setGoal(){},setMovements(){},async goto(goal){walked.push([goal.x,goal.z]);throw Object.assign(new Error('No path'),{name:'NoPath'})}},
  canDigBlock:()=>true,tool:{async equipForBlock(){}},dig:async()=>{}}
 await assert.rejects(executeSkill(bot,{kind:'gather',goal:{item:'logs',count:1}},{check(){},progress(){},stage(){},movements:{}}),
  /no logs within 48 blocks after exploring 3 legs from the start: no route toward/)
 assert.equal(walked.length,3,'it gave up after three legs that moved it nowhere')
})
test('under solid rock a search for logs fails at once and says why',async()=>{
 // Lab runs 32 and 33, 3 October: from the foot of the back exit a pickaxe
 // preparation explored eight legs for logs through stone, five minutes a time.
 const walked=[]
 const bot={registry:{blocksByName:{spruce_log:{id:1}}},inventory:{items:()=>[]},entity:{position:new Vec3(0,40,0)},findBlocks:()=>[],blockAt:p=>({position:p,name:p.y===40||p.y===41?'air':'stone'}),
  pathfinder:{setGoal(){},setMovements(){},async goto(goal){walked.push([goal.x,goal.z])}},canDigBlock:()=>true,tool:{async equipForBlock(){}},dig:async()=>{}}
 const started=Date.now()
 await assert.rejects(executeSkill(bot,{kind:'gather',goal:{item:'logs',count:1}},{check(){},progress(){},stage(){},movements:{}}),/underground.*surface/)
 assert.deepEqual(walked,[],'not one exploring leg');assert.ok(Date.now()-started<5000,'the collector\'s own three-second scan, then the answer')
})
