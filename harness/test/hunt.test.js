import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import registry from 'prismarine-registry'
import {Vec3} from 'vec3'
import {huntFor,validateHuntGoal} from '../src/hunt.js'
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
  attack(e){bot.attacks++;e.health-=7;if(e.health<=0){delete bot.entities[e.id];bot.emit('entityDead',e);inventory.push({name:'raw_beef',count:2},{name:'leather',count:1})}}})
 return {bot,inventory,cow}
}
test('hunt goals are validated in the planner and the task store',()=>{
 assert.deepEqual(validateTaskGoal('hunt',{item:'raw_beef',count:2}),{item:'raw_beef',count:2})
 assert.throws(()=>validateHuntGoal({item:'diamond',count:1}),/farm-animal/);assert.throws(()=>validateHuntGoal({item:'raw_beef',count:9}),/1–8/)
 assert.equal(validatePlan({reply:'Hunting.',steps:[{action:'hunt',name:'',count:2,item:'raw_beef',design:[]}]}).steps[0].action,'hunt')
 assert.throws(()=>validatePlan({reply:'Hunting.',steps:[{action:'hunt',name:'',count:2,item:'zombie',design:[]}]}))
 for(const f of ['raw_beef','raw_porkchop','raw_mutton'])assert.ok(SAFE_FOODS.has(f));assert.equal(SAFE_FOODS.has('raw_chicken'),false)
})
test('hunting closes on the nearest cow, strikes with the axe, collects the drops and reports the count',async()=>{
 const {bot}=fixture()
 const result=await executeSkill(bot,{kind:'hunt',goal:{item:'raw_beef',count:2}},{check(){},stage(){},progress(){},persist(){},movements:{}})
 assert.equal(result.receipt,'hunt_target_reached');assert.equal(result.count,2);assert.equal(result.kills,1);assert.equal(bot.attacks,2)
})
test('hunting stops with a partial result when no animal is in range and pauses for a hostile',async()=>{
 const {bot}=fixture();bot.entities={}
 const none=await huntFor(bot,{kind:'hunt',goal:{item:'raw_beef',count:2}},{check(){},stage(){},progress(){},persist(){}})
 assert.equal(none.receipt,'hunt_partial');assert.equal(none.count,0)
 const {bot:b2}=fixture();b2.entities[5]={id:5,name:'zombie',type:'hostile',position:new Vec3(4,64,4)}
 await assert.rejects(huntFor(b2,{kind:'hunt',goal:{item:'raw_beef',count:2}},{check(){},stage(){},progress(){},persist(){}}),/Hostile zombie nearby/)
})
