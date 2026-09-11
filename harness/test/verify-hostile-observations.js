import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {Vec3} from 'vec3'
import {shelterLayout} from '../src/shelter.js'
const prefix=process.env.MC_AUDIT_PREFIX||'hostile';assert.match(prefix,/^[a-z-]+$/)
const r=JSON.parse(readFileSync(`results/${prefix}-recovery-live.json`)),out={status:'running'}
try{
 const encounterOnly=process.env.MC_AUDIT_ENCOUNTER_ONLY==='1'
 if(encounterOnly){assert.ok(r.recovery&&r.holdAfter&&r.after);assert.equal(r.recovery.safety.status,'sheltered')}else assert.equal(r.status,'passed')
 const build=r.before.projects.base.build,o=new Vec3(build.origin.x,build.origin.y,build.origin.z),layout=shelterLayout(build.design)
 const interior=new Set(layout.inside.map(p=>o.plus(p).toString())),held=r.samples.filter(s=>s.safety==='sheltered')
 assert.ok(held.length>2&&held.at(-1).at-held[0].at>=7500)
 assert.ok(held.every(s=>interior.has(new Vec3(s.position.x,s.position.y,s.position.z).floored().toString())))
 assert.ok(held.every(s=>s.mob&&!interior.has(new Vec3(s.mob.position.x,s.mob.position.y,s.mob.position.z).floored().toString())),'Hostile entered the room or was not observed during hold')
 const mobs=r.samples.filter(s=>s.mob),first=mobs[0].mob.position
 const displacement=Math.max(...mobs.map(s=>Math.hypot(s.mob.position.x-first.x,s.mob.position.z-first.z)))
 assert.ok(displacement>.5)
 assert.match(r.recovery.safety.reason,/potential hostile/)
 assert.equal(r.before.connectionId,r.after.connectionId)
 const minimumHealth=Math.min(...r.samples.map(s=>s.health));assert.ok(minimumHealth>0)
 Object.assign(out,{status:'passed',trialStatus:r.status,encounterOnly,minimumHealth,holdMs:held.at(-1).at-held[0].at,closestMobDuringHold:Math.min(...held.map(s=>Math.hypot(s.position.x-s.mob.position.x,s.position.y-s.mob.position.y,s.position.z-s.mob.position.z))),maximumHorizontalMobDisplacement:displacement,mobStayedOutside:true,sameConnection:true,requestId:r.requestId,logs:r.after.inventory.spruce_log,scope:'One active adult husk, proximity-triggered retreat, observed movement and outside-room hold; no combat or general target inference'})
}catch(e){out.status='failed';out.error=e.message;process.exitCode=1}
writeFileSync(`results/${prefix}-observations-verified.json`,JSON.stringify(out,null,2));console.log(JSON.stringify(out))
