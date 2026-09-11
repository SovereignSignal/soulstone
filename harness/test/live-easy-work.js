import {readFileSync,writeFileSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import assert from 'node:assert/strict'
const host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const run=promisify(execFile),rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const api=async(route,data)=>{const a=JSON.parse(readFileSync('state/companion-api.json'));const r=await fetch(a.url+route,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+a.token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(8000)});assert.ok(r.ok);return r.json()}
const request='Complete a supply trip: prepare one serviceable stone axe, collect at least four raw iron from natural ore using the saved mining route, and finish carrying at least 32 spruce logs and 32 sweet berries. Use the axe for wood where possible. Leave through the shelter door before travelling. Check food and health between actions, eat carried food when hungry and replenish any berries used. Preserve all diamonds, existing tools, buildings and base storage. Finish inside the lit primary base with its door closed. The lab is temporarily on Easy; do not change server settings.'
const report={status:'running',request,samples:[]};let changed=false,interrupted=false,id=null,lastPrint=0
process.on('SIGINT',()=>interrupted=true);process.on('SIGTERM',()=>interrupted=true)
try{
 const before=report.before=await api('/state');assert.ok(before.connected&&before.phase==='ready'&&before.health===20&&!before.safety);assert.equal(before.survival.gameMode,'survival')
 assert.match(await rcon('difficulty'),/Peaceful/);assert.match(await rcon('gamerule doMobSpawning'),/false/);assert.match(await rcon('gamerule doDaylightCycle'),/false/)
 writeFileSync('results/easy-work-before.json',JSON.stringify(before,null,2))
 changed=true;await rcon('difficulty easy');report.startedAt=Date.now()
 await api('/message',{text:request})
 const deadline=Date.now()+20*60*1000
 while(Date.now()<deadline){
  assert.ok(!interrupted,'Operator interrupted trial')
  const s=await api('/state');id??=s.requestProgress.id;report.requestId=id
  assert.equal(s.requestProgress.id,id,'Request superseded');assert.equal(s.requestProgress.request,request);assert.ok(s.connected&&s.connectionId===before.connectionId,'Connection changed')
  const sample={at:Date.now(),phase:s.phase,action:s.task?.kind,taskStatus:s.task?.status,position:s.position,health:s.health,food:s.survival.food,saturation:s.survival.saturation,berries:s.inventory.sweet_berries,logs:s.inventory.spruce_log,rawIron:s.inventory.raw_iron||0,safety:s.safety}
  report.samples.push(sample)
  if(Date.now()-lastPrint>15000){console.log(JSON.stringify(sample));lastPrint=Date.now()}
  assert.ok(s.health>10,'Health cutoff');assert.equal(s.survival.difficulty,'easy','Difficulty changed during trial')
  if(s.safety){report.interruption=s;throw new Error('Automatic safety interrupted work; recording the pause without automatic Resume')}
  if(['ready','blocked'].includes(s.phase)){
   report.after=s;assert.equal(s.phase,'ready',s.messages.at(-1).text)
   assert.ok(s.inventory.raw_iron>=4&&s.inventory.spruce_log>=32&&s.inventory.sweet_berries>=32,'Supply targets incomplete')
   assert.ok(s.tools.some(t=>t.name==='stone_axe'&&t.remaining>=Math.max(32,t.maximum/2)),'No serviceable stone axe')
   assert.equal(s.inventory.diamond,before.inventory.diamond)
   assert.ok(s.requestProgress.verification.checks.some(c=>c.kind==='sheltered'&&c.passed),'No verified final shelter')
   report.serverIron=await rcon('data get entity HarnessRunner Inventory[{id:"minecraft:raw_iron"}].count');assert.ok(Number(report.serverIron.match(/entity data: (\d+)$/)?.[1])>=4)
   report.serverAxe=await rcon('data get entity HarnessRunner Inventory[{id:"minecraft:stone_axe"}].count');assert.match(report.serverAxe,/entity data: 1$/)
   report.status='passed';break
  }
  await delay(1000)
 }
 assert.equal(report.status,'passed','20-minute work limit reached')
}catch(e){report.status='failed';report.error=e.message;process.exitCode=1}
finally{
 report.endedAt=Date.now();report.durationMs=report.startedAt?report.endedAt-report.startedAt:0
 try{
  if(changed){report.restore=await rcon('difficulty peaceful');report.finalDifficulty=await rcon('difficulty');assert.match(report.finalDifficulty,/Peaceful/)}
  const s=await api('/state');if(s.requestProgress?.id===id&&['thinking','acting'].includes(s.phase)){report.stopped=await api('/stop',{});report.operatorStop=true}
 }catch(e){report.cleanupError=e.message;report.status='failed';process.exitCode=1}
 writeFileSync('results/easy-work-live.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,error:report.error,durationMs:report.durationMs,finalDifficulty:report.finalDifficulty}))
}
