import {test} from 'node:test'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {saveTask,loadTask} from '../src/task-store.js'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {Vec3} from 'vec3'
import {deliverItem} from '../src/delivery.js'
import {validatePlan} from '../src/companion/planner.js'
import {guardIntent} from '../src/companion/intent.js'
import {validateTaskGoal} from '../src/task-store.js'

function fixture(collector=2){
 const bot=new EventEmitter();let carried=3,cancelled=false,tosses=0,persisted=false,lookFlushed=false
 bot._client=new EventEmitter();bot.entity={id:1,position:new Vec3(0,64,0)}
 bot.players={Owner:{entity:{id:2,position:new Vec3(1.4,64,0)}}};bot.entities={99:{}}
 bot.inventory={items:()=>carried?[{name:'stone_pickaxe',type:123,count:carried}]:[]}
 bot.pathfinder={setMovements(){},async goto(){},setGoal(){}}
 bot.lookAt=async()=>{};bot.clearControlStates=()=>{};bot.waitForTicks=async ticks=>{assert.equal(ticks,2);lookFlushed=true}
 const task={goal:{item:'stone_pickaxe',count:1,player:'Owner'}}
 bot.toss=async(type,metadata,count)=>{
  assert.ok(persisted);assert.ok(lookFlushed);assert.equal(type,123);assert.equal(count,1);tosses++;carried-=count
  bot.emit('itemDrop',{id:99,position:bot.entity.position,getDroppedItem:()=>({name:'stone_pickaxe',count:10})})
  bot._client.emit('collect',{collectedEntityId:99,collectorEntityId:2,pickupItemCount:10})
  bot.emit('itemDrop',{id:7,position:bot.entity.position,getDroppedItem:()=>({name:'stone_pickaxe',count})})
  bot._client.emit('collect',{collectedEntityId:7,collectorEntityId:collector,pickupItemCount:count})
  bot._client.emit('collect',{collectedEntityId:7,collectorEntityId:collector,pickupItemCount:count})
 }
 const context={check(){if(cancelled)throw new Error('cancelled')},progress(){},stage(){},movements:{},persist(){persisted=true}}
 return {bot,task,context,cancel(){cancelled=true},get tosses(){return tosses}}
}

test('delivery confirms owner pickup, exact quantity and excludes old entities and duplicate packets',async()=>{
 const f=fixture(),result=await deliverItem(f.bot,f.task,f.context)
 assert.equal(result.receipt,'recipient_pickup');assert.equal(result.count,1)
 assert.deepEqual(result.pickups,[{entityId:7,recipientId:2,count:1}]);assert.equal(f.task.delivery.received,1)
 assert.equal(f.bot.inventory.items()[0].count,2)
 assert.equal(f.bot.listenerCount('itemDrop'),0);assert.equal(f.bot._client.listenerCount('collect'),0)
})
test('another collector is failure and cannot trigger an automatic resend',async()=>{
 const f=fixture(3)
 await assert.rejects(deliverItem(f.bot,f.task,f.context),/Another entity/)
 await assert.rejects(deliverItem(f.bot,f.task,f.context),/already attempted/)
 assert.equal(f.tosses,1);assert.equal(f.task.delivery.received,0)
})
test('stop before toss sends nothing; interruption after toss persists uncertainty and cleans listeners',async()=>{
 const f=fixture();f.bot.lookAt=async()=>f.cancel()
 await assert.rejects(deliverItem(f.bot,f.task,f.context),/cancelled/);assert.equal(f.tosses,0);assert.equal(f.task.delivery,undefined)
 const g=fixture();g.bot.toss=async()=>g.cancel()
 await assert.rejects(deliverItem(g.bot,g.task,g.context),/cancelled/)
 assert.equal(g.task.delivery.attempted,true);assert.equal(g.bot.listenerCount('itemDrop'),0);assert.equal(g.bot._client.listenerCount('collect'),0)
})
test('recipient moving away or another player nearby prevents tossing',async()=>{
 const f=fixture();f.bot.pathfinder.goto=async()=>{f.bot.players.Owner.entity.position=new Vec3(20,64,0)}
 await assert.rejects(deliverItem(f.bot,f.task,f.context),/moved out/);assert.equal(f.tosses,0)
 const g=fixture();g.bot.players.Other={entity:{id:3,position:new Vec3(2,64,0)}}
 await assert.rejects(deliverItem(g.bot,g.task,g.context),/Another player/);assert.equal(g.tosses,0)
})
test('delivery schema bounds quantity and recipient and guards unsolicited transfer',()=>{
 const plan={reply:'On it',steps:[{action:'give',item:'stone_pickaxe',count:1}]}
 assert.equal(validatePlan(plan).steps[0].action,'give')
 assert.throws(()=>validatePlan({reply:'On it',steps:[{...plan.steps[0],count:65}]}))
 assert.throws(()=>validateTaskGoal('give',{item:'stone_pickaxe',count:1,player:'@a'}))
 assert.deepEqual(guardIntent(plan,'build a house',[{role:'user',text:'give me a pickaxe'}]).steps,[])
 assert.equal(guardIntent(plan,'make a stone pickaxe and bring it to me').steps.length,1)
})

test('runner replaces an arbitrary recipient with its configured owner',async()=>{
 const {Runner}=await import('../src/runner.js')
 const runner={owner:'Owner',assertAvailable(){},halt(){},persist(){},log(){},applyGoal(){}}
 Runner.prototype.skill.call(runner,'give',{item:'stone_pickaxe',count:1,player:'SomeoneElse'})
 assert.equal(runner.task.goal.player,'Owner')
})

test('an attempted delivery remains non-replayable after task state reload',async()=>{
 const f=fixture();f.task={...f.task,id:'delivery',kind:'give',status:'running',deadline:Date.now()+30000,delivery:{attempted:true,received:0}}
 const path=join(mkdtempSync(join(tmpdir(),'mc-delivery-')),'task.json')
 saveTask(path,'fixture',f.task)
 const loaded=loadTask(path,'fixture')
 await assert.rejects(deliverItem(f.bot,loaded,f.context),/already attempted/)
 assert.equal(f.tosses,0)
})

test('a cancelled walk to the recipient reports our own stopwatch, not the world',async()=>{
 // Fifteen seconds to reach a player who may be walking away is a clock we set
 // ourselves. Clearing the goal rejects the in-flight goto as GoalChanged, and
 // reported raw that is terminal rather than worth another try.
 const f=fixture()
 f.bot.pathfinder.goto=async()=>{throw Object.assign(new Error('The goal was changed before it could be completed!'),{name:'GoalChanged'})}
 const original=global.setTimeout
 global.setTimeout=fn=>{fn();return {unref(){}}}
 try{
  await assert.rejects(deliverItem(f.bot,f.task,f.context),e=>{
   assert.equal(e.name,'Timeout',`a stalled walk must stay retryable, got ${e.name}: ${e.message}`)
   assert.match(e.message,/deliver|recipient/i)
   return true
  })
  assert.equal(f.tosses,0,'nothing was thrown')
 }finally{global.setTimeout=original}
})
