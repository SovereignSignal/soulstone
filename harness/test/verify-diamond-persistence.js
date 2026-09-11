// Read-only acceptance from the host's saved inventory and mining statistics.
// Arguments: run directory, Minecraft world directory, player UUID, state dir.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,statSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import nbt from 'prismarine-nbt'
const [runPath,worldPath,uuid,statePath]=process.argv.slice(2)
assert.ok(runPath&&worldPath&&statePath);assert.match(uuid||'',/^[a-f0-9-]{36}$/)
const directory=resolve(runPath),before=JSON.parse(readFileSync(join(directory,'before.json'))),after=JSON.parse(readFileSync(join(directory,'after.json')))
const initial=JSON.parse(readFileSync(new URL('../results/persistence-server-before.json',import.meta.url)))
const request=after.requestProgress,report={status:'running',scope:'Resumed real LAN diamond request with two wooden pickaxes and an existing house; not fresh-world empty-inventory acceptance.',requestId:request.id}
const count=(inventory,item)=>inventory.filter(i=>i.id==='minecraft:'+item).reduce((n,i)=>n+i.count,0)
const mined=stats=>['minecraft:diamond_ore','minecraft:deepslate_diamond_ore'].reduce((n,k)=>n+(stats.stats?.['minecraft:mined']?.[k]||0),0)
try{
 assert.equal(before.inventory.diamond||0,0);assert.equal(count(initial.player.Inventory,'diamond'),0)
 assert.equal(request.id,before.requestProgress.id)
 assert.deepEqual(request.goal,before.requestProgress.goal)
 assert.ok(after.inventory.diamond>=1,'Client does not carry a diamond')
 assert.deepEqual(after.projects.base.build,before.projects.base.build,'Saved house changed')
 assert.ok(after.connected&&!after.dead)
 const dataFile=join(worldPath,'players/data',uuid+'.dat'),statsFile=join(worldPath,'players/stats',uuid+'.json')
 const deadline=Date.now()+360000
 let player,stats
 do{
  player=nbt.simplify((await nbt.parse(readFileSync(dataFile))).parsed);stats=JSON.parse(readFileSync(statsFile))
  if(count(player.Inventory,'diamond')>=1&&mined(stats)>mined(initial.stats))break
  assert.ok(Date.now()<deadline,'Host save did not confirm both diamond inventory and newly mined diamond ore within six minutes')
  await delay(5000)
 }while(true)
 report.server={inventory:player.Inventory,minedDiamondOreBefore:mined(initial.stats),minedDiamondOreAfter:mined(stats),health:player.Health,position:player.Pos,inventorySavedAt:statSync(dataFile).mtime.toISOString(),statsSavedAt:statSync(statsFile).mtime.toISOString()}
 const saved=JSON.parse(readFileSync(join(statePath,'teammate.json'))),experience=JSON.parse(readFileSync(join(statePath,'experience.json')))
 assert.equal(saved.requestProgress.id,request.id);assert.deepEqual(saved.requestProgress.goal,before.requestProgress.goal)
 const entry=experience.entries.find(e=>e.requestId===request.id)
 assert.ok(entry,'Missing persisted request experience')
 assert.ok(entry.outcomes?.some(o=>o.verdict==='needs_work'),'Earlier failed outcome was lost')
 assert.equal(entry.verdict,request.verification.verdict,'Persisted experience did not update after Resume')
 assert.ok(entry.outcomes.length>=2,'Resume did not retain an outcome revision')
 report.learning={experienceId:entry.id,verdict:entry.verdict,outcomes:entry.outcomes,lessons:entry.lessons}
 report.client={inventory:after.inventory,health:after.health,requestStatus:request.status,verification:request.verification,rounds:request.rounds}
 report.status='passed'
}catch(error){report.status='failed';report.error=error.stack;process.exitCode=1}
writeFileSync(join(directory,'server-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,path:join(directory,'server-verification.json'),error:report.error}))
