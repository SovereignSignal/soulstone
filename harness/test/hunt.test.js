import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import registry from 'prismarine-registry'
import {Vec3} from 'vec3'
import {huntFor,validateHuntGoal,HUNTABLE} from '../src/hunt.js'
import {executeSkill} from '../src/skills.js'
import {validateTaskGoal} from '../src/task-store.js'
import {validatePlan} from '../src/companion/planner.js'
import {SAFE_FOODS} from '../src/survival.js'
function fixture(){
 const bot=new EventEmitter(),reg=registry('1.21.4'),inventory=[{name:'wooden_axe',count:1,maxDurability:59,durabilityUsed:0}]
 const cow={id:9,uuid:'c',type:'animal',name:'cow',height:1.4,position:new Vec3(6,64,0),health:10}
 Object.assign(bot,{registry:reg,health:20,food:8,game:{gameMode:'survival',difficulty:'normal'},time:{timeOfDay:6000},entity:{id:1,type:'player',position:new Vec3(0.5,64,0.5),onGround:true,eyeHeight:1.62},entities:{9:cow},players:{},
  inventory:{items:()=>inventory},world:{raycast:()=>null},blockAt:()=>({name:'air'}),
  pathfinder:{setMovements(){},setGoal(g){if(g&&g.entity)bot.entity.position=new Vec3(g.entity.position.x-1,64,g.entity.position.z)},async goto(g){bot.entity.position=new Vec3(g.x,64,g.z)}},
  async equip(){},async lookAt(){},clearControlStates(){},attacks:0,
  attack(e){bot.attacks++;e.health-=7;if(e.health<=0){delete bot.entities[e.id];bot.emit('entityDead',e);inventory.push({name:'beef',count:2},{name:'leather',count:1})}}})
 return {bot,inventory,cow}
}
test('hunt goals are validated in the planner and the task store',()=>{
 assert.deepEqual(validateTaskGoal('hunt',{item:'beef',count:2}),{item:'beef',count:2})
 assert.throws(()=>validateHuntGoal({item:'diamond',count:1}),/farm-animal/);assert.throws(()=>validateHuntGoal({item:'beef',count:9}),/1–8/)
 assert.equal(validatePlan({reply:'Hunting.',steps:[{action:'hunt',name:'',count:2,item:'beef',design:[]}]}).steps[0].action,'hunt')
 assert.throws(()=>validatePlan({reply:'Hunting.',steps:[{action:'hunt',name:'',count:2,item:'zombie',design:[]}]}))
 for(const f of ['beef','porkchop','mutton'])assert.ok(SAFE_FOODS.has(f));assert.equal(SAFE_FOODS.has('raw_chicken'),false)
})
test('hunting closes on the nearest cow, strikes with the axe, collects the drops and reports the count',async()=>{
 const {bot}=fixture()
 const result=await executeSkill(bot,{kind:'hunt',goal:{item:'beef',count:2}},{check(){},stage(){},progress(){},persist(){},movements:{}})
 assert.equal(result.receipt,'hunt_target_reached');assert.equal(result.count,2);assert.equal(result.kills,1);assert.equal(bot.attacks,2)
})
test('hunting fails when no animal is in range, and pauses for a hostile',async()=>{
 // Was asserted as a partial result until 2026-09-22. A hunt that acquires
 // nothing is a failure; see 'a hunt that kills nothing fails' below.
 const {bot}=fixture();bot.entities={}
 await assert.rejects(huntFor(bot,{kind:'hunt',goal:{item:'beef',count:2}},{check(){},stage(){},progress(){},persist(){}}),/Found no beef/)
 const {bot:b2}=fixture();b2.entities[5]={id:5,name:'zombie',type:'hostile',position:new Vec3(4,64,4)}
 await assert.rejects(huntFor(b2,{kind:'hunt',goal:{item:'beef',count:2}},{check(){},stage(){},progress(){},persist(){}}),/Hostile zombie nearby/)
})
test('with nothing in sight the hunt walks bounded cardinal legs to look, then reports the legs and what it saw',async()=>{
 const {bot,cow}=fixture();bot.entities={}
 const legs=[]
 bot.pathfinder.goto=async g=>{
  bot.entity.position=new Vec3(g.x,64,g.z)
  if(g.y===undefined){legs.push([g.x,g.z]);if(legs.length===2){cow.position=new Vec3(g.x+3,64,g.z);bot.entities[9]=cow}}
 }
 bot.pathfinder.setGoal=g=>{if(g&&g.entity)bot.entity.position=new Vec3(g.entity.position.x-1,64,g.entity.position.z)}
 const result=await huntFor(bot,{kind:'hunt',goal:{item:'beef',count:2}},{check(){},stage(){},progress(){},persist(){}})
 assert.equal(result.acquired,true);assert.equal(result.legs,2)
 assert.deepEqual(legs.slice(0,2),[[33,1],[1,33]],'cardinal legs measured from the start')
})
test('an empty area ends the hunt after six legs, naming any other animals it found',async()=>{
 const {bot}=fixture();bot.entities={}
 const messages=[];let walked=0
 bot.pathfinder.goto=async g=>{
  bot.entity.position=new Vec3(g.x,64,g.z)
  if(g.y===undefined&&++walked===6)bot.entities[11]={id:11,name:'pig',type:'animal',position:new Vec3(g.x+2,64,g.z)}
 }
 // The legs walked and the animals seen still have to reach the planner; they
 // now travel in the refusal rather than in a completed receipt.
 await assert.rejects(huntFor(bot,{kind:'hunt',goal:{item:'beef',count:2}},{check(){},stage(){},progress:m=>messages.push(m),persist(){}}),
  e=>{assert.match(e.message,/6 search legs/,e.message);assert.match(e.message,/pig/,'it still names what it did see');return true})
 assert.equal(walked,6)
 assert.ok(messages.some(m=>/after 6 exploring legs \(nearby animals: pig\)/.test(m)),messages.at(-1))
})
test('the search walk never sprints, since sprinting burns the hunger the hunt is meant to restore',async()=>{
 const {bot}=fixture();bot.entities={}
 const policies=[];let walks=0
 bot.pathfinder.setMovements=m=>policies.push(m.allowSprinting)
 bot.pathfinder.goto=async g=>{bot.entity.position=new Vec3(g.x,64,g.z);if(g.y===undefined)walks++}
 // The empty search now ends in a refusal; the movement policy is what this test is about.
 await huntFor(bot,{kind:'hunt',goal:{item:'beef',count:1}},{check(){},stage(){},progress(){},persist(){}}).catch(()=>{})
 assert.equal(walks,6)
 assert.ok(policies.includes(false),'a non-sprinting policy is used for the search')
 assert.equal(policies.at(-1),true,'the chase policy is restored afterwards')
})
test('every huntable drop and safe food is a real item in the game registry',()=>{
 const reg=registry('1.21.4')
 for(const item of Object.keys(HUNTABLE))assert.ok(reg.itemsByName[item],`HUNTABLE names a real item: ${item}`)
 for(const item of SAFE_FOODS)assert.ok(reg.itemsByName[item],`SAFE_FOODS names a real item: ${item}`)
 for(const item of SAFE_FOODS)assert.ok(reg.foodsByName[item],`SAFE_FOODS names something edible: ${item}`)
 assert.equal(SAFE_FOODS.has('chicken'),false,'raw chicken causes food poisoning')
 assert.deepEqual(HUNTABLE.porkchop,['pig'])
})

test('a hunt that kills nothing fails; it does not report a partial success',async()=>{
 // Live evidence from the persistent world: twelve consecutive hunts returned
 // status "completed" carrying {count:0, kills:0, acquired:false} while the
 // agent sat at 0/20 hunger and 10/20 health. Because the step completed, the
 // planner had no reason to try berries, a different area, or anywhere above
 // ground, and it starved holding a receipt that said food was handled.
 // Partial means "I got some of what I wanted". Zero is a failure.
 const {bot}=fixture();bot.entities={}
 await assert.rejects(
  huntFor(bot,{kind:'hunt',goal:{item:'beef',count:2}},{check(){},stage(){},progress(){},persist(){}}),
  e=>{
   assert.match(e.message,/no beef/i,`the refusal names what it was after: ${e.message}`)
   assert.match(e.message,/leg/i,'and how far it looked, so the planner can judge trying elsewhere')
   return true
  })
})

// pi2, 10 October 09:15 PDT: two dawn hunts asked for beef, and only cows count
// for beef. With a pig and a chicken within 64 blocks and the nearest cow past
// 100, a hunt for food has to take whichever farm animal it finds.
test('a hunt for meat takes the nearest farm animal of any kind and counts every raw meat',async()=>{
 const {bot,inventory}=fixture()
 const pig={id:12,uuid:'p',type:'animal',name:'pig',height:0.9,position:new Vec3(4,64,0),health:10}
 bot.entities={12:pig}
 bot.attack=e=>{bot.attacks++;e.health-=7;if(e.health<=0){delete bot.entities[e.id];bot.emit('entityDead',e);inventory.push({name:'porkchop',count:2})}}
 inventory.push({name:'beef',count:1})
 const result=await huntFor(bot,{kind:'hunt',goal:{item:'meat',count:3}},{check(){},stage(){},progress(){},persist(){}})
 assert.equal(result.item,'meat');assert.equal(result.count,3,'one beef carried plus two porkchops');assert.equal(result.receipt,'hunt_target_reached');assert.equal(result.kills,1)
 assert.deepEqual(validateHuntGoal({item:'meat',count:4}),{item:'meat',count:4})
 assert.equal(validatePlan({reply:'Food.',steps:[{action:'hunt',name:'',count:4,item:'meat',design:[]}]}).steps[0].item,'meat')
 const {bot:empty}=fixture();empty.entities={}
 await assert.rejects(huntFor(empty,{kind:'hunt',goal:{item:'meat',count:2}},{check(){},stage(){},progress(){},persist(){}}),/Found no meat/)
})

// pi2, 10 October 20:50Z: a hunt for meat west of the base gave up the moment one
// chicken could not be reached ("Cannot reach the chicken") with a cow and two
// more chickens in range. One animal out of reach is not the hunt out of reach.
test('an animal the hunt cannot reach is passed over for the next one',async()=>{
 const {bot,cow}=fixture()
 const chicken={id:7,uuid:'h',type:'animal',name:'chicken',height:0.7,position:new Vec3(4,64,2),health:4}
 bot.entities={7:chicken,9:cow}
 // The chicken sits on a ledge the walk never reaches; the cow is on open ground.
 bot.pathfinder.setGoal=g=>{if(g&&g.entity?.name==='cow')bot.entity.position=new Vec3(g.entity.position.x-1,64,g.entity.position.z)}
 const result=await huntFor(bot,{kind:'hunt',goal:{item:'meat',count:2}},{check(){},stage(){},progress(){},persist(){},contactMs:60})
 assert.equal(result.acquired,true);assert.equal(result.kills,1);assert.deepEqual(result.unreachable,['chicken'])
})
