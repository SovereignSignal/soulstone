import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import assert from 'node:assert/strict'
import {Runner} from '../src/runner.js'
import {Teammate} from '../src/companion/controller.js'
if(process.env.MC_LAB_EXPERIMENT!=='yes')throw new Error('Disposable lab opt-in required')
const run=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms)),ssh=process.env.MC_SSH_HOST
if(!/^[A-Za-z0-9_.-]+$/.test(ssh||''))throw new Error('Missing lab SSH alias')
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',ssh,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const dir=resolve('results/prospect-lab-'+Date.now());mkdirSync(dir,{recursive:true})
const report={scope:'Seeded buried ore with supplied stone tools, wood and base workstations; executor integration, not a natural-world/model success',status:'running',events:[]}
let runner,controller
async function start(){
 runner=new Runner({host:process.env.MC_HOST,username:'HarnessTest',version:'1.21.4',owner:'HarnessWitness',statePath:dir+'/bot.json'})
 runner.on('event',e=>{report.events.push(structuredClone(e));if(e.type==='skill_progress')console.log(e.message);if(e.type==='task_finished')console.log(e.task.kind+': '+e.task.status+' '+e.task.reason)})
 runner.start();for(let i=0;i<60&&!runner.ready;i++)await pause(500);assert.ok(runner.ready);await runner.bot.waitForChunksToLoad()
 controller=new Teammate(runner,{model:'executor test'},dir+'/conversation.json')
}
async function skill(action,item,count){runner.command({action,goal:{item,count,...(action==='acquire'?{}:{project:structuredClone(controller.projects.base)})},timeoutMs:600000});while(runner.task.status==='running')await pause(200);assert.equal(runner.task.status,'completed',runner.task.reason);return structuredClone(runner.task.result)}
try{
 await rcon('fill 60 227 0 90 250 24 minecraft:stone');await rcon('fill 60 251 0 90 255 24 minecraft:air')
 await rcon('fill 76 244 16 78 244 16 minecraft:iron_ore');await rcon('setblock 82 234 18 minecraft:diamond_ore')
 await rcon('setblock 71 251 2 minecraft:crafting_table');await rcon('setblock 70 251 2 minecraft:furnace')
 await start();controller.projects.base={build:{origin:{x:72,y:251,z:4},near:{x:68,y:251,z:4},wood:'oak_log',design:[{x:0,y:0,z:0,block:'wood_planks'}]},stations:{crafting_table:{position:{x:71,y:251,z:2}},furnace:{position:{x:70,y:251,z:2}}}};controller.persist()
 report.setup=[]
 for(let i=0;i<30;i++){const reply=await rcon('data get entity HarnessTest Health');if(/entity data/.test(reply))break;await pause(300)}
 for(const command of ['clear HarnessTest','tp HarnessTest 65.5 251 8.5','give HarnessTest minecraft:stone_pickaxe 2','give HarnessTest minecraft:oak_log 6','give HarnessTest minecraft:torch 16']){const reply=await rcon(command);report.setup.push({command,reply});console.log(reply)}
 for(let i=0;i<50&&(!runner.bot.inventory.items().some(i=>i.name==='stone_pickaxe')||Math.abs(runner.position().x-65.5)>.1);i++)await pause(200)
 report.initialInventory=runner.bot.inventory.items().map(i=>({name:i.name,count:i.count}));report.initialPosition=runner.position()
 assert.equal(report.initialInventory.filter(i=>i.name==='stone_pickaxe').reduce((n,i)=>n+i.count,0),2,'Fixture tools not confirmed')
 assert.ok(Math.abs(report.initialPosition.x-65.5)<.1,'Fixture teleport not confirmed')
 const started=Date.now()
 report.iron=await skill('prospect','raw_iron',3);assert.equal(report.iron.acquired,true);assert.equal(report.iron.returned,true)
 report.serverIron=await rcon('data get entity HarnessTest Inventory[{id:"minecraft:raw_iron"}]');assert.match(report.serverIron,/count: 3/)
 report.smelt=await skill('smelt','iron_ingot',3);report.pickaxe=await skill('acquire','iron_pickaxe',1)
 // Simulate a later mining action removing support beneath an old waypoint.
 const old=controller.projects.base.expedition.frontier[0]
 report.changedWaypoint={x:old.x,y:old.y-1,z:old.z}
 await rcon(`setblock ${old.x} ${old.y-1} ${old.z} minecraft:air`)
 await pause(300)
 runner.command({action:'prospect',goal:{item:'diamond',count:1,project:structuredClone(controller.projects.base)},timeoutMs:600000})
 for(let i=0;i<1000&&runner.task.status==='running'&&!(runner.task.progress?.broken>=2);i++)await pause(100)
 assert.ok(runner.task.progress?.broken>=2,'No actual diamond excavation before Stop')
 runner.stop();assert.equal(runner.task.status,'cancelled');report.interrupted=structuredClone(runner.task.progress)
 const trail=structuredClone(controller.projects.base.expedition.trail);assert.ok(trail.length);runner.close();await pause(1500);await start()
 assert.equal(runner.task.status,'cancelled');assert.deepEqual(controller.projects.base.expedition.trail,trail)
 report.restart={cancelledStayedCancelled:true,trailRetained:true}
 report.diamond=await skill('prospect','diamond',1);assert.equal(report.diamond.acquired,true);assert.equal(report.diamond.returned,true)
 report.serverDiamond=await rcon('data get entity HarnessTest Inventory[{id:"minecraft:diamond"}]');assert.match(report.serverDiamond,/count: 1/)
 report.serverPosition=await rcon('data get entity HarnessTest Pos');report.position=runner.position();report.project=structuredClone(controller.projects.base)
 assert.ok(report.project.expedition.routeRepairs>=1,'Changed waypoint was not repaired');assert.equal(report.project.expedition.trail.length,0);report.elapsedMs=Date.now()-started;report.status='passed'
}catch(e){report.status='failed';report.error=e.stack;report.task=structuredClone(runner?.task);report.project=structuredClone(controller?.projects.base);process.exitCode=1}
finally{runner?.close();writeFileSync(dir+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({path:dir+'/report.json',status:report.status,error:report.error,elapsedMs:report.elapsedMs},null,2));setTimeout(()=>process.exit(process.exitCode||0),1000)}
