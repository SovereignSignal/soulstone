import {test} from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {inspectEmergencyShelter,assertNoHostileOccupants} from '../src/shelter-occupants.js'
import {Teammate} from '../src/companion/controller.js'
const registry=minecraftData('1.21.4')
function cavity(){
 const cells=new Map([['(0, 60, 0)','air'],['(0, 61, 0)','air']])
 const bot={registry,entity:{position:new Vec3(.5,60,.5),onGround:true},health:20,food:20,game:{gameMode:'survival',difficulty:'easy'},time:{timeOfDay:15000},inventory:{items:()=>[]},entities:{},players:{},
 blockAt(p){const name=cells.has(p.toString())?cells.get(p.toString()):'dirt';return name===null?null:{name,position:p,boundingBox:registry.blocksByName[name]?.boundingBox}}}
 return {bot,cells}
}
test('protection requires a closed, observed, dry cavity with room for the body',()=>{
 const {bot,cells}=cavity();assert.equal(inspectEmergencyShelter(bot).verified,true)
 cells.set('(1, 60, 0)','air');assert.equal(inspectEmergencyShelter(bot).cells,3,'closed material alcove is allowed')
 cells.set('(1, 60, 0)',null);assert.throws(()=>inspectEmergencyShelter(bot),/not observed/)
 cells.set('(1, 60, 0)','water');assert.throws(()=>inspectEmergencyShelter(bot),/liquid/)
 cells.set('(1, 60, 0)','dirt');cells.set('(0, 61, 0)','dirt');assert.throws(()=>inspectEmergencyShelter(bot),/obstructed/)
 cells.set('(0, 61, 0)','air');for(let y=62;y<100;y++)cells.set(`(0, ${y}, 0)`,'air')
 assert.throws(()=>inspectEmergencyShelter(bot),/open or exceeds/)
})
test('hostile bounding boxes inside or straddling the cavity invalidate it; a mob above the roof does not',()=>{
 const {bot}=cavity();bot.entities={1:{name:'zombie',position:new Vec3(.5,63,.5)}}
 assert.equal(inspectEmergencyShelter(bot).verified,true)
 bot.entities[1].position=new Vec3(1.1,60,.5);assert.throws(()=>inspectEmergencyShelter(bot),/potential hostile/)
})
for(const change of ['intruder','breach','damage'])test(`waiting detects a later ${change} without opening up or resuming`,async()=>{
 const {bot,cells}=cavity(),abort=new AbortController()
 const c={epoch:1,runner:{bot,ready:true,connectionId:'same'},safety:{status:'burrowed',retreat:{shelterName:'burrow',surface:{x:0,y:64,z:0}}},requestProgress:null,burrowWait:{quietMs:5,limitMs:1000,watches:1},persist(){},emit(){},say(){},execute(){assert.fail('must not open an unsafe shelter')},resume(){assert.fail('must not resume')}}
 const task=Teammate.prototype.waitInBurrow.call(c,1,abort.signal,bot,false)
 setTimeout(()=>{if(change==='intruder')bot.entities={1:{name:'zombie',position:new Vec3(.5,60,.5)}};if(change==='damage')bot.health=19;if(change==='breach')for(let y=62;y<100;y++)cells.set(`(0, ${y}, 0)`,'air')},30)
 await task
 assert.equal(c.recoveryHistory.at(-1).action,'shelter_watch');assert.equal(c.recoveryHistory.at(-1).status,'failed')
 assert.equal(c.safety.status,'failed');assert.equal(c.safety.protection.verified,false);assert.ok(c.safety.failedAt)
 assert.match(c.safety.error,change==='intruder'?/potential hostile/:change==='damage'?/Health fell/:/open or exceeds/)
})
test('Stop cancels the shelter watch without overwriting the newer safety state',async()=>{
 const {bot}=cavity(),abort=new AbortController()
 const c={epoch:1,runner:{bot,ready:true,connectionId:'same'},safety:{status:'burrowed'},requestProgress:null,burrowWait:{limitMs:1000},persist(){},emit(){},say(){}}
 const task=Teammate.prototype.waitInBurrow.call(c,1,abort.signal,bot,false)
 c.epoch++;c.safety={status:'cancelled'};abort.abort();await task
 assert.deepEqual(c.safety,{status:'cancelled'})
})
// Run 8, 17 October 03:34:15Z: a 1.4-wide hoglin on the platform floor diagonally below the
// two-cell hut grazed the feet cell's corner by 0.002 through the cobblestone at -35,59,-8 and
// -36,59,-7, and the inspection threw "Shelter contains a potential hostile: hoglin".
test('a box grazing a cavity cell through the wall is no occupant; a mob straddling in from open air is',()=>{
 const cells=new Map([['(-36, 59, -8)','air'],['(-36, 60, -8)','air']])
 const bot={registry,entity:{position:new Vec3(-35.5,59,-7.433),onGround:true},health:20,food:20,game:{gameMode:'survival',difficulty:'hard'},time:{timeOfDay:5590},inventory:{items:()=>[]},players:{},
  entities:{1:{name:'hoglin',width:1.4,height:1.4,position:new Vec3(-34.3017578125,58,-6.3017578125)}},
  blockAt(p){const name=cells.get(p.toString())||'cobblestone';return {name,position:p,boundingBox:registry.blocksByName[name].boundingBox}}}
 assert.equal(inspectEmergencyShelter(bot).verified,true,'the live graze')
 // The same hoglin one block on, its box half a block into the hut's open east neighbour.
 cells.set('(-35, 59, -8)','air');bot.entities[1].position=new Vec3(-34.75,59,-7.5);bot.entities[1].width=.9
 assert.throws(()=>assertNoHostileOccupants(bot,[new Vec3(-36,59,-8),new Vec3(-36,60,-8)]),/potential hostile: hoglin/,'a straddling mob in an open neighbouring cell')
 assert.throws(()=>inspectEmergencyShelter(bot),/potential hostile: hoglin/)
})
