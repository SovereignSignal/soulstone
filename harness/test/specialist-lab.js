// A local model controls the real executor; server checks remain independent.
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import assert from 'node:assert/strict'
import mineflayer from 'mineflayer'
import {Runner} from '../src/runner.js'
import {LocalPlanner} from '../src/companion/planner.js'
import {Teammate} from '../src/companion/controller.js'
import {EpisodeRecorder} from '../src/companion/episodes.js'
import {validateProfile} from '../src/companion/providers.js'
if(process.env.MC_LAB_EXPERIMENT!=='yes')throw new Error('Disposable lab opt-in required')
const profile=validateProfile(JSON.parse(readFileSync(process.env.MC_EVAL_PROFILE||'local-model/profile.json','utf8')))
if(profile.kind!=='local')throw new Error('This first specialist lab accepts local profiles only')
const ssh=process.env.MC_SSH_HOST
if(!/^[A-Za-z0-9_.-]+$/.test(ssh||''))throw new Error('Missing lab SSH alias')
const run=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms))
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',ssh,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const dir=resolve('results/specialist-lab-'+Date.now());mkdirSync(dir,{recursive:true})
let runner,witness,controller,deadline;const report={status:'running',scope:'live local-model planning and execution; two crafting tables and return',model:profile.model,events:[]}
try{
 await rcon('whitelist add HarnessWitness')
 witness=mineflayer.createBot({host:process.env.MC_HOST,username:'HarnessWitness',version:process.env.MC_VERSION||'1.21.4',auth:'offline'});witness.on('error',()=>{})
 await new Promise((yes,no)=>{const t=setTimeout(()=>no(new Error('Witness timeout')),30000);witness.once('spawn',()=>{clearTimeout(t);yes()})})
 await rcon('tp HarnessWitness 30.5 251 8.5')
 runner=new Runner({host:process.env.MC_HOST,username:'HarnessTest',version:process.env.MC_VERSION||'1.21.4',owner:'HarnessWitness',statePath:dir+'/bot.json'})
 runner.on('event',e=>report.events.push(structuredClone(e)));runner.start()
 for(let i=0;i<60&&!runner.ready;i++)await pause(500)
 assert.equal(runner.ready,true)
 await rcon('clear HarnessTest');await rcon('gamemode survival HarnessTest');await rcon('tp HarnessTest 32.5 251 8.5')
 await rcon('fill 0 250 0 48 250 16 minecraft:smooth_stone');await rcon('fill 0 251 0 48 256 16 minecraft:air');await rcon('fill 18 251 4 23 251 4 minecraft:oak_log')
 await pause(700)
 const planner=new LocalPlanner();planner.profiles={current:profile,key:''}
 let modelCalls=0;planner.fetcher=(...args)=>{modelCalls++;return fetch(...args)}
 controller=new Teammate(runner,planner,dir+'/conversation.json',new EpisodeRecorder(dir+'/episodes'))
 report.request='Make sure you have two crafting tables for our next camp, then return to my position here.'
 const started=Date.now();deadline=setTimeout(()=>controller.stop(),180000)
 await controller.submit(report.request);clearTimeout(deadline)
 const state=controller.snapshot();Object.assign(report,{elapsedMs:Date.now()-started,modelCalls,phase:state.phase,messages:state.messages,inventory:state.inventory,position:state.position})
 assert.ok(modelCalls>0,'Must use the actual model, not a direct rule')
 assert.ok(state.inventory.crafting_table>=2,'Two tables must be in inventory')
 const serverCount=await rcon('clear HarnessTest minecraft:crafting_table 0')
 assert.match(serverCount,/Found ([2-9]|[1-9][0-9]+) /)
 const serverPosition=await rcon('data get entity HarnessTest Pos')
 const coordinates=serverPosition.match(/\[([^\]]+)\]/)?.[1].split(',').map(n=>Number.parseFloat(n.trim()))
 assert.equal(coordinates?.length,3)
 const distance=Math.hypot(coordinates[0]-30.5,coordinates[1]-251,coordinates[2]-8.5)
 assert.ok(distance<=3,'Server position must be within three blocks of saved owner position')
 report.verification={source:'server RCON queries',serverCount,serverPosition,distance,goalSatisfied:true,trainingEligible:false,reviewRequired:true}
 assert.equal(state.phase,'ready','Controller must finish without a planning-limit failure')
 report.status='passed'
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1}
finally{
 clearTimeout(deadline);runner?.close();witness?.quit()
 writeFileSync(dir+'/report.json',JSON.stringify(report,null,2),{mode:0o600})
 console.log(JSON.stringify({...report,events:report.events.length,receipt:dir+'/report.json'},null,2))
 setTimeout(()=>process.exit(process.exitCode||0),1000)
}
