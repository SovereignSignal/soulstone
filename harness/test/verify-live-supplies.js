import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFileSync,writeFileSync} from 'node:fs'
import {serverChest} from './server-chest.js'
const a=JSON.parse(readFileSync('state/companion-api.json')),response=await fetch(a.url+'/state',{headers:{Authorization:'Bearer '+a.token}})
assert.ok(response.ok);const s=await response.json();assert.equal(s.phase,'ready','Wait for the active goal to finish')
const before=JSON.parse(readFileSync('results/live-supplies-before.json'))
assert.equal(s.requestProgress.request,before.request,'A different request is active')
const run=promisify(execFile),ssh=process.env.MC_SSH_HOST,player=process.env.MC_USERNAME||'HarnessRunner'
assert.match(ssh,/^[A-Za-z0-9_.-]+$/);assert.match(player,/^[A-Za-z0-9_]{1,16}$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',ssh,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const report={status:'running',scope:'Independent read-only server verification of natural-world supplies goal',request:before.request,inventory:{},tools:[],reads:[]}
try{
 for(let index=0;index<36;index++){
  const at=`Inventory[${index}]`,id=await rcon(`data get entity ${player} ${at}.id`);report.reads.push(id)
  if(id===`Found no elements matching ${at}`)break
  const name=id.match(/"minecraft:([a-z0-9_]+)"$/)?.[1];assert.ok(name,id)
  const amount=await rcon(`data get entity ${player} ${at}.count`);report.reads.push(amount)
  const count=Number(amount.match(/entity data: (\d+)$/)?.[1]);assert.ok(count>=1&&count<=64,amount)
  report.inventory[name]=(report.inventory[name]||0)+count
  if(name==='iron_pickaxe'){
   const raw=await rcon(`data get entity ${player} ${at}.components."minecraft:damage"`);report.reads.push(raw)
   const match=raw.match(/entity data: (\d+)$/);assert.ok(match||/^Found no elements matching/.test(raw),raw)
   const damage=match?Number(match[1]):0;report.tools.push({index,damage,remaining:250-damage})
  }
 }
 report.chest=await serverChest(rcon,s.projects.base.stations.chest.position)
 const raw=await rcon(`data get entity ${player} Pos`);report.reads.push(raw)
 const p=raw.match(/\[([^\]]+)\]/)?.[1].split(',').map(n=>Number(n.trim().replace(/d$/,'')))
 assert.ok(p?.length===3&&p.every(Number.isFinite),raw);report.position=p
 const base=s.projects.base.stations.crafting_table.position
 report.distanceToBase=Math.hypot(p[0]-base.x,p[1]-base.y,p[2]-base.z)
 assert.ok(report.tools.filter(t=>t.remaining>=125).length>=2,'Two serviceable iron picks were not confirmed')
 assert.equal(report.inventory.diamond,1);assert.ok(report.chest.contents.coal>=8)
 assert.ok(report.chest.contents.granite>=before.before.inventory.granite)
 assert.ok(report.chest.contents.cobblestone>=before.before.inventory.cobblestone-32)
 assert.ok(report.distanceToBase<5);assert.equal(s.projects.base.expedition.trail.length,0)
 report.requestRounds=s.requestProgress.rounds;report.status='passed'
}catch(error){report.status='failed';report.error=error.stack;process.exitCode=1}
writeFileSync('results/live-supplies-server-verified.json',JSON.stringify(report,null,2))
console.log(JSON.stringify(report,null,2))
