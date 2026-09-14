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
  execute:Teammate.prototype.execute,leaveOccupiedShelter:async()=>{},seekSafety:Teammate.prototype.seekSafety,lastResortShelter:Teammate.prototype.lastResortShelter,moveOutOfDanger:Teammate.prototype.moveOutOfDanger,leaveOnOpenGround:Teammate.prototype.leaveOnOpenGround,waitInBurrow:Teammate.prototype.waitInBurrow,
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
