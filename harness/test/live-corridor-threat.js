import {readFileSync,writeFileSync,appendFileSync,mkdirSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import assert from 'node:assert/strict'
import {shelterLayout} from '../src/shelter.js'

const run=promisify(execFile),host=process.env.MC_SSH_HOST
assert.match(host,/^[\w.-]+$/)
const rcon=async command=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+command.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const api=async(route,data)=>{
 const config=JSON.parse(readFileSync('state/companion-api.json'))
 const response=await fetch(config.url+route,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(8000)})
 const body=await response.json();assert.ok(response.ok,body.error);return body
}

const directory='results/corridor-threat-'+Date.now();mkdirSync(directory,{recursive:true})
const report={status:'running',directory,startedAt:Date.now(),samples:[]},file=directory+'/report.json',sampleFile=directory+'/samples.jsonl'
const tag='harness_corridor_threat_'+Date.now();let changed=false,fixture=false,interrupted=false,lastPrint=0
process.on('SIGINT',()=>interrupted=true);process.on('SIGTERM',()=>interrupted=true)
const key=p=>`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
const save=()=>writeFileSync(file,JSON.stringify(report,null,2))
const sample=s=>{
 const value={at:Date.now(),phase:s.phase,health:s.health,food:s.survival.food,position:s.position,threats:s.survival.nearbyThreats,safety:s.safety?.status,session:s.survivalSession&&{status:s.survivalSession.status,mode:s.survivalSession.mode,reason:s.survivalSession.reason,jobs:s.survivalSession.jobs?.length||0,cycles:s.survivalSession.completedCycles}}
 report.samples.push(value);appendFileSync(sampleFile,JSON.stringify(value)+'\n')
 if(Date.now()-lastPrint>15000){console.log(JSON.stringify(value));lastPrint=Date.now()}
 return value
}

try{
 report.before=await api('/state');assert.ok(report.before.connected&&report.before.phase==='ready'&&report.before.health===20&&!report.before.safety)
 assert.match(await rcon('difficulty'),/Peaceful/)
 assert.match(await rcon('gamerule doMobSpawning'),/false/)
 assert.match(await rcon('gamerule doDaylightCycle'),/false/)
 assert.match(await rcon('time query daytime'),/6000/)
 report.rules={difficulty:await rcon('difficulty'),spawning:await rcon('gamerule doMobSpawning'),daylight:await rcon('gamerule doDaylightCycle'),time:await rcon('time query daytime')}
 const base=report.before.projects.base.build,layout=shelterLayout(base.design),origin=base.origin
 const door={x:origin.x+layout.door.x,y:origin.y+layout.door.y,z:origin.z+layout.door.z}
 // Nearby castle blocks occupy the level ground beyond the approach. Use a
 // verified air pocket within the corridor buffer; NoGravity holds this
 // detection fixture above terrain, outside the six-block emergency rule.
 const across={x:layout.out.z,z:-layout.out.x}
 const corridor={x:door.x+0.5+layout.out.x*4+across.x*2,y:door.y+3,z:door.z+0.5+layout.out.z*4+across.z*2}
 const separation=Math.hypot(corridor.x-report.before.position.x,corridor.y-report.before.position.y,corridor.z-report.before.position.z)
 assert.ok(separation>6.1&&separation<24,'Fixture must isolate departure clearance from the emergency radius')
 const headroom=await rcon(`execute if block ${Math.floor(corridor.x)} ${corridor.y} ${Math.floor(corridor.z)} minecraft:air if block ${Math.floor(corridor.x)} ${corridor.y+1} ${Math.floor(corridor.z)} minecraft:air run list`)
 assert.match(headroom,/players online/,'Fixture needs two clear air blocks')
 report.fixture={tag,entity:corridor,distanceFromBot:separation,noAI:true,noGravity:true,headroom}
 const inside=new Set(layout.inside.map(p=>key({x:origin.x+p.x,y:origin.y+p.y,z:origin.z+p.z})))
 report.inside=[...inside]
 changed=true
 save();await rcon('time set 1000');await rcon('difficulty easy');await rcon('gamerule doDaylightCycle true');await delay(1500)
 fixture=true
 const summon=await rcon(`summon minecraft:husk ${corridor.x} ${corridor.y} ${corridor.z} {Tags:["${tag}"],PersistenceRequired:1b,CanPickUpLoot:0b,CanBreakDoors:0b,IsBaby:0b,NoAI:1b,NoGravity:1b,DeathLootTable:"minecraft:empty"}`)
 assert.match(summon,/Summoned/);report.summon=summon;report.fixtureData=await rcon(`data get entity @e[tag=${tag},limit=1] Pos`);assert.match(report.fixtureData,/entity data/)
 report.session=await api('/survival-session',{days:1});save();console.log(JSON.stringify({directory,session:report.session.id,fixture:report.fixture,status:'started'}))
 const deadline=Date.now()+420000
 while(Date.now()<deadline){
  assert.ok(!interrupted,'Trial interrupted by operator')
  const s=await api('/state'),session=s.survivalSession
  const v=sample(s)
  assert.ok(s.survival.nearbyThreats.some(t=>t.name==='husk'&&Math.hypot(t.position.x-corridor.x,t.position.y-corridor.y,t.position.z-corridor.z)<0.05),'Stationary fixture disappeared or moved; clearance test is invalid')
  assert.ok(s.connected&&s.connectionId===report.before.connectionId,'Connection changed')
  assert.equal(session.id,report.session.id,'Session superseded')
  assert.equal(s.health,20,'Stationary clearance fixture must not cause damage')
  assert.equal(s.survival.food,report.before.survival.food,'Food changed while idle in shelter')
  assert.equal(s.requestProgress?.id,report.before.requestProgress?.id,'Clearance gate dispatched a new request')
  assert.equal(s.requestProgress?.status,report.before.requestProgress?.status,'Previous request status changed')
  assert.deepEqual(s.inventory,report.before.inventory,'Inventory changed without authorized work')
  assert.ok(!s.safety,'Emergency rule preempted the departure gate')
  assert.equal(s.survival.difficulty,'easy')
  if(session.status==='blocked'){
   report.after=s
   assert.match(session.reason,/Morning area did not become clear within four minutes/)
   assert.equal(session.jobs.length,0)
   assert.ok(session.completedCycles===0)
   const held=report.samples.filter(x=>x.session?.mode==='morning_check'&&/departure corridor/.test(x.session.reason))
   assert.ok(held.length>200&&held.at(-1).at-held[0].at>=239000,'No sustained four-minute corridor hold observed')
   assert.ok(held.every(x=>x.threats.some(t=>t.name==='husk'&&t.distance>6)),'Fixture was not continuously observed outside the emergency radius')
   report.fixtureAfter=await rcon(`data get entity @e[tag=${tag},limit=1] Pos`)
   assert.equal(report.fixtureAfter,report.fixtureData,'Fixture moved or disappeared')
   assert.ok(inside.has(key(s.position)),`Bot left the base: ${key(s.position)}`)
   assert.ok(report.samples.filter(x=>x.session?.status==='running').every(x=>inside.has(key(x.position))), 'Bot moved outside while corridor was blocked')
   report.status='passed';break
  }
  assert.equal(session.status,'running',session.reason)
  assert.ok(inside.has(key(v.position)),`Bot left the base before block: ${key(v.position)}`)
  await delay(1000)
 }
 assert.equal(report.status,'passed','Corridor threat did not produce a bounded block')
}catch(error){report.status='failed';report.error=error.stack||error.message;process.exitCode=1}
finally{
 try{
  if(report.session){const s=await api('/state').catch(()=>null);if(s?.survivalSession?.id===report.session.id&&s.survivalSession.status==='running')await api('/stop',{}).catch(()=>null)}
  if(fixture){report.mobRemoved=await rcon(`kill @e[tag=${tag}]`);assert.match(await rcon(`execute unless entity @e[tag=${tag}] run list`),/players online/)}
  if(changed){await rcon('difficulty peaceful');await rcon('gamerule doMobSpawning false');await rcon('gamerule doDaylightCycle false');await rcon('time set 6000')}
  report.finalRules={difficulty:await rcon('difficulty'),spawning:await rcon('gamerule doMobSpawning'),daylight:await rcon('gamerule doDaylightCycle'),time:await rcon('time query daytime')}
  assert.match(report.finalRules.difficulty,/Peaceful/);assert.match(report.finalRules.spawning,/false/);assert.match(report.finalRules.daylight,/false/);assert.match(report.finalRules.time,/6000/)
 }catch(error){report.cleanupError=error.stack||error.message;report.status='failed';process.exitCode=1}
 report.finalState=await api('/state').catch(()=>null);report.endedAt=Date.now();save()
 console.log(JSON.stringify({status:report.status,error:report.error,cleanupError:report.cleanupError,directory,durationSeconds:(report.endedAt-report.startedAt)/1000,finalRules:report.finalRules}))
}
