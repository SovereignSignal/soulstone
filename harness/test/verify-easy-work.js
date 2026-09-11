import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
const read=p=>JSON.parse(readFileSync('results/'+p)),r=read('easy-work-live.json'),during=read('easy-work-food-during.json'),returned=read('easy-work-food-return.json'),out={status:'running'}
try{
 assert.equal(r.status,'passed');assert.ok(!r.operatorStop&&!r.interruption&&!r.cleanupError)
 assert.equal(r.before.connectionId,r.after.connectionId);assert.equal(r.after.requestProgress.id,r.requestId)
 assert.ok(r.samples.every(s=>s.health>10&&!s.safety));assert.ok(r.durationMs<=20*60*1000+15000)
 const feedback=r.after.requestProgress.feedback;assert.ok(!feedback.some(f=>f.status==='failed'))
 assert.ok(feedback.some(f=>f.action==='prepare'&&f.result?.receipt==='serviceable_tools_verified'))
 assert.ok(feedback.some(f=>f.action==='prospect'&&f.status==='completed'))
 assert.ok(r.after.requestProgress.verification.checks.some(c=>c.kind==='sheltered'&&c.passed))
 assert.match(r.serverIron,/entity data: 4$/);assert.match(r.serverAxe,/entity data: 1$/)
 assert.equal(returned.status,'captured');assert.equal(returned.requestId,r.requestId)
 const value=s=>Number(s.match(/entity data: ([\d.]+)/)?.[1]);assert.ok(Number.isFinite(value(returned.foodSaturationLevel)))
 const phases={};for(let i=0;i<r.samples.length-1;i++){const s=r.samples[i];phases[s.phase]=(phases[s.phase]||0)+(r.samples[i+1].at-s.at)/1000}
 Object.assign(out,{status:'passed',durationSeconds:r.durationMs/1000,sampledPhaseSeconds:phases,minimumHealth:Math.min(...r.samples.map(s=>s.health)),minimumFood:Math.min(...r.samples.map(s=>s.food)),lowestY:Math.min(...r.samples.map(s=>s.position.y)),sameRequest:true,sameConnection:true,operatorInterventions:0,serverSaturationDuring:value(during.foodSaturationLevel),serverSaturationOnReturn:value(returned.foodSaturationLevel),eatingActions:feedback.filter(f=>f.action==='eat').length,harvestActions:feedback.filter(f=>f.action==='harvest').length,rawIron:r.after.inventory.raw_iron,stoneAxe:r.after.tools.find(t=>t.name==='stone_axe'),scope:'One bounded Easy-mode supply trip, natural spawning disabled and daytime frozen. No injected effects, no hostile encounter and no natural eating demand. Client saturation stayed stale; server readings establish the energy change.'})
}catch(e){out.status='failed';out.error=e.message;process.exitCode=1}
writeFileSync('results/easy-work-observations-verified.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out))
