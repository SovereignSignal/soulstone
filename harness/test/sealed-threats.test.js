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
 assert.equal(emergencyReason(at('creeper',10)),THREAT_INTERRUPTION,'a creeper in fuse range')
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

test('a sealed melee mob counts only within three blocks; a sealed creeper within ten; wall-breachers always',()=>{
 // Lab run 27, 3 October: at y 50 the bot was interrupted every few seconds by
 // skeletons and cave spiders at 5.2 to 6.0 blocks, each sealed and blocked,
 // and spent the night burrowing, clearing and unburrowing in place.
 const o={health:18,food:12,gameMode:'survival',difficulty:'normal',timeOfDay:6000}
 const sealed=(name,distance)=>({risk:'potential_hostile',name,distance,reach:'sealed',sightline:{status:'blocked'}})
 assert.equal(emergencyReason({...o,nearbyThreats:[sealed('skeleton',5.3),sealed('cave_spider',4),sealed('zombie',3.1)]}),null)
 assert.equal(emergencyReason({...o,nearbyThreats:[sealed('zombie',2.9)]}),THREAT_INTERRUPTION,'through one block of rock it still counts')
 assert.equal(emergencyReason({...o,nearbyThreats:[sealed('creeper',8)]}),THREAT_INTERRUPTION);assert.equal(emergencyReason({...o,nearbyThreats:[sealed('creeper',11)]}),null)
 assert.equal(emergencyReason({...o,nearbyThreats:[sealed('warden',9)]}),THREAT_INTERRUPTION)
 assert.equal(emergencyReason({...o,nearbyThreats:[{...sealed('zombie',5),reach:'open'}]}),THREAT_INTERRUPTION,'an open route is an interruption at any distance inside the radius')
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
