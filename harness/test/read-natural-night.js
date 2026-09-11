import {readFileSync,writeFileSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
const run=promisify(execFile),host=process.env.MC_SSH_HOST
if(!/^[\w.-]+$/.test(host))throw new Error('Invalid host')
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c+"'"],{timeout:15000})).stdout.trim()
const deadline=Date.now()+600000
while(Date.now()<deadline){const a=JSON.parse(readFileSync('state/companion-api.json'));const s=await(await fetch(a.url+'/state',{headers:{Authorization:'Bearer '+a.token}})).json();if(s.survival.difficulty!=='easy')throw new Error('Cycle is no longer on Easy');if(s.survival.timeOfDay>=14000&&s.survival.timeOfDay<=22000){
 const r={at:Date.now(),timeOfDay:s.survival.timeOfDay,position:s.position,spawning:await rcon('gamerule doMobSpawning'),difficulty:await rcon('difficulty'),scope:'Read-only server presence within 64 blocks of HarnessRunner, not proof of aggression or combat',presence:{}}
 for(const name of ['zombie','skeleton','creeper','spider','drowned','phantom'])r.presence[name]=await rcon(`execute at HarnessRunner if entity @e[type=minecraft:${name},distance=..64] run list`)
 writeFileSync(process.argv[2] || 'results/natural-night-presence.json',JSON.stringify(r,null,2));console.log(JSON.stringify(r));break
}await delay(5000)}
