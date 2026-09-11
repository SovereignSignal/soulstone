import mineflayer from 'mineflayer'
import {once} from 'node:events'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {writeFileSync,readFileSync} from 'node:fs'
import {Vec3} from 'vec3'
import assert from 'node:assert/strict'
import {compileArchitecture} from '../src/construction.js'
assert.equal(process.env.MC_LAB_EXPERIMENT,'yes')
const run=promisify(execFile),host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const bp=compileArchitecture(JSON.parse(readFileSync('results/visible-guesthouse-blueprint.json')).design)
const bot=mineflayer.createBot({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565),username:'HarnessWitness',version:'1.21.4',auth:'offline'})
const report={origin:{x:-594,y:67,z:-310},scope:'Only a natural-ground pad and supplied kit; guesthouse blocks will be placed by the live survival companion',commands:[],before:[]}
try{
 await once(bot,'spawn');await rcon('tp HarnessWitness -596 69 -300');await new Promise(r=>setTimeout(r,1500));await bot.waitForChunksToLoad()
 for(const name of ['SovereignSignal','HarnessRunner']){const p=bot.players[name]?.entity?.position;assert.ok(p);assert.ok(p.x< -594.4||p.x> -585.6||p.z< -310.4||p.z> -301.6,'Player occupies pad')}
 const natural=new Set(['air','sand','sandstone','grass_block','dirt','gravel','stone'])
 for(let x=-594;x<=-586;x++)for(let z=-310;z<=-302;z++)for(let y=63;y<=71;y++){
  const b=bot.blockAt(new Vec3(x,y,z));assert.ok(b);assert.ok(y<=66?natural.has(b.name):b.name==='air',`Unexpected ${b.name} at ${x},${y},${z}`);report.before.push({x,y,z,block:b.name})
 }
 // Raising only this surveyed natural patch avoids cutting terrain or touching nearby saved structures.
 for(const name of natural){const c=`fill -594 63 -310 -586 66 -302 minecraft:stone_bricks replace minecraft:${name}`;report.commands.push({command:c,response:await rcon(c)})}
 const kit=bp.blocks.reduce((m,b)=>(m[b.block]=(m[b.block]||0)+1,m),{})
 for(const [name,count] of Object.entries(kit)){const c=`give HarnessRunner minecraft:${name} ${count}`;report.commands.push({command:c,response:await rcon(c)})}
 report.kit=kit;report.status='prepared';console.log(JSON.stringify({origin:report.origin,kit,status:report.status}))
}finally{writeFileSync('results/visible-guesthouse-setup.json',JSON.stringify(report,null,2));bot.quit()}
