import test from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import minecraftData from 'minecraft-data'
import {canopyLandings,descendFromCanopy} from '../src/canopy.js'
const cube=[[0,0,0,1,1,1]]
// The footing and the observed ground are parameters, because the bug this file
// guards is a bot standing on its own placed dirt: every fixture here used to
// put leaves under it, which is the one case the old early return let through.
function fixture(footing='oak_leaves',groundAt=new Vec3(3,65,0)){
 const blocks=new Map(),p=new Vec3(.5,70,.5),registry=minecraftData('1.21.4')
 const put=(p,name,shapes=cube)=>blocks.set(p.toString(),{position:p,name,shapes,boundingBox:shapes.length?'block':'empty'})
 put(new Vec3(0,69,0),footing);put(groundAt,'dirt')
 const bot={registry,entity:{position:p,onGround:true},inventory:{items:()=>[]},entities:{},
  blockAt:p=>blocks.get(p.toString())||{position:p,name:'air',shapes:[],boundingBox:'empty'},
  findBlocks:({matching,useExtraInfo})=>{for(const b of blocks.values())matching({...b,position:undefined});return [...blocks.values()].filter(matching).filter(useExtraInfo).map(b=>b.position)},clearControlStates(){},
  pathfinder:{setGoal(){},setMovements(m){this.m=m},async goto(){bot.entity.position=new Vec3(3.5,66,.5)}}}
 return {bot,put,context:{check(){},stage(){},progress(){},movements:{blocksToAvoid:new Set()}}}
}
test('canopy escape targets observed lower natural ground with checked three-block routes',async()=>{
 const {bot,context}=fixture()
 assert.deepEqual(canopyLandings(bot),[new Vec3(3,66,0)])
 bot.pathfinder.goto=async()=>{assert.equal(bot.pathfinder.m.maxDropDown,3);assert.equal(bot.pathfinder.m.allowParkour,false);bot.entity.position=new Vec3(3.5,66,.5)}
 const result=await descendFromCanopy(bot,{},context);assert.equal(result.receipt,'descended_to_ground');assert.equal(result.drop,4)
})
test('unknown, wet, obstructed, partial and canopy landings are refused',()=>{
 for(const [name,shape] of [['water',[]],['oak_leaves',cube],['dirt',[[0,0,0,1,.5,1]]],['oak_planks',cube]]){
  const {bot,put}=fixture();put(new Vec3(3,65,0),name,shape);assert.deepEqual(canopyLandings(bot),[])
 }
 for(const blocker of ['water','oak_planks']){const {bot,put}=fixture();put(new Vec3(3,67,0),blocker,blocker==='water'?[]:cube);assert.deepEqual(canopyLandings(bot),[])}
 const {bot}=fixture();const original=bot.blockAt;bot.blockAt=p=>p.y===67?null:original(p);assert.deepEqual(canopyLandings(bot),[])
})
test('empty successful paths, airborne arrival and cancellation never claim descent',async()=>{
 for(const mode of ['empty','airborne','cancelled']){
  const {bot,context}=fixture();let calls=0
  bot.pathfinder.goto=async()=>{if(mode!=='empty')bot.entity.position=new Vec3(3.5,66,.5);if(mode==='airborne')bot.entity.onGround=false}
  if(mode==='cancelled')context.check=()=>{if(calls++)throw new Error('Cancelled')}
  await assert.rejects(descendFromCanopy(bot,{},context),mode==='empty'?/without reaching/:mode==='airborne'?/stable/:/Cancelled/)
 }
})

import {validateTaskGoal} from '../src/task-store.js'
import {Runner} from '../src/runner.js'
test('the safety descent command crosses the actual runner and task validation boundary',()=>{
 const dispatched=[]
 const runner={closed:false,emit(){},skill(kind,goal,timeout){dispatched.push({kind,goal:validateTaskGoal(kind,goal),timeout})}}
 Runner.prototype.command.call(runner,{action:'descend',goal:{},timeoutMs:45000})
 assert.deepEqual(dispatched,[{kind:'descend',goal:{},timeout:45000}])
})

test('a canopy descent that runs out of time reports a retryable timeout, not a raw pathfinder error',async()=>{
 // The timer cancels the pathfinder goal, which makes goto() REJECT with
 // GoalChanged. The `if(expired)` check after the await was therefore dead
 // code, the raw error escaped, and navigationFailure does not list
 // GoalChanged, so a transient stall became a terminal failure. On the
 // persistent Proxmox world this blocked "get a diamond" for eight hours at
 // the first step with the agent standing in a tree.
 const {bot,context}=fixture()
 bot.pathfinder.goto=async()=>{
  // exactly what mineflayer-pathfinder does when the goal is cleared mid-path
  const e=new Error('The goal was changed before it could be completed!');e.name='GoalChanged'
  throw e
 }
 const original=global.setTimeout
 global.setTimeout=(fn)=>{fn();return {unref(){}}}            // fire the deadline immediately
 try{
  await assert.rejects(()=>descendFromCanopy(bot,{},context),e=>{
   assert.equal(e.name,'Timeout',`a stalled descent must be retryable, got ${e.name}: ${e.message}`)
   assert.match(e.message,/timed out/)
   return true
  })
 } finally { global.setTimeout=original }
})

test('descend runs from any footing more than the drop cap above the ground, not only from leaves',async()=>{
 // 14:13:47Z on the persistent world: the bot stood on its own dirt pillar
 // thirteen blocks up and `descend` refused to even look, because the block
 // under its feet was not a leaf. The refusal was reported in the words of a
 // search that never ran.
 const {bot,context}=fixture('dirt')
 assert.deepEqual(canopyLandings(bot),[new Vec3(3,66,0)],'dirt footing is still a place to descend from')
 const result=await descendFromCanopy(bot,{},context)
 assert.equal(result.receipt,'descended_to_ground');assert.equal(result.drop,4)
})
test('a drop the walking policy can already pay for is travel work, not a descent',async()=>{
 // MIN_DROP names the mechanism rather than the situation: descend exists for
 // drops maxDropDown:3 cannot pay for. A two-block step down is a walk, and
 // without this bound `descend` becomes a general downhill walk the planner can
 // select anywhere and that will usually succeed at nothing in particular.
 const {bot}=fixture('dirt',new Vec3(3,67,0))
 assert.deepEqual(canopyLandings(bot),[],'a two block drop is not a canopy descent')
 await assert.rejects(descendFromCanopy(bot,{},fixture('dirt',new Vec3(3,67,0)).context),/at least 4 blocks below|No observed safe ground/)
})
test('the descent settles on the ground before it judges where it landed',async()=>{
 // requireReachedGoal reads position.floored() against exact-cell goals, so a
 // mid-drop sample at y=77.766 floors to 77 and throws NAVIGATION_INCOMPLETE one
 // line before the symptom. Wait for the fall to finish, then judge.
 const {bot,context}=fixture('dirt')
 let samples=0
 // The footing is stable until the walk starts; from then on the bot is falling
 // for three samples, exactly as the live trace showed at y=77.766.
 bot.pathfinder.goto=async()=>{
  bot.entity.position=new Vec3(3.5,66.766,.5)
  Object.defineProperty(bot.entity,'onGround',{configurable:true,
   get(){if(samples++<3)return false;bot.entity.position=new Vec3(3.5,66,.5);return true},set(){}})
 }
 const result=await descendFromCanopy(bot,{},context)
 assert.equal(result.receipt,'descended_to_ground')
 assert.ok(samples>3,'it waited for the fall to finish')
})
