import mineflayer from 'mineflayer'
import {once} from 'node:events'
import {readFileSync,writeFileSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import assert from 'node:assert/strict'
import {alternativeShelters,inspectConstructionShelter} from '../src/alternate-shelter.js'
const host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const run=promisify(execFile),rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c+"'"],{timeout:15000})).stdout.trim()
const a=JSON.parse(readFileSync('state/companion-api.json')),s=await(await fetch(a.url+'/state',{headers:{Authorization:'Bearer '+a.token}})).json()
assert.ok(s.connected&&s.phase==='ready');assert.match(await rcon('difficulty'),/Peaceful/)
const bot=mineflayer.createBot({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565),username:'HarnessWitness',version:'1.21.4',auth:'offline'})
bot.on('error',e=>console.error(e.message))
try{
 await once(bot,'spawn');await rcon('gamemode spectator HarnessWitness');await rcon(`tp HarnessWitness ${s.position.x} ${s.position.y+5} ${s.position.z}`);await bot.waitForChunksToLoad()
 const report=alternativeShelters(bot,s.projects).map(shelter=>{try{const r=inspectConstructionShelter(bot,shelter);return {name:shelter.name,valid:true,inside:r.inside,outside:r.outside,door:r.door.position,interiorCells:r.cells.length,minLight:Math.min(...r.lighting.map(c=>c.lowerBound))}}catch(e){return {name:shelter.name,valid:false,reason:e.message}}})
 writeFileSync('results/fallback-sites-live.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report))
 assert.ok(report.some(r=>r.valid),'No usable fallback')
}finally{bot.quit()}
