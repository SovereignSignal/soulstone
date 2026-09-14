import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {Vec3} from 'vec3'
import minecraftData from 'minecraft-data'
const registry=minecraftData('1.21.4')
import {legs,validateTravelGoal,travelTo,LEG} from '../src/travel.js'
import {validateTaskGoal} from '../src/task-store.js'

test('a journey is cut into legs along the line, and a short hop is one leg',()=>{
 assert.deepEqual(legs({x:0,z:0},{x:10,z:0}),[{x:10,z:0}],'inside one leg, go straight there')
 const far=legs({x:0,z:0},{x:130,z:0})
 assert.equal(far.length,Math.ceil(130/LEG))
 assert.deepEqual(far[0],{x:32,z:0});assert.deepEqual(far.at(-1),{x:130,z:0})
 const diagonal=legs({x:0,z:0},{x:0,z:-100})
 assert.equal(diagonal[0].z,-32);assert.equal(diagonal.at(-1).z,-100)
})
test('travel goals are validated and accepted by the task store',()=>{
 assert.deepEqual(validateTravelGoal({x:1.7,y:64.2,z:-3.9}),{x:1,y:64,z:-4})
 for(const bad of [null,{},{x:1,y:2},{x:1,y:2,z:NaN}])assert.throws(()=>validateTravelGoal(bad),/finite/)
 assert.deepEqual(validateTaskGoal('travel',{x:5,y:64,z:5}),{x:5,y:64,z:5})
})
test('a wall across the line is detoured around rather than ending the journey',async()=>{
 let pos=new Vec3(0.5,64,0.5)
 const walked=[]
 const bot={entity:{position:pos},clearControlStates(){},
  pathfinder:{setMovements(){},setGoal(){},async goto(g){
   walked.push([g.x,g.z])
   // The straight line is blocked until the bot has detoured once.
   if(g.z===0&&walked.length===1)throw Object.assign(new Error('No path'),{name:'NoPath'})
   pos=new Vec3(g.x+.5,64,g.z+.5);bot.entity.position=pos
  }},
  inventory:{items:()=>[]},registry,world:{},blockAt:()=>({name:'air',boundingBox:'empty'})}
 const result=await travelTo(bot,{kind:'travel',goal:{x:80,y:64,z:0}},{check(){},stage(){},progress(){}})
 assert.equal(result.receipt,'arrived')
 assert.ok(result.detours>=1,'it stepped off the line at least once')
 assert.ok(result.legs>=2,`a long walk takes several legs (${result.legs})`)
 assert.ok(Math.hypot(bot.entity.position.x-80,bot.entity.position.z-0)<=3)
})
test('a journey with no way forward at all fails with how far it got',async()=>{
 const bot={entity:{position:new Vec3(0.5,64,0.5)},clearControlStates(){},inventory:{items:()=>[]},registry,world:{},blockAt:()=>({name:'air',boundingBox:'empty'}),
  pathfinder:{setMovements(){},setGoal(){},async goto(){throw Object.assign(new Error('No path'),{name:'NoPath'})}}}
 await assert.rejects(travelTo(bot,{kind:'travel',goal:{x:200,y:64,z:0}},{check(){},stage(){},progress(){}}),/No way forward 200 blocks short of 200,64,0 after three detours/)
})

test('every long walk in the world skills closes the gap in stages first',()=>{
 const source=readFileSync(new URL('../src/world-skills.js',import.meta.url),'utf8')
 assert.ok(source.includes('async function approach(goal){'),'a staged approach exists')
 assert.ok(source.includes('await approach(goal)'),'and every walk runs it first')
 assert.ok(source.includes('<=64)return'),'short walks are untouched')
 assert.ok(source.includes('travelTo(bot,'),'using the travel skill')
})

