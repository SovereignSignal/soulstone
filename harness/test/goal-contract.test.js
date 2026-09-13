import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {validateContract,evaluateGoal,enforceProjectIntent,vacuousContract} from '../src/companion/goal-contract.js'
import {ExperienceStore,experienceEvidence} from '../src/companion/experience.js'
import {LocalPlanner} from '../src/companion/planner.js'
const criterion=(kind,target='',item='',count=0)=>({kind,description:kind+' '+item,target,item,count})
const contract=criteria=>({kind:'task',summary:'Complete this request.',projectMode:criteria.some(c=>c.kind==='construction')?'new':'none',criteria,milestones:['Inspect','Execute','Verify'],constraints:[]})

test('goal formatting is corrected before saving a contract without weakening the original request',async()=>{
 const planner=new LocalPlanner(),valid=contract([criterion('construction','lookout'),criterion('max_blocks','lookout','',72)])
 const invalidName=structuredClone(valid);invalidName.criteria.forEach(c=>c.target='Oak Lookout')
 const responses=[{...valid,summary:'x'.repeat(700)},invalidName,valid],calls=[],trace=[]
 planner.structured=async messages=>{calls.push(structuredClone(messages));return responses.shift()}
 const result=await planner.formulate('Build a roofed lookout within 72 blocks.',{projects:{}},[],undefined,r=>trace.push(r))
 assert.equal(calls.length,3);assert.equal(result.criteria[1].count,72)
 assert.ok(calls.every(messages=>messages.some(m=>m.content==='Build a roofed lookout within 72 blocks.')))
 assert.match(calls[1].at(-1).content,/600/);assert.match(calls[2].at(-1).content,/lowercase/)
 assert.equal(trace.filter(r=>r.validationError).length,2)
})

test('invalid goal correction is bounded and provider failures are not retried',async()=>{
 const planner=new LocalPlanner();let calls=0
 planner.structured=async()=>{calls++;return {kind:'task'}}
 await assert.rejects(planner.formulate('Build a new lookout',{projects:{}},[]),/Invalid goal/)
 assert.equal(calls,3)
 calls=0;planner.structured=async()=>{calls++;throw new Error('Subscription unavailable')}
 await assert.rejects(planner.formulate('Build a new lookout',{projects:{}},[]),/Subscription unavailable/)
 assert.equal(calls,1)
})

test('Stop during invalid goal correction prevents another model call',async()=>{
 const planner=new LocalPlanner(),abort=new AbortController();let calls=0
 planner.structured=async()=>{calls++;abort.abort();return {kind:'task'}}
 await assert.rejects(planner.formulate('Build a new lookout',{projects:{}},[],abort.signal),/Cancelled/)
 assert.equal(calls,1)
})
test('new projects cannot reuse an earlier castle and derived constraints follow the new name',()=>{
 const c=validateContract(contract([criterion('construction','castle','',1),criterion('reach_height','castle','',4)]),{castle:{construction:{}}})
 assert.equal(c.criteria[0].target,'castle_2');assert.equal(c.criteria[1].target,'castle_2')
 assert.throws(()=>enforceProjectIntent(c,{action:'construct',name:'castle',design:[]},{castle:{construction:{}}}),/project named/)
 assert.throws(()=>enforceProjectIntent(c,{action:'construct',name:'castle_2',design:[]},{}),/fresh design/)
})
test('completion is checked against current inventory and this-request delivery, not a model claim',()=>{
 const c=validateContract(contract([criterion('inventory','','torch',8),criterion('delivered','','wooden_sword',1)]))
 const s={inventory:{torch:4},projects:{}}
 assert.equal(evaluateGoal(c,s,{},[]).verdict,'needs_work')
 s.inventory.torch=8
 assert.equal(evaluateGoal(c,s,{},[]).verdict,'needs_work')
 const f=[{action:'give',status:'completed',result:{receipt:'recipient_pickup',item:'wooden_sword',count:1}}]
 assert.equal(evaluateGoal(c,s,{},f).verdict,'passed')
})
test('qualitative requirements remain reviewable instead of receiving automatic success',()=>{
 const c=validateContract(contract([criterion('inventory','','torch',4),{...criterion('review'),description:'The room feels welcoming'}]))
 assert.equal(evaluateGoal(c,{inventory:{torch:4}},{}).verdict,'needs_review')
})
test('an old full structure receipt cannot fulfill a new verification request',()=>{
 const c=validateContract({...contract([criterion('construction','lookout','',1)]),projectMode:'inspect'},{lookout:{construction:{}}})
 assert.equal(evaluateGoal(c,{projects:{lookout:{result:{partial:false,verifiedBlocks:100}}}},{}).verdict,'needs_work')
})
test('experience persists across restarts and retrieval transfers by capability without storing blueprints',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'mc-experience-')),'experience.json'),store=new ExperienceStore(path,'lab')
 const evidence=[{action:'construct',status:'completed',partial:false,facts:{placedBlocks:80,walked:4,height:4,verified:true}}]
 store.record({requestId:'one',summary:'Build a stone lookout',criteria:[criterion('construction','lookout')],version:'1.21.4',evidence,verdict:'passed',reflection:{lessons:[{when:'Building elevated access',strategy:'Reserve a connected stepped access route before enclosing upper levels.',limits:'Observed once with full blocks on a level site.',evidence:[0]},{when:'Bad citation',strategy:'Never supported',limits:'',evidence:[90]}]}})
 const loaded=new ExperienceStore(path,'lab');const found=loaded.retrieve('Create a wooden viewing platform',contract([criterion('construction','platform')]),'1.21.4')
 assert.equal(found.length,1);assert.equal(found[0].lessons.length,1);assert.equal(found[0].lessons[0].status,'conditional_hypothesis')
 assert.equal(loaded.retrieve('Create a platform',contract([criterion('construction','p')]),'1.20.1').length,0)
 assert.equal(readFileSync(path,'utf8').includes('"design"'),false)
 store.record({requestId:'one'});assert.equal(store.entries.length,1)
})
test('partial execution is never retained as verified success evidence',()=>{
 const evidence=experienceEvidence([{action:'construct',status:'completed',result:{partial:true,count:64},step:{}}],{verdict:'needs_work'})
 assert.equal(evidence[0].partial,true);assert.equal(evidence[0].facts.verified,undefined)
})

test('a resumed request updates its saved lesson and retains the earlier failure after restart',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'mc-experience-resume-')),'experience.json'),store=new ExperienceStore(path,'world')
 const input={requestId:'mining',summary:'Mine a diamond',criteria:[criterion('inventory','','diamond',1)],version:'1.21.4'}
 const failure=experienceEvidence([{action:'prospect',status:'completed',step:{item:'coal'},result:{partial:true,acquired:false,count:0,broken:0,steps:0,returned:true,needs:['Acquire torches']}}],{verdict:'needs_work'})
 store.record({...input,evidence:failure,verdict:'needs_work',reflection:{lessons:[{when:'Starter coal requires torches',strategy:'Obtain starter stone for a furnace and charcoal.',limits:'A zero-progress supply return; recovery is not yet verified.',evidence:[0]}]}})
 const id=store.entries[0].id
 assert.equal(store.entries[0].lessons.length,1);assert.equal(store.entries[0].evidence[0].facts.acquired,false)
 const loaded=new ExperienceStore(path,'world')
 loaded.record({...input,evidence:[...failure,{action:'prospect',item:'diamond',status:'completed',partial:false,facts:{count:1}}],verdict:'passed',reflection:{lessons:[]}})
 const reloaded=new ExperienceStore(path,'world'),entry=reloaded.retrieve('Mine a diamond',contract(input.criteria),'1.21.4')[0]
 assert.equal(reloaded.entries.length,1);assert.equal(entry.id,id);assert.equal(entry.verdict,'passed')
 assert.deepEqual(entry.outcomes.map(o=>o.verdict),['needs_work','passed'])
 assert.deepEqual(entry.outcomes[0].blockers[0].needs,['Acquire torches'])
 assert.equal(entry.evidence[0].partial,true)
 assert.throws(()=>new ExperienceStore(path,'another-world'),/another profile/)
})

test('starter shelter usability has its own current-request check',()=>{
 const c=validateContract(contract([criterion('shelter','base')]))
 const old={projects:{base:{result:{usability:{status:'usable'}}}}}
 assert.equal(evaluateGoal(c,old,{},[]).verdict,'needs_work')
 assert.equal(evaluateGoal(c,old,{},[{action:'build',status:'completed',result:{usability:{status:'usable'}}}]).verdict,'passed')
})

test('construction completion rechecks door upper halves even after a prior successful receipt',()=>{
 const design=[{x:0,y:0,z:0,block:'oak_door[facing=north]'},{x:1,y:0,z:0,block:'checkpoint'},{x:1,y:0,z:1,block:'checkpoint'}]
 const c=contract([criterion('construction','entry')]),snapshot={projects:{entry:{construction:{origin:{x:0,y:64,z:0},design}}}}
 const feedback=[{action:'construct',status:'completed',result:{name:'entry',partial:false,walkthrough:[{},{}]}}]
 let upper=true
 const bot={blockAt:p=>({name:p.y===65&&!upper?'air':'oak_door',getProperties:()=>({facing:'north',half:p.y===65?'upper':'lower',open:false,powered:false})})}
 assert.equal(evaluateGoal(c,snapshot,bot,feedback).verdict,'passed')
 upper=false;assert.equal(evaluateGoal(c,snapshot,bot,feedback).verdict,'needs_work')
})

test('current construction checks also reject an obstruction in a recorded air cell',()=>{
 const design=[{x:0,y:0,z:0,x2:2,y2:0,z2:2,block:'stone_bricks'},{x:0,y:1,z:0,block:'air'},{x:1,y:1,z:1,block:'checkpoint'},{x:2,y:1,z:1,block:'checkpoint'}]
 const c=contract([criterion('construction','room')]),snapshot={projects:{room:{construction:{origin:{x:0,y:64,z:0},design}}}}
 const f=[{action:'construct',status:'completed',result:{name:'room',partial:false,walkthrough:[{},{}]}}];let obstructed=false
 const bot={blockAt:p=>({name:p.y===64?'stone_bricks':obstructed?'chest':'air'})}
 assert.equal(evaluateGoal(c,snapshot,bot,f).verdict,'passed');obstructed=true
 assert.equal(evaluateGoal(c,snapshot,bot,f).verdict,'needs_work')
})

test('lessons carry the executor revision; older ones retrieve as stale and rank last',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'mc-experience-')),'experience.json'),store=new ExperienceStore(path,'lab')
 const evidence=[{action:'gather',status:'failed',item:'logs',partial:false,reason:'no logs within 48 blocks'}]
 store.record({requestId:'old',summary:'Gather logs for a shelter',criteria:[criterion('inventory','')],version:'1.21.4',evidence,verdict:'needs_work',reflection:{lessons:[]},executor:'bundle-24'})
 store.record({requestId:'new',summary:'Gather logs for a house',criteria:[criterion('inventory','')],version:'1.21.4',evidence,verdict:'passed',reflection:{lessons:[]},executor:'bundle-31'})
 const found=store.retrieve('Gather logs and build',contract([criterion('inventory','')]),'1.21.4',{executor:'bundle-31'})
 assert.equal(found.length,2);assert.equal(found[0].executor,'bundle-31');assert.equal(found[0].stale,false);assert.equal(found[1].executor,'bundle-24');assert.equal(found[1].stale,true)
})

test('a task cannot be verified by review criteria alone, and a slept night is checked from the sleep receipt',()=>{
 const base={kind:'task',projectMode:'none',summary:'sleep in a bed',milestones:[],constraints:[]}
 const review={kind:'review',description:'Verify the bot slept.',target:'',item:'',count:0}
 assert.throws(()=>validateContract({...base,criteria:[review]}),/machine-checkable/)
 const slept={kind:'slept',description:'Sleep a night in the base bed.',target:'',item:'',count:1}
 const contract=validateContract({...base,criteria:[slept,review]})
 assert.equal(contract.criteria.length,2)
 assert.throws(()=>validateContract({...base,criteria:[{...slept,count:2}]}),/count 1/)
 const snapshot={inventory:{},projects:{},position:{x:0,y:64,z:0}}
 const none=evaluateGoal(contract,snapshot,null,[])
 assert.equal(none.checks[0].passed,false)
 const done=evaluateGoal(contract,snapshot,null,[{action:'sleep',status:'completed',result:{receipt:'slept_until_morning',wokeAt:120}}])
 assert.equal(done.checks[0].passed,true);assert.equal(done.verdict,'needs_review')
 const failed=evaluateGoal(contract,snapshot,null,[{action:'sleep',status:'completed',result:{receipt:'woke_early'}}])
 assert.equal(failed.checks[0].passed,false);assert.equal(failed.verdict,'needs_work')
})

test('a contract the starting state already satisfies is refused, and health and eating are checkable outcomes',()=>{
 const base={kind:'task',projectMode:'none',summary:'recover health',milestones:[],constraints:[]}
 const review={kind:'review',description:'Verify it hunted and ate.',target:'',item:'',count:0}
 const axe={kind:'tools',description:'Keep the wooden axe serviceable.',target:'',item:'wooden_axe',count:1}
 const snapshot={inventory:{},projects:{},position:{x:0,y:64,z:0},survival:{health:3}}
 const bot={inventory:{items:()=>[{name:'wooden_axe',count:1,maxDurability:59,durabilityUsed:0}]}}
 // The axe check passes on arrival, so the contract measures nothing.
 assert.match(vacuousContract(validateContract({...base,criteria:[axe,review]}),snapshot,bot),/already pass before any work/)
 assert.throws(()=>validateContract({...base,criteria:[review]}),/machine-checkable/,'review-only never even validates')
 assert.match(vacuousContract({kind:'task',criteria:[review]},snapshot,bot),/human review/,'and the guard still refuses one built directly')
 const health={kind:'health',description:'Reach full health.',target:'',item:'',count:20}
 const ate={kind:'ate',description:'Eat cooked meat.',target:'',item:'cooked_porkchop',count:2}
 const real=validateContract({...base,criteria:[health,ate,review]})
 assert.equal(vacuousContract(real,snapshot,bot),null,'unmet outcomes make a real contract')
 const before=evaluateGoal(real,snapshot,bot,[])
 assert.equal(before.checks[0].passed,false);assert.equal(before.checks[1].passed,false)
 const after=evaluateGoal(real,{...snapshot,survival:{health:20}},bot,[{action:'eat',status:'completed',result:{item:'cooked_porkchop',count:2}}])
 assert.equal(after.checks[0].passed,true);assert.equal(after.checks[1].passed,true)
 assert.throws(()=>validateContract({...base,criteria:[{...health,count:0}]}),/1 to 20/)
 assert.throws(()=>validateContract({...base,criteria:[{...ate,item:''}]}),/food item/)
})
