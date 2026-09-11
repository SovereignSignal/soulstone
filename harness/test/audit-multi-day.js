import {readFileSync,writeFileSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import assert from 'node:assert/strict'
import {compileArchitecture} from '../src/construction.js'
import {shelterLayout} from '../src/shelter.js'
import {serverChest} from './server-chest.js'
const directory=process.argv[2],label=process.argv[3]||'after';assert.match(directory,/^results\/(?:multi-day|frontier-live)-\d+$/);assert.match(label,/^[a-z]+$/)
const report=JSON.parse(readFileSync(directory+'/report.json')),before=report.before,host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const run=promisify(execFile),rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const result={status:'running',scope:'Compare saved structures and storage; retain the previously documented dirt-at-castle-air exception without changing it',checks:[],knownDeviation:[]}
try{
 const conditions=[]
 const add=(b,o)=>{
  const p={x:o.x+b.x,y:o.y+b.y,z:o.z+b.z}
  if(p.x===-580&&p.y===69&&p.z===-311&&b.block==='air'){
   result.knownDeviation.push({position:p,design:'air',previouslyObserved:'dirt'});b={...b,block:'dirt',properties:{}}
  }
  conditions.push(`if block ${p.x} ${p.y} ${p.z} minecraft:${b.block}${b.properties&&Object.keys(b.properties).length?'['+Object.entries(b.properties).map(([k,v])=>`${k}=${v}`).join(',')+']':''}`)
 }
 for(const project of Object.values(before.projects))if(project.construction){const c=project.construction;for(const cell of compileArchitecture(c.design).cells)add(cell,c.origin)}
 const base=before.projects.base,origin=base.build.origin
 for(const b of base.build.design)add({...b,block:b.block==='wood_planks'?base.build.wood.replace('_log','_planks'):b.block},origin)
 for(const [block,station] of Object.entries(base.stations))conditions.push(`if block ${station.position.x} ${station.position.y} ${station.position.z} minecraft:${block}`)
 const layout=shelterLayout(base.build.design),door=layout.door
 for(const half of [0,1])add({x:door.x,y:door.y+half,z:door.z,block:base.build.wood.replace('_log','_door'),properties:{half:half?'upper':'lower',open:false}},origin)
 for(let i=0;i<conditions.length;i+=12){const batch=conditions.slice(i,i+12),response=await rcon('execute '+batch.join(' ')+' run list');result.checks.push({conditions:batch,response});assert.match(response,/players online/,'Block comparison failed: '+batch.join('; '))}
 result.chest=await serverChest(rcon,base.stations.chest.position);assert.deepEqual(result.chest.contents,base.stations.chest.contents)
 result.diamonds=await rcon('data get entity HarnessRunner Inventory[{id:"minecraft:diamond"}].count');assert.match(result.diamonds,new RegExp(`entity data: ${before.inventory.diamond}$`))
 result.health=await rcon('data get entity HarnessRunner Health');result.status='passed';result.cellCount=conditions.length
}catch(e){result.status='failed';result.error=e.message;process.exitCode=1}
writeFileSync(directory+'/audit-'+label+'.json',JSON.stringify(result,null,2));console.log(JSON.stringify({...result,checks:result.checks.length,chest:result.chest?.contents}))
