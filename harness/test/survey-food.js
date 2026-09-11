import mineflayer from 'mineflayer'
import {once} from 'node:events'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFileSync,writeFileSync} from 'node:fs'
import {terrainSummary} from '../src/observations.js'
const run=promisify(execFile),host=process.env.MC_SSH_HOST
if(!/^[\w.-]+$/.test(host||''))throw new Error('Missing lab SSH host')
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const a=JSON.parse(readFileSync('state/companion-api.json')),state=await(await fetch(a.url+'/state',{headers:{Authorization:'Bearer '+a.token}})).json()
const bot=mineflayer.createBot({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565),username:'HarnessWitness',version:'1.21.4',auth:'offline'})
try{
 await once(bot,'spawn');await rcon(`tp HarnessWitness ${state.position.x} ${state.position.y+3} ${state.position.z}`);await new Promise(r=>setTimeout(r,2000));await bot.waitForChunksToLoad()
 const food=[];for(const name of ['sweet_berry_bush','wheat','carrots','potatoes','melon','pumpkin']){const id=bot.registry.blocksByName[name]?.id;if(id===undefined)continue;for(const p of bot.findBlocks({matching:id,maxDistance:64,count:24}))food.push({name,position:p,properties:bot.blockAt(p).getProperties()})}
 writeFileSync('results/food-survey.json',JSON.stringify({food,position:state.position},null,2));console.log(JSON.stringify(food))
 console.log(await rcon('difficulty'))
}finally{bot.quit()}
