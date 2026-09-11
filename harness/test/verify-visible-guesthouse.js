import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFileSync,writeFileSync} from 'node:fs'
import {compileArchitecture} from '../src/construction.js'
import {serverChest} from './server-chest.js'
const a=JSON.parse(readFileSync('state/companion-api.json')),s=await(await fetch(a.url+'/state',{headers:{Authorization:'Bearer '+a.token}})).json(),before=JSON.parse(readFileSync('results/visible-guesthouse-first-before.json'))
const run=promisify(execFile),host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const report={status:'running',scope:'Live companion guesthouse beside owner; admin supplied pad and materials',checks:[]}
try{
 assert.equal(s.phase,'ready');const project=s.projects.visible_guesthouse,c=project.construction,bp=compileArchitecture(c.design);assert.equal(project.result.partial,false)
 const condition=(b,o)=>`if block ${o.x+b.x} ${o.y+b.y} ${o.z+b.z} minecraft:${b.block}${b.properties&&Object.keys(b.properties).length?'['+Object.entries(b.properties).map(([k,v])=>`${k}=${v}`).join(',')+']':''}`
 const conditions=bp.cells.map(b=>condition(b,c.origin))
 for(const [name,old] of Object.entries(before.projects).filter(([name])=>name!=='visible_guesthouse'))assert.deepEqual(s.projects[name],old,'Existing saved project changed: '+name)
 const castle=before.projects.castle.construction,cbp=compileArchitecture(castle.design);conditions.push(...cbp.cells.map(b=>condition(b,castle.origin)))
 const base=before.projects.base;for(const b of base.build.design)conditions.push(condition({...b,block:b.block==='wood_planks'?base.build.wood.replace('_log','_planks'):b.block},base.build.origin))
 for(let i=0;i<conditions.length;i+=12){const batch=conditions.slice(i,i+12),response=await rcon('execute '+batch.join(' ')+' run list');assert.match(response,/players online/,batch.join(';'));report.checks.push({conditions:batch,response})}
 const contents=await serverChest(rcon,base.stations.chest.position);assert.deepEqual(contents.contents,base.stations.chest.contents,'Base chest changed')
 assert.equal(project.result.walkthrough.length,bp.checks.length);assert.equal(project.result.furnishings.length,4);assert.equal(project.result.interactions.length,1)
 assert.ok(s.inventory.diamond>=before.inventory.diamond);assert.equal(s.health,before.health,'Health changed during live build')
 const gamemode=await rcon('data get entity HarnessRunner playerGameType');assert.match(gamemode,/entity data: 0$/)
 Object.assign(report,{status:'passed',origin:c.origin,placedItems:bp.blocks.length,plannedCells:bp.cells.length,castleCells:cbp.cells.length,walkthrough:project.result.walkthrough,furnishings:project.result.furnishings,interactions:project.result.interactions,baseChest:contents,diamonds:s.inventory.diamond,health:s.health,gamemode,ownerPosition:s.ownerPosition,position:s.position,goalStatus:s.requestProgress.status,verification:s.requestProgress.verification})
}catch(e){report.status='failed';report.error=e.message;process.exitCode=1}
writeFileSync('results/visible-guesthouse-server-verified.json',JSON.stringify(report,null,2));console.log(JSON.stringify({...report,checks:report.checks.length}))
