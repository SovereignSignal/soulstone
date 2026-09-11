import {Runner} from '../src/runner.js'
import {readFileSync,writeFileSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import assert from 'node:assert/strict'
const a=JSON.parse(readFileSync('state/companion-api.json')),s=await(await fetch(a.url+'/state',{headers:{Authorization:'Bearer '+a.token}})).json()
const host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const run=promisify(execFile),rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c+"'"],{timeout:15000})).stdout
const runner=new Runner({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565),username:'HarnessWitness',statePath:'state/navigation-witness.json'})
const report={status:'running',goal:s.places.camp,events:[]};runner.on('event',e=>{if(e.type==='task_finished'||e.type==='task_started')report.events.push(e)})
try{
 runner.start();let deadline=Date.now()+20000;while(!runner.ready&&Date.now()<deadline)await delay(100);assert.ok(runner.ready)
 await rcon('gamemode spectator HarnessWitness');await rcon('tp HarnessWitness -586.4359390537678 67 -307.5');await runner.bot.waitForChunksToLoad();await delay(1000)
 runner.bot.on('path_update',r=>report.events.push({type:'path_update',status:r.status,path:r.path.map(p=>({x:p.x,y:p.y,z:p.z}))}));const start=Date.now();runner.navigate(s.places.camp,30000)
 deadline=Date.now()+32000;while(runner.task.status==='running'&&Date.now()<deadline)await delay(50)
 report.elapsedMs=Date.now()-start;report.task=runner.task;assert.equal(runner.task.status,'failed');assert.match(runner.task.reason,/No walking route|Walking route search/);assert.ok(report.elapsedMs<25000,'Waited for deadline instead of reporting exhausted path search');report.status='passed'
}catch(e){report.status='failed';report.error=e.message;process.exitCode=1}
finally{runner.close();writeFileSync('results/navigation-failure-live.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,error:report.error,elapsedMs:report.elapsedMs,reason:report.task?.reason}))}
