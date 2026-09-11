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
 const near=state.ownerPosition||state.position,terrain=terrainSummary(bot,{near,projects:state.projects})
 writeFileSync('results/storehouse-natural-survey.json',JSON.stringify(terrain,null,2));console.log(JSON.stringify(terrain))
 console.log(await rcon('difficulty'))
}finally{bot.quit()}
