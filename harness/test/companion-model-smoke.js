// Explicit local inference test. Does not connect to or move the Minecraft bot.
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync } from 'node:fs'
import { LocalPlanner } from '../src/companion/planner.js'
const planner = new LocalPlanner()
const observation = { connected:true, owner:'SovereignSignal',ownerVisible:true,ownerPosition:{x:1,y:64,z:2},position:{x:0,y:64,z:2},inventory:{},places:{camp:{x:100,y:64,z:200}},task:null }
const cases = [
 ['Hi, can you hear me?',[]],
 ['Follow me and stay beside me.',['follow']],
 ['Remember where I am standing as camp.',['remember']],
 ['Collect five oak logs and come back here.',['remember','gather','return']],
 ['Mine diamonds and build a castle.',[]],
 ['Remember my current location as camp, come to me, then follow me.',['remember','come','follow']]
]
const receipts=[]
for(const [request,expected] of cases){
 const t=Date.now();let result
 try {
  result=await planner.plan(request,observation,[],new AbortController().signal)
  if(expected.includes('gather')) {
   const g=result.steps.findIndex(s=>s.action==='gather'); const r=result.steps.findIndex(s=>s.action==='return')
   assert.ok(g>=1 && r>g);assert.ok(result.steps.slice(0,g).some(s=>s.action==='remember' && s.name===result.steps[r].name))
   assert.equal(result.steps[g].count,5)
  } else assert.deepEqual(result.steps.map(s=>s.action),expected)
  receipts.push({request,result,elapsedMs:Date.now()-t,status:'passed'})
 } catch(e) { receipts.push({request,result,elapsedMs:Date.now()-t,status:'failed',error:e.message});process.exitCode=1 }
 console.log(JSON.stringify(receipts.at(-1)))
}
mkdirSync(new URL('../results/',import.meta.url),{recursive:true});writeFileSync(new URL('../results/companion-model-smoke.json',import.meta.url),JSON.stringify({model:planner.model,cases:receipts,status:process.exitCode ? 'failed':'passed'},null,2))
