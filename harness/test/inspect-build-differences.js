import mineflayer from 'mineflayer'
import {once} from 'node:events'
import {readFileSync,writeFileSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {Vec3} from 'vec3'
import {compileArchitecture} from '../src/construction.js'
const run=promisify(execFile),before=JSON.parse(readFileSync('results/day-night-before.json')),b=mineflayer.createBot({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565),username:'HarnessWitness',version:'1.21.4',auth:'offline'})
try{await once(b,'spawn',{signal:AbortSignal.timeout(20000)});for(const command of ['gamemode spectator HarnessWitness','tp HarnessWitness -585 75 -307'])await run('ssh',['-o','BatchMode=yes',process.env.MC_SSH_HOST,`sudo docker exec mc-sandbox rcon-cli '${command}'`]);await b.waitForChunksToLoad();const differences=[];let checked=0
for(const [name,p]of Object.entries(before.projects))if(p.construction)for(const c of compileArchitecture(p.construction.design).cells){const q=new Vec3(c.x+p.construction.origin.x,c.y+p.construction.origin.y,c.z+p.construction.origin.z),actual=b.blockAt(q);checked++;if(actual?.name!==c.block||Object.entries(c.properties||{}).some(([k,v])=>String(actual.getProperties()[k])!==String(v)))differences.push({project:name,position:q,expected:c.block,expectedProperties:c.properties,actual:actual?.name,actualProperties:actual?.getProperties()})}
const report={checked,differences};writeFileSync('results/day-night-build-differences.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report))
}finally{b.quit()}
