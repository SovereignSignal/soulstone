import mineflayer from 'mineflayer'
import {once} from 'node:events'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFileSync,writeFileSync} from 'node:fs'
import {setTimeout as delay} from 'node:timers/promises'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {inspectConstructionShelter} from '../src/alternate-shelter.js'
import {shelterLayout} from '../src/shelter.js'
const run=promisify(execFile),host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const api=async(route,data)=>{const a=JSON.parse(readFileSync('state/companion-api.json'));const r=await fetch(a.url+route,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(8000)});assert.ok(r.ok);return r.json()}
const mode=process.env.MC_THREAT_CASE||'rear';assert.ok(['rear','front','blocked','fallback','occupied'].includes(mode))
const target=Number(process.env.MC_LOG_TARGET||12);assert.ok(Number.isInteger(target)&&target>0&&target<=32)
const prefix=mode==='rear'?'hostile':`hostile-${mode}`
let fixture=null
const report={mode,target,status:'running',samples:[]},tag='harness_threat_'+Date.now();let observer,changed=false,interrupted=false
process.on('SIGINT',()=>interrupted=true);process.on('SIGTERM',()=>interrupted=true)
const point=p=>({x:p.x,y:p.y,z:p.z}),vec=p=>new Vec3(p.x,p.y,p.z)
const request=`Leave the base through its door, collect until you carry at least ${target} spruce logs from natural trees, then retreat inside the lit base and close its door. Preserve food, tools, all diamonds, existing buildings and base storage.`
let lastPrint=0
function sample(s){const mob=Object.values(observer.entities).find(e=>e.name==='husk');const v={at:Date.now(),phase:s.phase,health:s.health,position:s.position,safety:s.safety?.status,threats:s.survival.nearbyThreats,mob:mob?{id:mob.id,position:point(mob.position)}:null};report.samples.push(v);if(Date.now()-lastPrint>15000){console.log(JSON.stringify(v));lastPrint=Date.now()}return v}
function spawnSite(s){
 if(mode==='occupied'){
  const o=vec(s.projects.base.build.origin),layout=shelterLayout(s.projects.base.build.design),door=o.plus(layout.door),p=vec(s.position)
  if(layout.inside.some(q=>o.plus(q).equals(p.floored()))||observer.blockAt(door)?.getProperties().open!==false)return null
  return layout.inside.map(q=>o.plus(q)).filter(q=>observer.blockAt(q)?.name==='air'&&observer.blockAt(q.offset(0,1,0))?.name==='air').map(q=>q.offset(.5,0,.5)).find(q=>q.distanceTo(p)>=2.5&&q.distanceTo(p)<=5&&(!s.ownerPosition||q.distanceTo(vec(s.ownerPosition))>=12))
 }
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
 return candidates.filter(q=>mode==='rear'||q.minus(p).dot(base.minus(p))>0).sort((a,b)=>mode==='rear'?b.distanceTo(base)-a.distanceTo(base):a.distanceTo(base)-b.distanceTo(base))[0]
}
async function restore(){if(fixture){const q=fixture;report.fixtureRemoved=await rcon(`execute if block ${q.x} ${q.y} ${q.z} minecraft:glass run setblock ${q.x} ${q.y} ${q.z} minecraft:air`);assert.match(await rcon(`execute if block ${q.x} ${q.y} ${q.z} minecraft:air run list`),/players online/);fixture=null}if(changed){report.restore=await rcon('difficulty peaceful');changed=false;report.mobRemoved=await rcon(`execute unless entity @e[tag=${tag}] run list`);assert.match(report.mobRemoved,/players online/)} }
try{
 const before=report.before=await api('/state');assert.ok(before.connected&&['ready','blocked'].includes(before.phase)&&before.health===20&&(!before.safety||before.safety.status==='cancelled'));assert.ok(before.inventory.spruce_log<target);assert.match(await rcon('difficulty'),/Peaceful/);assert.match(await rcon('gamerule doMobSpawning'),/false/);assert.match(await rcon('gamerule doDaylightCycle'),/false/)
 writeFileSync(`results/${prefix}-before.json`,JSON.stringify(before,null,2));const connection=before.connectionId
 observer=mineflayer.createBot({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565),username:'HarnessWitness',version:'1.21.4',auth:'offline'})
 observer.on('error',e=>{report.observerError=e.message})
 await once(observer,'spawn');await rcon('gamemode spectator HarnessWitness');await rcon(`tp HarnessWitness ${before.position.x} ${before.position.y+5} ${before.position.z}`);await observer.waitForChunksToLoad();await delay(1000)
 await api('/message',{text:request});report.request=request
 let fired=false,spawnedAt=0,shelteredAt=0,completed=false
 const deadline=Date.now()+600000
 while(Date.now()<deadline){
  assert.ok(!interrupted,'Operator interrupted drill');let s=await api('/state');assert.equal(s.requestProgress.request,request,'Request superseded');report.requestId??=s.requestProgress.id;assert.equal(s.requestProgress.id,report.requestId);assert.ok(s.connected&&s.connectionId===connection,'Bot connection changed')
  if(!fired&&s.phase==='acting'&&s.task?.kind==='gather'&&s.task.status==='running'){
   let q=spawnSite(s)
   if(q){changed=true;await rcon('difficulty easy');s=await api('/state');q=spawnSite(s)
    if(q&&s.task?.kind==='gather'&&s.task.status==='running'){
     if(['blocked','fallback'].includes(mode)){
      const layout=shelterLayout(s.projects.base.build.design)
      const f=vec(s.projects.base.build.origin).plus(layout.door).plus(layout.out)
      assert.equal(observer.blockAt(f)?.name,'air','Fixture requires untouched air')
      assert.ok(Object.values(observer.entities).filter(e=>e.type==='player').every(e=>e.position.distanceTo(f.offset(.5,0,.5))>3),'Player near fixture')
      fixture=f;report.fixture=point(f)
      assert.match(await rcon(`execute if block ${f.x} ${f.y} ${f.z} minecraft:air run setblock ${f.x} ${f.y} ${f.z} minecraft:glass`),/Changed/)
     }
     report.triggerBefore=s;report.spawn=point(q);report.tag=tag
     report.summon=await rcon(`summon minecraft:husk ${q.x} ${q.y} ${q.z} {Tags:["${tag}"],PersistenceRequired:1b,CanPickUpLoot:0b,CanBreakDoors:0b,IsBaby:0b,NoAI:0b}`)
     assert.match(report.summon,/Summoned/);fired=true;spawnedAt=Date.now();console.log('Spawned one active adult husk at '+q)
    }else await restore()
   }
  }
  const v=sample(s)
  if(mode==='occupied'&&fired&&v.mob){
   const layout=shelterLayout(before.projects.base.build.design),o=vec(before.projects.base.build.origin)
   assert.ok([...layout.inside,layout.door].some(q=>o.plus(q).equals(vec(v.mob.position).floored())),'Hostile left the compromised primary room')
  }
  if(fired){
   assert.ok(s.health>12,'Health safety cutoff; ending encounter')
   assert.ok(Date.now()-spawnedAt<45000,'45-second encounter cutoff')
   if(mode==='blocked'&&s.safety?.status==='failed'){
    report.recovery=s;assert.match(JSON.stringify(s.safety),/access obstructed/);assert.equal(s.requestProgress.status,'interrupted');assert.ok(s.canResume);assert.ok(!s.safety.retreat)
    await restore();completed=true;break
   }
   assert.ok(!['failed','cancelled'].includes(s.safety?.status),JSON.stringify(s.safety))
   if(s.safety?.status==='sheltered'){
    shelteredAt||=Date.now();report.recovery??=s
    if(['fallback','occupied'].includes(mode)){
     assert.ok(s.safety.retreat.shelterName&&s.safety.retreat.shelterName!=='base','Primary base incorrectly accepted')
     assert.ok(s.safety.attempts.some(a=>a.name==='base'&&a.status==='rejected'&&(mode==='occupied'?/contains a potential hostile/:/access obstructed/).test(a.reason)))
     assert.deepEqual(s.projects.base.build,before.projects.base.build,'Fallback replaced primary base')
     assert.deepEqual(s.projects.base.stations,before.projects.base.stations,'Fallback changed base storage')
     const name=s.safety.retreat.shelterName,room=inspectConstructionShelter(observer,{name,construction:s.projects[name].construction})
     assert.ok(room.cells.some(p=>p.equals(vec(s.position).floored())),'Bot is outside selected fallback')
     assert.equal(observer.blockAt(room.door.position).getProperties().open,false)
     report.fallback={name,inside:room.inside,door:room.door.position,cells:room.cells}
    }
    assert.equal(s.requestProgress.status,'interrupted');assert.ok(s.canResume)
    assert.ok(vec(s.position).distanceTo(vec(s.safety.retreat.position))<1,'Bot left shelter during hold')
    if(Date.now()-shelteredAt>=8000){
     report.holdAfter=s;report.activeMob=await rcon(`data get entity @e[tag=${tag},limit=1] Pos`);assert.match(report.activeMob,/entity data/)
     assert.ok(report.samples.some(x=>x.threats.some(t=>t.name==='husk'&&t.distance<=6)),'Husk not observed in trigger range')
     const positions=report.samples.filter(x=>x.mob).map(x=>vec(x.mob.position));if(mode!=='occupied')assert.ok(positions.length>2&&positions.some(p=>p.distanceTo(positions[0])>.5),'No observed mob movement')
     await restore();completed=true;break
    }
   }
  }else if(['ready','blocked'].includes(s.phase))throw new Error('Request ended before a safe spawn opportunity')
  await delay(150)
 }
 assert.ok(completed,'No completed encounter');await api('/resume',{});console.log('Encounter cleared; resuming the same gathering request')
 const resumeDeadline=Date.now()+600000
 while(Date.now()<resumeDeadline){
  assert.ok(!interrupted);const s=await api('/state');assert.equal(s.requestProgress.id,report.requestId);assert.ok(s.connected&&s.connectionId===connection)
  sample(s)
  if(['ready','blocked'].includes(s.phase)){
   report.after=s;assert.equal(s.phase,'ready',s.messages.at(-1).text);assert.ok(s.inventory.spruce_log>=target);assert.equal(s.inventory.diamond,before.inventory.diamond)
   assert.ok(s.requestProgress.verification.checks.some(c=>c.kind==='sheltered'&&c.passed));report.status='passed';break
  }
  await delay(1000)
 }
 assert.equal(report.status,'passed','Resume timed out')
}catch(e){report.status='failed';report.error=e.message;process.exitCode=1}
finally{
 try{await restore();report.finalDifficulty=await rcon('difficulty');assert.match(report.finalDifficulty,/Peaceful/)}catch(e){report.cleanupError=e.message;report.status='failed';process.exitCode=1}
 observer?.quit();writeFileSync(`results/${prefix}-recovery-live.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,error:report.error,finalDifficulty:report.finalDifficulty}))
}
