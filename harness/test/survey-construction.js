import mineflayer from 'mineflayer'
import {once} from 'node:events'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {writeFileSync} from 'node:fs'
import {Vec3} from 'vec3'
const run=promisify(execFile),host=process.env.MC_SSH_HOST
if(!/^[\w.-]+$/.test(host||''))throw new Error('Missing lab SSH host')
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const bot=mineflayer.createBot({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565),username:'HarnessTest',version:'1.21.4',auth:'offline'})
try{
 await once(bot,'spawn');await rcon('tp HarnessTest -600 67 -288');await new Promise(r=>setTimeout(r,2500));await bot.waitForChunksToLoad()
 const terrain=[]
 for(let x=-625;x<=-550;x++)for(let z=-330;z<=-250;z++){
  for(let y=90;y>=60;y--){const b=bot.blockAt(new Vec3(x,y,z));if(b&&b.name!=='air'){terrain.push({x,y,z,name:b.name});break}}
 }
 writeFileSync('results/construction-survey.json',JSON.stringify(terrain))
 const lookup=new Map(terrain.map(b=>[b.x+','+b.z,b])),sites=[]
 for(let x=-622;x<=-565;x++)for(let z=-327;z<=-265;z++){
  const cells=[];for(let dx=0;dx<15;dx++)for(let dz=0;dz<15;dz++)cells.push(lookup.get((x+dx)+','+(z+dz)))
  if(cells.some(b=>!b||b.name==='water'||/planks|chest|furnace|crafting/.test(b.name)))continue
  const lo=Math.min(...cells.map(b=>b.y)),hi=Math.max(...cells.map(b=>b.y))
  sites.push({x,z,lo,hi,roughness:hi-lo,cuts:cells.filter(b=>b.y>lo).length,distance:Math.hypot(x+7+592,z+7+299)})
 }
 sites.sort((a,b)=>a.roughness-b.roughness||a.distance-b.distance);console.log(JSON.stringify(sites.slice(0,12)))
 console.log(await rcon('data get entity SovereignSignal Pos'))
}finally{bot.quit()}
