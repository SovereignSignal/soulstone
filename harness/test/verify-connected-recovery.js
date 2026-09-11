import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {compileArchitecture} from '../src/construction.js'
import {serverChest} from './server-chest.js'
const a=JSON.parse(readFileSync('state/companion-api.json')),s=await(await fetch(a.url+'/state',{headers:{Authorization:'Bearer '+a.token}})).json(),before=JSON.parse(readFileSync(process.env.MC_AUDIT_BEFORE||'results/connected-cancellation-before.json'))
const run=promisify(execFile),host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const report={status:'running',checks:[],scope:'Existing structures, food and log inventory, closed shelter door and preserved base storage'}
try{
 assert.equal(s.connected,true);process.env.MC_AUDIT_REPLENISH==='1'?assert.ok(s.inventory.sweet_berries>=before.inventory.sweet_berries):assert.equal(s.inventory.sweet_berries,before.inventory.sweet_berries);assert.ok(s.inventory.spruce_log>=6);assert.equal(s.inventory.diamond,before.inventory.diamond);const allowedExtraTools=(process.env.MC_AUDIT_EXTRA_TOOLS||'').split(',').filter(Boolean)
 if(!allowedExtraTools.length)assert.deepEqual(s.tools.map(t=>t.name).sort(),before.tools.map(t=>t.name).sort())
 else{
  const counts=tools=>tools.reduce((m,t)=>(m[t.name]=(m[t.name]||0)+1,m),{})
  const old=counts(before.tools),now=counts(s.tools)
  for(const [name,count] of Object.entries(old))assert.ok(now[name]>=count,'Missing baseline tool: '+name)
  for(const [name,count] of Object.entries(now))assert.ok(count<=(old[name]||0)||allowedExtraTools.includes(name),'Unexpected new tool: '+name)
 }
 const condition=(b,o)=>`if block ${o.x+b.x} ${o.y+b.y} ${o.z+b.z} minecraft:${b.block}${b.properties&&Object.keys(b.properties).length?'['+Object.entries(b.properties).map(([k,v])=>`${k}=${v}`).join(',')+']':''}`
 const conditions=[]
 for(const [name,old] of Object.entries(before.projects))if(old.construction){assert.deepEqual(s.projects[name],old);conditions.push(...compileArchitecture(old.construction.design).cells.map(b=>condition(b,old.construction.origin)))}
 const base=before.projects.base;assert.deepEqual(s.projects.base.build,base.build)
 for(const b of base.build.design)conditions.push(condition({...b,block:b.block==='wood_planks'?base.build.wood.replace('_log','_planks'):b.block},base.build.origin))
 for(const [name,st] of Object.entries(base.stations))conditions.push(`if block ${st.position.x} ${st.position.y} ${st.position.z} minecraft:${name}`)
 const feedback=s.requestProgress.feedback||[]
 for(const h of feedback.flatMap(f=>f.result?.harvested||f.task?.harvested||[]))conditions.push(`if block ${h.position.x} ${h.position.y} ${h.position.z} minecraft:sweet_berry_bush`)
 for(let i=0;i<conditions.length;i+=12){const batch=conditions.slice(i,i+12),response=await rcon('execute '+batch.join(' ')+' run list');if(process.env.MC_AUDIT_CONTINUE==='1'&&!/players online/.test(response))(report.blockFailures??=[]).push({conditions:batch,response});else assert.match(response,/players online/);report.checks.push({conditions:batch,response});if(i%120===0)console.log('Verified '+Math.min(i+12,conditions.length)+'/'+conditions.length+' block conditions')}
 const chest=await serverChest(rcon,base.stations.chest.position);assert.deepEqual(chest.contents,base.stations.chest.contents)
 const retreat=feedback.findLast(f=>f.action==='retreat'&&f.result?.receipt==='sheltered_door_closed')?.result||s.safety?.retreat;assert.ok(retreat)
 const d=retreat.door.position;assert.match(await rcon(`execute if block ${d.x} ${d.y} ${d.z} minecraft:spruce_door[open=false] run list`),/players online/)
 const inventory=await rcon('data get entity HarnessRunner Inventory[{id:"minecraft:sweet_berries"}].count');assert.ok(Number(inventory.match(/entity data: (\d+)$/)?.[1])>=12)
 const serverLogs=await rcon('data get entity HarnessRunner Inventory[{id:"minecraft:spruce_log"}].count');assert.ok(Number(serverLogs.match(/entity data: (\d+)$/)?.[1])>=6)
 const difficulty=await rcon('difficulty');assert.match(difficulty,/Peaceful/)
 Object.assign(report,{status:report.blockFailures?.length?'failed':'passed',berries:s.inventory.sweet_berries,logs:s.inventory.spruce_log,retreat,health:s.health,diamonds:s.inventory.diamond,difficulty,serverInventory:inventory,serverLogs,baseChest:chest,position:s.position})
}catch(e){report.status='failed';report.error=e.message;process.exitCode=1}
if(report.status==='failed')process.exitCode=1
writeFileSync(process.env.MC_AUDIT_REPORT||'results/connected-recovery-server-verified.json',JSON.stringify(report,null,2));console.log(JSON.stringify({...report,checks:report.checks.length}))
