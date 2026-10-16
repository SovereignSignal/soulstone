import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {burrowClearance,shelterExits,RELOCATE_PATIENCE_MS,RELOCATE_FLOOR} from '../src/burrow.js'
import {roofed} from '../src/observations.js'
import {emergencyReason,NIGHT_EXPOSURE} from '../src/survival.js'
import {Teammate,SEALED_WINDOW_MS} from '../src/companion/controller.js'
const registry=minecraftData('1.21.4')
// Trial 42 again: of 1455 blocked seconds, 894 were "Waiting for daylight" in a
// hut 36 blocks underground and 493 were waiting on mobs in a cave that could
// not reach it. The hut is at y -36 in deepslate; the cave is thirteen below.
const HUT=new Vec3(-595,-36,-333)
const RECORDED=[['creeper',-600.16,-49,-325.84],['zombie',-601.41,-49,-342.56],['skeleton',-604.28,-50,-323.7]]
const block=(n,p)=>n===null?null:{name:n,position:p,boundingBox:registry.blocksByName[n]?.boundingBox,getProperties:()=>({})}
const base=(position,name,{timeOfDay=6000,mobs=[]}={})=>({registry,game:{gameMode:'survival',difficulty:'easy',dimension:'overworld'},time:{timeOfDay},health:20,food:17,oxygenLevel:20,players:{},
 entity:{position,onGround:true,eyeHeight:1.62,isInWater:false,metadata:[0]},inventory:{items:()=>[]},
 entities:Object.fromEntries(mobs.map(([n,x,y,z],i)=>[i+1,{id:i+1,name:n,position:new Vec3(x,y,z)}])),
 blockAt:p=>block(name(p),p),
 // A real walk along the ray (it used to answer "deepslate" for every query, even
 // down an open corridor): the first full block on the line, or nothing.
 world:{raycast:(from,dir,range)=>{for(let d=0.1;d<=range;d+=0.1){const c=from.plus(dir.scaled(d)).floored(),n=name(c);if(n&&registry.blocksByName[n]?.boundingBox==='block')return {name:n,position:c}}return null}}})
function deep(options){
 const cells=new Map([HUT,HUT.offset(0,1,0)].map(c=>[c.toString(),'air']))
 return {cells,bot:base(new Vec3(-594.58,-36,-332.5),p=>cells.has(p.toString())?cells.get(p.toString()):p.y>=-50&&p.y<=-48&&p.x<=-598?'air':'deepslate',options)}
}
// A capped burrow just under open ground: three shaft cells, one cap block, then sky.
function shallow(options){
 return base(new Vec3(.5,60,.5),p=>p.y>=64?'air':p.x===0&&p.z===0&&p.y>=60&&p.y<=62?'air':'stone',options)
}
const hut={shelterName:'hut',surface:{x:HUT.x,y:HUT.y,z:HUT.z}}
const breach=cells=>{for(let y=-37;y>=-47;y--)cells.set(new Vec3(-599,y,-333).toString(),'air');for(let x=-599;x<=-597;x++)cells.set(new Vec3(x,-36,-333).toString(),'air')}
test('rock overhead is what makes a place underground; a capped burrow under the sky is not',()=>{
 assert.equal(roofed(deep().bot),true)
 assert.equal(roofed(shallow()),false)
})
test('night with no base is an emergency on the surface and not under rock',()=>{
 const night={gameMode:'survival',health:20,food:20,difficulty:'easy',headSubmerged:false,oxygen:20,nearbyThreats:[],carriedFood:[],timeOfDay:15000,shelterAvailable:false}
 assert.equal(emergencyReason(night),NIGHT_EXPOSURE)
 assert.equal(emergencyReason({...night,roofed:false}),NIGHT_EXPOSURE)
 assert.equal(emergencyReason({...night,roofed:true}),null)
})
test('a shelter exits where it opens: beyond each hut wall, and above a burrow\'s cap',()=>{
 assert.deepEqual(shelterExits(hut).map(String),[[2,0,0],[2,1,0],[-2,0,0],[-2,1,0],[0,0,2],[0,1,2],[0,0,-2],[0,1,-2]].map(([x,y,z])=>HUT.offset(x,y,z).toString()))
 assert.deepEqual(shelterExits({shelterName:'burrow',surface:{x:0,y:64,z:0}}).map(String),[new Vec3(0,64,0),new Vec3(0,65,0),new Vec3(0,66,0)].map(String))
 assert.equal(shelterExits(null),null)
})
test('the wait under rock does not hold for daylight; the wait under the sky still does',()=>{
 assert.equal(burrowClearance(deep({timeOfDay:15000}).bot).clear,true)
 const up=burrowClearance(shallow({timeOfDay:15000}));assert.equal(up.clear,false);assert.equal(up.holding,true);assert.match(up.reason,/daylight/)
 assert.equal(burrowClearance(shallow({timeOfDay:6000})).clear,true)
})
test('hostiles the exits cannot reach do not hold a shelter closed; a route, a close floor or no exit evidence does',()=>{
 const sealed=deep({mobs:RECORDED}),exits=shelterExits(hut)
 const legacy=burrowClearance(sealed.bot);assert.equal(legacy.clear,false);assert.match(legacy.reason,/within 16 blocks/)
 assert.equal(burrowClearance(sealed.bot,{exits}).clear,true,'the trial 42 wait')
 const open=deep({mobs:RECORDED});breach(open.cells)
 assert.equal(burrowClearance(open.bot,{exits}).clear,false,'the west exit opens onto the cave')
 // 16 October: a sealed creeper never fuses, and nothing in the shelter digs toward it.
 const close=deep({mobs:[['creeper',-595.5,-39,-332.5]]})
 assert.equal(burrowClearance(close.bot,{exits}).clear,true,'a sealed, unseen creeper within four blocks does not hold the wait')
 const reached=deep({mobs:[['creeper',-596.5,-39,-332.5]]});for(let y=-39;y<=-36;y++)reached.cells.set(new Vec3(-597,y,-333).toString(),'air')
 assert.equal(burrowClearance(reached.bot,{exits}).clear,false,'one the exit flood reaches does')
 const below=deep({mobs:[['creeper',-595.5,-45,-332.5]]})
 assert.equal(burrowClearance(below.bot,{exits}).clear,true,'sealed nine below, it cannot see the bot to fuse (run 47)')
 // A ranged mob holds a shelter out to twenty-four blocks, past the default search radius.
 const far=deep({mobs:[['skeleton',-571.5,-36,-332.5]]});for(let x=2;x<=26;x++)for(const y of [0,1])far.cells.set(HUT.offset(x,y,0).toString(),'air')
 assert.equal(burrowClearance(far.bot,{exits}).clear,false,'a skeleton down an open corridor from the exit')
 const unloaded=deep({mobs:RECORDED});unloaded.cells.set(HUT.offset(2,0,0).toString(),null)
 assert.equal(burrowClearance(unloaded.bot,{exits}).clear,false,'an unobserved exit proves nothing')
})
// A measured death: dug in with an iron sword, no armour and no bow, the bot opened the
// shaft for a lone skeleton lingering at 8.9 blocks; a second skeleton and a creeper came.
const IRON=['iron_helmet','iron_chestplate','iron_leggings','iron_boots']
function bareSkeleton(mobs=[['skeleton',8.5,64,.5]]){
 const bot=shallow({mobs}),items=[{name:'iron_sword',count:1,maxDurability:250,durabilityUsed:0}],slots=[]
 Object.values(bot.entities).forEach((e,i)=>Object.assign(e,{uuid:`00000000-0000-0000-0000-00000000000${i+1}`,type:'hostile'}))
 // Fed to eighteen, so waiting can heal and the wait is worth something.
 bot.food=20;bot.inventory={items:()=>items,slots};bot.getEquipmentDestSlot=slot=>({head:5,torso:6,legs:7,feet:8})[slot]
 const wear=names=>names.forEach((name,i)=>{slots[5+i]={name}})
 return {bot,items,wear}
}
test('a sword alone does not open the burrow to a shooter; worn armour or a bow that answers it does',()=>{
 const bare=bareSkeleton()
 const r=burrowClearance(bare.bot,{lingeredMs:61000});assert.equal(r.clear,false,'no armour, no bow: keep waiting');assert.equal(r.confront,undefined);assert.equal(r.lingering,true)
 const chest=bareSkeleton();chest.bot.inventory.slots[6]={name:'iron_chestplate'}
 assert.equal(burrowClearance(chest.bot,{lingeredMs:61000}).clear,false,'a chestplate alone is not enough to walk into the arrows')
 const armoured=bareSkeleton();armoured.wear(IRON)
 const a=burrowClearance(armoured.bot,{lingeredMs:61000});assert.equal(a.clear,true,a.reason);assert.equal(a.confront?.name,'skeleton')
 const archer=bareSkeleton();archer.items.push({name:'bow',count:1,maxDurability:384,durabilityUsed:0},{name:'arrow',count:64})
 const b=burrowClearance(archer.bot,{lingeredMs:61000});assert.equal(b.clear,true,b.reason);assert.equal(b.confront?.name,'skeleton')
})
// The gate is only worth holding while waiting can heal; hungry with no food, waiting
// is the slower death, and the sword confronts as it did before the gate.
test('a bot that cannot heal under the cap confronts a shooter with the sword as before',()=>{
 const hungry=bareSkeleton();hungry.bot.food=10
 const r=burrowClearance(hungry.bot,{lingeredMs:61000});assert.equal(r.clear,true,r.reason);assert.equal(r.confront?.name,'skeleton')
 hungry.items.push({name:'bread',count:3})
 const fed=burrowClearance(hungry.bot,{lingeredMs:61000});assert.equal(fed.clear,false,'carrying food it can heal, so it waits');assert.equal(fed.lingering,true)
})
test('melee mobs are confronted with the sword alone as before, unless a shooter waits behind them',()=>{
 const zombie=bareSkeleton([['zombie',5.5,64,.5]])
 const z=burrowClearance(zombie.bot,{lingeredMs:61000});assert.equal(z.clear,true,z.reason);assert.equal(z.confront?.name,'zombie')
 const covered=bareSkeleton([['zombie',5.5,64,.5],['skeleton',16.5,64,.5]])
 assert.equal(burrowClearance(covered.bot,{lingeredMs:61000}).clear,false,'the skeleton shoots while the sword works on the zombie')
 covered.wear(IRON);assert.equal(burrowClearance(covered.bot,{lingeredMs:61000}).confront?.name,'zombie')
})
// Lab run 165, 15 October: a lone skeleton in shade nine blocks off, a bow and 88 arrows, and
// the burrow opened "to confront it"; from the surface dirt was in the way and the alarm chose
// shelter at once. The same capped shaft, with a stone column between the exits and the skeleton.
// roof: eight cells of rock high over the shaft and no sky light, so the burrow reads as underground (observations.js roofed).
function archerUnder({wall=true,pocket=false,mobs=[['skeleton',8.5,64,.5]],roof=false,timeOfDay=6000}={}){
 const bot=base(new Vec3(.5,60,.5),p=>roof&&p.x===0&&p.z===0&&p.y>=70&&p.y<=77?'stone':wall&&p.x===5&&p.z===0&&p.y>=64&&p.y<=69?'stone':p.y>=64?'air':p.x===0&&p.z===0&&p.y>=60&&p.y<=62?'air':pocket&&p.x===3&&p.z===0&&p.y>=60&&p.y<=61?'air':'stone',{mobs,timeOfDay})
 // Under the roof no sky light reaches the air between, so the column reads as rock overhead.
 if(roof){const at=bot.blockAt;bot.blockAt=p=>{const b=at(p);return b&&{...b,skyLight:0}}}
 const items=[{name:'bow',count:1,maxDurability:384,durabilityUsed:0},{name:'arrow',count:88}]
 Object.values(bot.entities).forEach((e,i)=>Object.assign(e,{uuid:`00000000-0000-0000-0000-00000000000${i+1}`,type:'hostile'}))
 bot.food=20;bot.inventory={items:()=>items,slots:[]};bot.getEquipmentDestSlot=()=>null
 return bot
}
const shaftExits=shelterExits({shelterName:'burrow',surface:{x:0,y:64,z:0}})
test('a lone skeleton the shaft cannot see holds the burrow; one in view is confronted',()=>{
 const hidden=burrowClearance(archerUnder(),{lingeredMs:61000,exits:shaftExits})
 assert.equal(hidden.clear,false,hidden.reason);assert.equal(hidden.lingering,true);assert.equal(hidden.confront,undefined);assert.match(hidden.reason,/out of sight/)
 const seen=burrowClearance(archerUnder({wall:false}),{lingeredMs:61000,exits:shaftExits})
 assert.equal(seen.clear,true,seen.reason);assert.equal(seen.confront?.name,'skeleton')
 assert.equal(burrowClearance(archerUnder(),{lingeredMs:61000}).confront?.name,'skeleton','with no exits given, as before')
})
test('a hidden shooter still comes due for relocation',()=>{
 const r=burrowClearance(archerUnder({mobs:[['skeleton',10.5,64,.5]]}),{lingeredMs:241000,exits:shaftExits})
 assert.equal(r.clear,true,r.reason);assert.ok(r.relocate,r.reason);assert.equal(r.confront,undefined)
})
// Inside the relocation standoff there is no way out but the shooter leaving or burning: the
// burrow holds, healing, through the watches and over dusk (the daylight hold), as it was
// built to. The 15 October skeleton was 9.1 blocks off.
test('a hidden shooter inside the relocation standoff is held, however long it lingers',()=>{
 const r=burrowClearance(archerUnder(),{lingeredMs:241000,exits:shaftExits})
 assert.equal(r.clear,false,r.reason);assert.equal(r.lingering,true);assert.equal(r.relocate,undefined);assert.equal(r.confront,undefined);assert.match(r.reason,/out of sight/)
})
// 16 October: that hold is worth it only while waiting heals. Hungry with nothing to eat it heals
// nothing, and four watches end on a Resume nobody in the family world can send, so a hidden
// lone shooter does not hold the standoff then: the patience runs and the bot leaves.
const hungryArcher=({food=12,health=20,...o}={})=>{const bot=archerUnder(o);bot.food=food;bot.health=health;return bot}
test('a hidden shooter inside the standoff is held only while waiting can heal',()=>{
 const fed=burrowClearance(hungryArcher({food:20}),{lingeredMs:RELOCATE_PATIENCE_MS,exits:shaftExits})
 assert.equal(fed.clear,false,fed.reason);assert.equal(fed.relocate,undefined)
 const early=burrowClearance(hungryArcher(),{lingeredMs:61000,exits:shaftExits})
 assert.equal(early.clear,false,early.reason);assert.equal(early.lingering,true);assert.equal(early.confront,undefined,'still never confronted unseen')
 const hungry=burrowClearance(hungryArcher(),{lingeredMs:RELOCATE_PATIENCE_MS,exits:shaftExits})
 assert.equal(hungry.clear,true,hungry.reason);assert.equal(hungry.relocate?.threats?.[0]?.name,'skeleton');assert.equal(hungry.confront,undefined)
 const weak=burrowClearance(hungryArcher({health:RELOCATE_FLOOR-1}),{lingeredMs:RELOCATE_PATIENCE_MS,exits:shaftExits})
 assert.equal(weak.clear,false,'under the relocation floor it still holds');assert.equal(weak.relocate,undefined)
 const carrying=hungryArcher();carrying.inventory.items().push({name:'bread',count:3})
 assert.equal(burrowClearance(carrying,{lingeredMs:RELOCATE_PATIENCE_MS,exits:shaftExits}).clear,false,'carrying food it can heal, so it waits')
})
test('the hunger waiver is for the lone hidden shooter only: a creeper at the rim or a zombie inside ten blocks still holds',()=>{
 const creeper=hungryArcher({mobs:[['creeper',4.5,64,.5],['skeleton',8.5,64,.5]]})
 const c=burrowClearance(creeper,{lingeredMs:RELOCATE_PATIENCE_MS,exits:shaftExits});assert.equal(c.clear,false,c.reason);assert.equal(c.relocate,undefined)
 const zombie=hungryArcher({mobs:[['zombie',8.5,64,.5]]})
 const z=burrowClearance(zombie,{lingeredMs:RELOCATE_PATIENCE_MS,exits:shaftExits});assert.equal(z.clear,false,z.reason);assert.equal(z.relocate,undefined)
})
// Review of 16 October: under a rock roof the night does not hold the burrow, but the hunger
// waiver must not send the bot out into the dark on eight health: it waits for dawn, then leaves.
test('a hungry bot under a rock roof keeps a hidden shooter\'s hold through the night and leaves in daylight',()=>{
 const night=hungryArcher({roof:true,timeOfDay:15000});assert.equal(roofed(night),true)
 const n=burrowClearance(night,{lingeredMs:RELOCATE_PATIENCE_MS,exits:shaftExits})
 assert.equal(n.clear,false,n.reason);assert.equal(n.relocate,undefined);assert.match(n.reason,/out of sight/)
 const d=burrowClearance(hungryArcher({roof:true}),{lingeredMs:RELOCATE_PATIENCE_MS,exits:shaftExits})
 assert.equal(d.clear,true,d.reason);assert.equal(d.relocate?.threats?.[0]?.name,'skeleton')
})
const burrowedAt=bot=>{const executed=[],said=[]
 const c={epoch:1,runner:{bot,ready:true,connectionId:'same',task:{result:{receipt:'surfaced'}}},safety:{status:'burrowed',retreat:{shelterName:'burrow',surface:{x:0,y:64,z:0}}},requestProgress:null,burrowWait:{quietMs:5,limitMs:1500,watches:1,relocateAfterMs:0},
  persist(){},emit(){},say(m){said.push(m)},dispatch(){},async execute(command){executed.push(command.action)},resume(){assert.fail('no request to resume')}}
 return {c,executed,said}}
test('a burrow wait that cannot heal ends in a relocation from a hidden shooter, not a Resume request',async()=>{
 const hungry=burrowedAt(hungryArcher())
 await Teammate.prototype.waitInBurrow.call(hungry.c,1,new AbortController().signal,hungry.c.runner.bot,false)
 assert.deepEqual(hungry.executed,['unburrow','climb','flee']);assert.equal(hungry.c.safety,null)
 assert.ok(hungry.said.some(m=>/leaving the area/.test(m)),hungry.said.join(' | '));assert.ok(!hungry.said.some(m=>/Resume is required/.test(m)))
 const fed=burrowedAt(hungryArcher({food:20}))
 await Teammate.prototype.waitInBurrow.call(fed.c,1,new AbortController().signal,fed.c.runner.bot,false)
 assert.deepEqual(fed.executed,[]);assert.ok(fed.said.some(m=>/Resume is required/.test(m)),'fed, the hold is the one built on purpose')
})
// A hut drops a hidden shooter past four blocks before the gate is asked; one closer, which it
// keeps, is answered from the hut's port while the burrow holds it.
test('a hidden shooter within four blocks is confronted from a hut and held by a burrow',()=>{
 const scene=()=>archerUnder({pocket:true,mobs:[['skeleton',3.5,60,.5]]})
 const burrow=burrowClearance(scene(),{lingeredMs:61000,exits:shaftExits})
 assert.equal(burrow.clear,false,burrow.reason);assert.match(burrow.reason,/out of sight/)
 const hut=burrowClearance(scene(),{lingeredMs:61000,exits:shaftExits,canPort:true})
 assert.equal(hut.clear,true,hut.reason);assert.equal(hut.confront?.name,'skeleton')
})
// Lab run 166, 16 October: home at dusk, dug in, and held underground through the next
// daylight by a phantom hanging 4.5 blocks off the shaft. A skeleton and a creeper in caves
// below were already dropped by the exits flood; the phantom alone held the standoff. The same
// capped shaft; pockets are 3x3x2 cave rooms sealed in stone, the wall the archer test's column.
function run166({mobs,pockets=[],wall=false,timeOfDay=6000}){
 const inPocket=p=>pockets.some(([x,y,z])=>Math.abs(p.x-x)<=1&&Math.abs(p.z-z)<=1&&p.y>=y&&p.y<=y+1)
 const bot=base(new Vec3(.5,60,.5),p=>wall&&p.x===5&&p.z===0&&p.y>=64&&p.y<=69?'stone':p.y>=64?'air':p.x===0&&p.z===0&&p.y>=60&&p.y<=62?'air':inPocket(p)?'air':'stone',{mobs,timeOfDay})
 bot.food=20
 return bot
}
const PHANTOM=['phantom',-2.1,64,.4]
const CAVE=[['skeleton',-3,54,6.5],['creeper',-7,50,9.5]],POCKETS=[[-3,54,6],[-7,50,9]]
test('a phantom hanging at the shaft in daylight runs the patience, then does not hold the relocation',()=>{
 const early=burrowClearance(run166({mobs:[PHANTOM]}),{lingeredMs:1000,exits:shaftExits})
 assert.equal(early.clear,false,early.reason);assert.equal(early.lingering,true)
 const r=burrowClearance(run166({mobs:[PHANTOM]}),{lingeredMs:RELOCATE_PATIENCE_MS,exits:shaftExits})
 assert.equal(r.clear,true,r.reason);assert.equal(r.relocate?.threats?.[0]?.name,'phantom');assert.equal(r.confront,undefined)
})
test('run 166: the phantom at the exit with a skeleton and a creeper sealed in caves below relocates, leaving only the phantom',()=>{
 const r=burrowClearance(run166({mobs:[PHANTOM,...CAVE],pockets:POCKETS}),{lingeredMs:RELOCATE_PATIENCE_MS,exits:shaftExits})
 assert.equal(r.clear,true,r.reason);assert.deepEqual(r.relocate?.threats?.map(t=>t.name),['phantom'])
})
test('mobs sealed in caves below the burrow never held it: the exits flood drops them',()=>{
 const r=burrowClearance(run166({mobs:CAVE,pockets:POCKETS}),{lingeredMs:1000,exits:shaftExits})
 assert.equal(r.clear,true,r.reason);assert.equal(r.relocate,undefined)
})
test('beside the phantom, a creeper at the rim or a hidden shooter inside ten blocks still holds the burrow',()=>{
 const creeper=burrowClearance(run166({mobs:[PHANTOM,['creeper',4.5,64,.5]]}),{lingeredMs:RELOCATE_PATIENCE_MS,exits:shaftExits})
 assert.equal(creeper.clear,false,creeper.reason);assert.equal(creeper.relocate,undefined)
 assert.match(creeper.reason,/potential hostile remains within 16 blocks: creeper, phantom$/,'the hold names what holds it')
 const archer=burrowClearance(run166({mobs:[PHANTOM,['skeleton',8.5,64,.5]],wall:true}),{lingeredMs:RELOCATE_PATIENCE_MS,exits:shaftExits})
 assert.equal(archer.clear,false,archer.reason);assert.equal(archer.relocate,undefined)
})
test('at night under the sky a phantom at the shaft changes nothing: the burrow holds for daylight',()=>{
 const r=burrowClearance(run166({mobs:[PHANTOM],timeOfDay:15000}),{lingeredMs:RELOCATE_PATIENCE_MS,exits:shaftExits})
 assert.equal(r.clear,false,r.reason);assert.equal(r.holding,true)
})
class FakeRunner extends EventEmitter{
 constructor(bot){super();this.profile='lab';this.owner='Sov';this.ready=true;this.commands=[];this.bot=bot}
 position(){const p=this.bot.entity.position;return {x:p.x,y:p.y,z:p.z}}
 command(c){this.commands.push(c);this.task={id:String(this.commands.length),status:'running'}}
}
test('the survival tick lets a bot with no base keep mining through the night, and digs in when it is under the sky',()=>{
 for(const [bot,expected] of [[deep({timeOfDay:15000}).bot,[]],[shallow({timeOfDay:15000}),[NIGHT_EXPOSURE]]]){
  const r=new FakeRunner(bot),c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-night-')),'state.json'))
  const calls=[];c.seekSafety=async why=>{calls.push(why);c.safety={status:'retreating',reason:why}}
  r.emit('event',{type:'survival_tick'});assert.deepEqual(calls,expected)
 }
})
test('walled in under rock at night with a cave below, the wait clears and opens the hut',async()=>{
 const {bot}=deep({timeOfDay:15000,mobs:RECORDED}),executed=[]
 const c={epoch:1,runner:{bot,ready:true,connectionId:'same',task:{result:{receipt:'unwalled'}}},safety:{status:'burrowed',retreat:hut},requestProgress:null,burrowWait:{quietMs:5,limitMs:1500,watches:1},
  persist(){},emit(){},say(){},async execute(command){executed.push(command.action)},resume(){assert.fail('no request to resume')}}
 await Teammate.prototype.waitInBurrow.call(c,1,new AbortController().signal,bot,false)
 assert.deepEqual(executed,['unhut']);assert.equal(c.safety,null)
})
// Review of 16 October: a hut that leaned on a player's walls on every side cannot open. The
// family world's players are children: chat asks plainly for help, and the detail stays in the log.
test('a hut that cannot open through walls it did not build asks for help in plain words',async()=>{
 const {bot}=deep({timeOfDay:15000,mobs:RECORDED}),said=[],logged=[],detail='Could not open a wall of the hut: all 4 sides are not natural ground and not placed by me'
 const c={epoch:1,runner:{bot,ready:true,connectionId:'same',task:{result:{}},log(type,data){logged.push([type,data])}},safety:{status:'burrowed',retreat:hut},requestProgress:null,burrowWait:{quietMs:5,limitMs:1500,watches:1},
  persist(){},emit(){},say(m){said.push(m)},dispatch(){},async execute(){throw new Error(detail)},resume(){assert.fail('no request to resume')}}
 await Teammate.prototype.waitInBurrow.call(c,1,new AbortController().signal,bot,false)
 assert.ok(said.includes('I\'m stuck inside walls I didn\'t build. Please open one side for me.'),said.join(' | '))
 assert.ok(!said.some(m=>/natural ground/.test(m)),'the detail is not chat');assert.equal(c.safety.error,detail)
 assert.ok(logged.some(([type,data])=>type==='hut_walls_not_mine'&&data.reason===detail),JSON.stringify(logged))
})
test('a shelter still watching for clearance is not a stall; one whose watch has ended is',async()=>{
 // Lab run 8, 2 October: sheltered in the lit base at night, the bot was sent
 // back out after ninety seconds by the stall retry, three times, into creepers.
 const r=new FakeRunner(deep().bot),c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-stall-')),'state.json'))
 let resumes=0;c.resume=async()=>{resumes++};c.phase='blocked'
 c.requestProgress={id:'d',request:'mine iron',status:'interrupted',blocker:'Safety interruption: A potential hostile is within ten blocks'}
 c.safety={status:'sheltered',reason:'A potential hostile is within ten blocks',continuation:{status:'watching',reason:'Waiting in the lit base for daylight'}}
 c.blockedSince=1;assert.equal(await c.stallRetry(),false);assert.equal(resumes,0);assert.equal(c.requestProgress.stallContinuations,undefined,'and it spends none of the retry budget')
 c.safety.status='burrowed';c.blockedSince=1;await c.stallRetry();assert.equal(resumes,0)
 c.safety.continuation={status:'paused',code:'clearance_timeout'}
 c.blockedSince=1;assert.equal(await c.stallRetry(),true);assert.equal(resumes,1,'a watch that gave up leaves the retry in charge')
})
test('a shelter whose watch has cleared is leaving, not stalled',async()=>{
 // Lab run 93, 10 October: walled in at the Nether portal, the watch cleared
 // to move away from two wither skeletons and opened the wall; the stall retry
 // resumed the request in the same second, the alarm fired at the same
 // skeletons, and the bot walled in again, every four and a half minutes.
 const r=new FakeRunner(deep().bot),c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-leave-')),'state.json'))
 let resumes=0;c.resume=async()=>{resumes++};c.phase='blocked'
 c.requestProgress={id:'e',request:'blaze rods',status:'interrupted',blocker:'Safety interruption: A potential hostile is within ten blocks'}
 c.safety={status:'burrowed',reason:'A potential hostile is within ten blocks',continuation:{status:'cleared',watch:1}}
 c.blockedSince=1;assert.equal(await c.stallRetry(),false);assert.equal(resumes,0,'the exit resumes the request itself when it is done')
 c.safety.status='failed';c.blockedSince=1;assert.equal(await c.stallRetry(),true);assert.equal(resumes,1,'an exit that failed leaves the retry in charge')
 // Lab run 98: the hut's watch failed mid-watch ("Health fell inside the emergency
 // shelter"), the record still said watching, and the bot stood for 34 minutes.
 c.safety={status:'failed',error:'Health fell inside the emergency shelter',continuation:{status:'watching'}}
 c.blockedSince=1;assert.equal(await c.stallRetry(),true);assert.equal(resumes,2,'a watch that failed while watching leaves the retry in charge')
})
// Lab run 146, 15 October: kitted in the Nether, walled in inside a one-wide
// netherrack tunnel, a blaze hovering outside the tunnel wall. The tunnel runs
// along z at x 0; its walls are netherrack, one thick on the +x side with open
// air beyond, solid rock on the -x side; the hut closes it at z ±1.
import {Runner} from '../src/runner.js'
import {validateTaskGoal} from '../src/task-store.js'
const TUNNEL_HUT={shelterName:'hut',surface:{x:0,y:64,z:0}}
function tunnel({mobs=[],items=[],timeOfDay=6000,cells=new Map()}={}){
 const name=p=>cells.has(p.toString())?cells.get(p.toString()):p.x===0&&(p.y===64||p.y===65)&&Math.abs(p.z)<=10?(Math.abs(p.z)===1?'cobblestone':'air'):p.x>=2?'air':'netherrack'
 const bot=base(new Vec3(.5,64,.5),name,{timeOfDay,mobs})
 bot.game.dimension='the_nether'
 Object.values(bot.entities).forEach((e,i)=>Object.assign(e,{uuid:`00000000-0000-0000-0000-00000000001${i}`,type:'hostile',height:e.name==='blaze'?1.8:1.95,velocity:new Vec3(0,0,0)}))
 bot.food=20;bot.inventory={items:()=>items,slots:[]}
 return {bot,cells}
}
const SWORD={name:'iron_sword',count:1,maxDurability:250,durabilityUsed:0}
// A rod lying where a kill fell (an item entity, as mineflayer has it).
const rod=(bot,at,id=40+Object.keys(bot.entities).length)=>{bot.entities[id]={id,name:'item',type:'object',position:new Vec3(at.x,at.y,at.z),getDroppedItem:()=>({name:'blaze_rod',count:1})}}
test('the hut opened to confront carries the way it faces through the runner to the skill',async()=>{
 // The controller built goal.toward; the runner's unhut case dropped it and the
 // task goal validator returned {} for unhut, so the wall facing the mob never opened.
 const {bot}=tunnel({mobs:[['zombie',.5,64,6.5]],items:[SWORD]}),executed=[]
 const c={epoch:1,runner:{bot,ready:true,connectionId:'same',task:{result:{receipt:'unwalled'}}},safety:{status:'burrowed',retreat:TUNNEL_HUT},requestProgress:null,burrowWait:{quietMs:5,limitMs:1500,watches:1,patienceMs:0},
  persist(){},emit(){},say(){},dispatch(){},async execute(command){executed.push(command)},resume(){assert.fail('no request to resume')}}
 await Teammate.prototype.waitInBurrow.call(c,1,new AbortController().signal,bot,false)
 assert.deepEqual(executed.map(x=>x.action),['unhut'])
 const skilled=[];Runner.prototype.command.call({emit(){},skill:(kind,goal)=>skilled.push([kind,validateTaskGoal(kind,goal)])},executed[0])
 assert.deepEqual(skilled,[['unhut',{toward:{x:0,z:6}}]])
})
// The same hut, kitted, a lone blaze hovering outside the one-thick +x wall below
// eye level. Opening a door and resuming put the bot back under the alarm within
// seconds, which judged the shot through its own remaining wall and walled in again,
// every ninety seconds for fifteen minutes, without one arrow loosed.
const KIT=[{name:'bow',count:1,maxDurability:384,durabilityUsed:0},{name:'arrow',count:122},SWORD]
function portWait({shot,blaze=[5.5,63,.5],health=20,hut=()=>{},limitMs=1500,trip=false,food=20,items=[],cells}){
 const {bot}=tunnel({mobs:[['blaze',...blaze]],items:[...KIT,...items],cells}),executed=[],said=[],held=[]
 bot.health=health;bot.food=food
 // A kitted trip: a live request and iron armour with golden boots (nether-trip.js).
 if(trip){bot.getEquipmentDestSlot=s=>({head:5,torso:6,legs:7,feet:8})[s];for(const [i,n] of [[5,'iron_helmet'],[6,'iron_chestplate'],[7,'iron_leggings'],[8,'golden_boots']])bot.inventory.slots[i]={name:n}}
 const c={epoch:1,runner:{bot,ready:true,connectionId:'same',task:{result:{}}},safety:{status:'burrowed',retreat:{...TUNNEL_HUT}},requestProgress:trip?{id:'rods',request:'blaze rods',status:'interrupted',feedback:[]}:null,burrowWait:{quietMs:5,limitMs,watches:1,patienceMs:0},
  // Held in the hut, the blaze drifts off so the wait can end.
  persist(){},emit(){},say:t=>{said.push(t);if(/Holding the hut/.test(t))delete bot.entities[1]},dispatch(){},resume(){assert.fail('no request to resume')},tripEnded:Teammate.prototype.tripEnded,
  async execute(command){
   executed.push(command)
   if(command.action==='unhut'&&command.goal?.shooter){
    if(command.goal.skip?.some(s=>s.dx===1&&s.dz===0))throw new Error('No wall facing the blaze left to open without lava, water or fire beside it')
    this.runner.task={result:{receipt:'unwalled',port:true,side:{dx:1,dz:0}}};return
   }
   if(command.action==='shoot'){held.push(this.safety?.status);return shot(bot,this)}
   const built=command.action==='hut'?hut(bot,this,executed.filter(x=>x.action==='hut').length):null
   this.runner.task={result:{receipt:command.action==='hut'?'walled_in':'done',...built}}
  }}
 return {bot,c,executed,said,held}
}
// Lab run 150, 15 October: the same kit burrowed into this tunnel's floor, four blazes off
// the walls and one down the tunnel. The wait confronted one, and a burrow confronts by
// climbing out with no shot planned. A burrow holds while a shooter waits, then opens as before.
test('burrowed on a trip with blazes outside, the wait holds; once they are gone it opens up as before',async()=>{
 const shaft=new Map([[0,64,1,'air'],[0,65,1,'air'],[0,64,-1,'air'],[0,65,-1,'air'],[0,60,0,'air'],[0,61,0,'air'],[0,62,0,'air'],[0,63,0,'cobblestone'],[1,64,6,'air'],[1,65,6,'air']].map(([x,y,z,n])=>[new Vec3(x,y,z).toString(),n]))
 const burrowWait=gone=>{
  const {bot}=tunnel({mobs:[[4.5,64,2.5],[5.5,65,-3.5],[4.5,63,8.5],[6.5,64,-1.5],[.5,64,7.5]].map(p=>['blaze',...p]),items:[KIT[0],{name:'arrow',count:128},SWORD],cells:shaft}),executed=[],said=[]
  bot.entity.position=new Vec3(.5,60,.5);bot.game.dimension='minecraft:the_nether'
  bot.inventory.slots=[];bot.getEquipmentDestSlot=s=>({head:5,torso:6,legs:7,feet:8})[s]
  for(const [i,n] of [[5,'iron_helmet'],[6,'iron_chestplate'],[7,'iron_leggings'],[8,'golden_boots']])bot.inventory.slots[i]={name:n}
  const c={epoch:1,runner:{bot,ready:true,connectionId:'same',task:{result:{}}},safety:{status:'burrowed',retreat:{shelterName:'burrow',surface:{x:0,y:64,z:0}}},
   requestProgress:{id:'rods',request:'blaze rods',status:'interrupted',feedback:[]},burrowWait:{quietMs:5,limitMs:1200,watches:1,patienceMs:0},
   persist(){},emit(){},say:t=>said.push(t),dispatch(){},resume(){assert.fail('not eligible to resume')},
   async execute(command){executed.push({action:command.action,blazes:Object.keys(bot.entities).length});this.runner.task={result:{receipt:command.action}}}}
  if(gone)setTimeout(()=>{bot.entities={}},gone)
  return {bot,c,executed,said}
 }
 const held=burrowWait();await Teammate.prototype.waitInBurrow.call(held.c,1,new AbortController().signal,held.bot,false)
 assert.deepEqual(held.executed,[],held.said.join(' | '))
 const left=burrowWait(300);await Teammate.prototype.waitInBurrow.call(left.c,1,new AbortController().signal,left.bot,false)
 assert.deepEqual(left.executed,[{action:'unburrow',blazes:0}],left.said.join(' | '))
})
test('a shooter outside the hut is shot from a firing port while the shelter still holds, then the port closes',async()=>{
 const w=portWait({shot:(bot,c)=>{delete bot.entities[1];c.runner.task={result:{item:'blaze',receipt:'killed',count:1,shots:3,at:{x:5.5,y:63,z:.5}}}}})
 await Teammate.prototype.waitInBurrow.call(w.c,1,new AbortController().signal,w.bot,false)
 assert.deepEqual(w.executed.map(x=>x.action),['unhut','shoot','hut','unhut'],w.said.join(' | '))
 assert.deepEqual(w.executed[0].goal,{toward:{x:5,z:0},shooter:'blaze'})
 assert.deepEqual(w.executed[1].goal,{type:'blaze',collect:false,stay:true},'shot from cover, never walking out to find a line')
 assert.deepEqual(validateTaskGoal('shoot',w.executed[1].goal),w.executed[1].goal,'and the runner keeps it so')
 assert.deepEqual(w.held,['burrowed'],'the shelter is still held while it shoots, so the alarm does not fire')
 assert.equal(w.executed[3].goal.shooter,undefined,'with the blaze dead the hut opens as it always has')
 assert.deepEqual(w.c.killSites?.map(k=>k.at),[{x:5.5,y:63,z:.5}],'the rod is picked up when the wait ends')
 assert.equal(w.c.safety,null)
})
// Lab run 166, 16 October: a bay hut beside a blaze spawner room, the port shut and blazes six
// to ten blocks off for more than ten minutes. The room's roof (y 65 from x 4, solid from y 66
// over it all) hid them from the exits two cells out; the bot's eye through the port saw under
// it. On a trip such a blaze is shot through the port, as the two ports before it were.
test('on a trip a blaze the hut\'s exits cannot see but its port can is shot through the port',async()=>{
 const cells=new Map()
 for(let x=2;x<=12;x++)for(let z=-6;z<=6;z++){cells.set(new Vec3(x,66,z).toString(),'netherrack');if(x>=4)cells.set(new Vec3(x,65,z).toString(),'netherrack')}
 const kill=(bot,c)=>{delete bot.entities[1];c.runner.task={result:{item:'blaze',receipt:'killed',count:1,shots:6,at:{x:7.5,y:63.2,z:-.3}}}}
 const w=portWait({shot:kill,trip:true,blaze:[7.5,63.2,-.3],cells})
 await run(w)
 assert.deepEqual(w.executed.slice(0,3).map(x=>x.action),['unhut','shoot','hut'],w.said.join(' | '))
 assert.deepEqual(w.executed[0].goal,{toward:{x:7,z:-1},shooter:'blaze'})
 assert.equal(w.executed[1].goal.stay,true)
 assert.ok(w.said.some(t=>/fell to my arrows\. Port closed/.test(t)),w.said.join(' | '))
})
// Lab run 166, 16 October: at a blaze bay the fight is the work. A hut that kills through its port
// and comes out with no step completed and no rod in hand counted as idle, and the third such hut
// would have stopped the request at "Resume is available". A kill through the port is progress.
test('on a trip a kill through the port counts as progress, so the request continues past the idle cap',async()=>{
 const kill=(bot,c)=>{delete bot.entities[1];c.runner.task={result:{item:'blaze',receipt:'killed',count:1,shots:3,at:{x:5.5,y:63,z:.5}}}}
 const idle=()=>[{completedAt:0,advancedAt:0,resumeSerial:0},{completedAt:0,advancedAt:0,resumeSerial:0}]
 const w=portWait({shot:kill,trip:true});Object.assign(w.c.requestProgress,{completed:[],safetyContinuations:idle()})
 let resumed=0;w.c.resume=async()=>{resumed++}
 await Teammate.prototype.waitInBurrow.call(w.c,1,new AbortController().signal,w.bot,true)
 assert.ok(w.said.some(t=>/fell to my arrows\. Port closed/.test(t)),w.said.join(' | '))
 assert.equal(w.c.requestProgress.portKills,1,'the port kill is counted');assert.equal(w.c.requestProgress.advances,undefined,'and is not an item won')
 assert.equal(resumed,1,w.said.join(' | '))
 // With no kill, two idle continuations still stop it.
 const none=portWait({shot:noShot,trip:true,limitMs:800});Object.assign(none.c.requestProgress,{completed:[],safetyContinuations:idle()})
 let again=0;none.c.resume=async()=>{again++};delete none.bot.entities[1]
 await Teammate.prototype.waitInBurrow.call(none.c,1,new AbortController().signal,none.bot,true)
 assert.equal(again,0,none.said.join(' | '));assert.ok(none.said.some(t=>/Resume is available/.test(t)),none.said.join(' | '))
})
// Review of lab run 166: a side refused for no clear shot is skipped only until a port kill.
// The next mob may stand where that side is the shot, so after a kill every side is offered again.
test('after a kill through the port the sides tried before are offered again',async()=>{
 let n=0,again=null
 const w=portWait({limitMs:1500,shot:(bot,c)=>{
  if(++n===1)return noShot()
  const blaze=bot.entities[1];delete bot.entities[1];if(n===2)again=()=>{bot.entities[1]=blaze}
  c.runner.task={result:{item:'blaze',receipt:'killed',count:1,shots:3}}}})
 const execute=w.c.execute
 w.c.execute=async function(command){
  if(command.action==='unhut'&&command.goal?.shooter){w.executed.push(command);this.runner.task={result:{receipt:'unwalled',port:true,side:{dx:1,dz:0}}};return}
  await execute.call(this,command);if(command.action==='hut'&&again){again();again=null}
 }
 await run(w)
 const ports=w.executed.filter(x=>x.action==='unhut'&&x.goal?.shooter).map(x=>x.goal.skip)
 assert.deepEqual(ports,[undefined,[{dx:1,dz:0}],undefined],w.said.join(' | '))
})
// Lab run 156, 15 October: at a firing port into a sealed room of blazes the bot lost 11
// health in six seconds before the duel's own half-health line stopped it. On a kitted trip
// the port's shot breaks off at the first hit.
test('on a kitted trip the shot from the port breaks off at the first hit; off a trip it keeps the old line',async()=>{
 const kill=(bot,c)=>{delete bot.entities[1];c.runner.task={result:{item:'blaze',receipt:'killed',count:1,shots:3}}}
 const trip=portWait({shot:kill,trip:true})
 await Teammate.prototype.waitInBurrow.call(trip.c,1,new AbortController().signal,trip.bot,false)
 assert.deepEqual(trip.executed.find(x=>x.action==='shoot')?.goal,{type:'blaze',collect:false,stay:true,breakOnHit:true},trip.said.join(' | '))
 const off=portWait({shot:kill})
 await Teammate.prototype.waitInBurrow.call(off.c,1,new AbortController().signal,off.bot,false)
 assert.deepEqual(off.executed.find(x=>x.action==='shoot')?.goal,{type:'blaze',collect:false,stay:true})
})
const noShot=()=>{throw new Error('No clear shot at the blaze: netherrack is in the way')}
// Review of the burn rule: on fire without end (a fire block, say) the grace would mask every
// point lost until death. Past burnCapMs of continuous fire the wait douses once, and from
// then on a drop is a breach again.
test('burning past the cap, the wait douses once and then counts a drop as a breach',async()=>{
 const {bot}=tunnel({items:KIT}),executed=[],said=[];bot.entity.metadata=[1]
 const c={epoch:1,runner:{bot,ready:true,connectionId:'same',task:{result:{}}},safety:{status:'burrowed',retreat:{...TUNNEL_HUT}},requestProgress:null,burrowWait:{quietMs:3000,limitMs:3000,watches:1,patienceMs:0,burnCapMs:300},
  persist(){},emit(){},say:t=>said.push(t),dispatch(){},resume(){assert.fail('no request to resume')},async execute(command){executed.push({action:command.action,health:bot.health});this.runner.task={result:{receipt:command.action}}}}
 setTimeout(()=>{bot.health--},100);setTimeout(()=>{bot.health-=2},1200)
 await Teammate.prototype.waitInBurrow.call(c,1,new AbortController().signal,bot,false)
 assert.deepEqual(executed,[{action:'douse',health:19}],said.join(' | '))
 assert.ok(said.some(t=>/Health fell inside the emergency shelter/.test(t)),said.join(' | '))
})

// Lab run 156, 15 October: broken off at the port alight, the bot closed the hut and burned.
// Fire ticks after the hut has closed are a burn, not a breach: the hut is kept and the wait
// goes on. Only a drop while not burning, nor burnt within the last few seconds, fails it.
test('health lost to fire inside a closed hut is a burn, not a breach; a drop when not burning still fails it',async()=>{
 const closed=({burning})=>{
  const {bot}=tunnel({items:KIT}),executed=[],said=[];bot.entity.metadata=[burning?1:0]
  const c={epoch:1,runner:{bot,ready:true,connectionId:'same',task:{result:{}}},safety:{status:'burrowed',retreat:{...TUNNEL_HUT}},requestProgress:null,burrowWait:{quietMs:1500,limitMs:3000,watches:1,patienceMs:0},
   persist(){},emit(){},say:t=>said.push(t),dispatch(){},resume(){assert.fail('no request to resume')},async execute(command){executed.push(command.action);this.runner.task={result:{receipt:command.action}}}}
  return {bot,c,executed,said}
 }
 const fire=closed({burning:true})
 // 20 to 16 in four ticks; the flag goes out before the last, which still lands as a burn.
 for(const [ms,last] of [[200],[400],[600],[800,true]])setTimeout(()=>{fire.bot.health--;if(last)fire.bot.entity.metadata=[0]},ms)
 setTimeout(()=>{fire.bot.entity.metadata=[0]},700)
 await Teammate.prototype.waitInBurrow.call(fire.c,1,new AbortController().signal,fire.bot,false)
 assert.equal(fire.bot.health,16)
 assert.ok(!fire.said.some(t=>/Health fell/.test(t)),fire.said.join(' | '));assert.deepEqual(fire.executed,['unhut'],fire.said.join(' | '))
 const hit=closed({burning:false});setTimeout(()=>{hit.bot.health-=4},200)
 await Teammate.prototype.waitInBurrow.call(hit.c,1,new AbortController().signal,hit.bot,false)
 assert.ok(hit.said.some(t=>/Health fell inside the emergency shelter/.test(t)),hit.said.join(' | '));assert.deepEqual(hit.executed,[])
})

// Lab run 156, 15 October: on a trip, rods from the port's kills are walked for only after a
// quiet minute, on 16 health, and only within eight blocks of the hut (tripPickup).
test('on a trip the wait leaves the rods while a shooter was near in the last minute, and walks only for kills near the hut',async()=>{
 const site={at:{x:5.5,y:63,z:.5}}
 const kill=(bot,c)=>{delete bot.entities[1];rod(bot,site.at);c.runner.task={result:{item:'blaze',receipt:'killed',count:1,shots:3,at:site.at}}}
 const recent=portWait({shot:kill,trip:true})
 await Teammate.prototype.waitInBurrow.call(recent.c,1,new AbortController().signal,recent.bot,false)
 assert.ok(!recent.executed.some(x=>x.action==='collect'),recent.executed.map(x=>x.action).join(' '))
 assert.ok(recent.said.some(t=>/Leaving what fell .*shooter/.test(t)),recent.said.join(' | '))
 assert.deepEqual(recent.c.killSites.map(k=>k.at),[site.at],'kept for later');assert.equal(recent.c.killSites[0].trip,true,'a kill on the trip')
 // No shooter near for the whole wait: only the kill within eight blocks of the hut is walked for.
 const quiet=portWait({shot:kill,trip:true});delete quiet.bot.entities[1]
 quiet.c.killSites=[{at:site.at,time:Date.now()},{at:{x:14.5,y:64,z:.5},time:Date.now()}];rod(quiet.bot,site.at);rod(quiet.bot,{x:14.5,y:64,z:.5})
 await Teammate.prototype.waitInBurrow.call(quiet.c,1,new AbortController().signal,quiet.bot,false)
 assert.deepEqual(quiet.executed.find(x=>x.action==='collect')?.goal.at,[site.at],quiet.said.join(' | '))
 assert.deepEqual(quiet.c.killSites.map(k=>k.at),[{x:14.5,y:64,z:.5}],'the far one is left')
})

const run=async w=>{await Teammate.prototype.waitInBurrow.call(w.c,1,new AbortController().signal,w.bot,false);return w.executed.map(x=>x.action)}
const leaving=actions=>actions.filter(a=>['climb','flee','use_portal'].includes(a))
// Review of portReady: holding the port shut heals nothing with no food carried and too little
// hunger to regenerate. On a kitted trip that ends the trip, out of food; otherwise the hold is
// skipped and the hut's ordinary rules decide.
test('unable to heal while holding the port shut, a kitted trip ends out of food; off a trip the hold is skipped',async()=>{
 const trip=portWait({shot:noShot,trip:true,health:14,food:10,limitMs:800});trip.c.requestProgress.kittedTrip={at:'t',how:'crossed'}
 await run(trip)
 assert.match(String(trip.c.requestProgress.tripEnded?.reason),/out of food/,trip.said.join(' | '))
 assert.ok(trip.said.some(t=>/The Nether trip is over: .*out of food/.test(t)),trip.said.join(' | '))
 assert.ok(!trip.said.some(t=>/Holding the port/.test(t)),trip.said.join(' | '))
 const off=portWait({shot:noShot,health:14,food:10,limitMs:800});await run(off)
 assert.ok(!off.said.some(t=>/Holding the port/.test(t)),off.said.join(' | '))
 assert.ok(off.executed.some(x=>x.action==='unhut'&&x.goal?.shooter),off.said.join(' | '))
 assert.ok(off.said.some(t=>/cannot heal/.test(t)),off.said.join(' | '))
})
// With kills to fetch on a trip, the wait holds the hut quiet until no shooter has been near
// for a minute (or until the watch has no room left for it), then walks for them, guarded.
// Trip kills are kept until fetched or the trip ends, not dropped after four and a half minutes.
test('with kills to fetch on a trip the hut holds quiet a minute after the last shooter, then collects; trip kills last until the trip ends',async()=>{
 const site={x:5.5,y:63,z:.5},far={x:14.5,y:64,z:.5}
 const pending=({seenAgo,limitMs,age=0,onlyFar=false})=>{
  const w=portWait({shot:noShot,trip:true,limitMs});delete w.bot.entities[1]
  w.c.killSites=[{at:site,time:Date.now()-age,trip:true},{at:far,time:Date.now(),trip:true}].slice(onlyFar?1:0);w.c.shooterSeenAt=Date.now()-seenAgo
  // Lab run 166, 16 October: a site counts only while a rod lies at it.
  rod(w.bot,site);rod(w.bot,far)
  const at={};const execute=w.c.execute;w.c.execute=async function(command){at[command.action]??=Date.now();return execute.call(this,command)}
  return {...w,at}
 }
 // Seen twenty seconds ago, with a short watch: it holds, then gives the pickup up and says so.
 const held=pending({seenAgo:20000,limitMs:2000}),start=Date.now()
 await run(held)
 assert.ok(held.said.some(t=>/Holding the hut quiet/.test(t)),held.said.join(' | '))
 assert.ok(held.at.unhut-start>=450,'held before opening: '+(held.at.unhut-start))
 assert.ok(!held.executed.some(x=>x.action==='collect'),held.said.join(' | '))
 // Seen 59.4 seconds ago: it holds out the minute, then walks for the near kill only.
 const quiet=pending({seenAgo:59400,limitMs:4000,age:400000}),seen=quiet.c.shooterSeenAt
 await run(quiet)
 assert.deepEqual(quiet.executed.find(x=>x.action==='collect')?.goal.at,[site],quiet.said.join(' | '))
 assert.ok(quiet.at.unhut-seen>=60000,'opened only after a quiet minute');assert.ok(quiet.at.collect-seen>=60000)
 assert.deepEqual(quiet.c.killSites.map(k=>k.at),[far],'the far one is kept for later')
 // Only kills near the hut are worth holding for.
 const farOnly=pending({seenAgo:20000,limitMs:2000,onlyFar:true});await run(farOnly)
 assert.ok(!farOnly.said.some(t=>/Holding the hut quiet/.test(t)),farOnly.said.join(' | '))
 // The trip ending drops its kills; a kill from before it is kept.
 const said=[],c={requestProgress:{id:'rods',status:'interrupted',kittedTrip:{at:'t'}},killSites:[{at:site,time:Date.now(),trip:true},{at:far,time:Date.now()}],runner:{},say:t=>said.push(t),persist(){},cancel(){}}
 assert.equal(Teammate.prototype.tripEnded.call(c,'danger sent me home through the portal'),true)
 assert.deepEqual(c.killSites.map(k=>k.at),[far])
})
// Lab run 166, 16 October: at a blaze bay a hopper floor carried every rod off within a second,
// and the hut held "quiet before fetching what fell" for more than ten minutes over nothing.
// With no rod at either site it does not hold, walks for nothing, says nothing about leaving
// what fell, and forgets both sites, loaded and tracked with no drop.
test('with every rod carried off the hut does not hold quiet, walks for nothing and forgets the empty sites',async()=>{
 const w=portWait({shot:noShot,trip:true,limitMs:2000});delete w.bot.entities[1]
 w.c.killSites=[{at:{x:5.5,y:63,z:.5},time:Date.now(),trip:true},{at:{x:14.5,y:64,z:.5},time:Date.now(),trip:true}];w.c.shooterSeenAt=Date.now()-20000
 await run(w)
 assert.ok(!w.said.some(t=>/Holding the hut quiet|Leaving what fell/.test(t)),w.said.join(' | '))
 assert.ok(w.executed.some(x=>x.action==='unhut'),w.said.join(' | '));assert.ok(!w.executed.some(x=>x.action==='collect'),w.said.join(' | '))
 assert.deepEqual(w.c.killSites,[],'nothing lies at either site')
})
// Lab run 156, 15 October: broken off at 10 health and burning, the bot walled in and burned
// to death. In the Nether the wait opens no port toward a shooter until it is ready: hurt,
// alight or hungry it holds the hut, says why, and eats when it can.
test('hurt, burning or hungry, the wait holds the hut shut rather than open a port, says why, and eats',async()=>{
 const opened=w=>w.executed.filter(x=>['unhut','shoot'].includes(x.action)).map(x=>x.action)
 const hurt=portWait({shot:noShot,health:14,limitMs:800});await run(hurt)
 assert.deepEqual(opened(hurt),[],hurt.said.join(' | '));assert.ok(hurt.said.some(t=>/health 14 of 16/.test(t)),hurt.said.join(' | '))
 const burning=portWait({shot:noShot,limitMs:800});burning.bot.entity.metadata=[1];await run(burning)
 assert.deepEqual(opened(burning),[],burning.said.join(' | '));assert.ok(burning.said.some(t=>/on fire/.test(t)),burning.said.join(' | '))
 const hungry=portWait({shot:noShot,health:14,food:10,items:[{name:'cooked_beef',count:4}],limitMs:800});await run(hungry)
 assert.deepEqual(opened(hungry),[],hungry.said.join(' | '));assert.deepEqual(hungry.executed.map(x=>x.action),['eat'])
 // Ready again, the port opens as before.
 const well=portWait({shot:noShot,health:16,limitMs:800});await run(well)
 assert.deepEqual(opened(well).slice(0,2),['unhut','shoot'],well.said.join(' | '))
})
test('a firing port with no shot closes again and is not reopened; out of ports with the blaze close, it holds the hut',async()=>{
 const w=portWait({shot:noShot}),actions=await run(w)
 assert.deepEqual(actions.slice(0,4),['unhut','shoot','hut','unhut'],w.said.join(' | '))
 assert.deepEqual(w.executed[3].goal.skip,[{dx:1,dz:0}],'the port that had no shot is not opened again')
 assert.deepEqual(leaving(actions),[],'a blaze five blocks off is not walked away from: '+w.said.join(' | '))
 assert.ok(w.said.some(t=>/Holding the hut/.test(t)))
 assert.deepEqual(actions.slice(4),['unhut'],'the blaze gone, it opens up as before')
})
test('out of ports with the shooter ten or more blocks off and the bot strong, it moves away; not strong, it holds',async()=>{
 const far=portWait({shot:noShot,blaze:[12.5,63,.5]}),actions=await run(far)
 assert.deepEqual(actions,['unhut','shoot','hut','unhut','unhut','climb','flee'],far.said.join(' | '))
 const weak=portWait({shot:noShot,blaze:[12.5,63,.5],health:12})
 assert.deepEqual(leaving(await run(weak)),[],'twelve health it can heal from is not enough to leave on: '+weak.said.join(' | '))
})
test('hurt, the bot holds the hut and heals rather than port or leave',async()=>{
 const hurt=portWait({shot:noShot,blaze:[5.5,63,.5],health:9,limitMs:1200})
 assert.deepEqual(await run(hurt),[],hurt.said.join(' | '))
 // Hit through the port and breaking off, it closes up and holds rather than leave.
 const hit=portWait({shot:bot=>{bot.health=9;throw new Error('Breaking off at 9 health: the blaze survived 2 arrows')},limitMs:1200})
 const actions=await run(hit)
 assert.deepEqual(actions,['unhut','shoot','hut'],hit.said.join(' | '))
 assert.ok(!hit.said.some(t=>/Health fell/.test(t)),'the arrows taken at the open port are not a failed shelter')
})
test('a hit taken after the port is closed again still fails the shelter',async()=>{
 const w=portWait({shot:(bot,c)=>{delete bot.entities[1];c.runner.task={result:{item:'blaze',receipt:'killed',count:1,shots:3}}},hut:bot=>setTimeout(()=>{bot.health=15},20),limitMs:1200})
 await run(w)
 assert.ok(w.said.some(t=>/Health fell inside the emergency shelter/.test(t)),w.said.join(' | '))
})
test('a port that does not close at the first try is closed at the second, and the shelter keeps no open port on record',async()=>{
 const w=portWait({shot:(bot,c)=>{delete bot.entities[1];c.runner.task={result:{item:'blaze',receipt:'killed',count:1,shots:3}}},hut:(bot,c,n)=>{if(n===1)throw new Error('Hut incomplete: 1 of 10 blocks missing')}})
 const safety=w.c.safety,actions=await run(w)
 assert.deepEqual(actions,['unhut','shoot','hut','hut','unhut'],w.said.join(' | '))
 assert.equal(safety.port,undefined);assert.equal(safety.status,'burrowed','not a failed shelter')
 const twice=portWait({shot:noShot,hut:()=>{throw new Error('Hut incomplete: 2 of 10 blocks missing')}})
 const kept=twice.c.safety;await run(twice)
 assert.equal(kept.status,'failed');assert.equal(kept.port,undefined,'no stale port once the second close fails too')
})
test('a bot that did not get back into the hut from the port walls in where it stands, and the shelter follows it',async()=>{
 const w=portWait({shot:(bot,c)=>{delete bot.entities[1];bot.entity.position=new Vec3(1.5,64,.5);c.runner.task={result:{item:'blaze',receipt:'killed',count:1,shots:3,strayed:{x:1,y:64,z:0}}}},hut:()=>({surface:{x:1,y:64,z:0}})})
 const safety=w.c.safety,actions=await run(w)
 assert.deepEqual(actions.slice(0,3),['unhut','shoot','hut'],w.said.join(' | '))
 assert.deepEqual(safety.retreat.surface,{x:1,y:64,z:0},'the wait watches the hut it is actually in')
 assert.ok(w.said.some(t=>/not back in the hut/i.test(t)),w.said.join(' | '))
})
// Family rehearsal, 16 October: tunnel_out left the bot at the back exit's foot (y 59), one block
// of rock over a dark cave at y 55 to 57 under the base: three skeletons, a zombie 2.2 blocks
// below and two creepers at 3.6, every one sealed off and out of sight. It walled in and held
// "for daylight and a clear area" through four watches, then stopped until Resume.
const CAVE_BASE={x:-625,y:68,z:-368},CAVE_SHAFT={x:-623,z:-366},CAVE_FOOT=new Vec3(-623,59,-366)
const CAVE_MOBS=[['zombie',-622.5,56.8,-365.5],['creeper',-620.5,56,-365.5],['creeper',-622.5,56.2,-363.3],['skeleton',-625.5,55,-363.5],['skeleton',-619.5,55,-368.5],['skeleton',-626.5,55,-369.5]]
function sealedCave({cells=new Map(),timeOfDay=6000}={}){
 const name=p=>cells.has(p.toString())?cells.get(p.toString()):p.y>=CAVE_BASE.y?'air':p.x===CAVE_SHAFT.x&&p.z===CAVE_SHAFT.z&&p.y>=59?'air':p.y>=55&&p.y<=57&&p.x>=-627&&p.x<=-619&&p.z>=-370&&p.z<=-362?'air':'stone'
 return {cells,bot:base(CAVE_FOOT.offset(.5,0,.5),name,{timeOfDay,mobs:CAVE_MOBS})}
}
const CAVE_HUT={shelterName:'hut',surface:{x:CAVE_FOOT.x,y:CAVE_FOOT.y,z:CAVE_FOOT.z}}
test('walled in at the shaft foot over a sealed cave, the wait clears; a way in from the cave holds it',()=>{
 const exits=shelterExits(CAVE_HUT),r=burrowClearance(sealedCave().bot,{exits})
 assert.equal(r.clear,true,r.reason);assert.equal(r.relocate,undefined);assert.equal(r.confront,undefined)
 assert.deepEqual(r.sealed?.map(t=>t.name).sort(),['creeper','creeper','zombie'],'the ones only the rock floors held are named, for the chat')
 const under=sealedCave({cells:new Map([[CAVE_FOOT.offset(0,-1,0).toString(),'air']])})
 assert.equal(burrowClearance(under.bot,{exits}).clear,false,'the floor under the foot opened: the zombie is in sight')
 const side=sealedCave({cells:new Map([CAVE_FOOT.offset(2,0,0),CAVE_FOOT.offset(2,-1,0)].map(c=>[c.toString(),'air']))})
 assert.equal(burrowClearance(side.bot,{exits}).clear,false,'a cave cell opened to an exit: the flood reaches them')
 const warden=sealedCave();warden.bot.entities[7]={id:7,name:'warden',position:new Vec3(-624.5,55,-366.5)}
 assert.equal(burrowClearance(warden.bot,{exits}).clear,false,'rock does not stop a warden')
})
test('the shaft-foot wait that clears over a sealed cave climbs home into the base, says why and resumes',async()=>{
 // The hut's roof two above the feet closes the shaft over it, as the hut built it.
 const roofed=()=>sealedCave({cells:new Map([[CAVE_FOOT.offset(0,2,0).toString(),'cobblestone']])})
 const {bot}=roofed(),executed=[],said=[];let resumed=0
 const design=[];for(let x=0;x<4;x++)for(let z=0;z<4;z++)for(let y=0;y<3;y++)if((y===2||x===0||x===3||z===0||z===3)&&!(x===1&&z===0&&y<2))design.push({x,y,z,block:y===2?'dirt':'cobblestone'})
 const project={build:{origin:{...CAVE_BASE},design,wood:'spruce_log'},stations:{torch:{position:{x:-624,y:68,z:-366},confirmed:true}},backExit:{cell:{x:CAVE_SHAFT.x,y:CAVE_BASE.y,z:CAVE_SHAFT.z},bottom:59},built:true}
 const c={epoch:1,projects:{base:project},runner:{bot,ready:true,connectionId:'same',task:{result:{}}},safety:{status:'burrowed',reason:'A potential hostile is within ten blocks',retreat:{...CAVE_HUT}},
  requestProgress:{id:'r16',request:'mine iron',status:'interrupted',feedback:[],completed:[]},burrowWait:{quietMs:5,limitMs:1500,watches:1},
  persist(){},emit(){},say:t=>said.push(t),dispatch(){},async resume(){resumed++},
  async execute(command){executed.push(command);this.runner.task={result:command.action==='retreat'?{item:'shelter',count:1,receipt:'sheltered_door_closed',repaired:[{x:-623,y:70,z:-366,block:'dirt'}]}:{item:'safety',count:1,receipt:'unwalled'}}}}
 await Teammate.prototype.waitInBurrow.call(c,1,new AbortController().signal,bot,true)
 assert.deepEqual(executed.map(x=>x.action),['unhut','retreat'],said.join(' | '))
 assert.deepEqual(executed[1].goal.project.backExit,project.backExit,'the base is the goal, up the shaft')
 assert.equal(resumed,1,said.join(' | '))
 assert.ok(said.includes('The mobs are in a sealed cave under me and cannot reach me.'),said.join(' | '))
 assert.ok(said.some(t=>/One roof block was missing\. I put it back\./.test(t)),said.join(' | '))
 assert.ok(!said.some(t=>/Back on the surface/.test(t)),said.join(' | '))
 // A failed climb falls back to today's way: the request resumes from where the bot stands.
 const failed=roofed(),fsaid=[];let fresumed=0
 const logged=[]
 const f={...c,runner:{bot:failed.bot,ready:true,connectionId:'same',task:{result:{}},log:(type,data)=>logged.push([type,data])},safety:{status:'burrowed',retreat:{...CAVE_HUT}},requestProgress:{id:'r17',request:'mine iron',status:'interrupted',feedback:[],completed:[]},
  say:t=>fsaid.push(t),async resume(){fresumed++},async execute(command){if(command.action==='retreat')throw new Error('Climb stalled');this.runner.task={result:{item:'safety',count:1,receipt:'unwalled'}}}}
 await Teammate.prototype.waitInBurrow.call(f,1,new AbortController().signal,failed.bot,true)
 assert.equal(fresumed,1,fsaid.join(' | '))
 // Review of 16 October: chat is for the children; the detail goes to the log.
 assert.ok(fsaid.includes('I could not get back into the base. I will keep going from here.'),fsaid.join(' | '))
 assert.ok(!fsaid.some(t=>/Climb stalled/.test(t)),fsaid.join(' | '));assert.ok(logged.some(([type,data])=>type==='back_exit_climb_failed'&&/Climb stalled/.test(data.reason)),JSON.stringify(logged))
})
// Review of 16 October: the sealed release sends the bot home and the request back to work, the
// planner goes back down the shaft, the alarm fires at the foot, the hut waits, and round again.
// The second sealed release at one place holds that work: tunnel_out is refused with a reason the
// planner reads, chat says so once, and no line repeats each lap.
test('the second sealed release at the shaft foot ends the loop: tunnel_out is refused and chat does not repeat',async()=>{
 const roofed=()=>sealedCave({cells:new Map([[CAVE_FOOT.offset(0,2,0).toString(),'cobblestone']])}).bot
 const design=[];for(let x=0;x<4;x++)for(let z=0;z<4;z++)for(let y=0;y<3;y++)if((y===2||x===0||x===3||z===0||z===3)&&!(x===1&&z===0&&y<2))design.push({x,y,z,block:'cobblestone'})
 const project={build:{origin:{...CAVE_BASE},design,wood:'spruce_log'},stations:{torch:{position:{x:-624,y:68,z:-366},confirmed:true}},backExit:{cell:{x:CAVE_SHAFT.x,y:CAVE_BASE.y,z:CAVE_SHAFT.z},bottom:59},built:true}
 const request={id:'loop',request:'mine iron',status:'interrupted',feedback:[],completed:[]},said=[];let resumed=0
 const c={epoch:1,projects:{base:project},runner:{bot:null,ready:true,connectionId:'same',task:{result:{}}},requestProgress:request,burrowWait:{quietMs:5,limitMs:1500,watches:1},
  persist(){},emit(){},say:t=>said.push(t),dispatch(){},async resume(){resumed++},async execute(command){this.runner.task={result:{item:'safety',count:1,receipt:command.action==='retreat'?'sheltered_door_closed':'unwalled'}}}}
 const lap=async()=>{const bot=roofed();c.runner.bot=bot;c.safety={status:'burrowed',retreat:{...CAVE_HUT}};request.status='interrupted';await Teammate.prototype.waitInBurrow.call(c,1,new AbortController().signal,bot,true)}
 await lap()
 assert.equal(Teammate.prototype.sealedHoldRefusal.call(c,{action:'tunnel_out',goal:{}}),null,'one release holds nothing')
 await lap();await lap()
 assert.equal(resumed,2,said.join(' | ')+' (a third idle continuation is already stopped by the continuation cap)')
 const refusal=Teammate.prototype.sealedHoldRefusal.call(c,{action:'tunnel_out',goal:{}})
 assert.match(refusal?.message||'',/sealed cave/,'the planner is told why going back down is refused')
 await assert.rejects(Teammate.prototype.executeCommand.call(c,{action:'tunnel_out',goal:{},timeoutMs:1000},new AbortController().signal),/sealed cave/)
 assert.equal(Teammate.prototype.sealedHoldRefusal.call(c,{action:'mine',goal:{}}),null,'other work is not refused')
 assert.ok(request.feedback.some(f=>f.action==='safety_hold'&&/tunnel_out/.test(f.reason)),JSON.stringify(request.feedback))
 const count=re=>said.filter(t=>re.test(t)).length
 assert.equal(count(/sealed cave under me/),1,said.join(' | '));assert.equal(count(/keep sending me back up/),1,said.join(' | '))
 assert.equal(count(/I climbed the back exit/),1,said.join(' | '))
 // Second review of 16 October: the hold lasts ten minutes from the second release, and a release
 // older than that does not count toward the next one.
 for(const h of request.sealedHolds)h.until=Date.now()-1
 assert.equal(Teammate.prototype.sealedHoldRefusal.call(c,{action:'tunnel_out',goal:{}}),null,'past its window the back exit is open again')
 for(const k of Object.keys(request.sealedReleases))request.sealedReleases[k]=request.sealedReleases[k].map(()=>Date.now()-SEALED_WINDOW_MS-1)
 request.sealedHolds=[];await lap()
 assert.equal(Teammate.prototype.sealedHoldRefusal.call(c,{action:'tunnel_out',goal:{}}),null,'one release in the window holds nothing')
})
// Second review of 16 October: away from the back exit no work is refused; the planner is told and chat says it once.
test('sealed releases at a hut away from the back exit refuse nothing and say so once',async()=>{
 const roofed=()=>sealedCave({cells:new Map([[CAVE_FOOT.offset(0,2,0).toString(),'cobblestone']])}).bot
 const request={id:'site',request:'mine iron',status:'interrupted',feedback:[],completed:[]},said=[]
 const c={epoch:1,projects:{},runner:{bot:null,ready:true,connectionId:'same',task:{result:{}}},requestProgress:request,burrowWait:{quietMs:5,limitMs:1500,watches:1},
  persist(){},emit(){},say:t=>said.push(t),dispatch(){},async resume(){},async execute(){this.runner.task={result:{item:'safety',count:1,receipt:'unwalled'}}}}
 for(let i=0;i<3;i++){const bot=roofed();c.runner.bot=bot;c.safety={status:'burrowed',retreat:{...CAVE_HUT}};request.status='interrupted';await Teammate.prototype.waitInBurrow.call(c,1,new AbortController().signal,bot,true)}
 for(const action of ['tunnel_out','leave_base','mine','bore'])assert.equal(Teammate.prototype.sealedHoldRefusal.call(c,{action,goal:{}}),null,action)
 assert.equal(said.filter(t=>/keep stopping my work/.test(t)).length,1,said.join(' | '));assert.equal(said.filter(t=>/cannot reach me/.test(t)).length,1,said.join(' | '))
 assert.ok(request.feedback.some(f=>f.action==='sealed_note'&&/work elsewhere/.test(f.reason)),JSON.stringify(request.feedback));assert.deepEqual(request.sealedHolds||[],[])
})
