import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import assert from 'node:assert/strict'
import mineflayer from 'mineflayer'
import {Runner} from '../src/runner.js'
import {Teammate} from '../src/companion/controller.js'
import {LocalPlanner} from '../src/companion/planner.js'
import {ModelProfiles} from '../src/companion/providers.js'
import {EpisodeRecorder} from '../src/companion/episodes.js'
import {installLightReader} from '../src/lighting.js'
import {Vec3} from 'vec3'
import {serverChest} from './server-chest.js'
if(process.env.MC_LAB_EXPERIMENT!=='yes')throw new Error('Disposable lab opt-in required')
const run=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms)),ssh=process.env.MC_SSH_HOST
if(!/^[A-Za-z0-9_.-]+$/.test(ssh||''))throw new Error('Missing lab SSH alias')
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',ssh,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const dir=resolve('results/base-lab-'+Date.now());mkdirSync(dir,{recursive:true})
const old=JSON.parse(readFileSync('state/companion.json')).task
const saved=JSON.parse(readFileSync('state/teammate.json'))
const build=structuredClone(saved.projects?.base?.build||old.goal)
build.origin={x:26,y:251,z:8};build.near={x:30,y:251,z:12};build.wood='oak_log';build.purpose='shelter'
const profiles=new ModelProfiles(resolve('state/models.json')),profile=profiles.profiles.find(p=>p.kind==='codex'&&p.model==='gpt-6-astra');assert.ok(profile)
let runner,witness,controller,deadline;const report={status:'running',scope:'Astra base upgrade of seeded shelter with supplied raw materials; separate interruption and storage checks',events:[]}
async function start(){
 runner=new Runner({host:process.env.MC_HOST,username:'HarnessTest',version:'1.21.4',owner:'HarnessWitness',statePath:dir+'/bot.json'})
 runner.on('event',e=>{report.events.push(structuredClone(e));if(e.type==='skill_progress')console.log(e.message);if(e.type==='task_finished'&&e.task)console.log(e.task.kind+': '+e.task.status+' '+e.task.reason)})
 runner.start();for(let i=0;i<60&&!runner.ready;i++)await pause(500);assert.ok(runner.ready)
 const planner=new LocalPlanner();planner.profiles={current:profile,key:''}
 controller=new Teammate(runner,planner,dir+'/conversation.json',new EpisodeRecorder(dir+'/episodes'))
}
async function skill(action,item,count){runner.command({action,goal:{item,count,project:structuredClone(controller.projects.base)},timeoutMs:240000});while(runner.task.status==='running')await pause(200);assert.equal(runner.task.status,'completed',runner.task.reason);return structuredClone(runner.task.result)}
try{
 await rcon('fill 18 250 0 40 250 16 minecraft:smooth_stone');await rcon('fill 18 251 0 40 256 16 minecraft:air')
 await rcon('fill 26 251 8 29 253 11 minecraft:oak_planks');await rcon('fill 27 251 9 28 252 10 minecraft:air');await rcon('fill 27 251 8 27 252 8 minecraft:air')
 await rcon('setblock 27 251 8 minecraft:oak_door[facing=south,half=lower,open=false]');await rcon('setblock 27 252 8 minecraft:oak_door[facing=south,half=upper,open=false]')
 await rcon('whitelist add HarnessWitness')
 witness=mineflayer.createBot({host:process.env.MC_HOST,username:'HarnessWitness',version:'1.21.4',auth:'offline'});witness.on('error',()=>{})
 await new Promise((yes,no)=>{const t=setTimeout(()=>no(new Error('Witness timeout')),30000);witness.once('spawn',()=>{clearTimeout(t);yes()})})
 await rcon('tp HarnessWitness 32.5 251 12.5');await start();controller.projects.base={build,stations:{}};controller.persist()
 await rcon('clear HarnessTest');await rcon('tp HarnessTest 27.5 251 4.5');await rcon('give HarnessTest minecraft:oak_log 16');await rcon('give HarnessTest minecraft:cobblestone 16');await pause(500)
 report.request='Make this saved shelter a useful base. Add lighting, a crafting table, furnace and chest. Keep the interior and entrance clear, use workstations beside the house, and put spare building materials in the chest. Verify the completed base.'
 const started=Date.now();deadline=setTimeout(()=>controller.stop(),420000);await controller.submit(report.request);clearTimeout(deadline)
 report.elapsedMs=Date.now()-started;report.messages=controller.messages;report.project=structuredClone(controller.projects.base)
 assert.equal(controller.phase,'ready');assert.ok(report.project.verification,'No completed base verification');assert.ok(Object.values(report.project.stations.chest.contents).some(c=>c>0),'Nothing deposited')
 report.serverChecks=[]
 for(const [name,s] of Object.entries(report.project.stations)){
  const p=s.position,c=`execute if block ${p.x} ${p.y} ${p.z} minecraft:${name} run data get entity HarnessTest Health`,result=await rcon(c);assert.match(result,/Health|entity data/);report.serverChecks.push({command:c,result})
 }
 const chest=report.project.stations.chest.position,at=`${chest.x} ${chest.y} ${chest.z}`
 report.serverChest=await rcon(`data get block ${at} Items`)
 report.serverChestBefore=await serverChest(rcon,chest);assert.deepEqual(report.serverChestBefore.contents,report.project.stations.chest.contents)
 // A fresh observer receives current raw lighting, independent of the builder's
 // conservative calculation and stale post-placement client light caches.
 witness.quit();await pause(1200)
 witness=mineflayer.createBot({host:process.env.MC_HOST,username:'HarnessWitness',version:'1.21.4',auth:'offline'});witness.on('error',()=>{});installLightReader(witness)
 await new Promise((yes,no)=>{const t=setTimeout(()=>no(new Error('Light observer timeout')),30000);witness.once('spawn',()=>{clearTimeout(t);yes()})});await witness.waitForChunksToLoad();await pause(500)
 report.serverLight=report.project.verification.lighting.map(v=>({...v,measured:witness.getObservedBlockLight(new Vec3(v.position.x,v.position.y,v.position.z))}))
 for(const v of report.serverLight){assert.ok(v.measured!==null&&v.measured>=8,'Server room light below 8 or unknown');assert.ok(v.measured>=v.lowerBound,'Lighting bound exceeded server value')}
 const [stored,count]=Object.entries(report.project.stations.chest.contents).find(([,n])=>n>=2)||[];assert.ok(stored,'Need two stored items for roundtrip test')
 const initial=runner.bot.inventory.items().filter(i=>i.name===stored).reduce((n,i)=>n+i.count,0)
 report.withdraw=await skill('withdraw',stored,initial+2);assert.equal(report.withdraw.container[stored],count-2)
 report.repeatWithdraw=await skill('withdraw',stored,initial+2);assert.equal(report.repeatWithdraw.count,0)
 report.deposit=await skill('deposit',stored,count);report.repeatDeposit=await skill('deposit',stored,count);assert.equal(report.repeatDeposit.count,0)
 report.serverChestAfterRoundtrip=await serverChest(rcon,chest);assert.deepEqual(report.serverChestAfterRoundtrip.contents,report.serverChestBefore.contents)
 // An enclosed route must fail honestly without relocating any station.
 const f=controller.projects.base.stations.furnace.position,region=`${f.x-1} ${f.y} ${f.z-1} ${f.x+1} ${f.y+2} ${f.z+1}`
 await rcon('tp HarnessTest 35.5 251 14.5')
 await rcon(`fill ${region} minecraft:glass replace minecraft:air`)
 try {
  runner.command({action:'check_base',goal:{project:structuredClone(controller.projects.base)},timeoutMs:45000})
  while(runner.task.status==='running')await pause(200)
  assert.equal(runner.task.status,'failed');report.blockedRoute={status:runner.task.status,reason:runner.task.reason}
  assert.deepEqual(controller.projects.base.stations.furnace.position,f)
 }finally{await rcon(`fill ${region} minecraft:air replace minecraft:glass`)}
 // Separate supplied inputs isolate cancellation/restart while a furnace cooks.
 await rcon('give HarnessTest minecraft:sand 2');await rcon('give HarnessTest minecraft:oak_planks 4')
 runner.command({action:'smelt',goal:{project:structuredClone(controller.projects.base),item:'glass',count:2},timeoutMs:120000})
 for(let i=0;i<200&&!runner.task.smelting&&runner.task.status==='running';i++)await pause(100)
 assert.ok(runner.task.smelting,'Furnace was not loaded');runner.stop();assert.equal(runner.task.status,'cancelled')
 const beforeRestart=structuredClone(controller.projects.base);runner.close();await pause(1500);await start()
 assert.deepEqual(controller.projects.base.stations,beforeRestart.stations);assert.equal(runner.task.status,'cancelled');await pause(1000);assert.equal(runner.task.status,'cancelled')
 report.restart={cancelledStayedCancelled:true,stationsRetained:true}
 report.resumedSmelt=await skill('smelt','glass',2);assert.equal(report.resumedSmelt.count,2)
 report.serverGlass=await rcon('clear HarnessTest minecraft:glass 0');assert.match(report.serverGlass,/2 matching/)
 report.status='passed'
}catch(e){report.status='failed';report.error=e.stack;report.project=structuredClone(controller?.projects.base);report.messages=controller?.messages;process.exitCode=1}
finally{clearTimeout(deadline);runner?.close();witness?.quit();writeFileSync(dir+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({path:dir+'/report.json',status:report.status,error:report.error,elapsedMs:report.elapsedMs,restart:report.restart},null,2));setTimeout(()=>process.exit(process.exitCode||0),1000)}
