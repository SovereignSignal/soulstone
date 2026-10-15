import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {burrowClearance,shelterExits} from '../src/burrow.js'
import {roofed} from '../src/observations.js'
import {emergencyReason,NIGHT_EXPOSURE} from '../src/survival.js'
import {Teammate} from '../src/companion/controller.js'
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
 const close=deep({mobs:[['creeper',-595.5,-39,-332.5]]})
 assert.equal(burrowClearance(close.bot,{exits}).clear,false,'a creeper within four blocks counts through rock')
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
function portWait({shot,blaze=[5.5,63,.5],health=20,hut=()=>{},limitMs=1500}){
 const {bot}=tunnel({mobs:[['blaze',...blaze]],items:KIT}),executed=[],said=[],held=[]
 bot.health=health
 const c={epoch:1,runner:{bot,ready:true,connectionId:'same',task:{result:{}}},safety:{status:'burrowed',retreat:{...TUNNEL_HUT}},requestProgress:null,burrowWait:{quietMs:5,limitMs,watches:1,patienceMs:0},
  // Held in the hut, the blaze drifts off so the wait can end.
  persist(){},emit(){},say:t=>{said.push(t);if(/Holding the hut/.test(t))delete bot.entities[1]},dispatch(){},resume(){assert.fail('no request to resume')},
  async execute(command){
   executed.push(command)
   if(command.action==='unhut'&&command.goal?.shooter){
    if(command.goal.skip?.some(s=>s.dx===1&&s.dz===0))throw new Error('No wall facing the blaze left to open without lava, water or fire beside it')
    this.runner.task={result:{receipt:'unwalled',port:true,side:{dx:1,dz:0}}};return
   }
   if(command.action==='shoot'){held.push(this.safety?.status);return shot(bot,this)}
   if(command.action==='hut')hut(bot,this,executed.filter(x=>x.action==='hut').length)
   this.runner.task={result:{receipt:command.action==='hut'?'walled_in':'done'}}
  }}
 return {bot,c,executed,said,held}
}
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
const noShot=()=>{throw new Error('No clear shot at the blaze: netherrack is in the way')}
const run=async w=>{await Teammate.prototype.waitInBurrow.call(w.c,1,new AbortController().signal,w.bot,false);return w.executed.map(x=>x.action)}
const leaving=actions=>actions.filter(a=>['climb','flee','use_portal'].includes(a))
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
