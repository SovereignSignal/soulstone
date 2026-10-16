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

test('an empty criteria list is corrected by saying what belongs in criteria and what belongs in constraints',async()=>{
 // Lab run 7, 2 October: "Mine 16 iron ore, smelt it, and store the ingots in
 // the base chest. Use the lit base as your shelter at night." came back three
 // times with criteria [] and the request stopped before any action.
 const planner=new LocalPlanner(),valid=contract([criterion('stored','base','iron_ingot',16)]),calls=[]
 const responses=[{...valid,criteria:[]},valid]
 planner.structured=async messages=>{calls.push(structuredClone(messages));return responses.shift()}
 const result=await planner.formulate('Mine 16 iron ore, smelt it, and store the ingots in the base chest. Use the lit base as your shelter at night.',{projects:{}},[])
 assert.equal(calls.length,2);assert.equal(result.criteria[0].kind,'stored')
 assert.match(calls[1].at(-1).content,/criteria array was empty/);assert.match(calls[1].at(-1).content,/constraints/)
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

test('the goal prompt refuses only when nothing at all can be attempted',()=>{
 const prompt=readFileSync(new URL('../src/companion/goal-prompt.txt',import.meta.url),'utf8')
 assert.match(prompt,/When only part of a request is unsupported, do NOT return clarification/)
 assert.match(prompt,/name the unsupported part in the summary/)
 assert.match(prompt,/handled automatically by the safety system and are never planner actions/)
})

test('success is what was asked for; survival needs are not finishing conditions unless named',()=>{
 // Trial 12, 24 September: "craft an iron pickaxe" became a food reserve, a lit
 // shelter and the pickaxe as hard criteria, and the run spent its second hour
 // on the shelter. Sov: shelter matters, but it is a separate thing from
 // crafting; one may require the other, and that is the survival layer's call.
 const prompt=readFileSync(new URL('../src/companion/goal-prompt.txt',import.meta.url),'utf8')
 assert.match(prompt,/Success is the outcome the request names/)
 assert.match(prompt,/food reserve, a shelter, sleep/)
 assert.match(prompt,/craft an iron pickaxe" is done when a serviceable iron pickaxe is carried/)
})

test('the capabilities brief tells the planner how a damaged base is repaired',()=>{
 const brief=readFileSync(new URL('../src/companion/survival-capabilities.txt',import.meta.url),'utf8')
 assert.match(brief,/DAMAGED BASE/)
 assert.match(brief,/build at the saved base origin sources and places only the blocks that differ/)
})

// Lab run 66, 7 October: a corner-less portal frame stopped at 17 of 25, its
// top row with nothing to be placed against. The ignition check reads only the
// ten frame cells and the interior, so filled corners cost nothing.
test('the capabilities brief tells the planner to fill a portal frame\'s corners',()=>{
 const brief=readFileSync(new URL('../src/companion/survival-capabilities.txt',import.meta.url),'utf8')
 assert.match(brief,/PORTAL FRAMES: build a Nether portal frame with its four corner cells filled/)
})

test('the reachability audit fixes hold: a lone hunt or sleep plans, and three criteria read what the runtime writes',async()=>{
 const {guardIntent}=await import('../src/companion/intent.js')
 for(const action of ['hunt','sleep']){
  const plan={reply:'',steps:[{action,name:'',item:action==='hunt'?'beef':'',count:action==='hunt'?2:0,design:[]}]}
  assert.equal(guardIntent(structuredClone(plan),'do it',[]).steps.length,1,`a lone ${action} plan is allowed`)
 }
 const snapshot={inventory:{},projects:{},position:{x:0,y:64,z:0},places:{'home base':{x:0,y:64,z:0}},ownerPosition:{x:2.8,y:64,z:0}}
 const base={kind:'task',projectMode:'none',summary:'go',milestones:[],constraints:[]}
 // A saved place is keyed lowercase; a criterion naming it any other way used to miss.
 const place=validateContract({...base,criteria:[{kind:'at_place',description:'Finish at home base.',target:'Home Base',item:'',count:0}]})
 assert.equal(evaluateGoal(place,snapshot,null,[]).checks[0].passed,true)
 // Following holds within three blocks, so the check may not demand two.
 const owner=validateContract({...base,criteria:[{kind:'at_owner',description:'Finish near me.',target:'',item:'',count:0}]})
 assert.equal(evaluateGoal(owner,snapshot,null,[]).checks[0].passed,true)
 // A withdraw returns a verified container snapshot and now counts as evidence.
 const stored=validateContract({...base,criteria:[{kind:'stored',description:'Keep 3 iron in the chest.',target:'',item:'iron_ingot',count:3}]})
 const after=evaluateGoal(stored,snapshot,null,[{action:'withdraw',status:'completed',result:{container:{iron_ingot:5}}}])
 assert.equal(after.checks[0].passed,true)
})


test('food recovery verifies server hunger without requiring a predetermined food species',()=>{
 const base={kind:'task',projectMode:'none',summary:'Recover hunger using available safe food',milestones:[],constraints:[]},criterion={kind:'hunger',description:'Restore hunger to at least 18.',target:'',item:'',count:18}
 const contract=validateContract({...base,criteria:[criterion]})
 for(const food of [null,undefined,5,17])assert.equal(evaluateGoal(contract,{survival:{food},inventory:{}},null,[]).verdict,'needs_work')
 for(const item of ['beef','sweet_berries']){
  const feedback=[{action:'eat',status:'completed',result:{item,count:3}}]
  assert.equal(evaluateGoal(contract,{survival:{food:18},inventory:{}},null,feedback).verdict,'passed')
  assert.equal(evaluateGoal(contract,{survival:{food:5},inventory:{}},null,feedback).verdict,'needs_work','eating receipts alone cannot substitute for current hunger')
 }
 for(const count of [0,21])assert.throws(()=>validateContract({...base,criteria:[{...criterion,count}]}),/1 to 20/)
})

// --- block_at: the criterion `use` must not ship without ---
const useReceipt = (x, y, z, name, state = {}, dimension = 'overworld', receipt = 'use_effect_observed') =>
  ({ action: 'use', status: 'completed', result: { receipt, item: 'flint_and_steel', target: { x, y, z, how: 'click', dimension }, observed: { name, state }, changed: [] } })
const blockAtContract = (over = {}) => ({
  kind: 'task', summary: 'Light a nether portal.', projectMode: 'none', milestones: ['Light it'], constraints: [],
  milestonePlan: [{ id: 'light', description: 'Light the portal frame and confirm it.', dependsOn: [], criteria: [0] }],
  criteria: [{ kind: 'block_at', description: 'A nether portal exists that this request lit.', target: '', item: 'nether_portal', count: 1, ...over }],
})
const botIn = (dimension, block) => ({ game: { dimension }, blockAt: () => block })
const litBlock = { name: 'nether_portal', getProperties: () => ({ axis: 'x' }) }

test('block_at passes on a use receipt from this request and survives walking away', () => {
  const c = validateContract(blockAtContract(), {}), snap = { position: { x: 0, y: 64, z: 0 } }
  const fb = [useReceipt(12, 65, -7, 'nether_portal', { axis: 'x' })]
  assert.equal(evaluateGoal(c, snap, botIn('overworld', litBlock), fb).verdict, 'passed', 'receipt plus a matching live read')
  // An unloaded chunk is not a contradiction: it is the absence of a reading.
  assert.equal(evaluateGoal(c, snap, botIn('overworld', null), fb).verdict, 'passed', 'walking away does not un-light the portal')
  // A different block in the same dimension is a real contradiction.
  assert.equal(evaluateGoal(c, snap, botIn('overworld', { name: 'obsidian', getProperties: () => ({}) }), fb).verdict, 'needs_work', 'someone broke it')
  // bot.world is replaced wholesale on a dimension change, so a cross-dimension
  // read is skipped rather than trusted.
  assert.equal(evaluateGoal(c, snap, botIn('the_nether', { name: 'netherrack', getProperties: () => ({}) }), fb).verdict, 'passed', 'a read from another dimension proves nothing')
  assert.equal(evaluateGoal(c, snap, botIn('overworld', litBlock), []).verdict, 'needs_work', 'no receipt, no pass')
})

test('block_at counts distinct places and reads block states', () => {
  const twelve = validateContract(blockAtContract({ item: 'end_portal_frame[eye=true]', count: 12, description: 'Twelve frames hold an eye.' }), {})
  const snap = { position: { x: 0, y: 64, z: 0 } }
  const frame = n => useReceipt(n, 65, -7, 'end_portal_frame', { eye: true })
  const bot = botIn('overworld', { name: 'end_portal_frame', getProperties: () => ({ eye: true }) })
  const eleven = Array.from({ length: 11 }, (_, i) => frame(i))
  assert.equal(evaluateGoal(twelve, snap, bot, eleven).verdict, 'needs_work', 'eleven frames is not twelve')
  assert.equal(evaluateGoal(twelve, snap, bot, [...eleven, frame(11)]).verdict, 'passed')
  // Distinct places, not repeated receipts for the same one.
  assert.equal(evaluateGoal(twelve, snap, bot, Array.from({ length: 12 }, () => frame(0))).verdict, 'needs_work', 'one frame twelve times is one frame')
  assert.throws(() => validateContract(blockAtContract({ count: 2, target: '1,2,3' }), {}), /names no single position/)
  assert.throws(() => validateContract(blockAtContract({ target: 'over there' }), {}), /"" or "x,y,z"/)
})

test('a portal contract is not vacuous before the work', () => {
  // vacuousContract evaluates with empty feedback, so a receipt-anchored
  // criterion cannot report success on arrival.
  const c = validateContract(blockAtContract(), {})
  assert.equal(vacuousContract(c, { position: { x: 0, y: 64, z: 0 } }, botIn('overworld', litBlock)), null)
})

test('an inventory criterion counts armour the agent is wearing', () => {
  // Armour occupies player-window slots 5-8 and items() starts at 9, verified
  // live: carried reads 1, worn reads 0. So "carry an iron helmet" failed the
  // instant the agent put one on, and it crafted a spare to satisfy itself.
  const contract = validateContract({
    kind: 'task', summary: 'Wear iron.', projectMode: 'none', milestones: ['Get a helmet'], constraints: [],
    milestonePlan: [{ id: 'helm', description: 'Obtain and wear an iron helmet.', dependsOn: [], criteria: [0] }],
    criteria: [{ kind: 'inventory', description: 'An iron helmet is held or worn.', target: '', item: 'iron_helmet', count: 1 }],
  }, {})
  const snap = { position: { x: 0, y: 64, z: 0 }, inventory: {} }
  const bare = { getEquipmentDestSlot: () => null, inventory: { slots: [] } }
  assert.equal(evaluateGoal(contract, snap, bare, []).verdict, 'needs_work', 'neither carried nor worn')
  // worn: the equipment slot holds it, inventory.items() does not
  const wearing = { getEquipmentDestSlot: s => ({ head: 5, torso: 6, legs: 7, feet: 8 }[s] ?? null),
    inventory: { slots: [, , , , , { name: 'iron_helmet' }] } }
  assert.equal(evaluateGoal(contract, snap, wearing, []).verdict, 'passed', 'wearing it satisfies carrying it')
  // carried still works
  assert.equal(evaluateGoal(contract, { ...snap, inventory: { iron_helmet: 1 } }, bare, []).verdict, 'passed')
})

// The Nether plan, step 7: the brief describes the switch,
// use_portal and the Nether's rules, and keeps the End behind its own switch.
test('the brief allows a portal only through use_portal behind the switch, and states the Nether rules',()=>{
 const brief=readFileSync(new URL('../src/companion/survival-capabilities.txt',import.meta.url),'utf8')
 const teammate=readFileSync(new URL('../src/companion/teammate-prompt.txt',import.meta.url),'utf8')
 assert.match(brief,/The one way through is the use_portal action, and from the Overworld only when observation.portalTravel.nether is "on"/)
 assert.match(brief,/an end portal only when observation.portalTravel.end is "on"/)
 assert.match(brief,/THE NETHER: .*no water .*no bed .*Never mine obsidian there/s)
 assert.match(teammate,/Action use_portal: /)
 assert.doesNotMatch(brief,/never go through a portal or into the Nether/,'the old blanket rule is replaced, not contradicted')
})

// Honest run 2, 14 October: 53 blocks from its own lit portal and sure there was none, the
// bot gathered ten obsidian and was refused the frame because the request never asked
// for a build. A Nether goal may build the portal it needs; any other build is still refused.
test('a Nether goal may construct a nether-portal the request did not name; other goals and other builds may not',()=>{
 const frame=[];for(let x=0;x<4;x++)for(let z=0;z<4;z++)frame.push({x,y:0,z,block:'obsidian'});frame.push({x:1,y:1,z:1,block:'checkpoint'},{x:2,y:1,z:1,block:'checkpoint'})
 const nether=validateContract({...contract([criterion('inventory','','blaze_rod',3)]),summary:'Cross the lit Nether portal, find a fortress and bring three blaze rods home'})
 assert.doesNotThrow(()=>enforceProjectIntent(nether,{action:'construct',name:'nether-portal',design:frame},{}))
 assert.throws(()=>enforceProjectIntent(nether,{action:'construct',name:'tower',design:frame},{}),/project named/)
 assert.throws(()=>enforceProjectIntent(nether,{action:'construct',name:'nether-portal',design:[]},{}),/fresh design/,'the rest of the checks still apply')
 const iron=validateContract({...contract([criterion('inventory','','iron_ingot',8)]),summary:'Mine eight iron'})
 assert.throws(()=>enforceProjectIntent(iron,{action:'construct',name:'nether-portal',design:frame},{}),/project named/)
})
