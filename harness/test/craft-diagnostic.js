import mineflayer from 'mineflayer'
import {execFileSync} from 'node:child_process'
const pause=ms=>new Promise(r=>setTimeout(r,ms))
const rcon=c=>execFileSync('ssh',[process.env.MC_SSH_HOST,"sudo docker exec mc-sandbox rcon-cli '"+c+"'"],{encoding:'utf8',timeout:15000}).trim()
if(process.env.MC_LAB_EXPERIMENT!=='yes')throw new Error('Lab opt-in required')
const bot=mineflayer.createBot({host:process.env.MC_HOST,username:'HarnessTest',version:'1.21.4',auth:'offline'})
const trace=[]
bot._client.on('packet',(p,m)=>{if(['set_slot','window_items','open_window','set_player_inventory'].includes(m.name))trace.push({type:m.name,window:p.windowId,slot:p.slot,state:p.stateId})})
bot.once('spawn',async()=>{try {
 await pause(1000)
 rcon('clear HarnessTest');rcon('tp HarnessTest 3.5 251 8.5');console.log('give',rcon('give HarnessTest minecraft:oak_log 8'));rcon('setblock 5 251 8 minecraft:crafting_table');await pause(700)
 console.log('server inventory',rcon('data get entity HarnessTest Inventory'));
 for(const name of ['oak_planks','oak_planks','oak_planks','stick','crafting_table','wooden_pickaxe']){
  const table=name==='wooden_pickaxe'?bot.blockAt(bot.entity.position.floored().offset(2,0,0)):null
  const recipe=bot.recipesFor(bot.registry.itemsByName[name].id,null,1,table)[0]
  console.log('before',name,bot.inventory.items().map(x=>[x.name,x.count]),!!recipe,table?.name)
  if(!recipe)throw new Error('Missing recipe for '+name)
  await bot.craft(recipe,1,table);await pause(700)
  console.log('after',name,bot.inventory.items().map(x=>[x.name,x.count]),rcon('data get entity HarnessTest Inventory'))
 }
}catch(e){console.log(e.stack);process.exitCode=1}finally{console.log('packets',JSON.stringify(trace));bot.quit();setTimeout(()=>process.exit(process.exitCode||0),500)}})
setTimeout(()=>{console.log('Timeout');bot.quit();process.exit(1)},60000).unref()
