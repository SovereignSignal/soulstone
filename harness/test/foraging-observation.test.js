import test from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {berryObservation,harvestBerries} from '../src/foraging.js'

test('food observations distinguish unknown terrain, observed absence and unripe sources',()=>{
 assert.equal(berryObservation(null).status,'unknown')
 const bot={registry:{blocksByName:{sweet_berry_bush:{id:7}}},findBlocks:()=>[],blockAt:()=>null}
 assert.equal(berryObservation(bot).status,'observed');assert.equal(berryObservation(bot).ripeCount,0)
 const ages=['0','1','2','3',undefined,'invalid'],positions=ages.map((_,x)=>new Vec3(x,64,0))
 bot.findBlocks=options=>{assert.deepEqual(options,{matching:7,maxDistance:48,count:64});return positions}
 bot.blockAt=p=>({name:'sweet_berry_bush',getProperties:()=>({age:ages[p.x]})})
 const result=berryObservation(bot)
 assert.equal(result.ripeCount,2);assert.deepEqual(result.bushes.map(b=>b.age),[0,1,2,3,null,null]);assert.equal(result.bushes[4].ripe,null)
 assert.match(result.scope,/access.*unverified/)
})
test('the bounded food scan reports unloaded blocks and truncation without claiming ripeness',()=>{
 const positions=Array.from({length:65},(_,x)=>new Vec3(x,64,0));let reads=0
 const bot={registry:{blocksByName:{sweet_berry_bush:{id:7}}},findBlocks:()=>positions,blockAt:p=>{reads++;return p.x===0?null:{name:'sweet_berry_bush',getProperties:()=>({age:1})}}}
 const o=berryObservation(bot);assert.equal(reads,64);assert.equal(o.truncated,true);assert.equal(o.unknownBlocks,1);assert.equal(o.ripeCount,0)
})
test('a bush that loses its ripe state during approach is never activated',async()=>{
 const p=new Vec3(0,64,0);let age=3,activated=0
 const bot={registry:{blocksByName:{sweet_berry_bush:{id:7}}},entity:{position:new Vec3(2,64,0)},inventory:{items:()=>[]},findBlocks:()=>[p],blockAt:()=>({name:'sweet_berry_bush',getProperties:()=>({age})}),activateBlock:async()=>activated++}
 await assert.rejects(harvestBerries(bot,{goal:{item:'sweet_berries',count:3}},{check(){},walk:async()=>{age=undefined},progress(){},persist(){}}),/No more ripe/)
 assert.equal(activated,0)
})
test('harvest records confirmed crop change before waiting for pickup, and keeps an interrupted activation uncertain',async()=>{
 for(const stopAt of ['activation_pending','crop_confirmed']){
  const p=new Vec3(0,64,0);let age=3,stop=false;const saved=[]
  const task={goal:{item:'sweet_berries',count:3}}
  const bot={registry:{blocksByName:{sweet_berry_bush:{id:7}}},entity:{position:new Vec3(2,64,0)},inventory:{items:()=>[]},findBlocks:()=>[p],entities:{},blockAt:()=>({name:'sweet_berry_bush',getProperties:()=>({age})}),unequip:async()=>{},activateBlock:async()=>{if(stopAt==='activation_pending'){stop=true;return}age=1},waitForTicks:async()=>{stop=true}}
  await assert.rejects(harvestBerries(bot,task,{check(){if(stop)throw Error('Stopped')},walk:async()=>{},progress(){},stage(){},settle:async fn=>assert.ok(fn()),persist(){saved.push(structuredClone(task.harvestAttempt))}}),/Stopped/)
  assert.equal(task.harvestAttempt.status,stopAt);assert.equal(saved.at(-1).status,stopAt);assert.deepEqual(task.harvested,[])
 }
})
test('inventory gain during approach cannot become a confirmed harvest receipt',async()=>{
 const p=new Vec3(0,64,0);let stock=0,stop=false;const task={goal:{item:'sweet_berries',count:3}}
 const bot={registry:{blocksByName:{sweet_berry_bush:{id:7}}},entity:{position:new Vec3(2,64,0)},inventory:{items:()=>stock?[{name:'sweet_berries',count:stock}]:[]},findBlocks:()=>[p],blockAt:()=>({name:'sweet_berry_bush',getProperties:()=>({age:3})})}
 await assert.rejects(harvestBerries(bot,task,{check(){if(stop)throw Error('Stopped')},walk:async()=>{stock=2;stop=true},progress(){},persist(){}}),/Stopped/)
 assert.equal(task.harvestAttempt.status,'approaching');assert.deepEqual(task.harvested,[])
})
test('already collected berries do not require another pickup landing cell',async()=>{
 const p=new Vec3(0,64,0);let age=3,stock=0;const task={goal:{item:'sweet_berries',count:3}}
 const bot={registry:{blocksByName:{sweet_berry_bush:{id:7}}},entity:{position:new Vec3(2,64,0)},inventory:{items:()=>stock?[{name:'sweet_berries',count:stock}]:[]},findBlocks:()=>[p],entities:{},blockAt:q=>q.equals(p)?{name:'sweet_berry_bush',getProperties:()=>({age})}:{name:'short_grass',boundingBox:'empty'},unequip:async()=>{},activateBlock:async()=>{age=1},waitForTicks:async()=>{stock=3}}
 const result=await harvestBerries(bot,task,{check(){},walk:async()=>{},progress(){},stage(){},persist(){},settle:async fn=>assert.ok(fn())})
 assert.equal(result.count,3);assert.equal(task.harvestAttempt.status,'pickup_confirmed');assert.equal(task.harvested[0].gained,3)
})

test('the berry harvest empties the hand before activating the bush',async()=>{
 // One of the five shared activate sites. The `use` action will turn the empty
 // hand from an invariant into an explicit variant, so pin the current contract
 // first: a held item here would eat, place or throw instead of picking berries.
 const p=new Vec3(0,64,0);let age=3,stock=0;const calls=[]
 const task={goal:{item:'sweet_berries',count:3}}
 const bot={registry:{blocksByName:{sweet_berry_bush:{id:7}}},entity:{position:new Vec3(2,64,0)},inventory:{items:()=>stock?[{name:'sweet_berries',count:stock}]:[]},findBlocks:()=>[p],entities:{},blockAt:q=>q.equals(p)?{name:'sweet_berry_bush',getProperties:()=>({age})}:{name:'short_grass',boundingBox:'empty'},
  unequip:async slot=>{calls.push('unequip:'+slot)},activateBlock:async()=>{calls.push('activateBlock');age=1},waitForTicks:async()=>{stock=3}}
 await harvestBerries(bot,task,{check(){},walk:async()=>{},progress(){},stage(){},persist(){},settle:async fn=>assert.ok(fn())})
 assert.deepEqual(calls,['unequip:hand','activateBlock'],'the hand is emptied exactly once, immediately before the activation')
})

// Trial 9, 23 September: two harvests of about eight minutes each ended
// "Bounded harvesting limit reached" while carrying berries. Each unreachable
// bush cost a fifteen-second walk plus a thirty-second terrain watch, and a
// harvest that got some reported getting none.
function bushField({ reachable = true } = {}) {
 const near=new Vec3(0,64,0),far=Array.from({length:20},(_,i)=>new Vec3(10+i,64,3)),ages=new Map([[near.toString(),3],...far.map(p=>[p.toString(),3])])
 let stock=0;const walks=[]
 const bot={registry:{blocksByName:{sweet_berry_bush:{id:7}}},entity:{position:new Vec3(2,64,0)},inventory:{items:()=>stock?[{name:'sweet_berries',count:stock}]:[]},
  findBlocks:()=>[near,...far],entities:{},
  blockAt:q=>ages.has(q.toString())?{name:'sweet_berry_bush',getProperties:()=>({age:ages.get(q.toString())})}:{name:'short_grass',boundingBox:'empty'},
  unequip:async()=>{},activateBlock:async b=>{ages.set(near.toString(),1)},waitForTicks:async()=>{stock=2}}
 const walk=async(goal,recover)=>{walks.push(recover);if(!(reachable&&goal.x===0))throw Object.assign(new Error('Walking attempt timed out'),{name:'Timeout'})}
 return {bot,walks,ctx:{check(){},walk,progress(){},stage(){},persist(){},settle:async fn=>assert.ok(fn())}}
}
test('a harvest that got some berries before its bound says partial, not failed',async()=>{
 const {bot,walks,ctx}=bushField(),task={goal:{item:'sweet_berries',count:6}}
 const result=await harvestBerries(bot,task,ctx)
 assert.equal(result.count,2);assert.equal(result.requested,6);assert.equal(result.partial,true)
 assert.match(result.stoppedBecause,/unreachable/)
 assert.ok(walks.length>1&&walks.every(r=>r===false),'a bush approach does not wait out a terrain watch: '+JSON.stringify(walks))
})
test('a harvest that got nothing still fails',async()=>{
 const {bot,ctx}=bushField({reachable:false})
 await assert.rejects(harvestBerries(bot,{goal:{item:'sweet_berries',count:6}},ctx),/Bounded harvesting limit reached|No more ripe/)
})
