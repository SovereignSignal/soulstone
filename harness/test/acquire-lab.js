import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import mineflayer from 'mineflayer'
import assert from 'node:assert/strict'
import { Runner } from '../src/runner.js'
if(process.env.MC_LAB_EXPERIMENT!=='yes')throw new Error('Disposable lab opt-in required')
const run=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms))
const ssh=process.env.MC_SSH_HOST
if(!/^[A-Za-z0-9_.-]+$/.test(ssh||''))throw new Error('Missing lab SSH alias')
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',ssh,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const dir=resolve('results/acquire-lab-'+Date.now());mkdirSync(dir,{recursive:true})
let runner,witness;const report={status:'running',model:'deterministic executor',events:[]}
try{
 await rcon('whitelist add HarnessWitness')
 witness=mineflayer.createBot({host:process.env.MC_HOST,username:'HarnessWitness',version:'1.21.4',auth:'offline'});witness.on('error',()=>{})
 await new Promise((yes,no)=>{const t=setTimeout(()=>no(new Error('Witness timeout')),30000);witness.once('spawn',()=>{clearTimeout(t);yes()})})
 await rcon('tp HarnessWitness 30.5 251 8.5')
 runner=new Runner({host:process.env.MC_HOST,username:'HarnessTest',version:'1.21.4',owner:'HarnessWitness',statePath:dir+'/bot.json'})
 runner.on('event',e=>{report.events.push(structuredClone(e));if(e.type==='skill_progress')writeFileSync(dir+'/progress.json',JSON.stringify(e))});runner.start()
 for(let i=0;i<60&&!runner.ready;i++)await pause(500)
 assert.equal(runner.ready,true)
 if(process.env.MC_RESUME_LAB!=='yes'){
 await rcon('clear HarnessTest');await rcon('gamemode survival HarnessTest');await rcon('tp HarnessTest 32.5 251 8.5')
 await rcon('fill 0 250 0 48 250 16 minecraft:smooth_stone');await rcon('fill 0 251 0 48 256 16 minecraft:air')
 await rcon('fill 1 251 4 16 251 4 minecraft:oak_log');await rcon('fill 18 251 4 23 251 4 minecraft:stone')
 }
 await pause(700)
 if(process.env.MC_CRAFT_TRACE==='yes'){
  const bot=runner.bot,trace=[];report.craftTrace=trace
  const compact=w=>w&&({id:w.id,type:w.type,selected:w.selectedItem&&{name:w.selectedItem.name,count:w.selectedItem.count},slots:w.slots.map((i,slot)=>i&&({slot,name:i.name,count:i.count})).filter(Boolean)})
  const original=bot.craft.bind(bot)
  bot.craft=async(r,n,t)=>{
   trace.push({event:'craft_start',result:bot.registry.items[r.result.id].name,recipe:r,invent:compact(bot.inventory),table:t?.position})
   try {return await original(r,n,t)} finally {trace.push({event:'craft_end',invent:compact(bot.inventory)})}
  }
  bot._client.on('packet',(p,m)=>{if(['set_slot','window_items','open_window','set_player_inventory'].includes(m.name))trace.push({event:m.name,p})})
  const write=bot._client.write.bind(bot._client)
  bot._client.write=(name,p)=>{if(['window_click','close_window','block_place'].includes(name))trace.push({event:'send_'+name,p});return write(name,p)}
 }
 report.request=process.env.MC_RESUME_LAB==='yes'?'resume stone_pickaxe acquisition from saved inventory':'acquire one stone_pickaxe from empty inventory'
 const started=Date.now()
 await new Promise((yes,no)=>{
  const timer=setTimeout(()=>no(new Error('Acquisition timed out')),600000)
  runner.on('event',e=>{if(e.type==='task_finished'&&e.task?.kind==='acquire'){clearTimeout(timer);e.task.status==='completed'?yes():no(new Error(e.task.reason))}})
  runner.command({action:'acquire',goal:{item:'stone_pickaxe',count:1},timeoutMs:600000})
 })
 report.elapsedMs=Date.now()-started;report.result=runner.task.result
 report.serverInventory=await rcon('data get entity HarnessTest Inventory')
 // Full entity text can be truncated by the server. Verify the exact item.
 report.serverStonePickaxe=await rcon('data get entity HarnessTest Inventory[{id:"minecraft:stone_pickaxe"}]')
 assert.match(report.serverStonePickaxe,/minecraft:stone_pickaxe/)
 report.status='passed'
}catch(e){report.status='failed';report.error=e.stack;report.localInventory=runner?.bot?.inventory.items().map(i=>({name:i.name,count:i.count}));try{report.serverPickaxe=await rcon('data get entity HarnessTest Inventory[{id:"minecraft:wooden_pickaxe"}]')}catch{};process.exitCode=1}
finally{runner?.close();witness?.quit();writeFileSync(dir+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({...report,events:report.events.length,craftTrace:report.craftTrace?.length},null,2));setTimeout(()=>process.exit(process.exitCode||0),1000)}
