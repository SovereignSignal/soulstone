import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {Vec3} from 'vec3'
import minecraftData from 'minecraft-data'
const registry=minecraftData('1.21.4')
import {legs,validateTravelGoal,travelTo,lineObstruction,LEG,LEG_TIMEOUT_MS} from '../src/travel.js'
import {DoorAwareMovements,allowGroundBreaking,breakableWhileTravelling,TRAVERSAL_DIG_COST} from '../src/navigation.js'
import {validateTaskGoal} from '../src/task-store.js'
import {goalTarget} from '../src/world-skills.js'
import pathfinding from 'mineflayer-pathfinder'
const {goals}=pathfinding

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

test('the staged approach reads a goal that names a block, and one wrapped in a composite',()=>{
 // GoalLookAtBlock keeps its target in `pos`; GoalBlock and GoalNear expose x/z;
 // and approachPlacement wraps EVERY placement in a GoalCompositeAll, which has
 // neither, only `goals`. Reading x/z alone skipped staging for the walk home to
 // the base station; reading x/z and pos skipped it for every build walk, which
 // is why the run stood 39, 76 and 87 blocks from its site at its three build
 // failures and verified zero blocks. The old form of this test asserted the
 // source text of the ladder and would have passed throughout that failure.
 const at=new Vec3(-644,68,-324),world={}
 const xz=t=>t&&[t.x,t.z]
 assert.deepEqual(xz(goalTarget(new goals.GoalNear(at.x,at.y,at.z,2))),[-644,-324],'a plain x/z goal')
 assert.deepEqual(xz(goalTarget(new goals.GoalLookAtBlock(at,world))),[-644,-324],'a goal that names a block')
 assert.deepEqual(xz(goalTarget(new goals.GoalCompositeAll([new goals.GoalLookAtBlock(at,world)]))),[-644,-324],'every placement walk arrives wrapped in this')
 assert.equal(goalTarget(new goals.GoalCompositeAll([])),null,'an empty composite names nowhere')
 assert.equal(goalTarget({}),null,'a goal with no position at all names nowhere')
 const source=readFileSync(new URL('../src/world-skills.js',import.meta.url),'utf8')
 assert.ok(/<=64\)return/.test(source),'short walks are still untouched')
 // The walk home ends at a block-named goal, which is why this mattered.
 const prospecting=readFileSync(new URL('../src/prospecting.js',import.meta.url),'utf8')
 assert.ok(/walk\(new goals\.GoalLookAtBlock\(vec\(station\.position\)/.test(prospecting),'the base walk still targets the station block')
})


test('staged travel follows sloped terrain without requiring the intermediate starting elevation',async()=>{
 const bot={entity:{position:new Vec3(.5,64,.5)},clearControlStates(){},inventory:{items:()=>[]},registry,world:{},blockAt:()=>({name:'air',boundingBox:'empty'}),
 pathfinder:{setMovements(){},setGoal(){},async goto(goal){
  const landing=new Vec3(goal.x,64+Math.floor(goal.x/2),goal.z)
  if(!goal.isEnd(landing))throw Object.assign(new Error('No landing at requested elevation'),{name:'NoPath'})
  bot.entity.position=landing.offset(.5,0,.5)
 }}}
 const r=await travelTo(bot,{kind:'travel',goal:{x:64,y:96,z:0}},{check(){},stage(){},progress(){}})
 assert.equal(r.receipt,'arrived');assert.equal(r.position.y,96);assert.ok(r.legs>=2)
})
test('travel does not report arrival below the destination when goto silently returns without moving',async()=>{
 const bot={entity:{position:new Vec3(.5,64,.5)},clearControlStates(){},inventory:{items:()=>[]},registry,world:{},blockAt:()=>({name:'air',boundingBox:'empty'}),
 pathfinder:{setMovements(){},setGoal(){},async goto(){}}}
 await assert.rejects(travelTo(bot,{kind:'travel',goal:{x:0,y:80,z:0}},{check(){},stage(){},progress(){}}),/without reaching/)
})
test('travel finishes a reachable elevation change even when already horizontally nearby',async()=>{
 let walks=0
 const bot={entity:{position:new Vec3(.5,64,.5)},clearControlStates(){},inventory:{items:()=>[]},registry,world:{},blockAt:()=>({name:'air',boundingBox:'empty'}),
 pathfinder:{setMovements(){},setGoal(){},async goto(goal){walks++;bot.entity.position=new Vec3(goal.x+.5,goal.y,goal.z+.5)}}}
 const r=await travelTo(bot,{kind:'travel',goal:{x:0,y:80,z:0}},{check(){},stage(){},progress(){}})
 assert.equal(walks,1);assert.equal(r.position.y,80);assert.equal(r.receipt,'arrived')
})


test('model-selected travel requires nearby loaded support and safe headroom',async()=>{
 const {validateObservedTravelGoal}=await import('../src/travel.js')
 let override=null
 const bot={registry,entity:{position:new Vec3(.5,64,.5)},blockAt(p){if(override)return override(p);return {name:p.y===63?'dirt':'air',boundingBox:p.y===63?'block':'empty'}}}
 assert.deepEqual(validateObservedTravelGoal(bot,{x:16,y:64,z:0}),{x:16,y:64,z:0})
 assert.throws(()=>validateObservedTravelGoal(bot,{x:200,y:64,z:0}),/96 blocks/)
 for(const name of [null,'water','lava','sweet_berry_bush','stone']){
  override=p=>p.y===63?{name:'dirt',boundingBox:'block'}:name===null?null:{name,boundingBox:name==='stone'?'block':'empty'}
  assert.throws(()=>validateObservedTravelGoal(bot,{x:16,y:64,z:0}),/observed solid support/)
 }
 override=p=>({name:p.y===63?'magma_block':'air',boundingBox:p.y===63?'block':'empty'})
 assert.throws(()=>validateObservedTravelGoal(bot,{x:16,y:64,z:0}),/observed solid support/)
})

test('local terrain waypoints name observed feet cells rather than construction anchors',async()=>{
 const {terrainSummary}=await import('../src/observations.js')
 const bot={entity:{position:new Vec3(.5,64,.5)},players:{},blockAt:p=>({name:p.y<=63?'dirt':'air',boundingBox:p.y<=63?'block':'empty'})}
 const observed=terrainSummary(bot)
 assert.ok(observed.waypoints.length>=4);assert.ok(observed.waypoints.every(p=>p.y===64));assert.ok(observed.waypoints.some(p=>p.x>=16))
 for(const p of observed.waypoints){assert.equal(bot.blockAt(new Vec3(p.x,p.y-1,p.z)).name,'dirt');assert.equal(bot.blockAt(new Vec3(p.x,p.y,p.z)).name,'air')}
})


test('the final travel stage preserves elevation when a lower route shares its horizontal destination',async()=>{
 const upper=new Vec3(16,84,0),lower=new Vec3(16,69,0),visited=[]
 const bot={entity:{position:new Vec3(.5,90,.5)},clearControlStates(){},inventory:{items:()=>[]},registry,world:{},blockAt:()=>({name:'air',boundingBox:'empty'}),
 pathfinder:{setMovements(){},setGoal(){},async goto(goal){
  // Both routes are initially reachable; a descent commits to a lower area
  // without an ascent back. An XZ-only destination accepts that wrong route.
  const candidates=bot.entity.position.y<80?[lower]:[lower,upper]
  const landing=candidates.find(p=>goal.isEnd(p))
  if(!landing)throw Object.assign(new Error('No ascent from lower route'),{name:'NoPath'})
  bot.entity.position=landing.offset(.5,0,.5);visited.push(landing.y)
 }}}
 const r=await travelTo(bot,{kind:'travel',goal:{x:16,y:84,z:0}},{check(){},stage(){},progress(){}})
 assert.equal(r.receipt,'arrived');assert.equal(r.position.y,84)
 assert.ok(visited.every(y=>y>=80),'approach did not choose the lower route merely for horizontal proximity')
})

test('regroup refreshes a moving player between travel legs and records current arrival',async()=>{
 const owner={position:new Vec3(100,70,0)},visited=[]
 const bot={players:{Sov:{entity:owner}},entity:{position:new Vec3(0,70,0)},clearControlStates(){},inventory:{items:()=>[]},registry,world:{},blockAt:()=>({name:'air',boundingBox:'empty'}),pathfinder:{setMovements(){},setGoal(){},async goto(g){visited.push([g.x,g.z]);bot.entity.position=new Vec3(g.x,g.y??70,g.z);if(visited.length===1)owner.position=new Vec3(64,70,40)}}}
 const result=await travelTo(bot,{goal:{x:100,y:70,z:0,player:'Sov'}},{check(){},stage(){},progress(){}})
 assert.deepEqual(result.target,{x:64,y:70,z:40});assert.ok(bot.entity.position.distanceTo(owner.position)<=3)
 assert.deepEqual(validateTaskGoal('travel',{x:1,y:70,z:2,player:'Sov'}),{x:1,y:70,z:2,player:'Sov'})
 assert.throws(()=>validateTravelGoal({x:1,y:70,z:2,player:'not a player'}),/player/)
})

test('regroup refuses stale coordinates when the observed player disappears',async()=>{
 const bot={players:{},entity:{position:new Vec3(0,70,0)}}
 await assert.rejects(travelTo(bot,{goal:{x:100,y:70,z:0,player:'Sov'}},{check(){},stage(){},progress(){}}),/Cannot currently see Sov/)
})

test('regroup cannot claim arrival when the player moves during final elevation approach',async()=>{
 const owner={position:new Vec3(0,80,0)}
 const bot={players:{Sov:{entity:owner}},entity:{position:new Vec3(0,70,0)},clearControlStates(){},inventory:{items:()=>[]},registry,world:{},blockAt:()=>({name:'air',boundingBox:'empty'}),pathfinder:{setMovements(){},setGoal(){},async goto(g){bot.entity.position=new Vec3(g.x,g.y,g.z);owner.position=new Vec3(20,80,0)}}}
 await assert.rejects(travelTo(bot,{goal:{x:0,y:80,z:0,player:'Sov'}},{check(){},stage(){},progress(){}}),/moved during the final approach/)
})


test('nearby regroup first plans the full destination height instead of a horizontal valley waypoint',async()=>{
 const owner={position:new Vec3(90,112,0)},visited=[]
 const bot={players:{Sov:{entity:owner}},entity:{position:new Vec3(0,87,0)},clearControlStates(){},inventory:{items:()=>[]},registry,world:{},blockAt:()=>({name:'air',boundingBox:'empty'}),pathfinder:{setMovements(){},setGoal(){},async goto(g){visited.push(g);assert.equal(g.y,112);bot.entity.position=new Vec3(g.x,g.y,g.z)}}}
 await travelTo(bot,{goal:{x:90,y:112,z:0,player:'Sov'}},{check(){},stage(){},progress(){}})
 assert.equal(visited.length,1);assert.equal(visited[0].x,90)
})

test('travel arrives in the dead band where the goal is satisfied but the float distance is not',async()=>{
 // The loop exits on flat() <= ARRIVE, computed from the raw float position,
 // while the pathfinder satisfies GoalNear against the FLOORED cell. Between
 // those two lies a band where goto() has genuinely arrived and the loop does
 // not believe it, so travel walks in place until the eight-minute deadline and
 // reports "N blocks short". The live run produced exactly that, repeatedly,
 // from five blocks out.
 let walks=0
 const bot={entity:{position:new Vec3(2.5,64,2.5)},clearControlStates(){},inventory:{items:()=>[]},registry,world:{},
  blockAt:()=>({name:'air',boundingBox:'empty'}),
  pathfinder:{setMovements(){},setGoal(){},async goto(){walks++}}}   // already there; the walk changes nothing
 // floor(2.5)=2 → the goal's own isEnd is true at (2,64,2); flat() is 3.54 > ARRIVE
 const r=await travelTo(bot,{kind:'travel',goal:{x:0,y:64,z:0}},{check(){},stage(){},progress(){}})
 assert.equal(r.receipt,'arrived',`must recognise arrival, got ${JSON.stringify(r)}`)
 assert.ok(walks<=1,`and must not keep walking in place: ${walks} walks`)
})

test('a detour is scaled to the gap, and skipped when there is no gap',async()=>{
 // The offset was a flat 16 blocks whatever the distance, applied to the target.
 // Five blocks short, it proposed a cell 16 blocks perpendicular: further away
 // than the bot already was, and outside the region the straight line failed
 // in. The live refusals reconstruct exactly: "5 blocks short of -726,70,-278
 // ... no route to -710,-278" is target.x+16.
 const tried=[]
 const bot={entity:{position:new Vec3(.5,64,5.5)},clearControlStates(){},inventory:{items:()=>[]},registry,world:{},
  blockAt:()=>({name:'air',boundingBox:'empty'}),
  pathfinder:{setMovements(){},setGoal(){},async goto(g){tried.push({x:g.x,z:g.z});throw Object.assign(new Error('No path'),{name:'NoPath'})}}}
 await assert.rejects(travelTo(bot,{kind:'travel',goal:{x:0,y:64,z:0}},{check(){},stage(){},progress(){}}),
  e=>{assert.match(e.message,/no room to detour/,`a 5-block gap has no room for a detour: ${e.message}`);return true})
 const far=tried.filter(t=>Math.hypot(t.x,t.z)>8)
 assert.equal(far.length,0,`no attempt should land further out than the target: ${JSON.stringify(far)}`)
})

test('a refusal names what is on the straight line that travel cannot break',async()=>{
 // Live, 2026-09-22 07:30 PDT: the agent spent twenty minutes alternating
 // `travel` ("No way forward 7 blocks short of -731,55,-274 after three
 // detours") with `climb` ("No pit exit judged from here"), while the target
 // sat behind solid stone. Both refusals were accurate and neither named the
 // one verb that could have worked. travel breaks soft ground and leaves and
 // never stone, so stone across the line is not something a fourth detour
 // solves: it is a fact for whoever picks the next action.
 const wall=x=>x>=3
 const bot={entity:{position:new Vec3(0.5,64,0.5)},clearControlStates(){},inventory:{items:()=>[]},registry,world:{},
  blockAt:p=>wall(p.x)&&(p.y===64||p.y===65)?{name:'stone',boundingBox:'block'}:{name:'air',boundingBox:'empty'},
  pathfinder:{setMovements(){},setGoal(){},goto(){return Promise.reject(Object.assign(new Error('No path to the goal!'),{name:'NoPath'}))}}}
 await assert.rejects(travelTo(bot,{kind:'travel',goal:{x:10,y:64,z:0}},{check(){},stage(){},progress(){}}),e=>{
  assert.match(e.message,/No way forward/)
  assert.match(e.message,/stone 3 blocks ahead/,`the planner needs the obstacle named, got: ${e.message}`)
  return true
 })
})

test('an open line is reported as open, never as an obstruction that is not there',async()=>{
 // The pathfinder searches in three dimensions, so a clear straight line does
 // not mean the goal is reachable. Say what was observed, not a verdict.
 const bot={entity:{position:new Vec3(0.5,64,0.5)},clearControlStates(){},inventory:{items:()=>[]},registry,world:{},
  blockAt:()=>({name:'air',boundingBox:'empty'}),
  pathfinder:{setMovements(){},setGoal(){},goto(){return Promise.reject(Object.assign(new Error('No path to the goal!'),{name:'NoPath'}))}}}
 await assert.rejects(travelTo(bot,{kind:'travel',goal:{x:10,y:64,z:0}},{check(){},stage(){},progress(){}}),e=>{
  assert.doesNotMatch(e.message,/blocks ahead/,`nothing is in the way, got: ${e.message}`)
  assert.match(e.message,/straight line is clear/)
  return true
 })
})

test('leaves on the line are not an obstruction, because travel digs them',()=>{
 const bot={entity:{position:new Vec3(0.5,64,0.5)},registry,
  blockAt:p=>p.x>=3&&(p.y===64||p.y===65)?{name:'spruce_leaves',boundingBox:'block'}:{name:'air',boundingBox:'empty'}}
 assert.equal(lineObstruction(bot,{x:0,y:64,z:0},{x:10,y:64,z:0}),null,'leaves are breakable while travelling')
 bot.blockAt=p=>p.x>=5&&(p.y===64||p.y===65)?{name:'deepslate',boundingBox:'block'}:{name:'air',boundingBox:'empty'}
 assert.deepEqual({...lineObstruction(bot,{x:0,y:64,z:0},{x:10,y:64,z:0}),solid:undefined,sampled:undefined},
  {name:'deepslate',away:5,solid:undefined,sampled:undefined})
})

test('a broken world read never replaces the refusal it was meant to explain',()=>{
 // This runs only inside a failure, where the message already in hand IS the
 // evidence. Yesterday's progressFingerprint bug was exactly this: code that
 // was harmless everywhere it was called before threw a TypeError the moment it
 // was called from a new place.
 assert.equal(lineObstruction({entity:{},registry},{x:0,y:64,z:0},{x:9,y:64,z:0}),null,'no blockAt')
 assert.equal(lineObstruction({blockAt:()=>({name:'stone',boundingBox:'block'})},{x:0,y:64,z:0},{x:9,y:64,z:0}),null,'no registry')
 const angry={registry,blockAt(){throw new TypeError('chunk not loaded')}}
 assert.equal(lineObstruction(angry,{x:0,y:64,z:0},{x:9,y:64,z:0}),null,'a throwing world read is silence, not a second failure')
})

test('a leg that shuffled is not a leg that made progress',async()=>{
 // Live, 2026-09-22 14:57Z: 4 legs, 9 detours, 343 seconds, "12 blocks to go"
 // on every single progress line, and the stall counter never reached 3. A leg
 // counted as movement on `before-flat()>0`, so a bot oscillating in place
 // bought itself a fresh budget with a few centimetres in the right direction
 // and travel burned its whole eight minutes instead of refusing in ninety
 // seconds. This is C7's defect one level up: closing ground is progress,
 // moving is not.
 let walks=0
 const bot={entity:{position:new Vec3(0.5,64,0.5)},clearControlStates(){},inventory:{items:()=>[]},registry,world:{},
  blockAt:()=>({name:'air',boundingBox:'empty'}),
  pathfinder:{setMovements(){},setGoal(){},async goto(){
   walks++
   // The escape hatch keeps this test bounded: if the stall budget never fires,
   // travel arrives instead of spinning out its real eight minute deadline, and
   // assert.rejects fails immediately rather than hanging the suite.
   if(walks>12){bot.entity.position=new Vec3(60.5,64,0.5);return}
   // a shuffle: a few centimetres closer, then back again
   bot.entity.position=new Vec3(0.5+(walks%2?0.2:0.05),64,0.5)
   throw Object.assign(new Error('No path to the goal!'),{name:'NoPath'})
  }}}
 await assert.rejects(travelTo(bot,{kind:'travel',goal:{x:60,y:64,z:0}},{check(){},stage(){},progress(){}}),/No way forward/)
 assert.ok(walks<=12,`three legs of three attempts at most, not a full budget of shuffling: ${walks}`)
})

test('a leg that closed real ground still buys another leg',async()=>{
 // The guard against over-tightening: a slow approach that is genuinely
 // arriving must not be called a stall.
 let walks=0
 const bot={entity:{position:new Vec3(0.5,64,0.5)},clearControlStates(){},inventory:{items:()=>[]},registry,world:{},
  blockAt:()=>({name:'air',boundingBox:'empty'}),
  pathfinder:{setMovements(){},setGoal(){},async goto(goal){
   walks++
   const p=bot.entity.position
   if(p.x>=9.5){bot.entity.position=new Vec3(10.5,64,0.5);return}
   bot.entity.position=new Vec3(p.x+2,64,0.5)          // two blocks closer each leg
   throw Object.assign(new Error('No path to the goal!'),{name:'NoPath'})
  }}}
 const r=await travelTo(bot,{kind:'travel',goal:{x:10,y:64,z:0}},{check(){},stage(){},progress(){}})
 assert.equal(r.receipt,'arrived')
 assert.ok(walks>3,`it kept going past the stall budget because it was actually arriving: ${walks}`)
})
