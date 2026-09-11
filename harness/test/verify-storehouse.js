import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFileSync,writeFileSync} from 'node:fs'
import {compileArchitecture} from '../src/construction.js'
import {serverChest} from './server-chest.js'
const a=JSON.parse(readFileSync('state/companion-api.json')),s=await(await fetch(a.url+'/state',{headers:{Authorization:'Bearer '+a.token}})).json(),before=JSON.parse(readFileSync('results/storehouse-live-before.json'))
const run=promisify(execFile),host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const report={status:'running',scope:'Model-designed, naturally sited and self-supplied live storehouse; no item grants or terrain preparation',checks:[]}
try{
 assert.equal(s.phase,'ready');const names=Object.keys(s.projects).filter(n=>!before.projects[n]);assert.equal(names.length,1)
 const name=names[0],project=s.projects[name],c=project.construction,bp=compileArchitecture(c.design);assert.equal(project.result.partial,false)
 const condition=(b,o)=>`if block ${o.x+b.x} ${o.y+b.y} ${o.z+b.z} minecraft:${b.block}${b.properties&&Object.keys(b.properties).length?'['+Object.entries(b.properties).map(([k,v])=>`${k}=${v}`).join(',')+']':''}`
 const conditions=bp.cells.map(b=>condition(b,c.origin));let existingCells=0
 for(const [n,old] of Object.entries(before.projects)){
  assert.deepEqual(s.projects[n],old,'Existing project changed: '+n)
  if(old.construction){const oldBp=compileArchitecture(old.construction.design);conditions.push(...oldBp.cells.map(b=>condition(b,old.construction.origin)));existingCells+=oldBp.cells.length}
 }
 const base=before.projects.base
 for(const b of base.build.design)conditions.push(condition({...b,block:b.block==='wood_planks'?base.build.wood.replace('_log','_planks'):b.block},base.build.origin))
 for(const [block,station] of Object.entries(base.stations))conditions.push(`if block ${station.position.x} ${station.position.y} ${station.position.z} minecraft:${block}`)
 for(let i=0;i<conditions.length;i+=12){const batch=conditions.slice(i,i+12),response=await rcon('execute '+batch.join(' ')+' run list');assert.match(response,/players online/,batch.join(';'));report.checks.push({conditions:batch,response})}
 const chest=await serverChest(rcon,base.stations.chest.position);assert.deepEqual(chest.contents,base.stations.chest.contents,'Base chest contents changed')
 assert.equal(project.result.walkthrough.length,bp.checks.length)
 assert.equal(project.result.furnishings.filter(f=>f.block==='barrel').length,2);assert.equal(project.result.furnishings.filter(f=>f.block==='crafting_table').length,1)
 assert.equal(project.result.interactions.length,1)
 assert.ok(s.inventory.diamond>=before.inventory.diamond)
 for(const item of new Set(before.tools.map(t=>t.name)))assert.ok(s.tools.filter(t=>t.name===item).length>=before.tools.filter(t=>t.name===item).length,'Missing tool '+item)
 const gamemode=await rcon('data get entity HarnessRunner playerGameType'),difficulty=await rcon('difficulty');assert.match(gamemode,/entity data: 0$/);assert.match(difficulty,/Peaceful/)
 const actions=s.requestProgress.feedback||[],reservation=actions.find(f=>f.result?.site)?.result;assert.ok(reservation,'Missing natural site reservation receipt');assert.equal(reservation.placed,0)
 assert.ok(actions.some(f=>f.action==='acquire'||f.action==='gather'),'No material acquisition observed')
 Object.assign(report,{status:'passed',name,origin:c.origin,placedItems:bp.blocks.length,plannedCells:bp.cells.length,existingCells,reservation,walkthrough:project.result.walkthrough,furnishings:project.result.furnishings,interactions:project.result.interactions,baseChest:chest,diamonds:s.inventory.diamond,health:s.health,gamemode,difficulty,ownerPosition:s.ownerPosition,position:s.position,goalStatus:s.requestProgress.status,verification:s.requestProgress.verification,actions:actions.map(f=>({action:f.action,status:f.status,item:f.step?.item,count:f.step?.count,reason:f.reason})),requestId:s.requestProgress.id})
}catch(e){report.status='failed';report.error=e.message;process.exitCode=1}
writeFileSync('results/storehouse-server-verified.json',JSON.stringify(report,null,2));console.log(JSON.stringify({...report,checks:report.checks.length}))
