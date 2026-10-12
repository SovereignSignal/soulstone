import {executeWithShelter} from './emergency-shelter-fixture.js'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {hutSite,wallIn,unwall} from '../src/hut.js'
import {burrowSite} from '../src/burrow.js'
import {executeSkill} from '../src/skills.js'
import {Teammate} from '../src/companion/controller.js'
import {THREAT_INTERRUPTION} from '../src/survival.js'
const registry=minecraftData('1.21.4')
function world({logs=21,stoneFrom=60}={}){
 const cells=new Map(),inventory=logs?[{name:'oak_log',count:logs}]:[],placed=[],dug=[],equipped=[]
 const bot={registry,game:{gameMode:'survival',difficulty:'normal'},time:{timeOfDay:15000},health:20,food:18,entities:{},players:{},
  entity:{position:new Vec3(10.5,64,10.5),onGround:true},inventory:{items:()=>inventory},
  blockAt(p){const name=cells.get(p.toString())??(p.y>=64?'air':p.y===63?'grass_block':p.y>stoneFrom?'dirt':'stone');return {name,position:p.clone(),boundingBox:registry.blocksByName[name]?.boundingBox}},
  pathfinder:{setGoal(){},setMovements(){},async goto(){}},clearControlStates(){},tool:{async equipForBlock(){}},
  async equip(item){equipped.push(item.name)},
  async placeBlock(ref,face){const p=ref.position.plus(face);placed.push(p.toString());cells.set(p.toString(),equipped.at(-1));const slot=inventory.find(i=>i.name===equipped.at(-1));if(slot&&--slot.count<=0)inventory.splice(inventory.indexOf(slot),1)},
  async dig(block){dug.push(block.position.toString());cells.set(block.position.toString(),'air')}}
 return {bot,cells,inventory,placed,dug}
}
const api={check(){},stage(){},progress(){},persist(){},movements:{}}
test('a burrow takes three cells when stone stops the fourth, and refuses a two-cell column',()=>{
 const shallow=world({stoneFrom:60});shallow.inventory.length=0
 const site=burrowSite(shallow.bot);assert.equal(site.ok,true);assert.equal(site.cells.length,3)
 const rock=world({stoneFrom:61});rock.inventory.length=0;assert.match(burrowSite(rock.bot).reason,/at least 3/)
 rock.inventory.push({name:'wooden_pickaxe',count:1});assert.equal(burrowSite(rock.bot).cells.length,4)
})
test('a hut needs the blocks its own site is missing, solid ground around and room above',()=>{
 assert.equal(hutSite(world().bot).ok,true)
 assert.match(hutSite(world({logs:9}).bot).reason,/10 blocks needed to close this spot and 9 carried/)
 const pit=world();pit.cells.set(new Vec3(11,63,10).toString(),'air');assert.match(hutSite(pit.bot).reason,/No ground/)
 const tree=world();tree.cells.set(new Vec3(10,66,10).toString(),'oak_log');assert.equal(hutSite(tree.bot).ok,true)
 const wall=world();wall.cells.set(new Vec3(11,64,10).toString(),'water');assert.match(hutSite(wall.bot).reason,/Cannot wall/)
})
test('walling in places eight walls, a helper and a roof from carried logs, then one side opens again',async()=>{
 const w=world()
 const result=await executeSkill(w.bot,{kind:'hut',goal:{}},api)
 assert.equal(result.receipt,'walled_in');assert.equal(w.placed.length,10);assert.equal(w.inventory.find(i=>i.name==='oak_log').count,11)
 for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]])for(const y of [64,65])assert.equal(w.cells.get(new Vec3(10+dx,y,10+dz).toString()),'oak_log')
 assert.equal(w.cells.get(new Vec3(10,66,10).toString()),'oak_log')
 const out=await executeSkill(w.bot,{kind:'unhut',goal:{}},api)
 assert.equal(out.receipt,'unwalled');assert.equal(w.dug.length,2)
})
// Lab run 57, 5 October: carrying obsidian first, the hut walled in with it,
// opened one side to leave and left the rest in the cave (10 obsidian to 9).
test('the hut never walls in with obsidian, and does not count it toward the blocks it needs',async()=>{
 const w=world({logs:10});w.inventory.unshift({name:'obsidian',count:9})
 const result=await executeSkill(w.bot,{kind:'hut',goal:{}},api)
 assert.equal(result.receipt,'walled_in');assert.ok(![...w.cells.values()].includes('obsidian'));assert.equal(w.inventory.find(i=>i.name==='obsidian').count,9)
 const short=world({logs:9});short.inventory.unshift({name:'obsidian',count:9})
 assert.match(hutSite(short.bot).reason,/10 blocks needed to close this spot and 9 carried/)
})
test('a dropped placement is retried once; a wall that never lands fails the hut loudly',async()=>{
 const w=world();const place=w.bot.placeBlock;let flaky=true
 w.bot.placeBlock=async(ref,face)=>{if(flaky){flaky=false;throw new Error('rejected')}await place(ref,face)}
 assert.equal((await wallIn(w.bot,{kind:'hut',goal:{}},api)).receipt,'walled_in')
 const v=world();const place2=v.bot.placeBlock;const bad=new Vec3(9,64,10).toString()
 v.bot.placeBlock=async(ref,face)=>{if(ref.position.plus(face).toString()===bad)throw new Error('rejected');await place2(ref,face)}
 await assert.rejects(wallIn(v.bot,{kind:'hut',goal:{}},api),/Hut incomplete: 2 of 10/)
})
test('when the burrow is refused, safety walls in, waits, opens up and continues the request',async()=>{
 const w=world({stoneFrom:62});const runner=new EventEmitter();runner.bot=w.bot;runner.ready=true;runner.connectionId='c1';runner.profile='p';runner.owner='Sov'
 const commands=[]
 runner.command=c=>{commands.push(c.action);if(c.action==='stop')return;runner.task={id:String(commands.length),kind:c.action,status:'running'}
  const fail=c.action==='burrow';const result=c.action==='hut'?{receipt:'walled_in',shelterName:'hut',surface:{x:10,y:64,z:10}}:c.action==='unhut'?{receipt:'unwalled'}:{}
  setTimeout(()=>{runner.task={...runner.task,status:fail?'failed':'completed',reason:fail?'No safe burrow here: Only 2 diggable cells below':undefined,result};runner.emit('event',{type:'task_finished',task:runner.task})},1)}
 runner.waitForIdle=async()=>{};runner.position=()=>({x:10,y:64,z:10})
 const said=[];let resumed=0
 const c={runner,projects:{},epoch:1,abort:null,phase:'acting',activity:'',requestProgress:{id:'r1',status:'running',feedback:[],completed:[]},safety:null,burrowWait:{quietMs:20,limitMs:2000},
  say:t=>said.push(t),persist(){},emit(){},cancel(){},interrupt(){this.requestProgress.status='interrupted'},dispatch(cmd){runner.command(cmd)},
  execute:executeWithShelter,leaveOccupiedShelter:async()=>{},seekSafety:Teammate.prototype.seekSafety,lastResortShelter:Teammate.prototype.lastResortShelter,moveOutOfDanger:Teammate.prototype.moveOutOfDanger,leaveOnOpenGround:Teammate.prototype.leaveOnOpenGround,waitInBurrow:Teammate.prototype.waitInBurrow,
  async resume(){resumed++;this.requestProgress.status='running'}}
 const started=c.seekSafety(THREAT_INTERRUPTION)
 await new Promise(r=>setTimeout(r,300));w.bot.time.timeOfDay=6000
 await started
 assert.deepEqual(commands.filter(a=>a!=='stop'),['burrow','hut','unhut'])
 assert.equal(resumed,1);assert.equal(c.safety,null);assert.ok(said.some(t=>/walling myself in/i.test(t)),said.join(' | '))
})
test('walls that already stand, as in a one-block shaft, need no ground beneath them; only the roof is placed',()=>{
 const registry=minecraftData('1.21.4')
 const inventory=[{name:'cobblestone',count:10}]
 const bot={registry,entity:{position:new Vec3(10.5,63,10.5),onGround:true},inventory:{items:()=>inventory},
  blockAt(p){const name=(p.x===10&&p.z===10)?(p.y<=62?'stone':'air'):(p.y<=65?'stone':'air');const b={name,position:p.clone(),boundingBox:name==='air'?'empty':'block'};if(p.x===9&&p.z===10&&p.y===62)b.name='air',b.boundingBox='empty';return b}}
 const site=hutSite(bot);assert.equal(site.ok,true,site.reason)
})

test('the hut asks for the blocks this spot actually needs, not a fixed ten',()=>{
 const registry=minecraftData('1.21.4')
 const open=(inv,solidAt=()=>false)=>({registry,entity:{position:new Vec3(10.5,64,10.5),onGround:true},inventory:{items:()=>inv},
  blockAt(p){const s=p.y===63||solidAt(p);return {name:s?'stone':'air',position:p.clone(),boundingBox:s?'block':'empty'}}})
 // Open ground needs all ten placements.
 const bare=hutSite(open([{name:'dirt',count:9}]))
 assert.equal(bare.ok,false);assert.match(bare.reason,/10 blocks needed to close this spot and 9 carried/)
 assert.equal(hutSite(open([{name:'dirt',count:10}])).ok,true)
 // A nook with three walls already standing needs fewer, and nine is plenty.
 const walls=p=>p.y===63||(p.x===9&&p.z===10)||(p.x===11&&p.z===10)||(p.x===10&&p.z===9)
 const nook=hutSite(open([{name:'dirt',count:9}],walls))
 assert.equal(nook.ok,true,nook.reason)
 assert.ok(nook.needed<10,`only ${nook.needed} placements are missing`)
})

test('a bot standing off centre steps clear before walling itself in',async()=>{
 // The real server refuses to place a block inside a player. A bot 0.49 off
 // centre has its 0.6-wide hitbox in the next cell, so those two walls never
 // close: "Hut incomplete: 2 of 10 blocks missing", the same two cells, nightly.
 const w=world()
 w.bot.entity.position=new Vec3(10.99,64,10.5)
 let aim=null
 w.bot.lookAt=async v=>{aim=v}
 w.bot.setControlState=(control,on)=>{
  if(control!=='forward'||!on||!aim)return
  const p=w.bot.entity.position
  w.bot.entity.position=new Vec3(p.x+(aim.x-p.x)*0.5,p.y,p.z+(aim.z-p.z)*0.5)
 }
 const place=w.bot.placeBlock.bind(w.bot)
 w.bot.placeBlock=async(ref,face)=>{
  const target=ref.position.plus(face),p=w.bot.entity.position
  const hits=p.x+0.3>target.x&&p.x-0.3<target.x+1&&p.z+0.3>target.z&&p.z-0.3<target.z+1&&p.y<target.y+1&&p.y+1.8>target.y
  if(hits)throw new Error('cannot place a block inside a player')
  return place(ref,face)
 }
 const result=await executeSkill(w.bot,{kind:'hut',goal:{}},api)
 assert.equal(result.receipt,'walled_in')
 assert.equal(w.placed.length,10,'every wall closed')
 assert.ok(Math.abs(w.bot.entity.position.x-10.5)<=0.15,`stood clear of the wall line (x=${w.bot.entity.position.x})`)
})
test('the hut reports when it could not stand clear of its own wall line',async()=>{
 const w=world()
 w.bot.entity.position=new Vec3(10.99,64,10.5)
 // No lookAt and no controls: the bot cannot move, so two cells stay occupied.
 const place=w.bot.placeBlock.bind(w.bot)
 w.bot.placeBlock=async(ref,face)=>{
  const target=ref.position.plus(face),p=w.bot.entity.position
  const hits=p.x+0.3>target.x&&p.x-0.3<target.x+1&&p.z+0.3>target.z&&p.z-0.3<target.z+1&&p.y<target.y+1&&p.y+1.8>target.y
  if(hits)throw new Error('cannot place a block inside a player')
  return place(ref,face)
 }
 await assert.rejects(executeSkill(w.bot,{kind:'hut',goal:{}},api),/could not stand clear of the wall line/)
})

// Run 73, 8 October: walled in twenty blocks from the portal in the Nether,
// the escape's walk could not leave the hut (it never digs its own blocks).
// Opening up can be asked to face a place: the wall toward it opens first.
test('a hut opened toward a place opens the wall facing it',async()=>{
 const w=world();await executeSkill(w.bot,{kind:'hut',goal:{}},api)
 const east=await unwall(w.bot,{kind:'unhut',goal:{toward:{x:40,z:11}}},api)
 assert.deepEqual(east.side,{dx:1,dz:0})
 const v=world();await executeSkill(v.bot,{kind:'hut',goal:{}},api)
 const north=await unwall(v.bot,{kind:'unhut',goal:{toward:{x:9,z:-30}}},api)
 assert.deepEqual(north.side,{dx:0,dz:-1})
})

// Run 84, 9 October: arriving in the Nether among hoglins, the bot beside the
// portal could not wall in ("Cannot wall through nether_portal"), so the only
// shelter was going home, and the room it was asked to build never started.
// Beside a portal the hut becomes a portal room: the portal's far side and its
// other column are sealed too, so nothing reaches the bot through the portal.
function besidePortal(){
 const w=world({logs:64})
 // Frame in the z=9 plane: obsidian x 9..12, y 63..67; portal x 10..11, y 64..66.
 for(let x=9;x<=12;x++)for(let y=63;y<=67;y++)w.cells.set(new Vec3(x,y,9).toString(),(x===9||x===12||y===63||y===67)?'obsidian':'nether_portal')
 w.bot.game.dimension='minecraft:the_nether'
 return w
}
test('beside a portal the hut seals the portal too: its far side and its other column',()=>{
 const w=besidePortal()
 const site=hutSite(w.bot)
 assert.equal(site.ok,true,site.reason);assert.equal(site.portal,true)
 assert.equal(site.needed,15,'6 far side, 3 beside the other column, 4 walls, helper and roof')
 const short=besidePortal();short.inventory[0].count=14;assert.match(hutSite(short.bot).reason,/15 blocks needed to close this spot and 14 carried/)
})
test('walling in beside a portal leaves a closed room that passes the shelter inspection',async()=>{
 const w=besidePortal()
 const result=await executeSkill(w.bot,{kind:'hut',goal:{}},api)
 assert.equal(result.receipt,'walled_in');assert.equal(result.protection.verified,true)
 for(const c of ['10,64,8','10,66,8','11,64,8','11,66,8','11,64,10','11,66,10','9,64,10','10,64,11','10,66,11','10,66,10']){const name=w.cells.get(new Vec3(...c.split(',').map(Number)).toString());assert.ok(name&&name!=='air','sealed '+c)}
 for(let y=64;y<=66;y++)assert.equal(w.cells.get(new Vec3(10,y,9).toString()),'nether_portal','the portal itself is untouched')
})

// Lab run 101, 10 October: the bot had opened its portal room and stepped two
// blocks out to shoot; three hoglins came round at ten blocks, and with the
// room a step away it went home through the portal, leaving the blaze and its
// rod. A portal room within a few steps is walked to and closed.
import {portalRoomSpot} from '../src/hut.js'
test('a few steps from a portal the hut walks back beside it and closes a portal room there',async()=>{
 const w=besidePortal()
 w.bot.entity.position=new Vec3(10.5,64,12.5)
 const spot=portalRoomSpot(w.bot)
 assert.ok(spot,'a spot beside the portal');assert.equal(spot.z,10);assert.ok([10,11].includes(spot.x))
 const walked=[]
 w.bot.pathfinder.goto=async g=>{walked.push(g);w.bot.entity.position=new Vec3(g.x+0.5,g.y,g.z+0.5)}
 const result=await executeSkill(w.bot,{kind:'hut',goal:{portalRoom:true}},api)
 assert.equal(walked.length,1);assert.equal(result.receipt,'walled_in');assert.equal(result.portalRoom,true)
 for(let y=64;y<=66;y++)assert.equal(w.cells.get(new Vec3(10,y,9).toString()),'nether_portal','the portal itself is untouched')
 const far=besidePortal();far.bot.entity.position=new Vec3(10.5,64,16.5)
 assert.equal(portalRoomSpot(far.bot),null,'seven blocks off is not a step back')
 await assert.rejects(executeSkill(far.bot,{kind:'hut',goal:{portalRoom:true}},api),/No spot beside a portal within 5 blocks/)
 // Lab run 108: five blocks east along the bridge, 4.1 from the room's cell, it went home.
 const along=besidePortal();along.bot.entity.position=new Vec3(10.5,64,14.5)
 assert.ok(portalRoomSpot(along.bot),'four blocks off is still a step back')
})

// Lab run 114, 12 October: at 9 health the bot stepped back beside the portal,
// arrived mid-step with its feet off the bricks, and the footing was judged
// that same instant: "Not standing on solid ground". It went home through the
// portal instead of closing the room. The walk's landing is waited for.
test('a step back to the portal room that arrives in the air waits to land before walling in',async()=>{
 const w=besidePortal()
 w.bot.entity.position=new Vec3(10.5,64,12.5)
 w.bot.pathfinder.goto=async g=>{w.bot.entity.position=new Vec3(g.x+0.5,g.y+0.2,g.z+0.5);w.bot.entity.onGround=false
  setTimeout(()=>{w.bot.entity.position=new Vec3(g.x+0.5,g.y,g.z+0.5);w.bot.entity.onGround=true},300)}
 const result=await executeSkill(w.bot,{kind:'hut',goal:{portalRoom:true}},api)
 assert.equal(result.receipt,'walled_in');assert.equal(result.portalRoom,true)
})
