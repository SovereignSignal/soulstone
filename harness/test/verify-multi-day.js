import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {shelterLayout} from '../src/shelter.js'
import {morningOutcome} from '../src/companion/day-routine.js'
const directory=process.argv[2];assert.match(directory,/^results\/multi-day-\d+$/)
const report=JSON.parse(readFileSync(directory+'/report.json'))
const samples=readFileSync(directory+'/samples.jsonl','utf8').trim().split('\n').map(JSON.parse)
const days=report.expectedDays??2;assert.ok(Number.isInteger(days)&&days>=1&&days<=3)
assert.equal(report.status,'passed',report.error);assert.ok(!report.cleanupError&&!report.operatorStop);assert.equal(report.manualRescues,0)
const session=report.after.survivalSession
assert.equal(session.status,'completed');assert.equal(session.days,days);assert.equal(session.jobs.length,days);assert.ok(session.completedCycles>=days)
assert.equal(report.after.connectionId,report.before.connectionId)
const ticks=report.server.map(s=>Number(s.tick.match(/is (\d+)/)?.[1]));assert.ok(ticks.every(Number.isFinite));assert.ok(ticks.every((v,i)=>!i||v>=ticks[i-1]));assert.ok(ticks.at(-1)-ticks[0]>=days*24000-1000,'Server clock did not span the requested cycles')
const base=report.before.projects.base.build,layout=shelterLayout(base.design),inside=new Set(layout.inside.map(p=>`${p.x+base.origin.x},${p.y+base.origin.y},${p.z+base.origin.z}`))
const atHome=p=>inside.has(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`)
let nightCount=0,inNight=false
for(const sample of samples){
 assert.ok(sample.health>12&&Number.isFinite(sample.food));assert.equal(sample.inventory.diamond,report.before.inventory.diamond)
 const night=sample.time>=13000&&sample.time<=23000
 if(night&&!inNight)nightCount++
 if(night)assert.ok(atHome(sample.position),'Bot outside base during night')
 inNight=night
}
assert.ok(nightCount>=days);assert.ok(atHome(report.after.position))
for(const job of session.jobs){assert.equal(job.status,'passed');assert.ok(morningOutcome({...job.after,survival:{food:job.after.food}},job.target));assert.ok(job.feedback.some(f=>f.status==='completed'&&f.action==='retreat'))}
assert.equal(new Set(session.jobs.map(j=>j.requestId)).size,days)
assert.ok(session.jobs.every((j,i)=>!i||j.day>session.jobs[i-1].day))
assert.match(report.finalRules.difficulty,/Peaceful/);assert.match(report.finalRules.spawning,/false/);assert.match(report.finalRules.daylight,/false/);assert.match(report.finalRules.time,/6000/)
const morningActivity=session.jobs.map((job,i)=>{
 const before=i?session.jobs[i-1].after.inventory:report.before.inventory,after=job.after.inventory
 const inventoryDelta=Object.fromEntries([...new Set([...Object.keys(before),...Object.keys(after)])].map(name=>[name,(after[name]||0)-(before[name]||0)]).filter(([,delta])=>delta!==0))
 return {day:job.day,requestId:job.requestId,inventoryDelta,actions:job.feedback.filter(f=>f.status==='completed').map(f=>f.action)}
})
if(report.requiresInventoryWork)assert.ok(morningActivity.every((j,i)=>j.inventoryDelta[session.jobs[i].target.planks]>0),'Active-resupply trial completed a morning without increasing plank reserves')
const automaticContinuations=session.jobs.flatMap(job=>job.feedback.filter(f=>f.action==='safety_continuation'&&f.status==='completed').map(f=>{
 const c=f.result;assert.equal(c.requestId,job.requestId);assert.equal(c.connectionId,report.before.connectionId)
 assert.equal(c.status,'cleared');assert.ok(c.quietMs>=20000&&c.clearedAt-c.startedAt>=c.quietMs)
 const held=samples.filter(s=>s.requestId===job.requestId&&s.at>=c.startedAt&&s.at<=c.clearedAt)
 assert.ok(held.length>=10&&held.every(s=>atHome(s.position)),'Continuation lacks sampled shelter occupancy during its watch')
 return {...c,shelterSamples:held.length}
}))
const result={status:'passed',requestedCycles:days,durationSeconds:(report.endedAt-report.startedAt)/1000,nightCount,nightSamples:samples.filter(s=>s.time>=13000&&s.time<=23000).length,outsideSamples:samples.filter(s=>!atHome(s.position)).length,minimumHealth:Math.min(...samples.map(s=>s.health)),minimumFood:Math.min(...samples.map(s=>s.food)),automaticMorningJobs:session.jobs.length,morningActivity,morningJobsWithInventoryChange:morningActivity.filter(j=>Object.keys(j.inventoryDelta).length).length,manualRescues:report.manualRescues,before:report.before.inventory,after:report.after.inventory,foodActions:session.jobs.flatMap(j=>j.feedback.filter(f=>['eat','harvest'].includes(f.action))),failures:session.jobs.flatMap(j=>j.feedback.filter(f=>f.status==='failed')),observedThreats:[...new Set(samples.flatMap(s=>s.threats.map(t=>t.name)))],scope:'Natural cycles from an existing equipped base. Morning checks can finish without resource changes when reserves already meet their caps; inspect activity and inventory deltas before claiming resupply. Loaded-entity threats, proximity and shelter occupancy do not establish combat, fresh-world startup or indefinite survival. Full building/storage preservation audit is separate.'}
result.automaticContinuations=automaticContinuations
writeFileSync(directory+'/verified.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))
