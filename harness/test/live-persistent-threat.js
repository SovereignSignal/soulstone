import mineflayer from 'mineflayer'
import {once} from 'node:events'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFileSync,writeFileSync} from 'node:fs'
import {setTimeout as delay} from 'node:timers/promises'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {shelterLayout} from '../src/shelter.js'
const run=promisify(execFile),host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const api=async(route,data)=>{const a=JSON.parse(readFileSync('state/companion-api.json'));const r=await fetch(a.url+route,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(8000)});assert.ok(r.ok);return r.json()}
const prefix='persistent-threat'
const report={status:'running',samples:[]},tag='harness_threat_'+Date.now();let observer,changed=false,interrupted=false
process.on('SIGINT',()=>interrupted=true);process.on('SIGTERM',()=>interrupted=true)
const point=p=>({x:p.x,y:p.y,z:p.z}),vec=p=>new Vec3(p.x,p.y,p.z)
const request='Leave through the shelter door, replenish spruce logs to at least 32 by harvesting natural trees with your stone axe, then collect at least sixteen total raw iron from natural ore using the saved mining route. Check hunger between actions, eat when hungry and replenish berries to at least 32. Preserve all diamonds, existing tools, buildings and base chest contents. Finish inside the lit primary base with its door closed.'
let lastPrint=0
function sample(s){const mob=Object.values(observer.entities).find(e=>e.name==='husk');const v={at:Date.now(),phase:s.phase,health:s.health,position:s.position,safety:s.safety?.status,continuation:s.safety?.continuation,threats:s.survival.nearbyThreats,mob:mob?{id:mob.id,position:point(mob.position)}:null};report.samples.push(v);if(Date.now()-lastPrint>15000){console.log(JSON.stringify(v));lastPrint=Date.now()}return v}
function spawnSite(s){
 const p=vec(s.position),owner=s.ownerPosition&&vec(s.ownerPosition),base=vec(s.projects.base.build.origin)
 if(p.distanceTo(base)<9)return null
 const candidates=[]
 for(let dx=-5;dx<=5;dx++)for(let dz=-5;dz<=5;dz++)for(const dy of [0,-1,1]){
  const q=p.floored().offset(dx,dy,dz),center=q.offset(.5,0,.5),d=center.distanceTo(p)
  if(d<3.5||d>4.8||owner&&center.distanceTo(owner)<12||center.distanceTo(base)<7)continue
  if(observer.blockAt(q)?.name!=='air'||observer.blockAt(q.offset(0,1,0))?.name!=='air'||observer.blockAt(q.offset(0,-1,0))?.boundingBox!=='block')continue
  const eye=center.offset(0,1.6,0),delta=p.offset(0,1.6,0).minus(eye)
  if(observer.world.raycast(eye,delta.normalize(),delta.norm()-.2))continue
  candidates.push(center)
 }
 return candidates.sort((a,b)=>b.distanceTo(base)-a.distanceTo(base))[0]
}

try{
 const before=report.before=await api('/state');assert.ok(before.connected&&before.phase==='ready'&&before.health===20&&(!before.safety||before.safety.status==='cancelled'));assert.match(await rcon('difficulty'),/Peaceful/);assert.match(await rcon('gamerule doMobSpawning'),/false/)
 writeFileSync(`results/${prefix}-before.json`,JSON.stringify(before,null,2));report.startedAt=Date.now();const connection=before.connectionId
 const prep='Smelt sixteen total charcoal using carried spruce logs and carried fuel. Preserve tools, diamonds, buildings and chest contents. Finish inside the lit primary base with its door closed.'
 let prepared=before.inventory.charcoal>=16&&before.inventory.spruce_log<32;if(!prepared)await api('/message',{text:prep})
 const prepDeadline=Date.now()+300000
 while(!prepared&&Date.now()<prepDeadline){assert.ok(!interrupted);const s=await api('/state');assert.equal(s.connectionId,connection);if(['ready','blocked'].includes(s.phase)){assert.equal(s.phase,'ready');assert.ok(s.inventory.charcoal>=16&&s.inventory.spruce_log<32);report.prepared=s;prepared=true;break}await delay(1000)}
 assert.ok(prepared,'Fuel preparation deadline');console.log('Fuel preparation complete')
 observer=mineflayer.createBot({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565),username:'HarnessWitness',version:'1.21.4',auth:'offline'})
 const spawned=once(observer,'spawn',{signal:AbortSignal.timeout(20000)});observer.on('error',e=>report.observerError=e.message);await spawned
 await rcon('gamemode spectator HarnessWitness');await rcon(`tp HarnessWitness ${before.position.x} ${before.position.y+5} ${before.position.z}`);await observer.waitForChunksToLoad()
 changed=true;await rcon('difficulty easy');await api('/message',{text:request});report.request=request
 let fired=false,spawnedAt=0,heldAt=0,pausedAt=0
 const deadline=Date.now()+420000
 while(Date.now()<deadline){
  assert.ok(!interrupted);const s=await api('/state');assert.equal(s.requestProgress.request,request);report.requestId??=s.requestProgress.id;assert.equal(s.requestProgress.id,report.requestId);assert.equal(s.connectionId,connection);assert.ok(s.connected&&s.health>12);assert.equal(s.survival.difficulty,'easy')
  if(!fired&&s.phase==='acting'&&s.task?.kind==='gather'&&s.task.status==='running'){
   const q=spawnSite(s);if(q){report.spawn=point(q);report.tag=tag;await rcon(`summon minecraft:husk ${q.x} ${q.y} ${q.z} {Tags:["${tag}"],PersistenceRequired:1b,CanPickUpLoot:0b,CanBreakDoors:0b,IsBaby:0b,NoAI:0b,DeathLootTable:"minecraft:empty"}`);fired=true;spawnedAt=Date.now();report.lootTable=await rcon(`data get entity @e[tag=${tag},limit=1] DeathLootTable`);assert.match(report.lootTable,/minecraft:empty/);console.log('Persistent fixture spawned')}
  }
  const v=sample(s)
  if(fired){
   assert.ok(!['failed','cancelled'].includes(s.safety?.status));assert.ok(!(s.requestProgress.safetyContinuations?.length))
   if(s.safety?.status==='sheltered'){
    if(!heldAt){heldAt=Date.now();report.fixtureHeld=await rcon(`data merge entity @e[tag=${tag},limit=1] {NoAI:1b}`)}assert.equal(s.phase,'blocked');assert.equal(s.requestProgress.status,'interrupted');assert.ok(s.canResume)
    const inside=shelterLayout(before.projects.base.build.design).inside.map(p=>vec(before.projects.base.build.origin).plus(p));assert.ok(inside.some(p=>p.equals(vec(s.position).floored())));assert.ok(v.mob&&vec(v.mob.position).distanceTo(vec(s.position))<24);assert.ok(!inside.some(p=>p.equals(vec(v.mob.position).floored())))
    if(s.safety.continuation?.status==='paused'){pausedAt||=Date.now();assert.match(s.safety.continuation.reason,/not established/);assert.ok(s.safety.continuation.endedAt-s.safety.continuation.startedAt>=90000);if(Date.now()-pausedAt>=10000){report.after=s;report.holdMs=Date.now()-heldAt;report.status='passed';break}}
   }else assert.ok(Date.now()-spawnedAt<45000,'Retreat exceeded encounter limit')
  }
  await delay(500)
 }
 assert.equal(report.status,'passed','Persistent threat test deadline')
}catch(e){report.status='failed';report.error=e.message;process.exitCode=1}
finally{
 try{if(changed){await rcon(`kill @e[tag=${tag}]`);report.mobRemoved=await rcon(`execute unless entity @e[tag=${tag}] run list`);await rcon('difficulty peaceful')}report.finalDifficulty=await rcon('difficulty')}catch(e){report.cleanupError=e.message;report.status='failed';process.exitCode=1}
 const s=await api('/state').catch(()=>null);if(s?.requestProgress?.request===request){await api('/stop',{});report.finalStop=true}report.endedAt=Date.now();observer?.quit();writeFileSync(`results/${prefix}-live.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,error:report.error,holdMs:report.holdMs,finalDifficulty:report.finalDifficulty}))
}
