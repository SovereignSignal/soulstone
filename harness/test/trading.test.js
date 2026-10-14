import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {tradeWithVillager,validateTradeGoal} from '../src/trading.js'
import {validatePlan} from '../src/companion/planner.js'
// "trade with these villagers" (the creative world, 14 October 2026), with 64 emeralds in
// the bot's hands and no way to spend them.
function fixture({emeralds=64,trades=null}={}){
 const inv=new Map([['emerald',emeralds]]),traded=[]
 const t=(name,count,costName,costCount,extra={})=>({inputItem1:{name:costName,count:costCount},hasItem2:false,outputItem:{name,count},realPrice:costCount,maximumNbTradeUses:12,nbTradeUses:0,...extra})
 const villager={trades:trades||[t('bread',6,'emerald',1),t('diamond_axe',1,'emerald',9),t('enchanted_book',1,'emerald',40,{tradeDisabled:true})],closed:0,close(){this.closed++}}
 const bot={entity:{position:new Vec3(0.5,64,0.5)},entities:{7:{id:7,name:'villager',position:new Vec3(2.5,64,0.5)},8:{id:8,name:'cow',position:new Vec3(1.5,64,0.5)}},
  inventory:{items:()=>[...inv].filter(([,c])=>c>0).map(([name,count])=>({name,count}))},
  async openVillager(e){assert.equal(e.id,7);return villager},
  async trade(v,index,times){const tr=v.trades[index];traded.push([index,times]);inv.set(tr.inputItem1.name,inv.get(tr.inputItem1.name)-tr.realPrice*times);inv.set(tr.outputItem.name,(inv.get(tr.outputItem.name)||0)+tr.outputItem.count*times);tr.nbTradeUses+=times}}
 return {bot,villager,traded,inv,api:{check(){},stage(){},progress(){}}}
}
test('buys the asked item from the nearest villager as many times as asked, afforded and allowed',async()=>{
 const f=fixture();const r=await tradeWithVillager(f.bot,{kind:'trade',goal:{item:'bread',count:3}},f.api)
 assert.deepEqual(f.traded,[[0,3]]);assert.equal(r.item,'bread');assert.equal(r.count,18);assert.equal(r.receipt,'traded');assert.equal(f.villager.closed,1)
 const axe=fixture({emeralds:20});const a=await tradeWithVillager(axe.bot,{kind:'trade',goal:{item:'diamond_axe',count:5}},axe.api)
 assert.deepEqual(axe.traded,[[1,2]],'twenty emeralds buy two axes at nine');assert.equal(a.count,2)
})
test('with no item asked it takes the first affordable trade; a disabled or unaffordable trade is refused with the offers listed',async()=>{
 const f=fixture({emeralds:5});const r=await tradeWithVillager(f.bot,{kind:'trade',goal:{item:'',count:1}},f.api)
 assert.equal(r.item,'bread');assert.deepEqual(f.traded,[[0,1]])
 const poor=fixture({emeralds:2});await assert.rejects(tradeWithVillager(poor.bot,{kind:'trade',goal:{item:'diamond_axe',count:1}},poor.api),/cannot afford its diamond_axe: it offers 1 diamond_axe for 9 emerald/)
 const off=fixture();await assert.rejects(tradeWithVillager(off.bot,{kind:'trade',goal:{item:'enchanted_book',count:1}},off.api),/does not sell enchanted_book/)
 assert.equal(off.villager.closed,1,'closed even when refused')
 const none=fixture();none.bot.entities={};await assert.rejects(tradeWithVillager(none.bot,{kind:'trade',goal:{item:'',count:1}},none.api),/No villager or wandering trader within 32/)
})
test('the goal and the planner step are validated',()=>{
 assert.throws(()=>validateTradeGoal({item:'Bread!',count:1}),/item id/);assert.throws(()=>validateTradeGoal({item:'',count:17}),/1 to 16/)
 assert.deepEqual(validateTradeGoal({item:'bread'}),{item:'bread',count:1})
 assert.equal(validatePlan({reply:'Shopping!',steps:[{action:'trade',name:'',item:'bread',count:2,design:[],target:null}]}).steps[0].action,'trade')
 assert.throws(()=>validatePlan({reply:'',steps:[{action:'trade',name:'x',item:'',count:1,design:[],target:null}]}),/Trade needs/)
})
