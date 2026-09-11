import {readFileSync,writeFileSync} from 'node:fs'
import assert from 'node:assert/strict'
const r=JSON.parse(readFileSync('results/terrain-work-live.json')),f=JSON.parse(readFileSync('results/terrain-work-food-return.json'))
assert.equal(r.status,'passed',r.error);assert.ok(!r.operatorStop&&!r.interruption&&!r.cleanupError)
assert.equal(r.before.connectionId,r.after.connectionId);assert.equal(r.requestId,r.after.requestProgress.id)
assert.ok(r.samples.every(s=>!s.safety));assert.equal(r.after.inventory.diamond,r.before.inventory.diamond)
assert.ok(r.after.inventory.raw_iron>=12&&r.after.inventory.torch>=53&&r.after.inventory.spruce_log>=32&&r.after.inventory.sweet_berries>=32)
assert.ok(r.after.requestProgress.verification.checks.some(c=>c.kind==='sheltered'&&c.passed))
assert.equal(f.status,'captured');assert.equal(f.requestId,r.requestId)
const recoveries=new Map();for(const s of r.samples)if(s.navigationRecovery)recoveries.set(s.navigationRecovery.startedAt,s.navigationRecovery)
const report={status:'passed',durationSeconds:r.durationMs/1000,minimumSampledHealth:Math.min(...r.samples.map(s=>s.health)),minimumSampledFood:Math.min(...r.samples.map(s=>s.food)),lowestY:Math.min(...r.samples.map(s=>s.position.y)),inventory:r.after.inventory,failedActions:r.after.requestProgress.feedback.filter(f=>f.status==='failed'),sampledRecoveries:[...recoveries.values()],foodActions:r.after.requestProgress.feedback.filter(f=>['eat','harvest'].includes(f.action)),serverFood:f,scope:'One main-bot request on Easy with spawning disabled and daytime frozen; no operator continuation, item grants or main-bot teleport. Recovery mechanism acceptance is the separate controlled live fixture. World preservation is audited separately.'}
writeFileSync('results/terrain-work-observations-verified.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
