import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import minecraftData from 'minecraft-data'
import {shelteredPlanning,shelterDeparture} from '../src/companion/sheltered-planning.js'
import {LocalPlanner} from '../src/companion/planner.js'
const registry=minecraftData('1.21.4'),plan={reply:'Collect the requested wood',steps:[{action:'gather',item:'oak_log',count:8,name:'',design:[]}]}
const limits={rounds:1,budgetMs:200,decisionMs:80,pollMs:2,waitMs:5,quietMs:4}
function fixture(choose,act=()=>{}){
 const cells=new Map(),commands=[],events=[],abort=new AbortController()
 const bot={registry,health:20,food:20,game:{gameMode:'survival',difficulty:'easy'},time:{timeOfDay:6000},entity:{position:new Vec3(.5,60,.5),onGround:true},entities:{1:{name:'zombie',position:new Vec3(15,64,.5)}},players:{},inventory:{items:()=>[]},findBlocks:()=>[],
 blockAt(p){const name=cells.get(p.toString())??(p.y>=64||p.x===0&&p.z===0&&p.y>=60&&p.y<63?'air':'dirt');return {name,position:p.clone(),boundingBox:registry.blocksByName[name]?.boundingBox}}}
 const runner={bot,ready:true,connectionId:'c',log:(type,data)=>events.push({type,...data})}
 const c={runner,epoch:1,safety:{status:'burrowed',retreat:{shelterName:'burrow',surface:{x:0,y:64,z:0}}},requestProgress:{id:'r',request:'Collect eight logs',completed:[],feedback:[]},recoveryHistory:[],planner:{sheltered:choose},persist(){},snapshot:()=>({inventory:{},position:bot.entity.position,health:bot.health}),dispatch:cmd=>commands.push(cmd.action),async execute(cmd){commands.push(cmd.action);await act(cmd,bot);if(cmd.action==='unburrow')bot.entity.position=new Vec3(.5,64,.5);if(cmd.action==='flee')bot.entities={};runner.task={result:{receipt:cmd.action}}}}
 return {bot,cells,c,commands,events,abort,run:(opts={})=>shelteredPlanning(c,1,abort.signal,bot,{...limits,...opts})}
}
test('a protected decision observes the goal and resources, departs, clears pursuit and returns its bound work plan',async()=>{
 const f=fixture(async o=>{assert.equal(o.protection.verified,true);assert.equal(o.foraging.status,'observed');assert.equal(o.foraging.ripeCount,0);assert.equal(o.recovery.objective.request,'Collect eight logs');assert.equal(o.departure.available,true);return {action:'depart',expectation:'Reach clear ground and collect wood',plan}})
 const result=await f.run();assert.equal(result.status,'departed');assert.deepEqual(f.commands,['unburrow','flee']);assert.equal(result.prepared.requestId,'r');assert.equal(result.prepared.connectionId,'c');assert.deepEqual(result.prepared.plan,plan)
})
test('a late decision rechecks the surface threat instead of using stale permission to exit',async()=>{
 const f=fixture(async()=>{f.bot.entities[1].position.x=2;return {action:'depart',expectation:'Leave',plan}})
 assert.equal((await f.run()).status,'held');assert.deepEqual(f.commands,[]);assert.ok(f.c.recoveryHistory.some(x=>x.status==='rejected'))
})
for(const change of ['stop','request','connection'])test(`${change} invalidates a late planner answer`,async()=>{
 const f=fixture(async()=>{await new Promise(r=>setTimeout(r,25));return {action:'depart',expectation:'Leave',plan}})
 const run=f.run();setTimeout(()=>{if(change==='stop'){f.c.epoch++;f.abort.abort()}if(change==='request')f.c.requestProgress={id:'other'};if(change==='connection')f.c.runner.connectionId='other'},5)
 assert.equal((await run).status,'cancelled');await new Promise(r=>setTimeout(r,35));assert.deepEqual(f.commands,[])
})
for(const change of ['breach','damage'])test(`protection detects ${change} while the model is still pending`,async()=>{
 const f=fixture(async()=>{await new Promise(r=>setTimeout(r,40));return {action:'depart',expectation:'Leave',plan}})
 const run=f.run();setTimeout(()=>{if(change==='damage')f.bot.health=19;else for(let y=63;y<100;y++)f.cells.set(`(0, ${y}, 0)`,'air')},5)
 await assert.rejects(run,change==='damage'?/Health fell/:/open or exceeds/);assert.deepEqual(f.commands,[])
})
test('a provider timeout leaves the verified shelter closed',async()=>{
 const f=fixture(()=>new Promise(()=>{}));assert.equal((await f.run({decisionMs:8})).status,'held');assert.deepEqual(f.commands,[])
})
test('a failed departure is available to the next protected decision and does not reuse the plan',async()=>{
 let second=false
 const f=fixture(async o=>{if(second){assert.ok(o.recovery.recentAttempts.some(x=>x.status==='failed'&&x.reason==='Blocked route'));return {action:'wait',expectation:'Reassess the changed route',plan:{reply:'Wait',steps:[]}}}return {action:'depart',expectation:'Leave',plan}},async()=>{throw new Error('Blocked route')})
 assert.equal((await f.run()).status,'unsafe');second=true
 assert.equal((await f.run()).status,'held');assert.deepEqual(f.commands,['unburrow'])
})
test('departure checks the surface landing and distance from that landing, rather than distance from underground',()=>{
 const f=fixture();f.bot.entities[1].position=new Vec3(9,64,.5);assert.equal(shelterDeparture(f.bot,f.c.safety.retreat).available,false)
 f.bot.entities={};f.cells.set('(0, 64, 0)','water');assert.equal(shelterDeparture(f.bot,f.c.safety.retreat).available,false)
})
test('sheltered provider validates the typed decision and respects late cancellation',async()=>{
 const p=new LocalPlanner(),abort=new AbortController(),o={recovery:{objective:{request:'Collect eight logs'}}}
 p.structured=async()=>({action:'depart',expectation:'Gather wood',plan});assert.equal((await p.sheltered(o,abort.signal)).plan.steps[0].action,'gather')
 p.structured=async()=>({action:'depart',expectation:'Leave',plan:{reply:'What now?',steps:[]}});await assert.rejects(p.sheltered(o,abort.signal),/usable work plan/)
 p.structured=async()=>{abort.abort();return {action:'depart',expectation:'Leave',plan}};await assert.rejects(p.sheltered(o,abort.signal),/Cancelled/)
})

import {Teammate} from '../src/companion/controller.js'
import {canContinueAfterSafety,SAFETY_CONTINUATIONS,SHELTERED_CALLS} from '../src/companion/continuity.js'
test('protected reconsideration shares the episode cap and finite call budget while ordinary idle retries stay capped',()=>{
 const request={resumeSerial:1,completed:[],safetyContinuations:[{resumeSerial:1,completedAt:0},{resumeSerial:1,completedAt:0}],shelteredCalls:1}
 const allowed=()=>canContinueAfterSafety(request,undefined,{protectedPlanning:true})
 assert.equal(canContinueAfterSafety(request),false);assert.equal(allowed(),true)
 request.shelteredCalls=SHELTERED_CALLS;assert.equal(allowed(),false)
 request.shelteredCalls=1;request.safetyContinuations=Array.from({length:SAFETY_CONTINUATIONS},()=>({resumeSerial:1,completedAt:0}));assert.equal(allowed(),false)
 request.resumeSerial=2;assert.equal(allowed(),true)
 request.shelteredCalls=SHELTERED_CALLS;assert.equal(allowed(),false,'explicit Resume does not reset the saved request model-call budget')
})
test('two interrupted work attempts still reach a protected decision and its departure counts in the current Resume run',async()=>{
 const f=fixture(async()=>({action:'depart',expectation:'Use clearance and retry the saved work',plan}))
 Object.assign(f.c.requestProgress,{status:'interrupted',resumeSerial:2,safetyContinuations:[{resumeSerial:2,completedAt:0},{resumeSerial:2,completedAt:0}]})
 Object.assign(f.c,{shelterPlanning:true,shelteredLimits:limits,say(){},emit(){}})
 let resumed
 f.c.resume=async options=>{resumed=options}
 await Teammate.prototype.waitInBurrow.call(f.c,1,f.abort.signal,f.bot,true)
 assert.equal(resumed.automatic,true);assert.deepEqual(resumed.prepared.plan,plan)
 assert.equal(f.c.requestProgress.shelteredCalls,1)
 assert.equal(f.c.requestProgress.safetyContinuations.at(-1).resumeSerial,2)
 assert.equal(f.c.requestProgress.safetyContinuations.length,3)
 assert.equal(canContinueAfterSafety(f.c.requestProgress),false,'ordinary idle continuations remain capped')
})


test('unchanged night consumes one protected decision and keeps the finite budget',async()=>{
 let calls=0
 const f=fixture(async()=>{calls++;return {action:'wait',expectation:'Wait for daylight',plan:{reply:'Wait',steps:[]}}})
 f.bot.time.timeOfDay=14000
 const result=await f.run({rounds:6,budgetMs:50})
 assert.equal(result.status,'held');assert.equal(calls,1);assert.equal(f.c.requestProgress.shelteredCalls,1);assert.deepEqual(f.commands,[])
})
test('changed departure feasibility triggers a fresh protected plan after waiting',async()=>{
 let calls=0
 const f=fixture(async o=>{calls++;return o.departure.available?{action:'depart',expectation:'Use fresh daylight clearance',plan}:{action:'wait',expectation:'Wait for daylight',plan:{reply:'Wait',steps:[]}}})
 f.bot.time.timeOfDay=14000
 const running=f.run({rounds:6,budgetMs:200})
 setTimeout(()=>{f.bot.time.timeOfDay=6000},20)
 assert.equal((await running).status,'departed');assert.equal(calls,2);assert.deepEqual(f.commands,['unburrow','flee'])
})
for(const change of ['stop','damage'])test(`unchanged-condition wait still detects ${change}`,async()=>{
 let calls=0
 const f=fixture(async()=>{calls++;return {action:'wait',expectation:'Wait for daylight',plan:{reply:'Wait',steps:[]}}})
 f.bot.time.timeOfDay=14000
 const running=f.run({rounds:6,budgetMs:200})
 setTimeout(()=>{if(change==='stop')f.abort.abort();else f.bot.health=19},20)
 if(change==='stop')assert.equal((await running).status,'cancelled');else await assert.rejects(running,/Health fell/)
 assert.equal(calls,1);assert.deepEqual(f.commands,[])
})
