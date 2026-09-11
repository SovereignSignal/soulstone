import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import assert from 'node:assert/strict'
import {Runner} from '../src/runner.js'
import {shelterLayout} from '../src/shelter.js'
if(process.env.MC_LAB_EXPERIMENT!=='yes')throw new Error('Lab opt-in required')
const live=process.env.MC_REPAIR_LIVE==='yes',run=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms))
const ssh=process.env.MC_SSH_HOST;if(!/^[A-Za-z0-9_.-]+$/.test(ssh||''))throw new Error('Missing SSH alias')
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',ssh,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const dir=resolve(`results/shelter-${live?'live-repair':'lab'}-${Date.now()}`);mkdirSync(dir,{recursive:true})
const original=JSON.parse(readFileSync('state/companion.json')).task
assert.equal(original.kind,'build');assert.ok(original.goal.origin)
const goal={...structuredClone(original.goal),purpose:'shelter'}
if(!live){goal.origin={x:26,y:251,z:8};goal.near={x:30,y:251,z:8};goal.wood='oak_log'}
const report={status:'running',scope:live?'Repair existing natural-terrain house with evaluator':'Repair seeded shell and blocked approach; supplied fixture materials',goal,events:[]};let runner
try{
 runner=new Runner({host:process.env.MC_HOST,username:'HarnessTest',version:'1.21.4',owner:process.env.MC_OWNER,statePath:dir+'/bot.json'})
 runner.on('event',e=>{report.events.push(structuredClone(e));if(['skill_progress','task_finished'].includes(e.type))console.log(JSON.stringify(e.type==='skill_progress'?{message:e.message}:{status:e.task.status,reason:e.task.reason}))});runner.start()
 for(let i=0;i<60&&!runner.ready;i++)await pause(500);assert.ok(runner.ready)
 const o=goal.origin
 if(!live&&process.env.MC_REUSE_SHELTER!=='yes'){
  await rcon('fill 18 250 0 40 250 16 minecraft:smooth_stone');await rcon('fill 18 251 0 40 256 16 minecraft:air');await rcon('clear HarnessTest')
  for(const cmd of ['fill 26 251 8 29 253 11 minecraft:oak_planks','fill 27 251 9 28 252 10 minecraft:air','fill 27 251 8 27 252 8 minecraft:air'])await rcon(cmd)
  await rcon('fill 26 251 6 28 251 7 minecraft:sand')
  await rcon('give HarnessTest minecraft:oak_log 4')
 }
 await rcon(`tp HarnessTest ${o.x+1.5} ${o.y} ${o.z-4.5}`);await pause(800)
 const start=Date.now();runner.command({action:'build',goal,timeoutMs:240000})
 while(runner.task.status==='running')await pause(500)
 report.elapsedMs=Date.now()-start;report.task=structuredClone(runner.task);assert.equal(runner.task.status,'completed',runner.task.reason)
 const result=runner.task.result.usability;assert.equal(result.status,'usable');assert.equal(result.interiorCells,4);assert.ok(result.visits.some(v=>v.label==='exited through door'))
 report.serverChecks=[]
 async function verify(c){report.serverChecks.push(c.replace(/^execute /,''))}
 for(const b of goal.design)await verify(`execute if block ${o.x+b.x} ${o.y+b.y} ${o.z+b.z} minecraft:${b.block==='wood_planks'?goal.wood.replace('_log','_planks'):b.block}`)
 const l=shelterLayout(goal.design)
 for(const p of [...l.inside,...l.approach])for(let y=0;y<2;y++)await verify(`execute if block ${o.x+p.x} ${o.y+y} ${o.z+p.z} minecraft:air`)
 const d=result.door.position;await verify(`execute if block ${d.x} ${d.y} ${d.z} minecraft:${result.door.name}[half=lower,open=false]`);await verify(`execute if block ${d.x} ${d.y+1} ${d.z} minecraft:${result.door.name}[half=upper,open=false]`)
 report.serverVerification=[];for(let i=0;i<report.serverChecks.length;i+=10){const result=await rcon('execute '+report.serverChecks.slice(i,i+10).join(' ')+' run data get entity HarnessTest Health');assert.match(result,/Health|entity data/);report.serverVerification.push(result)}
 report.finalServerPosition=await rcon('data get entity HarnessTest Pos');report.status='passed'
}catch(e){report.status='failed';report.error=e.stack;process.exitCode=1;const o=goal.origin,l=shelterLayout(goal.design);report.diagnostics={position:runner?.position(),door:[0,1].map(y=>{const p=runner.bot.entity.position.clone().set(o.x+l.door.x,o.y+y,o.z+l.door.z),b=runner.bot.blockAt(p),m=runner.movements.getBlock(p,0,0,0);return {name:b.name,props:b.getProperties(),shapes:b.shapes,safe:m.safe,physical:m.physical,height:m.height}})};console.log(JSON.stringify(report.diagnostics))}
finally{runner?.close();writeFileSync(dir+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({path:dir+'/report.json',status:report.status,error:report.error,elapsedMs:report.elapsedMs,usability:report.task?.result?.usability},null,2));setTimeout(()=>process.exit(process.exitCode||0),1000)}
