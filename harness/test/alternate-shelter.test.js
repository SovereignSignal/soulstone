import test from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {compileArchitecture} from '../src/construction.js'
import {inspectConstructionShelter,retreatToConstruction,alternativeShelters,occupiedAlternative} from '../src/alternate-shelter.js'
import {validateTaskGoal} from '../src/task-store.js'
import {assertNoHostileOccupants} from '../src/shelter-occupants.js'
const registry=minecraftData('1.21.4')
function fixture(){
 const design=[{x:0,y:0,z:0,x2:4,y2:3,z2:4,block:'stone_bricks'},{x:1,y:1,z:1,x2:3,y2:2,z2:3,block:'air'},{x:2,y:1,z:0,x2:2,y2:2,z2:0,block:'air'},{x:2,y:1,z:0,block:'oak_door[facing=north]'},{x:2,y:3,z:2,block:'glowstone'},{x:2,y:1,z:1,block:'checkpoint'},{x:2,y:1,z:-1,block:'checkpoint'}]
 const shelter={name:'refuge',construction:{origin:{x:0,y:64,z:0},design}},world=new Map()
 for(const b of compileArchitecture(design).cells)world.set(new Vec3(b.x,64+b.y,b.z).toString(),{name:b.block,properties:b.properties})
 let opened=false
 const bot={registry,entities:{},entity:{position:new Vec3(2.5,65,-1.5),onGround:true},blockAt(p){const b=world.get(p.toString())||{name:p.y===64?'stone':'air'};return {name:b.name,position:p,boundingBox:registry.blocksByName[b.name]?.boundingBox,shapes:[],getProperties:()=>({...b.properties,...(b.name==='oak_door'?{open:opened}:{})})}},unequip:async()=>{},activateBlock:async()=>{opened=!opened}}
 const api={check(){},progress(){},walk:async g=>{bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)},settle:async f=>assert.ok(f())}
 return {bot,shelter,world,api,doorOpen:()=>opened}
}
test('saved enclosed lit room can be entered and exited without replacing the base',async()=>{
 const {bot,shelter,api,doorOpen}=fixture(),projects={refuge:{status:'completed',result:{partial:false},construction:shelter.construction}}
 assert.equal(alternativeShelters(bot,projects)[0].name,'refuge')
 assert.equal(occupiedAlternative(bot,projects),null)
 const result=await retreatToConstruction(bot,{kind:'retreat',goal:{shelter}},api)
 assert.equal(result.shelterName,'refuge');assert.equal(result.receipt,'sheltered_door_closed');assert.equal(doorOpen(),false)
 assert.equal(occupiedAlternative(bot,projects).name,'refuge')
 await retreatToConstruction(bot,{kind:'leave_base',goal:{shelter}},api)
 assert.equal(occupiedAlternative(bot,projects),null);assert.equal(doorOpen(),false)
 assert.equal(validateTaskGoal('retreat',{shelter}).shelter.name,'refuge')
 assert.throws(()=>validateTaskGoal('retreat',{shelter,project:{}}),/ambiguous/)
})
test('missing roof, darkness and blocked entrance reject fallback before walking',()=>{
 for(const [p,name] of [[new Vec3(1,67,1),'air'],[new Vec3(2,67,2),'stone_bricks'],[new Vec3(2,65,-1),'stone']]){
  const {bot,shelter,world}=fixture();world.set(p.toString(),{name});assert.throws(()=>inspectConstructionShelter(bot,shelter))
 }
})
test('hostile occupants use all loaded entities and reject a late arrival after entry',async()=>{
 const {bot,shelter,api}=fixture();bot.entities[99]={name:'husk',position:new Vec3(2.5,65,2.5),width:.6,height:1.95}
 assert.throws(()=>inspectConstructionShelter(bot,shelter),/contains a potential hostile/)
 delete bot.entities[99]
 const walk=api.walk;api.walk=async g=>{await walk(g);bot.entities[99]={name:'husk',position:new Vec3(1.5,65,1.5)}}
 await assert.rejects(retreatToConstruction(bot,{kind:'retreat',goal:{shelter}},api),/contains a potential hostile/)
})
test('mob overlapping doorway is rejected, outside mob and neutral animal are not',()=>{
 const cells=[new Vec3(0,64,0)],bot={entities:{1:{name:'husk',position:new Vec3(-.1,64,.5),width:.6}}}
 assert.throws(()=>assertNoHostileOccupants(bot,cells),/hostile/)
 bot.entities[1].position.x=-1;assert.doesNotThrow(()=>assertNoHostileOccupants(bot,cells))
 bot.entities[1]={name:'cow',position:new Vec3(.5,64,.5)};assert.doesNotThrow(()=>assertNoHostileOccupants(bot,cells))
})

import {EventEmitter} from 'node:events'
import {Teammate} from '../src/companion/controller.js'
test('executor leaves an occupied fallback before gathering even if the model omits leave_base',async()=>{
 const {bot,shelter}=fixture();bot.entity.position=new Vec3(2.5,65,1.5)
 const runner=new EventEmitter();runner.bot=bot;const calls=[]
 const c={runner,projects:{refuge:{status:'completed',result:{partial:false},construction:shelter.construction}},requestProgress:{status:'running',feedback:[],completed:[]},persist(){},execute:Teammate.prototype.execute,leaveOccupiedShelter:Teammate.prototype.leaveOccupiedShelter,dispatch(cmd){
  calls.push(cmd);runner.task={id:String(calls.length),status:'completed',result:cmd.action==='leave_base'?{receipt:'left_base_door_closed',shelterName:'refuge'}:{count:30}}
  if(cmd.action==='leave_base')bot.entity.position=new Vec3(2.5,65,-.5)
  queueMicrotask(()=>runner.emit('event',{type:'task_finished',task:runner.task}))
 }}
 await c.execute({action:'gather',goal:{item:'spruce_log',count:30}},new AbortController().signal)
 assert.deepEqual(calls.map(c=>c.action),['leave_base','gather'])
 assert.equal(c.requestProgress.feedback[0].automatic,true);assert.equal(c.requestProgress.feedback[0].result.shelterName,'refuge')
})

test('matching blueprints still fail for an open roof or insufficient light',()=>{
 for(const [block,reason] of [['air',/enclosed/],['stone_bricks',/lighting/]]){
  const {bot,shelter,world}=fixture()
  const p=block==='air'?new Vec3(1,67,1):new Vec3(2,67,2)
  shelter.construction.design.push({x:p.x,y:p.y-64,z:p.z,block})
  world.set(p.toString(),{name:block})
  assert.throws(()=>inspectConstructionShelter(bot,shelter),reason)
 }
})

import {currentRequestTask} from '../src/companion/progress.js'
test('fresh requests do not inherit a prior failed base check, while construction remains resumable',()=>{
 const failed={id:'old',kind:'check_base',status:'failed',reason:'old obstruction'}
 assert.equal(currentRequestTask(failed,new Set()),null)
 assert.equal(currentRequestTask(failed,new Set(['old'])),failed)
 const build={...failed,kind:'construct'};assert.equal(currentRequestTask(build,new Set()),build)
 assert.equal(currentRequestTask({...build,status:'completed'},new Set()),null)
})
