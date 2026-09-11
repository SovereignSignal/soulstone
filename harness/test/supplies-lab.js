import {serverTools} from './server-tools.js'
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {Runner} from '../src/runner.js'
import {Teammate} from '../src/companion/controller.js'
import {LocalPlanner} from '../src/companion/planner.js'
import {ModelProfiles} from '../src/companion/providers.js'
import {EpisodeRecorder} from '../src/companion/episodes.js'
import {usableToolCount} from '../src/supplies.js'
import {serverChest} from './server-chest.js'
if(process.env.MC_LAB_EXPERIMENT!=='yes')throw new Error('Disposable lab opt-in required')
const run=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms)),ssh=process.env.MC_SSH_HOST
assert.match(ssh,/^[A-Za-z0-9_.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',ssh,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const dir=resolve('results/supplies-lab-'+Date.now());mkdirSync(dir,{recursive:true})
const profiles=new ModelProfiles('state/models.json'),profile=profiles.profiles.find(p=>p.kind==='codex'&&p.model==='gpt-6-astra');assert.ok(profile)
const report={status:'running',scope:'Astra expedition supplies in a seeded lab: supplied raw iron, logs, worn tools and rubble; buried coal must be mined. Restart during smelting tests durable Resume. Not a natural-resource start.',events:[]}
const alternate=process.env.MC_LAB_VARIANT==='alternate';report.variant=alternate?'south seam with scarce charcoal inputs':'east seam'
let runner,controller,timer
async function start(){
 runner=new Runner({host:process.env.MC_HOST,username:'HarnessTest',version:'1.21.4',owner:'HarnessWitness',statePath:dir+'/bot.json'})
 if(['running','paused'].includes(runner.task?.status))runner.stop()
 runner.on('event',e=>{report.events.push(structuredClone(e));if(e.type==='skill_progress')console.log(e.message);if(e.type==='task_finished')console.log(e.task.kind+': '+e.task.status+' '+e.task.reason)})
 runner.start();for(let i=0;i<60&&!runner.ready;i++)await pause(500);assert.ok(runner.ready);await runner.bot.waitForChunksToLoad()
 const planner=new LocalPlanner();planner.profiles={current:profile,key:''}
 controller=new Teammate(runner,planner,dir+'/conversation.json',new EpisodeRecorder(dir+'/episodes'))
}
async function skill(action,item,count){runner.command({action,goal:{item,count,...(['prepare','acquire'].includes(action)?{}:{project:structuredClone(controller.projects.base)})},timeoutMs:600000});while(runner.task.status==='running')await pause(200);assert.equal(runner.task.status,'completed',runner.task.reason);return structuredClone(runner.task.result)}
try{
 await rcon('fill 60 227 0 90 250 24 minecraft:stone');await rcon('fill 60 251 0 90 255 24 minecraft:air')
 await rcon(alternate?'fill 64 244 20 67 244 21 minecraft:coal_ore':'fill 82 245 16 85 245 17 minecraft:coal_ore')
 if(alternate)await rcon('fill 64 251 9 64 252 9 minecraft:oak_log')
 await rcon('setblock 71 251 2 minecraft:crafting_table');await rcon('setblock 70 251 2 minecraft:furnace');await rcon('setblock 70 251 4 minecraft:chest')
 await start();controller.projects.base={build:{origin:{x:72,y:251,z:4},near:{x:68,y:251,z:4},wood:'oak_log',design:[{x:0,y:0,z:0,block:'wood_planks'}]},stations:{crafting_table:{position:{x:71,y:251,z:2}},furnace:{position:{x:70,y:251,z:2}},chest:{position:{x:70,y:251,z:4}}}};controller.persist()
 report.setup=[]
 for(let i=0;i<30;i++){if(/entity data/.test(await rcon('data get entity HarnessTest Health')))break;await pause(300)}
 for(const command of ['clear HarnessTest','tp HarnessTest 65.5 251 8.5','give HarnessTest minecraft:iron_pickaxe[minecraft:damage=244] 1','give HarnessTest minecraft:stone_pickaxe[minecraft:damage=125] 1','give HarnessTest minecraft:raw_iron 6',`give HarnessTest minecraft:oak_log ${alternate?2:8}`,'give HarnessTest minecraft:cobblestone 120','give HarnessTest minecraft:granite 32','give HarnessTest minecraft:diamond 1','give HarnessTest minecraft:torch 8']){const reply=await rcon(command);report.setup.push({command,reply})}
 for(let i=0;i<50&&runner.bot.inventory.items().filter(i=>i.name==='raw_iron').reduce((n,i)=>n+i.count,0)!==6;i++)await pause(200)
 report.initial=controller.snapshot();assert.equal(report.initial.inventory.raw_iron,6);assert.equal(report.initial.tools.find(t=>t.name==='iron_pickaxe').remaining,6)
 // No actual excavation should occur with only exhausted picks.
 report.preflight=await skill('prospect','coal',8);assert.equal(report.preflight.broken,0);assert.ok(report.preflight.needs.some(n=>/pickaxe/.test(n)))
 if(alternate){report.charcoal=await skill('smelt','charcoal',2);assert.equal(report.charcoal.count,2);report.serverCharcoal=await rcon('data get entity HarnessTest Inventory[{id:"minecraft:charcoal"}]');assert.match(report.serverCharcoal,/count: 2/)}
 report.request='Prepare supplies for a mining trip: make two serviceable iron pickaxes, gather eight coal, stock our base chest with the coal and spare excavation materials, and return to base ready for my next command. Keep tools, torches and the diamond.'
 const started=Date.now();timer=setTimeout(()=>controller.stop(),600000)
 const pending=controller.submit(report.request)
 let interrupted=false
 for(let i=0;i<2400&&controller.requestProgress?.status==='running';i++){
  if(runner.task?.kind==='smelt'&&runner.task.smelting&&runner.task.status==='running'){
   const id=controller.requestProgress.id;report.beforeRestart=controller.snapshot();controller.interrupt('Lab process restart during smelting');runner.close();await pending;await pause(1500);await start()
   assert.equal(controller.requestProgress.status,'interrupted');assert.equal(controller.requestProgress.id,id);assert.equal(controller.snapshot().canResume,true)
   report.restart={requestIdRetained:true,automaticReplay:false,smeltingObserved:true};interrupted=true
   await controller.resume();break
  }
  await pause(100)
 }
 if(!interrupted)await pending
 clearTimeout(timer);assert.ok(interrupted,'Did not exercise restart during active smelting')
 report.final=controller.snapshot();assert.equal(controller.phase,'ready',controller.requestProgress.blocker)
 assert.ok(usableToolCount(runner.bot.inventory.items(),'iron_pickaxe')>=2,'Two serviceable tools not confirmed')
 assert.equal(report.final.inventory.diamond,1,'Valuable item was not retained')
 report.serverChest=await serverChest(rcon,{x:70,y:251,z:4})
 assert.ok(report.serverChest.contents.coal>=8);assert.ok(report.serverChest.contents.cobblestone>=88);assert.equal(report.serverChest.contents.granite,32)
 report.serverPicks=await serverTools(rcon,'HarnessTest',runner.bot.inventory.items(),'iron_pickaxe');assert.ok(report.serverPicks.filter(t=>t.remaining>=125).length>=2,'Server did not confirm two serviceable iron tools')
 report.serverDiamond=await rcon('data get entity HarnessTest Inventory[{id:"minecraft:diamond"}]');assert.match(report.serverDiamond,/count: 1/)
 report.serverPosition=await rcon('data get entity HarnessTest Pos')
 assert.ok(Math.hypot(runner.position().x-71,runner.position().y-251,runner.position().z-2)<5)
 assert.ok(controller.requestProgress.completed.some(c=>c.step.action==='prospect'&&c.result.acquired),'No completed coal expedition')
 const lights=controller.projects.base.expedition.lights||[];assert.ok(lights.length,'No trail torches placed')
 report.serverLights=[];for(const p of lights){const reply=await rcon(`execute if block ${p.x} ${p.y} ${p.z} minecraft:torch run data get entity HarnessTest Health`);assert.match(reply,/entity data/);report.serverLights.push({position:p,reply})}
 report.elapsedMs=Date.now()-started;report.status='passed'
}catch(e){report.status='failed';report.error=e.stack;report.final=controller?.snapshot();process.exitCode=1}
finally{clearTimeout(timer);runner?.close();writeFileSync(dir+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({path:dir+'/report.json',status:report.status,error:report.error,elapsedMs:report.elapsedMs}));setTimeout(()=>process.exit(process.exitCode||0),1000)}
