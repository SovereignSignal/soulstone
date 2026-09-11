import {Runner} from '../src/runner.js'
import {compileArchitecture} from '../src/construction.js'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {writeFileSync,mkdirSync,readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
if(process.env.MC_LAB_EXPERIMENT!=='yes')throw new Error('Disposable lab opt-in required')
const run=promisify(execFile),host=process.env.MC_SSH_HOST;assert.match(host,/^[\w.-]+$/)
const rcon=async c=>(await run('ssh',['-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+c.replaceAll("'","'\\''")+"'"],{timeout:15000})).stdout.trim()
const dir='results/building-blocks-'+Date.now();mkdirSync(dir)
const onlyFacing=process.env.MC_FUNCTIONAL_FACING;if(onlyFacing)assert.ok(['north','south','east','west'].includes(onlyFacing))
const modelDesign=process.env.MC_FUNCTIONAL_DESIGN==='model'?JSON.parse(readFileSync('results/functional-build-blueprint.json')):null
const report={status:'running',fixture:modelDesign?'fresh Astra gatehouse, isolated supplied-materials survival':'isolated supplied-materials survival, all four cardinal orientations',trials:[],runtimeHash:createHash('sha256').update(['src/construction.js','src/building-blocks.js','src/navigation.js','src/world-skills.js'].map(p=>readFileSync(p,'utf8')).join('\n')).digest('hex')},origin={x:370,y:251,z:12}
const runner=new Runner({host:process.env.MC_HOST,port:Number(process.env.MC_PORT||25565),version:'1.21.4',username:'HarnessTest',owner:'HarnessWitness',statePath:dir+'/task.json'})
runner.on('event',e=>{if(e.type==='skill_progress')console.log(e.message)})
const region=(x,y,z,block,x2=x,y2=y,z2=z)=>({x,y,z,x2,y2,z2,block})
try{
 runner.start();for(let i=0;i<60&&!runner.ready;i++)await new Promise(r=>setTimeout(r,500));assert.ok(runner.ready)
 for(const [facing,dx,dz] of (modelDesign?[['model',0,-1]]:[['north',0,-1],['south',0,1],['east',1,0],['west',-1,0]]).filter(([facing])=>!onlyFacing||facing===onlyFacing)){
  const trial={facing,checks:[],origin};report.trials.push(trial)
  let design=[region(0,0,0,`oak_door[facing=${facing}]`),region(4,0,0,`spruce_fence_gate[facing=${facing}]`)]
  for(let i=0;i<3;i++){
   if(i)design.push(region(9+dx*i,0,dz*i,'stone_bricks',9+dx*i,i-1,dz*i))
   design.push(region(9+dx*i,i,dz*i,`stone_brick_stairs[facing=${facing}]`))
  }
  design.push(region(9+dx*3,0,dz*3,'stone_bricks',9+dx*3,2,dz*3),region(9-dx,0,-dz,'checkpoint'),region(9+dx*3,3,dz*3,'checkpoint'),region(9-dx,0,-dz,'checkpoint'))
  if(modelDesign)design=modelDesign.design
  trial.design=design;const bp=compileArchitecture(design)
  for(const c of ['forceload add 360 0 386 24','fill 360 250 0 386 250 24 minecraft:smooth_stone','fill 360 251 0 386 268 24 minecraft:air','clear HarnessTest','gamemode survival HarnessTest','tp HarnessTest 367.5 251 9.5','effect give HarnessTest minecraft:instant_health 1 10 true','effect give HarnessTest minecraft:saturation 1 10 true'])await rcon(c)
  const kit=bp.blocks.reduce((m,b)=>(m[b.block]=(m[b.block]||0)+1,m),{})
  for(const [name,n] of Object.entries(kit))await rcon(`give HarnessTest minecraft:${name} ${n}`)
  await new Promise(r=>setTimeout(r,1200));await runner.bot.waitForChunksToLoad()
  const done=new Promise(resolve=>{const h=e=>{if(e.type==='task_finished'){runner.off('event',h);resolve(e.task)}};runner.on('event',h)})
  runner.command({action:'construct',goal:{name:modelDesign?.name||'functional_'+facing,design,near:origin,origin},timeoutMs:300000})
  trial.task=await done;assert.equal(trial.task.status,'completed',trial.task.reason);assert.equal(trial.task.result.partial,false)
  assert.equal(trial.task.result.interactions.length,2)
  for(const b of bp.cells){
   const states=Object.entries(b.properties||{}).map(([k,v])=>`${k}=${v}`).join(',')
   const command=`execute if block ${origin.x+b.x} ${origin.y+b.y} ${origin.z+b.z} minecraft:${b.block}${states?'['+states+']':''} run list`
   let response=await rcon(command),matchedCommand=command
   if(!/players online/.test(response)&&b.block.endsWith('_fence_gate')){
    const opposite={north:'south',south:'north',east:'west',west:'east'}[b.properties.facing]
    matchedCommand=command.replace('facing='+b.properties.facing,'facing='+opposite);response=await rcon(matchedCommand)
   }
   assert.match(response,/players online/,matchedCommand);trial.checks.push({block:b,matchedCommand,response})
  }
  trial.status='passed';writeFileSync(dir+'/report.json',JSON.stringify(report,null,2));console.log('PASS '+facing)
 }
 report.status='passed'
}catch(error){report.status='failed';report.error=error.message;console.error('FAIL '+error.message);process.exitCode=1}
finally{writeFileSync(dir+'/report.json',JSON.stringify(report,null,2));runner.close();console.log(dir);setTimeout(()=>process.exit(process.exitCode||0),1000)}
