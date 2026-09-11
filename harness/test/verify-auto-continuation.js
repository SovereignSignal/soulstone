import {readFileSync,writeFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {shelterLayout} from '../src/shelter.js'
const r=JSON.parse(readFileSync('results/auto-continuation-recovery-live.json'))
assert.equal(r.status,'passed',r.error);assert.equal(r.resumeInterventions,0);assert.ok(!r.operatorStop&&!r.cleanupError)
const c=r.after.requestProgress.safetyContinuations;assert.equal(c.length,1);assert.equal(c[0].requestId,r.requestId);assert.equal(c[0].connectionId,r.before.connectionId);assert.equal(c[0].quietMs,20000)
for(const s of [r.firstAfter,r.triggerBefore,r.recovery,r.holdAfter,r.after])assert.equal(s.connectionId,r.before.connectionId)
for(const s of [r.triggerBefore,r.recovery,r.holdAfter,r.after])assert.equal(s.requestProgress.id,r.requestId)
const v=p=>new Vec3(p.x,p.y,p.z),o=v(r.before.projects.base.build.origin),inside=new Set(shelterLayout(r.before.projects.base.build.design).inside.map(p=>o.plus(p).toString()))
const held=r.samples.filter(s=>s.safety==='sheltered'&&s.mob)
assert.ok(held.at(-1).at-held[0].at>=8000);assert.ok(held.every(s=>inside.has(v(s.position).floored().toString())&&!inside.has(v(s.mob.position).floored().toString())))
assert.ok(c[0].clearedAt-held.at(-1).at>=20000,'Continuation began before a full quiet interval after the last observed mob')
const quiet=r.samples.filter(s=>s.at>=c[0].clearedAt-19500&&s.at<c[0].clearedAt)
assert.ok(quiet.length>=10);assert.ok(quiet.every(s=>s.safety==='sheltered'&&!s.mob&&!s.threats.length&&s.health===20))
assert.match(r.lootTable,/minecraft:empty/);assert.match(r.mobRemoved,/players online/);assert.match(r.finalDifficulty,/Peaceful/)
assert.ok(r.after.inventory.raw_iron>=16&&r.after.inventory.spruce_log>=32&&r.after.inventory.sweet_berries>=32);assert.equal(r.after.inventory.diamond,r.before.inventory.diamond)
assert.ok(r.after.messages.some(m=>m.role==='assistant'&&m.text.startsWith('Automatically continuing')))
const eating=r.after.requestProgress.feedback.filter(f=>f.action==='eat'&&f.status==='completed').flatMap(f=>f.result.consumed)
assert.equal(eating.length,1);assert.deepEqual(eating[0],{item:'sweet_berries',before:{food:18,count:32},after:{food:20,count:31}})
const harvest=r.after.requestProgress.feedback.find(f=>f.action==='harvest'&&f.status==='completed').result
assert.equal(harvest.count,33);assert.equal(harvest.harvested.reduce((n,h)=>n+h.gained,0),2)
assert.match(r.foodAfter.difficulty,/Easy/);assert.match(r.foodAfter.food,/data: 20$/)
const out={food:{eating,harvest,serverAfter:r.foodAfter},status:'passed',durationSeconds:(r.endedAt-r.startedAt)/1000,holdMs:held.at(-1).at-held[0].at,minimumHealth:Math.min(...r.samples.map(s=>s.health)),automaticContinuations:1,manualResumes:0,clearance:c[0],inventory:r.after.inventory,failures:r.after.requestProgress.feedback.filter(f=>f.status==='failed'),scope:'One tagged lootless husk removed administratively after shelter hold, followed by observed clearance and automatic same-request continuation. Natural spawning disabled; no combat or independent threat removal by the bot.'}
writeFileSync('results/auto-continuation-observations-verified.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2))
