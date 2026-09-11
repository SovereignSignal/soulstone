import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {setTimeout as delay} from 'node:timers/promises'
import pathfinding from 'mineflayer-pathfinder'
import {Vec3} from 'vec3'
import {Runner} from '../src/runner.js'
import {compileArchitecture} from '../src/construction.js'
import {verifyArchitecture} from './architecture-check.js'
import {coveredDeck} from './frontier-requirements.js'

const retained='results/frontier-live-1788971803343/lookout-codex-astra/report.json'
const previous=JSON.parse(readFileSync(retained)),construction=previous.final.projects.oak_pad_lookout.construction
const blueprint=compileArchitecture(construction.design),origin=new Vec3(...['x','y','z'].map(k=>construction.origin[k]))
const complete=process.argv.includes('--complete'),workAccess=process.argv.includes('--work-access')
if(process.argv.includes('--dry-run')){console.log(JSON.stringify({retained,complete,workAccess,blocks:blueprint.blocks.length,fixture:'Reserved 640..660 / 0..22 sky pad; reconstruct the recorded 27-block partial build, inspect roof supports, optionally execute with a three-block work platform added to the design; restore empty pad. The work platform is an operator-authored control, not model recovery.'}));process.exit(0)}
assert.equal(process.env.MC_LAB_EXPERIMENT,'yes')
const run=promisify(execFile),host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const main=async()=>{const a=JSON.parse(readFileSync('state/companion-api.json'));return(await fetch(a.url+'/state',{headers:{Authorization:'Bearer '+a.token},signal:AbortSignal.timeout(5000)})).json()}
const directory='results/lookout-replay-'+Date.now();mkdirSync(directory,{recursive:true})
const report={status:'running',retained,complete,workAccess,construction,forcedChunks:[]},save=()=>writeFileSync(directory+'/report.json',JSON.stringify(report,null,2))
let runner,owned=false,interrupted=false
process.on('SIGINT',()=>{interrupted=true;runner?.stop()});process.on('SIGTERM',()=>{interrupted=true;runner?.stop()})
const wait=async(predicate,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){assert.ok(!interrupted,'Interrupted');if(predicate())return;await delay(100)}throw new Error(label)}
const cells=[];for(let x=640;x<=660;x++)for(let y=250;y<=270;y++)for(let z=0;z<=22;z++)cells.push(new Vec3(x,y,z))
try{
 report.before=await main();assert.ok(report.before.connected&&report.before.phase==='ready');assert.match(await rcon('difficulty'),/Peaceful/)
 assert.ok(!/HarnessTest|HarnessWitness/.test(await rcon('list')),'Another fixture driver is active')
 runner=new Runner({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565),username:'HarnessTest',version:'1.21.4',statePath:directory+'/bot.json'})
 runner.on('event',e=>{if(e.type==='skill_progress')console.log(JSON.stringify(e))});runner.start();await wait(()=>runner.ready,'Test bot did not join')
 await rcon('gamemode spectator HarnessTest');await rcon('tp HarnessTest 650.5 255 3.5')
 for(const [x,z]of [[640,0],[656,0],[640,16],[656,16]])if(!/is marked for force loading/.test(await rcon(`forceload query ${x} ${z}`))){await rcon(`forceload add ${x} ${z}`);report.forcedChunks.push([x,z])}
 await wait(()=>cells.every(p=>runner.bot.blockAt(p)),'Fixture chunks did not arrive')
 // The retained interrupted trial owns this pad. Only its bare stone floor
 // may remain: refuse other structures rather than erasing an unknown build.
 const occupied=cells.filter(p=>runner.bot.blockAt(p).name!=='air')
 assert.ok(occupied.every(p=>p.y===250&&runner.bot.blockAt(p).name==='stone'),'Unexpected blocks on the reserved pad')
 report.retainedFloorBlocks=occupied.length
 assert.ok(Object.values(runner.bot.players).every(p=>p.username==='HarnessTest'||!p.entity||p.entity.position.distanceTo(runner.bot.entity.position)>40),'Another player is near the fixture')
 owned=true;await rcon('fill 640 250 0 660 250 22 minecraft:stone')
 for(const r of construction.design.filter(r=>r.block==='oak_planks'&&r.y<4))await rcon(`fill ${r.x+origin.x} ${r.y+origin.y} ${r.z+origin.z} ${r.x2+origin.x} ${r.y2+origin.y} ${r.z2+origin.z} minecraft:oak_planks`)
 const partial=blueprint.blocks.filter(b=>b.y<4)
 await wait(()=>partial.every(b=>runner.bot.blockAt(origin.offset(b.x,b.y,b.z))?.name===b.block),'Partial build not observed')
 for(const c of ['clear HarnessTest','give HarnessTest minecraft:oak_planks 15','tp HarnessTest 649.55 251 4.11','gamemode survival HarnessTest','effect give HarnessTest minecraft:instant_health 1 10 true'])await rcon(c)
 await wait(()=>runner.bot.entity.onGround&&runner.bot.entity.position.y===251&&runner.bot.inventory.items().some(i=>i.name==='oak_planks'&&i.count===15),'Bot readiness failed')
 report.roof=blueprint.blocks.filter(b=>b.y===4).map(b=>{
  const p=origin.offset(b.x,b.y,b.z),goal=new pathfinding.goals.GoalPlaceBlock(p,runner.bot.world,{range:4.5})
  const route=goal.facesPos.length?runner.bot.pathfinder.getPathTo(runner.movements,goal,3000):null
  return {position:p,faces:goal.facesPos.length,route:route&&{status:route.status,steps:route.path.length}}
 })
 report.firstSupportedIndex=report.roof.findIndex(b=>b.faces>0)
 assert.equal(partial.length,27);assert.equal(report.firstSupportedIndex,10)
 assert.ok(report.roof.filter(b=>b.faces>0).every(b=>b.route.status==='noPath'),'Recorded partial build should expose its missing working-height access')
 console.log(JSON.stringify({directory,firstSupportedIndex:report.firstSupportedIndex,roof:report.roof}));save()
 if(complete){
  const goal=structuredClone(construction)
  if(workAccess){goal.design.push({x:3,y:0,z:0,x2:3,y2:2,z2:0,block:'oak_planks'});await rcon('give HarnessTest minecraft:oak_planks 3');await wait(()=>runner.bot.inventory.items().some(i=>i.name==='oak_planks'&&i.count===18),'Extra work-platform inventory not observed')}
  report.executedConstruction=goal
  const startedAt=Date.now();runner.skill('construct',goal,180000)
  await wait(()=>!['running','paused'].includes(runner.task.status),'Construction did not finish',185000)
  report.task=runner.task;report.elapsedMs=Date.now()-startedAt
  if(workAccess){
   assert.equal(runner.task.status,'completed',runner.task.reason)
   report.audit=await verifyArchitecture(rcon,{construction:goal,result:runner.task.result},{palette:'oak_planks',height:2,budget:72,pad:{minX:640,maxX:660,minZ:0,maxZ:22}})
   report.audit.coveredDeck=coveredDeck(compileArchitecture(goal.design),origin,runner.task.result.walkthrough);assert.ok(report.audit.coveredDeck)
  }else{assert.equal(runner.task.status,'failed');assert.match(runner.task.reason,/reachable working height/);assert.ok(report.elapsedMs<120000,'Impossible roof should return useful feedback within two minutes')}
  report.health=runner.bot.health;assert.equal(report.health,20)
 }
 report.status='passed'
}catch(e){report.status='failed';report.error=e.stack;process.exitCode=1}
finally{
 runner?.stop()
 try{
  if(owned){await rcon('clear HarnessTest');await rcon('gamemode spectator HarnessTest');await rcon('fill 640 250 0 660 270 22 minecraft:air');await wait(()=>cells.every(p=>runner.bot.blockAt(p)?.name==='air'),'Cleanup not observed');report.fixtureRemoved=true}
  for(const [x,z]of report.forcedChunks)await rcon(`forceload remove ${x} ${z}`)
  report.after=await main();for(const k of ['connectionId','inventory','projects','model','requestProgress'])assert.deepEqual(report.after[k],report.before[k],`Main bot ${k} changed`)
 }catch(e){report.cleanupError=e.stack;report.status='failed';process.exitCode=1}
 runner?.close();save();console.log(JSON.stringify({directory,status:report.status,error:report.error,cleanupError:report.cleanupError,seconds:report.elapsedMs/1000}));setTimeout(()=>process.exit(process.exitCode||0),500)
}
