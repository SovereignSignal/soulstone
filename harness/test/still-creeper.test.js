import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {THREAT_INTERRUPTION} from '../src/survival.js'
import {insideBase,pressingOutside} from '../src/retreat.js'
import {burrowClearance} from '../src/burrow.js'
import {clearanceObservation} from '../src/companion/hazard-clearance.js'
import {Teammate} from '../src/companion/controller.js'
import {noteStill,stillCreeper,STILL_MS} from '../src/still-creeper.js'
const registry=minecraftData('1.21.4')
// Live, the play world, 17 October 15:59Z and 16:39Z: a pile of six creepers stood still for over a day
// 13 to 14 blocks from the base door; every morning the shelter watch kept the bot in on them. The owner's rule:
// in daylight a creeper that has not moved and is 10 or more blocks off does not hold the door.
const design=[]
for(let x=0;x<4;x++)for(let z=0;z<4;z++)for(let y=0;y<3;y++)if((y===2||x===0||x===3||z===0||z===3)&&!(x===1&&z===0&&y<2))design.push({x,y,z,block:'cobblestone'})
const base=()=>({build:{origin:{x:0,y:64,z:0},near:{x:0,y:64,z:0},purpose:'shelter',design},stations:{torch:{position:{x:2,y:64,z:2},confirmed:true}},built:true})
// The door is at x 1, z 0 and opens north: a creeper at z -12.5 is 14 blocks from the bot inside and 12 from the doorstep.
const FAR=new Vec3(1.5,64,-12.5),NEAR=new Vec3(1.5,64,-7.5)
function world(position,creeper=FAR,{timeOfDay=6000,dimension='overworld'}={}){
 const shell=new Set(design.map(b=>`${b.x},${b.y+64},${b.z}`))
 const bot={registry,username:'Bot',game:{gameMode:'survival',difficulty:'normal',dimension},time:{timeOfDay},health:20,food:20,oxygenLevel:20,players:{},
  entity:{position,onGround:true,eyeHeight:1.62,isInWater:false,metadata:[0]},inventory:{items:()=>[]},
  entities:{7:{id:7,name:'creeper',position:creeper.clone()}},
  blockAt:p=>{const name=p.y<64||shell.has(`${p.x},${p.y},${p.z}`)?'cobblestone':'air';return {name,position:p,boundingBox:name==='air'?'empty':'block',getProperties:()=>({})}},
  world:{raycast:()=>({name:'cobblestone'}),getColumn:()=>({})},clearControlStates(){},setControlState(){}}
 const r=new EventEmitter();Object.assign(r,{profile:'lab',owner:'Player',ready:true,connectionId:'c1',bot,commands:[],position:()=>({x:position.x,y:position.y,z:position.z}),waitForIdle:async()=>{}})
 r.command=c=>{r.commands.push(c.action);if(c.action==='stop')return
  r.task={id:String(r.commands.length),kind:c.action,status:'running'}
  setTimeout(()=>{r.task={...r.task,status:'completed',result:{item:'safety',count:1,receipt:c.action}};r.emit('event',{type:'task_finished',task:r.task})},1)}
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-still-')),'state.json'))
 c.projects.base=base();c.threatJudge={enabled:false,control:false,judge:async()=>null}
 return {r,c,bot}
}
// Watched where it stands for longer than STILL_MS.
const stood=bot=>noteStill(bot,Date.now()-STILL_MS-1000)
const leave=(w,action='goto')=>w.c.executeCommand({action,goal:action==='goto'?{x:20,y:64,z:-20}:{},timeoutMs:5000},new AbortController().signal)

test('in daylight a creeper that has stood still 14 blocks off for over a minute does not hold the door',async()=>{
 const w=world(new Vec3(1.5,64,1.5));stood(w.bot)
 assert.equal(insideBase(w.bot,w.c.projects.base),true)
 assert.equal(pressingOutside(w.bot,w.c.projects.base),null)
 await leave(w);assert.deepEqual(w.r.commands,['leave_base','goto'],'the door opens and the work goes on')
 // The live refusal: the hut's own opening, from inside the base, after the watch cleared.
 const hut=world(new Vec3(1.5,64,1.5));stood(hut.bot)
 await leave(hut,'unhut');assert.deepEqual(hut.r.commands,['leave_base','unhut'])
})
test('the same creeper just arrived, or moving, still holds the door',async()=>{
 const fresh=world(new Vec3(1.5,64,1.5))
 await assert.rejects(leave(fresh),/creeper is 14 blocks from the base, inside its interruption radius/);assert.deepEqual(fresh.r.commands,[])
 const moving=world(new Vec3(1.5,64,1.5));stood(moving.bot)
 moving.bot.entities[7].position=FAR.offset(1.5,0,0)
 await assert.rejects(leave(moving),/creeper .* inside its interruption radius/);assert.deepEqual(moving.r.commands,[])
 // Back where it was is not still either: the minute starts again from the move.
 moving.bot.entities[7].position=FAR.clone()
 await assert.rejects(leave(moving),/inside its interruption radius/)
 // A creeper that has wandered within a block of where it stood is still standing there.
 const jostled=world(new Vec3(1.5,64,1.5));stood(jostled.bot);jostled.bot.entities[7].position=FAR.offset(.6,0,.4)
 await leave(jostled);assert.deepEqual(jostled.r.commands,['leave_base','goto'])
})
test('at night, outside the Overworld, or nine blocks off, a still creeper still counts',async()=>{
 // The one difference from the daylight release is the clock, the dimension or the distance.
 const day=world(new Vec3(1.5,64,1.5));stood(day.bot);assert.equal(pressingOutside(day.bot,day.c.projects.base),null)
 const night=world(new Vec3(1.5,64,1.5),FAR,{timeOfDay:13000});stood(night.bot)
 assert.equal(pressingOutside(night.bot,night.c.projects.base)?.name,'creeper')
 assert.equal(stillCreeper(night.bot,{name:'creeper',distance:14,position:FAR}),false)
 const nether=world(new Vec3(1.5,64,1.5),FAR,{dimension:'the_nether'});stood(nether.bot)
 assert.equal(pressingOutside(nether.bot,nether.c.projects.base)?.name,'creeper')
 const close=world(new Vec3(1.5,64,1.5),NEAR);stood(close.bot)
 await assert.rejects(leave(close),/creeper is 9 blocks from the base, inside its interruption radius/);assert.deepEqual(close.r.commands,[])
 // Ten or more from the bot is not enough: within ten of the cell it leaves by, it counts.
 const w=world(new Vec3(1.5,64,1.5));stood(w.bot)
 assert.equal(stillCreeper(w.bot,{name:'creeper',distance:14,position:FAR},{cells:[{x:1,y:64,z:-4}]}),false)
 assert.equal(stillCreeper(w.bot,{name:'creeper',distance:14,position:FAR},{cells:[{x:1,y:64,z:-1}]}),true)
})
test('a pile is still only while every creeper in it is: one that just walked onto the spot holds the door',async()=>{
 const w=world(new Vec3(1.5,64,1.5));stood(w.bot)
 assert.equal(pressingOutside(w.bot,w.c.projects.base),null,'alone and still, it does not hold the door')
 w.bot.entities[8]={id:8,name:'creeper',position:FAR.clone()}
 await assert.rejects(leave(w),/inside its interruption radius/)
})
test('the shelter watch releases on a still far creeper in daylight; moving, at night or nine blocks off it holds',()=>{
 // The live watch: a hut inside the base, cleared only by its patience running out, then refused at the door.
 const hut={shelterName:'hut',surface:{x:1,y:64,z:1}},exits=[[1,0],[-1,0],[0,1],[0,-1]].flatMap(([dx,dz])=>[new Vec3(1+dx*2,64,1+dz*2),new Vec3(1+dx*2,65,1+dz*2)])
 const w=world(new Vec3(1.5,64,1.5));stood(w.bot)
 const r=burrowClearance(w.bot,{exits,canPort:true});assert.equal(r.clear,true);assert.equal(r.relocate,undefined,'opened up, not leaving the area');assert.equal(hut.shelterName,'hut')
 const moving=world(new Vec3(1.5,64,1.5));stood(moving.bot);moving.bot.entities[7].position=FAR.offset(0,0,-2)
 assert.equal(burrowClearance(moving.bot,{exits,canPort:true}).clear,false)
 const night=world(new Vec3(1.5,64,1.5),FAR,{timeOfDay:13000});stood(night.bot)
 assert.equal(burrowClearance(night.bot,{exits,canPort:true}).clear,false)
 const close=world(new Vec3(1.5,64,1.5),NEAR);stood(close.bot)
 assert.equal(burrowClearance(close.bot,{exits,canPort:true}).clear,false)
 // The base's own watch, by the same test at its doorstep.
 const b=world(new Vec3(1.5,64,1.5));stood(b.bot)
 assert.doesNotMatch(clearanceObservation(b.bot,{base:b.c.projects.base},'base').reason||'',/interruption radius/)
 const bm=world(new Vec3(1.5,64,1.5))
 assert.match(clearanceObservation(bm.bot,{base:bm.c.projects.base},'base').reason,/interruption radius/)
})
test('once out, the alarm does not send the bot back in for the still far creeper; a moving one or one within ten still interrupts',()=>{
 const run=(w,setup=()=>{})=>{const calls=[];w.c.seekSafety=async why=>{calls.push(why)};setup(w);w.r.emit('event',{type:'survival_tick'});return calls}
 // On the doorstep, 12 blocks from the pile.
 const out=new Vec3(1.5,64,-0.5)
 assert.deepEqual(run(world(out),w=>stood(w.bot)),[],'still and far in daylight: no interruption')
 assert.deepEqual(run(world(out)),[THREAT_INTERRUPTION],'not yet watched still: the alarm as before')
 assert.deepEqual(run(world(out),w=>{stood(w.bot);w.bot.entities[7].position=FAR.offset(0,0,1.5)}),[THREAT_INTERRUPTION],'moving')
 assert.ok(run(world(out,FAR,{timeOfDay:13000}),w=>stood(w.bot)).includes(THREAT_INTERRUPTION),'at night')
 assert.deepEqual(run(world(out),w=>{stood(w.bot);w.bot.entity.position=new Vec3(1.5,64,-3.5)}),[THREAT_INTERRUPTION],'walked within ten of it')
})
