import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {FOOD_FLOOR,foodPoints,foodFloorDue,nextFoodStep} from '../src/companion/food-floor.js'
import {Teammate} from '../src/companion/controller.js'
const registry=minecraftData('1.21.4')
const points=name=>registry.foodsByName[name]?.foodPoints||0

// pi2, 10 October: diamond reached, no deaths, and the bot went a whole day with no
// food at all. Overnight its health fell from 12 to 1, and with nothing to eat no
// action could bring it back. It needs food in the bag before it needs to eat.
const day=(over={})=>({inventory:{},food:20,health:20,timeOfDay:3000,dimension:'overworld',underRock:false,nearbyAnimals:[],canCook:true,points,now:1e9,last:null,...over})

test('the floor is a full hunger bar of carried food, counted in hunger points',()=>{
 assert.equal(FOOD_FLOOR,20)
 assert.equal(foodPoints({cooked_beef:2,bread:1,cobblestone:64},points),8+8+5)
 assert.equal(foodPoints({chicken:3,rotten_flesh:2},points),0,'raw chicken and rotten flesh are not ordinary food')
})
test('below the floor in Overworld daylight on the surface the errand is due; anywhere else it waits',()=>{
 assert.equal(foodFloorDue(day()).due,true)
 assert.equal(foodFloorDue(day({inventory:{cooked_beef:3}})).due,false,'24 points carried')
 assert.equal(foodFloorDue(day({inventory:{cooked_beef:2}})).due,true,'16 points is under the floor')
 assert.match(foodFloorDue(day({timeOfDay:13000})).reason,/daylight/)
 assert.match(foodFloorDue(day({timeOfDay:10500})).reason,/daylight/,'too late in the day to start a hunt')
 assert.match(foodFloorDue(day({dimension:'the_nether'})).reason,/Overworld/,'no farm animals in the Nether, and its rules stay its own')
 assert.match(foodFloorDue(day({underRock:true})).reason,/rock/,'mining underground: the errand waits for the surface')
 // A hunt that found nothing is not tried again for ten minutes; one that brought food back, two.
 assert.match(foodFloorDue(day({last:{at:1e9-5*60000,outcome:'nothing'}})).reason,/tried/)
 assert.equal(foodFloorDue(day({last:{at:1e9-11*60000,outcome:'nothing'}})).due,true)
 assert.match(foodFloorDue(day({last:{at:1e9-60000,outcome:'gained'}})).reason,/tried/)
 assert.equal(foodFloorDue(day({last:{at:1e9-3*60000,outcome:'gained'}})).due,true)
})
test('the errand cooks raw meat first, hunts for any meat when short, cooks the catch, then eats when hurt or hungry',()=>{
 // Carrying raw beef and able to cook: cook it all, raw plus already cooked.
 assert.deepEqual(nextFoodStep(day({inventory:{beef:3,cooked_beef:1}}),[]),{action:'smelt',goal:{item:'cooked_beef',count:4}})
 // Nothing carried: hunt for meat, four more than the raw meat already held.
 assert.deepEqual(nextFoodStep(day({inventory:{}}),[]),{action:'hunt',goal:{item:'meat',count:4}})
 // A species the planner can see is still 'meat': whichever is nearest.
 assert.deepEqual(nextFoodStep(day({inventory:{mutton:1},canCook:false}),[]),{action:'hunt',goal:{item:'meat',count:5}})
 // After the hunt the catch is cooked, once.
 assert.deepEqual(nextFoodStep(day({inventory:{porkchop:2,beef:1}}),['hunt']),{action:'smelt',goal:{item:'cooked_porkchop',count:2}})
 assert.deepEqual(nextFoodStep(day({inventory:{porkchop:2,beef:1}}),['hunt','smelt:cooked_porkchop']),{action:'smelt',goal:{item:'cooked_beef',count:1}},'each raw kind once')
 // Hurt and below the hunger that heals: eat the best food carried.
 assert.deepEqual(nextFoodStep(day({inventory:{cooked_porkchop:2,beef:1},health:1,food:10}),['hunt','smelt:cooked_porkchop','smelt:cooked_beef']),{action:'eat',goal:{item:'cooked_porkchop',count:2}})
 assert.equal(nextFoodStep(day({inventory:{cooked_porkchop:4},health:20,food:19}),['hunt','smelt:cooked_porkchop']),null,'healthy and fed: done')
 assert.equal(nextFoodStep(day({inventory:{}}),['hunt']),null,'one hunt per errand')
 assert.deepEqual(nextFoodStep(day({inventory:{cooked_beef:1},health:20,food:12}),['hunt']),{action:'eat',goal:{item:'cooked_beef',count:1}},'hungry enough to eat even when healthy')
 assert.equal(nextFoodStep(day({inventory:{cooked_beef:1},health:20,food:12}),['hunt','eat']),null,'one meal per errand')
 // No furnace in reach and no cobblestone for one: hunt and keep the raw meat.
 assert.deepEqual(nextFoodStep(day({inventory:{beef:1},canCook:false}),[]),{action:'hunt',goal:{item:'meat',count:5}})
})

// Controller level: the errand runs before the request's next step, and its steps
// are the bot's own, recorded as automatic feedback and in the journal.
class FakeRunner extends EventEmitter{
 constructor(bot){super();this.profile='food-floor';this.owner='Sov';this.ready=true;this.connectionId='one';this.commands=[];this.bot=bot;this.logs=[]}
 position(){const p=this.bot.entity.position;return {x:p.x,y:p.y,z:p.z}}
 command(c){this.commands.push(c);this.task={id:String(this.commands.length),kind:c.action,status:'running'}}
 log(type,data){this.logs.push([type,data])}
}
function world({health=1,food=10,stock={},timeOfDay=3000}={}){
 const items=Object.entries(stock).map(([name,count])=>({name,count}))
 const set=(name,count)=>{const i=items.find(x=>x.name===name);if(i)i.count=count;else items.push({name,count});for(let k=items.length-1;k>=0;k--)if(items[k].count<=0)items.splice(k,1)}
 const have=name=>items.filter(i=>i.name===name).reduce((n,i)=>n+i.count,0)
 const bot={registry,game:{gameMode:'survival',difficulty:'normal',dimension:'overworld'},time:{timeOfDay},health,food,foodSaturation:0,oxygenLevel:20,players:{},
  entity:{position:new Vec3(0.5,64,0.5),onGround:true,eyeHeight:1.62,isInWater:false,metadata:[0]},entities:{},
  inventory:{items:()=>items.map(i=>({...i}))},
  blockAt:p=>({name:p.y<64?'stone':'air',boundingBox:p.y<64?'block':'empty',position:p,getProperties:()=>({})}),world:{raycast:()=>null},findBlocks:()=>[],findBlock:()=>null}
 return {bot,set,have}
}
function teammate(w,{hunt=4,plans=[]}={}){
 const r=new FakeRunner(w.bot)
 const c=new Teammate(r,{model:'fake',plan:async()=>{plans.push(c.runner.bot.food);return {reply:'Nothing more to do.',steps:[]}}},join(mkdtempSync(join(tmpdir(),'mc-floor-')),'state.json'))
 const commands=[]
 c.execute=async cmd=>{
  commands.push([cmd.action,cmd.goal.item,cmd.goal.count])
  if(cmd.action==='hunt'){
   if(!hunt)throw new Error('Found no meat after 6 search legs and no animals in range. Try a different area, the surface, or another food source.')
   w.set('beef',w.have('beef')+hunt);r.task={id:'h',kind:'hunt',status:'completed',result:{item:'meat',count:w.have('beef'),receipt:'hunt_target_reached'}}
  }else if(cmd.action==='smelt'){
   const raw=cmd.goal.item.replace('cooked_','');w.set(cmd.goal.item,cmd.goal.count);w.set(raw,0)
   r.task={id:'s',kind:'smelt',status:'completed',result:{item:cmd.goal.item,count:cmd.goal.count,receipt:'smelted_output_collected'}}
  }else if(cmd.action==='eat'){
   const before=w.bot.food;w.bot.food=Math.min(20,before+8);w.set(cmd.goal.item,w.have(cmd.goal.item)-1)
   r.task={id:'e',kind:'eat',status:'completed',result:{item:cmd.goal.item,count:1,food:w.bot.food,receipt:'food_consumption_verified'}}
  }else throw new Error('Unexpected command '+cmd.action)
 }
 return {c,r,commands,plans}
}
// A saved request with a task contract: ordinary work the food floor applies to.
const work=(over={})=>({id:'w',request:'mine 10 iron',status:'interrupted',completed:[],pending:[],feedback:[],goal:{kind:'task',summary:'Mine 10 iron',criteria:[{kind:'inventory',item:'raw_iron',count:10,target:'',description:'Carry 10 raw iron'}]},...over})
test('at 1 health with no food in daylight the bot hunts, cooks and eats before planning the request',async()=>{
 const w=world({stock:{cobblestone:64,coal:8}}),{c,r,commands,plans}=teammate(w)
 await c.submit('mine 10 iron',work(),{automatic:true})
 assert.deepEqual(commands,[['hunt','meat',4],['smelt','cooked_beef',4],['eat','cooked_beef',4]])
 assert.equal(plans[0],18,'the planner was first asked only after the errand, with the bot fed')
 assert.equal(commands.length,3,'and the errand did not repeat in later rounds')
 const auto=c.requestProgress.feedback.filter(f=>f.automatic&&f.foodFloor)
 assert.deepEqual(auto.map(f=>[f.action,f.status]),[['hunt','completed'],['smelt','completed'],['eat','completed']])
 const finished=r.logs.find(([type,d])=>type==='food_floor'&&d.phase==='finished')
 assert.ok(finished,'the journal carries the errand');assert.equal(finished[1].outcome,'gained');assert.equal(finished[1].before.points,0);assert.equal(finished[1].after.points,24)
 assert.equal(c.requestProgress.foodFloor.outcome,'gained')
 assert.ok(c.messages.some(m=>/food floor/i.test(m.text)),'it says why it is hunting')
})
test('a hunt that finds nothing is reported honestly and is not retried in the next round',async()=>{
 const w=world({stock:{}}),{c,r,commands,plans}=teammate(w,{hunt:0})
 c.planner.plan=async()=>{plans.push(1);return plans.length<2?{reply:'Working.',steps:[{action:'inspect',name:'',item:'',count:0,design:[]}]}:{reply:'Nothing more to do.',steps:[]}}
 await c.submit('mine 10 iron',work(),{automatic:true})
 assert.deepEqual(commands,[['hunt','meat',4]],'one errand, not one per planning round')
 const failed=c.requestProgress.feedback.find(f=>f.foodFloor&&f.action==='hunt')
 assert.equal(failed.status,'failed');assert.match(failed.reason,/Found no meat/)
 assert.equal(c.requestProgress.foodFloor.outcome,'nothing')
 assert.equal(r.logs.find(([t,d])=>t==='food_floor'&&d.phase==='finished')[1].outcome,'nothing')
 assert.ok(plans.length>=2,'the request kept planning: '+plans.length)
})
test('at night, at the floor, or underground the request goes straight to planning',async()=>{
 const night=world({timeOfDay:14000}),stocked=world({stock:{cooked_beef:3}}),mining=world()
 // Rock overhead: the column above the bot is solid well past eight cells.
 mining.bot.blockAt=p=>({name:p.y<64||p.y>65?'stone':'air',boundingBox:p.y<64||p.y>65?'block':'empty',position:p,getProperties:()=>({})})
 for(const w of [night,stocked,mining]){
  const {c,commands,plans}=teammate(w)
  await c.submit('mine 10 iron',work(),{automatic:true})
  assert.deepEqual(commands,[]);assert.ok(plans.length>=1)
 }
})
test('a request where a person is waiting, or one with no task contract, is not held up for food',async()=>{
 const waiting=work({goal:{kind:'task',summary:'Come to me',criteria:[{kind:'at_owner',item:'',count:0,target:'',description:'Finish near the owner'}]}})
 for(const run of [c=>c.submit('come here',waiting,{automatic:true}),c=>c.submit('hello there')]){
  const {c,commands,plans}=teammate(world())
  await run(c)
  assert.deepEqual(commands,[]);assert.ok(plans.length>=1)
 }
})
test('a hunt paused by a hostile is an interruption, tried again after two minutes, not ten',async()=>{
 const w=world(),{c,commands}=teammate(w)
 c.execute=async cmd=>{commands.push([cmd.action]);throw new Error('Hostile zombie nearby; hunting paused')}
 await c.submit('mine 10 iron',work(),{automatic:true})
 assert.deepEqual(commands,[['hunt']]);assert.equal(c.requestProgress.foodFloor.outcome,'interrupted')
 assert.equal(foodFloorDue(day({last:{at:1e9-3*60000,outcome:'interrupted'}})).due,true)
})

// pi2, 10 October 21:08Z: the second morning's errand hunted from the base, where
// six search legs found nothing, while every kill so far had been 40 to 60 blocks
// west. The last place a hunt killed is remembered as the hunting ground, and an
// errand with no animal in sight walks there before hunting.
test('with no animal in sight the errand walks to the remembered hunting ground before it hunts',()=>{
 const ground={x:50,y:70,z:699}
 const far=day({position:{x:108,y:64,z:680},huntingGround:ground,animalsInSight:0})
 assert.deepEqual(nextFoodStep(far,[]),{action:'go',goal:ground})
 assert.deepEqual(nextFoodStep(far,['go']),{action:'hunt',goal:{item:'meat',count:4}},'once per errand')
 assert.deepEqual(nextFoodStep({...far,animalsInSight:2},[]),{action:'hunt',goal:{item:'meat',count:4}},'animals in sight: hunt here')
 assert.deepEqual(nextFoodStep({...far,position:{x:60,y:70,z:690}},[]),{action:'hunt',goal:{item:'meat',count:4}},'already on the hunting ground')
 assert.deepEqual(nextFoodStep({...far,huntingGround:null},[]),{action:'hunt',goal:{item:'meat',count:4}})
})
test('a hunt that kills is remembered as the hunting ground',()=>{
 const w=world(),{c,r}=teammate(w)
 r.emit('event',{type:'task_finished',task:{id:'h',kind:'hunt',status:'completed',goal:{item:'meat',count:2},result:{item:'meat',count:2,kills:1,position:{x:50.4,y:70,z:699.6}}}})
 assert.deepEqual(c.places.hunting_ground,{x:50.4,y:70,z:699.6,dimension:'overworld'})
 r.emit('event',{type:'task_finished',task:{id:'i',kind:'hunt',status:'completed',goal:{item:'meat',count:2},result:{item:'meat',count:2,kills:0,position:{x:0,y:64,z:0}}}})
 assert.equal(c.places.hunting_ground.x,50.4,'a hunt that killed nothing moves nothing')
})

// pi2, 21:53Z: the errand started at y 54 in the bot's own tunnel, four blocks of
// rock overhead (under the eight that count as roofed), and the hunt's legs got one
// block: "No path to the goal". The errand is for the open surface: in the base the
// roof is one block; more than two overhead is underground.
test('more than two solid blocks overhead is underground for the food errand; a base roof is not',async()=>{
 const pocket=world(),hut=world()
 pocket.bot.blockAt=p=>{const solid=p.y<64||p.y>=66&&p.y<=69;return {name:solid?'stone':'air',boundingBox:solid?'block':'empty',position:p,getProperties:()=>({})}}
 hut.bot.blockAt=p=>{const solid=p.y<64||p.y===66;return {name:solid?'oak_planks':'air',boundingBox:solid?'block':'empty',position:p,getProperties:()=>({})}}
 const a=teammate(pocket);await a.c.submit('mine 10 iron',work(),{automatic:true});assert.deepEqual(a.commands,[],'four blocks of rock overhead')
 const b=teammate(hut);await b.c.submit('mine 10 iron',work(),{automatic:true});assert.equal(b.commands[0]?.[0],'hunt','one roof block overhead')
})
