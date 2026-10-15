import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {threatReach,threatRoutes} from '../src/threat-reach.js'
import {survivalObservation,emergencyReason,THREAT_INTERRUPTION} from '../src/survival.js'
import {Teammate} from '../src/companion/controller.js'
const registry=minecraftData('1.21.4')
// Trial 42, 1 October 2026: the bot stood in its own two-cell hut at y -36 in
// deepslate while a cave thirteen blocks below held the mobs recorded here.
// Seven planning episodes were interrupted and 24 of 30 minutes spent blocked.
const HUT=new Vec3(-595,-36,-333)
const RECORDED=[['creeper',-600.16,-49,-325.84],['zombie',-601.41,-49,-342.56],['skeleton',-604.28,-50,-323.7],['skeleton',-611.51,-49,-329.14],['creeper',-608.59,-49,-321.97]]
function trial42({mobs=RECORDED}={}){
 const cells=new Map([HUT,HUT.offset(0,1,0)].map(c=>[c.toString(),'air']))
 const name=p=>cells.has(p.toString())?cells.get(p.toString()):p.y>=-50&&p.y<=-48&&p.x<=-598?'air':'deepslate'
 const bot={registry,game:{gameMode:'survival',difficulty:'easy',dimension:'overworld'},time:{timeOfDay:6735},health:20,food:17,oxygenLevel:20,players:{},
  entity:{position:new Vec3(-594.58,-36,-332.5),onGround:true,eyeHeight:1.62,isInWater:false,metadata:[0]},inventory:{items:()=>[]},
  entities:Object.fromEntries(mobs.map(([n,x,y,z],i)=>[i+1,{id:i+1,name:n,position:new Vec3(x,y,z)}])),
  blockAt(p){const n=name(p);return n===null?null:{name:n,position:p,boundingBox:registry.blocksByName[n]?.boundingBox,getProperties:()=>({})}},
  world:{raycast:()=>({name:'deepslate'})}}
 return {bot,cells}
}
const air=(cells,...list)=>{for(const c of list)cells.set(c.toString(),'air')}
// A shaft from the hut's level down into the cave the mobs stand in.
const breach=cells=>{for(let y=-37;y>=-47;y--)air(cells,new Vec3(-599,y,-333));for(let x=-599;x<=-596;x++)air(cells,new Vec3(x,-36,-333))}
const reach=bot=>threatReach(bot,survivalObservation(bot).nearbyThreats)
test('hostiles in a cave the bot\'s space does not touch are sealed off, from a hut and from a long tunnel',()=>{
 const {bot,cells}=trial42()
 assert.deepEqual(reach(bot),['sealed','sealed','sealed','sealed','sealed'])
 // The ordinary mining case: a tunnel and a shaft that run on past the search
 // radius toward the surface. Leaving the radius is a long way round, not a route in.
 for(let x=1;x<=12;x++)air(cells,HUT.offset(x,0,0),HUT.offset(x,1,0))
 for(let y=2;y<=60;y++)air(cells,HUT.offset(12,y,0))
 assert.deepEqual(reach(bot),['sealed','sealed','sealed','sealed','sealed'])
})
test('a route to the cave, a hostile in the bot\'s own tunnel, unloaded rock and too much space are not sealed',()=>{
 // The last two stand past twenty blocks; the search widens to wherever the hostiles it is asked about are.
 const open=trial42();breach(open.cells)
 assert.deepEqual(reach(open.bot),['open','open','open','open','open'])
 const inside=trial42({mobs:[...RECORDED,['zombie',-590.5,-36,-332.5]]});for(let x=1;x<=6;x++)air(inside.cells,HUT.offset(x,0,0),HUT.offset(x,1,0))
 const s=survivalObservation(inside.bot).nearbyThreats;assert.equal(s[0].name,'zombie')
 assert.deepEqual(threatReach(inside.bot,s),['open','sealed','sealed','sealed','sealed','sealed'])
 const unloaded=trial42();unloaded.cells.set(HUT.offset(1,0,0).toString(),null)
 assert.deepEqual(reach(unloaded.bot),['unknown','unknown','unknown','unknown','unknown'])
 const vast=trial42();assert.deepEqual(threatReach(vast.bot,survivalObservation(vast.bot).nearbyThreats,{limit:1}),['unknown','unknown','unknown','unknown','unknown'])
})
test('a hostile sealed off behind rock interrupts only inside the close floors; anything else keeps the rule',()=>{
 const {bot}=trial42(),observed=survivalObservation(bot)
 assert.equal(observed.nearbyThreats[0].distance,15.6);assert.equal(observed.nearbyThreats[0].verticalOffset,-13)
 assert.equal(emergencyReason(observed),THREAT_INTERRUPTION,'without reach evidence the rule is unchanged')
 const all=(reach,sightline='blocked')=>({...observed,nearbyThreats:observed.nearbyThreats.map(t=>({...t,reach,sightline:{status:sightline}}))})
 assert.equal(emergencyReason(all('sealed')),null,'the recorded trial 42 interruption')
 assert.equal(emergencyReason(all('unknown')),THREAT_INTERRUPTION,'an inconclusive search proves nothing')
 assert.equal(emergencyReason(all('open')),THREAT_INTERRUPTION)
 assert.equal(emergencyReason(all('sealed','clear')),THREAT_INTERRUPTION,'a hostile that can see the bot counts whatever the search says')
 assert.equal(emergencyReason(all('sealed','unknown')),THREAT_INTERRUPTION)
 const at=(name,distance)=>({...observed,nearbyThreats:[{name,distance,risk:'potential_hostile',reach:'sealed',sightline:{status:'blocked'}}]})
 assert.equal(emergencyReason(at('skeleton',16)),null)
 assert.equal(emergencyReason(at('zombie',8)),null)
 assert.equal(emergencyReason(at('creeper',4)),THREAT_INTERRUPTION,'a creeper near fuse range');assert.equal(emergencyReason(at('creeper',10)),null,'sealed at ten it cannot see the bot to fuse')
 assert.equal(emergencyReason(at('zombie',3)),THREAT_INTERRUPTION,'a hostile through one block of rock');assert.equal(emergencyReason(at('zombie',6)),null,'six blocks of rock is rock (lab run 27)')
 assert.equal(emergencyReason(at('warden',9)),THREAT_INTERRUPTION,'a warden hits through walls')
 assert.equal(emergencyReason(at('vex',9)),THREAT_INTERRUPTION,'a vex passes through walls')
})
class FakeRunner extends EventEmitter{
 constructor(bot){super();this.profile='lab';this.owner='Sov';this.ready=true;this.commands=[];this.bot=bot}
 position(){const p=this.bot.entity.position;return {x:p.x,y:p.y,z:p.z}}
 command(c){this.commands.push(c);this.task={id:String(this.commands.length),status:'running'}}
}
test('the survival tick leaves the bot working behind rock and interrupts once its space opens onto the cave',()=>{
 const {bot,cells}=trial42(),r=new FakeRunner(bot)
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-sealed-')),'state.json'))
 const calls=[],logs=[];c.seekSafety=async why=>{calls.push(why);c.safety={status:'retreating',reason:why}};r.log=(type,data)=>logs.push([type,data])
 r.emit('event',{type:'survival_tick'});assert.deepEqual(calls,[],'sealed from every recorded mob')
 // Only the creeper is inside its own radius; the zombie at 17.8 never pressed.
 assert.deepEqual(logs,[['threat_sealed',{threats:['creeper@15.6/-13:sealed']}]])
 r.emit('event',{type:'survival_tick'});assert.equal(logs.length,1,'logged once per half minute, not every tick')
 breach(cells)
 // The route is now open but long: four blocks of tunnel, an eleven-block shaft
 // (no mob climbs one) and the cave floor, about 25 steps for a creeper whose
 // sight is blocked. Run 46, 3 October: thirty shelter cycles on one such skeleton.
 r.emit('event',{type:'survival_tick'});assert.deepEqual(calls,[],'a long way round with no sight is not yet an interruption')
 const creeper=Object.values(bot.entities).find(e=>e.name==='creeper');creeper.position=new Vec3(-598.5,-48,-332.5)
 r.emit('event',{type:'survival_tick'});assert.deepEqual(calls,[THREAT_INTERRUPTION],'at the foot of the shaft the route is short and the rule fires')
})
test('the flood reports the length of the shortest open route',()=>{
 const {bot,cells}=trial42();breach(cells)
 const creeper=Object.values(bot.entities).find(e=>e.name==='creeper')
 const [far]=threatRoutes(bot,[{position:creeper.position}]);assert.equal(far.reach,'open');assert.ok(far.steps>24,'about 25: '+far.steps)
 const [near]=threatRoutes(bot,[{position:new Vec3(-598.5,-48,-332.5)}]);assert.ok(near.steps<=20,'down the shaft: '+near.steps)
 assert.deepEqual(threatRoutes(trial42().bot,[{position:creeper.position}]),[{reach:'sealed',steps:null}])
})

test('a shut door is a wall to the reach flood below Hard; open, or on Hard, it is a way through',()=>{
 // Lab run 24, 3 October: one cell under its own floor the bot was no longer
 // on an interior cell, the threat rule asked the flood, and the flood walked
 // out through the closed door to a spider in a cave. On Normal nothing opens
 // or breaks that door.
 const make=({open,difficulty='normal'})=>{
  // A 1x1 cell at y 64 with a door on its +z side opening on to the mob's space.
  const cells=new Map([[new Vec3(0,64,0).toString(),'air'],[new Vec3(0,65,0).toString(),'air'],[new Vec3(0,64,1).toString(),'spruce_door'],[new Vec3(0,65,1).toString(),'spruce_door']])
  for(let z=2;z<=12;z++)for(const y of [64,65])cells.set(new Vec3(0,y,z).toString(),'air')
  const bot={registry,game:{gameMode:'survival',difficulty,dimension:'overworld'},entity:{position:new Vec3(.5,64,.5)},
   blockAt(p){const n=cells.get(p.toString())||'stone';return {name:n,position:p,boundingBox:registry.blocksByName[n]?.boundingBox,getProperties:()=>n==='spruce_door'?{open,half:p.y===64?'lower':'upper'}:{}}}}
  return threatReach(bot,[{name:'zombie',position:new Vec3(.5,64,10.5)}])[0]
 }
 assert.equal(make({open:false}),'sealed');assert.equal(make({open:true}),'open');assert.equal(make({open:false,difficulty:'hard'}),'open','on Hard a zombie breaks the door')
})

test('a sealed melee mob counts only within three blocks; a sealed creeper within four; wall-breachers always',()=>{
 // Lab run 27, 3 October: at y 50 the bot was interrupted every few seconds by
 // skeletons and cave spiders at 5.2 to 6.0 blocks, each sealed and blocked,
 // and spent the night burrowing, clearing and unburrowing in place.
 const o={health:18,food:12,gameMode:'survival',difficulty:'normal',timeOfDay:6000}
 const sealed=(name,distance)=>({risk:'potential_hostile',name,distance,reach:'sealed',sightline:{status:'blocked'}})
 assert.equal(emergencyReason({...o,nearbyThreats:[sealed('skeleton',5.3),sealed('cave_spider',4),sealed('zombie',3.1)]}),null)
 assert.equal(emergencyReason({...o,nearbyThreats:[sealed('zombie',2.9)]}),THREAT_INTERRUPTION,'through one block of rock it still counts')
 assert.equal(emergencyReason({...o,nearbyThreats:[sealed('creeper',3.9)]}),THREAT_INTERRUPTION);assert.equal(emergencyReason({...o,nearbyThreats:[sealed('creeper',5.5)]}),null,'run 47: sealed creepers in the cave below')
 assert.equal(emergencyReason({...o,nearbyThreats:[sealed('warden',9)]}),THREAT_INTERRUPTION)
 assert.equal(emergencyReason({...o,nearbyThreats:[{...sealed('zombie',5),reach:'open'}]}),THREAT_INTERRUPTION,'an open route is an interruption at any distance inside the radius')
})
// Fresh-world test on pi1, 9 October: hurt to 9 with no food, a creeper sealed
// three blocks below behind snow. The health alarm counted any hostile within
// sixteen blocks while the shelter's clearance judged it by reach: walled in,
// "Daylight with no hostile nearby. Opening up.", walled in again, every 22
// seconds for over an hour, and the planner was never called.
test('the health alarm judges a hidden hostile by reach, as the threat alarm and the clearance do',async()=>{
 const {emergencyReason,HEALTH_EMERGENCY}=await import('../src/survival.js')
 const o={gameMode:'survival',health:9,difficulty:'normal',timeOfDay:6000,sheltered:false,shelterAvailable:false,food:17,carriedFood:[],nearbyThreats:[]}
 const hidden=(name,distance,reach)=>({risk:'potential_hostile',name,distance,reach,sightline:{status:'blocked'}})
 assert.equal(emergencyReason({...o,nearbyThreats:[hidden('creeper',9.9,'sealed')]}),null,'the pi1 creeper')
 assert.equal(emergencyReason({...o,nearbyThreats:[hidden('zombie',13,'sealed')]}),null)
 assert.equal(emergencyReason({...o,nearbyThreats:[hidden('creeper',9.9,'open')]}),HEALTH_EMERGENCY,'a route in still counts')
 assert.equal(emergencyReason({...o,nearbyThreats:[{...hidden('zombie',13,'sealed'),sightline:{status:'clear'}}]}),HEALTH_EMERGENCY,'in sight still counts')
})
import {outOfReach,farRoute,ROUTE_FACTOR} from '../src/survival.js'
test('out of reach: sealed, or out of sight with a route longer than one and a half alarm radii; never a wall-breacher or a close one',()=>{
 const t=(name,distance,reach,routeSteps,sight='blocked')=>({name,distance,reach,routeSteps,sightline:{status:sight},risk:'potential_hostile'})
 assert.equal(ROUTE_FACTOR,1.5)
 assert.equal(outOfReach(t('skeleton',15.8,'open',25)),true,'run 46: the skeleton round the cave');assert.equal(outOfReach(t('skeleton',15.8,'open',24)),false)
 assert.equal(outOfReach(t('zombie',8,'open',16)),true);assert.equal(outOfReach(t('zombie',8,'open',15)),false)
 assert.equal(outOfReach(t('zombie',8,'open',40,'clear')),false,'in sight counts whatever the route')
 assert.equal(outOfReach(t('zombie',2.5,'open',40)),false,'within the rock floor it counts');assert.equal(outOfReach(t('warden',12,'open',60)),false,'a warden always counts')
 assert.equal(outOfReach(t('zombie',8,'unknown',null)),false,'an inconclusive flood proves nothing')
 assert.equal(outOfReach(t('zombie',8,'sealed',null)),true);assert.equal(farRoute(t('zombie',8,'sealed',null)),false)
})

// Run 86, 10 October: at the fortress portal a blaze four blocks below behind
// nether bricks kept the bot walling in and opening up: the alarm counted it,
// the bow had no shot. A mob that only shoots cannot hurt the bot without a
// line of sight; until it has one (or is within four blocks) it is no alarm,
// and the moment it has one the bow has one too. Melee mobs are unchanged.
test('a shooter with no line of sight is no alarm until it has one; melee mobs still count',async()=>{
 const {emergencyReason,THREAT_INTERRUPTION,HEALTH_EMERGENCY,cannotShootYet}=await import('../src/survival.js')
 const o={gameMode:'survival',health:20,difficulty:'normal',timeOfDay:6000,sheltered:false,shelterAvailable:false,food:20,carriedFood:[],nearbyThreats:[]}
 const t=(name,distance,sight,reach='open')=>({risk:'potential_hostile',name,distance,reach,sightline:{status:sight}})
 assert.equal(emergencyReason({...o,nearbyThreats:[t('blaze',13,'blocked')]}),null,'the run 86 blaze')
 assert.equal(emergencyReason({...o,nearbyThreats:[t('blaze',13,'clear')]}),THREAT_INTERRUPTION,'in sight it counts')
 assert.equal(emergencyReason({...o,nearbyThreats:[t('skeleton',3.5,'blocked')]}),THREAT_INTERRUPTION,'within four blocks it counts')
 assert.equal(emergencyReason({...o,nearbyThreats:[t('wither_skeleton',8,'blocked')]}),THREAT_INTERRUPTION,'a melee mob behind a wall still counts')
 assert.equal(emergencyReason({...o,health:8,nearbyThreats:[t('blaze',13,'blocked')]}),null,'nor is it a health alarm')
 assert.equal(cannotShootYet(t('ghast',30,'blocked')),true);assert.equal(cannotShootYet(t('drowned',10,'blocked')),false)
})
// pi2, 10 October: two dawn hunts at 1 health were cancelled by the health alarm
// within six seconds, and the journal could not say which hostile raised it: the
// recovery record, taken a moment later, showed only a witch thirteen blocks down
// behind grass. The alarm now logs what it counted when it fires.
test('the health alarm logs the hostiles it counted, with reach and sightline',()=>{
 const {bot,cells}=trial42(),r=new FakeRunner(bot);bot.health=5
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-health-log-')),'state.json'))
 const calls=[],logs=[];c.seekSafety=async why=>{calls.push(why);c.safety={status:'retreating',reason:why}};r.log=(type,data)=>logs.push([type,data])
 breach(cells);const creeper=Object.values(bot.entities).find(e=>e.name==='creeper');creeper.position=new Vec3(-598.5,-48,-332.5)
 r.emit('event',{type:'survival_tick'})
 assert.deepEqual(calls,['Health is at or below half'])
 const entry=logs.find(([type])=>type==='health_alarm')
 assert.ok(entry,JSON.stringify(logs));assert.equal(entry[1].health,5)
 assert.ok(entry[1].counted.some(t=>/^creeper@[\d.]+\/-?[\d.]+:open(~\d+)?:blocked$/.test(t)),JSON.stringify(entry[1]))
})

// Lab run 145, 15 October: walled in at the Nether portal, a wither skeleton 10 to 16
// blocks off and six below behind netherrack read "unknown" for good, because the
// bot's space opened onto the Nether's open air and the flood ran out of cells long
// before it could say anything. The flood is breadth first, so how deep it got when it
// stopped is a floor under every route it had not found yet. Here a cavern twelve high
// over netherrack.
const NETHER_ORIGIN=new Vec3(.5,64,.5)
function netherField({pocket=[new Vec3(14,58,0),new Vec3(14,59,0)],tunnel=[],unloaded=[]}={}){
 const air=new Set([...pocket,...tunnel].map(c=>c.toString())),gone=new Set(unloaded.map(c=>c.toString()))
 return {registry,game:{gameMode:'survival',difficulty:'normal',dimension:'minecraft:the_nether'},entity:{position:NETHER_ORIGIN.clone()},
  blockAt(p){const k=p.floored().toString();if(gone.has(k))return null;const n=p.y>=64&&p.y<=75||air.has(k)?'air':'netherrack';return {name:n,position:p,boundingBox:registry.blocksByName[n].boundingBox,getProperties:()=>({})}}}
}
test('a hostile the flood did not reach before its cell limit reports how deep the flood got, and that depth never overstates a route',()=>{
 const skeleton={position:new Vec3(14.5,58,.5)}
 const [capped]=threatRoutes(netherField(),[skeleton])
 assert.equal(capped.reach,'unknown');assert.equal(capped.steps,null)
 assert.equal(capped.atLeast,28,'the cavern runs the flood out of cells 28 steps out')
 // A shaft down from the open air to the pocket: the true route is known with no limit,
 // and at every limit the flood either finds it or reports no more than its length.
 const shaft=[];for(let y=60;y<=63;y++)shaft.push(new Vec3(14,y,0))
 const [truth]=threatRoutes(netherField({tunnel:shaft}),[skeleton],{limit:Infinity})
 assert.equal(truth.reach,'open')
 for(const limit of [1,10,100,1000,3000,6000,12000]){
  const [r]=threatRoutes(netherField({tunnel:shaft}),[skeleton],{limit})
  if(r.reach==='open')assert.equal(r.steps,truth.steps)
  else{assert.equal(r.reach,'unknown');assert.ok(Number.isFinite(r.atLeast)&&r.atLeast<=truth.steps,`limit ${limit}: ${r.atLeast} against ${truth.steps}`)}
 }
 assert.deepEqual(threatRoutes(trial42().bot,[{position:new Vec3(-600.16,-49,-325.84)}]),[{reach:'sealed',steps:null}],'sealed reads as before')
})
test('an unloaded cell bounds the routes at the depth the flood met it',()=>{
 const near=trial42();near.cells.set(HUT.offset(1,0,0).toString(),null)
 assert.deepEqual(threatRoutes(near.bot,survivalObservation(near.bot).nearbyThreats).map(r=>[r.reach,r.atLeast]),Array(5).fill(['unknown',1]))
 // A tunnel twelve long ending in unloaded ground: nothing beyond it is nearer than thirteen.
 const far=trial42();for(let x=1;x<=12;x++)air(far.cells,HUT.offset(x,0,0),HUT.offset(x,1,0));far.cells.set(HUT.offset(13,0,0).toString(),null)
 assert.deepEqual(threatRoutes(far.bot,survivalObservation(far.bot).nearbyThreats).map(r=>[r.reach,r.atLeast]),Array(5).fill(['unknown',13]))
 // Run 145 from the other side: open air whose only unloaded cell lies thirty steps out.
 const ring=[];for(let x=0;x<=12;x++)ring.push(new Vec3(x,62,0));for(let z=1;z<=12;z++)ring.push(new Vec3(12,62,z));for(let x=11;x>=0;x--)ring.push(new Vec3(x,62,12))
 const bot={...netherField({pocket:[new Vec3(6,57,4),new Vec3(6,58,4)],tunnel:ring,unloaded:[new Vec3(6,62,12)]}),entity:{position:new Vec3(.5,62,.5)}}
 const [r]=threatRoutes(bot,[{position:new Vec3(6.5,57,4.5)}],{origins:[new Vec3(0,62,0)]})
 assert.equal(r.reach,'unknown');assert.equal(r.atLeast,30)
})
test('an unknown route the flood has followed past one and a half alarm radii is out of reach; nearer, in sight or within the floors it counts',async()=>{
 const {HEALTH_EMERGENCY}=await import('../src/survival.js')
 const o={gameMode:'survival',health:20,difficulty:'normal',timeOfDay:6000,sheltered:false,shelterAvailable:false,food:20,carriedFood:[],nearbyThreats:[]}
 const t=(name,distance,routeAtLeast,sight='blocked')=>({risk:'potential_hostile',name,distance,reach:'unknown',routeSteps:null,routeAtLeast,sightline:{status:sight}})
 assert.equal(emergencyReason({...o,nearbyThreats:[t('wither_skeleton',14,28)]}),null,'the run 145 wither skeleton')
 assert.equal(emergencyReason({...o,health:8,nearbyThreats:[t('wither_skeleton',14,28)]}),null,'nor a health alarm')
 assert.equal(outOfReach(t('wither_skeleton',14,28)),true);assert.equal(farRoute(t('wither_skeleton',14,28)),true)
 assert.equal(emergencyReason({...o,nearbyThreats:[t('wither_skeleton',14,24)]}),THREAT_INTERRUPTION,'not past 24, the route may be short enough')
 assert.equal(emergencyReason({...o,health:8,nearbyThreats:[t('wither_skeleton',14,24)]}),HEALTH_EMERGENCY)
 assert.equal(emergencyReason({...o,nearbyThreats:[t('zombie',8,16)]}),null);assert.equal(emergencyReason({...o,nearbyThreats:[t('zombie',8,15)]}),THREAT_INTERRUPTION)
 assert.equal(emergencyReason({...o,nearbyThreats:[t('wither_skeleton',14,28,'clear')]}),THREAT_INTERRUPTION,'in sight counts whatever the flood says')
 assert.equal(emergencyReason({...o,nearbyThreats:[t('wither_skeleton',14,null)]}),THREAT_INTERRUPTION,'an unknown with no depth proves nothing')
 assert.equal(emergencyReason({...o,nearbyThreats:[t('creeper',3.5,40)]}),THREAT_INTERRUPTION,'a creeper inside the rock floor')
 assert.equal(emergencyReason({...o,nearbyThreats:[t('zombie',2.5,40)]}),THREAT_INTERRUPTION,'a melee mob inside the rock floor')
 assert.equal(emergencyReason({...o,nearbyThreats:[t('warden',9,60)]}),THREAT_INTERRUPTION,'a warden always counts')
 assert.equal(outOfReach(t('enderman',9,60)),false,'an angry enderman teleports, so no route is long for it')
 assert.equal(outOfReach({risk:'potential_hostile',name:'enderman',distance:9,reach:'open',routeSteps:60,sightline:{status:'blocked'}}),false)
})
test('the threat journal says how far the flood got for a hostile it never met',()=>{
 const bot=Object.assign(netherField(),{time:{timeOfDay:6000},health:20,food:20,oxygenLevel:20,players:{},inventory:{items:()=>[]},world:{raycast:()=>({name:'netherrack'})},
  entities:{1:{id:1,name:'wither_skeleton',position:new Vec3(14.5,58,.5)},2:{id:2,name:'zombie',position:new Vec3(5.5,64,.5)}}})
 Object.assign(bot.entity,{onGround:true,eyeHeight:1.62,isInWater:false,metadata:[0]})
 const r=new FakeRunner(bot),c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-bound-log-')),'state.json'))
 const calls=[],logs=[];c.seekSafety=async why=>{calls.push(why);c.safety={status:'retreating',reason:why}};r.log=(type,data)=>logs.push([type,data])
 r.emit('event',{type:'survival_tick'})
 assert.deepEqual(calls,[THREAT_INTERRUPTION],'the zombie in the cavern')
 const entry=logs.find(([type])=>type==='threat_route')
 assert.ok(entry?.[1].threats.includes('wither_skeleton@15.2/-6:unknown>=28:blocked'),JSON.stringify(logs))
 assert.ok(entry[1].threats.includes('zombie@5/0:open~5:blocked'),JSON.stringify(entry))
})
