import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {homedir} from 'node:os'
import mineflayer from 'mineflayer'
import pathfinding from 'mineflayer-pathfinder'
import collection from 'mineflayer-collectblock'
import {MinecraftAccounts,linkedAccountAuth} from '../src/companion/minecraft-accounts.js'
import {startVersionBridge} from '../src/companion/version-bridge.js'
import {craftWithWindowState} from '../src/crafting.js'
const root=join(homedir(),'Library/Application Support/Vibrant Soul'),setup=JSON.parse(readFileSync(join(root,'setup.json'),'utf8')),store=new MinecraftAccounts(join(root,'accounts'))
const trace=[],receipt={startedAt:new Date().toISOString(),trace};let bridge,bot,done=false
const pause=ms=>new Promise(r=>setTimeout(r,ms))
async function finish(status,error){if(done)return;done=true;receipt.status=status;receipt.error=error;bot?.quit();await bridge?.close();writeFileSync('results/bridge-craft-diagnostic.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));process.exit(status==='passed'?0:1)}
setTimeout(()=>void finish('failed','timeout'),120000).unref()
try{
 bridge=await startVersionBridge({host:setup.host,port:setup.port,store,accountId:setup.minecraftAccountId})
 bot=mineflayer.createBot({host:bridge.host,port:bridge.port,version:bridge.version,username:setup.minecraftAccountId,auth:linkedAccountAuth(store,setup.minecraftAccountId)})
 bot.soulstoneInventoryResync=true
 bot.loadPlugin(pathfinding.pathfinder);bot.loadPlugin(collection.plugin)
 const write=bot._client.write
 bot._client.write=function(name,p,...rest){if(name==='window_click')trace.push({type:name,slot:p.slot,stateId:p.stateId});return write.call(this,name,p,...rest)}
 bot._client.on('packet',(p,m)=>{if(['set_slot','window_items','set_player_inventory'].includes(m.name))trace.push({type:m.name,slot:p.slot,windowId:p.windowId,stateId:p.stateId})})
 bot.once('spawn',async()=>{try{
  await pause(1500);receipt.initial=bot.inventory.items().map(i=>({name:i.name,count:i.count}))
  if(!bot.inventory.items().some(i=>i.name==='oak_log')){
   receipt.resupply=[]
   const candidates=bot.findBlocks({matching:bot.registry.blocksByName.oak_log.id,maxDistance:16,count:8})
   for(const pos of candidates){try{await bot.collectBlock.collect(bot.blockAt(pos),{count:1});receipt.resupply.push({position:pos,status:'collected'});break}catch(e){receipt.resupply.push({position:pos,status:e.message})}}
  }
  receipt.before=bot.inventory.items().map(i=>({name:i.name,count:i.count}))
  const recipe=bot.recipesFor(bot.registry.itemsByName.oak_planks.id,null,1,null)[0]
  if(!recipe)throw new Error('No carried log available for crafting')
  await craftWithWindowState(bot,recipe,1,null);await pause(600)
  receipt.after=bot.inventory.items().map(i=>({name:i.name,count:i.count}))
  if(receipt.after.reduce((n,i)=>n+(i.name==='oak_planks'?i.count:0),0)!==4)throw new Error('Expected four planks')
  await finish('passed')
 }catch(e){await finish('failed',e.message)}})
 bot.on('kicked',reason=>void finish('failed',JSON.stringify(reason)));bot.on('error',()=>void finish('failed','connection error'))
}catch(e){await finish('failed',e.message)}
