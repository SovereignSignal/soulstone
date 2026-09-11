import assert from 'node:assert/strict'
import mineflayer from 'mineflayer'
import {once} from 'node:events'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {Runner} from '../src/runner.js'
import {Teammate} from '../src/companion/controller.js'
import {LocalPlanner} from '../src/companion/planner.js'
import {ModelProfiles} from '../src/companion/providers.js'
import {EpisodeRecorder} from '../src/companion/episodes.js'
import {verifyArchitecture} from './architecture-check.js'
import {serverTools} from './server-tools.js'
if(process.env.MC_LAB_EXPERIMENT!=='yes')throw new Error('Disposable lab opt-in required')
const exec=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms)),host=process.env.MC_SSH_HOST
assert.match(host,/^[\w.-]+$/)
const rcon=async c=>(await exec('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const root=resolve('results/experience-ablation-'+Date.now());mkdirSync(root,{recursive:true})
const seedText=readFileSync('results/autonomy-lab-1788835964915/experience.json','utf8'),seed=JSON.parse(seedText)
assert.equal(seed.schema,1);assert.equal(seed.entries.length,3)
const profile=new ModelProfiles('state/models.json').profiles.find(p=>p.kind==='codex'&&p.model==='gpt-6-astra');assert.ok(profile)
const cases={
 platform:{request:'Build a compact birch-plank observation stage here. I need a clear upper deck at least two by two blocks, reachable on foot from the ground at least three blocks above it. Use only birch planks and at most 36 placed blocks. Work out the crafting and layout, then physically check the route.',kit:[['birch_log',12]]},
 tools:{request:'Prepare two serviceable stone axes and one serviceable stone shovel, plus twelve torches. Keep the worn axe and the diamond too. Keep everything in your inventory; do not hand anything over.',kit:[['oak_log',4],['cobblestone',7],['coal',3],['diamond',1],['stone_axe[minecraft:damage=125]',1]]}
}
const family=process.env.MC_ABLATION_FAMILY;if(family)assert.ok(Object.hasOwn(cases,family),'Unknown comparison family')
const schedule=[['platform',false],['platform',true],['tools',true],['tools',false]].filter(([name])=>!family||name===family)
const report={status:'running',design:'Two fixed paired tasks, counterbalanced arm order, one trial per arm/task. Same model, prompts, site, kit and no prior conversation/projects. Only frozen experience retrieval differs. No significance or broad efficacy claim.',runtimeHash:createHash('sha256').update(['src/crafting.js','src/world-skills.js','src/companion/controller.js','src/companion/experience.js'].map(p=>readFileSync(p,'utf8')).join('\n')).digest('hex'),seedHash:createHash('sha256').update(seedText).digest('hex'),seedEntries:seed.entries.length,model:profile.model,schedule,cases,trials:[]}
writeFileSync(root+'/design.json',JSON.stringify(report,null,2))
let witness,runner,controller,timer,lastLog=0
async function trial(family,memory){
 const spec=cases[family],dir=root+'/'+family+'-'+(memory?'memory':'empty');mkdirSync(dir)
 const result={family,memory,status:'running',timings:{formulate:[],plan:[],reflect:[]}};report.trials.push(result)
 try{
  runner=new Runner({host:process.env.MC_HOST,username:'HarnessTest',version:'1.21.4',owner:'HarnessWitness',statePath:dir+'/bot.json'})
  runner.on('event',e=>{if(e.type==='skill_progress'&&Date.now()-lastLog>15000){console.log(e.message);lastLog=Date.now()}})
  runner.start();for(let i=0;i<60&&!runner.ready;i++)await pause(500);assert.ok(runner.ready)
  for(const command of ['forceload add 320 0 326 12','fill 320 250 0 326 250 12 minecraft:smooth_stone','fill 320 251 0 326 268 12 minecraft:air','clear HarnessTest','gamemode survival HarnessTest','tp HarnessTest 323.5 251 3.5','tp HarnessWitness 323.5 251 1.5','effect give HarnessTest minecraft:instant_health 1 10 true','effect give HarnessTest minecraft:saturation 1 10 true',...spec.kit.map(([item,n])=>`give HarnessTest minecraft:${item} ${n}`)])await rcon(command)
  await pause(1500);await runner.bot.waitForChunksToLoad()
  assert.equal(seed.profile,runner.profile)
  writeFileSync(dir+'/experience.json',JSON.stringify({...seed,entries:memory?seed.entries:[]}),{mode:0o600})
  const planner=new LocalPlanner();planner.profiles={current:profile,key:''}
  for(const name of ['formulate','plan','reflect']){const fn=planner[name].bind(planner);planner[name]=async(...args)=>{const start=Date.now();try{return await fn(...args)}finally{result.timings[name].push(Date.now()-start)}}}
  controller=new Teammate(runner,planner,dir+'/conversation.json',new EpisodeRecorder(dir+'/episodes'))
  if(!memory)controller.experience.retrieve=()=>[]
  const s=controller.snapshot();assert.equal(s.ownerVisible,true);assert.equal(s.health,20)
  result.initial={inventory:s.inventory,tools:s.tools,position:s.position,ownerPosition:s.ownerPosition,health:s.health};result.request=spec.request
  const paired=report.trials.find(t=>t!==result&&t.family===family);if(paired)assert.deepEqual(result.initial,paired.initial,'Paired initial observations differ')
  console.log('START '+family+' memory='+memory)
  const started=Date.now();timer=setTimeout(()=>controller.stop(),600000)
  await controller.submit(spec.request);clearTimeout(timer)
  result.elapsedMs=Date.now()-started;result.final=controller.snapshot();result.rounds=controller.requestProgress.rounds
  result.failures=controller.requestProgress.feedback.filter(f=>f.status==='failed').map(f=>({action:f.action,reason:f.reason}));result.actions=controller.requestProgress.completed.map(c=>c.step.action)
  result.retrieved=controller.requestProgress.retrievedExperience||[]
  assert.equal(result.retrieved.length>0,memory,'Memory exposure mismatch')
  assert.ok(['verified','needs_review'].includes(controller.requestProgress.status),controller.requestProgress.blocker||controller.messages.at(-1)?.text)
  assert.ok(!result.actions.includes('give'),'Unrequested delivery')
  if(family==='platform'){
   const name=controller.requestProgress.goal.criteria.find(c=>c.kind==='construction')?.target
   result.audit=await verifyArchitecture(rcon,controller.projects[name],{palette:'birch_planks',height:3,budget:36,pad:{minX:320,maxX:326,minZ:0,maxZ:12}})
  }else{
   result.audit={}
   for(const [item,count] of [['stone_axe',2],['stone_shovel',1]]){const tools=await serverTools(rcon,'HarnessTest',runner.bot.inventory.items(),item);assert.ok(tools.filter(t=>t.remaining>=Math.max(32,t.maximum/2)).length>=count);result.audit[item]=tools}
   assert.ok(result.audit.stone_axe.some(t=>t.damage===125),'Original worn axe not retained')
   for(const [item,count] of [['torch',12],['diamond',1]]){const reply=await rcon(`data get entity HarnessTest Inventory[{id:"minecraft:${item}"}].count`);assert.match(reply,new RegExp('entity data: '+count+'$'));result.audit[item]=reply}
  }
  result.status='passed'
 }catch(error){result.status='failed';result.error=error.message;result.final=controller?.snapshot();console.log('FAIL '+family+' '+error.message)}
 finally{clearTimeout(timer);runner?.close();controller=null;runner=null;writeFileSync(dir+'/report.json',JSON.stringify(result,null,2));writeFileSync(root+'/report.json',JSON.stringify(report,null,2));await pause(1500)}
}
try{
 witness=mineflayer.createBot({host:process.env.MC_HOST,username:'HarnessWitness',version:'1.21.4'});await once(witness,'spawn')
 for(const [family,memory] of schedule)await trial(family,memory)
 report.status='completed';report.passed=report.trials.filter(t=>t.status==='passed').length
}catch(error){report.status='setup_failed';report.error=error.message;process.exitCode=1}
finally{clearTimeout(timer);runner?.close();witness?.quit();writeFileSync(root+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({path:root+'/report.json',status:report.status,trials:report.trials.map(t=>({family:t.family,memory:t.memory,status:t.status,error:t.error,seconds:t.elapsedMs/1000,rounds:t.rounds,failures:t.failures?.length}))}));setTimeout(()=>process.exit(process.exitCode||0),1000)}
