import test from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import blockLoader from 'prismarine-block'
import {Vec3} from 'vec3'
import {pourSites,makeObsidian,validateObsidianGoal} from '../src/obsidian.js'
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
 await assert.rejects(makeObsidian(f.bot,task(4),f.ctx),/No obsidian made: no open lava source/)
})

test('a pool too small for the total returns what it got as partial, with the reason',async()=>{
 const f=fixture()
 const r=await makeObsidian(f.bot,task(20),f.ctx)
 assert.equal(r.partial,true);assert.equal(r.count,9);assert.match(r.stoppedBecause,/no open lava source/)
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

test('flowing water counts as an open face, and a lake sealed by one block names the block to open',async()=>{
 // Live, 2026-09-24: the lake beside the VM bot had been sealed again by the
 // time make_obsidian ran; the only thing between the tunnel and the water was
 // one block of deepslate.
 const {fillableWaterSource,sealedWaterSource}=await import('../src/obsidian.js')
 const lake=()=>{const extra={}
  for(let y=60;y<=63;y++)for(let x=3;x<=8;x++)for(let z=-3;z<=3;z++)extra[`${x},${y},${z}`]='water'
  for(let x=3;x<=8;x++)for(let z=-3;z<=3;z++)extra[`${x},64,${z}`]='stone'
  return extra}
 const flowing=lake();flowing['2,62,0']='flowing_water';flowing['1,62,0']='air';flowing['1,63,0']='air'
 assert.deepEqual([fillableWaterSource(fixture({pool:false,extra:flowing}).bot)?.x],[3],'a bucket reaches a source through flowing water')
 const sealed=lake();sealed['1,62,0']='air';sealed['1,63,0']='air'   // tunnel ends one block short of the lake
 const {bot}=fixture({pool:false,extra:sealed})
 assert.equal(fillableWaterSource(bot),null)
 const found=sealedWaterSource(bot)
 assert.ok(found,'the sealed lake is found')
 assert.deepEqual([found.wall.x,found.wall.z,found.source.x],[2,0,3],'the one stone block between tunnel and water')
 assert.deepEqual([found.stand.x,found.stand.y,found.stand.z],[1,62,0],'opened from a standing cell level with the wall, never from below it')
 const hanging=lake();hanging['1,63,0']='air';hanging['1,64,0']='air'   // air beyond the wall but no floor at the water's level
 hanging['1,62,0']='air';hanging['1,61,0']='air'
 const low=sealedWaterSource(fixture({pool:false,extra:hanging}).bot)
 assert.ok(!low||low.stand.y>=low.wall.y,'a stance below the wall would be flooded when it opens')
 assert.equal(sealedWaterSource(fixture({pool:false}).bot),null)
})

test('a level source is tried before a nearer one high overhead',async()=>{
 // Live, 2026-09-24: the fill chose water nine blocks up through deepslate and
 // the path search gave up; a climb costs far more than its straight line.
 const {fillableWaterSources}=await import('../src/obsidian.js')
 const {bot}=fixture({pool:false,extra:{'-5,72,1':'water','3,64,1':'water'}})
 const order=fillableWaterSources(bot).map(p=>`${p.x},${p.y},${p.z}`)
 assert.deepEqual(order,['3,64,1','-5,72,1'])
})
