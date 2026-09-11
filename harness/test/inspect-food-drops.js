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
 const entities=Object.values(bot.entities).filter(e=>e.name==='item'||e.name==='fox').map(e=>({name:e.name,position:e.position,item:e.getDroppedItem?.()?.name}));console.log(JSON.stringify(entities));
 console.log(await rcon('difficulty'))
}finally{bot.quit()}
