import test from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {aimPitch,arrowPath,ARROW} from '../src/archery.js'

// The dragon ladder needs a bow: blazes keep their distance and the dragon's
// end crystals sit on towers. A fully drawn arrow leaves at 3 blocks a tick,
// loses 0.05 a tick to gravity and keeps 0.99 of its speed to drag; the aim is
// the pitch whose path passes through the target.
const landsOn=(from,to,pitch)=>{
 const d=Math.hypot(to.x-from.x,to.z-from.z)
 const path=arrowPath(pitch,{ticks:200})
 for(let i=1;i<path.length;i++){const [a,b]=[path[i-1],path[i]];if(b.x>=d){const t=(d-a.x)/(b.x-a.x);return a.y+(b.y-a.y)*t-(to.y-from.y)}}
 return null
}
test('the aim puts the arrow through the target at short, long, high and low range',()=>{
 assert.equal(ARROW.speed,3);assert.equal(ARROW.gravity,0.05);assert.equal(ARROW.drag,0.99)
 const eye=new Vec3(0,65.52,0)
 for(const target of [new Vec3(10,65,0),new Vec3(30,65,5),new Vec3(15,75,-8),new Vec3(20,55,0)]){
  const pitch=aimPitch(eye,target)
  assert.ok(Number.isFinite(pitch),'reachable: '+target)
  assert.ok(Math.abs(landsOn(eye,target,pitch))<0.25,`misses ${target} by ${landsOn(eye,target,pitch)}`)
 }
})
test('aim takes the low arc and gives up beyond the bow\'s reach',()=>{
 const eye=new Vec3(0,65.52,0)
 const near=aimPitch(eye,new Vec3(12,65.5,0));assert.ok(near<0.15,'a flat shot at twelve blocks, not a lob: '+near)
 assert.equal(aimPitch(eye,new Vec3(200,65,0)),null,'two hundred blocks is past any arc')
})
test('a moving target is led by its velocity over the flight time',()=>{
 const eye=new Vec3(0,65.52,0),target=new Vec3(20,65,0),velocity=new Vec3(0,0,0.2)
 const {aimAt}=aimPitch.lead(eye,target,velocity)
 assert.ok(aimAt.z>0.8&&aimAt.z<3,'aims ahead of a target walking sideways: '+aimAt.z)
})

import {EventEmitter} from 'node:events'
import minecraftData from 'minecraft-data'
import {shootTarget} from '../src/archery.js'
const registry=minecraftData('1.21.4')
function range({bow=true,arrows=16,distance=15,hitsToKill=2,blocked=null}={}){
 const bot=new EventEmitter(),log=[],items=[...(bow?[{name:'bow',count:1}]:[]),...(arrows?[{name:'arrow',count:arrows}]:[])]
 const zombie={id:7,name:'zombie',type:'hostile',height:1.95,position:new Vec3(0.5,64,0.5+distance),velocity:new Vec3(0,0,0)}
 Object.assign(bot,{registry,entity:{position:new Vec3(0.5,64,0.5),eyeHeight:1.62},entities:{7:zombie},health:20,food:20,inventory:{items:()=>items},
  blockAt:p=>({name:p.y<64?'stone':'air',position:p}),world:{raycast:()=>blocked?{name:blocked}:null},
  async equip(item){log.push('equip '+item.name)},async look(yaw,pitch){bot.aim={yaw,pitch}},
  activateItem(){log.push('draw')},deactivateItem(){if(log.at(-1)!=='draw')return;log.push('release');const a=items.find(i=>i.name==='arrow');a.count--;if(log.filter(l=>l==='release').length>=hitsToKill)setTimeout(()=>{delete bot.entities[7];bot.emit('entityDead',zombie)},5)}})
 return {bot,log,zombie}
}
const api={check(){},stage(){},progress(){}}
const fast={drawMs:20,settleMs:60}
test('shoot draws, aims at the solved pitch and releases until the target dies, and says so',async()=>{
 const r=range()
 const result=await shootTarget(r.bot,{kind:'shoot',goal:{type:'zombie'}},api,fast)
 assert.equal(result.receipt,'killed');assert.equal(result.count,1);assert.equal(result.shots,2);assert.equal(result.arrowsLeft,14)
 assert.deepEqual(r.log.slice(0,3),['equip bow','draw','release'])
 const eye=new Vec3(0.5,65.62,0.5),want=aimPitch(eye,new Vec3(0.5,64+1.95/2,15.5))
 assert.ok(Math.abs(r.bot.aim.pitch-want)<0.01,'pitch '+r.bot.aim.pitch+' vs '+want)
 const facing=Math.atan2(0,-15);assert.ok(Math.hypot(Math.cos(r.bot.aim.yaw)-Math.cos(facing),Math.sin(r.bot.aim.yaw)-Math.sin(facing))<0.01,'facing the target')
})
test('shoot refuses honestly: no bow, no arrows, no clear shot, out of range; and a survivor is not a kill',async()=>{
 await assert.rejects(shootTarget(range({bow:false}).bot,{kind:'shoot',goal:{type:'zombie'}},api,fast),/needs a bow/)
 await assert.rejects(shootTarget(range({arrows:0}).bot,{kind:'shoot',goal:{type:'zombie'}},api,fast),/needs arrows/)
 await assert.rejects(shootTarget(range({blocked:'stone'}).bot,{kind:'shoot',goal:{type:'zombie'}},api,fast),/No clear shot.*stone/)
 await assert.rejects(shootTarget(range().bot,{kind:'shoot',goal:{type:'villager'}},api,fast),/refuses villager/)
 const tough=await shootTarget(range({arrows:3,hitsToKill:99}).bot,{kind:'shoot',goal:{type:'zombie'}},api,fast)
 assert.equal(tough.receipt,'target_survived');assert.equal(tough.count,0);assert.equal(tough.shots,3);assert.equal(tough.arrowsLeft,0)
})

// Run 68 (8 October): a new action missing from one hand-kept list was refused
// live. shoot goes through every gate a planned step meets before it runs.
import {guardIntent} from '../src/companion/intent.js'
import {validatePlan} from '../src/companion/planner.js'
import {validateTaskGoal} from '../src/task-store.js'
test('a planned shoot step passes the plan check, the intent guard and the task check',()=>{
 const plan={reply:'Bow out.',steps:[{action:'shoot',name:'',count:1,item:'blaze',design:[],target:null}]}
 assert.doesNotThrow(()=>validatePlan(plan))
 assert.deepEqual(guardIntent(plan,'shoot the blaze with your bow'),plan)
 assert.deepEqual(validateTaskGoal('shoot',{type:'blaze'}),{type:'blaze'})
 assert.throws(()=>validatePlan({reply:'',steps:[{action:'shoot',name:'',count:1,item:'villager',design:[],target:null}]}),/villager/)
})
