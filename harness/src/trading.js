// Villager trading, asked for by the first child to play with the bot ("trade with these
// villagers", 14 October 2026, with 64 emeralds in the bot's hands). Nearest villager or
// wandering trader, its trade list, the trade that gives the asked item (or the first the
// bot can afford), a bounded number of times.
import {walkNear} from './primitives.js'
export const TRADE_RADIUS=32,TRADE_REACH=3,TRADE_MAX=16
const TRADERS=new Set(['villager','wandering_trader'])
export function validateTradeGoal(g){
 const item=String(g?.item||''),count=Number.isInteger(g?.count)?g.count:1
 if(item&&!/^[a-z0-9_]{1,64}$/.test(item))throw new Error('Trade item must be a Minecraft item id or empty')
 if(count<1||count>TRADE_MAX)throw new Error(`Trade count is 1 to ${TRADE_MAX}`)
 return {item,count}
}
const carried=(bot,name)=>(bot.inventory?.items?.()||[]).filter(i=>i.name===name).reduce((n,i)=>n+i.count,0)
const describe=t=>`${t.outputItem?.count||1} ${t.outputItem?.name||'?'} for ${[t.inputItem1,t.hasItem2?t.inputItem2:null].filter(x=>x&&x.name).map(x=>`${x.count} ${x.name}`).join(' and ')}`
export async function tradeWithVillager(bot,task,{check,stage,progress}){
 const {item,count}=validateTradeGoal(task.goal),here=bot.entity.position
 const trader=Object.values(bot.entities||{}).filter(e=>e&&TRADERS.has(e.name)&&e.position&&e.position.distanceTo(here)<=TRADE_RADIUS).sort((a,b)=>a.position.distanceTo(here)-b.position.distanceTo(here))[0]
 if(!trader)throw new Error(`No villager or wandering trader within ${TRADE_RADIUS} blocks`)
 if(trader.position.distanceTo(bot.entity.position)>TRADE_REACH){stage('walking');progress(`Walking to the ${trader.name.replaceAll('_',' ')}`);await walkNear(bot,trader.position.floored(),{dig:false,check,stage,progress,timeoutMs:60000,range:2});check()}
 stage('trading');progress(`Opening trades with the ${trader.name.replaceAll('_',' ')}`)
 const villager=await bot.openVillager(trader);check()
 try{
  const trades=(villager.trades||[]).map((t,i)=>({i,t}))
  if(!trades.length)throw new Error('The villager has no trades')
  const left=({t})=>Number.isFinite(t.maximumNbTradeUses)?t.maximumNbTradeUses-(t.nbTradeUses||0):TRADE_MAX
  const affordable=({t})=>carried(bot,t.inputItem1?.name)>=(t.realPrice||t.inputItem1?.count||0)&&(!t.hasItem2||carried(bot,t.inputItem2.name)>=t.inputItem2.count)
  const offers=trades.map(({t})=>describe(t)).join('; ')
  const wanted=trades.filter(x=>!x.t.tradeDisabled&&left(x)>0&&(!item||x.t.outputItem?.name===item))
  if(!wanted.length)throw new Error(item?`The ${trader.name.replaceAll('_',' ')} does not sell ${item}. It offers: ${offers}`:`The ${trader.name.replaceAll('_',' ')} has nothing to trade right now. It offers: ${offers}`)
  const choice=wanted.find(affordable)
  if(!choice)throw new Error(`I cannot afford ${item?`its ${item}`:'any of its trades'}: it offers ${wanted.map(x=>describe(x.t)).join('; ')}`)
  const price=choice.t.realPrice||choice.t.inputItem1?.count||1
  const times=Math.max(1,Math.min(count,left(choice),Math.floor(carried(bot,choice.t.inputItem1.name)/price),choice.t.hasItem2?Math.floor(carried(bot,choice.t.inputItem2.name)/choice.t.inputItem2.count):TRADE_MAX))
  const before=carried(bot,choice.t.outputItem.name)
  progress(`Buying ${describe(choice.t)}, ${times} time${times===1?'':'s'}`)
  await bot.trade(villager,choice.i,times);check()
  const got=carried(bot,choice.t.outputItem.name)-before
  return {item:choice.t.outputItem.name,count:got,times,price:describe(choice.t),trader:trader.name,offers,receipt:got>0?'traded':'trade_unconfirmed'}
 }finally{try{villager.close?.()}catch{}}
}
