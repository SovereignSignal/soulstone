import mineflayer from 'mineflayer'
import pathfinding from 'mineflayer-pathfinder'
import {once} from 'node:events'
import {readFileSync,writeFileSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import {Vec3} from 'vec3'
import assert from 'node:assert/strict'
import {DoorAwareMovements} from '../src/navigation.js'
import {walkWithTerrainRecovery} from '../src/route-recovery.js'
const host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const run=promisify(execFile),rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c+"'"],{timeout:15000})).stdout.trim()
const state=async()=>{const a=JSON.parse(readFileSync('state/companion-api.json'));return (await fetch(a.url+'/state',{headers:{Authorization:'Bearer '+a.token}})).json()}
const before=await state(),report={status:'running',cases:[],fixture:{min:[499,250,1000],max:[507,253,1002]}};let placed=false,pending=Promise.resolve(),stopped=false
const bot=mineflayer.createBot({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565),username:'HarnessWitness',version:'1.21.4',auth:'offline'})
const spawned=once(bot,'spawn',{signal:AbortSignal.timeout(20000)})
bot.loadPlugin(pathfinding.pathfinder)
const start=new Vec3(501,251,1001),goal=new pathfinding.goals.GoalBlock(505,251,1001)
try{
 assert.equal(before.phase,'ready');assert.match(await rcon('difficulty'),/Peaceful/)
 await spawned;await rcon('gamemode spectator HarnessWitness');await rcon('tp HarnessWitness 501.5 251 1001.5');await bot.waitForChunksToLoad()
 for(let x=499;x<=507;x++)for(let y=250;y<=253;y++)for(let z=1000;z<=1002;z++)assert.equal(bot.blockAt(new Vec3(x,y,z))?.name,'air','Fixture must start entirely empty')
 placed=true
 for(const c of ['fill 499 250 1000 507 253 1002 stone','fill 500 251 1001 506 252 1001 air','fill 503 251 1001 503 252 1001 glass'])await rcon(c)
 await rcon('gamemode survival HarnessWitness');await rcon('tp HarnessWitness 501.5 251 1001.5');await bot.waitForChunksToLoad();await delay(1000);assert.ok(bot.entity.onGround&&bot.entity.position.distanceTo(start.offset(.5,0,.5))<.3,'Witness must start grounded on the fixture');assert.equal(bot.blockAt(start.offset(0,-1,0))?.name,'stone')
 const baselineListeners=bot.listenerCount('blockUpdate');const m=new DoorAwareMovements(bot);m.canDig=false;m.allowParkour=false;m.allow1by1towers=false;m.allowSprinting=false;m.scafoldingBlocks=[];m.maxDropDown=1;bot.pathfinder.thinkTimeout=2000
 for(const mode of ['unchanged','changed','stop']){
  stopped=false;const rec={mode,records:[],healthBefore:bot.health};report.cases.push(rec)
  const options={movements:m,check(){if(stopped)throw new Error('Cancelled')},stage(){},progress:message=>console.log(mode+': '+message),waitMs:mode==='unchanged'?1200:30000,onRecovery:r=>{
   rec.records.push(r)
   if(r.status==='waiting')pending=(async()=>{await delay(1500);if(mode==='changed')rec.gateRemoval=await rcon('fill 503 251 1001 503 252 1001 air');if(mode==='stop')stopped=true})()
  }}
  const began=Date.now()
  if(mode==='changed'){
   await walkWithTerrainRecovery(bot,goal,options);assert.ok(goal.isEnd(bot.entity.position.floored()));assert.equal(rec.records.at(-1).status,'recovered')
  }else{
   await assert.rejects(walkWithTerrainRecovery(bot,goal,options),mode==='stop'?/Cancelled/:/No path|without reaching|time/i)
   rec.blockedPosition=bot.entity.position.clone();assert.ok(bot.entity.position.x<503&&bot.entity.position.y>=251&&bot.entity.position.y<252,'Witness crossed the blocked passage');assert.ok(!rec.records.some(r=>r.status==='recovered'))
  }
  await pending;rec.elapsedMs=Date.now()-began;rec.healthAfter=bot.health;rec.position=bot.entity.position.clone();assert.equal(bot.health,rec.healthBefore)
  assert.equal(bot.listenerCount('blockUpdate'),baselineListeners,'Recovery listener leaked beyond the pathfinder listener')
  if(mode==='changed'){
   await walkWithTerrainRecovery(bot,new pathfinding.goals.GoalBlock(start.x,start.y,start.z),{...options,onRecovery(){}})
   await rcon('fill 503 251 1001 503 252 1001 glass');await delay(300)
  }
 }
 report.status='passed'
}catch(e){report.status='failed';report.error=e.message;process.exitCode=1}
finally{
 await pending.catch(()=>{})
 try{
  await rcon('gamemode spectator HarnessWitness')
  if(placed){await rcon('fill 499 250 1000 507 253 1002 air');await delay(300);for(let x=499;x<=507;x++)for(let y=250;y<=253;y++)for(let z=1000;z<=1002;z++)assert.equal(bot.blockAt(new Vec3(x,y,z))?.name,'air');report.fixtureRemoved=true}
  const after=await state();assert.equal(after.connectionId,before.connectionId);assert.equal(after.requestProgress.id,before.requestProgress.id);assert.deepEqual(after.inventory,before.inventory);assert.deepEqual(after.projects,before.projects);report.mainBotPreserved=true
 }catch(e){report.cleanupError=e.message;report.status='failed';process.exitCode=1}
 bot.quit();writeFileSync('results/route-recovery-live.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report))
}
