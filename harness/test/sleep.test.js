import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {bedSite,sleepable,sleepThroughNight,SLEEP_START} from '../src/sleep.js'
import {validateTaskGoal} from '../src/task-store.js'
import {validatePlan} from '../src/companion/planner.js'
const registry=minecraftData('1.21.4')
// A four by four hut with a doorway on the west wall and a torch inside.
const design=[]
for(let x=0;x<4;x++)for(let z=0;z<4;z++)for(let y=0;y<3;y++){
 const edge=x===0||x===3||z===0||z===3
 if(y===2||edge){if(x===0&&z===1&&y<2)continue;design.push({x,y,z,block:'oak_planks'})}
}
const project={build:{origin:{x:0,y:64,z:0},design,wood:'oak_log'},stations:{torch:{position:{x:2,y:64,z:2},confirmed:true}}}
function world(){
 const cells=new Map(),placed=[]
 const bot=new EventEmitter()
 Object.assign(bot,{registry,health:20,food:20,game:{gameMode:'survival',difficulty:'normal'},time:{timeOfDay:14000},entities:{},players:{},isSleeping:false,
  entity:{position:new Vec3(1.5,64,2.5),onGround:true},inventory:{items:()=>inventory},
  blockAt(p){const name=cells.get(p.toString())??(p.y===63?'stone':'air');return {name,position:p.clone(),boundingBox:name==='air'?'empty':(registry.blocksByName[name]?.boundingBox||'block')}},
  findBlock(){return null},
  pathfinder:{setMovements(){},setGoal(){},async goto(g){bot.entity.position=new Vec3(g.x+.5,64,g.z+.5)}},
  async equip(){},async lookAt(){},clearControlStates(){},
  async placeBlock(ref,face){const p=ref.position.plus(face);placed.push(p.toString());cells.set(p.toString(),'white_bed')},
  async sleep(){bot.isSleeping=true;setTimeout(()=>{bot.isSleeping=false;bot.time.timeOfDay=100},60)},
  async wake(){bot.isSleeping=false}})
 const inventory=[{name:'white_bed',count:1}]
 return {bot,cells,placed,inventory}
}
const api={check(){},stage(){},progress(){},persist(){}}
test('a bed needs two clear interior cells away from the doorway and the stations',()=>{
 const {bot}=world()
 const site=bedSite(bot,project)
 assert.ok(site,'a site is found')
 for(const cell of [site.foot,site.head]){
  assert.ok(cell.x>0&&cell.x<3&&cell.z>0&&cell.z<3,'inside the walls')
  assert.notDeepEqual([cell.x,cell.y,cell.z],[2,64,2],'never on the torch')
 }
 assert.equal(site.foot.distanceTo(site.head),1)
})
test('sleeping is only for night or a thunderstorm',()=>{
 assert.equal(sleepable({timeOfDay:6000}),false)
 assert.equal(sleepable({timeOfDay:SLEEP_START}),true)
 assert.equal(sleepable({timeOfDay:6000,thunderstorm:true}),true)
 assert.equal(sleepable({timeOfDay:null}),false)
})
test('the bot places its carried bed, sleeps and reports morning',async()=>{
 const {bot,placed}=world()
 const result=await sleepThroughNight(bot,{kind:'sleep',goal:{project}},api)
 assert.equal(result.receipt,'slept_until_morning')
 assert.equal(placed.length,1)
 assert.ok(result.wokeAt<SLEEP_START,'woke in the morning')
 assert.equal(result.spawnSet,true)
})
test('daylight, a nearby hostile and an empty inventory each refuse plainly',async()=>{
 const day=world();day.bot.time.timeOfDay=6000
 await assert.rejects(sleepThroughNight(day.bot,{kind:'sleep',goal:{project}},api),/Not night/)
 const threat=world();threat.bot.entities={1:{name:'zombie',position:new Vec3(4,64,2)}}
 await assert.rejects(sleepThroughNight(threat.bot,{kind:'sleep',goal:{project}},api),/Cannot sleep with a zombie/)
 const empty=world();empty.inventory.length=0
 await assert.rejects(sleepThroughNight(empty.bot,{kind:'sleep',goal:{project}},api),/none carried/)
})
test('sleep is a valid planner action and task goal',()=>{
 assert.deepEqual(validateTaskGoal('sleep',{}),{})
 const plan=validatePlan({reply:'',steps:[{action:'sleep',name:'',item:'',count:0,design:[]}]})
 assert.equal(plan.steps[0].action,'sleep')
})
