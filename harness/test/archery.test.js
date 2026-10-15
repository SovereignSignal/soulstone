import test from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {aimPitch,arrowPath,ARROW,lineOfFireBlocker} from '../src/archery.js'

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
  blockAt:p=>({name:p.y<64?'stone':'air',boundingBox:p.y<64?'block':'empty',position:p}),world:{raycast:()=>blocked?{name:blocked}:null},
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

// Security review of 6da6e6c, 9 October: shoot checked only the target's type,
// but an arrow flies on past a miss. A villager, a pet, a player or an armour
// stand in or near the line of fire holds the shot; the family world has kids.
test('a player, a pet or a villager in or beyond the line of fire holds the shot',async()=>{
 const withBystander=(name,type,pos)=>{const r=range();r.bot.entities[8]={id:8,name,type,height:1.8,position:pos,username:type==='player'?'Kid':undefined};return r}
 for(const [name,type,pos] of [['villager','passive',new Vec3(0.5,64,22)],['wolf','animal',new Vec3(1.2,64,8)],['player','player',new Vec3(0.5,64,19)],['armor_stand','living',new Vec3(0.6,64,25)]]){
  const r=withBystander(name,type,pos)
  await assert.rejects(shootTarget(r.bot,{kind:'shoot',goal:{type:'zombie'}},api,fast),/line of fire/,name)
  assert.ok(!r.log.includes('release'),'no arrow loosed with a '+name+' there')
 }
 const cow=withBystander('cow','animal',new Vec3(0.5,64,20))
 assert.equal((await shootTarget(cow.bot,{kind:'shoot',goal:{type:'zombie'}},api,fast)).receipt,'killed','a cow behind the target is not protected')
 const aside=withBystander('villager','passive',new Vec3(9,64,8))
 assert.equal((await shootTarget(aside.bot,{kind:'shoot',goal:{type:'zombie'}},api,fast)).receipt,'killed','a villager well off the line is clear')
})
test('a bystander stepping into the line of fire while the bow is drawn cancels the draw instead of loosing it',async()=>{
 const r=range()
 r.bot.quickBarSlot=0;r.bot.setQuickBarSlot=n=>{r.log.push('slot '+n)}
 const draw=r.bot.activateItem
 r.bot.activateItem=()=>{draw();setTimeout(()=>{r.bot.entities[9]={id:9,name:'cat',type:'animal',height:0.7,position:new Vec3(0.5,64,10)}},5)}
 await assert.rejects(shootTarget(r.bot,{kind:'shoot',goal:{type:'zombie'}},api,{...fast,drawMs:40}),/line of fire.*cat|cat.*line of fire/)
 assert.ok(!r.log.includes('release'),'the drawn arrow was not loosed: '+r.log.join(' '))
 assert.ok(r.log.includes('slot 1'),'the draw was cancelled by changing the held slot')
})

// Security review of ae7e4aa: (1) holding fire must leave no arrow drawn, or the
// runner's cleanup (which calls deactivateItem) looses it after all; (2) the line
// of fire is the arrow's arc, not the straight line to the aim point; (3) the
// protected lists are one read-only check, not exported mutable sets.
import {isProtectedBystander} from '../src/primitives-world.js'
import * as world from '../src/primitives-world.js'
test('after holding fire nothing is left drawn for a later cleanup to loose',async()=>{
 const r=range();r.bot.quickBarSlot=0;r.bot.setQuickBarSlot=n=>{r.log.push('slot '+n)}
 const draw=r.bot.activateItem
 r.bot.activateItem=()=>{draw();setTimeout(()=>{r.bot.entities[9]={id:9,name:'cat',type:'animal',height:0.7,position:new Vec3(0.5,64,10)}},5)}
 await assert.rejects(shootTarget(r.bot,{kind:'shoot',goal:{type:'zombie'}},api,{...fast,drawMs:40}),/line of fire/)
 r.bot.deactivateItem();assert.ok(!r.log.includes('release'),'a cleanup deactivate after the stand-down looses nothing: '+r.log.join(' '))
})
test('the line of fire follows the arc: the arrow passes over a villager on the ground, not one on a ledge in its path',()=>{
 // A 60-block shot from eye height to foot level rises to y 68.5 at the 30-block mark.
 const from=new Vec3(0.5,65.62,0.5),aimAt=new Vec3(0.5,65,60.5),target={id:2,position:new Vec3(0.5,64,60.5)}
 const villagerAt=y=>({entities:{1:{id:1,name:'villager',type:'passive',height:1.9,position:new Vec3(0.5,y,30.5)}},entity:{}})
 assert.equal(lineOfFireBlocker(villagerAt(64),from,aimAt,target),null,'on the ground, 3.5 blocks under the arc: clear (the straight line would have held it)')
 assert.notEqual(lineOfFireBlocker(villagerAt(67),from,aimAt,target),null,'on a ledge where the arc passes: held')
})
test('the protected lists are one read-only check, not exported sets',()=>{
 assert.equal(world.PETS,undefined);assert.equal(world.VILLAGE,undefined);assert.equal(world.PLACED,undefined)
 for(const e of [{type:'player'},{name:'wolf'},{name:'villager'},{name:'armor_stand'},{name:'piglin'}])assert.equal(isProtectedBystander(e),true,JSON.stringify(e))
 for(const e of [{name:'zombie'},{name:'cow'},{name:'blaze'}])assert.equal(isProtectedBystander(e),false,JSON.stringify(e))
})

// Security review of 1993aea: the line of fire stopped twelve blocks past the
// target, and a missed arrow flies on until it lands. The whole flight counts,
// until the arrow falls well below the target or meets a solid block.
test('an upward miss flies far past the target: a villager on a cliff in its path holds the shot; one behind a wall does not',()=>{
 // Aimed at a target 10 out and 10 up, a miss climbs past y 92 at 30 blocks out, far beyond any fixed margin past the target.
 const from=new Vec3(0.5,65.62,0.5),aimAt=new Vec3(0.5,76,10.5),target={id:2,position:new Vec3(0.5,75,10.5)}
 const cliff=(wall)=>({registry,entities:{1:{id:1,name:'villager',type:'passive',height:1.9,position:new Vec3(0.5,91.5,30.5)}},entity:{},
  blockAt:p=>({name:wall&&p.z===wall?'stone':'air',boundingBox:wall&&p.z===wall?'block':'empty'})})
 assert.notEqual(lineOfFireBlocker(cliff(),from,aimAt,target),null,'thirty blocks out, where the climbing arrow passes')
 assert.equal(lineOfFireBlocker(cliff(20),from,aimAt,target),null,'a wall past the target stops the arrow first')
})

// Security review of c90b035: (1) only a full cube ends the flight; an arrow
// passes over a slab or beside a fence post or pane, so a bystander behind one
// still counts. (2) A target straight above or below gave no horizontal line
// and the check returned clear without looking; such a shot comes down by the
// shooter, so a protected bystander close by holds it.
test('a slab or a fence past the target does not end the flight; a full cube does',()=>{
 const from=new Vec3(0.5,65.62,0.5),aimAt=new Vec3(0.5,76,10.5),target={id:2,position:new Vec3(0.5,75,10.5)}
 const cliff=block=>({registry,entities:{1:{id:1,name:'villager',type:'passive',height:1.9,position:new Vec3(0.5,91.5,30.5)}},entity:{},
  blockAt:p=>{const name=p.z===20?block:'air';return {name,boundingBox:name==='air'?'empty':'block'}}})
 for(const partial of ['oak_slab','oak_fence','glass_pane','oak_trapdoor'])assert.notEqual(lineOfFireBlocker(cliff(partial),from,aimAt,target),null,partial+' does not stop the arrow')
 assert.equal(lineOfFireBlocker(cliff('stone'),from,aimAt,target),null,'a full cube does')
})
test('a target straight overhead is clear only with no protected bystander close by',()=>{
 const from=new Vec3(0.5,65.62,0.5),aimAt=new Vec3(0.5,80,0.5),target={id:2,position:new Vec3(0.5,79,0.5)}
 const near={registry,entity:{},entities:{1:{id:1,name:'cat',type:'animal',height:0.7,position:new Vec3(2.5,64,1.5)}}}
 const far={registry,entity:{},entities:{1:{id:1,name:'cat',type:'animal',height:0.7,position:new Vec3(12.5,64,1.5)}}}
 assert.notEqual(lineOfFireBlocker(near,from,aimAt,target),null,'a cat two blocks off holds a shot straight up')
 assert.equal(lineOfFireBlocker(far,from,aimAt,target),null,'one twelve blocks off does not')
})

// Lab, 10 October: a blaze 18 blocks off set off the safety ladder; flee,
// retreat, burrow and hut all failed on open ground and the bot burned to
// death with a bow and 55 arrows in hand, never shooting. A player shoots back.
import {rangedDefenseDecision,edgeExposed} from '../src/archery.js'
function threatened({mob='blaze',distance=15,bow=true,arrows=20,health=20,food=20,extra={}}={}){
 const r=range({bow,arrows})
 Object.assign(r.bot,{health,food,game:{gameMode:'survival',difficulty:'normal'},time:{timeOfDay:6000}})
 r.bot.entity.onGround=true
 r.bot.entities={7:{id:7,name:mob,type:'hostile',height:1.8,position:new Vec3(0.5,64,0.5+distance),velocity:new Vec3(0,0,0)},...extra}
 return r.bot
}
test('a ranged hostile in bow range with a bow, arrows and health is answered with the bow',()=>{
 const yes=rangedDefenseDecision(threatened());assert.equal(yes.engage,true,yes.reason);assert.equal(yes.target.targetName,'blaze')
 assert.equal(rangedDefenseDecision(threatened({mob:'skeleton',distance:20})).engage,true)
 for(const [why,bot,re] of [
  ['no bow',threatened({bow:false}),/bow/],
  ['few arrows',threatened({arrows:2}),/arrows/],
  ['hurt',threatened({health:6}),/Health/],
  ['a zombie',threatened({mob:'zombie'}),/not a ranged/],
  ['a zombie close as well',threatened({extra:{9:{id:9,name:'zombie',type:'hostile',height:1.95,position:new Vec3(2.5,64,2.5)}}}),/close/],
  ['out of range',threatened({distance:40}),/range/]])assert.match(rangedDefenseDecision(bot).reason||'',re,why)
})

test('a nearer blaze behind bricks does not stop a shot at one in the open',()=>{
 // Lab run 90: a blaze five blocks off behind the fortress wall and another ten
 // blocks off in clear view. The decision judged only the nearest, declined,
 // and the bot left the fortress through the portal.
 const bot=threatened({distance:10,extra:{8:{id:8,name:'blaze',type:'hostile',height:1.8,position:new Vec3(-4.5,64,0.5),velocity:new Vec3(0,0,0)}}})
 bot.world={raycast:(from,dir)=>dir.x<-0.5?{name:'nether_bricks',position:new Vec3(-2,65,0)}:null}
 const yes=rangedDefenseDecision(bot)
 assert.equal(yes.engage,true,yes.reason);assert.equal(yes.target.targetId,7,'the one in the open')
 bot.world={raycast:()=>({name:'nether_bricks',position:new Vec3(0,65,2)})}
 assert.match(rangedDefenseDecision(bot).reason,/nether_bricks/,'with both behind bricks, the nearest one\'s reason is given')
 const hoglin=threatened({distance:20,extra:{9:{id:9,name:'hoglin',type:'hostile',height:1.4,position:new Vec3(0.5,64,12.5)}}})
 assert.match(rangedDefenseDecision(hoglin).reason,/hoglin/,'a melee mob between the bot and the blaze still keeps the bow down')
})

import {combatClearance} from '../src/combat.js'
test('after a kill, a blaze behind the wall does not keep the area from clearing',()=>{
 // Lab run 91: the bow killed one blaze, the clearance counted a second one
 // five blocks below behind nether bricks, and the bot fled home through the
 // portal. A shooter with no line to the bot is not a threat until it has one.
 const bot=threatened({distance:5})
 bot.world={getColumn:()=>({}),raycast:()=>({name:'nether_bricks',position:new Vec3(0,65,3)})}
 assert.equal(combatClearance(bot).clear,true,combatClearance(bot).reason)
 bot.world.raycast=()=>null
 assert.equal(combatClearance(bot).clear,false,'in plain view it still holds the area')
 const zombie=threatened({mob:'zombie',distance:5})
 zombie.world={getColumn:()=>({}),raycast:()=>({name:'stone',position:new Vec3(0,65,3)})}
 assert.equal(combatClearance(zombie).clear,false,'a walker behind a wall can still come round it')
})

import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Teammate} from '../src/companion/controller.js'
import {THREAT_INTERRUPTION} from '../src/survival.js'
class ShootRunner extends EventEmitter{
 constructor(bot){super();this.profile='lab';this.owner='Sov';this.ready=true;this.commands=[];this.bot=bot;this.connectionId='3f2504e0-4f89-11d3-9a0c-0305e82c3301'}
 position(){return {x:0,y:64,z:0}}
 command(c){this.commands.push(c);this.task={id:String(this.commands.length),kind:c.action,status:'running',goal:c.goal}}
}
test('the safety controller answers a blaze in bow range with the bow, not a shelter',async()=>{
 const bot=threatened()
 const r=new ShootRunner(bot)
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-companion-')),'state.json'))
 void c.seekSafety(THREAT_INTERRUPTION);await new Promise(res=>setTimeout(res,80))
 const acts=r.commands.map(x=>x.action).filter(a=>a!=='stop');c.cancel?.(true)
 assert.equal(acts[0],'shoot',acts.join(' '));assert.equal(r.commands.find(x=>x.action==='shoot').goal.type,'blaze')
 assert.ok(c.messages.some(m=>/drawing my bow/.test(m.text)),c.messages.map(m=>m.text).join(' | '))
})

test('a second blaze the bow can answer is shot too, not taken as too many to fight',async()=>{
 // Lab run 97, 10 October: two blazes shot in eighteen seconds at full health;
 // a third arrived during the after-kill check, the area did not clear, and
 // the bot fled home through the portal with its rods left on the bridge.
 const bot=threatened({distance:12,extra:{8:{id:8,name:'blaze',type:'hostile',height:1.8,position:new Vec3(0.5,64,16.5),velocity:new Vec3(0,0,0)}}})
 bot.world={...bot.world,getColumn:()=>({}),raycast:()=>null}
 class KillingRunner extends ShootRunner{
  command(c){super.command(c);if(c.action!=='shoot')return
   const target=Object.values(bot.entities).filter(e=>e.name==='blaze').sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position))[0]
   const task=this.task;queueMicrotask(()=>{delete bot.entities[target.id];task.status='completed';task.result={item:'blaze',count:1,receipt:'killed',shots:2};this.emit('event',{type:'task_finished',task})})}
 }
 const r=new KillingRunner(bot)
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-chain-')),'state.json'))
 void c.seekSafety(THREAT_INTERRUPTION);await new Promise(res=>setTimeout(res,2500))
 const acts=r.commands.map(x=>x.action).filter(a=>a!=='stop');c.cancel?.(true)
 assert.deepEqual(acts.filter(a=>a==='shoot').length,2,acts.join(' '))
 assert.ok(!acts.some(a=>['retreat','burrow','hut','use_portal'].includes(a)),'no shelter once both are down: '+acts.join(' '))
})

test('a second blaze that flies out of view ends the chain at the area check, not in shelter',async()=>{
 // Lab run 98: after a kill, the follow-up shot lost its blaze behind the bridge
 // after one arrow, and the bot walled in as if the fight had been lost.
 const bot=threatened({distance:12,extra:{8:{id:8,name:'blaze',type:'hostile',height:1.8,position:new Vec3(0.5,64,16.5),velocity:new Vec3(0,0,0)}}})
 bot.world={...bot.world,getColumn:()=>({}),raycast:()=>null}
 class LosingRunner extends ShootRunner{
  command(c){super.command(c);if(c.action!=='shoot')return
   const shots=this.commands.filter(x=>x.action==='shoot').length,task=this.task
   queueMicrotask(()=>{
    if(shots===1){delete bot.entities[7];task.result={item:'blaze',count:1,receipt:'killed',shots:2}}
    else{delete bot.entities[8];task.result={item:'blaze',count:0,receipt:'target_survived',shots:1,stopped:'target_lost'}}
    task.status='completed';this.emit('event',{type:'task_finished',task})})}
 }
 const r=new LosingRunner(bot)
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-lost-')),'state.json'))
 void c.seekSafety(THREAT_INTERRUPTION);await new Promise(res=>setTimeout(res,2500))
 const acts=r.commands.map(x=>x.action).filter(a=>a!=='stop');c.cancel?.(true)
 assert.equal(acts.filter(a=>a==='shoot').length,2,acts.join(' '))
 assert.ok(!acts.some(a=>['retreat','burrow','hut','use_portal'].includes(a)),'the area is clear once it is gone: '+acts.join(' '))
})

// Lab run 99, 10 October: shooting a blaze from the open end of the fortress
// bridge, the bot was knocked over the edge by a fireball between shots and
// died in the lava sea thirty blocks down, its first blaze rod with it.
function ledge(groundAt){
 const r=range({hitsToKill:1})
 r.bot.blockAt=p=>{const solid=p.y<64&&groundAt(Math.floor(p.x),Math.floor(p.z));return {name:solid?'stone':'air',boundingBox:solid?'block':'empty',position:p}}
 const walked=[]
 r.bot.pathfinder={movements:null,setMovements(m){this.movements=m},setGoal(){},async goto(g){walked.push([g.x,g.y,g.z]);r.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}}
 return {...r,walked}
}
test('the bow steps back from an open edge before it draws',async()=>{
 const r=ledge(x=>x<=1)
 r.bot.entity.position=new Vec3(1.5,64,0.5)
 const out=await shootTarget(r.bot,{kind:'shoot',goal:{type:'zombie'}},api,fast)
 assert.equal(out.receipt,'killed')
 assert.equal(r.walked.length,1,'one step back');assert.ok(r.walked[0][0]<=0,'to a cell with ground all round: '+JSON.stringify(r.walked))
 assert.ok(r.log.indexOf('draw')>=0)
 assert.ok(edgeExposed(r.bot,new Vec3(1,64,0))&&!edgeExposed(r.bot,new Vec3(0,64,0)))
})
test('with every firing spot at an open edge, the bow refuses and says so',async()=>{
 const r=ledge((x,z)=>x===0&&z===0)
 await assert.rejects(shootTarget(r.bot,{kind:'shoot',goal:{type:'zombie'}},api,fast),/open edge/)
 assert.deepEqual(r.log.filter(l=>l==='draw'),[],'never drew at the edge')
})

// Lab, 10 October: shoot fired once at a blaze and finished "target_survived"
// with 47 arrows and 11 shots left: the blaze had dropped out of the entity
// list. Like attack, it re-acquires the same type nearby, and says why it stopped.
test('shoot re-acquires a target that drops out of the entity list, and says why it stopped',async()=>{
 const r=range({hitsToKill:3})
 let swapped=false
 const release=r.bot.deactivateItem
 r.bot.deactivateItem=()=>{release();if(!swapped){swapped=true;const z=r.bot.entities[7];delete r.bot.entities[7];r.bot.entities[11]={...z,id:11,position:z.position.offset(1,0,0)}}}
 r.bot.on=r.bot.on.bind(r.bot)
 const out=await shootTarget(r.bot,{kind:'shoot',goal:{type:'zombie'}},api,fast)
 assert.ok(out.shots>=2,'kept shooting at the re-acquired zombie: '+JSON.stringify(out))
 const gone=range({hitsToKill:99,arrows:5})
 gone.bot.deactivateItem=(()=>{const f=gone.bot.deactivateItem;return()=>{f();delete gone.bot.entities[7]}})()
 const lost=await shootTarget(gone.bot,{kind:'shoot',goal:{type:'zombie'}},api,fast)
 assert.equal(lost.receipt,'target_survived');assert.equal(lost.stopped,'target_lost')
 assert.equal((await shootTarget(range({arrows:2,hitsToKill:99}).bot,{kind:'shoot',goal:{type:'zombie'}},api,fast)).stopped,'out_of_arrows')
})

// Run 87, 10 October: at the fortress, shoot took the nearest blaze, walled in
// behind nether bricks, three times over, while the planner shuffled about. It
// now takes the nearest blaze it can see, and with none in sight steps to a spot
// within four blocks that has a clear line before giving up.
test('shoot takes the nearest target it can see, not the nearest behind a wall',async()=>{
 const r=range({hitsToKill:1})
 r.bot.entities[8]={id:8,name:'zombie',type:'hostile',height:1.95,position:new Vec3(0.5,64,5.5),velocity:new Vec3(0,0,0)}
 // The near zombie is behind a wall; the far one at z 15.5 is in plain view.
 r.bot.world={raycast:(from,dir,range)=>range<8?{name:'nether_bricks'}:null}
 let hit=null;r.bot.on('entityDead',e=>{hit=e.id})
 const out=await shootTarget(r.bot,{kind:'shoot',goal:{type:'zombie'}},api,fast)
 assert.equal(out.receipt,'killed');assert.equal(hit,7,'the visible one')
})
test('with no target in sight, shoot steps to a firing position within four blocks, or says none exists',async()=>{
 const r=range({hitsToKill:1})
 r.bot.pathfinder={setGoal(){},setMovements(){},async goto(g){r.log.push('walk '+[g.x,g.y,g.z]);r.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)},isMoving:()=>false}
 // From x < 2 the bricks hide the zombie; two blocks east the line is clear.
 r.bot.world={raycast:from=>from.x<2?{name:'nether_bricks'}:null}
 const out=await shootTarget(r.bot,{kind:'shoot',goal:{type:'zombie'}},api,fast)
 assert.equal(out.receipt,'killed',JSON.stringify(out));assert.ok(r.log.some(l=>/^walk 2,64,/.test(l)),r.log.join(' | '))
 const walled=range();walled.bot.world={raycast:()=>({name:'nether_bricks'})}
 walled.bot.pathfinder={setGoal(){},setMovements(){},async goto(){},isMoving:()=>false}
 await assert.rejects(shootTarget(walled.bot,{kind:'shoot',goal:{type:'zombie'}},api,fast),/No clear shot at any zombie.*nether_bricks/)
})

// Security review of 35a7589: the step to a firing position walked with whatever
// movements were set, which may dig and place. Like attack's chase it now walks
// with no digging, no towering and no scaffolding, and restores the old profile.
test('the step to a firing position never digs or places, and restores the movement profile',async()=>{
 const r=range({hitsToKill:1}),set=[]
 const before={canDig:true,tag:'runner'}
 r.bot.pathfinder={movements:before,setGoal(){},setMovements(m){set.push(m);this.movements=m},async goto(g){r.log.push('walk '+[g.x,g.y,g.z]+' dig='+this.movements.canDig+' towers='+this.movements.allow1by1towers+' scaffold='+this.movements.scafoldingBlocks.length);r.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)},isMoving:()=>false}
 r.bot.world={raycast:from=>from.x<2?{name:'nether_bricks'}:null}
 await shootTarget(r.bot,{kind:'shoot',goal:{type:'zombie'}},api,fast)
 const walk=r.log.find(l=>l.startsWith('walk'));assert.match(walk,/dig=false towers=false scaffold=0/,walk)
 assert.equal(r.bot.pathfinder.movements,before,'the runner\'s profile is back')
})

// Lab run 101, 10 October: shooting a blaze 3 to 7 blocks off, the bot went from
// 20 health to 5 in five seconds and kept drawing. In the Nether no fire alarm
// stands in (burning there is not an emergency), so nothing stopped the duel;
// it killed the blaze and was fireballed by the next one at 0.07.
test('the bow breaks off a duel at half health once it is being hurt, and says so',async()=>{
 const r=range({arrows:16,hitsToKill:99})
 r.bot.health=20
 const release=r.bot.deactivateItem
 r.bot.deactivateItem=()=>{release();r.bot.health-=4}
 await assert.rejects(shootTarget(r.bot,{kind:'shoot',goal:{type:'zombie'}},api,fast),/Breaking off at 8 health: the zombie survived 3 arrows/)
 const hurt=range({arrows:16,hitsToKill:2});hurt.bot.health=10
 const result=await shootTarget(hurt.bot,{kind:'shoot',goal:{type:'zombie'}},api,fast)
 assert.equal(result.receipt,'killed','starting at half health untouched is no reason to stop')
})

test('after a kill that left the bot at half health or less, it does not stand still for the area check',async()=>{
 // Lab run 101: the blaze fell with the bot on 5 health; the after-kill check then
 // stood five seconds waiting for a quiet it could never declare (health too low),
 // and the next blaze's fireball killed it two seconds in.
 const bot=threatened({distance:12})
 bot.world={...bot.world,getColumn:()=>({}),raycast:()=>null}
 let finishedAt=null
 class HurtRunner extends ShootRunner{
  command(c){super.command(c);if(c.action!=='shoot')return
   const task=this.task;queueMicrotask(()=>{delete bot.entities[7];bot.health=6;task.status='completed';task.result={item:'blaze',count:1,receipt:'killed',shots:3};finishedAt=Date.now();this.emit('event',{type:'task_finished',task})})}
 }
 const r=new HurtRunner(bot)
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-hurt-')),'state.json'))
 void c.seekSafety(THREAT_INTERRUPTION);await new Promise(res=>setTimeout(res,1200))
 const acts=r.commands.map(x=>x.action).filter(a=>a!=='stop');c.cancel?.(true)
 assert.ok(finishedAt,'the shot ran')
 assert.ok(acts.length>1,'something follows the kill within a second, not a five-second wait: '+acts.join(' ')+' | '+c.messages.map(m=>m.text).join(' | '))
})

// Lab runs 99 to 101: a blaze shot over the fortress bridge leaves its rod on the
// bricks; the planner's collect came a round later or, when a safety interruption
// sent the bot home first, never. The shot picks up its own kill's drops.
test('a planned shot picks up what its kill dropped and reports it; one told not to leaves it',async()=>{
 const setup=()=>{
  const r=range({distance:6,hitsToKill:1}),items=r.bot.inventory.items()
  r.bot.on('entityDead',e=>{setTimeout(()=>{r.bot.entities[50]={id:50,name:'item',type:'object',position:new Vec3(e.position.x+0.3,64,e.position.z),getDroppedItem:()=>({name:'blaze_rod',count:1})}},2)})
  const pickup=()=>{for(const [id,x] of Object.entries(r.bot.entities))if(x.getDroppedItem&&Math.hypot(x.position.x-r.bot.entity.position.x,x.position.z-r.bot.entity.position.z)<=1.3){items.push({name:'blaze_rod',count:1});delete r.bot.entities[id]}}
  r.bot.pathfinder={setMovements(){},setGoal(){},async goto(g){r.bot.entity.position=new Vec3(g.x+0.5,64,g.z+0.5);pickup()}}
  r.bot.entity.onGround=true;r.bot.lookAt=async()=>{};r.bot.setControlState=()=>{};r.bot.clearControlStates=()=>{}
  return r
 }
 const r=setup()
 const result=await shootTarget(r.bot,{kind:'shoot',goal:{type:'zombie'}},api,fast)
 assert.equal(result.receipt,'killed');assert.deepEqual(result.collected.gained,{blaze_rod:1},JSON.stringify(result.collected))
 assert.ok(result.at&&Math.abs(result.at.z-6.5)<0.01,'where it died')
 const told=setup()
 const left=await shootTarget(told.bot,{kind:'shoot',goal:{type:'zombie',collect:false}},api,fast)
 assert.equal(left.collected,undefined);assert.ok(!told.bot.inventory.items().some(i=>i.name==='blaze_rod'))
})

test('self-defense shoots without stopping to pick up, then collects where its kills fell once the area is clear',async()=>{
 // Lab run 101: a self-defense kill left the rod on the bricks; the request
 // resumed, more fights came, and the rod was never picked up.
 const bot=threatened({distance:12})
 bot.world={...bot.world,getColumn:()=>({}),raycast:()=>null}
 class KillingRunner extends ShootRunner{
  command(c){super.command(c);const task=this.task
   if(c.action==='shoot')queueMicrotask(()=>{delete bot.entities[7];task.status='completed';task.result={item:'blaze',count:1,receipt:'killed',shots:2,at:{x:0.5,y:64,z:12.5}};this.emit('event',{type:'task_finished',task})})
   if(c.action==='collect')queueMicrotask(()=>{task.status='completed';task.result={receipt:'collected',item:'',gained:1,items:{blaze_rod:1}};this.emit('event',{type:'task_finished',task})})
  }
 }
 const r=new KillingRunner(bot)
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-loot-')),'state.json'))
 c.requestProgress={id:'q',request:'blaze rods',status:'running',completed:[],feedback:[],goal:{criteria:[{kind:'inventory',item:'blaze_rod',count:3}]}}
 void c.seekSafety(THREAT_INTERRUPTION);await new Promise(res=>setTimeout(res,2800))
 const acts=r.commands.map(x=>x.action).filter(a=>a!=='stop');c.cancel?.(true)
 assert.equal(r.commands.find(x=>x.action==='shoot').goal.collect,false,'no pickup between shots')
 const collect=r.commands.find(x=>x.action==='collect')
 assert.ok(collect,'collects after the area check: '+acts.join(' '))
 assert.deepEqual(collect.goal.at,[{x:0.5,y:64,z:12.5}]);assert.deepEqual(collect.goal.items,['blaze_rod'],'only what the request asks for')
 assert.ok(acts.indexOf('collect')>acts.indexOf('shoot'))
 const fed=c.requestProgress.feedback.find(f=>f.action==='shoot')
 assert.deepEqual(fed?.result?.collected?.items,{blaze_rod:1},JSON.stringify(c.requestProgress.feedback))
})

test('a fight that wins a rod the request asks for continues the request even after three fights',async()=>{
 const bot=threatened({distance:12})
 bot.world={...bot.world,getColumn:()=>({}),raycast:()=>null}
 const items=bot.inventory.items()
 class KillingRunner extends ShootRunner{
  command(c){super.command(c);const task=this.task
   if(c.action==='shoot')queueMicrotask(()=>{delete bot.entities[7];task.status='completed';task.result={item:'blaze',count:1,receipt:'killed',shots:2,at:{x:0.5,y:64,z:12.5}};this.emit('event',{type:'task_finished',task})})
   if(c.action==='collect')queueMicrotask(()=>{items.push({name:'blaze_rod',count:1});task.status='completed';task.result={receipt:'collected',item:'',gained:1,items:{blaze_rod:1}};this.emit('event',{type:'task_finished',task})})
  }
 }
 const r=new KillingRunner(bot)
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-gain-')),'state.json'))
 c.requestProgress={id:'q',request:'blaze rods',status:'running',completed:[],feedback:[],goal:{criteria:[{kind:'inventory',item:'blaze_rod',count:3}]},gainKey:'blaze_rod',gainHigh:0,
  combatContinuations:[{completedAt:0,advancedAt:0},{completedAt:0,advancedAt:0},{completedAt:0,advancedAt:0}]}
 let resumed=0;c.resume=async()=>{resumed++}
 void c.seekSafety(THREAT_INTERRUPTION);await new Promise(res=>setTimeout(res,2800))
 c.cancel?.(true)
 assert.equal(c.requestProgress.advances,1,'the rod is an advance')
 assert.equal(resumed,1,'and the request continues: '+c.messages.map(m=>m.text).join(' | '))
})

test('self-defense walks for no drop the request does not ask for',async()=>{
 // Lab run 103: home from the Nether at night, the bot shot a skeleton and walked
 // ten blocks from the portal for its bones; a zombie caught it digging in there.
 const bot=threatened({mob:'skeleton',distance:12})
 bot.world={...bot.world,getColumn:()=>({}),raycast:()=>null}
 class KillingRunner extends ShootRunner{
  command(c){super.command(c);const task=this.task
   if(c.action==='shoot')queueMicrotask(()=>{delete bot.entities[7];task.status='completed';task.result={item:'skeleton',count:1,receipt:'killed',shots:2,at:{x:0.5,y:64,z:12.5}};this.emit('event',{type:'task_finished',task})})
  }
 }
 for(const request of [null,{id:'q',request:'blaze rods',status:'running',completed:[],feedback:[],goal:{criteria:[{kind:'inventory',item:'blaze_rod',count:3},{kind:'at_base',target:'base'}]}}]){
  const r=new KillingRunner(bot);bot.entities[7]={id:7,name:'skeleton',type:'hostile',height:1.99,position:new Vec3(0.5,64,12.5),velocity:new Vec3(0,0,0)}
  const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-bones-')),'state.json'))
  if(request)c.requestProgress=structuredClone(request)
  c.resume=async()=>{}
  void c.seekSafety(THREAT_INTERRUPTION);await new Promise(res=>setTimeout(res,2600))
  const acts=r.commands.map(x=>x.action).filter(a=>a!=='stop');c.cancel?.(true)
  assert.ok(acts.includes('shoot'),acts.join(' '))
  if(!request)assert.ok(!acts.includes('collect'),'no request, no pickup: '+acts.join(' '))
  else assert.deepEqual(r.commands.find(x=>x.action==='collect')?.goal.items??['blaze_rod'],['blaze_rod'],'only rods are worth the walk')
 }
})

test('kills whose fight ended in shelter are picked up when the bot comes out, while the drops last',async()=>{
 // Lab run 111: two rods fell mid-chain, the chain ended in the portal room, and
 // nothing ever went back for them.
 const bot=threatened({distance:12})
 const r=new ShootRunner(bot)
 r.command=function(c){this.commands.push(c);const task=this.task={id:String(this.commands.length),kind:c.action,status:'running',goal:c.goal}
  if(c.action==='collect')queueMicrotask(()=>{task.status='completed';task.result={receipt:'collected',item:'',gained:1,items:{blaze_rod:1}};this.emit('event',{type:'task_finished',task})})}
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-sites-')),'state.json'))
 c.requestProgress={id:'q',request:'collect 3 blaze rods',status:'interrupted',completed:[],feedback:[],goal:null}
 c.killSites=[{at:{x:1,y:64,z:9},time:Date.now()-10000},{at:{x:5,y:64,z:9},time:Date.now()-400000}]
 const got=await c.collectKillSites(new AbortController().signal,bot,c.requestProgress)
 const collect=r.commands.find(x=>x.action==='collect')
 assert.ok(collect,'collects');assert.deepEqual(collect.goal.at,[{x:1,y:64,z:9}],'only sites whose drops have not despawned');assert.deepEqual(collect.goal.items,['blaze_rod'])
 assert.deepEqual(got.items,{blaze_rod:1});assert.deepEqual(c.killSites,[],'picked up once')
 c.killSites=[{at:{x:1,y:64,z:9},time:Date.now()}];c.requestProgress.request='build a house'
 assert.equal(await c.collectKillSites(new AbortController().signal,bot,c.requestProgress),null,'nothing wanted, no walk')
})

// Lab run 146, 15 October: shooting through a hut's firing port, the bow stays in
// cover. Asked to stay, it never walks out to look for a line.
test('a shot asked to stay in cover does not walk to a better spot',async()=>{
 const walk=({stay})=>{
  const r=range(),walked=[]
  r.bot.world={raycast:from=>from.x===0.5&&from.z===0.5?{name:'netherrack'}:null}
  r.bot.pathfinder={movements:null,setMovements(){},setGoal(){},async goto(g){walked.push(g);r.bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}}
  return {run:shootTarget(r.bot,{kind:'shoot',goal:{type:'zombie',...(stay?{stay:true}:{})}},api,fast),walked}
 }
 const free=walk({stay:false});assert.equal((await free.run).receipt,'killed');assert.equal(free.walked.length,1)
 const held=walk({stay:true});await assert.rejects(held.run,/No clear shot.*netherrack/);assert.equal(held.walked.length,0)
})

// Lab run 146, 15 October: in a hut inside a one-wide netherrack tunnel, a blaze
// below eye level outside the tunnel wall. From the middle of the hut the line runs
// into the port's own floor; one step into the port, still under the tunnel roof and
// between its walls, it is clear. The gate judges from there too, and the bow steps in.
function portHut({open=true,blaze=new Vec3(3.5,60,.5)}={}){
 const bot=threatened({distance:5})
 const name=p=>p.x===0&&(p.y===64||p.y===65)&&Math.abs(p.z)<=10?(Math.abs(p.z)===1?'cobblestone':'air'):open&&p.x===1&&p.z===0&&(p.y===64||p.y===65)?'air':p.x>=2?'air':'netherrack'
 bot.blockAt=p=>{const n=name(p);return {name:n,position:p,boundingBox:n==='air'?'empty':'block'}}
 bot.world={raycast:(from,dir,range)=>{for(let d=0.05;d<=range;d+=0.05){const c=from.plus(dir.scaled(d)).floored(),n=name(c);if(n!=='air')return {name:n,position:c}}return null}}
 bot.entities[7].position=blaze
 return bot
}
test('the bow judges the shot from one step into an opened port that is still cover',()=>{
 const yes=rangedDefenseDecision(portHut());assert.equal(yes.engage,true,yes.reason);assert.equal(yes.target.targetName,'blaze')
 assert.match(rangedDefenseDecision(portHut({open:false})).reason,/No clear shot at the blaze: netherrack/,'with nothing open, as before')
})
test('the bow steps into the port for the shot and back into the hut after',async()=>{
 const bot=portHut(),walked=[]
 bot.pathfinder={movements:null,setMovements(){},setGoal(){},async goto(g){walked.push(`${g.x},${g.y},${g.z}`);bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}}
 const result=await shootTarget(bot,{kind:'shoot',goal:{type:'blaze',collect:false,stay:true}},api,fast)
 assert.equal(result.receipt,'killed');assert.deepEqual(walked,['1,64,0','0,64,0'])
 const shut=portHut({open:false});shut.pathfinder=bot.pathfinder;walked.length=0
 await assert.rejects(shootTarget(shut,{kind:'shoot',goal:{type:'blaze',collect:false,stay:true}},api,fast),/No clear shot/);assert.deepEqual(walked,[])
})
test('a step back from the port that lands short is reported, not assumed home; a shot not told to stay takes no port step',async()=>{
 const bot=portHut(),walked=[]
 bot.pathfinder={movements:null,setMovements(){},setGoal(){},async goto(g){walked.push(`${g.x},${g.y},${g.z}`);if(walked.length===1)bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}}
 const result=await shootTarget(bot,{kind:'shoot',goal:{type:'blaze',collect:false,stay:true}},api,fast)
 assert.equal(result.receipt,'killed');assert.deepEqual(result.strayed,{x:1,y:64,z:0})
 // Stepped in, then no shot left from there: the failure says where the bot is.
 const lost=portHut(),moves=[]
 lost.pathfinder={movements:null,setMovements(){},setGoal(){},async goto(g){moves.push(g);if(moves.length===1){lost.entity.position=new Vec3(g.x+.5,g.y,g.z+.5);lost.world.raycast=()=>({name:'netherrack'})}}}
 await assert.rejects(shootTarget(lost,{kind:'shoot',goal:{type:'blaze',collect:false,stay:true}},api,fast),/Not back in the hut: at 1,64,0/)
 const ordinary=portHut(),steps=[]
 ordinary.pathfinder={movements:null,setMovements(){},setGoal(){},async goto(g){steps.push(g)}}
 await assert.rejects(shootTarget(ordinary,{kind:'shoot',goal:{type:'blaze',collect:false}},api,fast),/No clear shot/);assert.deepEqual(steps,[],'ordinary shots keep the old reposition rules')
})
