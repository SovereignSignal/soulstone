// Bounded real sign-in probe. No movement, chat, account copy, or model call.
import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {homedir} from 'node:os'
import mineflayer from 'mineflayer'
import {MinecraftAccounts,linkedAccountAuth} from '../src/companion/minecraft-accounts.js'
import {startVersionBridge} from '../src/companion/version-bridge.js'
const root=join(homedir(),'Library/Application Support/Vibrant Soul')
const setup=JSON.parse(readFileSync(join(root,'setup.json'),'utf8')),store=new MinecraftAccounts(join(root,'accounts'))
const receipt={startedAt:new Date().toISOString(),serverVersion:'26.2',targetPort:Number(process.env.PROBE_PORT||5773),clientVersion:'1.21.4',events:[]}
let bridge,bot,finished=false
const timer=setTimeout(()=>void finish('failed','probe timeout'),60000)
async function finish(status,reason){if(finished)return;finished=true;clearTimeout(timer);bot?.quit();await bridge?.close();receipt.status=status;receipt.reason=reason;writeFileSync('results/lan-26.2-account-probe.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));process.exit(status==='passed'?0:1)}
try {
 bridge=await startVersionBridge({host:'127.0.0.1',port:receipt.targetPort,store,accountId:setup.minecraftAccountId,onEvent:type=>receipt.events.push({type}),onFailure:reason=>void finish('failed',reason)})
 receipt.events.push({type:'helper_ready'})
 bot=mineflayer.createBot({host:bridge.host,port:bridge.port,version:bridge.version,username:setup.minecraftAccountId,auth:linkedAccountAuth(store,setup.minecraftAccountId)})
 bot.once('login',()=>receipt.events.push({type:'login',name:bot.username}))
 bot.once('spawn',()=>{receipt.events.push({type:'spawn',name:bot.username,health:bot.health});setTimeout(()=>void finish('passed','spawned and stayed connected for five seconds'),5000)})
 bot.once('kicked',reason=>void finish('rejected',JSON.stringify(reason)))
 bot.once('error',()=>void finish('failed','Minecraft connection error'))
 bot.once('end',()=>void finish('failed','connection ended'))
}catch(error){await finish('failed',error.message)}
