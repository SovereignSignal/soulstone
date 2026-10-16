import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {validateBoreGoal,borePath,BORE_MAX} from '../src/bore.js'
import {executeSkill} from '../src/skills.js'
import {hutSite} from '../src/hut.js'
import {validatePlan} from '../src/companion/planner.js'
import {validateTaskGoal} from '../src/task-store.js'
import {Runner} from '../src/runner.js'
import {OwnBlocks,trackOwnPlacements} from '../src/natural.js'
const registry=minecraftData('1.21.4')
const k=(x,y,z)=>new Vec3(x,y,z).toString()
// A Nether of netherrack with the bot standing at 0,64,0 in a two-high cell. fills: [x,y,z,name].
// The log keeps digs, placements and steps in order; a dig drops the block it broke unless drops is false.
function world({fills=[],items,health=20,food=20,drops=true,ground=()=>'netherrack'}={}){
 const cells=new Map([[k(0,64,0),'air'],[k(0,65,0),'air'],...fills.map(([x,y,z,n])=>[k(x,y,z),n])]),log=[],hand={name:null}
 const inventory=items??[{name:'iron_pickaxe',count:1,type:registry.itemsByName.iron_pickaxe.id},{name:'cobblestone',count:32}]
 const blockAt=p=>{const at=p.floored(),name=cells.get(at.toString())??ground(at),e=registry.blocksByName[name];return {name,position:at,boundingBox:e.boundingBox,diggable:e.diggable,harvestTools:e.harvestTools}}
 const bot={registry,game:{dimension:'the_nether',gameMode:'survival'},health,food,entities:{},entity:{position:new Vec3(.5,64,.5),onGround:true},inventory:{items:()=>inventory},blockAt,
  // mineflayer 4.38's own rule: breakable, and the block centre within 5.1 of the eyes.
  canDigBlock:b=>!!b?.diggable&&b.position.offset(.5,.5,.5).distanceTo(bot.entity.position.offset(0,1.62,0))<=5.1,
  pathfinder:{profiles:[],setGoal(){},setMovements(m){this.profiles.push(m)},async goto(g){const cell=new Vec3(g.x,g.y,g.z);log.push(['step',cell.toString(),blockAt(cell.offset(0,-1,0)).name]);bot.entity.position=cell.offset(.5,0,.5)}},
  clearControlStates(){},tool:{async equipForBlock(){}},
  get heldItem(){const stack=hand.name&&inventory.find(i=>i.name===hand.name);return stack?{name:stack.name,count:stack.count}:null},
  async equip(item){hand.name=item.name},
  async placeBlock(ref,face){
   const p=ref.position.plus(face),feet=bot.entity.position.floored()
   if(!registry.blocksByName[ref.name]||blockAt(ref.position).boundingBox!=='block')throw new Error('no reference')
   if(p.equals(feet)||p.equals(feet.offset(0,1,0)))throw new Error('inside the player')
   const slot=inventory.find(i=>i.name===hand.name);if(!slot)throw new Error('must be holding an item to place')
   cells.set(p.toString(),slot.name);log.push(['place',p.toString(),slot.name,feet.toString(),ref.position.toString()]);if(--slot.count<=0)inventory.splice(inventory.indexOf(slot),1)},
  async dig(b){log.push(['dig',b.position.toString()]);if(drops){const s=inventory.find(i=>i.name===b.name);s?s.count++:inventory.push({name:b.name,count:1})}cells.set(b.position.toString(),'air')}}
 bot.world={getBlock:blockAt}
 trackOwnPlacements(bot,new OwnBlocks(null))
 const at=()=>bot.entity.position.floored()
 const of=kind=>log.filter(e=>e[0]===kind).map(e=>e[1])
 return {bot,cells,log,inventory,at,of}
}
const api={check(){},stage(){},progress(){},persist(){},movements:null}
const bore=(w,goal,ctx=api)=>executeSkill(w.bot,{kind:'bore',goal:{x:10,y:64,z:0,count:10,...goal}},ctx)
// A room of air beyond the rock: x 5 to 8, y 64 to 66, z -2 to 2.
const ROOM=[];for(let x=5;x<=8;x++)for(let y=64;y<=66;y++)for(let z=-2;z<=2;z++)ROOM.push([x,y,z,'air'])

test('bore validates its goal and step and is registered as a skill, a label and a brief line',()=>{
 assert.deepEqual(validateBoreGoal({x:1,y:2,z:3,count:BORE_MAX}),{x:1,y:2,z:3,count:64})
 for(const count of [0,65,1.5])assert.throws(()=>validateBoreGoal({x:1,y:2,z:3,count}),/1–64/)
 assert.throws(()=>validateBoreGoal({x:1.5,y:2,z:3,count:4}),/integer/)
 assert.throws(()=>validateBoreGoal({x:1,y:2,z:3,count:4,protectedSites:[{minX:2,maxX:1,minZ:0,maxZ:0}]}),/protected/)
 const step=over=>({action:'bore',name:'',count:64,item:'',design:[],target:{x:-35,y:57,z:-8},...over})
 assert.deepEqual(validatePlan({reply:'Boring.',steps:[step()]}).steps[0],{action:'bore',name:'',count:64,target:{x:-35,y:57,z:-8}})
 for(const count of [0,65])assert.throws(()=>validatePlan({reply:'x',steps:[step({count})]}),/1–64/)
 assert.throws(()=>validatePlan({reply:'x',steps:[step({target:null})]}),/target/)
 assert.deepEqual(validateTaskGoal('bore',{x:1,y:64,z:0,count:2}),{x:1,y:64,z:0,count:2})
 const calls=[]
 Runner.prototype.applyGoal.call({ready:true,connectionId:'c1',task:{kind:'bore',status:'running',goal:{x:1,y:64,z:1,count:2},deadline:Date.now()+10000},bot:{pathfinder:{setGoal:g=>calls.push(['navigate',g])}},log:t=>calls.push([t]),finish:(s,r)=>calls.push(['finish',s,r]),runSkill:()=>calls.push(['runSkill'])})
 assert.deepEqual(calls,[['runSkill']])
 const controller=readFileSync(new URL('../src/companion/controller.js',import.meta.url),'utf8')
 assert.match(controller.split('\n').find(l=>l.includes('const labels={')),/bore:s=>`bore a covered tunnel \$\{s\.count\} columns toward \$\{s\.target\.x\}, /)
 assert.match(readFileSync(new URL('../src/companion/survival-capabilities.txt',import.meta.url),'utf8'),/^Action bore: name="", item="", count=1–64/m)
})
test('bore admits through intent and skill control',async()=>{
 const {guardIntent}=await import('../src/companion/intent.js'),{SKILL_ACTIONS}=await import('../src/companion/skill-control.js')
 const plan=validatePlan({reply:'ok',steps:[{action:'bore',name:'',count:8,item:'',design:[],target:{x:9,y:64,z:0}}]})
 assert.deepEqual(guardIntent(plan,'bore toward the spawner'),plan);assert.ok(SKILL_ACTIONS.has('bore'))
})
test('the path is Manhattan: one axis a column, the longer first, and height spread one step at a time',()=>{
 const from=new Vec3(0,64,0),path=borePath(from,{x:35,y:61,z:33})
 assert.equal(path.length,68);assert.deepEqual(path.at(-1),new Vec3(35,61,33))
 let prev=from;const drops=[]
 for(const [i,c] of path.entries()){
  assert.equal(Math.abs(c.x-prev.x)+Math.abs(c.z-prev.z),1,`column ${i+1} moves one cell on one axis`);assert.ok(Math.abs(c.y-prev.y)<=1)
  if(c.y!==prev.y)drops.push(i+1)
  if(i<35)assert.equal(c.z,0,'the longer axis runs first, in full');prev=c
 }
 assert.deepEqual(drops,[22,44,66])
 const shortX=borePath(from,{x:2,y:64,z:-5});assert.deepEqual(shortX.slice(0,5).map(c=>c.x),[0,0,0,0,0]);assert.equal(shortX.length,7)
})
test('through solid netherrack bore digs head then feet of each column and steps in on the plain profile',async()=>{
 const w=world()
 const r=await bore(w,{count:4})
 assert.equal(r.receipt,'bored');assert.equal(r.columns,4);assert.equal(r.requested,4);assert.deepEqual(r.plugged,[]);assert.equal(r.reason,null);assert.equal(r.slit,null)
 assert.deepEqual(r.from,{x:0,y:64,z:0});assert.deepEqual(r.to,{x:4,y:64,z:0});assert.deepEqual(w.at(),new Vec3(4,64,0))
 assert.deepEqual(w.of('dig'),[1,2,3,4].flatMap(x=>[k(x,65,0),k(x,64,0)]))
 assert.deepEqual(w.of('step'),[1,2,3,4].map(x=>k(x,64,0)))
 // dig:false: no towering, no scaffold, so a step never builds or tunnels on its own.
 for(const m of w.bot.pathfinder.profiles){assert.equal(m.allow1by1towers,false);assert.deepEqual(m.scafoldingBlocks,[])}
 assert.equal(r.drops.netherrack,8)
})
test('a step down opens the third cell the body drops through, a step up the one above the head it jumps from',async()=>{
 const up=world();await executeSkill(up.bot,{kind:'bore',goal:{x:2,y:66,z:0,count:2}},api)
 assert.deepEqual(up.of('dig'),[k(0,66,0),k(1,66,0),k(1,65,0),k(1,67,0),k(2,67,0),k(2,66,0)]);assert.deepEqual(up.at(),new Vec3(2,66,0))
 const fall=world();await executeSkill(fall.bot,{kind:'bore',goal:{x:2,y:62,z:0,count:2}},api)
 assert.deepEqual(fall.of('dig'),[k(1,65,0),k(1,64,0),k(1,63,0),k(2,64,0),k(2,63,0),k(2,62,0)]);assert.deepEqual(fall.at(),new Vec3(2,62,0))
})
test('a cave air pocket beside a head is plugged from the column behind, plain blocks first, and claimed as its own',async()=>{
 const w=world({fills:[[3,65,1,'cave_air']],items:[{name:'iron_pickaxe',count:1,type:registry.itemsByName.iron_pickaxe.id},{name:'oak_planks',count:64},{name:'cobblestone',count:20},{name:'netherrack',count:30}]})
 const r=await bore(w,{count:4})
 assert.equal(r.columns,4);assert.deepEqual(r.plugged,[{x:3,y:65,z:1}])
 const place=w.log.find(e=>e[0]==='place')
 assert.equal(place[1],k(3,65,1));assert.equal(place[2],'netherrack');assert.equal(place[3],k(2,64,0),'placed while standing in column 2')
 assert.ok(w.log.indexOf(place)<w.log.findIndex(e=>e[0]==='step'&&e[1]===k(3,64,0)),'plugged before the step into column 3')
 assert.ok(w.bot.ownBlocks.has(new Vec3(3,65,1),'netherrack','the_nether'))
})
test('air over a head and under the next feet are plugged before the step, so the bot never stands over air',async()=>{
 const w=world({fills:[[3,66,0,'air'],[4,63,0,'air']]})
 const r=await bore(w,{count:5})
 assert.equal(r.columns,5);assert.deepEqual(r.plugged,[{x:3,y:66,z:0},{x:4,y:63,z:0}])
 for(const [,cell,floor] of w.log.filter(e=>e[0]==='step'))assert.ok(['netherrack','cobblestone'].includes(floor),`floor under ${cell} is ${floor}`)
 assert.equal(w.log.find(e=>e[0]==='step'&&e[1]===k(4,64,0))[2],'cobblestone')
})
test('lava beside the next column at feet or head level stops the bore in the column before, digging nothing of it',async()=>{
 for(const lava of [[4,64,1],[4,65,-1]]){
  const w=world({fills:[[...lava,'lava']]})
  const r=await bore(w,{})
  assert.equal(r.columns,3);assert.match(r.reason,new RegExp(`lava at ${lava.join(',')}`));assert.deepEqual(r.stoppedAt,{x:4,y:64,z:0})
  assert.deepEqual(w.at(),new Vec3(3,64,0));assert.ok(!w.of('dig').some(c=>c.startsWith('(4,')));assert.equal(r.slit,null)
 }
})
test('lava over the next head or under the next feet stops the bore the same way',async()=>{
 const over=world({fills:[[4,66,0,'lava']]});const a=await bore(over,{})
 assert.equal(a.columns,3);assert.match(a.reason,/directly supports liquid \(lava\) at 4,66,0/)
 const under=world({fills:[[4,63,0,'lava']]});const b=await bore(under,{})
 assert.equal(b.columns,3);assert.match(b.reason,/lava under it at 4,63,0/);assert.ok(!under.of('dig').some(c=>c.startsWith('(4,')))
})
test('nether bricks, a child\'s planks and a saved footprint ahead stop the bore with nothing dug past and no slit',async()=>{
 for(const name of ['nether_bricks','oak_planks']){
  const w=world({fills:[[4,64,0,name],[4,65,0,name]]});const r=await bore(w,{})
  assert.equal(r.columns,3);assert.match(r.reason,/not natural ground/);assert.equal(r.wall,`${name} at 4,65,0`);assert.equal(r.slit,null)
  assert.ok(!w.of('dig').some(c=>c.startsWith('(4,')));assert.equal(w.cells.get(k(4,64,0)),name)
 }
 const w=world();const r=await bore(w,{protectedSites:[{minX:4,maxX:9,minZ:-3,maxZ:3}]})
 assert.equal(r.columns,3);assert.match(r.reason,/saved project footprint/);assert.equal(r.wall,null)
})
// Lab run 166, 16 October: the bay at -42,59,-8 with its slit at x -41, y 60, z -9 to -7.
test('one column short of open space bore keeps the last wall and opens a three-cell slit in it, centre first',async()=>{
 const w=world({fills:ROOM})
 const r=await bore(w,{})
 assert.equal(r.columns,3);assert.deepEqual(w.at(),new Vec3(3,64,0));assert.deepEqual(r.stoppedAt,{x:4,y:64,z:0})
 assert.deepEqual(r.slit,[{x:4,y:65,z:0},{x:4,y:65,z:-1},{x:4,y:65,z:1}]);assert.deepEqual(w.of('dig').slice(-3),[k(4,65,0),k(4,65,-1),k(4,65,1)])
 assert.deepEqual(r.beyond,{x:5,y:64,z:0,name:'air'});assert.match(r.reason,/open space/)
 assert.equal(w.cells.get(k(4,64,0)),undefined,'the wall column\'s feet cell is still netherrack')
 // The hut there needs the slit centre and the two cells behind (lab run 166's bay, re-closed between shots).
 const site=hutSite(w.bot);assert.equal(site.ok,true,site.reason);assert.equal(site.needed,3)
})
test('the slit skips a side touching lava or fire, and a centre of nether bricks gives no slit',async()=>{
 const lava=world({fills:[...ROOM,[4,65,-2,'lava']]});const a=await bore(lava,{})
 assert.deepEqual(a.slit,[{x:4,y:65,z:0},{x:4,y:65,z:1}])
 const fire=world({fills:[...ROOM,[4,66,1,'fire']]});const b=await bore(fire,{})
 assert.deepEqual(b.slit,[{x:4,y:65,z:0},{x:4,y:65,z:-1}])
 const bricks=world({fills:[...ROOM,[4,65,0,'nether_bricks']]});const c=await bore(bricks,{})
 assert.equal(c.slit,null);assert.equal(c.wall,'nether_bricks at 4,65,0');assert.match(c.reason,/nether_bricks/);assert.equal(c.columns,3)
})
test('hurt at the wall bore waits with no slit, and a second bore from the same cell opens it once healed',async()=>{
 const w=world({fills:ROOM,health:10})
 const r=await bore(w,{})
 assert.equal(r.columns,3);assert.equal(r.slit,null);assert.match(r.reason,/health 10 of 16/);assert.ok(!w.of('dig').some(c=>c.startsWith('(4,')))
 w.bot.health=20
 const again=await bore(w,{})
 assert.equal(again.columns,0);assert.equal(again.slit.length,3);assert.deepEqual(w.at(),new Vec3(3,64,0))
})
test('at the bottom of a shaft bore caps the cell two above its feet before the first column',async()=>{
 const w=world({fills:[[0,66,0,'air'],[0,67,0,'air']]})
 const r=await bore(w,{count:2})
 assert.deepEqual(r.plugged[0],{x:0,y:66,z:0});assert.equal(w.log[0][0],'place');assert.equal(w.log[0][1],k(0,66,0))
})
test('bore refuses without a pickaxe, and stops before the step when the plugs run out',async()=>{
 await assert.rejects(bore(world({items:[{name:'cobblestone',count:32}]}),{}),/Boring needs a pickaxe/)
 await assert.rejects(bore(world({items:[{name:'iron_pickaxe',count:1,type:registry.itemsByName.iron_pickaxe.id},{name:'cobblestone',count:7}]}),{}),/8 blocks/)
 const holes=[2,3].flatMap(x=>[[x,64,1,'air'],[x,64,-1,'air'],[x,65,1,'air'],[x,65,-1,'air'],[x,66,0,'air']])
 const w=world({fills:holes,drops:false,items:[{name:'iron_pickaxe',count:1,type:registry.itemsByName.iron_pickaxe.id},{name:'cobblestone',count:8}]})
 const r=await bore(w,{})
 assert.equal(r.columns,2);assert.match(r.reason,/out of blocks to cover 3,/);assert.deepEqual(w.at(),new Vec3(2,64,0))
})
// The alarm cancels between any two awaits. The skin is closed before the dig, so a cancel after it
// leaves a closed pocket ahead, and the bore issued again from the same cell carries on through it.
test('a cancel after the dig of column 4 leaves the bot in column 3 with column 4 closed, and a second bore goes on',async()=>{
 const w=world({fills:[[4,65,1,'air']]})
 const check=()=>{if(w.of('dig').length>=8)throw new Error('cancelled')}
 await assert.rejects(bore(w,{},{...api,check}),/cancelled/)
 assert.deepEqual(w.at(),new Vec3(3,64,0));assert.equal(w.cells.get(k(4,65,1)),'cobblestone','closed before the dig')
 assert.ok(w.log.findIndex(e=>e[0]==='place')<w.log.findIndex(e=>e[0]==='dig'&&e[1]===k(4,65,0)))
 const r=await bore(w,{count:2});assert.equal(r.columns,2);assert.deepEqual(w.at(),new Vec3(5,64,0))
})
test('a column open onto a cavern stops the bore before it; a pocket closed inside the column does not',async()=>{
 await assert.rejects(bore(world({fills:[[1,65,0,'air'],[1,64,0,'air'],[1,63,0,'lava'],[1,65,1,'air'],[1,64,1,'air'],[1,64,2,'air']]}),{}),/1,6[345],0/)
 const pocket=world({fills:[[2,65,0,'cave_air']]});assert.equal((await bore(pocket,{count:3})).columns,3)
 const w=world({fills:[[3,64,0,'air'],[3,65,0,'air'],[4,64,0,'air']]});const r=await bore(w,{x:6})
 assert.equal(r.columns,1);assert.equal(r.slit.length,3);assert.deepEqual(r.beyond,{x:3,y:64,z:0,name:'air'})
})
// Review of 9d2770d, 16 October: magma, receipts with nothing done, the Overworld, footprints, a raised wall, the clock.
test('a magma floor under the next column stops the bore before it, and magma beside a slit cell keeps that cell shut',async()=>{
 const w=world({fills:[[2,63,0,'magma_block']]});const r=await bore(w,{})
 assert.equal(r.columns,1);assert.match(r.reason,/magma_block under it at 2,63,0/);assert.ok(!w.of('dig').some(c=>c.startsWith('(2,')))
 const s=world({fills:[...ROOM,[4,66,-1,'magma_block']]});const a=await bore(s,{})
 assert.deepEqual(a.slit,[{x:4,y:65,z:0},{x:4,y:65,z:1}])
})
test('plugs alone are no progress: zero columns and no slit fail with the reason and name the plugs',async()=>{
 const w=world({fills:[[0,66,0,'air'],[0,67,0,'air'],[1,64,0,'nether_bricks'],[1,65,0,'nether_bricks']]})
 await assert.rejects(bore(w,{}),/not natural ground.*plugged 0,66,0/)
})
test('bore refuses outside the Nether, and stops rather than build inside a saved footprint',async()=>{
 const over=world();over.bot.game.dimension='overworld'
 await assert.rejects(bore(over,{}),/bore is for the Nether/);assert.deepEqual(over.log,[])
 const w=world({fills:[[2,65,1,'cave_air']]});const r=await bore(w,{protectedSites:[{minX:2,maxX:2,minZ:1,maxZ:1}]})
 assert.equal(r.columns,1);assert.match(r.reason,/2,65,1 is inside a saved project footprint/);assert.equal(w.cells.get(k(2,65,1)),'cave_air')
 assert.ok(!w.log.some(e=>e[0]==='place'))
})
test('a wall one step above the bot gets no slit: the reason says to bore level first',async()=>{
 const room=[];for(let x=4;x<=6;x++)for(let y=65;y<=67;y++)for(let z=-1;z<=1;z++)room.push([x,y,z,'air'])
 const w=world({fills:room});const r=await executeSkill(w.bot,{kind:'bore',goal:{x:6,y:66,z:0,count:6}},api)
 assert.equal(r.columns,2);assert.equal(r.slit,null);assert.match(r.reason,/wall one step up at 3,65,0; bore level first/);assert.deepEqual(w.at(),new Vec3(2,64,0))
})
test('a bore cut short by its time budget says so in the receipt',async()=>{
 const w=world();const r=await bore(w,{},{...api,budgetMs:400})
 assert.ok(r.columns>=1&&r.columns<10,`${r.columns} columns`);assert.equal(r.reason,`timed out after ${r.columns} columns`)
})
// Live canary on the test world, 16 October (4e95192): in a closed portal room against its north
// wall, a bore toward a target 27 blocks off found the open arrival hub behind the wall and cut a
// slit from the safe room into it. The slit is for the firing position at the end of the route only.
test('open space beyond a wall far from the target stops the bore with the wall intact; near the target the slit opens',async()=>{
 const hub=[];for(let x=-2;x<=2;x++)for(let y=64;y<=66;y++)for(let z=-5;z<=-2;z++)hub.push([x,y,z,'air'])
 const far=world({fills:[...hub,...hub.filter(([,y])=>y===64).map(([x,,z])=>[x,63,z,'lava'])]})
 await assert.rejects(executeSkill(far.bot,{kind:'bore',goal:{x:0,y:64,z:-27,count:27}},api),/open space at 0,64,-2 over lava, 26 blocks short of the target; bore around it.*another wall.*re-aim/)
 assert.deepEqual(far.of('dig'),[]);for(const c of [k(0,64,-1),k(0,65,-1),k(-1,65,-1),k(1,65,-1)])assert.equal(far.cells.get(c),undefined,`${c} still netherrack`)
 const later=world({fills:[...ROOM,[5,63,0,'lava']]});const r=await bore(later,{x:20})
 assert.equal(r.columns,3);assert.equal(r.slit,null);assert.match(r.reason,/open space at 5,64,0 over lava, 16 blocks short of the target; bore around it/);assert.equal(later.cells.get(k(4,65,0)),undefined)
 const near=world({fills:hub});const n=await executeSkill(near.bot,{kind:'bore',goal:{x:0,y:64,z:-6,count:6}},api)
 assert.equal(n.columns,0);assert.deepEqual(n.slit,[{x:0,y:65,z:-1},{x:-1,y:65,z:-1},{x:1,y:65,z:-1}])
})
// Mapped on the rehearsal copy, 16 October: a bridge three wide, its floor of bricks at the
// portal's feet minus one, one-high brick walls on both edges, open air above, ending in a void
// over the lava sea. Here: floor y 63 at z -1 to 1, walls y 64 at z -2 and 2, nothing else solid.
const VOID=p=>p.y===31?'lava':'air'
const span=(x0,x1)=>{const out=[];for(let x=x0;x<=x1;x++){for(const z of [-1,0,1])out.push([x,63,z,'nether_bricks']);out.push([x,64,-2,'nether_bricks'],[x,64,2,'nether_bricks'])}return out}
const closedAt=(w,cell)=>[[0,-1,0],[0,0,1],[0,0,-1],[0,1,1],[0,1,-1],[0,2,0]].every(([dx,dy,dz])=>w.bot.blockAt(cell.offset(dx,dy,dz)).boundingBox==='block')
const cobble=(n,more=[])=>[{name:'iron_pickaxe',count:1,type:registry.itemsByName.iron_pickaxe.id},{name:'cobblestone',count:n},...more]
const guard=w=>{const goto=w.bot.pathfinder.goto;w.bot.pathfinder.goto=async g=>{assert.ok(closedAt(w,new Vec3(g.x,g.y,g.z)),`floor, sides and roof of ${g.x},${g.y},${g.z} closed before the step`);return goto.call(w.bot.pathfinder,g)}}
test('along the mapped bridge bore builds walls and a roof in cobblestone before each step, with nothing else to lean on',async()=>{
 const w=world({ground:VOID,fills:span(-3,8),items:cobble(64,[{name:'netherrack',count:100}])});guard(w)
 const r=await bore(w,{x:20,count:6})
 assert.equal(r.columns,6);assert.equal(r.covered,6);assert.equal(r.reason,null);assert.deepEqual(w.at(),new Vec3(6,64,0));assert.equal(w.of('dig').length,0)
 const placed=w.log.filter(e=>e[0]==='place');assert.ok(placed.length>=30);assert.ok(placed.every(e=>e[2]==='cobblestone'),'cobblestone first: ghast fireballs break netherrack')
})
test('off the end of the bridge bore lays a floor first, then walls and roof, across the void',async()=>{
 const w=world({ground:VOID,fills:span(-3,2),items:cobble(128)});guard(w)
 const r=await bore(w,{x:20,count:6})
 assert.equal(r.covered,6);assert.deepEqual(w.at(),new Vec3(6,64,0))
 for(let x=3;x<=6;x++)assert.equal(w.cells.get(k(x,63,0)),'cobblestone',`floor at ${x}`)
 const floor=w.log.findIndex(e=>e[0]==='place'&&e[1]===k(3,63,0)),side=w.log.findIndex(e=>e[0]==='place'&&e[1]===k(3,64,1))
 assert.ok(floor>=0&&floor<side,'the floor goes in before the walls')
})
test('on the bridge, lava beside or under a column, an empty hand or a mob stops before the step and closes the way ahead',async()=>{
 const lava=world({ground:VOID,fills:[...span(-3,8),[3,64,1,'lava']],items:cobble(64)});const a=await bore(lava,{x:20,count:6})
 assert.equal(a.columns,2);assert.match(a.reason,/lava at 3,64,1/);assert.deepEqual(lava.at(),new Vec3(2,64,0))
 assert.equal(lava.cells.get(k(3,64,0)),'cobblestone');assert.equal(lava.cells.get(k(3,65,0)),'cobblestone')
 const under=world({ground:VOID,fills:[...span(-3,8),[3,63,0,'lava']],items:cobble(64)});const b=await bore(under,{x:20,count:6})
 assert.match(b.reason,/over lava/);assert.ok(under.at().x<3)
 const short=world({ground:VOID,fills:span(-3,8),items:cobble(8),drops:false});const c=await bore(short,{x:20,count:6})
 assert.equal(c.columns,1);assert.match(c.reason,/out of blocks to cover 2,/);assert.deepEqual(short.at(),new Vec3(1,64,0))
 const mob=world({ground:VOID,fills:span(-3,8),items:cobble(64)});mob.bot.entities={7:{id:7,name:'zombified_piglin',position:new Vec3(3.5,64,.5)}}
 const d=await bore(mob,{x:20,count:6});assert.equal(d.columns,2);assert.match(d.reason,/zombified_piglin in 3,64,0/)
 // Live, 16 October: a dropped item in the next column stopped the walk. Only living things block.
 const loot=world({ground:VOID,fills:span(-3,8),items:cobble(64)})
 loot.bot.entities={9:{id:9,name:'item',type:'object',position:new Vec3(3.5,64,.5)},10:{id:10,name:'arrow',type:'projectile',position:new Vec3(4.5,64,1.5)},11:{id:11,name:'experience_orb',type:'orb',position:new Vec3(2.5,65,-.5)}}
 const f=await bore(loot,{x:20,count:6});assert.equal(f.covered,6);assert.equal(f.reason,null)
 const player=world({ground:VOID,fills:span(-3,8),items:cobble(64)});player.bot.entities={12:{id:12,name:'player',type:'player',username:'someone',position:new Vec3(3.5,64,.5)}}
 assert.match((await bore(player,{x:20,count:6})).reason,/player in 3,64,0/)
 const wall=world({ground:VOID,fills:span(-3,8),items:cobble(64)});wall.bot.entities={8:{id:8,name:'magma_cube',position:new Vec3(3.5,64,1.5)}}
 const e=await bore(wall,{x:20,count:6});assert.equal(e.columns,2);assert.match(e.reason,/magma_cube in 3,64,1/)
})
// Spec of 16 October: cover runs level or down; a rising path meets a cliff face and digs into it.
test('a bridge that meets a cliff face goes on as a tunnel into the rock',async()=>{
 const w=world({ground:p=>p.x>=4&&p.y<=70?'netherrack':VOID(p),fills:span(-3,3),items:cobble(64)})
 const r=await bore(w,{x:20,count:6})
 assert.equal(r.columns,6);assert.equal(r.covered,3);assert.ok(w.of('dig').includes(k(4,64,0)))
})
const BRIDGE=[];for(let x=1;x<=5;x++){BRIDGE.push([x,63,0,'nether_bricks'],[x,63,1,'lava'],[x,63,-1,'lava'],[x,66,0,'air']);for(const y of [64,65])for(const z of [-1,0,1])BRIDGE.push([x,y,z,'air'])}
test('near the target open ground over a floor still ends the bore at the last wall with the slit',async()=>{
 const w=world({fills:BRIDGE.filter(([x])=>x>=3),items:cobble(64)});const r=await bore(w,{x:6,count:6})
 assert.equal(r.covered,0);assert.equal(r.columns,1);assert.equal(r.slit.length,3)
})
// Live, 16 October: walled in on the bridge in its own cobblestone hut, the bot bored east and the
// next column was half its own wall and half air: neither all air (cover) nor all rock (tunnel),
// so it read as open space. Far from the target such a column is closed first, then dug, then entered.
test('a column half air and half diggable over a floor is closed, dug and entered; half bricks still stops',async()=>{
 const own=world({ground:VOID,fills:[...span(-3,8),[3,64,0,'cobblestone']],items:cobble(64)});own.bot.ownBlocks.add(new Vec3(3,64,0),'cobblestone','the_nether');guard(own)
 const a=await bore(own,{x:20,count:6});assert.equal(a.reason,null);assert.equal(a.columns,6);assert.ok(own.of('dig').includes(k(3,64,0)))
 const rock=world({ground:VOID,fills:[...span(-3,8),[3,65,0,'netherrack']],items:cobble(64)});guard(rock)
 const b=await bore(rock,{x:20,count:6});assert.equal(b.reason,null);assert.equal(b.columns,6);assert.ok(rock.of('dig').includes(k(3,65,0)))
 const bricks=world({ground:VOID,fills:[...span(-3,8),[3,64,0,'nether_bricks']],items:cobble(64)});const c=await bore(bricks,{x:20,count:6})
 assert.ok(c.columns<3);assert.match(c.reason,/open space|not natural ground/);assert.equal(bricks.cells.get(k(3,64,0)),'nether_bricks')
})
