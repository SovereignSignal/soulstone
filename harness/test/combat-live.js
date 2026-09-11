import assert from 'node:assert/strict'
import mineflayer from 'mineflayer'
import {once} from 'node:events'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import {readFileSync,writeFileSync,mkdirSync,readdirSync,appendFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {Vec3} from 'vec3'
import {Runner} from '../src/runner.js'
import {Teammate} from '../src/companion/controller.js'

if(process.argv.includes('--dry-run')){console.log(JSON.stringify({scope:'Existing disposable lab; isolated supplied-weapon fixture on reserved air pad; Normal difficulty, natural spawning disabled. Three lone melee mobs and Stop during a fourth fight. Server kill statistics and entity death checked. Main inventory/projects preserved, fixture removed and original Peaceful rules restored. No model calls.',mobs:['husk','zombie','spider'],pad:[640,250,0,660,270,22]},null,2));process.exit(0)}
assert.equal(process.env.MC_LAB_EXPERIMENT,'yes','Disposable lab opt-in required')
const host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const run=promisify(execFile),rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const main=async()=>{const a=JSON.parse(readFileSync('state/companion-api.json'));const r=await fetch(a.url+'/state',{headers:{Authorization:'Bearer '+a.token},signal:AbortSignal.timeout(5000)});assert.ok(r.ok);return r.json()}
const directory='results/combat-live-'+Date.now();mkdirSync(directory,{recursive:true})
const sources=[...readdirSync('src',{recursive:true}).filter(p=>/\.(js|txt)$/.test(p)).map(p=>'src/'+p),'package-lock.json']
const hashes=()=>Object.fromEntries(sources.map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]))
const report={status:'running',directory,startedAt:Date.now(),trials:[],forcedChunks:[],hashes:hashes()},save=()=>writeFileSync(directory+'/report.json',JSON.stringify(report,null,2))
let witness,runner,controller,owned=false,rulesChanged=false,interrupted=false,tag,objective
const check=()=>assert.ok(!interrupted,'Operator interrupted fixture')
const wait=async(predicate,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){check();if(predicate())return;await delay(50)}throw new Error(label)}
process.on('SIGINT',()=>{interrupted=true;controller?.stop()});process.on('SIGTERM',()=>{interrupted=true;controller?.stop()})
const area=[];for(let x=640;x<=660;x++)for(let y=250;y<=270;y++)for(let z=0;z<=22;z++)area.push(new Vec3(x,y,z))
const inside=p=>p&&p.x>=640&&p.x<=661&&p.z>=0&&p.z<=23&&p.y>=251&&p.y<255
async function preserveMain(){const s=await main();assert.ok(s.connected&&s.connectionId===report.before.connectionId);assert.deepEqual(s.inventory,report.before.inventory);assert.deepEqual(s.projects,report.before.projects);assert.equal(s.requestProgress?.id,report.before.requestProgress?.id);assert.equal(s.model,report.before.model);return s}
async function score(){const text=await rcon(`scoreboard players get HarnessTest ${objective}`);const n=text.match(/has (-?\d+) /);assert.ok(n,text);return {count:Number(n[1]),text}}
async function trial(mob,stop=false){
 const dir=directory+'/'+(stop?'stop':mob);mkdirSync(dir)
 const result={mob,stop,status:'setting_up',events:[],samples:[]};report.trials.push(result);save()
 let timer
 try{
  check();assert.deepEqual(hashes(),report.hashes);await preserveMain()
  runner=new Runner({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565),username:'HarnessTest',version:'1.21.4',owner:'HarnessWitness',statePath:dir+'/bot.json'})
  runner.on('event',e=>{if(['task_started','task_finished','skill_progress','death','disconnected'].includes(e.type)){result.events.push(structuredClone(e));appendFileSync(dir+'/events.jsonl',JSON.stringify(e)+'\n')}})
  runner.start();const reset=()=>runner.bot.respawn();runner.bot.once('death',reset)
  await wait(()=>runner.ready,'Test account join failed');runner.bot.removeListener('death',reset)
  for(const c of ['gamemode creative HarnessTest','clear HarnessTest','tp HarnessTest 650.5 252 9.5 0 0','tp HarnessWitness 648.5 251 9.5'])await rcon(c)
  await wait(()=>runner.bot.entity.onGround&&Math.abs(runner.bot.entity.position.y-251)<.02,'Fixture did not settle before survival')
  for(const c of ['give HarnessTest iron_axe 1','give HarnessTest shield 1','gamemode survival HarnessTest','effect give HarnessTest instant_health 1 10 true','effect give HarnessTest saturation 1 10 true'])await rcon(c)
  await wait(()=>runner.bot.health===20&&runner.bot.food===20&&runner.bot.inventory.items().some(i=>i.name==='iron_axe')&&runner.bot.inventory.items().some(i=>i.name==='shield'),'Fixture equipment not synchronized')
  controller=new Teammate(runner,{model:'no-model-needed',plan:()=>{throw new Error('Combat must not call a model')}},dir+'/teammate.json')
  controller.dispatch({action:'follow',player:'HarnessWitness'})
  tag='soulstone_combat_'+Date.now();objective='ssc'+String(Date.now()).slice(-9)
  assert.match(await rcon(`scoreboard objectives add ${objective} minecraft.killed:minecraft.${mob}`),/Created/)
  await rcon(`scoreboard players set HarnessTest ${objective} 0`)
  result.before={connection:runner.connectionId,health:runner.bot.health,position:runner.position(),killScore:await score()};result.startedAt=Date.now();result.status='running';save()
  await rcon(`summon ${mob} 650.5 251 13.5 {Tags:["${tag}"],PersistenceRequired:1b}`)
  const until=Date.now()+40000;let stopped=false
  while(Date.now()<until){
   check();const s=controller.snapshot();assert.ok(s.connected,'Combat connection lost');assert.ok(s.health>0,'Bot died');assert.ok(inside(s.position),'Bot left fixture')
   const sample={at:Date.now(),phase:s.phase,health:s.health,food:s.survival.food,position:s.position,combat:structuredClone(runner.task?.combat),safety:structuredClone(s.safety)}
   result.samples.push(sample)
   if(stop&&!stopped&&runner.task?.combat?.attacks>=1){
    result.beforeStop={attacks:runner.task.combat.attacks,killScore:await score()};controller.stop();stopped=true
    await runner.waitForIdle(new AbortController().signal);await delay(1200)
    result.afterStop={attacks:runner.task.combat.attacks,killScore:await score(),status:controller.safety.status,targetPresent:!!Object.values(runner.bot.entities).find(e=>e.name===mob)}
    assert.equal(result.afterStop.attacks,result.beforeStop.attacks);assert.equal(result.afterStop.killScore.count,0);assert.equal(result.afterStop.status,'cancelled');assert.ok(result.afterStop.targetPresent)
    break
   }
   if(!stop&&result.events.some(e=>e.type==='task_finished'&&e.task?.kind==='defend'&&e.task.status==='completed')&&runner.task?.kind==='follow'&&runner.task.status==='running')break
   if(s.safety?.status==='failed')throw new Error(s.safety.error)
   await delay(50)
  }
  result.killScore=await score();result.final=controller.snapshot();result.endedAt=Date.now()
  if(stop)assert.ok(stopped,'Combat did not reach the Stop checkpoint')
  else{
   assert.equal(result.killScore.count,1,'Server did not attribute a kill to the bot')
   const finished=result.events.find(e=>e.type==='task_finished'&&e.task?.kind==='defend'&&e.task.status==='completed')
   assert.equal(finished?.task.result.receipt,'target_death_observed');assert.ok(finished.task.result.attacks>0);assert.ok(finished.task.result.shield)
   assert.equal(runner.task.kind,'follow');assert.equal(runner.task.status,'running');assert.equal(result.events.some(e=>e.task?.kind==='retreat'),false)
  }
  assert.equal(runner.connectionId,result.before.connection);assert.deepEqual(hashes(),report.hashes);await preserveMain();result.status='passed'
 }catch(error){result.status='failed';result.error=error.stack||error.message;throw error}
 finally{
  clearInterval(timer);controller?.stop();runner?.close();runner=null;controller=null
  if(tag){await rcon(`kill @e[tag=${tag}]`);tag=null}
  if(objective){await rcon(`scoreboard objectives remove ${objective}`);objective=null}
  writeFileSync(dir+'/report.json',JSON.stringify(result,null,2));save();console.log(JSON.stringify({mob,stop,status:result.status,error:result.error,seconds:(result.endedAt-result.startedAt)/1000,minimumHealth:Math.min(...result.samples.map(s=>s.health)),killScore:result.killScore?.count}))
  await delay(500)
 }
}
try{
 report.before=await main();assert.ok(report.before.connected&&report.before.phase==='ready','Main bot must be idle');assert.match(await rcon('difficulty'),/Peaceful/)
 assert.ok(!/HarnessTest|HarnessWitness/.test(await rcon('list')),'Fixture account already in use')
 report.rules={difficulty:await rcon('difficulty'),spawning:await rcon('gamerule doMobSpawning'),daylight:await rcon('gamerule doDaylightCycle'),time:await rcon('time query daytime')}
 assert.match(report.rules.spawning,/false/);assert.match(report.rules.daylight,/false/);assert.match(report.rules.time,/6000/);save()
 witness=mineflayer.createBot({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565),username:'HarnessWitness',version:'1.21.4'});witness.on('error',e=>report.witnessError=e.message)
 await once(witness,'spawn',{signal:AbortSignal.timeout(20000)});await rcon('gamemode spectator HarnessWitness');await rcon('tp HarnessWitness 650.5 255 9.5')
 for(const [x,z]of [[640,0],[656,0],[640,16],[656,16]]){if(!/is marked for force loading/.test(await rcon(`forceload query ${x} ${z}`))){await rcon(`forceload add ${x} ${z}`);report.forcedChunks.push([x,z]);save()}}
 await wait(()=>area.every(p=>witness.blockAt(p)),'Fixture terrain not observed')
 for(const p of area)assert.equal(witness.blockAt(p).name,'air','Reserved fixture is occupied at '+p)
 report.checkpoint={rules:report.rules,fixture:'Every reserved block independently observed as air',main:report.before};save()
 owned=true;await rcon('fill 640 250 0 660 250 22 stone');await rcon('fill 640 255 0 660 255 22 stone');rulesChanged=true;await rcon('difficulty normal')
 for(const mob of ['husk','zombie','spider'])await trial(mob)
 await trial('husk',true);report.status='passed'
}catch(error){report.status='failed';report.error=error.stack||error.message;process.exitCode=1}
finally{
 controller?.stop();runner?.close()
 try{
  if(tag)await rcon(`kill @e[tag=${tag}]`)
  if(objective)await rcon(`scoreboard objectives remove ${objective}`)
  if(rulesChanged){await rcon('difficulty peaceful');await rcon('gamerule doMobSpawning false');await rcon('gamerule doDaylightCycle false');await rcon('time set 6000')}
  if(owned){assert.equal(Object.values(witness.players).filter(p=>!['HarnessTest','HarnessWitness'].includes(p.username)&&p.entity&&distanceFrom(p.entity.position)<40).length,0,'Player entered fixture; cleanup requires review');await rcon('fill 640 250 0 660 270 22 air');await delay(300);assert.ok(area.every(p=>witness.blockAt(p)?.name==='air'));report.fixtureRemoved=true}
  for(const [x,z]of report.forcedChunks)await rcon(`forceload remove ${x} ${z}`)
  report.finalRules={difficulty:await rcon('difficulty'),spawning:await rcon('gamerule doMobSpawning'),daylight:await rcon('gamerule doDaylightCycle'),time:await rcon('time query daytime')};assert.deepEqual(report.finalRules,report.rules)
  report.after=await preserveMain()
 }catch(error){report.cleanupError=error.stack||error.message;report.status='failed';process.exitCode=1}
 witness?.quit();report.endedAt=Date.now();save();console.log(JSON.stringify({status:report.status,directory,error:report.error,cleanupError:report.cleanupError}));setTimeout(()=>process.exit(process.exitCode||0),500)
}
function distanceFrom(p){return Math.hypot(p.x-650,p.y-251,p.z-10)}
