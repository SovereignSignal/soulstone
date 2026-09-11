import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {Vec3} from 'vec3'
import {shelterLayout} from '../src/shelter.js'
const mode=process.env.MC_THREAT_CASE||'fallback';assert.ok(['fallback','occupied'].includes(mode))
const r=JSON.parse(readFileSync(`results/hostile-${mode}-recovery-live.json`)),out={status:'running'},key=p=>new Vec3(p.x,p.y,p.z).floored().toString()
try{
 assert.equal(r.status,'passed')
 const held=r.samples.filter(s=>s.safety==='sheltered'),inside=new Set(r.fallback.cells.map(key))
 assert.ok(held.length>2&&held.at(-1).at-held[0].at>=7500)
 assert.ok(held.every(s=>inside.has(key(s.position))))
 assert.ok(held.every(s=>s.mob&&!inside.has(key(s.mob.position))))
 assert.ok(r.recovery.safety.attempts.some(a=>a.name==='base'&&a.status==='rejected'&&(mode==='occupied'?/contains a potential hostile/:/access obstructed/).test(a.reason)))
 assert.equal(r.recovery.safety.retreat.shelterName,r.fallback.name)
 assert.deepEqual(r.after.projects.base.build,r.before.projects.base.build)
 assert.deepEqual(r.after.projects.base.stations,r.before.projects.base.stations)
 for(const [name,project] of Object.entries(r.before.projects))if(name!=='base')assert.deepEqual(r.after.projects[name],project)
 assert.equal(r.before.connectionId,r.after.connectionId)
 assert.equal(r.recovery.requestProgress.id,r.after.requestProgress.id)
 if(mode==='fallback')assert.match(r.fixtureRemoved,/Changed/);else{
  assert.ok(!r.fixture,'Occupancy must be the sole primary rejection cause')
  const o=new Vec3(r.before.projects.base.build.origin.x,r.before.projects.base.build.origin.y,r.before.projects.base.build.origin.z),layout=shelterLayout(r.before.projects.base.build.design),primary=new Set([...layout.inside,layout.door].map(p=>key(o.plus(p))))
  assert.ok(held.every(s=>primary.has(key(s.mob.position))),'Hostile did not remain in primary shelter')
 }
 assert.match(r.mobRemoved,/players online/);assert.match(r.finalDifficulty,/Peaceful/)
 assert.ok(r.after.requestProgress.feedback.slice(r.recovery.requestProgress.feedback.length).some(f=>f.action==='leave_base'&&f.result?.shelterName===r.fallback.name&&f.result.receipt==='left_base_door_closed'),'Resume did not verify departure from fallback')
 assert.ok(r.after.requestProgress.verification.checks.some(c=>c.kind==='sheltered'&&c.passed))
 Object.assign(out,{status:'passed',shelter:r.fallback.name,attempts:r.recovery.safety.attempts,holdMs:held.at(-1).at-held[0].at,minimumHealth:Math.min(...r.samples.map(s=>s.health)),sameConnection:true,sameRequest:true,primaryBasePreserved:true,verifiedFallbackExit:true,logs:r.after.inventory.spruce_log,scope:`One ${mode==='occupied'?'hostile-occupied':'blocked'} primary emergency with autonomous selection and entry of an existing fallback, followed by administrative fixture cleanup and explicit Resume. No combat or automatic resumption.`})
}catch(e){out.status='failed';out.error=e.message;process.exitCode=1}
writeFileSync(`results/${mode}-observations-verified.json`,JSON.stringify(out,null,2));console.log(JSON.stringify(out))
