import test from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {harvestBerries} from '../src/foraging.js'
import {emergencyReason} from '../src/survival.js'
import {validateTaskGoal} from '../src/task-store.js'
import {validatePlan} from '../src/companion/planner.js'
import {Runner} from '../src/runner.js'

test('harvest routes through planner and runner without requiring a base',()=>{
 const goal={item:'sweet_berries',count:8};assert.deepEqual(validateTaskGoal('harvest',goal),goal)
 assert.equal(validatePlan({reply:'Harvesting.',steps:[{action:'harvest',...goal,name:'',design:[]}]}).steps[0].action,'harvest')
 const calls=[];Runner.prototype.command.call({emit(){},skill:(...a)=>calls.push(a)},{action:'harvest',goal});assert.equal(calls[0][0],'harvest')
 assert.throws(()=>validateTaskGoal('harvest',{...goal,count:100}),/1–32/)
})
test('berry harvest handles string age states, preserves bush and verifies pickup',async()=>{
 const p=new Vec3(0,64,0);let age='3',stock=0,activated=0,approached=false
 const bot={registry:{blocksByName:{sweet_berry_bush:{id:1}}},entity:{position:new Vec3(2,64,0)},world:{},inventory:{items:()=>[{name:'sweet_berries',count:stock}]},findBlocks:()=>[p],blockAt:q=>q.equals(p)?{name:'sweet_berry_bush',position:q,getProperties:()=>({age})}:{name:q.y===63?'dirt':'air',boundingBox:q.y===63?'block':'empty',shapes:q.y===63?[[0,0,0,1,1,1]]:[],position:q},unequip:async()=>{},activateBlock:async()=>{activated++;age='1'},waitForTicks:async()=>{stock=3}}
 bot.world.getBlock=bot.blockAt;bot.world.raycast=()=>null
 const task={goal:{item:'sweet_berries',count:3}}
 const result=await harvestBerries(bot,task,{check(){},walk:async goal=>{if(!approached){assert.ok(goal.isEnd(new Vec3(2,64,0)),'Non-colliding berry approach must have a reachable end');approached=true}},settle:async fn=>assert.ok(fn()),progress(){},stage(){},persist(){}})
 assert.equal(result.count,3);assert.equal(activated,1);assert.equal(age,'1');assert.equal(task.harvested.length,1)
})
test('unripe bushes are never activated or destroyed',async()=>{
 const bot={registry:{blocksByName:{sweet_berry_bush:{id:1}}},inventory:{items:()=>[]},findBlocks:()=>[new Vec3(0,64,0)],blockAt:()=>({getProperties:()=>({age:'1'})})}
 await assert.rejects(harvestBerries(bot,{goal:{item:'sweet_berries',count:3}},{check(){}}),/No more ripe/)
})
test('emergency thresholds exclude neutral mobs and Peaceful proximity, preserve health emergencies',()=>{
 const o={health:20,food:20,gameMode:'survival',difficulty:'peaceful',nearbyThreats:[{risk:'potential_hostile',distance:2}]}
 assert.equal(emergencyReason(o),null);assert.match(emergencyReason({...o,difficulty:'easy'}),/hostile/)
 assert.equal(emergencyReason({...o,difficulty:'easy',nearbyThreats:[{risk:'conditional',distance:1}]}),null)
 assert.match(emergencyReason({...o,health:9,shelterAvailable:true}),/Health/);assert.equal(emergencyReason({...o,health:9}),null)
 assert.match(emergencyReason({...o,food:6,carriedFood:[{name:'bread',count:1}]}),/Food/);assert.equal(emergencyReason({...o,food:6}),null)
 assert.equal(emergencyReason({...o,health:0}),null);assert.equal(emergencyReason({...o,health:1,gameMode:'creative'}),null)
})

import {retreatToShelter} from '../src/retreat.js'
import {evaluateGoal} from '../src/companion/goal-contract.js'
test('retreat verifies shell and light then enters and closes the door without repairs',async()=>{
 const o=new Vec3(0,64,0),design=[],world=new Map(),key=p=>p.toString();let open=false
 for(let x=0;x<=3;x++)for(let z=0;z<=3;z++)for(let y=0;y<=3;y++)if(y===3||((x===0||x===3||z===0||z===3)&&!(x===1&&z===0&&y<2))){design.push({x,y,z,block:'wood_planks'});world.set(key(o.offset(x,y,z)),{name:'spruce_planks',boundingBox:'block'})}
 world.set(key(o.offset(2,0,-3)),{name:'stone_bricks',boundingBox:'block'})
 const door=o.offset(1,0,0);world.set(key(o.offset(1,0,2)),{name:'torch',boundingBox:'empty'})
 const bot={registry:{blocksByName:{torch:{emitLight:14}}},entity:{position:o.offset(1.5,0,-1.5),onGround:true},world:{},blockAt:p=>{if(p.x===1&&p.z===0&&[64,65].includes(p.y))return {name:'spruce_door',position:p,boundingBox:'block',shapes:[[0,0,0,1,1,.2]],getProperties:()=>({open,half:p.y===64?'lower':'upper'})};return {...(world.get(key(p))||{name:p.y===63?'dirt':'air',boundingBox:p.y===63?'block':'empty'}),position:p,shapes:[]}},unequip:async()=>{},activateBlock:async()=>{open=!open}}
 bot.world.getBlock=bot.blockAt
 const task={goal:{project:{build:{origin:o,design,wood:'spruce_log'},stations:{torch:{position:o.offset(1,0,2)}}}}}
 const api={check(){},progress(){},settle:async fn=>assert.ok(fn()),walk:async g=>{if(Number.isFinite(g.x)&&Number.isFinite(g.y)&&Number.isFinite(g.z))bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5);else bot.entity.position=o.offset(1.5,0,-.5)}}
 const result=await retreatToShelter(bot,task,api);assert.equal(result.receipt,'sheltered_door_closed');assert.equal(open,false);assert.deepEqual(bot.entity.position,new Vec3(1.5,64,1.5))
 const contract={criteria:[{kind:'sheltered',target:'base',count:1,description:'Inside lit base'}]},snapshot={projects:{base:task.goal.project}},feedback=[{action:'retreat',status:'completed',result}]
 assert.equal(evaluateGoal(contract,snapshot,bot,feedback).checks[0].passed,true);assert.equal(evaluateGoal(contract,snapshot,bot,[]).checks[0].passed,false)
 bot.entities={99:{name:'husk',position:o.offset(1.5,0,2.5)}}
 assert.equal(evaluateGoal(contract,snapshot,bot,feedback).checks[0].passed,false)
 await assert.rejects(retreatToShelter(bot,task,api),/contains a potential hostile/)
 bot.entities={}
 bot.entity.position=o.offset(1.5,0,-.5);assert.equal(evaluateGoal(contract,snapshot,bot,feedback).checks[0].passed,false);bot.entity.position=o.offset(1.5,0,1.5)
 world.set(key(o.offset(1,0,-1)),{name:'stone_bricks',boundingBox:'block'});await assert.rejects(retreatToShelter(bot,task,api),/access obstructed/);world.delete(key(o.offset(1,0,-1)))
 world.delete(key(o.offset(0,3,0)));await assert.rejects(retreatToShelter(bot,task,api),/structure is missing/)
})

import {LocalPlanner} from '../src/companion/planner.js'
test('goal formulation receives harvesting and retreat capability descriptions',async()=>{
 const planner=new LocalPlanner({model:'test'}),seen=[];planner.structured=async messages=>{seen.push(messages[0].content);throw new Error('captured')}
 await assert.rejects(planner.formulate('Harvest berries',{},[],new AbortController().signal),/captured/)
 assert.ok(seen[0].includes('Action harvest'));assert.ok(seen[0].includes('Action leave_base'))
})

test('harvesting follows newly dropped berries down a step while preserving the bush',async()=>{
 const p=new Vec3(0,64,0);let age='3',stock=0,reachedDrop=false
 const bot={entities:{},registry:{blocksByName:{sweet_berry_bush:{id:1}}},entity:{position:new Vec3(2,64,0)},inventory:{items:()=>[{name:'sweet_berries',count:stock}]},findBlocks:()=>[p],blockAt:q=>q.equals(p)?{name:'sweet_berry_bush',getProperties:()=>({age})}:{name:q.x===2&&q.y===63?'air':q.y===62||q.y===63?'dirt':'air',boundingBox:q.x===2&&q.y===63?'empty':q.y===62||q.y===63?'block':'empty'},unequip:async()=>{},activateBlock:async()=>{age='1';bot.entities[22]={id:22,position:new Vec3(2.5,63.1,.5),getDroppedItem:()=>({name:'sweet_berries'})}},waitForTicks:async()=>{}}
 const result=await harvestBerries(bot,{goal:{item:'sweet_berries',count:3}},{check(){},progress(){},stage(){},persist(){},settle:async fn=>assert.ok(fn()),walk:async g=>{if(g.y===63&&g.x===2){reachedDrop=true;stock=3}}})
 assert.ok(reachedDrop);assert.equal(result.count,3);assert.equal(age,'1')
})

import {shelterLayout,shelterAccessLayout,inspectShelterSite} from '../src/shelter.js'
test('occupied-base checks share the narrow real approach while construction retains its wider clearance',()=>{
 const design=[]
 for(let x=0;x<=3;x++)for(let z=0;z<=3;z++)for(let y=0;y<=2;y++)if(y===2||((x===0||x===3||z===0||z===3)&&!(x===1&&z===0&&y<2)))design.push({x,y,z,block:'wood_planks'})
 const layout=shelterLayout(design),o=new Vec3(0,64,0),neighbor=new Vec3(2,64,-3)
 const bot={blockAt:p=>({position:p,name:p.equals(neighbor)?'stone_bricks':p.y===63?'dirt':'air',boundingBox:p.y===63?'block':'empty'})}
 assert.throws(()=>inspectShelterSite(bot,o,layout),/access obstructed/)
 assert.doesNotThrow(()=>inspectShelterSite(bot,o,shelterAccessLayout(layout)))
 assert.equal(layout.approach.length,9);assert.equal(shelterAccessLayout(layout).approach.length,2)
})
