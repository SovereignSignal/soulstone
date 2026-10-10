import test from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {awaitClearance,clearanceObservation,departureThreatObservation} from '../src/companion/hazard-clearance.js'
const run=options=>awaitClearance({check(){},observe:()=>({clear:true}),quietMs:15,limitMs:100,pollMs:2,...options})
test('clearance requires a continuous quiet interval',async()=>{
 let n=0;const updates=[];const r=await run({observe:()=>({clear:++n>3,reason:'Hostile remains'}),onUpdate:u=>updates.push(u)})
 assert.equal(r.status,'cleared');assert.ok(r.clearedAt-r.startedAt>=15);assert.ok(updates.some(u=>u.reason==='Hostile remains'))
})
test('returning threat resets the quiet interval',async()=>{
 const began=Date.now();let lastThreat=0
 const r=await run({quietMs:20,limitMs:150,observe:()=>{const t=Date.now()-began,clear=t<12||t>25;if(!clear)lastThreat=Date.now();return {clear,reason:'Threat'}}})
 assert.equal(r.status,'cleared');assert.ok(r.clearedAt-lastThreat>=20)
})
test('persistent uncertainty pauses at the deadline',async()=>{
 const r=await run({limitMs:15,observe:()=>({clear:false,reason:'Unknown chunks'})});assert.equal(r.status,'paused')
})
test('cancellation overrides a clear observation',async()=>{
 let cancelled=false;await assert.rejects(run({observe:()=>{cancelled=true;return {clear:true}},check(){if(cancelled)throw new Error('Cancelled')}}),/Cancelled/)
})
test('food maintenance restarts the quiet interval and cancellation during maintenance prevents continuation',async()=>{
 let fed=false,fedAt
 const result=await run({quietMs:20,limitMs:150,maintain:async()=>{if(!fed){fed=true;await new Promise(r=>setTimeout(r,10));fedAt=Date.now();return true}}})
 assert.equal(result.status,'cleared');assert.ok(result.clearedAt-fedAt>=20)
 let cancelled=false
 await assert.rejects(run({maintain:async()=>{cancelled=true},check(){if(cancelled)throw new Error('Stopped while eating')}}),/Stopped/)
})
test('a slow maintenance action cannot continue past the observation deadline',async()=>{
 const result=await run({quietMs:0,limitMs:5,maintain:async()=>{await new Promise(r=>setTimeout(r,10))}})
 assert.equal(result.code,'clearance_timeout');assert.equal(result.status,'paused')
})
test('uncertain maintenance stops observation without retrying the action',async()=>{
 let calls=0
 await assert.rejects(run({maintain:async()=>{calls++;throw new Error('Consumption uncertain')}}),/uncertain/)
 assert.equal(calls,1)
})
function bot(){return {entity:{position:new Vec3(0,65,0)},health:20,food:20,game:{gameMode:'survival',difficulty:'easy'},inventory:{items:()=>[]},entities:{},world:{getColumn:()=>({})}}}
test('missing chunks, threats, poor health or food, changed mode and unknown shelter deny clearance',()=>{
 let b=bot();b.world.getColumn=()=>null;assert.match(clearanceObservation(b,{},'base').reason,/chunks/)
 b=bot();b.health=19;assert.match(clearanceObservation(b,{},'base').reason,/Health/)
 b=bot();b.food=13;assert.match(clearanceObservation(b,{},'base').reason,/food/)
 b=bot();b.entities.husk={name:'husk',position:new Vec3(20,65,0)};assert.match(clearanceObservation(b,{},'base').reason,/threat/)
 b=bot();b.entities.husk={name:'husk'};assert.match(clearanceObservation(b,{},'base').reason,/threat/)
 b=bot();assert.match(clearanceObservation(b,{},'base').reason,/shelter/)
 b=bot();b.game.difficulty='peaceful';assert.equal(clearanceObservation(b,{},'base').clear,false)
})
test('a hostile inside its own interruption radius denies clearance even off the corridor',()=>{
 // Lab run 16, 2 October: the base wait cleared with a creeper 13 blocks off
 // the corridor; ten seconds outside, the threat rule sent the bot back in.
 const design=[]
 for(let x=0;x<4;x++)for(let z=0;z<4;z++)for(let y=0;y<3;y++)if((y===2||x===0||x===3||z===0||z===3)&&!(x===1&&z===0&&y<2))design.push({x,y,z,block:'cobblestone'})
 const base={build:{origin:{x:-1,y:65,z:-1},design}}
 let b=bot();b.entities.c={name:'creeper',position:new Vec3(9,65,9)}
 const r=clearanceObservation(b,{base},'base');assert.equal(r.clear,false);assert.match(r.reason,/interruption radius/);assert.equal(r.threats[0].name,'creeper')
 b=bot();b.entities.z={name:'zombie',position:new Vec3(9,65,9)}
 assert.doesNotMatch(clearanceObservation(b,{base},'base').reason||'',/interruption radius/,'a zombie at 12.7 is outside its ten-block radius')
})
test('departure threat observation blocks the exit corridor but records peripheral mobs separately',()=>{
 const design=[]
 for(let x=0;x<4;x++)for(let z=0;z<4;z++)for(let y=0;y<3;y++){
  const edge=x===0||x===3||z===0||z===3,door=x===1&&z===0&&y<2
  if(y===2||edge&&!door)design.push({x,y,z,block:'wood_planks'})
 }
 const project={build:{origin:{x:0,y:64,z:0},design},stations:{}}
 const bot={entity:{position:{x:1.5,y:64,z:1.5}},entities:{
  near:{name:'skeleton',position:{x:1.5,y:64,z:-1.5}},
  side:{name:'creeper',position:{x:6.5,y:64,z:1.5}},
  unknown:{name:'zombie'}
 }}
 const unknown=departureThreatObservation(bot,{base:project});assert.equal(unknown.blocking.length,2);assert.equal(unknown.peripheral.length,1)
 delete bot.entities.unknown
 const split=departureThreatObservation(bot,{base:project});assert.equal(split.blocking.length,1);assert.equal(split.blocking[0].name,'skeleton');assert.equal(split.peripheral[0].name,'creeper')
})

test('time in which nothing could change does not spend the observation window',async()=>{
 // A bot that digs in at dusk waits ten real minutes for a dawn that is simply
 // coming. Charged to the window, that left twenty-eight seconds for a judgement
 // needing four minutes, and the wait ended in "resume is required" instead.
 let calls=0
 const held=await awaitClearance({check(){},quietMs:15,limitMs:120,pollMs:2,
  observe:()=>(++calls<60?{clear:false,holding:true,reason:'Waiting for daylight'}:{clear:true})})
 assert.equal(held.status,'cleared','the watch outlasted a hold longer than its own window')
 // A hold does not make the window infinite: once something could change, it runs.
 calls=0
 const timedOut=await awaitClearance({check(){},quietMs:15,limitMs:60,pollMs:2,
  observe:()=>(++calls<10?{clear:false,holding:true,reason:'Waiting for daylight'}:{clear:false,reason:'A potential hostile remains'})})
 assert.equal(timedOut.status,'paused');assert.equal(timedOut.code,'clearance_timeout')
 assert.ok(timedOut.heldMs>0,'it reports how long it held')
})
// pi2, 10 October: at 1 health, hunger 10 and nothing to eat, the base's clearance
// asked for full health before letting the bot out. Inside, nothing raises health or
// hunger without food, so the watch could never clear: every dawn hunt ended in a
// ninety-second wait that timed out. Readiness is asked for only where waiting
// heals (carried food, or hunger 18 and up); otherwise leaving for food is the
// remedy, and that waits for working daylight instead.
test('a hurt, hungry bot with nothing to eat may leave the base for food in daylight, never at night',()=>{
 const hurt=(over={})=>{const b=bot();Object.assign(b,{health:1,food:10,time:{timeOfDay:3000}},over);return b}
 assert.match(clearanceObservation(hurt(),{},'base').reason,/shelter/,'past readiness, on to the remaining checks')
 assert.match(clearanceObservation(hurt({time:{timeOfDay:14000}}),{},'base').reason,/daylight/)
 assert.match(clearanceObservation(hurt({inventory:{items:()=>[{name:'bread',count:2}]}}),{},'base').reason,/Health/,'with food in the bag it eats and heals first')
 assert.match(clearanceObservation(hurt({food:18}),{},'base').reason,/Health/,'at hunger 18 it heals by waiting')
 assert.match(clearanceObservation(hurt({health:20,food:12}),{},'base').reason,/shelter/,'hungry at full health with no food: go and get some')
})
