import assert from 'node:assert/strict'
import mineflayer from 'mineflayer'
import {once} from 'node:events'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFileSync,writeFileSync} from 'node:fs'
import {Vec3} from 'vec3'
import {compileArchitecture} from '../src/construction.js'
import {installLightReader} from '../src/lighting.js'
import {eatFood,survivalObservation} from '../src/survival.js'
import {serverChest} from './server-chest.js'
const a=JSON.parse(readFileSync('state/companion-api.json')),s=await(await fetch(a.url+'/state',{headers:{Authorization:'Bearer '+a.token}})).json(),before=JSON.parse(readFileSync('results/survival-lighting-live-before.json'))
const run=promisify(execFile),host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const report={status:'running',scope:'Independent world audit and fresh observer chunk light; no world edits. Only observer identity repositioned.',checks:[]}
let bot
try{
 assert.equal(s.phase,'ready');assert.equal(s.projects.compact_storehouse.result.partial,false)
 const conditions=[],c=s.projects.compact_storehouse.construction,bp=compileArchitecture(c.design),torches=bp.blocks.filter(b=>b.block==='torch');assert.ok(torches.length>0&&torches.length<=2)
 const condition=(b,o)=>`if block ${o.x+b.x} ${o.y+b.y} ${o.z+b.z} minecraft:${b.block}${b.properties&&Object.keys(b.properties).length?'['+Object.entries(b.properties).map(([k,v])=>`${k}=${v}`).join(',')+']':''}`
 for(const [name,p] of Object.entries(before.projects)){
  if(name!=='compact_storehouse')assert.deepEqual(s.projects[name],p)
  if(p.construction)conditions.push(...compileArchitecture(p.construction.design).cells.filter(b=>b.block!=='air').map(b=>condition(b,p.construction.origin)))
 }
 conditions.push(...bp.cells.map(b=>condition(b,c.origin)))
 const base=before.projects.base
 for(const b of base.build.design)conditions.push(condition({...b,block:b.block==='wood_planks'?base.build.wood.replace('_log','_planks'):b.block},base.build.origin))
 for(const [block,station] of Object.entries(base.stations))conditions.push(`if block ${station.position.x} ${station.position.y} ${station.position.z} minecraft:${block}`)
 for(let i=0;i<conditions.length;i+=12){const batch=conditions.slice(i,i+12),response=await rcon('execute '+batch.join(' ')+' run list');assert.match(response,/players online/);report.checks.push({conditions:batch,response})}
 const chest=await serverChest(rcon,base.stations.chest.position);assert.deepEqual(chest.contents,base.stations.chest.contents)
 assert.equal(s.inventory.diamond,before.inventory.diamond);assert.deepEqual(s.tools,before.tools);assert.equal(before.inventory.torch-s.inventory.torch,torches.length)
 const difficulty=await rcon('difficulty');assert.match(difficulty,/Peaceful/)
 bot=mineflayer.createBot({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565),username:'HarnessWitness',version:'1.21.4',auth:'offline'});installLightReader(bot)
 await once(bot,'spawn');await rcon(`tp HarnessWitness ${c.origin.x+2.5} ${c.origin.y+5} ${c.origin.z+2.5}`);await new Promise(r=>setTimeout(r,2500));await bot.waitForChunksToLoad()
 const lighting=[]
 for(let x=1;x<=3;x++)for(let y=2;y<=3;y++)for(let z=2;z<=3;z++){
  const p=new Vec3(c.origin.x+x,c.origin.y+y,c.origin.z+z),block=bot.blockAt(p)
  if(['air','torch'].includes(block?.name)){const level=bot.getObservedBlockLight(p);assert.ok(Number.isInteger(level)&&level>=8,'Unlit or unknown cell '+p+': '+level);lighting.push({position:p,block:block.name,blockLight:level})}
 }
 assert.ok(lighting.length>=6)
 const fullHunger=await eatFood(bot,{goal:{item:'bread',count:1}},{check(){},stage(){},progress(){},persist(){}});assert.equal(fullHunger.receipt,'hunger_already_full');assert.equal(fullHunger.count,0)
 Object.assign(report,{status:'passed',torches:torches.map(b=>({x:c.origin.x+b.x,y:c.origin.y+b.y,z:c.origin.z+b.z})),lighting,fullHunger,observation:survivalObservation(bot),difficulty,diamonds:s.inventory.diamond,carriedTorches:s.inventory.torch,health:s.health,baseChest:chest,walkthrough:s.projects.compact_storehouse.result.walkthrough,interactions:s.projects.compact_storehouse.result.interactions,furnishings:s.projects.compact_storehouse.result.furnishings})
}catch(e){report.status='failed';report.error=e.message;process.exitCode=1}finally{bot?.quit()}
writeFileSync('results/survival-lighting-server-verified.json',JSON.stringify(report,null,2));console.log(JSON.stringify({...report,checks:report.checks.length}))
