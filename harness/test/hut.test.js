import {executeWithShelter} from './emergency-shelter-fixture.js'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {hutSite,wallIn,unwall} from '../src/hut.js'
import {burrowSite} from '../src/burrow.js'
import {inspectEmergencyShelter} from '../src/shelter-occupants.js'
import {executeSkill} from '../src/skills.js'
import {Teammate} from '../src/companion/controller.js'
import {THREAT_INTERRUPTION} from '../src/survival.js'
const registry=minecraftData('1.21.4')
function world({logs=21,stoneFrom=60,own=true}={}){
 const cells=new Map(),inventory=logs?[{name:'oak_log',count:logs}]:[],placed=[],dug=[],equipped=[],hand={name:null}
 const bot={registry,game:{gameMode:'survival',difficulty:'normal'},time:{timeOfDay:15000},health:20,food:18,entities:{},players:{},
  entity:{position:new Vec3(10.5,64,10.5),onGround:true},inventory:{items:()=>inventory},
  blockAt(p){const name=cells.get(p.toString())??(p.y>=64?'air':p.y===63?'grass_block':p.y>stoneFrom?'dirt':'stone');return {name,position:p.clone(),boundingBox:registry.blocksByName[name]?.boundingBox}},
  pathfinder:{setGoal(){},setMovements(){},async goto(){}},clearControlStates(){},tool:{async equipForBlock(){}},
  // As in mineflayer, the hand is the selected slot's stack, or null when that slot is empty.
  get heldItem(){const stack=hand.name&&inventory.find(i=>i.name===hand.name);return stack?{name:stack.name,count:stack.count}:null},
  async equip(item){equipped.push(item.name);hand.name=item.name},
  async placeBlock(ref,face){const p=ref.position.plus(face);placed.push(p.toString());cells.set(p.toString(),equipped.at(-1));const slot=inventory.find(i=>i.name===equipped.at(-1));if(slot&&--slot.count<=0)inventory.splice(inventory.indexOf(slot),1)},
  async dig(block){dug.push(block.position.toString());cells.set(block.position.toString(),'air')}}
 // As the runner does on spawn: the hut's walls are its own to open again (16 October).
 if(own)trackOwnPlacements(bot,new OwnBlocks(null))
 return {bot,cells,inventory,placed,dug,hand}
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
 // Lab run 142: a wall cell over air on a fortress walkway gets footing from the carried blocks.
 const pit=world({logs:12});pit.cells.set(new Vec3(11,63,10).toString(),'air');const edge=hutSite(pit.bot);assert.equal(edge.ok,true,edge.reason);assert.deepEqual(edge.footing,[new Vec3(11,63,10)]);assert.equal(edge.needed,11)
 const short=world({logs:10});short.cells.set(new Vec3(11,63,10).toString(),'air');assert.match(hutSite(short.bot).reason,/11 blocks needed/)
 const lava=world({logs:12});lava.cells.set(new Vec3(11,63,10).toString(),'lava');assert.match(hutSite(lava.bot).reason,/No ground to build the wall on .*lava/)
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
 const w=world({stoneFrom:62});const runner=new EventEmitter();runner.bot=w.bot;runner.ready=true;runner.connectionId='c1';runner.profile='p';runner.owner='Player'
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
function besidePortal(opts={}){
 const w=world({logs:64,...opts})
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

// Lab run 147, 15 October: an alarm cancelled the crossing before the arrival hop, and
// through the bridge the server ignores placements until the bot jumps. The portal room
// needed one block, failed after 8.4 seconds and the journal never said why. Two minutes
// later, after a crossing that hopped, the same placement landed in 0.64 seconds.
test('in the Nether a placement the server ignores until a jump is retried after one hop, and a failed one is reported',async()=>{
 const w=besidePortal(),place=w.bot.placeBlock.bind(w.bot),said=[];let jumped=false,ignored=0
 w.bot.setControlState=(control,on)=>{if(control==='jump'&&on){jumped=true;w.bot.entity.onGround=false;setTimeout(()=>{w.bot.entity.onGround=true},20)}}
 w.bot.placeBlock=async(ref,face)=>{if(!jumped){ignored++;throw new Error('Event blockUpdate did not fire within timeout of 5000ms')}return place(ref,face)}
 const result=await wallIn(w.bot,{kind:'hut',goal:{}},{...api,progress:t=>said.push(t)})
 assert.equal(result.receipt,'walled_in');assert.equal(ignored,1,'one ignored placement, then the hop')
 assert.ok(said.some(t=>/Placement at .* unconfirmed: Event blockUpdate/.test(t)),said.join(' | '))
 // In the Overworld nothing waits on a jump: no hop, and a wall that never lands is said.
 const v=world(),place2=v.bot.placeBlock.bind(v.bot),bad=new Vec3(9,64,10).toString(),told=[];let hops=0
 v.bot.setControlState=(control,on)=>{if(control==='jump'&&on)hops++}
 v.bot.placeBlock=async(ref,face)=>{if(ref.position.plus(face).toString()===bad)throw new Error('rejected');await place2(ref,face)}
 await assert.rejects(wallIn(v.bot,{kind:'hut',goal:{}},{...api,progress:t=>told.push(t)}),/Hut incomplete/)
 assert.equal(hops,0);assert.ok(told.some(t=>/Placement at 9,64,10 unconfirmed: rejected/.test(t)),told.join(' | '))
})
test('a wall whose planned reference is gone places against whatever solid neighbour stands',async()=>{
 // The ground under the east wall goes (a fireball, a mob) after the site was judged; stone stands beyond it.
 const w=world();w.cells.set(new Vec3(12,64,10).toString(),'stone')
 const equip=w.bot.equip;let first=true
 w.bot.equip=async item=>{if(first){first=false;w.cells.set(new Vec3(11,63,10).toString(),'air')}return equip(item)}
 const result=await wallIn(w.bot,{kind:'hut',goal:{}},api)
 assert.equal(result.receipt,'walled_in');assert.equal(w.cells.get(new Vec3(11,64,10).toString()),'oak_log')
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

// Lab run 146, 15 October: the confront's facing never reached the skill.
import {validateTaskGoal} from '../src/task-store.js'
test('an unhut goal keeps the way it faces, and nothing else',()=>{
 assert.deepEqual(validateTaskGoal('unhut',{toward:{x:40,z:11}}),{toward:{x:40,z:11}})
 assert.deepEqual(validateTaskGoal('unhut',{toward:{x:40.5,z:11}}),{})
 assert.deepEqual(validateTaskGoal('unhut',{toward:{x:40}}),{})
 assert.deepEqual(validateTaskGoal('unhut',{}),{})
 assert.deepEqual(validateTaskGoal('unhut',undefined),{})
})

// Lab run 146, 15 October: walled in inside a one-wide netherrack tunnel, blazes
// hovering outside its walls below eye level. Only the tunnel's own ends had
// standable ground beyond, so the opened wall faced along the tunnel, away from
// every blaze, and the bow never had a shot. Against a shooter the wall facing it
// opens as a firing port, natural rock and a drop beyond included.
function tunnelHut({own}={}){
 const w=world({logs:21,own})
 for(let z=0;z<=20;z++){
  for(const y of [63,64,65,66])w.cells.set(new Vec3(8,y,z).toString(),'netherrack'),w.cells.set(new Vec3(9,y,z).toString(),'netherrack')
  for(const y of [64,65,66])w.cells.set(new Vec3(11,y,z).toString(),'netherrack')
  w.cells.set(new Vec3(10,66,z).toString(),'netherrack');w.cells.set(new Vec3(10,63,z).toString(),'netherrack')
  // Beyond the one-thick +x wall: open air and a drop.
  for(let y=50;y<=70;y++)for(const x of [12,13,14,15])w.cells.set(new Vec3(x,y,z).toString(),'air')
 }
 w.bot.game.dimension='minecraft:the_nether'
 return w
}
const blazeAt=(bot,x,y,z)=>{bot.entities={1:{id:1,name:'blaze',type:'hostile',height:1.8,position:new Vec3(x,y,z)}}}
test('against a shooter the hut opens a firing port in the wall facing it, rock and a drop beyond included',async()=>{
 const w=tunnelHut();await executeSkill(w.bot,{kind:'hut',goal:{}},api)
 blazeAt(w.bot,13.5,63,10.5);w.dug.length=0
 const port=await unwall(w.bot,{kind:'unhut',goal:{toward:{x:13,z:10},shooter:'blaze'}},api)
 assert.deepEqual(port.side,{dx:1,dz:0})
 assert.deepEqual(port.opened,[{x:11,y:65,z:10}],'the head cell only, though the blaze is below eye level')
 // Above eye level too.
 const high=tunnelHut();await executeSkill(high.bot,{kind:'hut',goal:{}},api)
 blazeAt(high.bot,13.5,66,10.5);high.dug.length=0
 assert.deepEqual((await unwall(high.bot,{kind:'unhut',goal:{toward:{x:13,z:10},shooter:'blaze'}},api)).side,{dx:1,dz:0})
 assert.deepEqual(high.dug,[new Vec3(11,65,10).toString()])
})
// Live rehearsal, 16 October 22:21Z: the port opened by horizontal pull alone, never on the side the line was judged
// through. Given a side, unhut opens that side's head cell and ranks nothing; the refusals still stand.
test('unhut opens the side it is given, not the one with the most pull',async()=>{
 const w=tunnelHut();await executeSkill(w.bot,{kind:'hut',goal:{}},api)
 blazeAt(w.bot,13.5,63,10.5);w.dug.length=0
 const goal=validateTaskGoal('unhut',{toward:{x:13,z:10},shooter:'blaze',side:{dx:0,dz:1}})
 assert.deepEqual(goal.side,{dx:0,dz:1},'the side survives validation')
 const port=await unwall(w.bot,{kind:'unhut',goal},api)
 assert.deepEqual(port.side,{dx:0,dz:1});assert.deepEqual(w.dug,[new Vec3(10,65,11).toString()])
 assert.equal(validateTaskGoal('unhut',{toward:{x:13,z:10},shooter:'blaze',side:{dx:1,dz:1}}).side,undefined,'never a diagonal')
 // Lava over the given side's head cell refuses it, and no other side is taken instead.
 const hot=tunnelHut();await executeSkill(hot.bot,{kind:'hut',goal:{}},api)
 blazeAt(hot.bot,13.5,63,10.5);hot.cells.set(new Vec3(10,66,11).toString(),'lava');hot.dug.length=0
 await assert.rejects(unwall(hot.bot,{kind:'unhut',goal},api),/No wall facing the blaze/);assert.deepEqual(hot.dug,[])
})
// 16 October: the hut leans on any wall already standing, and in the play world that can be
// a player's. A port, or the plain exit, opens only what the bot may break: natural ground, or a
// block it placed itself. The bot stands at 10,64,10; a wall at x 11 is the east side.
function besideWall(name,{own=false}={}){
 const w=world({logs:0});w.inventory.push({name:'cobblestone',count:20})
 for(let z=8;z<=12;z++)for(const y of [64,65,66])w.cells.set(new Vec3(11,y,z).toString(),name)
 if(own)for(const y of [64,65])w.bot.ownBlocks.add(new Vec3(11,y,10),name,null)
 return w
}
const skeletonAt=(bot,x,y,z)=>{bot.entities={1:{id:1,name:'skeleton',type:'hostile',height:1.99,position:new Vec3(x,y,z)}}}
test('a firing port never opens through a player\'s wall: it takes another side facing the shooter, or there is none',async()=>{
 const w=besideWall('oak_planks');await executeSkill(w.bot,{kind:'hut',goal:{}},api);w.dug.length=0
 skeletonAt(w.bot,15.5,64,10.5)
 await assert.rejects(unwall(w.bot,{kind:'unhut',goal:{toward:{x:15,z:10},shooter:'skeleton'}},api),/No wall facing the skeleton/)
 assert.deepEqual(w.dug,[],'the planks stay');assert.equal(w.bot.blockAt(new Vec3(11,65,10)).name,'oak_planks')
 const d=besideWall('oak_planks');await executeSkill(d.bot,{kind:'hut',goal:{}},api);d.dug.length=0
 skeletonAt(d.bot,15.5,64,13.5)
 const port=await unwall(d.bot,{kind:'unhut',goal:{toward:{x:15,z:13},shooter:'skeleton'}},api)
 assert.deepEqual(port.side,{dx:0,dz:1},'its own cobblestone side');assert.deepEqual(d.dug,[new Vec3(10,65,11).toString()])
})
test('a firing port still opens the bot\'s own cobblestone and natural stone',async()=>{
 for(const [name,own] of [['cobblestone',true],['stone',false]]){
  const w=besideWall(name,{own});await executeSkill(w.bot,{kind:'hut',goal:{}},api);w.dug.length=0
  skeletonAt(w.bot,15.5,64,10.5)
  const port=await unwall(w.bot,{kind:'unhut',goal:{toward:{x:15,z:10},shooter:'skeleton'}},api)
  assert.deepEqual(port.opened,[{x:11,y:65,z:10}],name);assert.deepEqual(w.dug,[new Vec3(11,65,10).toString()],name)
 }
})
test('the plain exit opens only a side it may break, and with none it fails without digging',async()=>{
 const w=besideWall('oak_planks');await executeSkill(w.bot,{kind:'hut',goal:{}},api);w.dug.length=0
 const out=await unwall(w.bot,{kind:'unhut',goal:{toward:{x:40,z:10}}},api)
 assert.notDeepEqual(out.side,{dx:1,dz:0},'not through the planks, though that side faces the place');assert.ok(!w.dug.some(c=>c.startsWith('(11,')),w.dug.join(' '))
 // A player's room: planks on all four sides, the hut only roofs it.
 const room=world({logs:0});room.inventory.push({name:'cobblestone',count:20})
 for(const [x,z] of [[11,10],[9,10],[10,11],[10,9]])for(const y of [64,65])room.cells.set(new Vec3(x,y,z).toString(),'oak_planks')
 await executeSkill(room.bot,{kind:'hut',goal:{}},api);room.dug.length=0
 await assert.rejects(unwall(room.bot,{kind:'unhut',goal:{}},api),/Could not open a wall of the hut: all 4 sides are not natural ground and not placed by me$/)
 assert.deepEqual(room.dug,[],'the room is kept')
})
// Review of 16 October: the own-block record lapses after two hours for digging, but a hut held
// longer (four watches and a Resume) is still the bot's own to open while its walls stand.
test('a hut held past the own-block lapse still opens its own cobblestone, and still refuses the planks',async()=>{
 const realNow=Date.now
 try{
  const w=besideWall('oak_planks');await executeSkill(w.bot,{kind:'hut',goal:{}},api);w.dug.length=0
  const d=besideWall('oak_planks');await executeSkill(d.bot,{kind:'hut',goal:{}},api);d.dug.length=0
  const later=realNow()+3*3600*1000;Date.now=()=>later
  const out=await unwall(w.bot,{kind:'unhut',goal:{toward:{x:40,z:10}}},api)
  assert.notDeepEqual(out.side,{dx:1,dz:0});assert.ok(!w.dug.some(c=>c.startsWith('(11,')),w.dug.join(' '))
  skeletonAt(d.bot,15.5,64,13.5)
  const port=await unwall(d.bot,{kind:'unhut',goal:{toward:{x:15,z:13},shooter:'skeleton'}},api)
  assert.deepEqual(port.side,{dx:0,dz:1});assert.deepEqual(d.dug,[new Vec3(10,65,11).toString()])
 }finally{Date.now=realNow}
})
// Lab run 156, 15 October: a two-high port into a sealed room put the bot's whole body in the
// line of four blazes at 2.6 to 4 blocks, and it went from 20 health to 8.7 in six seconds. A
// blaze aims its fireball from its feet+1.4 at the target's mid-height, so a port at the feet
// takes every fireball. Against a shooter only the head cell opens, wherever the shooter is;
// an enderman still gets two, since its pearl is fetched by a step into the port.
test('against a shooter below eye level the port is the head cell only; an enderman still gets two',async()=>{
 const w=tunnelHut();await executeSkill(w.bot,{kind:'hut',goal:{}},api)
 blazeAt(w.bot,13.5,61,10.5);w.dug.length=0
 const port=await unwall(w.bot,{kind:'unhut',goal:{toward:{x:13,z:10},shooter:'blaze'}},api)
 assert.deepEqual(port.opened,[{x:11,y:65,z:10}]);assert.deepEqual(w.dug,[new Vec3(11,65,10).toString()])
 assert.equal(w.bot.blockAt(new Vec3(11,64,10)).name,'netherrack','the feet cell stays shut')
 const e=tunnelHut();await executeSkill(e.bot,{kind:'hut',goal:{}},api)
 e.bot.entities={1:{id:1,name:'enderman',type:'hostile',height:2.9,position:new Vec3(13.5,63,10.5)}};e.dug.length=0
 const two=await unwall(e.bot,{kind:'unhut',goal:{toward:{x:13,z:10},shooter:'enderman'}},api)
 assert.deepEqual(two.opened,[{x:11,y:65,z:10},{x:11,y:64,z:10}])
})
test('a firing port never opens onto lava or fire; a melee mob keeps the old exit',async()=>{
 const lava=tunnelHut();await executeSkill(lava.bot,{kind:'hut',goal:{}},api)
 lava.cells.set(new Vec3(12,65,10).toString(),'lava');blazeAt(lava.bot,13.5,63,10.5);lava.dug.length=0
 await assert.rejects(unwall(lava.bot,{kind:'unhut',goal:{toward:{x:13,z:10},shooter:'blaze'}},api),/No wall facing the blaze/)
 assert.deepEqual(lava.dug,[],'nothing dug toward the lava')
 // Off the diagonal, the other wall facing it opens instead.
 const diagonal=tunnelHut();await executeSkill(diagonal.bot,{kind:'hut',goal:{}},api)
 diagonal.cells.set(new Vec3(12,65,10).toString(),'fire');blazeAt(diagonal.bot,13.5,63,12.5)
 assert.deepEqual((await unwall(diagonal.bot,{kind:'unhut',goal:{toward:{x:13,z:12},shooter:'blaze'}},api)).side,{dx:0,dz:1})
 // A side already tried is not opened again.
 const tried=tunnelHut();await executeSkill(tried.bot,{kind:'hut',goal:{}},api);blazeAt(tried.bot,13.5,63,12.5)
 assert.deepEqual((await unwall(tried.bot,{kind:'unhut',goal:{toward:{x:13,z:12},shooter:'blaze',skip:[{dx:1,dz:0}]}},api)).side,{dx:0,dz:1})
 // A zombie, or no shooter named, opens a side the bot can step out of, as before.
 for(const goal of [{toward:{x:13,z:10}},{toward:{x:13,z:10},shooter:'zombie'}]){
  const melee=tunnelHut();await executeSkill(melee.bot,{kind:'hut',goal:{}},api)
  assert.deepEqual((await unwall(melee.bot,{kind:'unhut',goal},api)).side,{dx:0,dz:1},JSON.stringify(goal))
 }
 assert.deepEqual(validateTaskGoal('unhut',{toward:{x:13,z:12},shooter:'blaze',skip:[{dx:1,dz:0}]}),{toward:{x:13,z:12},shooter:'blaze',skip:[{dx:1,dz:0}]})
 assert.deepEqual(validateTaskGoal('unhut',{toward:{x:13,z:12},shooter:'zombie',skip:[{dx:2,dz:0},'x']}),{toward:{x:13,z:12}})
})

// Lab run 147, 15 October: going on from a hut on a kitted trip, the wall that opens is
// never the one facing the mob that held it.
test('a hut opened away from a mob never opens the wall facing it',async()=>{
 const w=tunnelHut();await executeSkill(w.bot,{kind:'hut',goal:{}},api)
 // Only the tunnel's ends have ground beyond; toward a place off to the side both tie.
 assert.deepEqual((await unwall(w.bot,{kind:'unhut',goal:{toward:{x:-20,z:10}}},api)).side,{dx:0,dz:1},'the tie goes to the first side')
 const v=tunnelHut();await executeSkill(v.bot,{kind:'hut',goal:{}},api)
 assert.deepEqual((await unwall(v.bot,{kind:'unhut',goal:{toward:{x:-20,z:10},from:[{x:10,z:30}]}},api)).side,{dx:0,dz:-1})
 assert.deepEqual(validateTaskGoal('unhut',{toward:{x:-20,z:10},from:[{x:10,z:30},{x:1.5,z:2},'x']}),{toward:{x:-20,z:10},from:[{x:10,z:30}]})
 assert.deepEqual(validateTaskGoal('unhut',{toward:{x:-20,z:10},from:{x:10,z:30}}),{toward:{x:-20,z:10}})
})
test('away from mobs, every side with any pull toward one stays shut, as does one onto lava; with none left the hut holds',async()=>{
 // A mob on the diagonal ties two sides: both stay shut, even when the place asked for is past them.
 const diagonal=world();await executeSkill(diagonal.bot,{kind:'hut',goal:{}},api)
 const d=await unwall(diagonal.bot,{kind:'unhut',goal:{toward:{x:40,z:40},from:[{x:20,z:20}]}},api)
 assert.ok(d.side.dx<=0&&d.side.dz<=0,JSON.stringify(d.side))
 // Two mobs on different sides.
 const two=world();await executeSkill(two.bot,{kind:'hut',goal:{}},api)
 const t=await unwall(two.bot,{kind:'unhut',goal:{toward:{x:40,z:10},from:[{x:30,z:10},{x:10,z:30}]}},api)
 assert.ok(!(t.side.dx===1||t.side.dz===1),JSON.stringify(t.side))
 // Lava two cells out on every other side: nothing is opened and the hut holds.
 const shut=world();await executeSkill(shut.bot,{kind:'hut',goal:{}},api);shut.dug.length=0
 for(const [x,z] of [[8,10],[12,10],[10,8]])shut.cells.set(new Vec3(x,64,z).toString(),'lava')
 await assert.rejects(unwall(shut.bot,{kind:'unhut',goal:{toward:{x:10,z:-30},from:[{x:10,z:30}]}},api),/No wall to open away from/)
 assert.deepEqual(shut.dug,[],'the hut is kept')
 // Without mobs named, the old exit is unchanged.
 const old=world();await executeSkill(old.bot,{kind:'hut',goal:{}},api)
 assert.ok((await unwall(old.bot,{kind:'unhut',goal:{}},api)).side)
})
test('away from a mob beside a portal, the portal side is never opened',async()=>{
 const w=besidePortal();await executeSkill(w.bot,{kind:'hut',goal:{}},api);w.dug.length=0
 // The portal is to the north (z=9); the mob is east, the place asked for north, and rock beyond west and south.
 for(const c of ['8,64,10','8,65,10','10,64,12','10,65,12'])w.cells.set(new Vec3(...c.split(',').map(Number)).toString(),'stone')
 const out=await unwall(w.bot,{kind:'unhut',goal:{toward:{x:10,z:-30},from:[{x:30,z:10}]}},api)
 assert.notDeepEqual(out.side,{dx:0,dz:-1});assert.ok(!w.dug.some(c=>c.endsWith(',9')),w.dug.join(' '))
})
// Review of lab run 156, 15 October: a fireball can light the hut's own floor, and a bot
// standing in fire burns for as long as it stands there. Fire in the cavity is no shelter,
// as liquid is not.
test('a closed hut with fire in its cavity fails the shelter inspection',async()=>{
 const w=world();await executeSkill(w.bot,{kind:'hut',goal:{}},api)
 assert.equal(inspectEmergencyShelter(w.bot).verified,true)
 w.cells.set(new Vec3(10,64,10).toString(),'fire')
 assert.throws(()=>inspectEmergencyShelter(w.bot),/Emergency shelter contains fire/)
})

// Lab run 162, 15 October: the firing-port loop dug its port, shot, and closed it again
// with the hut, re-placing the wall from carried cobblestone. Through the version bridge
// a placement's update can come late, so placeBlock threw while the block landed inside
// the hut's own settle. Nothing recorded it, and the planner's dig step then refused the
// bot's own wall: "cobblestone at -41,60,-8 is not natural ground".
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {OwnBlocks,trackOwnPlacements} from '../src/natural.js'
import {refuseDigCell} from '../src/primitives.js'
// The bridge: placeBlock gives up on the update, the block lands a moment later, and no update arrives.
function bridged(w,own){
 const place=w.bot.placeBlock,ee=new EventEmitter();let late=true
 w.bot.on=ee.on.bind(ee);w.bot.emit=ee.emit.bind(ee)
 w.bot.placeBlock=async(ref,face)=>{if(!late)return place(ref,face);setTimeout(()=>place(ref,face),80);throw new Error('Event blockUpdate did not fire within timeout of 5000ms')}
 // mineflayer's dig announces the cell turning to air, as the server's update does.
 const dig=w.bot.dig;w.bot.dig=async block=>{const old=w.bot.blockAt(block.position);await dig(block);w.bot.emit('blockUpdate',old,w.bot.blockAt(block.position))}
 trackOwnPlacements(w.bot,own)
 return {set late(v){late=v}}
}
test('a hut whose placements land late still records its cobblestone walls as its own to dig',async()=>{
 const w=world({logs:0,own:false});w.inventory.push({name:'cobblestone',count:20})
 const own=new OwnBlocks(null);bridged(w,own)
 assert.equal((await wallIn(w.bot,{kind:'hut',goal:{}},api)).receipt,'walled_in')
 assert.equal(w.placed.length,10)
 for(const cell of w.placed){const p=new Vec3(...cell.slice(1,-1).split(',').map(Number))
  assert.equal(w.bot.blockAt(p).name,'cobblestone');assert.equal(refuseDigCell(w.bot,p),null,`its own wall at ${cell}`)}
 w.cells.set(new Vec3(14,64,10).toString(),'cobblestone')
 assert.match(refuseDigCell(w.bot,new Vec3(14,64,10)),/cobblestone at 14,64,10 is not natural ground/,'a player\'s cobblestone stays refused')
})
test('a firing port closed again with cobblestone is the bot\'s own to dig, across a restart too',async()=>{
 const w=tunnelHut({own:false});w.inventory.splice(0,w.inventory.length,{name:'cobblestone',count:21})
 const path=join(mkdtempSync(join(tmpdir(),'mc-port-')),'own-blocks.json'),own=new OwnBlocks(path),bridge=bridged(w,own)
 bridge.late=false;await executeSkill(w.bot,{kind:'hut',goal:{}},api)
 blazeAt(w.bot,13.5,63,10.5)
 const port=await unwall(w.bot,{kind:'unhut',goal:{toward:{x:13,z:10},shooter:'blaze'}},api)
 assert.deepEqual(port.opened,[{x:11,y:65,z:10}])
 w.bot.entities={};bridge.late=true
 assert.equal((await wallIn(w.bot,{kind:'hut',goal:{}},api)).receipt,'walled_in')
 const cell=new Vec3(11,65,10)
 assert.equal(w.bot.blockAt(cell).name,'cobblestone')
 assert.equal(refuseDigCell(w.bot,cell),null,'the re-closed port is its own')
 assert.equal(new OwnBlocks(path).has(cell,'cobblestone','the_nether'),true,'remembered across a restart')
 w.cells.set(new Vec3(11,64,11).toString(),'cobblestone')
 assert.match(refuseDigCell(w.bot,new Vec3(11,64,11)),/not natural ground/,'a player\'s cobblestone in the wall line stays refused')
})
// Lab run 163, 15 October: in the Nether the hut's wall cell at -42,59,-8 had a dropper
// as its only solid neighbour. Vanilla right-click on a block with a use opens it
// instead of placing against it unless the player sneaks, so the hut ended "1 of 10
// blocks missing" and the safety chain fell back to the portal walk. The fake server
// here behaves that way; the runner's sneak wrapper is installed over it, as on spawn.
import {sneakAgainstInteractables} from '../src/placement.js'
import {fillCell} from '../src/scaffold.js'
const USES=new Set(['dropper','chest','furnace'])
function vanilla(w){
 const place=w.bot.placeBlock,controls={sneak:false},refs=[],sneaks=[],opened=[]
 w.bot.setControlState=(c,s)=>{if(controls[c]===s)return;controls[c]=s;if(c==='sneak')sneaks.push(s)}
 w.bot.getControlState=c=>controls[c]
 w.bot.placeBlock=async(ref,face)=>{
  refs.push({at:ref.position.toString(),sneaking:controls.sneak})
  if(USES.has(ref.name)&&!controls.sneak){opened.push(ref.position.toString());throw new Error('No block has been placed : the block is still air')}
  return place(ref,face)}
 sneakAgainstInteractables(w.bot)
 return {controls,refs,sneaks,opened}
}
test('a hut wall whose only neighbour is a dropper is placed sneaking, and the sneak is let go after',async()=>{
 const w=world(),dropper=new Vec3(11,63,10);w.cells.set(dropper.toString(),'dropper')
 const server=vanilla(w)
 assert.equal((await wallIn(w.bot,{kind:'hut',goal:{}},api)).receipt,'walled_in')
 assert.equal(w.cells.get(new Vec3(11,64,10).toString()),'oak_log')
 assert.deepEqual(server.opened,[],'the dropper was never opened')
 assert.deepEqual(server.refs.filter(r=>r.at===dropper.toString()),[{at:dropper.toString(),sneaking:true}])
 assert.deepEqual(server.sneaks,[true,false]);assert.equal(server.controls.sneak,false)
})
test('a hut wall with a dropper below and stone beside it is placed against the stone, without sneaking',async()=>{
 const w=world(),dropper=new Vec3(11,63,10),stone=new Vec3(12,64,10)
 w.cells.set(dropper.toString(),'dropper');w.cells.set(stone.toString(),'stone')
 const server=vanilla(w)
 assert.equal((await wallIn(w.bot,{kind:'hut',goal:{}},api)).receipt,'walled_in')
 assert.ok(server.refs.some(r=>r.at===stone.toString()),'the stone is the reference')
 assert.ok(!server.refs.some(r=>r.at===dropper.toString()),'the dropper is never clicked')
 assert.deepEqual(server.sneaks,[])
})
test('fillCell against a lone dropper places sneaking; beside stone it takes the stone and never sneaks',async()=>{
 const lone=world(),cell=new Vec3(11,64,10),below=new Vec3(11,63,10);lone.cells.set(below.toString(),'dropper')
 const s1=vanilla(lone)
 assert.equal(await fillCell(lone.bot,cell,{check(){}}),true)
 assert.equal(lone.cells.get(cell.toString()),'oak_log')
 assert.deepEqual(s1.refs,[{at:below.toString(),sneaking:true}]);assert.deepEqual(s1.sneaks,[true,false])
 // The dropper comes first in fillCell's own order (+x); the grass below is plain.
 const mixed=world(),side=new Vec3(12,64,10);mixed.cells.set(side.toString(),'dropper')
 const s2=vanilla(mixed)
 assert.equal(await fillCell(mixed.bot,cell,{check(){}}),true)
 assert.deepEqual(s2.refs,[{at:below.toString(),sneaking:false}]);assert.deepEqual(s2.sneaks,[])
})

// Lab run 164, 15 October: after the bow, re-closing the hut in a one-wide Nether corridor,
// the first click timed out ("blockUpdate did not fire") and the retry found the hand empty
// ("must be holding an item to place") with 52 cobblestone carried: "Hut incomplete: 1 of 10".
// The fake server here places only what the hand holds, as mineflayer and vanilla do.
function handServer(w,{equipTakes=()=>true,afterClick=()=>{}}={}){
 const clicks=[]
 w.bot.equip=async item=>{if(equipTakes(item.name))w.hand.name=item.name}
 w.bot.placeBlock=async(ref,face)=>{
  const held=w.bot.heldItem,p=ref.position.plus(face)
  clicks.push({at:p.toString(),held:held?.name??null})
  if(!held)throw new Error('must be holding an item to place')
  // A bow or any other non-block takes the click and places nothing.
  if(!registry.blocksByName[held.name])throw new Error(`Event blockUpdate:${p} did not fire within timeout of 5000ms`)
  return afterClick(p,held)
 }
 return clicks
}
function placeHeld(w,p){w.placed.push(p.toString());w.cells.set(p.toString(),w.hand.name);const s=w.inventory.find(i=>i.name===w.hand.name);if(s&&--s.count<=0)w.inventory.splice(w.inventory.indexOf(s),1)}
test('walling in with the bow in hand places every block with cobblestone held, equipping again when the first equip does not take',async()=>{
 const w=world({logs:0});w.inventory.push({name:'bow',count:1},{name:'cobblestone',count:52});w.hand.name='bow'
 let dropped=1
 const clicks=handServer(w,{equipTakes:()=>dropped--<=0,afterClick:(p)=>placeHeld(w,p)})
 assert.equal((await wallIn(w.bot,{kind:'hut',goal:{}},api)).receipt,'walled_in')
 assert.equal(w.placed.length,10)
 assert.deepEqual(clicks.filter(c=>c.held!=='cobblestone'),[],'no click with the bow or an empty hand')
})
test('a placement that times out and leaves the hand empty is retried with the block equipped again',async()=>{
 const w=world({logs:0});w.inventory.push({name:'bow',count:1},{name:'cobblestone',count:52});w.hand.name='bow'
 const said=[];let first=true
 const clicks=handServer(w,{afterClick:(p)=>{
  // The first click is lost and the hand changes while the hut waits: the bow, then nothing.
  if(first){first=false;w.hand.name='bow';setTimeout(()=>{w.hand.name=null},10);throw new Error(`Event blockUpdate:${p} did not fire within timeout of 5000ms`)}
  placeHeld(w,p)}})
 assert.equal((await wallIn(w.bot,{kind:'hut',goal:{}},{...api,progress:t=>said.push(t)})).receipt,'walled_in')
 assert.equal(w.placed.length,10)
 assert.equal(clicks.length,11,'one lost click, then one retry')
 assert.equal(clicks[1].at,clicks[0].at);assert.equal(clicks[1].held,'cobblestone')
 assert.ok(!said.some(t=>/must be holding/.test(t)),said.join(' | '))
})
test('a placement that times out but lands a tick later is counted placed and never clicked again',async()=>{
 const w=world({logs:0});w.inventory.push({name:'cobblestone',count:52})
 let first=true
 const clicks=handServer(w,{afterClick:(p)=>{
  if(first){first=false;setTimeout(()=>{placeHeld(w,p);w.hand.name=null},50);throw new Error(`Event blockUpdate:${p} did not fire within timeout of 5000ms`)}
  placeHeld(w,p)}})
 const result=await wallIn(w.bot,{kind:'hut',goal:{}},api)
 assert.equal(result.receipt,'walled_in');assert.equal(result.placed,10)
 assert.equal(clicks.length,10,'no retry for the block that landed late')
 assert.equal(new Set(clicks.map(c=>c.at)).size,10)
})
test('fillCell clicks its next reference with the block in hand when the first click is lost and empties the hand',async()=>{
 const w=world({logs:0});w.inventory.push({name:'cobblestone',count:5});w.cells.set(new Vec3(12,64,10).toString(),'stone')
 let first=true
 const clicks=handServer(w,{afterClick:(p)=>{if(first){first=false;w.hand.name=null;throw new Error(`Event blockUpdate:${p} did not fire within timeout of 5000ms`)}placeHeld(w,p)}})
 assert.equal(await fillCell(w.bot,new Vec3(11,64,10),{check(){}}),true)
 assert.equal(w.cells.get(new Vec3(11,64,10).toString()),'cobblestone')
 assert.deepEqual(clicks.map(c=>c.held),['cobblestone','cobblestone'])
})

// Lab run 165, 15 October: the hut spent a single dirt block ahead of a stack of cobblestone,
// and the next cell was clicked with the dirt already spent: the block update lands before
// the inventory update, so the emptied stack still read one. The click timed out and the
// retry said "No dirt left to place", the cobblestone never tried: "Hut incomplete: 1 of 10".
// The fake inventory here lags the same way: an emptied stack reads one until the next
// click with it is lost, and only then is it gone.
function laggingStacks(w){
 const spent=new Set()
 return handServer(w,{afterClick:(p,held)=>{
  const s=w.inventory.find(i=>i.name===held.name)
  if(spent.has(s)){spent.delete(s);w.inventory.splice(w.inventory.indexOf(s),1);throw new Error(`Event blockUpdate:${p} did not fire within timeout of 5000ms`)}
  w.placed.push(p.toString());w.cells.set(p.toString(),held.name)
  if(s.count===1)spent.add(s);else s.count--
 }})
}
test('the hut spends its biggest stack first: one dirt and sixty-four cobblestone wall in with cobblestone, and the dirt is still carried',async()=>{
 const w=world({logs:0});w.inventory.push({name:'dirt',count:1},{name:'cobblestone',count:64})
 const clicks=laggingStacks(w)
 assert.equal((await wallIn(w.bot,{kind:'hut',goal:{}},api)).receipt,'walled_in')
 assert.deepEqual(clicks.filter(c=>c.held!=='cobblestone'),[])
 assert.equal(w.inventory.find(i=>i.name==='dirt')?.count,1)
})
test('a stack the last click emptied gives way to the next kind on the retry, and the hut closes',async()=>{
 // Five and five: the hut takes them in turn, the dirt empties on the ninth block and
 // still reads one, level with the last cobblestone, for the tenth.
 const w=world({logs:0});w.inventory.push({name:'dirt',count:5},{name:'cobblestone',count:5})
 const said=[],clicks=laggingStacks(w)
 const result=await wallIn(w.bot,{kind:'hut',goal:{}},{...api,progress:t=>said.push(t)})
 assert.equal(result.receipt,'walled_in');assert.equal(result.placed,10)
 assert.ok(!said.some(t=>/No dirt left/.test(t)),said.join(' | '))
 assert.deepEqual(clicks.slice(-2).map(c=>c.held),['dirt','cobblestone'])
 assert.equal(clicks.at(-1).at,clicks.at(-2).at)
})
test('with a few blocks of several kinds the hut uses every one, each emptied stack giving way to the next',async()=>{
 const w=world({logs:0});w.inventory.push({name:'stone_bricks',count:1},{name:'dirt',count:1},{name:'cobblestone',count:8})
 const said=[];laggingStacks(w)
 const result=await wallIn(w.bot,{kind:'hut',goal:{}},{...api,progress:t=>said.push(t)})
 assert.equal(result.receipt,'walled_in',said.join(' | '));assert.equal(result.placed,10)
 const walls=[...w.cells.values()]
 assert.deepEqual(['stone_bricks','dirt','cobblestone'].map(n=>walls.filter(x=>x===n).length),[1,1,8])
})
test('the hut walls in with plain ground blocks before anything built or bought: cobblestone first, the planks and iron blocks kept',async()=>{
 const w=world({logs:0});w.inventory.push({name:'oak_planks',count:64},{name:'iron_block',count:9},{name:'cobblestone',count:10})
 const clicks=laggingStacks(w)
 assert.equal((await wallIn(w.bot,{kind:'hut',goal:{}},api)).receipt,'walled_in')
 assert.deepEqual([...new Set(clicks.map(c=>c.held))],['cobblestone'])
 assert.deepEqual(['oak_planks','iron_block'].map(n=>w.inventory.find(i=>i.name===n)?.count),[64,9])
})

// Rehearsal, 16 October 19:25Z: arriving at the mouth of its own tunnel beside the portal, a wither skeleton came
// through the portal's open far side and the bot went home. Sealing the portal's faces from the near side, with the
// tunnel left open behind, makes the tunnel and the portal one closed cavity (seal_portal; design-portal-room).
import {sealPortal} from '../src/hut.js'
import {COVERED_CELLS} from '../src/companion/continuity.js'
const FACES_FAR=['10,64,8','10,65,8','10,66,8','11,64,8','11,65,8','11,66,8'],FACES_NEAR=['11,64,10','11,65,10','11,66,10']
// The bot at the mouth of a tunnel running +z from the portal: walls x 9 and 11, roof y 66, closed at z 15.
function tunnelMouth(opts){
 const w=besidePortal(opts)
 for(let z=10;z<=14;z++){for(const y of [64,65,66])for(const x of [9,11])w.cells.set(new Vec3(x,y,z).toString(),'stone');w.cells.set(new Vec3(10,66,z).toString(),'stone')}
 for(const y of [64,65])w.cells.set(new Vec3(10,y,15).toString(),'stone')
 return w
}
test('the portal faces alone: six on the far side and three beside the other column, none of the bot\'s own walls',()=>{
 const w=besidePortal(),site=hutSite(w.bot,{facesOnly:true})
 assert.equal(site.ok,true,site.reason);assert.equal(site.needed,9)
 assert.deepEqual(site.cells.map(c=>`${c.x},${c.y},${c.z}`).sort(),[...FACES_FAR,...FACES_NEAR].sort())
 assert.equal(hutSite(tunnelMouth().bot,{facesOnly:true}).needed,6,'the other column\'s near side already stands')
})
test('seal_portal places the faces with cobblestone first, claims them, digs nothing and leaves the portal and frame alone',async()=>{
 const w=tunnelMouth();w.inventory.push({name:'cobblestone',count:16});w.inventory.push({name:'dirt',count:16})
 const result=await executeSkill(w.bot,{kind:'seal_portal',goal:{}},api)
 assert.equal(result.receipt,'portal_sealed');assert.equal(result.placed,6);assert.equal(result.alreadySealed,false)
 for(const c of FACES_FAR)assert.equal(w.cells.get(new Vec3(...c.split(',').map(Number)).toString()),'cobblestone',c)
 assert.equal(w.dug.length,0)
 for(let y=64;y<=66;y++)for(const x of [10,11])assert.equal(w.cells.get(new Vec3(x,y,9).toString()),'nether_portal')
 assert.ok(FACES_FAR.every(c=>w.bot.ownBlocks.has(new Vec3(...c.split(',').map(Number)),'cobblestone','the_nether')),'the seal is the bot\'s own')
 const again=await executeSkill(w.bot,{kind:'seal_portal',goal:{}},api)
 assert.equal(again.placed,0);assert.equal(again.alreadySealed,true);assert.equal(w.placed.length,6,'no click the second time')
})
test('seal_portal refuses the Overworld, no portal beside, a hostile in a face cell, and too few blocks',async()=>{
 const over=tunnelMouth();over.bot.game.dimension='minecraft:overworld';await assert.rejects(executeSkill(over.bot,{kind:'seal_portal',goal:{}},api),/Nether/)
 const away=world();away.bot.game.dimension='minecraft:the_nether';await assert.rejects(executeSkill(away.bot,{kind:'seal_portal',goal:{}},api),/beside the portal/)
 const mob=tunnelMouth();mob.bot.entities={5:{id:5,name:'wither_skeleton',position:new Vec3(10.5,64,8.5),width:.7,height:2.4}}
 await assert.rejects(executeSkill(mob.bot,{kind:'seal_portal',goal:{}},api),/wither_skeleton/)
 const short=tunnelMouth({logs:5});await assert.rejects(executeSkill(short.bot,{kind:'seal_portal',goal:{}},api),/6 blocks needed/)
})
test('one cavity: the tunnel and portal fail the covered inspection open, and pass it once the portal is sealed',async()=>{
 const w=tunnelMouth()
 assert.throws(()=>inspectEmergencyShelter(w.bot,{limit:COVERED_CELLS}),/open or exceeds/)
 await executeSkill(w.bot,{kind:'seal_portal',goal:{}},api)
 assert.equal(inspectEmergencyShelter(w.bot,{limit:COVERED_CELLS}).verified,true)
})
test('a seal broken off part way places only the faces still open the next time',async()=>{
 const w=tunnelMouth();for(const c of FACES_FAR.slice(0,3))w.cells.set(new Vec3(...c.split(',').map(Number)).toString(),'cobblestone')
 const result=await executeSkill(w.bot,{kind:'seal_portal',goal:{}},api)
 assert.equal(result.placed,3);assert.equal(w.placed.length,3);assert.equal(result.alreadySealed,false)
})
// Review of 55698df (live rehearsal, 17 October 01:17Z): a piglin stood in the bot's own tunnel, in the column's open
// end. The server takes no block inside a creature, so the hut places the free cells first, the far side first, and
// names the occupied cell instead of clicking it twice and hopping.
test('a creature standing in a column cell to be walled: the far side is walled first and the occupied cell is named, never clicked',async()=>{
 const run=async({leaves=false}={})=>{
  const w=tunnelHut(),clicks=[],place=w.bot.placeBlock
  w.bot.entities={1:{id:1,name:'piglin',type:'hostile',height:1.95,width:.6,position:new Vec3(10.5,64,11.5)}}
  w.bot.placeBlock=async(ref,face)=>{const c=ref.position.plus(face);clicks.push(c.toString());if(Object.values(w.bot.entities).some(e=>e.position.floored().equals(c)||e.position.floored().offset(0,1,0).equals(c)))throw new Error('Block is inside an entity');await place(ref,face)
   if(leaves&&clicks.length===2)delete w.bot.entities[1]}
  const result=await wallIn(w.bot,{kind:'hut',goal:{}},api).catch(e=>e)
  return {w,clicks,result}
 }
 const {clicks,result}=await run()
 assert.match(String(result?.message),/Hut incomplete: 2 of \d+ blocks missing .*10,64,11 occupied by a piglin/,String(result?.message||result?.receipt))
 assert.deepEqual(clicks.slice(0,2),[new Vec3(10,64,9).toString(),new Vec3(10,65,9).toString()],'the far side first')
 assert.ok(!clicks.some(c=>c===new Vec3(10,64,11).toString()||c===new Vec3(10,65,11).toString()),'no click into the piglin: '+clicks.join(' '))
 // Gone by the end of the first pass, its cells are walled after all.
 const later=await run({leaves:true});assert.equal(later.result.receipt,'walled_in',String(later.result?.message))
})

// Live rehearsal R9, 17 October 06:42Z (death 6, "burned to a crisp while fighting Blaze"): a blaze fireball lit the open port
// cell, and every close after it was refused, "Cannot wall in here: Cannot wall through fire at -37,61,-9". Fire is a
// replaceable block in vanilla and a punch puts it out, so a wall cell holding fire or soul fire is punched out and walled.
// Lava still refuses the wall.
test('a wall cell holding fire or soul fire is punched out and walled; lava there still refuses the hut',async()=>{
 for(const fire of ['fire','soul_fire']){
  const w=world(),cell=new Vec3(11,65,10);w.cells.set(cell.toString(),fire)
  assert.equal(hutSite(w.bot).ok,true,`${fire}: ${hutSite(w.bot).reason}`)
  const result=await wallIn(w.bot,{kind:'hut',goal:{}},api)
  assert.equal(result.receipt,'walled_in',fire);assert.equal(w.cells.get(cell.toString()),'oak_log',fire)
  assert.ok(w.dug.includes(cell.toString()),`${fire}: punched out before the wall went in`)
 }
 const lava=world();lava.cells.set(new Vec3(11,65,10).toString(),'lava')
 assert.match(hutSite(lava.bot).reason,/Cannot wall through lava at 11,65,10/)
 await assert.rejects(wallIn(lava.bot,{kind:'hut',goal:{}},api),/Cannot wall through lava/)
})
