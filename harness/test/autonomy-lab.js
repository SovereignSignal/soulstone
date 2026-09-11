import assert from 'node:assert/strict'
import mineflayer from 'mineflayer'
import {once} from 'node:events'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {Runner} from '../src/runner.js'
import {Teammate} from '../src/companion/controller.js'
import {LocalPlanner} from '../src/companion/planner.js'
import {ModelProfiles} from '../src/companion/providers.js'
import {EpisodeRecorder} from '../src/companion/episodes.js'
import {verifyArchitecture} from './architecture-check.js'
if(process.env.MC_LAB_EXPERIMENT!=='yes')throw new Error('Disposable lab opt-in required')
const run=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms)),host=process.env.MC_SSH_HOST
assert.match(host,/^[\w.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const dir=resolve('results/autonomy-lab-'+Date.now());mkdirSync(dir,{recursive:true})
const profiles=new ModelProfiles('state/models.json'),profile=profiles.profiles.find(p=>p.kind==='codex'&&p.model==='gpt-6-astra');assert.ok(profile)
const report={status:'running',scope:'Unseeded model plans on supplied isolated survival pads and raw materials. No operator design or intervention within a request. This tests bounded planning and experience retrieval, not learning efficacy or general Minecraft mastery.',cases:[]}
let runner,controller,timer,witness,lastLog=0
async function start(){
 runner=new Runner({host:process.env.MC_HOST,username:'HarnessTest',version:'1.21.4',owner:'HarnessWitness',statePath:dir+'/bot.json'})
 runner.on('event',e=>{if(e.type==='skill_progress'&&Date.now()-lastLog>10000){console.log(e.message);lastLog=Date.now()}if(e.type==='task_finished'&&e.task)console.log(e.task.kind+': '+e.task.status+' '+e.task.reason)})
 runner.start();for(let i=0;i<60&&!runner.ready;i++)await pause(500);assert.ok(runner.ready);await runner.bot.waitForChunksToLoad()
 const planner=new LocalPlanner();planner.profiles={current:profile,key:''}
 controller=new Teammate(runner,planner,dir+'/conversation.json',new EpisodeRecorder(dir+'/episodes'))
}
async function request(text){
 const c={request:text,started:Date.now()};report.cases.push(c);console.log('REQUEST '+text)
 timer=setTimeout(()=>controller.stop(),900000)
 await controller.submit(text);clearTimeout(timer)
 c.elapsedMs=Date.now()-c.started;c.final=controller.snapshot();writeFileSync(dir+'/report.json',JSON.stringify(report,null,2))
 assert.ok(['verified','needs_review'].includes(controller.requestProgress.status),controller.requestProgress.blocker||controller.messages.at(-1)?.text)
 return c
}
async function verifyBuild(c,palette,height,budget){
 const goal=c.final.requestProgress.goal,target=goal.criteria.find(c=>c.kind==='construction')?.target
 assert.ok(target,'Literal request requires a constructed structure')
 Object.assign(c,await verifyArchitecture(rcon,controller.projects[target],{palette,height,budget,pad:{minX:palette==='oak_planks'?160:240,maxX:palette==='oak_planks'?180:246,minZ:0,maxZ:palette==='oak_planks'?20:12}}));c.project=target
 return c
}
try{
 witness=mineflayer.createBot({host:process.env.MC_HOST,username:'HarnessWitness',version:'1.21.4'});await once(witness,'spawn')
 await start()
 // Two pads far from all player builds and previous fixture constructions.
 for(const command of ['forceload add 160 0 180 20','fill 160 250 0 180 250 20 minecraft:smooth_stone','fill 160 251 0 180 268 20 minecraft:air','forceload add 240 0 246 12','fill 240 250 0 246 250 12 minecraft:smooth_stone','fill 240 251 0 246 268 12 minecraft:air','clear HarnessTest','gamemode survival HarnessTest','tp HarnessTest 170.5 251 2.5','tp HarnessWitness 170.5 251 10.5','give HarnessTest minecraft:oak_log 16'])await rcon(command)
 await pause(1500);await runner.bot.waitForChunksToLoad()
 const a=await request('Build a small viewing platform here with a walkable route from the ground to at least three blocks above it. Use only oak planks and at most 48 placed blocks. Work out the layout and necessary crafting yourself, and verify the route before finishing.')
 await verifyBuild(a,'oak_planks',3,48)
 assert.ok(a.final.requestProgress.completed.some(c=>c.step.action==='acquire'),'Planner must derive crafting prerequisite')
 assert.ok(controller.experience.entries.length>0);const firstExperience=controller.experience.entries[0].id
 runner.close();await pause(1500);await start();assert.ok(controller.experience.entries.some(e=>e.id===firstExperience),'Experience must survive restart')
 for(const command of ['clear HarnessTest','tp HarnessTest 243.5 251 3.5','tp HarnessWitness 243.5 251 1.5','give HarnessTest minecraft:cobblestone 56'])await rcon(command)
 await pause(1500);await runner.bot.waitForChunksToLoad()
 const b=await request('Build another small lookout here. I need to walk up from the ground to at least four blocks above it. Use only cobblestone and at most 56 placed blocks. Fit this available site, preserve earlier builds, and verify the access route.')
 await verifyBuild(b,'cobblestone',4,56)
 assert.notEqual(a.project,b.project);assert.notDeepEqual(a.design.map(({block,...p})=>p),b.design.map(({block,...p})=>p),'Geometry must adapt beyond palette')
 assert.ok(b.final.requestProgress.retrievedExperience.includes(firstExperience),'Second request must retrieve first task experience')
 await verifyBuild(a,'oak_planks',3,48)
 // Independent non-building compound task with simple raw resources.
 for(const command of ['clear HarnessTest','tp HarnessTest 170.5 251 2.5','tp HarnessWitness 170.5 251 10.5','give HarnessTest minecraft:oak_log 4','give HarnessTest minecraft:cobblestone 6','give HarnessTest minecraft:coal 2'])await rcon(command)
 await pause(1000)
 const c=await request('Prepare a stone pickaxe, a stone sword, and eight torches. Keep all three supplies in your inventory ready for me; do not deliver them yet.')
 for(const [item,count] of [['stone_pickaxe',1],['stone_sword',1],['torch',8]]){assert.ok(c.final.inventory[item]>=count);c[item]=await rcon(`data get entity HarnessTest Inventory[{id:"minecraft:${item}"}]`);assert.match(c[item],new RegExp('count: '+count))}
 report.experience=JSON.parse(readFileSync(dir+'/experience.json'));report.serverMode=await rcon('data get entity HarnessTest playerGameType');assert.match(report.serverMode,/0/)
 report.status='passed'
}catch(e){report.status='failed';report.error=e.stack;report.final=controller?.snapshot();process.exitCode=1}
finally{clearTimeout(timer);runner?.close();witness?.quit();writeFileSync(dir+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({path:dir+'/report.json',status:report.status,error:report.error,cases:report.cases.map(c=>({elapsedMs:c.elapsedMs,blocks:c.blocks,height:c.height}))}));setTimeout(()=>process.exit(process.exitCode||0),1000)}
