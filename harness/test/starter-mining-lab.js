// Disposable raised fixture: buried starter stone, wooden tools, zero torches.
// This validates executor bootstrapping, not a natural-world diamond request.
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import assert from 'node:assert/strict'
import {Runner} from '../src/runner.js'
import {Teammate} from '../src/companion/controller.js'
if(process.env.MC_LAB_EXPERIMENT!=='yes')throw new Error('Disposable lab opt-in required')
const run=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms)),ssh=process.env.MC_SSH_HOST
assert.match(ssh||'',/^[A-Za-z0-9_.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',ssh,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const dir=resolve('results/starter-mining-lab-'+Date.now());mkdirSync(dir,{recursive:true})
const report={scope:'Supplied wooden tools and crafting table; stone buried six blocks below dirt; no torches. Disposable executor fixture.',status:'running',trips:[]}
const design=[]
for(let x=0;x<4;x++)for(let z=0;z<4;z++)for(let y=0;y<3;y++)if((y===2||x===0||x===3||z===0||z===3)&&!(x===1&&z===0&&y<2))design.push({x,y,z,block:'wood_planks'})
let runner,controller
async function wait(predicate,label,ms=30000){const end=Date.now()+ms;while(!predicate()){assert.ok(Date.now()<end,label);await pause(100)}}
async function skill(action,item,count){
 runner.command({action,goal:{item,count,...(action==='acquire'||action==='prepare'?{}:{project:structuredClone(controller.projects.base)})},timeoutMs:240000})
 await wait(()=>runner.task.status!=='running'||runner.bot?.isAlive===false,action+' did not finish',245000)
 assert.notEqual(runner.bot?.isAlive,false,'Fixture agent died')
 assert.equal(runner.task.status,'completed',runner.task.reason)
 return structuredClone(runner.task.result)
}
try{
 report.playersBefore=await rcon('list')
 await rcon('fill 60 240 0 90 250 24 minecraft:stone')
 await rcon('fill 60 245 0 90 250 24 minecraft:dirt')
 await rcon('fill 60 251 0 90 255 24 minecraft:air')
 await rcon('setblock 71 251 2 minecraft:crafting_table')
 await rcon('fill 72 251 4 75 253 7 minecraft:oak_planks')
 await rcon('fill 73 251 5 74 252 6 minecraft:air')
 await rcon('fill 73 251 4 73 252 4 minecraft:air')
 await rcon('setblock 73 251 4 minecraft:oak_door[facing=south,half=lower]')
 await rcon('setblock 73 252 4 minecraft:oak_door[facing=south,half=upper]')
 runner=new Runner({host:process.env.MC_HOST,username:'HarnessTest',version:'1.21.4',owner:'HarnessWitness',statePath:dir+'/bot.json'})
 runner.on('event',e=>{if(e.type==='skill_progress')console.log(e.message);if(['death','error','ended'].includes(e.type))console.log(JSON.stringify(e))})
 runner.start();await wait(()=>runner.ready||runner.bot?.isAlive===false,'Fixture did not join')
 // A dead saved player can log in without completing chunk delivery. Wait for
 // initial health metadata, respawn that test identity, then await its chunks.
 await pause(500)
 if(runner.bot.isAlive===false){runner.respawn();await wait(()=>runner.bot.isAlive&&runner.bot.health>0,'Fixture respawn failed')}
 await wait(()=>runner.ready,'Fixture spawn did not complete')
 await Promise.race([runner.bot.waitForChunksToLoad(),pause(15000).then(()=>{throw new Error('Fixture chunks did not load')})])
 controller=new Teammate(runner,{model:'executor fixture'},dir+'/teammate.json')
 controller.projects.base={build:{origin:{x:72,y:251,z:4},near:{x:68,y:251,z:4},wood:'oak_log',design},stations:{crafting_table:{position:{x:71,y:251,z:2}}}};controller.persist()
 // Prior fixtures can leave this disposable identity dead or falling. Establish
 // its own initial life, health and stationary landing before scoring actions.
 if(runner.bot.isAlive===false){runner.respawn();await wait(()=>runner.bot.isAlive&&runner.bot.health>0,'Fixture respawn failed')}
 for(const command of ['gamemode survival HarnessTest','spawnpoint HarnessTest 65 251 8','effect give HarnessTest minecraft:slow_falling 10 0 true','effect give HarnessTest minecraft:instant_health 1 10 true','clear HarnessTest','tp HarnessTest 65.5 251 8.5','give HarnessTest minecraft:wooden_pickaxe 2','give HarnessTest minecraft:oak_log 4'])await rcon(command)
 await wait(()=>runner.bot.inventory.items().filter(i=>i.name==='wooden_pickaxe').length===2&&Math.abs(runner.position().x-65.5)<.1,'Fixture inventory or position not confirmed')
 assert.ok(!runner.bot.inventory.items().some(i=>i.name==='torch'))
 await wait(()=>runner.bot.entity.onGround&&runner.bot.health===20&&runner.bot.isAlive,'Fixture life/landing not confirmed')
 await rcon('effect clear HarnessTest minecraft:slow_falling')
 report.startedAt=new Date().toISOString()
 for(let i=0;i<5;i++){
  const result=await skill('prospect','cobblestone',14);report.trips.push(result)
  console.log(JSON.stringify({trip:i+1,result}))
  assert.equal(result.bootstrap,true);assert.equal(result.returned,true)
  assert.ok(result.broken<=48);assert.ok(result.steps<=32)
  if(result.acquired)break
  assert.ok(result.broken>0||result.steps>0,'A no-progress trip must not be treated as excavation progress')
  if(result.needs.some(n=>n.includes('pickaxe')))await skill('prepare','wooden_pickaxe',2)
 }
 assert.equal(report.trips.at(-1).acquired,true,'Starter stone target was not reached')
 report.serverStone=await rcon('data get entity HarnessTest Inventory[{id:"minecraft:cobblestone"}]')
 assert.match(report.serverStone,/count: (1[4-9]|[2-9][0-9])/)
 report.furnace=await skill('place','furnace',1)
 report.charcoal=await skill('smelt','charcoal',2)
 report.torches=await skill('acquire','torch',8)
 report.serverTorches=await rcon('data get entity HarnessTest Inventory[{id:"minecraft:torch"}]')
 assert.match(report.serverTorches,/count: (8|[1-9][0-9])/)
 report.inventory=runner.bot.inventory.items().map(i=>({name:i.name,count:i.count}))
 report.project=structuredClone(controller.projects.base);report.status='passed'
}catch(error){report.status='failed';report.error=error.stack;report.task=structuredClone(runner?.task);process.exitCode=1}
finally{runner?.close();report.endedAt=new Date().toISOString();writeFileSync(dir+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({path:dir+'/report.json',status:report.status,error:report.error}));setTimeout(()=>process.exit(process.exitCode||0),1000)}
