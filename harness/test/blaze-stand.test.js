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
  async dig(block){log.events.push(['dig',key(block.position)]);map.set(key(block.position),'air');if(key(block.position)===PORT)log.onOpen?.();log.onDig?.(key(block.position))
   // The block under the bot dug: it falls to the first solid block below (the stand's sink).
   const p=bot.entity.position;let c=p.floored().offset(0,-1,0)
   if(c.equals(block.position)){while(registry.blocksByName[name(c.offset(0,-1,0))]?.boundingBox!=='block')c=c.offset(0,-1,0);bot.entity.position=new Vec3(p.x,c.y,p.z);log.events.push(['fell',key(c)])}},
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

// Round two (live rehearsal R9, 17 October 06:16Z): a spawner makes a blaze only where its box fits clear of every entity
// too, and a one-wide hut with the bot in it has no room for a second box, so the bot's own two cells are never a spawn
// pocket. The refusal of a cell inside the spawner's reach forbade the one position that works, level with the blazes.
test('the stand accepts a hut cell beside a spawner when the cavity is the bot\'s own two cells',async()=>{
 // The design's cell: feet -36,58,-9 on the platform floor, the spawner its south-east diagonal at -35,58,-8.
 const level=fixture({feet:[-36,58,-9],blazes:[{at:[-35.5,58,-5.5]}]});level.stop()
 assert.equal(blazeStandRefusal(level.bot),'')
 // R8's pocket beside the spawner and one above it, with a port toward the blaze, is accepted the same way.
 const pocket=fixture({feet:[-36,59,-8]});pocket.stop();assert.equal(blazeStandRefusal(pocket.bot),'')
 assert.equal(pocket.log.events.length,0,'nothing built by the judgement')
 // A portal room's cavity takes the portal's own blocks too, a pocket a blaze fits: inside a spawner's reach it is refused.
 const ground=[[-36,59,-8],[-36,59,-10],[-35,59,-9],[-38,59,-9]].map(c=>[...c,'netherrack'])
 const portal=[[-37,59,-9,'obsidian'],[-37,62,-9,'obsidian'],[-37,60,-9,'nether_portal'],[-37,61,-9,'nether_portal']]
 const room=fixture({cells:[...ground,...portal,[-38,61,-12,'spawner']]});room.stop()
 assert.match(blazeStandRefusal(room.bot),/The portal room's cell -37,6[01],-9 is inside the spawner's reach at -38,61,-12/)
 const clear=fixture({cells:[...ground,...portal]});clear.stop();assert.equal(blazeStandRefusal(clear.bot),'','a portal room away from a spawner is fine')
})
test('stand for blaze_rod refuses a cell with no port side toward a blaze, no blaze, no kit or the Overworld',async()=>{
 const good=fixture();good.stop();assert.equal(blazeStandRefusal(good.bot),'')
 // A blaze straight overhead: no wall faces it.
 const above=fixture({blazes:[{at:[-35.5,66,-8.5]}]});above.stop();assert.match(blazeStandRefusal(above.bot),/No wall here opens toward a blaze/)
 const none=fixture({blazes:[]});none.stop();assert.match(blazeStandRefusal(none.bot),/No blaze within 32 blocks/)
 const home=fixture({dimension:'overworld'});home.stop();assert.match(blazeStandRefusal(home.bot),/Nether only/)
 const short=fixture({arrows:15});short.stop();assert.match(blazeStandRefusal(short.bot),/Not on a kitted trip: 16 arrows \(carrying 15\)/)
 await assert.rejects(stand(fixture({blazes:[{at:[-35.5,66,-8.5]}]})),/No wall here opens toward a blaze/)
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

test('a hit closes the port, the stand heals to 16 shut, and opens again',async()=>{
 const f=fixture()
 f.log.onShot=n=>{const b=Object.values(f.bot.entities).find(e=>e.name==='blaze');if(n===1){f.bot.health=14;setTimeout(()=>{f.bot.health=20},80)}else if(b){b.dropAt=[-35.5,61,-7.5];f.kill(b)}}
 const r=await stand(f)
 assert.equal(r.rods,1);assert.equal(r.ports,2)
 const open=at(f,'dig',PORT),shot=after(f,open,'shot'),close=after(f,shot,'place',PORT),again=after(f,close,'dig',PORT)
 assert.ok(open>=0&&shot>open&&close>shot&&again>close,JSON.stringify(f.log.events))
 assert.equal(f.log.events[close][2],14,'shut at 14 health')
})

// Round two (design of the blaze endgame, section 4.1 rule 4): only a mob that fits the port column can come through it. A
// 2.4-tall wither skeleton beside the port is watched, never a reason to close; a magma cube (0.52 as mineflayer reads it)
// or a provoked piglin is. Review of the sink (Sonnet, 17 October): a hoglin is 1.4 wide but only 1.4 tall. On the ledge its
// box is 0.2 inside the port cell and its attack box reaches the bot's off centre or after a knockback; with the cell over
// the port dug it stands on the sill in the port column. Only height decides: a hoglin closes the port under air, not under rock.
const mob=(f,name,at,o={})=>f.add({name,type:'hostile',...registrySize(name),position:new Vec3(...at),...o})
const registrySize=name=>({width:registry.entitiesByName[name].width,height:registry.entitiesByName[name].height})
test('a hoglin or a magma cube two blocks from the port closes it; a wither skeleton does not',async()=>{
 for(const [name,closes] of [['hoglin',true],['magma_cube',true],['wither_skeleton',false]]){
  const f=fixture();let m=null,closedWith=false
  f.log.onShot=n=>{const b=Object.values(f.bot.entities).find(e=>e.name==='blaze');if(n===1)m=mob(f,name,[-35.5,60,-5.5]);if(n===3&&b){b.dropAt=[-35.5,61,-7.5];f.kill(b)}}
  const place=f.bot.placeBlock;f.bot.placeBlock=async(ref,face)=>{await place(ref,face);if(m&&f.bot.entities[m.id]&&f.log.shots<3&&f.map.get(PORT)==='cobblestone')closedWith=true}
  const r=await stand(f,1,{limitMs:closes?600:4000}).then(x=>x,e=>e)
  assert.equal(closedWith,closes,`${name}: ${r?.message??JSON.stringify(r)}`)
  if(!closes){assert.equal(r.rods,1,name);assert.equal(r.ports,1,`${name}: the port stayed open`)}
 }
 // A mob 8 blocks off never closes it, as before.
 const far=fixture()
 far.log.onShot=n=>{const b=Object.values(far.bot.entities).find(e=>e.name==='blaze');if(n===1)mob(far,'magma_cube',[-35.5,58,.5]);if(n===3&&b){b.dropAt=[-35.5,61,-7.5];far.kill(b)}}
 const r=await stand(far)
 assert.equal(r.rods,1);assert.equal(r.ports,1,'the port stayed open with a magma cube 8 blocks off')
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
 // The brief: stand for rods at or above the blazes' floor, and never bore down into the room.
 const brief=readFileSync(new URL('../src/companion/survival-capabilities.txt',import.meta.url),'utf8')
 assert.match(brief,/^Action stand for blaze rods: name="", item="blaze_rod", count=1–8.*at or above the floor the blazes rest on.*closes the column below itself from inside and drops to stand on the floor.*any blaze within reach.*a hoglin when the cell over the port is open.*a wither skeleton is too tall for it.*never steps out.*partial means some rods, never none/m)
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
  const r=Object.assign(new EventEmitter(),{profile:'stand',owner:'Player',ready:true,connectionId:'one',bot:f.bot,commands:[],position:()=>({x:-36,y:60,z:-9}),log(){},
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

test('a hoglin on the ledge with the cell over the port dug closes the port; with rock over the port, a hoglin two off does not',async()=>{
 const said=[],f=fixture();f.api.progress=m=>said.push(m)
 f.log.onShot=n=>{if(n===1){const h=mob(f,'hoglin',[-35.5,60,-6.5]);setTimeout(()=>{delete f.bot.entities[h.id]},150)}}
 await assert.rejects(stand(f,1,{limitMs:600}))
 assert.ok(said.some(m=>/A hoglin came near the port\. I closed it\./.test(m)),said.join(' | '))
 // Natural rock over the port: the column is one high, and a 1.4-tall hoglin cannot stand in it.
 const g=fixture({cells:[[-36,62,-8,'netherrack']]})
 g.log.onShot=n=>{const b=Object.values(g.bot.entities).find(e=>e.name==='blaze');if(n===1)mob(g,'hoglin',[-35.5,60,-5.5]);if(n===3&&b){b.dropAt=[-35.5,61,-7.5];g.kill(b)}}
 const r=await stand(g)
 assert.equal(r.rods,1);assert.equal(r.ports,1,'the port stayed open');assert.equal(g.map.get('-36,62,-8'),'netherrack')
})

// Round two (section 4.1 rule 5): at eye level a blaze at the wall melees the bot through the port, so waiting for it to come
// into the column pays health for nothing. Any blaze within 2.9 with a clear strike is struck, the column's first; a kill
// outside the column drops its rod beyond the wall, named in missed.
test('a blaze at the wall within 2.9 outside the port column is struck; its rod outside is named in missed',async()=>{
 const f=fixture({blazes:[{at:[-35.5,61.5,-3.5]}]})
 f.log.onOpen=()=>{const b=Object.values(f.bot.entities).find(e=>e.name==='blaze');b.position=new Vec3(-35.5,61,-6.3)}
 await assert.rejects(stand(f),/No blaze rod gained: 1 blaze killed.*left behind: 1 blaze_rod at -36,61,-7 \(outside the port/)
 assert.ok(f.log.swings.length>=2&&f.log.swings.every(s=>!s.inside),JSON.stringify(f.log.swings));assert.equal(f.log.shots,0,'no arrow at it')
 // With one in the column and one outside, the column's is struck first.
 const g=fixture({blazes:[{at:[-35.5,61.5,-3.5]},{at:[-35.5,61.5,-2.5]}]});let a=null,b=null
 g.log.onOpen=()=>{[a,b]=Object.values(g.bot.entities).filter(e=>e.name==='blaze');a.position=new Vec3(-35.5,61,-6.3);b.position=new Vec3(-35.5,61,-7.5)}
 const r=await stand(g)
 assert.equal(r.rods,1);assert.equal(g.log.swings[0].id,b.id,'the one in the column first')
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
  const r=Object.assign(new EventEmitter(),{profile:'stand',owner:'Player',ready:true,connectionId:'one',bot:f.bot,commands:[],position:()=>({x:-36,y:60,z:-9}),log(){},waitForIdle:async()=>{}})
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
 const r=Object.assign(new EventEmitter(),{profile:'stand',owner:'Player',ready:true,connectionId:'one',bot:f.bot,commands:[],position:()=>({x:-36,y:60,z:-9}),log(){},waitForIdle:async()=>{}})
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

// Round two (live rehearsal R9, 17 October 06:16 to 06:18Z; design of the blaze endgame round two): the hut at -36,60,-9 two
// above the platform floor was blind. The blazes rested on the floor under its walls, eye 59.53 against the bot's 61.62, and
// through a head port whose sill is the feet-level wall the eye-to-eye line clears the sill only from 5.05 blocks; the
// platform is 4 by 5. Standing on the floor, the eyes are level. The R9 hut: walls at y 60 and 61, roof -36,62,-9, helper
// -35,62,-9, floor -36,59,-9 over platform air at -36,58,-9, nether brick (netherrack here) at y 57, and the bot's own
// cobblestone at -36,58,-8. Resting blazes at y 58 off the side cells.
const R9_HUT=[...[60,61].flatMap(y=>[[-37,y,-9],[-35,y,-9],[-36,y,-10],[-36,y,-8]]),[-36,62,-9],[-35,62,-9],[-36,58,-8]]
const RING=[59,58].flatMap(y=>[[-37,y,-9],[-35,y,-9],[-36,y,-10],[-36,y,-8]]).map(c=>c.join(','))
const r9=(o={})=>fixture({own:R9_HUT,...o})
const RESTING=[{at:[-34.2,58,-9.7]},{at:[-35.5,58,-5.5]}]
test('with every blaze resting below the sill and solid ground two below the floor, the stand sinks: eight side cells placed from inside before the floor is dug, then the roof, and the cavity is never open',async()=>{
 const f=r9({blazes:RESTING});let ringAtDig=null,south=null
 f.log.onDig=c=>{if(c==='-36,59,-9')ringAtDig=RING.filter(r=>f.map.get(r)==='cobblestone')
  // The new south port cut: the blaze two off comes to it, feet on the sill, head in the cell over it.
  if(c==='-36,59,-8'&&f.bot.entity.position.y===58){south??=Object.values(f.bot.entities).find(e=>e.name==='blaze'&&e.position.z>-6);if(south)south.position=new Vec3(-35.5,59,-7.5)}}
 const r=await stand(f)
 const floor=at(f,'dig','-36,59,-9'),roof=after(f,floor,'place','-36,60,-9'),port=after(f,roof,'dig','-36,59,-8')
 assert.ok(floor>0,JSON.stringify(f.log.events))
 assert.deepEqual(ringAtDig?.sort(),[...RING].sort(),'all eight side cells solid when the floor goes')
 assert.deepEqual(f.log.events.slice(0,floor).filter(e=>e[0]==='place').map(e=>e[1]).sort(),RING.filter(c=>c!=='-36,58,-8').sort(),'the seven missing placed before it')
 assert.ok(!f.log.events.slice(0,floor).some(e=>e[0]==='dig'),'nothing dug before the floor')
 assert.ok(roof>floor&&port>roof,'the roof before any port');assert.equal(f.log.events[floor+1][0],'fell')
 assert.deepEqual(r.sank,{from:{x:-36,y:60,z:-9},to:{x:-36,y:58,z:-9}});assert.equal(r.rods,1);assert.equal(r.ports,1)
 assert.deepEqual(f.bot.entity.position,new Vec3(-35.5,58,-8.5),'standing on the platform floor')
 // At the new level the south port has the old south wall dug out over it and the ledge at feet level.
 assert.ok(at(f,'dig','-36,60,-8')>roof&&at(f,'place','-36,58,-7')>roof)
 assert.equal(f.map.get('-36,59,-8'),'cobblestone','closed at the end');assert.deepEqual(f.log.steps,[],'never walked')
})
test('a side cell a hoglin stands in is waited on, not dug; past the close limit the sink refuses with the cell named and the stand stays up',async()=>{
 const f=r9({blazes:RESTING});const said=[];f.api.progress=m=>said.push(m)
 f.add({name:'hoglin',type:'hostile',width:1.4,height:1.4,position:new Vec3(-37.2,58,-8.5)})
 const error=await stand(f,1,{limitMs:1500}).then(()=>null,e=>e)
 assert.match(String(error?.message),/No blaze rod gained/)
 assert.ok(said.some(m=>/-37,5[89],-9/.test(m)&&/stay/.test(m)),said.join(' | '))
 assert.equal(at(f,'dig','-36,59,-9'),-1,'the floor stays');assert.ok(!f.log.events.some(e=>e[0]==='dig'&&/^-37,5[89],-9$/.test(e[1])),'never dug toward it')
 assert.equal(f.bot.entity.position.y,60,'the stand stays up')
 // Review of the sink: a refusal is not for good. Once the hoglin has gone, the sink is tried again after sinkRetryMs.
 const h=r9({blazes:RESTING}),hog=h.add({name:'hoglin',type:'hostile',width:1.4,height:1.4,position:new Vec3(-37.2,58,-8.5)})
 setTimeout(()=>{delete h.bot.entities[hog.id]},400)
 await stand(h,1,{limitMs:2500,sinkRetryMs:600}).catch(()=>{})
 assert.ok(at(h,'dig','-36,59,-9')>=0,'sank on the retry');assert.equal(h.bot.entity.position.y,58)
 // A blaze in the column under the floor is waited on too: the floor never goes over it.
 const g=r9({blazes:[...RESTING,{at:[-35.5,58,-8.5]}]})
 await assert.rejects(stand(g,1,{limitMs:1500}));assert.equal(at(g,'dig','-36,59,-9'),-1);assert.equal(g.bot.entity.position.y,60)
})
// The R9 snapshot at 06:18Z: the platform's blazes resting below the sill, and one more at y 62.2 in the west cave, above the
// bot's feet, behind the cave's rock with no line to it (r9-blazes.txt; the '?' block at -37,62,-9 in the R8 scan). Only
// blazes resting in the spawner's box (4 across, the room's band of one up or down) ask for the sink; one elsewhere with no
// line does not hold the stand up.
const CAVE={at:[-39.7,62.2,-10.3]},CAVE_ROCK=[[-37,62,-9,'netherrack'],[-37,62,-10,'netherrack'],[-38,62,-9,'netherrack'],[-38,62,-10,'netherrack']]
test('the R9 shape sinks: platform blazes resting below the sill and a cave blaze above with no line',async()=>{
 const f=r9({blazes:[...RESTING,CAVE],cells:CAVE_ROCK});let south=null
 f.log.onDig=c=>{if(c==='-36,59,-8'&&f.bot.entity.position.y===58){south??=Object.values(f.bot.entities).find(e=>e.name==='blaze'&&e.position.z>-6);if(south)south.position=new Vec3(-35.5,59,-7.5)}}
 const r=await stand(f)
 assert.deepEqual(r.sank,{from:{x:-36,y:60,z:-9},to:{x:-36,y:58,z:-9}});assert.equal(r.rods,1)
})
test('no sink while a blaze is in line, with no blaze resting in the spawner\'s box, or with no ground within two below the floor',async()=>{
 for(const [name,o] of [['a blaze in line',{blazes:[...RESTING,{at:[-35.5,61.5,-3.5]}]}],['a platform blaze in line beside the cave one',{blazes:[...RESTING,CAVE,{at:[-35.5,61.5,-3.5]}],cells:CAVE_ROCK}],
  ['only the cave blaze',{blazes:[CAVE],cells:CAVE_ROCK}],['only blazes in the corridor under the kerb, out of the box\'s band',{blazes:[{at:[-32.3,56.2,-10.7]},{at:[-32.3,56.2,-10.3]}]}],
  ['air three below the floor',{blazes:RESTING,cells:[[-36,57,-9,'air']]}]]){
  const f=r9(o);await stand(f,1,{limitMs:600}).catch(()=>{})
  assert.equal(at(f,'dig','-36,59,-9'),-1,name);assert.equal(f.bot.entity.position.y,60,name)
 }
})
// Round two (section 4.1 rule 6): sunk, the new hut's helper is the old east wall, over the east side cell, so an east port
// has a hut block over it and no blaze can stand in it. The design names south first, north with the kerb as ledge, never east.
test('the east side whose over cell is the hut\'s helper is not prepared or opened',async()=>{
 // Sunk with a blaze east in line through the east port at the new level and none anywhere else.
 const f=r9({blazes:[{at:[-32.5,58,-8.5]}]})
 await assert.rejects(stand(f,1,{limitMs:1200}))
 assert.ok(at(f,'dig','-36,59,-9')>=0,'it sank');assert.equal(f.bot.entity.position.y,58)
 assert.equal(at(f,'dig','-35,59,-9'),-1,'the east port is never cut');assert.equal(f.map.get('-35,60,-9'),'cobblestone','the helper stays')
 assert.equal(at(f,'place','-33,58,-9'),-1,'no ledge east')
})
// The window arithmetic of round two, section 1.2, pinned on the platform: eye 1.62 over the feet, a blaze's 1.53 (0.85 of
// its 1.8), the sill the feet-level wall. From feet 58 a resting blaze 1.0 beyond the sill is in line eye to eye through the
// head port; from feet 60 the sill takes the line for every distance under 5.05 and gives it back past it.
test('eye-to-eye line from feet 58 to a resting blaze 1.0 beyond the sill is clear through the head port; from feet 60 it is blocked by the sill for every D under 5',async()=>{
 const {blazeEyeLine}=await import('../src/blaze-stand.js')
 const hut=y=>[[-37,y,-9],[-35,y,-9],[-36,y,-10],[-36,y,-8],[-37,y+1,-9],[-35,y+1,-9],[-36,y+1,-10],[-36,y+1,-8]]
 const low=fixture({feet:[-36,58,-9],own:hut(58),blazes:[{at:[-35.5,58,-6]}]});low.stop()
 const b=Object.values(low.bot.entities).find(e=>e.name==='blaze')
 const line=blazeEyeLine(low.bot,new Vec3(-36,58,-9),b)
 assert.equal(line.status,'clear',JSON.stringify(line));assert.deepEqual(line.cells,[new Vec3(-36,59,-8)])
 for(const d of [2,3,4,4.9]){
  const high=fixture({own:hut(60),blazes:[{at:[-35.5,58,-8.5+d]}]});high.stop()
  const l=blazeEyeLine(high.bot,new Vec3(-36,60,-9),Object.values(high.bot.entities).find(e=>e.name==='blaze'))
  assert.equal(l.status,'blocked',`D ${d}`);assert.deepEqual(l.cell,{x:-36,y:60,z:-8},`D ${d}: the sill`)
 }
 const far=fixture({own:hut(60),blazes:[{at:[-35.5,58,-8.5+5.3]}]});far.stop()
 assert.equal(blazeEyeLine(far.bot,new Vec3(-36,60,-9),Object.values(far.bot.entities).find(e=>e.name==='blaze')).status,'clear','D 5.3')
})

// Review of the sink: a plain stand (no covered phase guarding it) waited up to closeLimitMs in the sink's loop with no eye on
// the stand's clock or the trip's health line. Both end the wait at once.
test('a sink waiting on a side cell ends with the stand\'s time or under the trip\'s health, not after the close limit',async()=>{
 const hog=f=>f.add({name:'hoglin',type:'hostile',width:1.4,height:1.4,position:new Vec3(-37.2,58,-8.5)})
 const f=r9({blazes:RESTING});hog(f);const start=Date.now()
 await assert.rejects(stand(f,1,{limitMs:500,closeLimitMs:20000}),/ran out/);assert.ok(Date.now()-start<2500,`took ${Date.now()-start} ms`)
 const g=r9({blazes:RESTING});hog(g);g.api.stage=s=>{if(s==='sinking')setTimeout(()=>{g.bot.health=11},100)};const at2=Date.now()
 await assert.rejects(stand(g,1,{limitMs:20000,closeLimitMs:20000}),/health 11 is under 12/);assert.ok(Date.now()-at2<2500,`took ${Date.now()-at2} ms`)
 assert.equal(g.bot.entity.position.y,60)
})

// Rehearsals R13 and R14 (18 October): stands at the tunnel level killed
// blazes at bow range and left every rod outside the port, and nothing in
// any receipt or progress line said why the sink never applied; its
// geometry gates returned null in silence. A geometry refusal is durable
// information, not a transient wait, so the stand now says it once.
test('a sink refused by its floor or its ground says which, once, and the stand stays up',async()=>{
 for(const [name,o,pattern] of [
  ['an undiggable floor',{blazes:RESTING,cells:[[-36,59,-9,'nether_bricks']]},/nether_bricks at -36,59,-9/],
  ['no ground within two below the floor',{blazes:RESTING,cells:[[-36,57,-9,'air']]},/no solid ground/]]){
  const f=r9(o);const said=[];f.api.progress=m=>said.push(m)
  await stand(f,1,{limitMs:1200}).catch(()=>{})
  assert.ok(said.some(m=>pattern.test(m)),`${name}: ${said.join(' | ')}`)
  assert.equal(said.filter(m=>pattern.test(m)).length,1,`${name}: said once`)
  assert.equal(at(f,'dig','-36,59,-9'),-1,name);assert.equal(f.bot.entity.position.y,60,name)
 }
})
