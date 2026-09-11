import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFileSync,writeFileSync} from 'node:fs'
import {compileArchitecture} from '../src/construction.js'
import {serverChest} from './server-chest.js'
const a=JSON.parse(readFileSync('state/companion-api.json')),r=await fetch(a.url+'/state',{headers:{Authorization:'Bearer '+a.token}});assert.ok(r.ok)
const s=await r.json(),before=JSON.parse(readFileSync('results/live-castle-before.json'))
assert.equal(s.phase,'ready');assert.equal(s.projects.castle.result.partial,false)
assert.deepEqual(s.projects.base,before.projects.base,'Saved resupply base changed')
const host=process.env.MC_SSH_HOST,run=promisify(execFile);assert.match(host,/^[\w.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const c=s.projects.castle.construction,bp=compileArchitecture(c.design),report={status:'running',origin:c.origin,verifiedBlocks:0,reads:[],walkthrough:s.projects.castle.result.walkthrough,kit:'lab-supplied',mode:'survival'}
try{
 const conditions=bp.blocks.map(b=>`if block ${c.origin.x+b.x} ${c.origin.y+b.y} ${c.origin.z+b.z} minecraft:${b.block}`)
 const base=s.projects.base.build
 for(const b of base.design)conditions.push(`if block ${base.origin.x+b.x} ${base.origin.y+b.y} ${base.origin.z+b.z} minecraft:${b.block==='wood_planks'?base.wood.replace('_log','_planks'):b.block}`)
 for(const [name,v] of Object.entries(s.projects.base.stations))conditions.push(`if block ${v.position.x} ${v.position.y} ${v.position.z} minecraft:${name}`)
 for(let i=0;i<conditions.length;i+=16){const response=await rcon('execute '+conditions.slice(i,i+16).join(' ')+' run list');assert.match(response,/players online/);report.reads.push({checks:conditions.slice(i,i+16),response})}
 report.verifiedBlocks=bp.blocks.length;report.originalBaseBlocks=base.design.length
 for(const p of bp.checks){const at={x:c.origin.x+p.x,y:c.origin.y+p.y,z:c.origin.z+p.z};const response=await rcon(`execute if block ${at.x} ${at.y} ${at.z} air if block ${at.x} ${at.y+1} ${at.z} air run list`);assert.match(response,/players online/);report.reads.push({checkpoint:at,response})}
 assert.equal(report.walkthrough.length,bp.checks.length)
 report.chest=await serverChest(rcon,s.projects.base.stations.chest.position);assert.deepEqual(report.chest.contents,before.projects.base.stations.chest.contents)
 report.diamond=await rcon('data get entity HarnessRunner Inventory[{id:"minecraft:diamond"}].count');assert.match(report.diamond,/entity data: 1$/)
 report.gamemode=await rcon('data get entity HarnessRunner playerGameType');assert.match(report.gamemode,/entity data: 0$/)
 report.finalPosition=await rcon('data get entity HarnessRunner Pos');const pos=[...report.finalPosition.matchAll(/([-+\d.eE]+)d/g)].map(m=>Number(m[1]));assert.equal(pos.length,3)
 const end=bp.checks.at(-1);assert.ok(Math.hypot(pos[0]-c.origin.x-end.x-0.5,pos[1]-c.origin.y-end.y,pos[2]-c.origin.z-end.z-0.5)<1)
 const toolKey=t=>`${t.name}:${t.remaining}:${t.maximum}`;assert.deepEqual(s.tools.map(toolKey).sort(),before.tools.map(toolKey).sort(),'Carried tools changed')
 report.tools=s.tools;report.rounds=s.requestProgress.rounds;report.status='passed'
}catch(e){report.status='failed';report.error=e.message;process.exitCode=1}
writeFileSync('results/live-castle-server-verified.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,error:report.error,blocks:report.verifiedBlocks,checks:report.walkthrough.length,rounds:report.rounds,position:report.finalPosition}))
