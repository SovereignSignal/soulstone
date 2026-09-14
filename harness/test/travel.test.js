import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {Vec3} from 'vec3'
import minecraftData from 'minecraft-data'
const registry=minecraftData('1.21.4')
import {legs,validateTravelGoal,travelTo,LEG,LEG_TIMEOUT_MS} from '../src/travel.js'
import {DoorAwareMovements,allowGroundBreaking,breakableWhileTravelling,TRAVERSAL_DIG_COST} from '../src/navigation.js'
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


test('a traveller breaks soft ground to get out, and nothing else',()=>{
 // The agent digs its own shelters. Walled in by its own dirt, a traveller that
 // cannot break ground reports "no route" and stands there: the whole reason a
 // 138-block journey home ran nine pathfinder calls without moving one block.
 for(const name of ['dirt','grass_block','coarse_dirt','sand','gravel','clay','mud','snow','oak_leaves','birch_leaves'])
  assert.equal(breakableWhileTravelling({name}),true,`${name} should not trap a walker`)
 for(const name of ['stone','deepslate','diamond_ore','crafting_table','chest','furnace','torch','oak_door','white_bed','obsidian'])
  assert.equal(breakableWhileTravelling({name}),false,`${name} must never be broken in passing`)
 assert.equal(breakableWhileTravelling(null),false)
 assert.equal(breakableWhileTravelling({}),false)
})
test('ground breaking is priced into the traversal profile, not left free',()=>{
 const bot={registry,world:{},entity:{position:new Vec3(0.5,64,0.5)},inventory:{items:()=>[]},blockAt:()=>({name:'air',boundingBox:'empty'})}
 const movement=new DoorAwareMovements(bot)
 movement.canDig=false
 allowGroundBreaking(bot,movement)
 assert.equal(movement.canDig,true,'a traveller may dig')
 assert.equal(movement.digCost,TRAVERSAL_DIG_COST)
 assert.ok(TRAVERSAL_DIG_COST>1,'digging must cost more than walking so detours win')
 const exclude=movement.exclusionAreasBreak.at(-1)
 assert.equal(exclude({name:'dirt'}),0,'soft ground is available')
 assert.equal(exclude({name:'stone'}),100,'stone is refused outright, pickaxe or not')
 assert.equal(exclude({name:'crafting_table'}),100,'the base survives the walk home')
})
test('a refused journey names what the pathfinder actually said',async()=>{
 // Nine swallowed rejections read as one silent stall and cost an evening of
 // debugging aimed at the wrong layer. The reason travels with the failure.
 const bot={entity:{position:new Vec3(0.5,64,0.5)},clearControlStates(){},inventory:{items:()=>[]},registry,world:{},blockAt:()=>({name:'air',boundingBox:'empty'}),
  pathfinder:{setMovements(){},setGoal(){},async goto(){throw Object.assign(new Error('No path'),{name:'NoPath'})}}}
 await assert.rejects(travelTo(bot,{kind:'travel',goal:{x:200,y:64,z:0}},{check(){},stage(){},progress(){}}),/no route to/)
 const other={...bot,pathfinder:{setMovements(){},setGoal(){},async goto(){throw new Error('Goal changed underfoot')}}}
 other.entity={position:new Vec3(0.5,64,0.5)}
 await assert.rejects(travelTo(other,{kind:'travel',goal:{x:200,y:64,z:0}},{check(){},stage(){},progress(){}}),/Goal changed underfoot/)
})
test('escape and the shared walk use the same traversal profile as travel',()=>{
 for(const file of ['../src/runner.js','../src/flee.js','../src/travel.js']){
  const source=readFileSync(new URL(file,import.meta.url),'utf8')
  assert.ok(/allowGroundBreaking\(bot ?, ?movements?\)/.test(source),`${file} lets the walker break ground`)
  assert.ok(!/canDig ?[=:] ?false/.test(source),`${file} no longer hard-refuses digging`)
 }
})

test('a leg the harness abandoned is reported as ours, not as the world changing',async()=>{
 // Clearing the goal is how travel abandons a slow leg, and the pathfinder
 // rejects the in-flight goto as "The goal was changed before it could be
 // completed!". Reported raw, that reads like the world moved under us; it was
 // our own stopwatch, and it sent the diagnosis somewhere useless.
 const bot={entity:{position:new Vec3(0.5,64,0.5)},clearControlStates(){},inventory:{items:()=>[]},registry,world:{},blockAt:()=>({name:'air',boundingBox:'empty'}),
  pathfinder:{setMovements(){},setGoal(){},goto(){return new Promise((resolve,reject)=>{bot.pathfinder.reject=reject})}}}
 // Fire the abandon path directly: the goal is cleared, then the goto rejects.
 const original=global.setTimeout
 global.setTimeout=(fn,ms)=>ms===LEG_TIMEOUT_MS?original(()=>{fn();bot.pathfinder.reject(Object.assign(new Error('The goal was changed before it could be completed!'),{name:'GoalChanged'}))},1):original(fn,ms)
 try{
  await assert.rejects(travelTo(bot,{kind:'travel',goal:{x:200,y:64,z:0}},{check(){},stage(){},progress(){}}),/this leg was still walking after 25 seconds/)
 }finally{global.setTimeout=original}
})

test('the staged approach reads a goal that names a block, not just one with x and z',()=>{
 // GoalLookAtBlock keeps its target in `pos`; GoalBlock and GoalNear expose x/z.
 // Reading only x/z silently skipped staging for the walk home to the base
 // station, and for the base door and every station placement with it.
 const source=readFileSync(new URL('../src/world-skills.js',import.meta.url),'utf8')
 const body=source.slice(source.indexOf('async function approach(goal){'),source.indexOf('async function walk(goal,recover=true)'))
 assert.ok(/goal\?\.pos\?\.\[k\]/.test(body),'it falls back to the goal position')
 assert.ok(/<=64\)return/.test(body),'short walks are still untouched')
 // The walk home ends at a block-named goal, which is why this mattered.
 const prospecting=readFileSync(new URL('../src/prospecting.js',import.meta.url),'utf8')
 assert.ok(/walk\(new goals\.GoalLookAtBlock\(vec\(station\.position\)/.test(prospecting),'the base walk still targets the station block')
})
