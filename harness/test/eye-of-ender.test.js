import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {Vec3} from 'vec3'
import minecraftData from 'minecraft-data'
import {throwEye,bearingFromFlight,intersectBearings,addBearing,validateThrowEyeGoal} from '../src/eye-of-ender.js'
import {validatePlan} from '../src/companion/planner.js'
import {validateTaskGoal} from '../src/task-store.js'
import {guardIntent} from '../src/companion/intent.js'
import {SKILL_ACTIONS} from '../src/companion/skill-control.js'
import {Teammate} from '../src/companion/controller.js'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

// Dragon roadmap stage 4, brief 2: the stronghold is found by throwing eyes and reading
// where they fly. Headings are compass bearings, clockwise from north (-z).
const registry=minecraftData('1.21.4')
const line=(from,to,n)=>Array.from({length:n+1},(_,i)=>new Vec3(from.x+(to.x-from.x)*i/n,from.y+(to.y-from.y)*i/n,from.z+(to.z-from.z)*i/n))
const NE=line(new Vec3(.5,65.6,.5),new Vec3(.5+12/Math.SQRT2,73.6,.5-12/Math.SQRT2),40)

// A scripted world on a physics clock: the eye spawns two ticks after the click, flies its
// samples, vanishes, and maybe leaves an item where it fell.
function fixture({eyes=2,dimension='overworld',flight=NE,drop=true,roof=false,spend=true,spawn=true}={}){
 const bot=new EventEmitter(),inv=new Map([['ender_eye',eyes]]),log={thrown:0,looked:null,held:null}
 let tick=0,clicked=null,nextId=50
 Object.assign(bot,{registry,game:{dimension:'minecraft:'+dimension},entities:{},
  entity:{position:new Vec3(.5,64,.5),yaw:0,pitch:0,onGround:true,height:1.8,eyeHeight:1.62},
  inventory:{items:()=>[...inv].filter(([,c])=>c>0).map(([name,count])=>({name,count,type:registry.itemsByName[name].id}))},
  blockAt:p=>{const y=Math.floor(p.y);return y<64?{name:'stone',boundingBox:'block',position:p.floored()}:roof&&y===70?{name:'stone',boundingBox:'block',position:p.floored()}:{name:'air',boundingBox:'empty',skyLight:roof&&y<70?0:15,position:p.floored()}},
  async equip(item,dest){assert.equal(dest,'hand');log.held=item.name},
  async look(yaw,pitch){log.looked=pitch},async lookAt(){},setControlState(){},clearControlStates(){},
  activateItem(){log.thrown++;clicked=tick;if(spend)inv.set('ender_eye',inv.get('ender_eye')-1)},
  pathfinder:{setMovements(){},setGoal(){},async goto(g){bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)
   for(const e of Object.values(bot.entities))if(e.name==='item'&&e.position.distanceTo(bot.entity.position)<1.5){const s=e.getDroppedItem();inv.set(s.name,(inv.get(s.name)||0)+s.count);delete bot.entities[e.id];bot.emit('entityGone',e)}}},
  tool:{equipForBlock:async()=>{}},canDigBlock:()=>false,dig:async()=>{}})
 bot.world={getBlock:p=>bot.blockAt(p)}
 const add=e=>{e.id=nextId++;bot.entities[e.id]=e;bot.emit('entitySpawn',e);return e}
 // Someone else's eye ten blocks off is never the bot's.
 add({name:'eye_of_ender',type:'object',position:new Vec3(10.5,70,.5)})
 let eye=null
 const timer=setInterval(()=>{
  tick++
  if(clicked!==null&&spawn){
   const i=tick-clicked-2
   if(i===0)eye=add({name:'eye_of_ender',type:'object',position:flight[0].clone()})
   else if(eye&&i>0&&i<flight.length)eye.position=flight[i].clone()
   else if(eye&&i===flight.length){delete bot.entities[eye.id];bot.emit('entityGone',eye)
    if(drop){const at=flight.at(-1);add({name:'item',type:'object',position:new Vec3(at.x,64,at.z),getDroppedItem:()=>({name:'ender_eye',count:1})})}}
  }
  bot.emit('physicsTick')
 },1)
 const api={check(){},stage(){},progress(){},persist(){log.persisted=(log.persisted||0)+1},movements:null}
 return {bot,inv,log,api,stop:()=>clearInterval(timer)}
}
const run=async(f,task={kind:'throw_eye',goal:{}})=>{try{return await throwEye(f.bot,task,f.api)}finally{f.stop()}}

test('with no eye carried the throw is refused and nothing is clicked',async()=>{
 const f=fixture({eyes:0})
 await assert.rejects(run(f),/No eye of ender is carried/)
 assert.equal(f.log.thrown,0)
})

test('in the Nether, or under a roof, the throw is refused before anything is spent',async()=>{
 const n=fixture({dimension:'the_nether'})
 await assert.rejects(run(n),/Overworld/);assert.equal(n.log.thrown,0)
 const r=fixture({roof:true})
 await assert.rejects(run(r),/open sky/);assert.equal(r.log.thrown,0)
})

test('a twelve-block north-east flight reads heading 45, and the eye that drops is walked to and recovered',async()=>{
 const f=fixture()
 const r=await run(f)
 assert.equal(f.log.thrown,1);assert.equal(f.log.held,'ender_eye')
 assert.ok(f.log.looked>1.5,'looks straight up, so a frame or block in front never takes the click')
 assert.equal(r.heading,45);assert.equal(r.travelled,12);assert.equal(r.overhead,false)
 assert.equal(r.recovered,true);assert.equal(r.shattered,false);assert.ok(!r.partial)
 assert.deepEqual(r.from,{x:.5,y:64,z:.5})
 assert.equal(f.inv.get('ender_eye'),2,'the eye came back')
})

test('an eye that vanishes without a drop is shattered, and the bearing still stands',async()=>{
 const f=fixture({drop:false})
 const r=await run(f)
 assert.equal(r.heading,45);assert.equal(r.shattered,true);assert.equal(r.recovered,false)
 assert.equal(f.inv.get('ender_eye'),1)
})

test('an eye that drops almost straight down within six blocks says the stronghold is below',async()=>{
 const f=fixture({flight:line(new Vec3(.5,65.6,.5),new Vec3(2.5,58,1.5),30)})
 const r=await run(f)
 assert.equal(r.overhead,true);assert.ok(r.travelled<=6)
 assert.equal(r.recovered,true,'the item pushed up out of the ground is still picked up')
})

test('an eye spent with no flight seen is a partial receipt that latches, and the restored step never throws a second',async()=>{
 const f=fixture({spawn:false}),task={kind:'throw_eye',goal:{}}
 try{
  const r=await throwEye(f.bot,task,f.api)
  assert.equal(r.partial,true);assert.equal(r.heading,null);assert.equal(r.spent,1)
  assert.equal(task.eye.uncertain,true)
 }catch(e){f.stop();throw e}
 await assert.rejects(run(f,task),/already spent/)
 assert.equal(f.log.thrown,1)
 // Nothing spent and nothing seen: the click never happened, and that is a failure, not a bearing.
 const g=fixture({spawn:false,spend:false})
 await assert.rejects(run(g),/nothing left the hand/)
})

test('bearingFromFlight reads compass headings from the first and last samples',()=>{
 const o={x:0,y:70,z:0}
 for(const [x,z,h] of [[0,-10,0],[10,0,90],[0,10,180],[-10,0,270]])
  assert.equal(bearingFromFlight([o,{x,y:78,z}]).heading,h)
 assert.equal(bearingFromFlight([o]).heading,null,'one sample is no flight')
})

test('two bearings cross at the stronghold, and near-parallel or backward ones give no point',()=>{
 assert.deepEqual(intersectBearings({x:0,z:0,heading:45},{x:100,z:0,heading:315}),{point:{x:50,z:-50},reason:null})
 const flat=intersectBearings({x:0,z:0,heading:40},{x:100,z:0,heading:46})
 assert.equal(flat.point,null);assert.match(flat.reason,/6 degrees apart/)
 const back=intersectBearings({x:0,z:0,heading:225},{x:100,z:0,heading:315})
 assert.equal(back.point,null);assert.match(back.reason,/behind/)
})

test('saved bearings carry the crossing of the latest two, and an overhead drop is its own estimate',()=>{
 const a=addBearing(undefined,{from:{x:0,y:70,z:0},heading:45,overhead:false,at:{x:8,y:78,z:-8}})
 assert.equal(a.length,1);assert.equal(a[0].estimate,undefined)
 const b=addBearing(a,{from:{x:100,y:70,z:0},heading:315,overhead:false,at:{x:92,y:78,z:-8}})
 assert.deepEqual(b[1].estimate,{x:50,z:-50})
 const c=addBearing(b,{from:{x:49,y:70,z:-48},heading:200,overhead:true,at:{x:49.6,y:60,z:-50.2}})
 assert.deepEqual(c[2].estimate,{x:50,z:-50})
 assert.equal(addBearing(Array.from({length:12},()=>a[0]),{from:{x:100,y:70,z:0},heading:315,overhead:false,at:{x:92,y:78,z:-8}}).length,8)
})

test('the planner, the task store, intent and skill control all admit throw_eye',()=>{
 const step={action:'throw_eye',name:'',item:'ender_eye',count:1,design:[],target:null}
 const plan=validatePlan({reply:'Finding the stronghold',steps:[step]})
 assert.equal(plan.steps[0].action,'throw_eye')
 assert.throws(()=>validatePlan({reply:'',steps:[{...step,count:2}]}),/One eye per step/)
 assert.throws(()=>validatePlan({reply:'',steps:[{...step,item:'ender_pearl'}]}),/throw_eye/)
 assert.deepEqual(validateTaskGoal('throw_eye',{}),{})
 assert.deepEqual(validateThrowEyeGoal({}),{})
 assert.deepEqual(guardIntent(plan,'where is the stronghold'),plan)
 assert.ok(SKILL_ACTIONS.has('throw_eye'))
})

test('the controller saves each watched bearing in places.stronghold_bearing, and a partial throw saves none',()=>{
 const bot={registry,game:{gameMode:'survival',difficulty:'normal',dimension:'overworld'},time:{timeOfDay:3000},health:20,food:20,players:{},
  entity:{position:new Vec3(.5,64,.5),onGround:true,eyeHeight:1.62,metadata:[0]},entities:{},inventory:{items:()=>[]},
  blockAt:p=>({name:p.y<64?'stone':'air',boundingBox:p.y<64?'block':'empty',position:p,getProperties:()=>({})}),world:{raycast:()=>null},findBlocks:()=>[],findBlock:()=>null}
 const r=Object.assign(new EventEmitter(),{profile:'eye',owner:'Sov',ready:true,connectionId:'one',bot,position:()=>({x:.5,y:64,z:.5}),command(){},log(){}})
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-eye-')),'state.json'))
 const done=result=>r.emit('event',{type:'task_finished',task:{id:'e',kind:'throw_eye',status:'completed',goal:{},result}})
 done({receipt:'eye_unobserved',partial:true,heading:null,from:{x:0,y:70,z:0}})
 assert.equal(c.places.stronghold_bearing,undefined)
 done({receipt:'eye_bearing',from:{x:0,y:70,z:0},heading:45,overhead:false,at:{x:8,y:78,z:-8}})
 done({receipt:'eye_bearing',from:{x:100,y:70,z:0},heading:315,overhead:false,at:{x:92,y:78,z:-8}})
 assert.equal(c.places.stronghold_bearing.length,2);assert.deepEqual(c.places.stronghold_bearing[1].estimate,{x:50,z:-50})
})
