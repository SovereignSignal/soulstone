import {readFileSync,writeFileSync,appendFileSync,mkdirSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import assert from 'node:assert/strict'
import {morningGoal} from '../src/companion/day-routine.js'
const run=promisify(execFile),host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const api=async(route,data)=>{const a=JSON.parse(readFileSync('state/companion-api.json'));const response=await fetch(a.url+route,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(8000)});const body=await response.json();assert.ok(response.ok,body.error);return body}
const directory='results/multi-day-'+Date.now();mkdirSync(directory,{recursive:true})
const days=Number(process.env.MC_SURVIVAL_DAYS||2);assert.ok(Number.isInteger(days)&&days>=1&&days<=3,'MC_SURVIVAL_DAYS must be 1–3')
const report={status:'running',directory,startedAt:Date.now(),server:[],samples:0,manualRescues:0,expectedDays:days},file=directory+'/report.json'
const save=()=>writeFileSync(file,JSON.stringify(report,null,2))
let changed=false,interrupted=false,lastPrint=0,lastServer=0
process.on('SIGINT',()=>interrupted=true);process.on('SIGTERM',()=>interrupted=true)
try{
 report.before=await api('/state');assert.ok(report.before.connected&&report.before.phase==='ready'&&report.before.health===20&&!report.before.safety)
 const projected=structuredClone(report.before)
 for(let day=0;day<days;day++){
  const target=morningGoal(projected,report.before.projects.base.build.wood)
  assert.ok(target.boards>(projected.inventory[target.planks]||0),'Store surplus planks before this active-resupply trial; each morning must have room below the reserve cap')
  projected.inventory[target.planks]=target.boards
 }
 report.requiresInventoryWork=true
 report.rules={difficulty:await rcon('difficulty'),spawning:await rcon('gamerule doMobSpawning'),daylight:await rcon('gamerule doDaylightCycle'),time:await rcon('time query daytime'),mobGriefing:await rcon('gamerule mobGriefing')}
 assert.match(report.rules.difficulty,/Peaceful/);assert.match(report.rules.spawning,/false/);assert.match(report.rules.daylight,/false/);assert.match(report.rules.time,/6000/)
 changed=true;save();await rcon('time set 0');await rcon('difficulty easy');await rcon('gamerule doMobSpawning true');await rcon('gamerule doDaylightCycle true');await delay(2500)
 report.session=await api('/survival-session',{days});save();console.log(JSON.stringify({directory,session:report.session.id,status:'started',days}))
 while(Date.now()-report.startedAt<(days*24+10)*60000){
  assert.ok(!interrupted,'Trial interrupted by operator')
  const s=await api('/state'),session=s.survivalSession
  assert.ok(s.connected&&s.connectionId===report.before.connectionId,'Connection changed');assert.ok(s.health>12,'Health cutoff');assert.equal(s.survival.difficulty,'easy');assert.equal(session.id,report.session.id,'Session superseded')
  const sample={at:Date.now(),health:s.health,food:s.survival.food,time:s.survival.timeOfDay,position:s.position,phase:s.phase,inventory:s.inventory,threats:s.survival.nearbyThreats,safety:s.safety?.status,requestId:s.requestProgress?.id,session:{status:session.status,mode:session.mode,reason:session.reason,cycles:session.completedCycles,jobs:session.jobs.length}}
  appendFileSync(directory+'/samples.jsonl',JSON.stringify(sample)+'\n');report.samples++;report.last=sample
  if(Date.now()-lastServer>30000){report.server.push({at:Date.now(),time:await rcon('time query daytime'),tick:await rcon('time query gametime')});lastServer=Date.now();save()}
  if(Date.now()-lastPrint>30000){console.log(JSON.stringify(sample));lastPrint=Date.now()}
  if(session.status!=='running'){report.after=s;assert.equal(session.status,'completed',session.reason);assert.equal(session.jobs.length,days);assert.ok(session.completedCycles>=days);report.status='passed';break}
  await delay(1000)
 }
 assert.equal(report.status,'passed','Trial exceeded duration limit')
 report.foodAfter={food:await rcon('data get entity HarnessRunner foodLevel'),saturation:await rcon('data get entity HarnessRunner foodSaturationLevel')}
}catch(e){report.status='failed';report.error=e.message;process.exitCode=1}
finally{
 try{if(changed){await rcon('difficulty peaceful');await rcon('gamerule doMobSpawning false');await rcon('gamerule doDaylightCycle false');await rcon('time set 6000')}report.finalRules={difficulty:await rcon('difficulty'),spawning:await rcon('gamerule doMobSpawning'),daylight:await rcon('gamerule doDaylightCycle'),time:await rcon('time query daytime')}}catch(e){report.cleanupError=e.message;report.status='failed';process.exitCode=1}
 const s=await api('/state').catch(()=>null)
 if(s?.survivalSession?.id===report.session?.id&&(s.survivalSession.status==='running'||['thinking','acting','retreating'].includes(s.phase))){await api('/stop',{});report.operatorStop=true}
 report.finalState=await api('/state').catch(()=>null);report.endedAt=Date.now();save();console.log(JSON.stringify({status:report.status,error:report.error,directory,durationSeconds:(report.endedAt-report.startedAt)/1000,finalRules:report.finalRules}))
}
