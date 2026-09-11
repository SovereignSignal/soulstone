import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import assert from 'node:assert/strict'
import {serverChest} from './server-chest.js'

const run=promisify(execFile),host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const api=async(route,data)=>{
 const a=JSON.parse(readFileSync('state/companion-api.json'))
 const r=await fetch(a.url+route,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(8000)})
 const body=await r.json();assert.ok(r.ok,body.error);return body
}
const directory='results/resupply-preparation-'+Date.now();mkdirSync(directory,{recursive:true})
const report={status:'running',directory,startedAt:Date.now()},save=()=>writeFileSync(directory+'/report.json',JSON.stringify(report,null,2))
let interrupted=false
process.on('SIGINT',()=>interrupted=true);process.on('SIGTERM',()=>interrupted=true)
try{
 const before=report.before=await api('/state')
 assert.ok(before.connected&&before.phase==='ready'&&before.health===20)
 assert.equal(before.survival.difficulty,'peaceful');assert.ok(before.survivalSession?.status!=='running')
 const position=before.projects.base.stations.chest.position
 report.chestBefore=await serverChest(rcon,position)
 assert.equal(report.chestBefore.contents.spruce_planks||0,0,'This one-time preparation expects no stored spruce planks')
 assert.ok(before.inventory.spruce_planks>=80,'Insufficient surplus to prepare two morning tasks')
 const request='Put 64 of my currently carried spruce planks into the primary base chest, so the chest contains 64 spruce planks and I retain the remaining planks. Preserve every other chest item, my tools, food, all diamonds and existing buildings. Return inside the lit primary base and close its door. Do not gather or craft during this storage task.'
 report.request=request;save();await api('/message',{text:request})
 const deadline=Date.now()+300000
 while(Date.now()<deadline){
  assert.ok(!interrupted,'Preparation interrupted')
  const s=await api('/state');assert.ok(s.connected&&s.connectionId===before.connectionId)
  assert.equal(s.requestProgress?.request,request,'Request superseded');assert.equal(s.health,20)
  if(['ready','blocked'].includes(s.phase)){
   report.after=s;assert.equal(s.phase,'ready',s.requestProgress?.blocker)
   report.chestAfter=await serverChest(rcon,position)
   assert.deepEqual(report.chestAfter.contents,{...report.chestBefore.contents,spruce_planks:64})
   assert.deepEqual(s.inventory,{...before.inventory,spruce_planks:before.inventory.spruce_planks-64})
   assert.ok(s.requestProgress.verification.checks.some(c=>c.kind==='sheltered'&&c.passed))
   assert.ok(!s.safety);report.status='passed';break
  }
  await delay(1000)
 }
 assert.equal(report.status,'passed','Storage preparation timed out')
}catch(e){report.status='failed';report.error=e.stack;process.exitCode=1}
finally{
 if(report.status!=='passed'){
  const s=await api('/state').catch(()=>null)
  if(s?.requestProgress?.request===report.request&&['thinking','acting','retreating'].includes(s.phase)){await api('/stop',{});report.operatorStop=true}
 }
 report.endedAt=Date.now();save();console.log(JSON.stringify({status:report.status,error:report.error,directory,carriedPlanks:report.after?.inventory.spruce_planks,storedPlanks:report.chestAfter?.contents.spruce_planks}))
}
