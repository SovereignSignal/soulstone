// Astra controls the real executor; server checks remain independent.
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
import {ModelProfiles} from '../src/companion/providers.js'
if(process.env.MC_LAB_EXPERIMENT!=='yes')throw new Error('Disposable lab opt-in required')
const profiles=new ModelProfiles(resolve('state/models.json'))
const profile=profiles.profiles.find(p=>p.kind==='codex'&&p.model==='gpt-6-astra')
assert.ok(profile,'Astra subscription profile required')
const ssh=process.env.MC_SSH_HOST
if(!/^[A-Za-z0-9_.-]+$/.test(ssh||''))throw new Error('Missing lab SSH alias')
const run=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms))
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',ssh,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const dir=resolve('results/delivery-lab-'+Date.now());mkdirSync(dir,{recursive:true})
let runner,witness,controller,deadline;const report={status:'running',scope:'Astra acquisition and owner handoff from empty inventory',model:profile.model,events:[]}
try{
 await rcon('execute positioned 24 252 8 run kill @e[type=item,distance=..32]')
 await rcon('whitelist add HarnessWitness')
 witness=mineflayer.createBot({host:process.env.MC_HOST,username:'HarnessWitness',version:process.env.MC_VERSION||'1.21.4',auth:'offline'});witness.on('error',()=>{})
 await new Promise((yes,no)=>{const t=setTimeout(()=>no(new Error('Witness timeout')),30000);witness.once('spawn',()=>{clearTimeout(t);yes()})})
 await rcon('tp HarnessWitness 30.5 251 8.5');await rcon('gamemode survival HarnessWitness');await rcon('clear HarnessWitness')
 runner=new Runner({host:process.env.MC_HOST,username:'HarnessTest',version:process.env.MC_VERSION||'1.21.4',owner:'HarnessWitness',statePath:dir+'/bot.json'})
 runner.on('event',e=>report.events.push(structuredClone(e)));runner.start()
 for(let i=0;i<60&&!runner.ready;i++)await pause(500)
 assert.equal(runner.ready,true)
 await rcon('clear HarnessTest');await rcon('gamemode survival HarnessTest');await rcon('tp HarnessTest 32.5 251 8.5')
 await rcon('fill 0 250 0 48 250 16 minecraft:smooth_stone');await rcon('fill 0 251 0 48 256 16 minecraft:air');await rcon('fill 1 251 4 16 251 4 minecraft:oak_log');await rcon('fill 18 251 4 23 251 4 minecraft:stone')
 await pause(700)
 if(process.env.MC_DELIVERY_ONLY==='yes'){report.scope='Diagnostic with supplied pickaxe, not an empty-inventory chain';await rcon('give HarnessTest minecraft:stone_pickaxe 1')}
 report.pickupTrace=[]
 const describe=e=>({id:e?.id,name:e?.name,position:e?.position?.clone(),item:e?.getDroppedItem?.()})
 runner.bot.on('itemDrop',e=>report.pickupTrace.push({event:'itemDrop',entity:describe(e)}))
 runner.bot._client.on('collect',p=>report.pickupTrace.push({event:'collect',packet:p,entity:describe(runner.bot?.entities[p.collectedEntityId])}))
 const planner=new LocalPlanner();planner.profiles={current:profile,key:''}
 let modelCalls=0;const plan=planner.plan.bind(planner);planner.plan=(...args)=>{modelCalls++;return plan(...args)}
 controller=new Teammate(runner,planner,dir+'/conversation.json',new EpisodeRecorder(dir+'/episodes'))
 report.request='Make me one stone pickaxe and bring it to me. Hand it to me, then stop.'
 const started=Date.now();deadline=setTimeout(()=>controller.stop(),240000)
 await controller.submit(report.request);clearTimeout(deadline)
 const state=controller.snapshot();Object.assign(report,{elapsedMs:Date.now()-started,modelCalls,phase:state.phase,messages:structuredClone(state.messages),inventory:state.inventory,position:state.position})
 assert.ok(modelCalls>0,'Must use the actual model, not a direct rule')
 const delivery=report.events.find(e=>e.type==='task_finished'&&e.task?.kind==='give'&&e.task.status==='completed')
 assert.ok(delivery,'No completed delivery');report.delivery=delivery.task.result
 const serverRecipient=await rcon('clear HarnessWitness minecraft:stone_pickaxe 0')
 assert.match(serverRecipient,/Found 1 matching/)
 const serverSender=await rcon('data get entity HarnessTest Inventory[{id:"minecraft:stone_pickaxe"}]')
 assert.doesNotMatch(serverSender,/id: "minecraft:stone_pickaxe"/)
 assert.equal(state.inventory.stone_pickaxe||0,0)
 assert.equal(report.events.filter(e=>e.type==='task_started'&&e.task?.kind==='give').length,1)
 assert.equal(state.phase,'ready');assert.equal(state.requestProgress.pending.length,0)
 report.verification={source:'server RCON queries',serverRecipient,serverSender,goalSatisfied:true}
 report.requestProgress=state.requestProgress
 await pause(1000)
 // Stop a second handoff while approaching a distant recipient. Fixture item
 // is supplied for this cancellation check, separate from the full-chain pass.
 await rcon('give HarnessTest minecraft:stone_pickaxe 1');await rcon('tp HarnessTest 2.5 251 12.5');await pause(500)
 let cancelSent=false
 const cancelDelivery=e=>{if(e.type==='task_started'&&e.task?.kind==='give'){cancelSent=true;setTimeout(()=>controller.stop(),100)}}
 runner.on('event',cancelDelivery)
 await controller.submit('Hand me one stone pickaxe.')
 runner.off('event',cancelDelivery)
 assert.ok(cancelSent,'Second delivery must start before testing Stop')
 for(let i=0;i<60&&!runner.ready;i++)await pause(500)
 await pause(1000)
 report.cancelCheck={phase:controller.phase,taskStatus:runner.task.status,deliveryAttempted:!!runner.task.delivery?.attempted,recipient:await rcon('clear HarnessWitness minecraft:stone_pickaxe 0'),sender:await rcon('clear HarnessTest minecraft:stone_pickaxe 0')}
 assert.equal(report.cancelCheck.taskStatus,'cancelled');assert.equal(report.cancelCheck.deliveryAttempted,false)
 assert.match(report.cancelCheck.recipient,/Found 1 matching/);assert.match(report.cancelCheck.sender,/Found 1 matching/)
 report.status='passed'
}catch(error){report.status='failed';report.error=error.message;report.task=runner?.task;report.messages=controller?.messages;try{report.failedRecipient=await rcon('clear HarnessWitness minecraft:stone_pickaxe 0');report.failedGround=await rcon('execute as @e[type=item,distance=..64] run data get entity @s Item')}catch{};process.exitCode=1}
finally{
 clearTimeout(deadline);runner?.close();witness?.quit()
 writeFileSync(dir+'/report.json',JSON.stringify(report,null,2),{mode:0o600})
 console.log(JSON.stringify({...report,events:report.events.length,pickupTrace:report.pickupTrace?.length,receipt:dir+'/report.json'},null,2))
 setTimeout(()=>process.exit(process.exitCode||0),1000)
}
