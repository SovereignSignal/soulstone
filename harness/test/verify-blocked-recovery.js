import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
const r=JSON.parse(readFileSync('results/hostile-blocked-recovery-live.json'))
const out={status:'running'}
try{
 assert.equal(r.status,'passed')
 assert.equal(r.recovery.safety.status,'failed')
 assert.match(JSON.stringify(r.recovery.safety),/access obstructed/)
 assert.equal(r.recovery.requestProgress.status,'interrupted')
 assert.equal(r.recovery.canResume,true)
 assert.ok(!r.recovery.safety.retreat)
 assert.equal(r.before.connectionId,r.after.connectionId)
 assert.equal(r.recovery.requestProgress.id,r.after.requestProgress.id)
 assert.match(r.fixtureRemoved,/Changed/)
 assert.match(r.mobRemoved,/players online/)
 assert.match(r.finalDifficulty,/Peaceful/)
 assert.ok(r.after.requestProgress.verification.checks.some(c=>c.kind==='sheltered'&&c.passed))
 assert.ok(r.samples.some(s=>s.threats.some(t=>t.name==='husk'&&t.distance<=6)))
 assert.ok(!r.samples.some(s=>s.safety==='sheltered'))
 Object.assign(out,{status:'passed',minimumHealth:Math.min(...r.samples.map(s=>s.health)),sameConnection:true,sameRequest:true,reportedObstruction:true,fixtureRemoved:true,logs:r.after.inventory.spruce_log,scope:'Expected failure at blocked entrance, administrative fixture cleanup, explicit Resume and final verified shelter. No autonomous alternate shelter or obstruction repair.'})
}catch(e){out.status='failed';out.error=e.message;process.exitCode=1}
writeFileSync('results/hostile-blocked-observations-verified.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out))
