import {Teammate} from '../src/companion/controller.js'
import {LocalPlanner} from '../src/companion/planner.js'
import {ModelProfiles} from '../src/companion/providers.js'
import {EpisodeRecorder} from '../src/companion/episodes.js'
import {architectureChanges} from '../src/construction.js'
import {Runner} from '../src/runner.js'
import {compileArchitecture,reviseArchitecture} from '../src/construction.js'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {writeFileSync,mkdirSync} from 'node:fs'
import assert from 'node:assert/strict'
if(process.env.MC_LAB_EXPERIMENT!=='yes')throw new Error('Disposable lab opt-in required')
const run=promisify(execFile),host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const dir='results/furnishing-revision-'+Date.now();mkdirSync(dir)
const report={status:'running',fixture:'admin-seeded recorded room; supplied materials; survival revision and repair',stages:[]},origin={x:420,y:250,z:8}
const runner=new Runner({host:process.env.MC_HOST,version:'1.21.4',username:'HarnessTest',owner:'HarnessWitness',statePath:dir+'/task.json'})
runner.on('event',e=>{if(e.type==='skill_progress')console.log(e.message)})
const region=(x,y,z,block,x2=x,y2=y,z2=z)=>({x,y,z,x2,y2,z2,block})
const original=[region(0,0,-2,'stone_bricks',8,0,8),region(0,1,0,'stone_bricks',0,2,8),region(8,1,0,'stone_bricks',8,2,8),region(1,1,8,'stone_bricks',7,2,8),region(1,1,0,'stone_bricks',7,2,0),region(0,3,0,'stone_bricks',8,3,8),region(4,1,0,'air',4,2,0),region(6,1,2,'barrel'),region(4,1,-1,'checkpoint'),region(4,1,1,'checkpoint'),region(4,1,4,'checkpoint'),region(4,1,-1,'checkpoint')]
const patch=[region(1,1,2,'red_bed[facing=south]'),region(6,1,4,'crafting_table'),region(6,1,6,'furnace'),region(2,2,0,'glass')],design=reviseArchitecture(original,patch)
report.original=original;report.patch=patch;report.design=design
async function task(label,goal){
 const done=new Promise(resolve=>{const h=e=>{if(e.type==='task_finished'){runner.off('event',h);resolve(e.task)}};runner.on('event',h)})
 runner.command({action:'construct',goal:{name:'furnished_room',near:origin,origin,...goal},timeoutMs:600000})
 const result=await done;report.stages.push({label,task:result});writeFileSync(dir+'/report.json',JSON.stringify(report,null,2));console.log(label+': '+result.status+' '+result.reason);return result
}
async function audit(desired=design){
 const checks=[];const bp=compileArchitecture(desired)
 for(let i=0;i<bp.cells.length;i+=12){const group=bp.cells.slice(i,i+12);const c='execute '+group.map(b=>{const props=Object.entries(b.properties||{}).map(([k,v])=>k+'='+v).join(',');return `if block ${origin.x+b.x} ${origin.y+b.y} ${origin.z+b.z} minecraft:${b.block}${props?'['+props+']':''}`}).join(' ')+' run list';const reply=await rcon(c);assert.match(reply,/players online/);checks.push({count:group.length,reply})}
 for(const [pos,n] of [['426 251 10',5],['431 251 10',7]]){const contents=await rcon('data get block '+pos+' Items');assert.match(contents,new RegExp('count: '+n));assert.match(contents,/minecraft:diamond/);checks.push({pos,contents})}
 return checks
}
try{
 runner.start();for(let i=0;i<60&&!runner.ready;i++)await new Promise(r=>setTimeout(r,500));assert.ok(runner.ready)
 if(process.env.MC_REVISION_MODEL!=='only'){
 for(const c of ['forceload add 416 0 438 22','fill 416 250 0 438 250 22 minecraft:smooth_stone','fill 416 251 0 438 266 22 minecraft:air','clear HarnessTest','gamemode survival HarnessTest','tp HarnessTest 424.5 251 5.5','effect give HarnessTest minecraft:instant_health 1 10 true','effect give HarnessTest minecraft:saturation 1 10 true'])await rcon(c)
 for(const b of original.filter(b=>b.block!=='checkpoint'))await rcon(`fill ${origin.x+b.x} ${origin.y+b.y} ${origin.z+b.z} ${origin.x+b.x2} ${origin.y+b.y2} ${origin.z+b.z2} minecraft:${b.block}`)
 for(const c of ['data merge block 426 251 10 {Items:[{Slot:0b,id:"minecraft:diamond",count:5}]}','setblock 431 251 10 minecraft:chest','data merge block 431 251 10 {Items:[{Slot:0b,id:"minecraft:diamond",count:7}]}','setblock 422 252 8 minecraft:chest','data merge block 422 252 8 {Items:[{Slot:0b,id:"minecraft:diamond",count:3}]}',...['red_bed','crafting_table','furnace','glass','iron_pickaxe'].map(n=>'give HarnessTest minecraft:'+n+' 1')])await rcon(c)
 await new Promise(r=>setTimeout(r,1500));await runner.bot.waitForChunksToLoad()
 const conflict=await task('unknown-container-conflict',{design,previousDesign:original});assert.equal(conflict.status,'failed');assert.match(conflict.reason,/obstruction|conflict/)
 report.conflictContents=await rcon('data get block 422 252 8 Items');assert.match(report.conflictContents,/count: 3/)
 await rcon('setblock 422 252 8 minecraft:stone_bricks');await new Promise(r=>setTimeout(r,300))
 const revised=await task('furnish-and-replace',{design,previousDesign:original});assert.equal(revised.status,'completed',revised.reason);assert.equal(revised.result.partial,false)
 assert.equal(revised.result.furnishings.length,4);assert.equal(revised.result.revision.removed.length,1);report.revisionAudit=await audit()
 await rcon('setblock 424 253 12 minecraft:air');await rcon('give HarnessTest minecraft:stone_bricks 1');await new Promise(r=>setTimeout(r,300))
 const repair=await task('restore-missing-roof',{design,previousDesign:original});assert.equal(repair.status,'completed',repair.reason);assert.equal(repair.result.partial,false);assert.equal(repair.result.revision.removed.length,0);report.repairAudit=await audit()
 }else {await runner.bot.waitForChunksToLoad();report.baselineAudit=await audit()}
 if(['yes','only'].includes(process.env.MC_REVISION_MODEL)){
  for(const item of ['red_bed','barrel','glass'])await rcon('give HarnessTest minecraft:'+item+' 1')
  await new Promise(r=>setTimeout(r,500))
  const planner=new LocalPlanner(),profile=new ModelProfiles('state/models.json').profiles.find(p=>p.kind==='codex'&&p.model==='gpt-6-astra');assert.ok(profile);planner.profiles={current:profile,key:''}
  const controller=new Teammate(runner,planner,dir+'/conversation.json',new EpisodeRecorder(dir+'/episodes'))
  if(process.env.MC_REVISION_MODEL==='only')controller.projects.furnished_room={construction:{name:'furnished_room',near:origin,origin,design,previousDesign:original},status:'completed'}
  const request='Add a second red bed and a second barrel to the saved furnished_room. Add one glass window to a currently solid outer wall. Keep every existing furnishing, stored diamonds, the other structure and all existing walk checkpoints. Work within the current footprint; do not build another room. The lab supplies the extra bed, barrel and glass. Verify all furnishings and access.'
  report.model={request,before:controller.snapshot()};writeFileSync(dir+'/report.json',JSON.stringify(report,null,2))
  const timeout=setTimeout(()=>controller.stop(),600000)
  try{await controller.submit(request)}finally{clearTimeout(timeout)}
  report.model.after=controller.snapshot()
  assert.ok(['verified','needs_review'].includes(controller.requestProgress.status),controller.messages.at(-1)?.text)
  assert.equal(controller.requestProgress.goal.projectMode,'modify')
  const saved=controller.projects.furnished_room;assert.deepEqual(saved.construction.origin,origin)
  const changes=architectureChanges(design,saved.construction.design);assert.equal(changes.filter(c=>c.before.block!=='air').length,1)
  const window=changes.find(c=>c.before.block==='stone_bricks'&&c.after.block==='glass');assert.ok(window)
  assert.ok([1,2].includes(window.after.y)&&([0,8].includes(window.after.x)||[0,8].includes(window.after.z)))
  assert.deepEqual(compileArchitecture(saved.construction.design).bounds,compileArchitecture(design).bounds)
  assert.deepEqual(compileArchitecture(saved.construction.design).checks,compileArchitecture(design).checks)
  assert.equal(compileArchitecture(saved.construction.design).blocks.filter(b=>b.block==='red_bed').length,2)
  assert.equal(compileArchitecture(saved.construction.design).blocks.filter(b=>b.block==='barrel').length,2)
  report.model.audit=await audit(saved.construction.design)
 }
 report.status='passed'
}catch(error){report.status='failed';report.error=error.message;console.error('FAIL '+error.message);process.exitCode=1}
finally{writeFileSync(dir+'/report.json',JSON.stringify(report,null,2));runner.close();console.log(dir);setTimeout(()=>process.exit(process.exitCode||0),1000)}
