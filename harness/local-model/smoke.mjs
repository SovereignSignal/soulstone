// Model-only baseline. Uses the same planner schema, with no game connection or direct-command shortcut.
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {requestPlan,validateProfile} from '../src/companion/providers.js'
import {schema,validatePlan} from '../src/companion/planner.js'
const profile=validateProfile(JSON.parse(readFileSync(new URL('./profile.json',import.meta.url))))
const instructions=readFileSync(new URL('../src/companion/teammate-prompt.txt',import.meta.url),'utf8')
const cases=[
 {id:'craft-prerequisite',request:'Get me a stone pickaxe. Figure out the materials and tools you need.',observation:{connected:true,ownerVisible:true,inventory:{},position:{x:0,y:64,z:0},nearbyBlocks:['oak_log','stone']},check(plan){assert.ok(plan.steps.some(s=>s.action==='acquire'&&s.item==='stone_pickaxe'))}},
 {id:'verify-before-done',request:'Build a small wooden shelter.',observation:{connected:true,ownerVisible:true,inventory:{oak_planks:20},position:{x:0,y:64,z:0},feedback:[{action:'build',status:'failed',error:'One roof block could not be placed because the approach was blocked.',placed:37,total:38}]},check(plan){assert.ok(plan.steps.length>0,'Failure needs an inspection or recovery action');assert.ok(!/\b(completed|finished|done)\b/i.test(plan.reply),'Must not claim completion after observed failure')}}
]
const receipts=[]
for(const c of cases){
 const t=performance.now();let result,error,usage,timings
 try {
  const captureFetch=async(...args)=>{const response=await fetch(...args);const raw=await response.clone().json();usage=raw.usage;timings=raw.timings;return response}
  const text=await requestPlan(profile,'',[{role:'system',content:instructions},{role:'system',content:'Observed game state: '+JSON.stringify(c.observation)},{role:'user',content:c.request}],schema,new AbortController().signal,captureFetch)
  result=validatePlan(JSON.parse(text));c.check(result)
 }catch(e){error=e.message;process.exitCode=1}
 const receipt={id:c.id,status:error?'failed':'passed',elapsedMs:Math.round(performance.now()-t),usage,timings,result,...(error?{error}:{})};receipts.push(receipt);console.log(JSON.stringify(receipt))
}
mkdirSync(new URL('./results/',import.meta.url),{recursive:true})
writeFileSync(new URL('./results/inference-smoke.json',import.meta.url),JSON.stringify({profile,context:16384,thinking:false,scope:'Two synthetic model-only cases; no in-world capability evidence.',status:process.exitCode?'failed':'passed',cases:receipts},null,2)+'\n')
