import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {EventEmitter} from 'node:events'
import {DayRoutine,daytimeWork,morningGoal,morningOutcome,extendedRecoveryEligible} from '../src/companion/day-routine.js'
const observation=()=>({inventory:{spruce_log:32,spruce_planks:83,sweet_berries:32},survival:{food:20},tools:[{name:'stone_axe',remaining:80,maximum:131}]})
test('work stops before dusk and waits through night and early dawn',()=>{
 for(const time of [null,undefined,NaN,-1,0,999,10000,13000,23000,23999])assert.equal(daytimeWork(time),false)
 for(const time of [1000,6000,9999])assert.equal(daytimeWork(time),true)
})
test('extended waiting belongs only to the current routine request after its first clearance timeout',()=>{
 const s={requestProgress:{id:'morning',status:'interrupted'},safety:{status:'sheltered',retreat:{},continuation:{code:'clearance_timeout'}}},job={requestId:'morning'}
 assert.equal(extendedRecoveryEligible(s,job,{}),true)
 assert.equal(extendedRecoveryEligible(s,null,{}),false)
 assert.equal(extendedRecoveryEligible(s,{requestId:'other'},{}),false)
 assert.equal(extendedRecoveryEligible(s,job,{recoveryWaits:[{requestId:'morning'}]}),false)
 for(const change of [{status:'cancelled'},{reviewRequired:'uncertain transfer'},{safetyContinuations:[{}]}])assert.equal(extendedRecoveryEligible({...s,requestProgress:{...s.requestProgress,...change}},job,{}),false)
 for(const change of [{status:'failed'},{retreat:{shelterName:'refuge'}},{continuation:{status:'paused',reason:'Connection changed'}}])assert.equal(extendedRecoveryEligible({...s,safety:{...s.safety,...change}},job,{}),false)
})
test('morning goals adapt resource targets to observed inventory',()=>{
 const s=observation(),a=morningGoal(s);assert.equal(a.logs,32);assert.equal(a.boards,91)
 s.inventory.spruce_log=36;s.inventory.spruce_planks=91
 const b=morningGoal(s);assert.equal(b.logs,32);assert.equal(b.boards,99)
 assert.match(b.text,/stable solid ground/);assert.match(b.text,/Return inside/)
})
test('completion requires reserves, hunger and usable durability rather than tool presence',()=>{
 const s=observation(),goal=morningGoal(s)
 assert.equal(morningOutcome(s,goal),false)
 s.inventory.spruce_log=36;s.inventory.spruce_planks=91;assert.equal(morningOutcome(s,goal),true)
 s.tools[0].remaining=20;assert.equal(morningOutcome(s,goal),false)
 s.tools[0].remaining=80;s.survival.food=10;assert.equal(morningOutcome(s,goal),false)
})
test('restart never replays an active routine and a player command stops its scheduling',()=>{
 const dir=mkdtempSync(join(tmpdir(),'day-routine-')),path=join(dir,'routine.json'),runner=new EventEmitter()
 try{
  writeFileSync(path,JSON.stringify({status:'running',id:'old'}))
  const teammate={runner,snapshot:()=>({connected:false})},routine=new DayRoutine(teammate,path)
  assert.equal(routine.snapshot().status,'paused');assert.equal(routine.active,false)
  assert.throws(()=>routine.start(4),/one to three/);assert.throws(()=>routine.start(2),/healthy/)
  routine.active=true;routine.abort=new AbortController()
  teammate.dispatching=true;runner.emit('operator_command',{action:'stop'});assert.equal(routine.active,true)
  teammate.dispatching=false;runner.emit('operator_command',{action:'stop'})
  assert.equal(routine.active,false);assert.equal(routine.abort.signal.aborted,true)
  assert.equal(JSON.parse(readFileSync(path)).status,'paused')
 }finally{rmSync(dir,{recursive:true,force:true})}
})

import {Vec3} from 'vec3'
import {Teammate} from '../src/companion/controller.js'
import {shelteredObservation} from '../src/retreat.js'
test('extended recovery maintains food in a real checked shelter and resumes the same request once',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'extended-recovery-')),origin=new Vec3(0,64,0),design=[],blocks=new Map()
 for(let x=0;x<=3;x++)for(let z=0;z<=3;z++)for(let y=0;y<=3;y++)if(y===3||((x===0||x===3||z===0||z===3)&&!(x===1&&z===0&&y<2))){design.push({x,y,z,block:'wood_planks'});blocks.set(origin.offset(x,y,z).toString(),'spruce_planks')}
 blocks.set(origin.offset(1,0,2).toString(),'torch')
 const bot={health:20,food:16,game:{gameMode:'survival',difficulty:'easy'},entity:{position:origin.offset(1.5,0,1.5),onGround:true},entities:{},registry:{blocksByName:{torch:{emitLight:14}}},time:{timeOfDay:4000,doDaylightCycle:true},inventory:{items:()=>[{name:'sweet_berries',count:32}]},world:{getColumn:()=>({})},blockAt:p=>{
  if(p.x===1&&p.z===0&&[64,65].includes(p.y))return {position:p,name:'spruce_door',getProperties:()=>({open:false,half:p.y===64?'lower':'upper'}),boundingBox:'block',shapes:[[0,0,0,1,1,.2]]}
  const name=blocks.get(p.toString())||(p.y===63?'dirt':'air');return {position:p,name,boundingBox:['air','torch'].includes(name)?'empty':'block',shapes:[]}
 }};bot.world.getBlock=bot.blockAt
 const runner=new EventEmitter();Object.assign(runner,{bot,ready:true,connectionId:'connection'})
 const project={build:{origin,design,wood:'spruce_log'},stations:{torch:{position:origin.offset(1,0,2)}}}
 const request={id:'morning',status:'interrupted',feedback:[{action:'acquire',status:'completed',result:{count:123}}]},safety={status:'sheltered',retreat:{},continuation:{status:'paused',code:'clearance_timeout'}}
 let resumes=0,eats=0
 const teammate={runner,epoch:1,requestProgress:request,safety,projects:{base:project},persist(){},say(){},emit(){},snapshot:()=>({health:bot.health,inventory:{diamond:3},survival:{gameMode:bot.game.gameMode,difficulty:bot.game.difficulty,food:bot.food,carriedFood:[{name:'sweet_berries',count:32}]},requestProgress:request}),execute:async c=>{assert.equal(c.action,'eat');assert.ok(shelteredObservation(bot,project).passed);eats++;bot.food=20;runner.task={result:{receipt:'ate',count:2}}},resume:async({automatic})=>{assert.ok(automatic);assert.equal(request.id,'morning');assert.equal(request.feedback[0].result.count,123);assert.equal(request.safetyContinuations.length,1);resumes++;teammate.safety=null},continueAfterClearance:Teammate.prototype.continueAfterClearance}
 try{
  const routine=new DayRoutine(teammate,join(dir,'routine.json'));routine.active=true;routine.abort=new AbortController();routine.record={before:{inventory:{diamond:3}},actions:[]}
  await routine.extendRecovery({requestId:'morning'})
  assert.equal(eats,1);assert.equal(resumes,1);assert.equal(routine.record.recoveryWaits[0].status,'continued');assert.equal(routine.record.actions[0].action,'eat');assert.equal(request.safetyContinuations[0].quietMs,20000)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
