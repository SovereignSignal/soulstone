import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import registryFor from 'prismarine-registry'
import {Vec3} from 'vec3'
import {tripKit,onTrip,TRIP_ARMOR,TRIP_ARROWS} from '../src/nether-trip.js'
import {burrowClearance} from '../src/burrow.js'
import {Teammate} from '../src/companion/controller.js'
import {THREAT_INTERRUPTION} from '../src/survival.js'
const registry=registryFor('1.21.4')
// Step 4, lab runs 129 to 137 (13 October): the planner said walk 47 blocks to the
// spawner while the Nether safety rule sent the bot home at any hostile within ten
// blocks. A fortress always has one, so the bot never got twenty blocks in and died
// retreating through the corridors. On a trip with the kit it holds its ground.
const kitItems=()=>[{name:'bow',count:1},{name:'arrow',count:40},{name:'iron_sword',count:1,maxDurability:250,durabilityUsed:0},{name:'cobblestone',count:64,type:registry.itemsByName.cobblestone.id}]
function wear(bot,boots='golden_boots'){
 const slots=[];bot.inventory.slots=slots;bot.getEquipmentDestSlot=s=>({head:5,torso:6,legs:7,feet:8})[s]
 for(const [i,n] of [[5,'iron_helmet'],[6,'iron_chestplate'],[7,'iron_leggings'],[8,boots]])slots[i]={name:n}
 return slots
}
test('the trip kit is a bow, 16 arrows, an iron sword or axe and the Nether armour; each missing piece is named',()=>{
 const items=kitItems(),bot={health:20,game:{dimension:'minecraft:the_nether'},inventory:{items:()=>items}}
 wear(bot)
 assert.deepEqual(tripKit(bot),{ready:true,missing:[],arrows:40,armour:14,weapon:'iron_sword'})
 assert.equal(onTrip(bot,true),true)
 assert.equal(onTrip(bot,false),false,'no request, no trip')
 bot.game.dimension='minecraft:overworld';assert.equal(onTrip(bot,true),false,'the Overworld is not a trip');bot.game.dimension='minecraft:the_nether'
 bot.health=11;assert.equal(onTrip(bot,true),false,'hurt: the portal is back on the table');bot.health=20
 items[1].count=10;assert.match(tripKit(bot).missing[0],new RegExp(`${TRIP_ARROWS} arrows \\(carrying 10\\)`));items[1].count=40
 items[2]={name:'stone_sword',count:1,maxDurability:131,durabilityUsed:0};assert.match(tripKit(bot).missing[0],/iron sword or axe/);items[2]=kitItems()[2]
 bot.inventory.slots[6]=null;assert.match(tripKit(bot).missing[0],new RegExp(`iron armour \\(8 of ${TRIP_ARMOR} points worn\\)`))
})
function netherBot({health=20,kit=true,hoglinAt=3}={}){
 const items=kit?kitItems():[{name:'cobblestone',count:64,type:registry.itemsByName.cobblestone.id}]
 const bot=new EventEmitter()
 Object.assign(bot,{registry,username:'SoulStone303',players:{},health,food:20,oxygenLevel:20,game:{gameMode:'survival',difficulty:'normal',dimension:'minecraft:the_nether'},time:{timeOfDay:6000},
  entity:{id:1,type:'player',position:new Vec3(0.5,64,0.5),onGround:true,eyeHeight:1.62,isInWater:false,metadata:[0]},inventory:{items:()=>items,slots:[]},
  entities:{7:{id:7,uuid:'10000000-0000-0000-0000-000000000007',type:'mob',name:'hoglin',position:new Vec3(0.5,64,0.5+hoglinAt)}},
  world:{raycast:()=>null,getColumn:()=>({})},clearControlStates(){},setControlState(){},pathfinder:{setGoal(){},setMovements(){},async goto(){}}})
 // Frame in the z=-1 plane: obsidian x -1..2, y 63..67; portal x 0..1, y 64..66. Stone floor at y 63.
 bot.blockAt=p=>{const frame=p.z===-1&&p.x>=-1&&p.x<=2&&p.y>=63&&p.y<=67
  const name=frame?((p.x===-1||p.x===2||p.y===63||p.y===67)?'obsidian':'nether_portal'):p.y===63?'stone':'air'
  return {name,position:p.clone(),boundingBox:(name==='stone'||name==='obsidian')?'block':'empty',getProperties:()=>({})}}
 bot.findBlock=({matching})=>matching===registry.blocksByName.nether_portal.id?{name:'nether_portal',position:new Vec3(0,64,-1)}:null
 if(kit)wear(bot)
 return bot
}
async function firstActs({status='running',...opts}={}){
 const bot=netherBot(opts),r=new EventEmitter()
 Object.assign(r,{bot,ready:true,profile:'trip-test',owner:'Sov',connectionId:'20000000-0000-0000-0000-000000000002',position:()=>bot.entity.position,commands:[],waitForIdle:async()=>{}})
 r.command=c=>{r.commands.push(c);if(c.action!=='stop')r.task={id:String(r.commands.length),kind:c.action,status:'running',goal:c.goal}}
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-trip-')),'state.json'))
 c.requestProgress={id:'trip',request:'rods',status,feedback:[]}
 void c.seekSafety(THREAT_INTERRUPTION);await new Promise(res=>setTimeout(res,80))
 const acts=r.commands.map(x=>x.action).filter(a=>a!=='stop');c.cancel?.(true);return {acts,said:c.messages.map(m=>m.text)}
}
test('on a trip with the kit, a hoglin three blocks off beside the portal means cover here, not the portal; hurt or without the kit, the portal as before',async()=>{
 const trip=await firstActs({})
 assert.ok(!trip.acts.includes('use_portal'),'no run for the portal: '+trip.acts.join(' '))
 assert.ok(trip.said.some(t=>/taking cover here rather than running for the portal/.test(t)),trip.said.join(' | '))
 const hurt=await firstActs({health:8});assert.equal(hurt.acts[0],'use_portal','hurt: home, '+hurt.acts.join(' '))
 const bare=await firstActs({kit:false});assert.equal(bare.acts[0],'use_portal','no kit: home, '+bare.acts.join(' '))
})
// Lab run 144 (14 October): a shelter wait at the spawner spent its idle continuations and
// left the request interrupted; the next alarm read "no request" and walked the bot home
// with full health and kit. A request waiting to resume is still the trip (36def62).
test('on a trip with the kit, an interrupted request waiting to resume is still the trip: cover here, not the portal',async()=>{
 const trip=await firstActs({status:'interrupted'})
 assert.ok(!trip.acts.includes('use_portal'),'no run for the portal: '+trip.acts.join(' '))
 assert.ok(trip.said.some(t=>/taking cover here rather than running for the portal/.test(t)),trip.said.join(' | '))
})
test('from cover, a group the fight rules engage is confronted nearest first, not waited out or run from',()=>{
 const bot=netherBot({hoglinAt:30});delete bot.entities[7]
 const cube=(id,z)=>({id,uuid:'10000000-0000-0000-0000-00000000000'+id,type:'mob',name:'magma_cube',position:new Vec3(0.5,64,0.5+z)})
 bot.entities={2:cube(2,6),3:cube(3,4),4:cube(4,8)}
 // Under a roof, so the clock is not the question.
 const blockAt=bot.blockAt;bot.blockAt=p=>p.y>=66&&p.y<=70&&Math.abs(p.x)<3&&Math.abs(p.z)<3?{name:'netherrack',position:p.clone(),boundingBox:'block',getProperties:()=>({})}:blockAt(p)
 const r=burrowClearance(bot,{lingeredMs:90000,patienceMs:60000,relocateAfterMs:120000})
 assert.equal(r.clear,true,r.reason);assert.equal(r.confront?.name,'magma_cube');assert.equal(r.confront.distance,4,'nearest first');assert.equal(r.relocate,undefined)
 assert.match(r.reason,/3 hostiles I can fight/)
 const early=burrowClearance(bot,{lingeredMs:10000,patienceMs:60000});assert.equal(early.clear,false);assert.match(early.reason,/3 hostiles I can fight linger/)
})

