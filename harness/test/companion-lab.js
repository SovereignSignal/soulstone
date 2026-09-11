import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import mineflayer from 'mineflayer'
import assert from 'node:assert/strict'
import { Runner } from '../src/runner.js'
import { LocalPlanner } from '../src/companion/planner.js'
import { Teammate } from '../src/companion/controller.js'
if(process.env.MC_LAB_EXPERIMENT!=='yes')throw new Error('Disposable lab opt-in required')
const run=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms))
const ssh=process.env.MC_SSH_HOST
if(!/^[A-Za-z0-9_.-]+$/.test(ssh||''))throw new Error('Missing lab SSH alias')
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',ssh,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const dir=resolve('results/companion-lab-'+Date.now());mkdirSync(dir,{recursive:true})
let runner,witness;const report={status:'running',model:'minecraft-teammate',events:[]}
try{
 await rcon('whitelist add HarnessWitness')
 witness=mineflayer.createBot({host:process.env.MC_HOST,username:'HarnessWitness',version:'1.21.4',auth:'offline'});witness.on('error',()=>{})
 await new Promise((yes,no)=>{const t=setTimeout(()=>no(new Error('Witness timeout')),30000);witness.once('spawn',()=>{clearTimeout(t);yes()})})
 await rcon('tp HarnessWitness 2.5 251 8.5')
 runner=new Runner({host:process.env.MC_HOST,username:'HarnessTest',version:'1.21.4',owner:'HarnessWitness',statePath:dir+'/bot.json'})
 runner.on('event',e=>report.events.push(e));runner.start()
 for(let i=0;i<60&&!runner.ready;i++)await pause(500)
 assert.equal(runner.ready,true)
 await rcon('clear HarnessTest');await rcon('gamemode survival HarnessTest');await rcon('tp HarnessTest 3.5 251 8.5')
 await rcon('fill 10 251 4 14 251 4 minecraft:oak_log')
 await pause(700)
 const controller=new Teammate(runner,new LocalPlanner(),dir+'/conversation.json')
 report.request='Collect five oak logs and come back here.'
 const start=Date.now();await controller.submit(report.request);report.elapsedMs=Date.now()-start
 const state=controller.snapshot();report.phase=state.phase;report.plan=state.plan;report.messages=state.messages;report.inventory=state.inventory;report.position=state.position
 assert.equal(state.phase,'ready');assert.ok(state.inventory.oak_log>=5)
 assert.equal(state.plan.at(-1).action,'return')
 report.distance=Math.hypot(state.position.x-2.5,state.position.y-251,state.position.z-8.5);assert.ok(report.distance<=3)
 report.serverInventory=await rcon('clear HarnessTest minecraft:oak_log 0');assert.match(report.serverInventory,/Found 5 /)
 report.serverPosition=await rcon('data get entity HarnessTest Pos');report.status='passed'
}catch(e){report.status='failed';report.error=e.stack;process.exitCode=1}
finally{runner?.close();witness?.quit();writeFileSync(dir+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({...report,events:report.events.length},null,2));setTimeout(()=>process.exit(process.exitCode||0),1000)}
