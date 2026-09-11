import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
const r=JSON.parse(readFileSync('results/continuous-easy-recovery-live.json'))
assert.equal(r.status,'passed',r.error)
assert.ok(!r.cleanupError&&!r.operatorStop)
assert.notEqual(r.firstAfter.requestProgress.id,r.requestId)
for(const s of [r.firstAfter,r.triggerBefore,r.recovery,r.holdAfter,r.after]){
 assert.equal(s.connectionId,r.before.connectionId)
 assert.equal(s.survival.difficulty,'easy')
 assert.equal(s.inventory.diamond,r.before.inventory.diamond)
}
for(const s of [r.triggerBefore,r.recovery,r.holdAfter,r.after])assert.equal(s.requestProgress.id,r.requestId)
assert.ok(r.firstAfter.inventory.torch>=32&&r.firstAfter.inventory.spruce_log<32)
assert.ok(r.after.inventory.spruce_log>=32&&r.after.inventory.raw_iron>=8&&r.after.inventory.sweet_berries>=32)
assert.equal(r.resumeInterventions,1)
assert.match(r.lootTable,/minecraft:empty/)
assert.match(r.mobRemoved,/players online/)
assert.match(r.finalDifficulty,/Peaceful/)
for(const f of [r.foodBefore,r.foodBetween,r.foodAfter])assert.match(f.difficulty,/Easy/)
const held=r.samples.filter(s=>s.safety==='sheltered')
assert.ok(held.at(-1).at-held[0].at>=8000)
assert.ok(held.every(s=>s.mob),'Live mob absent during shelter hold')
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)
assert.ok(held.every(s=>distance(s.position,s.mob.position)>1),'Mob overlaps sheltered bot')
const feedback=r.after.requestProgress.feedback
const result={status:'passed',durationSeconds:(r.endedAt-r.startedAt)/1000,holdSeconds:(held.at(-1).at-held[0].at)/1000,minimumHealth:Math.min(...r.samples.map(s=>s.health)),resumeInterventions:r.resumeInterventions,foodBefore:r.foodBefore,foodBetween:r.foodBetween,foodAfter:r.foodAfter,inventory:r.after.inventory,foodActions:feedback.filter(f=>['eat','harvest'].includes(f.action)),failures:feedback.filter(f=>f.status==='failed'||f.task?.status==='failed'),scope:'Two jobs in one Easy window, one tagged lootless husk removed administratively, one explicit Resume. Natural spawning disabled and daytime frozen. Independent world/storage audit is separate.'}
writeFileSync('results/continuous-easy-work-observations-verified.json',JSON.stringify(result,null,2))
console.log(JSON.stringify(result,null,2))
