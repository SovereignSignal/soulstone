import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {readFileSync} from 'node:fs'
import {Vec3} from 'vec3'
import minecraftData from 'minecraft-data'
import {blazeStand,blazeStandRefusal,BLAZE_STAND} from '../src/blaze-stand.js'
import {validateStandGoal} from '../src/enderman-stand.js'
import {executeSkill} from '../src/skills.js'
import {OwnBlocks,trackOwnPlacements} from '../src/natural.js'
import {validatePlan} from '../src/companion/planner.js'
import {validateTaskGoal} from '../src/task-store.js'
import {Teammate} from '../src/companion/controller.js'
import {THREAT_INTERRUPTION} from '../src/survival.js'

// The blaze stand (design of the blaze endgame, after the R8 trip of 17 October 02:10Z to 03:37Z): blaze rods fought for from
// a hut over the spawner platform, a bow for what is in line beyond reach and the sword for what comes into the port.
const registry=minecraftData('1.21.4')
const key=p=>`${p.x},${p.y},${p.z}`
const IN_COLUMN=p=>Math.floor(p.x)===-36&&Math.floor(p.z)===-8

// The R8 room, reduced (r8-scan-spawner.txt): netherrack to y 57, the spawner at -35,58,-8, open air above. The stand cell
// -36,60,-9 stands on the bot's own cobblestone at -36,59,-9, two above the platform; its south port is -36,61,-8, the sill
// under it -36,60,-8, the ledge beyond the sill -36,60,-7. Blazes: {at, hits}; an arrow does nothing unless onShot says so,
// and onOpen runs when the port cell is dug (a blaze starting in the port column would stand in the hut's own wall).
// A blaze struck `hits` times dies and drops a rod where it is (dropAt overrides). An item is picked up when it meets the
// bot's box inflated 1.0 across and 0.5 up and down (vanilla), so a rod on the sill comes in and one on the ledge does not.
function fixture({feet=[-36,60,-9],blazes=[{at:[-35.5,61.5,-3.5]}],cells=[],own=[],health=20,food=20,arrows=64,dimension='the_nether'}={}){
 const bot=new EventEmitter(),map=new Map(),log={events:[],swings:[],shots:0,steps:[],outside:0}
 map.set('-35,58,-8','spawner')
 const floor=new Vec3(feet[0],feet[1]-1,feet[2]);map.set(key(floor),'cobblestone')
 for(const [x,y,z,n] of cells)map.set(`${x},${y},${z}`,n)
 const name=c=>map.get(key(c))??(c.y<=57?'netherrack':'air')
 const inv=[{name:'cobblestone',count:64},{name:'bow',count:1,maxDurability:384,durabilityUsed:0},{name:'arrow',count:arrows},{name:'iron_sword',count:1,maxDurability:250,durabilityUsed:0}]
 const slots=[];for(const [i,n] of [[5,'iron_helmet'],[6,'iron_chestplate'],[7,'iron_leggings'],[8,'golden_boots']])slots[i]={name:n}
 const gain=(n,count)=>{const s=inv.find(i=>i.name===n);if(s)s.count+=count;else inv.push({name:n,count})}
 let nextId=20,drawing=false
 const add=e=>{e.id=nextId++;e.uuid=`10000000-0000-0000-0000-0000000000${e.id}`;bot.entities[e.id]=e;return e}
 const blaze=({at,hits=2,dropAt=null})=>add({name:'blaze',type:'hostile',height:1.8,width:.6,position:new Vec3(...at),velocity:new Vec3(0,0,0),hits,dropAt})
 const kill=(t,drop=true)=>{delete bot.entities[t.id];bot.emit('entityDead',t);if(drop)add({name:'item',type:'object',position:(t.dropAt?new Vec3(...t.dropAt):t.position).clone(),pickupAt:Date.now()+(t.pickupDelay||0),getDroppedItem:()=>({name:'blaze_rod',count:1})})}
 const pickUp=()=>{const p=bot.entity.position;for(const e of Object.values(bot.entities))if(e.name==='item'&&!(Date.now()<e.pickupAt)&&Math.abs(e.position.x-p.x)<=1.425&&Math.abs(e.position.z-p.z)<=1.425&&e.position.y>=p.y-.75&&e.position.y<=p.y+2.3){const s=e.getDroppedItem();gain(s.name,s.count);delete bot.entities[e.id]}}
 const blockAt=p=>{const c=p.floored(),n=name(c);return {name:n,position:c,boundingBox:registry.blocksByName[n]?.boundingBox,diggable:true}}
 Object.assign(bot,{registry,game:{dimension:'minecraft:'+dimension,gameMode:'survival',difficulty:'normal'},health,food,players:{},entities:{},time:{timeOfDay:6000},
  entity:{position:new Vec3(feet[0]+.5,feet[1],feet[2]+.5),onGround:true,height:1.8,width:.6,eyeHeight:1.62},
  inventory:{items:()=>inv.filter(i=>i.count>0).map(i=>({...i,type:registry.itemsByName[i.name].id})),slots},getEquipmentDestSlot:s=>({head:5,torso:6,legs:7,feet:8})[s],
  blockAt,world:{raycast:(from,dir,range)=>{for(let d=0;d<=range;d+=.02){const b=blockAt(from.plus(dir.scaled(d)));if(b.boundingBox==='block')return b}return null}},
  async equip(item){bot.heldItem=item},
  // The server refuses a block inside a mob, as inside a player.
  async placeBlock(ref,face){const p=ref.position.plus(face)
   if(Object.values(bot.entities).some(e=>e.name!=='item'&&Math.abs(e.position.x-(p.x+.5))<.5+(e.width??.6)/2&&Math.abs(e.position.z-(p.z+.5))<.5+(e.width??.6)/2&&e.position.y<p.y+1&&e.position.y+(e.height||1.8)>p.y))throw new Error('Block placement rejected: entity in the way')
   // An item lying in the cell is walled in: lost to the bot.
   for(const e of Object.values(bot.entities))if(e.name==='item'&&e.position.floored().equals(p)){delete bot.entities[e.id];log.events.push(['walled',key(p)])}
   log.events.push(['place',key(p),bot.health]);map.set(key(p),'cobblestone');inv[0].count--},
  async dig(block){log.events.push(['dig',key(block.position)]);map.set(key(block.position),'air');if(key(block.position)===PORT)log.onOpen?.()},
  tool:{async equipForBlock(){}},setControlState(){},clearControlStates(){},setQuickBarSlot(){},quickBarSlot:0,
  activateItem(){drawing=true},
  deactivateItem(){if(!drawing)return;drawing=false;inv[2].count--;log.shots++;log.events.push(['shot']);log.onShot?.(log.shots)},
  async look(){},
  async lookAt(p){const t=Object.values(bot.entities).find(e=>e.name==='blaze'&&Math.abs(e.position.x-p.x)<.01&&Math.abs(e.position.z-p.z)<.01);if(t&&!IN_COLUMN(t.position))log.outside++},
  attack(t){log.swings.push({id:t.id,inside:IN_COLUMN(t.position)});log.events.push(['swing']);t.struck=(t.struck||0)+1;log.onSwing?.(t);if(t.struck>=t.hits)kill(t,t.drops!==false)},
  pathfinder:{movements:null,setMovements(m){this.movements=m},setGoal(){},async goto(g){log.steps.push(key(g))}}})
 const ownBlocks=new OwnBlocks(null)
 ownBlocks.add(floor,'cobblestone','the_nether')
 for(const [x,y,z] of own){map.set(`${x},${y},${z}`,'cobblestone');ownBlocks.add(new Vec3(x,y,z),'cobblestone','the_nether')}
 trackOwnPlacements(bot,ownBlocks)
 for(const b of blazes)blaze(b)
 const timer=setInterval(pickUp,5)
 const api={check(){},stage(){},progress(){},persist(){},movements:null}
 return {bot,map,inv,log,api,add,blaze,kill,stop:()=>clearInterval(timer)}
}
const fast={settleMs:60,poll:5,cooldownMs:0,drawMs:10,idleMs:400,drawInMs:2000,blinkMs:30,emptyMs:250,healMs:400,limitMs:4000,closeWaitMs:100,closeTries:2,closeLimitMs:300,finalCloseMs:2000}
const stand=async(f,count=1,options={})=>{try{return await blazeStand(f.bot,{kind:'stand',goal:validateStandGoal({item:'blaze_rod',count})},f.api,{...fast,...options})}finally{f.stop()}}
const rods=f=>f.inv.find(i=>i.name==='blaze_rod')?.count||0
const PORT='-36,61,-8'
const at=(f,kind,cell)=>f.log.events.findIndex(e=>e[0]===kind&&(cell===undefined||e[1]===cell))
const after=(f,i,kind,cell)=>{const j=f.log.events.slice(i+1).findIndex(e=>e[0]===kind&&(cell===undefined||e[1]===cell));return j<0?-1:i+1+j}

test('stand for blaze_rod refuses a cell inside the spawner\'s volume and one with no port side toward a blaze',async()=>{
 // R8's pocket: feet -36,59,-8, beside the spawner and one above it.
 const pocket=fixture({feet:[-36,59,-8]});pocket.stop()
 assert.match(blazeStandRefusal(pocket.bot),/-36,59,-8 is inside the spawner's reach at -35,58,-8/)
 await assert.rejects(stand(fixture({feet:[-36,59,-8]})),/inside the spawner's reach/)
 // The step cell two above the platform is outside it.
 const good=fixture();good.stop();assert.equal(blazeStandRefusal(good.bot),'')
 // A blaze straight overhead: no wall faces it.
 const above=fixture({blazes:[{at:[-35.5,66,-8.5]}]});above.stop();assert.match(blazeStandRefusal(above.bot),/No wall here opens toward a blaze/)
 // Review of the stand: the port cell too. A spawner a block over the port's level takes the port cell into its reach.
 const portIn=fixture({cells:[[-35,62,-8,'spawner']],blazes:[{at:[-35.5,61.5,-3.5]}]});portIn.stop()
 assert.match(blazeStandRefusal(portIn.bot),/The port cell -36,61,-8 is inside the spawner's reach at -35,62,-8/)
 const none=fixture({blazes:[]});none.stop();assert.match(blazeStandRefusal(none.bot),/No blaze within 32 blocks/)
 const home=fixture({dimension:'overworld'});home.stop();assert.match(blazeStandRefusal(home.bot),/Nether only/)
 const short=fixture({arrows:15});short.stop();assert.match(blazeStandRefusal(short.bot),/Not on a kitted trip: 16 arrows \(carrying 15\)/)
 assert.equal(pocket.log.events.length,0,'nothing built where it refuses')
})

test('the stand digs its own blocks in the port\'s cone within reach and places the ledge before the first open',async()=>{
 // A blaze up and south: the line from the eye leaves the port through its top into the bot's own plug at -36,62,-8.
 const f=fixture({own:[[-36,62,-8]],blazes:[{at:[-35.5,62,-4.5]}]})
 f.log.onShot=()=>f.kill(Object.values(f.bot.entities).find(e=>e.name==='blaze'),false)
 await assert.rejects(stand(f),/No blaze rod gained: 1 blaze killed/)
 const dug=at(f,'dig','-36,62,-8'),ledge=after(f,dug,'place','-36,60,-7'),open=after(f,ledge,'dig',PORT)
 assert.ok(dug>=0&&ledge>dug&&open>ledge,JSON.stringify(f.log.events.slice(-8)))
 assert.equal(f.log.events.filter(e=>e[0]==='dig'&&e[1]==='-36,62,-8').length,1,'one dig of the plug')
 assert.equal(f.log.events.filter(e=>e[0]==='place'&&e[1]==='-36,60,-7').length,1,'one ledge')
 // Nothing past the dig reach is dug, nor a natural block in the line, and with rock over the port no ledge goes down.
 const far=fixture({own:[[-36,64,-3]],blazes:[{at:[-35.5,64,-.5]}]})
 await assert.rejects(stand(far,1,{limitMs:300}))
 assert.equal(at(far,'dig','-36,64,-3'),-1,'out of dig reach')
 const rock=fixture({cells:[[-36,62,-8,'netherrack']],blazes:[{at:[-35.5,62,-4.5]}]})
 await assert.rejects(stand(rock,1,{limitMs:300}))
 assert.equal(at(rock,'dig','-36,62,-8'),-1,'natural ground is left');assert.equal(at(rock,'place','-36,60,-7'),-1,'no ledge under rock')
})

test('a blaze in line beyond reach gets an arrow; one in the port column gets the sword, and the port stays open between',async()=>{
 const f=fixture()
 // Shot at, it comes to the port, feet on the sill, as a pursuing blaze does.
 f.log.onShot=()=>{const b=Object.values(f.bot.entities).find(e=>e.name==='blaze');if(b)b.position=new Vec3(-35.5,61,-7.5)}
 const r=await stand(f)
 assert.equal(r.rods,1);assert.equal(r.kills,1);assert.equal(r.ports,1);assert.equal(r.partial,false)
 const shot=at(f,'shot'),swing=after(f,shot,'swing')
 assert.ok(shot>=0&&swing>shot,JSON.stringify(f.log.events))
 assert.equal(f.log.events.slice(shot,swing).filter(e=>e[0]==='place').length,0,'no hut between the arrow and the sword')
 assert.ok(f.log.swings.every(s=>s.inside));assert.equal(f.bot.heldItem.name,'cobblestone','the port closed at the end')
 assert.equal(f.map.get(PORT),'cobblestone')
})

test('a blaze knocked out of the port is not struck until it is back inside',async()=>{
 const f=fixture({blazes:[{at:[-35.5,61.5,-3.5],hits:3}]})
 f.log.onOpen=()=>{const b=Object.values(f.bot.entities).find(e=>e.name==='blaze');if(b)b.position=new Vec3(-35.5,61,-7.5)}
 // Each hit knocks it a block out over the ledge, still in reach; it floats back a moment later.
 f.log.onSwing=t=>{if(t.struck<t.hits){t.position=new Vec3(-35.5,61,-6.2);setTimeout(()=>{t.position=new Vec3(-35.5,61,-7.5)},60)}}
 const r=await stand(f)
 assert.equal(r.rods,1)
 assert.equal(f.log.swings.length,3,'one swing a visit');assert.ok(f.log.swings.every(s=>s.inside),'never struck outside the port column')
 assert.ok(f.log.outside>0,'it was watched while outside')
})

test('a hit closes the port, the stand heals to 16 shut, and opens again',async()=>{
 const f=fixture()
 f.log.onShot=n=>{const b=Object.values(f.bot.entities).find(e=>e.name==='blaze');if(n===1){f.bot.health=14;setTimeout(()=>{f.bot.health=20},80)}else if(b){b.dropAt=[-35.5,61,-7.5];f.kill(b)}}
 const r=await stand(f)
 assert.equal(r.rods,1);assert.equal(r.ports,2)
 const open=at(f,'dig',PORT),shot=after(f,open,'shot'),close=after(f,shot,'place',PORT),again=after(f,close,'dig',PORT)
 assert.ok(open>=0&&shot>open&&close>shot&&again>close,JSON.stringify(f.log.events))
 assert.equal(f.log.events[close][2],14,'shut at 14 health')
})

test('a melee mob within 3 of the port cell closes it; one at 8 does not',async()=>{
 const hoglin=(f,at)=>f.add({name:'hoglin',type:'hostile',height:1.4,width:1.4,position:new Vec3(...at)})
 const near=fixture();let h=null
 near.log.onShot=n=>{if(n===1){h=hoglin(near,[-34.2,61,-6.2]);setTimeout(()=>{delete near.bot.entities[h.id]},150)}}
 const place=near.bot.placeBlock;let closedWithHoglin=false
 near.bot.placeBlock=async(ref,face)=>{await place(ref,face);if(h&&near.bot.entities[h.id]&&near.map.get(PORT)==='cobblestone')closedWithHoglin=true}
 await assert.rejects(stand(near,1,{limitMs:600}))
 assert.ok(closedWithHoglin,'the port shut with the hoglin beside it')
 const far=fixture()
 far.log.onShot=n=>{const b=Object.values(far.bot.entities).find(e=>e.name==='blaze');if(n===1)hoglin(far,[-35.5,58,.5]);if(n===3&&b){b.dropAt=[-35.5,61,-7.5];far.kill(b)}}
 const r=await stand(far)
 assert.equal(r.rods,1);assert.equal(r.ports,1,'the port stayed open with a hoglin 8 blocks off')
})

test('a rod on the sill counts from the inventory delta; one on the ledge is named in missed and the bot never moves',async()=>{
 // The second is shot at range and dies knocked back onto the ledge.
 const f=fixture({blazes:[{at:[-35.5,61.5,-2.5]},{at:[-35.5,61.5,-1.5]}]});let first=null
 f.log.onOpen=()=>{first??=Object.values(f.bot.entities).find(e=>e.name==='blaze');first.position=new Vec3(-35.5,61,-7.5)}
 f.log.onShot=()=>{const b=Object.values(f.bot.entities).find(e=>e.name==='blaze'&&e!==first);if(b){b.position=new Vec3(-35.5,61,-6.3);f.kill(b)}}
 const r=await stand(f,2)
 assert.equal(r.kills,2);assert.equal(r.rods,1);assert.equal(r.count,1);assert.equal(r.partial,true);assert.equal(rods(f),1)
 assert.match(r.missed.join('; '),/1 blaze_rod at -36,61,-7/)
 assert.deepEqual(f.log.steps,[],'never left the hut');assert.deepEqual(f.bot.entity.position,new Vec3(-35.5,60,-8.5))
})

test('the stand stops at the count, at 15 arrows, at the time limit, and after two minutes with no blaze loaded, each with its reason; kills with no rod never count as rods',async()=>{
 const count=fixture({blazes:[{at:[-35.5,61.5,-2.5]},{at:[-35.5,61.5,-3.5]}]})
 count.log.onOpen=()=>{const b=Object.values(count.bot.entities).find(e=>e.name==='blaze');if(b&&!count.moved){count.moved=true;b.position=new Vec3(-35.5,61,-7.5)}}
 const c=await stand(count);assert.equal(c.stopped,'reached the count');assert.equal(c.rods,1)
 await assert.rejects(stand(fixture({arrows:17})),/No blaze rod gained: 0 blazes killed.*arrows 15 are under 16/)
 await assert.rejects(stand(fixture(),1,{limitMs:250}),/the stand's .* ran out/)
 const gone=fixture();gone.log.onShot=()=>gone.kill(Object.values(gone.bot.entities).find(e=>e.name==='blaze'),false)
 await assert.rejects(stand(gone),/No blaze rod gained: 1 blaze killed.*no blaze loaded within 32 blocks for/)
 assert.ok(BLAZE_STAND.emptyMs===120000&&BLAZE_STAND.limitMs===600000&&BLAZE_STAND.arrows===16)
})

test('the planner, the task store and the skill admit stand for 1 to 8 blaze rods',async()=>{
 const step={action:'stand',name:'',item:'blaze_rod',count:4,design:[],target:null}
 assert.equal(validatePlan({reply:'Rods',steps:[step]}).steps[0].item,'blaze_rod')
 assert.throws(()=>validatePlan({reply:'',steps:[{...step,item:'diamond'}]}),/stand/)
 assert.throws(()=>validatePlan({reply:'',steps:[{...step,count:9}]}),/stand/)
 assert.deepEqual(validateTaskGoal('stand',{item:'blaze_rod',count:4}),{item:'blaze_rod',count:4})
 assert.throws(()=>validateTaskGoal('stand',{item:'blaze_rod',count:0}),/1 to 8/)
 // The brief: stand for rods from outside the spawner's reach, and never bore down into the room.
 const brief=readFileSync(new URL('../src/companion/survival-capabilities.txt',import.meta.url),'utf8')
 assert.match(brief,/^Action stand for blaze rods: name="", item="blaze_rod", count=1–8.*outside the spawner's reach.*never steps out.*partial means some rods, never none/m)
 const nether=brief.split('\n').find(l=>l.startsWith('THE NETHER'))
 assert.match(nether,/then stand for the rods\. Never bore down into the room/);assert.doesNotMatch(nether,/picking up rods between waves/)
 // The skill table sends a rod stand to the blaze stand, which refuses here outside the Nether.
 const f=fixture({dimension:'overworld'});f.stop()
 await assert.rejects(executeSkill(f.bot,{kind:'stand',goal:{item:'blaze_rod',count:1}},f.api),/blazes live in fortresses/)
})

// The stand fights blazes at its port on purpose: they are its work, not an alarm. Anything else hostile still is.
test('a blaze at the port does not interrupt a blaze stand; it still interrupts other work, and a hoglin interrupts the stand',async()=>{
 const tick=async({kind='stand',mob='blaze',item='blaze_rod'}={})=>{
  const f=fixture({blazes:[{at:[-35.5,61,-7.5]}]});f.stop()
  const e=Object.values(f.bot.entities).find(x=>x.name==='blaze');e.name=mob
  f.bot.findBlocks=()=>[];f.bot.findBlock=()=>null;f.bot.entity.metadata={0:0}
  const r=Object.assign(new EventEmitter(),{profile:'stand',owner:'Sov',ready:true,connectionId:'one',bot:f.bot,commands:[],position:()=>({x:-36,y:60,z:-9}),log(){},
   command(c){this.commands.push(c);this.task={id:String(this.commands.length),kind:c.action,status:'running',goal:c.goal}}})
  const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-blaze-stand-')),'state.json'))
  r.task={id:'s',kind,status:'running',goal:{item,count:1}}
  r.emit('event',{type:'survival_tick'});await new Promise(res=>setTimeout(res,20))
  const reason=c.safety?.reason;c.cancel?.(true);return reason
 }
 assert.equal(await tick(),undefined,'the stand carries on')
 assert.equal(await tick({kind:'goto'}),THREAT_INTERRUPTION)
 assert.equal(await tick({item:'ender_pearl'}),THREAT_INTERRUPTION,'a pearl stand is not fighting blazes')
 assert.equal(await tick({mob:'hoglin'}),THREAT_INTERRUPTION)
})

// Review of the stand: the sword strikes only in the port column. A blaze in reach beside it, never yet in the port, is
// watched, not struck or shot: killed there its rod falls beyond the wall.
test('a blaze in reach outside the port column is watched, not struck or shot, until it comes into the column',async()=>{
 const f=fixture({blazes:[{at:[-35.5,61.5,-3.5]}]})
 f.log.onOpen=()=>{const b=Object.values(f.bot.entities).find(e=>e.name==='blaze');b.position=new Vec3(-35.5,61,-6.3);setTimeout(()=>{b.position=new Vec3(-35.5,61,-7.5)},80)}
 const r=await stand(f)
 assert.equal(r.rods,1);assert.ok(f.log.swings.every(s=>s.inside),'no swing outside the column');assert.equal(f.log.shots,0,'no arrow at it')
 assert.ok(f.log.outside>0,'it was watched while outside')
})

// Review of the stand: a 1.4-wide hoglin on the ledge stands in the port cell's box, and the server refuses the block. The
// close waited it out and gave up with the port open while it hit the bot through it. Now any mob hostile to the bot that
// holds the port is struck in place until the port closes, and under the trip line the close keeps going; the bot never leaves.
test('a hoglin standing on the ledge during a close is struck until the port closes, under the trip line too, and the bot never moves',async()=>{
 const f=fixture();let h=null
 f.log.onShot=n=>{if(n===1){h=f.add({name:'hoglin',type:'hostile',height:1.4,width:1.4,position:new Vec3(-35.5,61,-6.4),hits:5,drops:false});f.bot.health=11}}
 await assert.rejects(stand(f,1,{closeLimitMs:50}),/No blaze rod gained: 0 blazes killed, 1 port opened; health 11 is under 12/)
 assert.equal(f.log.swings.filter(s=>s.id===h.id).length,5,'struck until it died');assert.equal(f.map.get(PORT),'cobblestone','the port closed')
 assert.deepEqual(f.log.steps,[]);assert.deepEqual(f.bot.entity.position,new Vec3(-35.5,60,-8.5))
})

// Review of the stand: a cancellation made check() throw inside the closing in finally, which swallowed it and left the
// port open. The closing there runs on its own bounded check, and the open port is on the task while it is open.
test('a stand cancelled with the port open still closes it, on its own bounded check',async()=>{
 const f=fixture();let cancelled=false,openOnTask=null
 f.api.check=()=>{if(cancelled)throw new Error('skill interrupted')}
 f.api.progress=()=>f.api.check()
 const task={kind:'stand',goal:validateStandGoal({item:'blaze_rod',count:1})}
 f.log.onShot=()=>{openOnTask=structuredClone(task.portOpen);cancelled=true}
 await assert.rejects(blazeStand(f.bot,task,f.api,fast).finally(f.stop),/skill interrupted/)
 assert.deepEqual(openOnTask,[{x:-36,y:61,z:-8}],'the open port is on the task');assert.equal(task.portOpen,undefined)
 assert.equal(f.map.get(PORT),'cobblestone','the port closed')
})

// Review of the stand: a rod falling in the port's cell when the port shuts is walled in. The close waits for the kills
// still settling.
test('the port closes only after a kill in the port has had its rod picked up',async()=>{
 const f=fixture()
 f.log.onOpen=()=>{const b=Object.values(f.bot.entities).find(e=>e.name==='blaze');Object.assign(b,{position:new Vec3(-35.5,61,-7.5),hits:1,dropAt:[-35.5,61.2,-7.5],pickupDelay:40})}
 f.log.onSwing=()=>{f.bot.health=15}
 const r=await stand(f)
 assert.equal(r.rods,1);assert.equal(at(f,'walled'),-1,'no rod walled in')
})

// Review of the stand: nothing in the controller read portOpen. After a stand that ended with its port open (cancelled,
// failed or done), the next command waits for the stand to finish, and if the port's cells are still open walls in first.
test('after a stand ends with its port open, the controller walls in before the next command',async()=>{
 const run=async open=>{
  const f=fixture();f.stop();if(!open)f.map.set(PORT,'cobblestone')
  const r=Object.assign(new EventEmitter(),{profile:'stand',owner:'Sov',ready:true,connectionId:'one',bot:f.bot,commands:[],position:()=>({x:-36,y:60,z:-9}),log(){},waitForIdle:async()=>{}})
  r.command=c=>{r.commands.push(c);if(c.action==='stop')return;const t=r.task={id:String(r.commands.length),kind:c.action,status:'running',goal:c.goal};setTimeout(()=>{if(c.action==='hut')f.map.set(PORT,'cobblestone');t.status='completed';t.result={receipt:c.action};r.emit('event',{type:'task_finished',task:t})},1)}
  const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-blaze-port-')),'state.json'))
  r.emit('event',{type:'task_finished',task:{id:'s',kind:'stand',status:'cancelled',goal:{item:'blaze_rod',count:1},portOpen:[{x:-36,y:61,z:-8}]}})
  await c.executeCommand({action:'goto',goal:{x:-36,y:60,z:-9},timeoutMs:60000},new AbortController().signal)
  c.cancel?.(true);return r.commands.map(x=>x.action).filter(x=>x!=='stop')
 }
 assert.deepEqual(await run(true),['hut','goto'])
 assert.deepEqual(await run(false),['goto'],'a port already shut needs nothing')
})

// Re-review of the stand: a cancellation inside unwall, after the port's dig and before unwall returns, left the cell open
// with no port recorded and nothing on the task. The chosen cells go on the task before the dig.
test('a cancellation thrown inside unwall after the port is dug still closes the port',async()=>{
 const f=fixture();let cancelled=false
 f.api.check=()=>{if(cancelled)throw new Error('skill interrupted')}
 f.api.progress=()=>f.api.check()
 f.log.onOpen=()=>{cancelled=true}
 const task={kind:'stand',goal:validateStandGoal({item:'blaze_rod',count:1})}
 await assert.rejects(blazeStand(f.bot,task,f.api,fast).finally(f.stop),/skill interrupted/)
 assert.ok(at(f,'dig',PORT)>=0,'the port was dug');assert.equal(f.map.get(PORT),'cobblestone','and closed again');assert.equal(task.portOpen,undefined)
})

// Re-review of the stand: a pre-command hut that failed only logged, and the command ran with the port open. It is tried
// again after a short wait; still open, a command that moves or digs is refused, and the port stays recorded for the next.
test('with a mob in the port cell the pre-command hut fails twice, the goto is refused and the port stays recorded',async()=>{
 const f=fixture();f.stop()
 const r=Object.assign(new EventEmitter(),{profile:'stand',owner:'Sov',ready:true,connectionId:'one',bot:f.bot,commands:[],position:()=>({x:-36,y:60,z:-9}),log(){},waitForIdle:async()=>{}})
 r.command=c=>{r.commands.push(c);if(c.action==='stop')return;const t=r.task={id:String(r.commands.length),kind:c.action,status:'running',goal:c.goal}
  setTimeout(()=>{if(c.action==='hut'){t.status='failed';t.reason='Hut incomplete: -36,61,-8 occupied by a hoglin'}else{t.status='completed';t.result={receipt:c.action}}r.emit('event',{type:'task_finished',task:t})},1)}
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-blaze-port-')),'state.json'));c.standPortRetryMs=10
 const said=[];c.say=m=>said.push(m)
 r.emit('event',{type:'task_finished',task:{id:'s',kind:'stand',status:'cancelled',goal:{item:'blaze_rod',count:1},portOpen:[{x:-36,y:61,z:-8}]}})
 const signal=new AbortController().signal
 await assert.rejects(c.executeCommand({action:'goto',goal:{x:-36,y:60,z:-9},timeoutMs:60000},signal),/firing port is still open/)
 assert.deepEqual(r.commands.map(x=>x.action).filter(x=>x!=='stop'),['hut','hut']);assert.deepEqual(c.standPort,[{x:-36,y:61,z:-8}])
 assert.ok(said.some(m=>/cannot close my firing port yet/.test(m)),said.join(' | '))
 // Shut by the next try, the command runs.
 f.map.set(PORT,'cobblestone')
 await c.executeCommand({action:'goto',goal:{x:-36,y:60,z:-9},timeoutMs:60000},signal);c.cancel?.(true)
 assert.equal(r.commands.filter(x=>x.action!=='stop').at(-1).action,'goto');assert.equal(c.standPort,null)
})

// Review of the covered stand (Sonnet, 17 October): healing with the port shut, the stand waited up to healMs for 16
// health checking only the runner's check, so a mob hitting the bot through a broken wall went on for a minute. A fall
// in health while it heals, or health under the trip's 12, ends the wait at once and the stand says why.
test('a hit while healing with the port shut ends the stand at once, not after healMs',async()=>{
 const f=fixture({health:15}),start=Date.now()
 setTimeout(()=>{f.bot.health=13},40)
 await assert.rejects(stand(f,1,{healMs:5000,limitMs:20000}),/hit while healing with the port shut \(health 13\)/)
 assert.ok(Date.now()-start<2000,`took ${Date.now()-start} ms`)
 const g=fixture({health:15});setTimeout(()=>{g.bot.health=11.5},40)
 const at=Date.now();await assert.rejects(stand(g,1,{healMs:5000,limitMs:20000}),/hit while healing with the port shut/);assert.ok(Date.now()-at<2000)
})

// Live rehearsal R9b, 17 October 06:05:48Z: a fireball hit the bot at the port, the stand closed it and healed shut, still
// alight, with no fire block in or around the hut. Each burn tick took a health and the heal read the first as a hit
// ("hit while healing with the port shut (health 17)"), ending the stand. Alight in a closed hut with no fire, lava or
// soul fire in or touching its cavity, a fall is the burn; not alight, or with fire or lava there, it is a hit as before.
// The burn starts as the heal does: two ticks of 1 from 15 alight, the flag clears, the last tick lands after it (as the
// shelter wait has seen, controller.js observe), and health comes back to 20.
const burnWhileHealing=(f,{alight=true,cell=null,block='fire'}={})=>{
 f.api.stage=s=>{if(s!=='healing'||f.burnt)return;f.burnt=true;f.bot.entity.metadata={0:alight?1:0};if(cell)f.map.set(cell,block)
  let n=0;const t=setInterval(()=>{n++
   if(n<=2)f.bot.health-=1
   else if(n===3)f.bot.entity.metadata={0:0}
   else if(n===4)f.bot.health-=1
   else{clearInterval(t);if(cell)f.map.set(cell,cell==='-36,60,-9'?'air':'cobblestone');f.bot.health=20}},30)}
}
test('alight in the shut hut with no fire or lava in or touching it, the burn ticks are not a hit: the stand heals and goes on',async()=>{
 const f=fixture({health:15});burnWhileHealing(f)
 f.log.onShot=()=>{const b=Object.values(f.bot.entities).find(e=>e.name==='blaze');if(b){b.dropAt=[-35.5,61,-7.5];f.kill(b)}}
 const r=await stand(f,1,{healMs:5000,limitMs:20000})
 assert.ok(f.burnt,'it healed alight');assert.equal(r.rods,1);assert.equal(r.ports,1);assert.match(r.stopped,/reached the count/)
})
test('the same fall not alight, or alight with fire or lava in or touching the hut\'s cavity, still ends the stand at once',async()=>{
 for(const [name,o] of [['not alight',{alight:false}],['fire in the feet cell',{cell:'-36,60,-9'}],['soul fire in the feet cell',{cell:'-36,60,-9',block:'soul_fire'}],['lava in the wall beside the feet',{cell:'-35,60,-9',block:'lava'}]]){
  const f=fixture({health:15});burnWhileHealing(f,o);const start=Date.now()
  await assert.rejects(stand(f,1,{healMs:5000,limitMs:20000}),/hit while healing with the port shut \(health 14\)/,name)
  assert.ok(f.burnt,name);assert.ok(Date.now()-start<2000,`${name}: took ${Date.now()-start} ms`)
 }
})

// Live rehearsal R9, 17 October 06:42Z (death 6, "burned to a crisp while fighting Blaze"): a fireball lit the open port cell,
// and the close was refused for a minute, "Cannot wall through fire at -37,61,-9", while the bot burned beside the open port.
// Fire in the port cell is punched out and the port walled shut as any other.
test('a fire lit in the open port cell is punched out and the port closes',async()=>{
 const f=fixture();let lit=-1
 f.log.onShot=n=>{if(n===1){f.map.set(PORT,'fire');lit=f.log.events.length;f.bot.health=19}}
 const error=await stand(f,1,{limitMs:1500}).then(()=>null,e=>e)
 assert.ok(lit>=0,'the port caught fire');assert.doesNotMatch(String(error?.message),/could not close|Cannot wall through/)
 const out=after(f,lit-1,'dig',PORT),shut=after(f,out,'place',PORT)
 assert.ok(out>lit-1&&shut>out,JSON.stringify(f.log.events.slice(lit,lit+6)))
 assert.equal(f.map.get(PORT),'cobblestone','walled in at the end')
})

// The same death: from 06:42:36 the journal has no survival tick for a minute, and the bot's health read 15.875 until the stand
// gave up at 06:43:36, though the server had killed it at 06:42:48. A close the hut refuses at once (wallIn throws before any
// await that waits on a timer) only ever awaited resolved promises, so the retry loop never let the event loop turn: no
// packet, no tick, no health, no alarm. Every try now waits a poll, so the clock keeps running while the close fails.
test('a close the hut refuses at once keeps the event loop turning while it retries',async()=>{
 const f=fixture();let last=Date.now(),gap=0
 const clock=setInterval(()=>{const now=Date.now();gap=Math.max(gap,now-last);last=now},5)
 f.log.onShot=n=>{if(n===1){f.map.set(PORT,'lava');f.bot.health=19}}
 try{await assert.rejects(stand(f,1,{closeLimitMs:400}),/could not close the port: Cannot wall in here: Cannot wall through lava at -36,61,-8/)}
 finally{clearInterval(clock);gap=Math.max(gap,Date.now()-last)}
 assert.ok(gap<150,`the event loop stalled ${gap} ms`)
})
