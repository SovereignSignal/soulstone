import test from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import blockLoader from 'prismarine-block'
import {Vec3} from 'vec3'
import {pourSites,makeObsidian,validateObsidianGoal,sealedOpenings} from '../src/obsidian.js'
import {lavaBeside} from '../src/navigation.js'
const registry=minecraftData('1.21.4'),Block=blockLoader(registry)
const key=p=>`${p.x},${p.y},${p.z}`

// Stone to y=63, air above, and a 3x3 lava pool of sources set into the ground
// at y=63, x and z 0..2. The fake server does what the real one does with a
// bucket: a pour on a rim's top face puts a source on it, every lava source
// within seven cells under the spread becomes obsidian, and taking the source
// back drains the spread.
function fixture({items=['diamond_pickaxe','water_bucket'],pool=true,extra={}}={}){
 const world=new Map()
 if(pool)for(let x=0;x<=2;x++)for(let z=0;z<=2;z++)world.set(`${x},63,${z}`,'lava')
 for(const [k,v] of Object.entries(extra))world.set(k,v)
 const name=p=>world.get(key(p))??(p.y<64?'stone':'air')
 const state=n=>n==='flowing_water'?registry.blocksByName.water.minStateId+1:registry.blocksByName[n].minStateId
 const inventory=items.map((n,i)=>({name:n,count:1,slot:36+i}))
 const log=[]
 let look=null
 const bot={registry,entity:{position:new Vec3(-5.5,64,1.5)},heldItem:null,inventory:{items:()=>inventory},
  blockAt(p){const f=p.floored(),b=Block.fromStateId(state(name(f)),0);b.position=f;return b},
  findBlocks({point,matching,maxDistance}){const at=(point||bot.entity.position).floored(),out=[]
   for(const [k,v] of world){const [x,y,z]=k.split(',').map(Number),p=new Vec3(x,y,z),id=registry.blocksByName[v==='flowing_water'?'water':v].id
    if([matching].flat().includes(id)&&p.distanceTo(at)<=maxDistance)out.push(p)}
   return out},
  async equip(item){bot.heldItem=item;log.push('equip '+item.name)},
  async lookAt(p){look=p},async waitForTicks(){},deactivateItem(){},
  activateItem(){
   log.push('use '+bot.heldItem.name)
   if(bot.heldItem.name==='water_bucket'){
    const cell=new Vec3(Math.floor(look.x),Math.round(look.y),Math.floor(look.z))
    if(name(cell)!=='air')return
    world.set(key(cell),'water');bot.heldItem.name='bucket'
    for(const [k,v] of [...world])if(v==='lava'){const [x,y,z]=k.split(',').map(Number)
     if(y===cell.y-1&&Math.abs(x-cell.x)+Math.abs(z-cell.z)<=7){world.set(k,'obsidian');world.set(`${x},${y+1},${z}`,'flowing_water')}}
   }else if(bot.heldItem.name==='bucket'){
    const cell=look.floored()
    if(name(cell)!=='water')return
    world.set(key(cell),'air');bot.heldItem.name='water_bucket'
    for(const [k,v] of [...world])if(v==='flowing_water')world.delete(k)
   }
  }}
 const count=n=>inventory.filter(i=>i.name===n).reduce((s,i)=>s+i.count,0)
 const ctx={check(){},progress(m){log.push('say '+m)},stage(){},persist(){},count,
  async walk(goal){log.push('walk '+key(goal));bot.entity.position=new Vec3(goal.x+.5,goal.y,goal.z+.5)},
  async settle(predicate,message){for(let i=0;i<5;i++)if(predicate())return;throw new Error(message)},
  async fill(){log.push('fill');inventory.find(i=>i.name==='bucket').name='water_bucket'},
  // mineExposed's contract: mine safe obsidian until the total, else throw.
  async mine(n,total){
   for(const [k,v] of [...world]){if(count(n)>=total)break;if(v!==n)continue
    const [x,y,z]=k.split(',').map(Number),around=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].map(([a,b,c])=>name(new Vec3(x+a,y+b,z+c)))
    if(around.some(a=>['lava','water','flowing_water'].includes(a)))continue
    world.set(k,'air');const have=inventory.find(i=>i.name===n);if(have)have.count++;else inventory.push({name:n,count:1});log.push('mine '+k)}
   if(count(n)<total)throw new Error(`No reachable ${n} observed within 32 blocks`)
  }}
 return {bot,ctx,world,log,count}
}
const task=count=>({kind:'make_obsidian',goal:validateObsidianGoal({count})})

test('a pour site stands two cells out from the lava, on the far side of a solid rim',()=>{
 const {bot}=fixture()
 const sites=pourSites(bot)
 assert.ok(sites.length>0)
 for(const s of sites){
  assert.equal(bot.blockAt(s.rim).name,'stone');assert.equal(bot.blockAt(s.water).name,'air')
  assert.equal(lavaBeside(bot,s.stand),null,'never a standing cell beside lava')
  assert.equal(Math.abs(s.stand.x-s.lava.x)+Math.abs(s.stand.z-s.lava.z),2)
 }
 assert.deepEqual(sites[0].stand,new Vec3(-2,64,1),'nearest first')
 const {bot:guarded}=fixture({extra:{'-3,64,1':'lava'}})
 assert.ok(!pourSites(guarded).some(s=>key(s.stand)==='-2,64,1'),'a standing cell with lava beside it is refused')
})

test('it pours from the standing cell, converts the pool, takes the water back and mines to the total',async()=>{
 const f=fixture()
 const r=await makeObsidian(f.bot,task(5),f.ctx)
 assert.equal(r.receipt,'obsidian_carried');assert.equal(r.count,5);assert.equal(r.pours,1);assert.equal(r.converted,9)
 assert.ok(f.log.indexOf('walk -2,64,1')<f.log.indexOf('use water_bucket'),'it reaches the lava-free cell before pouring')
 assert.equal(f.count('water_bucket'),1,'the bucket is full again for the next fire')
 assert.ok(![...f.world.values()].some(v=>/water/.test(v)),'no water is left running over the pool')
})

test('without a diamond pickaxe it refuses before touching any water',async()=>{
 const f=fixture({items:['iron_pickaxe','water_bucket']})
 await assert.rejects(makeObsidian(f.bot,task(4),f.ctx),/diamond or netherite pickaxe/)
 assert.ok(!f.log.some(l=>l.startsWith('use')))
})

test('an empty bucket is filled before the pour',async()=>{
 const f=fixture({items:['diamond_pickaxe','bucket']})
 await makeObsidian(f.bot,task(3),f.ctx)
 assert.ok(f.log.indexOf('fill')<f.log.indexOf('use water_bucket'))
})

test('no open lava is a failure that says so, never a success',async()=>{
 const f=fixture({pool:false})
 await assert.rejects(makeObsidian(f.bot,task(4),f.ctx),/No obsidian made: no pour site within 64 blocks: saw 0 lava sources/)
})

test('a pool too small for the total returns what it got as partial, with the reason',async()=>{
 const f=fixture()
 const r=await makeObsidian(f.bot,task(20),f.ctx)
 assert.equal(r.partial,true);assert.equal(r.count,9);assert.match(r.stoppedBecause,/no pour site within 64 blocks/)
})

test('the goal is a bounded total',()=>{
 assert.throws(()=>validateObsidianGoal({count:0}),/1–64/);assert.throws(()=>validateObsidianGoal({count:65}),/1–64/)
 assert.deepEqual(validateObsidianGoal({count:10,protectedSites:[]}),{count:10})
})

test('the planner can ask for it, and the executor accepts the task',async()=>{
 const {validatePlan}=await import('../src/companion/planner.js'),{validateTaskGoal}=await import('../src/task-store.js')
 const step=over=>({action:'make_obsidian',name:'',count:10,item:'',design:[],target:null,...over})
 assert.deepEqual(validatePlan({reply:'Turning the pool to obsidian.',steps:[step()]}).steps[0],{action:'make_obsidian',name:'',count:10})
 assert.throws(()=>validatePlan({reply:'x',steps:[step({count:0})]}),/1–64/)
 assert.throws(()=>validatePlan({reply:'x',steps:[step({item:'obsidian'})]}),/empty name and item/)
 assert.deepEqual(validateTaskGoal('make_obsidian',{count:10}),{count:10})
})

test('a bucket fills from a lake open only at the side, as cave water usually is',async()=>{
 // Live, 2026-09-24: the only water near the VM bot was an underground lake,
 // sources stacked from y=-4 to y=2 behind a tunnel wall. The fill search
 // wanted air above a source, found none, and make_obsidian failed at once.
 const {fillableWaterSource}=await import('../src/obsidian.js')
 // A lake sunk in stone under a stone ceiling; a tunnel opens its x=2 wall.
 const extra={}
 for(let y=60;y<=63;y++)for(let x=3;x<=8;x++)for(let z=-3;z<=3;z++)extra[`${x},${y},${z}`]='water'
 for(let x=3;x<=8;x++)for(let z=-3;z<=3;z++)extra[`${x},64,${z}`]='stone'
 extra['2,62,0']='air';extra['2,63,0']='air'
 const {bot}=fixture({pool:false,extra})
 const source=fillableWaterSource(bot)
 assert.ok(source,'the side-open source is found')
 assert.deepEqual([source.x,source.z],[3,0],'the one facing the tunnel')
 const {bot:dry}=fixture({pool:false});assert.equal(fillableWaterSource(dry),null)
})

test('flowing water counts as an open face; a lake sealed by rock is not a source',async()=>{
 // Live, 2026-09-24: opening a sealed lake flooded the bot's tunnel twice, the
 // second time from a level stance, and cost trial 23 ten minutes of surfacing.
 // Sealed water is left sealed; a bucket fills only where it can already reach.
 const {fillableWaterSource}=await import('../src/obsidian.js')
 const lake=()=>{const extra={}
  for(let y=60;y<=63;y++)for(let x=3;x<=8;x++)for(let z=-3;z<=3;z++)extra[`${x},${y},${z}`]='water'
  for(let x=3;x<=8;x++)for(let z=-3;z<=3;z++)extra[`${x},64,${z}`]='stone'
  return extra}
 const flowing=lake();flowing['2,62,0']='flowing_water';flowing['1,62,0']='air';flowing['1,63,0']='air'
 assert.deepEqual([fillableWaterSource(fixture({pool:false,extra:flowing}).bot)?.x],[3],'a bucket reaches a source through flowing water')
 const sealed=lake();sealed['1,62,0']='air';sealed['1,63,0']='air'
 assert.equal(fillableWaterSource(fixture({pool:false,extra:sealed}).bot),null)
 const mod=await import('../src/obsidian.js');assert.equal(mod.sealedWaterSource,undefined,'no code path opens a lake')
})

test('a failed site search says what it saw and which rule turned each source away',async()=>{
 // Trial 23: six make_obsidian calls failed "no open lava source with a solid
 // rim and a lava-free standing cell", which could not say whether there was no
 // lava at all or a rule rejected what was there.
 const {surveyPourSites}=await import('../src/obsidian.js')
 const none=surveyPourSites(fixture({pool:false}).bot)
 assert.equal(none.sites.length,0);assert.equal(none.report.sources,0)
 const covered=fixture({extra:Object.fromEntries([0,1,2].flatMap(x=>[0,1,2].map(z=>[`${x},64,${z}`,'stone'])))})
 const r=surveyPourSites(covered.bot).report
 assert.equal(r.sources,9);assert.equal(r.open,0,'a pool with rock over it is not open to the air')
 const ok=surveyPourSites(fixture().bot)
 assert.ok(ok.sites.length>0);assert.ok(ok.report.open===9&&ok.report.rims>0&&ok.report.stands>0)
})

test('a level source is tried before a nearer one high overhead',async()=>{
 // Live, 2026-09-24: the fill chose water nine blocks up through deepslate and
 // the path search gave up; a climb costs far more than its straight line.
 const {fillableWaterSources}=await import('../src/obsidian.js')
 const {bot}=fixture({pool:false,extra:{'-5,72,1':'water','3,64,1':'water'}})
 const order=fillableWaterSources(bot).map(p=>`${p.x},${p.y},${p.z}`)
 assert.deepEqual(order,['3,64,1','-5,72,1'])
})

test('a failed survey names the nearest lava it saw, so the next move has a direction',async()=>{
 // Trial 25: six calls in a row "saw 1 lava source, 0 open to the air" while
 // the bot moved a few blocks between them; nothing said where that lava was.
 const {surveyPourSites,describeSurvey}=await import('../src/obsidian.js')
 const covered=fixture({extra:Object.fromEntries([0,1,2].flatMap(x=>[0,1,2].map(z=>[`${x},64,${z}`,'stone'])))})
 const r=surveyPourSites(covered.bot).report
 assert.ok(r.nearest,'the nearest source is recorded')
 assert.match(describeSurvey(r),/nearest at 0,63,[012]/)
})

test('a rim whose straight-out cell is blocked still pours from another dry cell in reach',async()=>{
 // Trial 26 at the deep lava level: "11 rims with air above, 0 with a standing
 // cell two out", every time. Cave floors rarely put a standing cell exactly two
 // straight out from the lava.
 const {surveyPourSites}=await import('../src/obsidian.js')
 const extra={}
 for(let z=-1;z<=3;z++){extra[`-2,64,${z}`]='stone';extra[`-2,65,${z}`]='stone'}   // a wall where every west stance would be
 const {bot}=fixture({extra})
 const {sites}=surveyPourSites(bot)
 const west=sites.filter(s=>s.rim.x===-1)
 assert.ok(west.length>0,'the west rims are still usable')
 for(const s of west){
  assert.notEqual(s.stand.x,-2,'not in the wall');assert.equal(lavaBeside(bot,s.stand),null)
  assert.equal(lavaBeside(bot,s.stand.offset(0,-1,0)),null,'not on the rim: its floor has no lava beside it')
  assert.ok(s.stand.offset(.5,1.62,.5).distanceTo(s.rim.offset(.5,1,.5))<=4.5,'within reach of the rim top')
 }
 const {sites:open}=surveyPourSites(fixture().bot)
 assert.deepEqual(open[0].stand,new Vec3(-2,64,1),'the straight-out stance is still preferred where it exists')
})

test('with no open lava in view it searches six legs in growing rings, then says how far it looked',async()=>{
 const f=fixture({pool:false}),legs=[]
 const r=makeObsidian(f.bot,task(4),{...f.ctx,travel:async to=>{legs.push([to.x,to.z])}})
 await assert.rejects(r,/no pour site within 64 blocks.*after 6 search legs/)
 const x=Math.floor(f.bot.entity.position.x),z=Math.floor(f.bot.entity.position.z)
 assert.deepEqual(legs,[[x,z-48],[x+48,z],[x,z+48],[x-48,z],[x,z-96],[x+96,z]])
})

test('lava sealed in rock is opened by digging one block above a dry rim, then poured and mined',async()=>{
 // Test world, 3 October run 41: nine lava sources within 96 blocks, every
 // one sealed in stone, and no pour site anywhere.
 const extra={};for(let x=0;x<=2;x++)for(let z=0;z<=2;z++)extra[`${x},50,${z}`]='lava'
 const f=fixture({pool:false,extra});f.bot.dig=async b=>{f.world.set(key(b.position),'air');f.log.push('dig '+key(b.position))}
 const sites=sealedOpenings(f.bot);assert.ok(sites.length>0)
 const first=sites[0];assert.equal(first.water.y,51);assert.equal(first.stand.y,51);assert.equal(first.rim.y,50)
 // The tunnelling walk: it clears the standing cell and its head room on arrival.
 const approach=async p=>{f.world.set(key(p),'air');f.world.set(key(p.offset(0,1,0)),'air');f.log.push('tunnel '+key(p));f.bot.entity.position=new Vec3(p.x+.5,p.y,p.z+.5)}
 const r=await makeObsidian(f.bot,task(5),{...f.ctx,approach})
 assert.equal(r.receipt,'obsidian_carried');assert.ok(f.count('obsidian')>=5)
 const digs=f.log.filter(l=>/^dig /.test(l))
 assert.equal(digs[0],'dig '+key(first.water),'the block over the rim first');assert.equal(digs[1],'dig '+key(first.lid),'then the lid over that lava')
 assert.ok(digs.every(l=>l.endsWith(`,51,${l.split(',')[2]}`)||/,51,/.test(l)),'only ever the layer above the lava: '+digs.join(' '))
 assert.ok(!digs.some(l=>/,50,/.test(l)),'never a block at the lava\'s own level')
})
// Family run 3, 5 October: from y 13, three route searches to the standing
// cell at y 44 timed out; the staircase refused any target above.
test('a standing cell above the bot is climbed to by the staircase, not a route search',async()=>{
 const extra={};for(let x=0;x<=2;x++)for(let z=0;z<=2;z++)extra[`${x},50,${z}`]='lava'
 const f=fixture({pool:false,extra});f.bot.dig=async b=>{f.world.set(key(b.position),'air')}
 f.bot.entity.position=new Vec3(-5.5,40,1.5)
 const used=[],move=kind=>async p=>{used.push(kind);f.world.set(key(p),'air');f.world.set(key(p.offset(0,1,0)),'air');f.bot.entity.position=new Vec3(p.x+.5,p.y,p.z+.5)}
 await makeObsidian(f.bot,task(1),{...f.ctx,approach:move('approach'),staircase:move('staircase')}).catch(()=>{})
 assert.equal(used[0],'staircase',used.join(' '))
})
test('a sealed pocket is refused when liquid touches the block to dig, or the floor of the standing cell',()=>{
 const extra={'0,50,1':'lava','0,52,1':'lava'} // lava over the lid: opening the lid would let it in
 const f=fixture({pool:false,extra})
 assert.ok(!sealedOpenings(f.bot).some(s=>s.lava.y===50),'no opening for the source whose lid touches other lava')
 const g=fixture({pool:false,extra:{'0,50,1':'lava','-2,49,1':'water'}})
 assert.ok(!sealedOpenings(g.bot).some(s=>s.stand.x===-2&&s.stand.z===1),'no standing cell over a floor that touches water')
})
