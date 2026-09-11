import {readFileSync,writeFileSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {shelterLayout} from '../src/shelter.js'
const run=promisify(execFile),host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const api=async(route,data)=>{const a=JSON.parse(readFileSync('state/companion-api.json'));const r=await fetch(a.url+route,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(8000)});assert.ok(r.ok);return r.json()}
const report={status:'running',samples:[],server:[]},request='Prepare for our first night with natural monsters enabled on Easy. Craft at least 48 spruce planks from carried logs, then replenish spruce logs to at least 32 and smelt until carrying twelve iron ingots from carried raw iron using carried fuel. Check hunger and eat or replenish berries if needed. Preserve all diamonds, tools, buildings and base chest contents. Return inside the verified lit primary base and close its door before night. Stay sheltered after completing these preparations; do not seek combat or begin another expedition.'
let changed=false,interrupted=false,lastServer=0,nightSeen=false,cycleDone=false,lastPrint=0
process.on('SIGINT',()=>interrupted=true);process.on('SIGTERM',()=>interrupted=true)
const time=async()=>Number((await rcon('time query gametime')).match(/is (\d+)/)?.[1])
try{
 const b=report.before=await api('/state');assert.ok(b.connected&&['ready','blocked'].includes(b.phase)&&b.health===20);assert.match(await rcon('difficulty'),/Peaceful/)
 report.initialRules={spawning:await rcon('gamerule doMobSpawning'),daylight:await rcon('gamerule doDaylightCycle'),daytime:await rcon('time query daytime'),mobGriefing:await rcon('gamerule mobGriefing')};assert.match(report.initialRules.spawning,/false/);assert.match(report.initialRules.daylight,/false/)
 writeFileSync('results/day-night-before.json',JSON.stringify(b,null,2))
 changed=true;await rcon('time set 0');await rcon('difficulty easy');await rcon('gamerule doMobSpawning true');await rcon('gamerule doDaylightCycle true');report.startTick=await time();assert.ok(Number.isFinite(report.startTick));report.startedAt=Date.now()
 await api('/message',{text:request});report.request=request
 const inside=shelterLayout(b.projects.base.build.design).inside.map(p=>new Vec3(b.projects.base.build.origin.x,b.projects.base.build.origin.y,b.projects.base.build.origin.z).plus(p).toString())
 while(Date.now()-report.startedAt<1560000){
  assert.ok(!interrupted,'Operator interrupted trial');const s=await api('/state');assert.ok(s.connected&&s.connectionId===b.connectionId,'Connection changed');assert.ok(s.health>12,'Health cutoff');assert.equal(s.survival.difficulty,'easy');assert.equal(s.requestProgress.request,request,'Request superseded');report.requestId??=s.requestProgress.id;assert.equal(s.requestProgress.id,report.requestId)
  const sheltered=inside.includes(new Vec3(s.position.x,s.position.y,s.position.z).floored().toString());const v={at:Date.now(),phase:s.phase,position:s.position,health:s.health,food:s.survival.food,timeOfDay:s.survival.timeOfDay,sheltered,safety:s.safety,threats:s.survival.nearbyThreats,inventory:s.inventory,task:s.task?.kind};report.samples.push(v)
  assert.ok(!['failed','cancelled'].includes(s.safety?.status),'Safety recovery failed or cancelled')
  if(s.phase==='blocked'&&!sheltered)throw new Error('Work blocked outside shelter')
  if(v.timeOfDay>=13000&&v.timeOfDay<=23000)nightSeen=true
  if(Date.now()-lastServer>=30000){const tick=await time();report.server.push({at:Date.now(),tick,daytime:await rcon('time query daytime')});lastServer=Date.now();assert.ok(Number.isFinite(tick));if(tick-report.startTick>=24000){cycleDone=true;report.endTick=tick}}
  if(Date.now()-lastPrint>=30000){console.log(JSON.stringify({elapsedSeconds:Math.round((Date.now()-report.startedAt)/1000),...v,inventory:undefined,safety:s.safety?.status}));lastPrint=Date.now();writeFileSync('results/day-night-progress.json',JSON.stringify({status:report.status,last:v,nightSeen,cycleDone,sampleCount:report.samples.length},null,2))}
  if(cycleDone){assert.ok(nightSeen,'No observed night');assert.ok(sheltered,'Not home at end of cycle');assert.ok(['ready','blocked'].includes(s.phase),'Work still active at end of cycle');assert.ok(s.inventory.spruce_log>=32&&s.inventory.iron_ingot>=12&&s.inventory.spruce_planks>=48&&s.inventory.sweet_berries>=32);assert.equal(s.inventory.diamond,b.inventory.diamond);report.after=s;report.foodAfter={food:await rcon('data get entity HarnessRunner foodLevel'),saturation:await rcon('data get entity HarnessRunner foodSaturationLevel')};report.status='passed';break}
  await delay(1000)
 }
 assert.equal(report.status,'passed','Full cycle exceeded 26-minute limit')
}catch(e){report.status='failed';report.error=e.message;process.exitCode=1}
finally{
 try{if(changed){await rcon('difficulty peaceful');await rcon('gamerule doMobSpawning false');await rcon('gamerule doDaylightCycle false');await rcon('time set 6000')}report.finalRules={difficulty:await rcon('difficulty'),spawning:await rcon('gamerule doMobSpawning'),daylight:await rcon('gamerule doDaylightCycle'),daytime:await rcon('time query daytime')}}catch(e){report.cleanupError=e.message;report.status='failed';process.exitCode=1}
 const s=await api('/state').catch(()=>null);if(s?.requestProgress?.request===request&&['thinking','acting','retreating'].includes(s.phase)){await api('/stop',{});report.operatorStop=true}report.endedAt=Date.now();report.nightSeen=nightSeen;writeFileSync('results/day-night-live.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,error:report.error,durationSeconds:(report.endedAt-report.startedAt)/1000,finalRules:report.finalRules}))
}
