// Read-only verification of the saved live base. Only the diagnostic observer
// is teleported; no live player, inventory or world blocks are changed.
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFileSync,writeFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import mineflayer from 'mineflayer'
import {Vec3} from 'vec3'
import {shelterLayout} from '../src/shelter.js'
import {installLightReader} from '../src/lighting.js'
import {serverChest} from './server-chest.js'
if(process.env.MC_LAB_EXPERIMENT!=='yes')throw new Error('Lab opt-in required')
const run=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms)),ssh=process.env.MC_SSH_HOST
if(!/^[A-Za-z0-9_.-]+$/.test(ssh||''))throw new Error('Missing SSH alias')
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',ssh,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const project=JSON.parse(readFileSync('state/teammate.json')).projects.base
const report={status:'running',project,checks:[]};let observer
try{
 assert.ok(project.verification,'No completed base check')
 const o=project.build.origin,l=shelterLayout(project.build.design),torch=project.stations.torch.position
 const block=(p,name)=>report.checks.push(`if block ${p.x} ${p.y} ${p.z} minecraft:${name}`)
 for(const b of project.build.design)block({x:o.x+b.x,y:o.y+b.y,z:o.z+b.z},b.block==='wood_planks'?project.build.wood.replace('_log','_planks'):b.block)
 for(const p of [...l.inside,...l.approach])for(let y=0;y<2;y++){
  const q={x:o.x+p.x,y:o.y+y,z:o.z+p.z};block(q,JSON.stringify(q)===JSON.stringify(torch)?'torch':'air')
 }
 const door=project.verification.usability.door
 block(door.position,door.name+'[half=lower,open=false]');block({...door.position,y:door.position.y+1},door.name+'[half=upper,open=false]')
 for(const [name,s] of Object.entries(project.stations))block(s.position,name)
 report.serverChecks=[]
 for(let i=0;i<report.checks.length;i+=10){const result=await rcon('execute '+report.checks.slice(i,i+10).join(' ')+' run data get entity HarnessRunner Health');assert.match(result,/Health|entity data/);report.serverChecks.push(result)}
 const chest=project.stations.chest.position
 report.serverChest=await rcon(`data get block ${chest.x} ${chest.y} ${chest.z} Items`)
 const inventory=await serverChest(rcon,chest);report.serverContents=inventory.contents;report.serverInventoryReads=inventory.reads
 assert.deepEqual(report.serverContents,project.stations.chest.contents)
 observer=mineflayer.createBot({host:process.env.MC_HOST,username:'HarnessProbe',version:'1.21.4',auth:'offline'});observer.on('error',()=>{});installLightReader(observer)
 await new Promise((yes,no)=>{const timer=setTimeout(()=>no(new Error('Observer join timeout')),30000);observer.once('spawn',()=>{clearTimeout(timer);yes()})})
 await rcon(`tp HarnessProbe ${o.x+1.5} ${o.y} ${o.z-4.5}`);await observer.waitForChunksToLoad();await pause(1000)
 report.serverLight=project.verification.lighting.map(v=>({...v,measured:observer.getObservedBlockLight(new Vec3(v.position.x,v.position.y,v.position.z))}))
 for(const v of report.serverLight){assert.ok(v.measured!==null&&v.measured>=8,'Unlit or unloaded room cell');assert.ok(v.measured>=v.lowerBound,'Calculated light bound exceeds actual server light')}
 report.position=await rcon('data get entity HarnessRunner Pos');report.status='passed'
}catch(e){report.status='failed';report.error=e.stack;process.exitCode=1}
finally{observer?.quit();writeFileSync('results/live-base-server-verified.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,error:report.error,checks:report.checks.length,contents:report.serverContents,lights:report.serverLight?.map(v=>v.measured)},null,2));setTimeout(()=>process.exit(process.exitCode||0),1000)}
