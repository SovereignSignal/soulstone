import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFileSync,writeFileSync} from 'node:fs'
import assert from 'node:assert/strict'
const run=promisify(execFile),ssh=process.env.MC_SSH_HOST,name=process.env.MC_USERNAME||'HarnessRunner'
assert.match(ssh||'',/^[A-Za-z0-9_.-]+$/);assert.match(name,/^[A-Za-z0-9_]{1,16}$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',ssh,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const state=JSON.parse(readFileSync('results/live-prospect-after.json'))
assert.ok(!['acting','thinking'].includes(state.phase),'Wait for the request to finish')
assert.equal(state.inventory.diamond,1,'Client does not hold the requested diamond')
const report={status:'running',scope:'Independent read-only verification of the live natural-world continuation. No diamond supplied to this bot.',before:JSON.parse(readFileSync('results/live-prospect-before.json')).inventory,client:state.inventory}
try{
 assert.equal(report.before.diamond||0,0)
 report.serverDiamond=await rcon(`data get entity ${name} Inventory[{id:"minecraft:diamond"}]`);assert.match(report.serverDiamond,/count: 1[,}]/)
 report.serverPickaxe=await rcon(`data get entity ${name} Inventory[{id:"minecraft:iron_pickaxe"}]`);assert.match(report.serverPickaxe,/count: 1[,}]/)
 report.serverPosition=await rcon(`data get entity ${name} Pos`)
 const match=report.serverPosition.match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/);assert.ok(match,'Server position not parseable')
 const xyz=match.slice(1).map(Number),station=state.projects.base.stations.crafting_table.position
 report.distanceToBaseTable=Math.hypot(xyz[0]-station.x,xyz[1]-station.y,xyz[2]-station.z)
 assert.ok(report.distanceToBaseTable<5,'Bot has not returned to the base table')
 assert.equal(state.projects.base.expedition.trail.length,0,'Return trail still pending')
 report.status='passed'
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1}
writeFileSync('results/live-diamond-server-verified.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
