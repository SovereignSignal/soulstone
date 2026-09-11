import {Runner} from '../src/runner.js'
import {compileArchitecture,architectureMaterials} from '../src/construction.js'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {once} from 'node:events'
import {Vec3} from 'vec3'
import assert from 'node:assert/strict'
if(process.env.MC_LAB_EXPERIMENT!=='yes')throw new Error('Lab opt-in required')
const run=promisify(execFile),host=process.env.MC_SSH_HOST
assert.match(host,/^[\w.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const step=JSON.parse(readFileSync('results/castle-blueprint.json')),bp=compileArchitecture(step.design)
const dir='results/castle-lab-'+Date.now();mkdirSync(dir)
const report={fixture:process.env.MC_VERIFY_ONLY==='yes'?'completed-castle-recheck':'supplied-materials-survival',design:step.design,origin:{x:113,y:251,z:3},batches:[],started:new Date().toISOString()}
const runner=new Runner({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565),version:'1.21.4',username:'HarnessTest',owner:'HarnessWitness',statePath:dir+'/task.json'})
let lastLog=0
runner.on('event',e=>{if(e.type==='skill_progress'&&Date.now()-lastLog>10000){console.log(e.message);lastLog=Date.now()}})
try{
 const spawned=new Promise(r=>runner.on('event',e=>{if(e.type==='spawn')r()}));runner.start();await spawned
 if(process.env.MC_VERIFY_ONLY!=='yes'){
 await rcon('forceload add 108 0 130 18')
 await rcon('fill 108 250 0 130 250 18 minecraft:smooth_stone')
 await rcon('fill 108 251 0 130 268 18 minecraft:air')
 await rcon('clear HarnessTest');await rcon('gamemode survival HarnessTest');await rcon('tp HarnessTest 119.5 251 1.5')
 const kit=bp.blocks.reduce((m,b)=>(m[b.block]=(m[b.block]||0)+1,m),{})
 for(const [name,count] of Object.entries(kit))console.log(await rcon(`give HarnessTest minecraft:${name} ${count}`))
 }
 await new Promise(r=>setTimeout(r,2000));await runner.bot.waitForChunksToLoad()
 for(let batch=0;batch<24;batch++){
  const done=new Promise(resolve=>{const h=e=>{if(e.type==='task_finished'){runner.off('event',h);resolve(e.task)}};runner.on('event',h)})
  runner.command({action:'construct',goal:{name:'castle',design:step.design,near:report.origin,origin:report.origin},timeoutMs:600000})
  const task=await done;report.batches.push(task);writeFileSync(dir+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({batch,status:task.status,reason:task.reason,result:task.result,progress:task.progress}))
  assert.equal(task.status,'completed',task.reason)
  if(!task.result.partial)break
 }
 assert.equal(report.batches.at(-1).result.partial,false)
 report.blockChecks=[]
 for(let i=0;i<bp.blocks.length;i+=16){const batch=bp.blocks.slice(i,i+16),cmd='execute '+batch.map(b=>`if block ${report.origin.x+b.x} ${report.origin.y+b.y} ${report.origin.z+b.z} minecraft:${b.block}`).join(' ')+' run list';const response=await rcon(cmd);assert.match(response,/players online/);report.blockChecks.push({count:batch.length,response})}
 report.finalPosition=await rcon('data get entity HarnessTest Pos');report.status='passed';console.log('PASS '+dir)
}catch(error){report.status='failed';report.error=error.message;console.error('FAIL '+error.message);process.exitCode=1}
finally{report.finished=new Date().toISOString();writeFileSync(dir+'/report.json',JSON.stringify(report,null,2));runner.close()}
