import assert from 'node:assert/strict'
import mineflayer from 'mineflayer'
import {once} from 'node:events'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {Vec3} from 'vec3'
import {Runner} from '../src/runner.js'
import {Teammate} from '../src/companion/controller.js'
import {LocalPlanner} from '../src/companion/planner.js'
import {ModelProfiles} from '../src/companion/providers.js'
import {EpisodeRecorder} from '../src/companion/episodes.js'
import {verifyArchitecture} from './architecture-check.js'
import {coveredDeck} from './frontier-requirements.js'
import {compileArchitecture} from '../src/construction.js'
import {serverTools} from './server-tools.js'
import {terrainSummary} from '../src/observations.js'

const cases={
 lookout:{request:'Build a compact roofed lookout here using only oak planks and at most 72 placed blocks. I need a clear rectangular deck at least two by three blocks, with its walking surface at least two blocks above the ground. Cover the whole deck with a roof while leaving at least two clear blocks of headroom. Provide a route I can walk up from the ground and physically walk onto the covered deck before finishing. Fit the available stone pad. Work out the layout and crafting yourself.',kit:[['oak_log',20]]},
 equipment:{request:'Prepare a quarry kit: two serviceable stone pickaxes, one serviceable stone axe, sixteen torches, and at least twenty-four birch planks. Keep the worn stone pickaxe and both diamonds unchanged as well. Craft what is needed from these supplies and keep everything in your inventory; do not hand anything over or mine the test pad.',kit:[['birch_log',10],['cobblestone',9],['coal',4],['diamond',2],['stone_pickaxe[minecraft:damage=119]',1]]}
}
const familyFilter=process.argv.find(a=>a.startsWith('--family='))?.slice(9)
assert.ok(!familyFilter||Object.hasOwn(cases,familyFilter),'Unknown task family')
const schedule=[['lookout','codex-astra'],['lookout','claude-max'],['equipment','claude-max'],['equipment','codex-astra']].filter(([family])=>!familyFilter||family===familyFilter)
const pad={minX:640,maxX:660,minZ:0,maxZ:22,minY:250,maxY:270}
if(process.argv.includes('--dry-run')){console.log(JSON.stringify({cases,schedule,pad,scope:`${schedule.length} live fixture requests; no fixture commands or model calls in dry-run.`},null,2));process.exit(0)}
if(process.env.MC_LAB_EXPERIMENT!=='yes')throw new Error('Disposable lab opt-in required')
const run=promisify(execFile),host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const main=async()=>{const a=JSON.parse(readFileSync('state/companion-api.json'));return(await fetch(a.url+'/state',{headers:{Authorization:'Bearer '+a.token},signal:AbortSignal.timeout(5000)})).json()}
const profiles=new ModelProfiles('state/models.json');for(const id of schedule.map(x=>x[1]))assert.ok(profiles.profiles.some(p=>p.id===id&&['codex','claude'].includes(p.kind)))
const directory='results/frontier-live-'+Date.now();mkdirSync(directory,{recursive:true})
const sources=[...readdirSync('src',{recursive:true}).filter(p=>/\.(js|txt)$/.test(p)).map(p=>'src/'+p),'package-lock.json']
const hashes=()=>Object.fromEntries(sources.map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]))
const report={status:'running',scope:'One trial per selected task/provider on supplied fixtures in the existing Peaceful lab; provider order reverses between the lookout and equipment families. Fresh profiles, no shared experience, no source edits during requests. Not natural resource sourcing, survival, a raw-model benchmark or a statistical ranking.',cases,schedule,pad,sourceHashes:hashes(),trials:[],forcedChunks:[]}
const save=()=>writeFileSync(directory+'/report.json',JSON.stringify(report,null,2))
let witness,runner,controller,fixtureOwned=false,interrupted=false
process.on('SIGINT',()=>{interrupted=true;controller?.stop()});process.on('SIGTERM',()=>{interrupted=true;controller?.stop()})
const within=p=>p&&p.x>=pad.minX&&p.x<pad.maxX+1&&p.z>=pad.minZ&&p.z<pad.maxZ+1&&p.y>=251&&p.y<270
const waitReady=async(predicate,label)=>{const end=Date.now()+20000;while(Date.now()<end){assert.ok(!interrupted,'Operator stopped trial');if(predicate())return;await delay(100)}throw new Error(label)}
const floor=[];for(let x=640;x<=660;x++)for(let z=0;z<=22;z++)floor.push(new Vec3(x,250,z))
async function preserveMain(){const s=await main();assert.ok(s.connected&&s.connectionId===report.before.connectionId,'Main bot connection changed');assert.equal(s.requestProgress?.id,report.before.requestProgress?.id,'Main bot request changed');assert.deepEqual(s.inventory,report.before.inventory,'Main bot inventory changed');assert.deepEqual(s.projects,report.before.projects,'Main bot project memory changed');assert.equal(s.model,report.before.model);assert.equal(s.survival.difficulty,'peaceful');return s}
async function clearPad(){
 const others=Object.values(witness.players).filter(p=>!['HarnessTest','HarnessWitness'].includes(p.username)&&p.entity&&p.entity.position.distanceTo(witness.entity.position)<40)
 assert.equal(others.length,0,'Another player is near the fixture; cleanup needs review')
 await rcon('fill 640 251 0 660 270 22 minecraft:air')
}
async function trial(family,id){
 const spec=cases[family],profile=profiles.profiles.find(p=>p.id===id),dir=directory+'/'+family+'-'+id;mkdirSync(dir)
 const result={family,profile:{id:profile.id,kind:profile.kind,model:profile.model},status:'running',timings:{formulate:[],plan:[],reflect:[]},samples:[],operatorResumes:0};report.trials.push(result);save()
 let timer,guard,stopped=false,lastLog=0,guardError
 try{
  assert.ok(!interrupted);assert.deepEqual(hashes(),report.sourceHashes);await preserveMain();await clearPad()
  await rcon('fill 640 250 0 660 250 22 minecraft:stone')
  runner=new Runner({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565),username:'HarnessTest',version:'1.21.4',owner:'HarnessWitness',statePath:dir+'/bot.json'})
  runner.start()
  // An interrupted fixture can leave this test-only account on a death screen.
  // Reset it during setup only; trial deaths never auto-respawn.
  const resetDeadFixture=()=>{result.setupRespawns=(result.setupRespawns||0)+1;runner.bot.respawn()}
  runner.bot.once('death',resetDeadFixture)
  for(let i=0;i<60&&!runner.ready;i++)await delay(500)
  runner.bot.removeListener('death',resetDeadFixture);assert.ok(runner.ready,'Test bot failed to join')
  // Restored client positions can start fractionally inside the old pad floor.
  // Establish a grounded position before survival so stale fall state cannot
  // kill the fixture account before the model has even received its request.
  for(const c of ['gamemode creative HarnessTest','clear HarnessTest','tp HarnessTest 650.5 252 3.5 0 0','tp HarnessWitness 650.5 251 1.5 0 0'])await rcon(c)
  await waitReady(()=>runner.bot.entity.onGround&&Math.abs(runner.bot.entity.position.y-251)<.01,'Test bot did not land on the pad')
  for(const c of ['gamemode survival HarnessTest','effect give HarnessTest minecraft:instant_health 1 10 true','effect give HarnessTest minecraft:saturation 1 10 true',...spec.kit.map(([item,n])=>`give HarnessTest minecraft:${item} ${n}`)])await rcon(c)
  await waitReady(()=>{
   result.setup={ownerVisible:!!runner.bot.players.HarnessWitness?.entity,onGround:runner.bot.entity.onGround,position:runner.position(),health:runner.bot.health,food:runner.bot.food,stoneFloor:floor.filter(p=>runner.bot.blockAt(p)?.name==='stone').length}
   return result.setup.ownerVisible&&result.setup.onGround&&within(result.setup.position)&&result.setup.health===20&&result.setup.food===20&&result.setup.stoneFloor===floor.length
  },'Fixture player, health, inventory or terrain not ready')
  await waitReady(()=>spec.kit.every(([item,n])=>runner.bot.inventory.items().filter(i=>i.name===item.split('[')[0]).reduce((s,i)=>s+i.count,0)===n),'Fixture inventory not synchronized')
  const planner=new LocalPlanner();planner.profiles={current:profile,key:''}
  for(const name of ['formulate','plan','reflect']){const fn=planner[name].bind(planner);planner[name]=async(...args)=>{const t=Date.now();try{return await fn(...args)}finally{result.timings[name].push(Date.now()-t)}}}
  controller=new Teammate(runner,planner,dir+'/conversation.json',new EpisodeRecorder(dir+'/episodes'))
  assert.equal(controller.experience.entries.length,0);assert.equal(controller.messages.length,0)
  const s=controller.snapshot();assert.ok(s.ownerVisible&&s.health===20&&within(s.position));result.initial={inventory:s.inventory,tools:s.tools,position:s.position,ownerPosition:s.ownerPosition,health:s.health,food:s.survival.food,difficulty:s.survival.difficulty}
  result.initial.terrain=terrainSummary(runner.bot,{near:s.ownerPosition,projects:{}});assert.ok(result.initial.terrain.sites.length,'Fixture does not expose a supported building site')
  const paired=report.trials.find(t=>t!==result&&t.family===family&&t.initial);if(paired)assert.deepEqual(result.initial,paired.initial,'Initial conditions differ across models')
  result.startedAt=Date.now();console.log(JSON.stringify({event:'start',family,model:profile.model,directory}));save()
  timer=setTimeout(()=>{stopped=true;guardError='Ten-minute task deadline';controller.stop()},600000)
  guard=setInterval(()=>{
   const s=controller.snapshot(),sample={at:Date.now(),phase:s.phase,health:s.health,food:s.survival.food,position:s.position,activity:s.activity}
   result.samples.push(sample)
   if(!s.connected||s.health<16||!within(s.position)){stopped=true;guardError='Connection, health or fixture-boundary cutoff';controller.stop()}
   if(Date.now()-lastLog>30000){console.log(JSON.stringify({event:'progress',family,model:profile.model,...sample}));lastLog=Date.now();save()}
  },1000)
  await controller.submit(spec.request);clearTimeout(timer);clearInterval(guard)
  result.elapsedMs=Date.now()-result.startedAt;result.final=controller.snapshot();result.messages=result.final.messages.filter(m=>m.role==='assistant').map(m=>m.text)
  result.failures=result.final.requestProgress?.feedback?.filter(f=>f.status==='failed')||[];result.actions=result.final.requestProgress?.completed?.map(c=>c.step.action)||[]
  assert.ok(!stopped&&!interrupted,guardError||'Operator stopped trial');assert.deepEqual(hashes(),report.sourceHashes)
  assert.ok(['verified','needs_review'].includes(result.final.requestProgress?.status),result.final.requestProgress?.blocker||result.messages.at(-1));assert.ok(!result.actions.includes('give'),'Unrequested delivery')
  for(let x=640;x<=660;x++)for(let z=0;z<=22;z++)assert.equal(witness.blockAt(new Vec3(x,250,z))?.name,'stone','Fixture ground was changed')
  if(family==='lookout'){
   const name=result.final.requestProgress.goal.criteria.find(c=>c.kind==='construction')?.target,project=controller.projects[name]
   result.audit=await verifyArchitecture(rcon,project,{palette:'oak_planks',height:2,budget:72,pad})
   result.audit.coveredDeck=coveredDeck(compileArchitecture(project.construction.design),project.construction.origin,project.result.walkthrough)
   assert.ok(result.audit.coveredDeck,'No walked 2-by-3 covered deck with two clear headroom blocks')
   const o=project.construction.origin,headroom=result.audit.coveredDeck.floor.flatMap(p=>[1,2].map(dy=>`if block ${p.x+o.x} ${p.y+o.y+dy} ${p.z+o.z} minecraft:air`))
   result.audit.deckHeadroom=await rcon('execute '+headroom.join(' ')+' run list');assert.match(result.audit.deckHeadroom,/players online/)
  }else{
   result.audit={}
   for(const [name,count]of [['stone_pickaxe',2],['stone_axe',1]]){const tools=await serverTools(rcon,'HarnessTest',runner.bot.inventory.items(),name);assert.ok(tools.filter(t=>t.remaining>=Math.max(32,Math.ceil(t.maximum/2))).length>=count,'Not enough serviceable '+name);result.audit[name]=tools}
   assert.ok(result.audit.stone_pickaxe.some(t=>t.damage===119),'Worn pickaxe was not retained unchanged')
   for(const [name,count]of [['torch',16],['birch_planks',24],['diamond',2]]){const response=await rcon(`data get entity HarnessTest Inventory[{id:"minecraft:${name}"}].count`),n=Number(response.match(/entity data: (\d+)$/)?.[1]);assert.ok(name==='diamond'?n===count:n>=count,response);result.audit[name]={count:n,response}}
  }
  await preserveMain();result.status='passed'
 }catch(error){result.status=result.startedAt?'failed':'setup_failed';result.error=error.message;result.final??=controller?.snapshot();console.log(JSON.stringify({event:'failed',family,model:profile.model,error:error.message}))}
 finally{
  clearTimeout(timer);clearInterval(guard);controller?.cancel();if(runner?.ready){await rcon('clear HarnessTest').catch(()=>{});await rcon('gamemode spectator HarnessTest').catch(()=>{})}runner?.close();runner=null;controller=null
  writeFileSync(dir+'/report.json',JSON.stringify(result,null,2));save();await delay(1500)
  console.log(JSON.stringify({event:'finished',family,model:profile.model,status:result.status,seconds:result.elapsedMs/1000,failures:result.failures?.length,error:result.error}))
 }
 return result
}
try{
 report.before=await main();assert.ok(report.before.connected&&report.before.phase==='ready');assert.match(await rcon('difficulty'),/Peaceful/)
 const players=await rcon('list');assert.ok(!/HarnessTest|HarnessWitness/.test(players),'Test account already online')
 report.rules={difficulty:await rcon('difficulty'),spawning:await rcon('gamerule doMobSpawning'),daylight:await rcon('gamerule doDaylightCycle')};save()
 witness=mineflayer.createBot({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565),username:'HarnessWitness',version:'1.21.4'});witness.on('error',e=>{report.witnessError=e.message});await once(witness,'spawn',{signal:AbortSignal.timeout(20000)})
 await rcon('gamemode spectator HarnessWitness');await rcon('tp HarnessWitness 650.5 255 1.5')
 for(const [x,z]of [[640,0],[656,0],[640,16],[656,16]]){const previous=await rcon(`forceload query ${x} ${z}`);if(!/is marked for force loading/.test(previous)){await rcon(`forceload add ${x} ${z}`);report.forcedChunks.push([x,z]);save()}}
 await waitReady(()=>floor.every(p=>witness.blockAt(p)),'Observer fixture chunks did not arrive')
 for(let x=640;x<=660;x++)for(let y=250;y<=270;y++)for(let z=0;z<=22;z++)assert.equal(witness.blockAt(new Vec3(x,y,z))?.name,'air',`Fixture is not empty at ${x},${y},${z}`)
 fixtureOwned=true;await rcon('fill 640 250 0 660 250 22 minecraft:stone');await rcon('gamemode creative HarnessWitness');save();writeFileSync(directory+'/design.json',JSON.stringify({...report,trials:[]},null,2))
 for(const [family,id]of schedule){assert.ok(!interrupted);const result=await trial(family,id);assert.notEqual(result.status,'setup_failed','Fixture setup failed; stop before calling another model')}
 report.status='completed';report.passed=report.trials.filter(t=>t.status==='passed').length
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1}
finally{
 controller?.stop();runner?.close()
 try{if(fixtureOwned){await rcon('gamemode spectator HarnessWitness');await clearPad();await rcon('fill 640 250 0 660 250 22 minecraft:air');await delay(500);for(let x=640;x<=660;x++)for(let y=250;y<=270;y++)for(let z=0;z<=22;z++)assert.equal(witness.blockAt(new Vec3(x,y,z))?.name,'air');report.fixtureRemoved=true}for(const [x,z]of report.forcedChunks)await rcon(`forceload remove ${x} ${z}`);report.after=await preserveMain();report.finalRules={difficulty:await rcon('difficulty'),spawning:await rcon('gamerule doMobSpawning'),daylight:await rcon('gamerule doDaylightCycle')};assert.deepEqual(report.finalRules,report.rules)}catch(error){report.cleanupError=error.message;report.status='failed';process.exitCode=1}
 witness?.quit();save();console.log(JSON.stringify({event:'complete',directory,status:report.status,passed:report.passed,cleanupError:report.cleanupError,trials:report.trials.map(t=>({family:t.family,model:t.profile.model,status:t.status,error:t.error,seconds:t.elapsedMs/1000}))}));setTimeout(()=>process.exit(process.exitCode||0),1000)
}
