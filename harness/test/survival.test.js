import test from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {eatFood,survivalObservation} from '../src/survival.js'
import {validateTaskGoal} from '../src/task-store.js'
import {validatePlan} from '../src/companion/planner.js'
import {interruptedEffect} from '../src/companion/continuity.js'
import {parseBuildingBlock,validateBuildingBlock,placeBuildingBlock,setPlacementSneaking} from '../src/building-blocks.js'
import {compileArchitecture,reviewArchitecture} from '../src/construction.js'
function fixture(){
 let count=3;const bot={food:14,game:{gameMode:'survival'},inventory:{items:()=>count?[{name:'bread',count}]:[]},equip:async()=>{},consume:async()=>{count--;bot.food=Math.min(20,bot.food+5)},deactivateItem(){}}
 return {bot,task:{goal:{item:'bread',count:3}},api:{check(){},stage(){},progress(){},persist(){}}}
}
test('eating caps at full hunger with both hunger and inventory receipts',async()=>{
 const {bot,task,api}=fixture();const result=await eatFood(bot,task,api)
 assert.equal(result.count,2);assert.equal(bot.inventory.items()[0].count,1);assert.equal(bot.food,20);assert.equal(task.consumption.uncertain,false)
 assert.equal((await eatFood(bot,{goal:task.goal},api)).receipt,'hunger_already_full')
})
test('eating rejects unsafe foods and survives task/planner validation',()=>{
 const step={action:'eat',item:'bread',count:1,name:'',design:[]}
 assert.equal(validatePlan({reply:'Eating bread.',steps:[step]}).steps[0].action,'eat')
 assert.deepEqual(validateTaskGoal('eat',step),{item:'bread',count:1})
 for(const item of ['rotten_flesh','pufferfish','chorus_fruit','golden_apple','suspicious_stew'])assert.throws(()=>validateTaskGoal('eat',{item,count:1}),/safe food/)
})
test('interrupted eating remains uncertain and releases item use without retries',async()=>{
 const {bot,task,api}=fixture();let released=false,calls=0
 bot.deactivateItem=()=>released=true;bot.consume=async()=>{calls++;throw new Error('disconnected')}
 await assert.rejects(eatFood(bot,task,api),/disconnected/)
 assert.equal(calls,1);assert.equal(released,true);assert.match(interruptedEffect(task),/eating/)
})
test('eating does not accept hunger increase without consumed inventory',async()=>{
 const {bot,task,api}=fixture();bot.consume=async()=>{bot.food=20}
 await assert.rejects(eatFood(bot,task,api),/not confirmed/)
 assert.equal(task.consumption.uncertain,true)
})
test('survival observations distinguish unknown state and bounded conditional threats',()=>{
 assert.equal(survivalObservation(null).food,null)
 const bot={entity:{position:new Vec3(0,64,0)},entities:{1:{name:'creeper',position:new Vec3(3,64,0)},2:{name:'wolf',position:new Vec3(2,64,0)},3:{name:'zombie',position:new Vec3(30,64,0)}},inventory:{items:()=>[{name:'bread',count:2},{name:'rotten_flesh',count:3}]}}
 const o=survivalObservation(bot);assert.deepEqual(o.nearbyThreats.map(e=>e.name),['wolf','creeper']);assert.equal(o.nearbyThreats[0].risk,'conditional');assert.deepEqual(o.carriedFood,[{name:'bread',count:2}])
})
test('torch cannot act as a structural floor in architecture review',()=>{
 const r=(x,y,z,block)=>({x,y,z,x2:x,y2:y,z2:z,block})
 const blueprint=compileArchitecture([r(0,0,0,'stone'),r(1,0,0,'torch'),r(0,1,0,'checkpoint'),r(1,1,0,'checkpoint')])
 assert.deepEqual(reviewArchitecture(blueprint).unreachable,[new Vec3(1,1,0)])
 assert.deepEqual(parseBuildingBlock('torch'),{block:'torch'})
 assert.throws(()=>parseBuildingBlock('torch[facing=north]'),/no configurable/)
 assert.throws(()=>validateBuildingBlock({blocksByName:{},itemsByName:{}},{block:'torch'},()=>false),/Unsupported/)
})
test('torch placement uses top face with sneak and restores controls on failure',async()=>{
 const controls=[],p=new Vec3(0,1,0),bot={blockAt:p=>({name:p.y===1?'air':'barrel'}),world:{getBlock:()=>({shapes:[[0,0,0,1,1,1]]})},inventory:{items:()=>[{name:'torch',count:1}]},equip:async()=>{},setControlState:(k,v)=>controls.push([k,v]),waitForTicks:async()=>{},placeBlock:async(_,face)=>{assert.deepEqual(face,new Vec3(0,1,0));throw new Error('placement failed')}}
 await assert.rejects(placeBuildingBlock(bot,p,{block:'torch'},{check(){},stage(){},approach:async()=>({ref:p.offset(0,-1,0)})}),/placement failed/)
 assert.deepEqual(controls,[['sneak',true],['sneak',false]])
})

test('transitional sneak protocol sends both inputs and legacy actions only where needed',()=>{
 for(const [input,mapped,expected] of [[true,false,2],[true,true,0],[false,false,0]]){
  const packets=[],controls=[],bot={entity:{id:42},setControlState:(k,v)=>controls.push(v),supportFeature:n=>n==='newPlayerInputPacket'?input:mapped,_client:{write:(name,p)=>packets.push({name,...p})}}
  setPlacementSneaking(bot,true);setPlacementSneaking(bot,false)
  assert.deepEqual(controls,[true,false]);assert.equal(packets.length,expected)
  if(expected)assert.deepEqual(packets.map(p=>p.actionId),[0,1])
 }
})

import {Runner} from '../src/runner.js'
test('runner dispatches eat to its own durable skill, not give',()=>{
 const calls=[],runner={closed:false,emit(){},skill:(...args)=>calls.push(args)}
 Runner.prototype.command.call(runner,{action:'eat',goal:{item:'bread',count:1},timeoutMs:10000})
 assert.deepEqual(calls,[['eat',{item:'bread',count:1},10000]])
})

test('resumed eating retains its original portion cap and refuses uncertain replay',async()=>{
 const {bot,task,api}=fixture();task.goal.count=1
 await eatFood(bot,task,api);assert.equal(bot.food,19)
 const resumed=await eatFood(bot,task,api);assert.equal(resumed.count,1);assert.equal(bot.inventory.items()[0].count,2)
 task.consumption.uncertain=true
 await assert.rejects(eatFood(bot,task,api),/Previous consumption is uncertain/)
})
