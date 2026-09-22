import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SkillControl,selectSkill,boundedCall} from '../src/companion/skill-control.js'
import {Teammate} from '../src/companion/controller.js'
import {LocalPlanner} from '../src/companion/planner.js'
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
const step=(item,count=1)=>({action:'acquire',item,count})
const observation=()=>({connected:true,position:{x:0,y:64,z:0},health:20,survival:{food:20,nearbyThreats:[]},inventory:{},feedback:[],projects:{},goal:{summary:'Make supplies'},verification:{verdict:'needs_work',checks:[]}})
function setup(overrides={}){
 const state=observation(),abort=new AbortController(),events=[]
 const c=new SkillControl({signal:abort.signal,observe:()=>structuredClone(state),plan:async()=>({reply:'Make supplies',steps:[step('oak_log'),step('cobblestone')]}),select:async()=>({index:1}),trace:(type,data)=>events.push({type,...data}),intervalMs:100000,...overrides})
 return {c,state,abort,events}
}
test('Jev chooses one offered skill and a later proposal cannot mutate that selection',async()=>{
 const {c}=setup();try{const p=await c.next();assert.equal(p.steps.length,1);assert.equal(p.steps[0].item,'cobblestone');assert.equal(c.budget.plannerCalls,1);assert.equal(c.budget.decisions,1)}finally{c.close()}
})
test('background planning does not block an available independent action',async()=>{
 const pending=deferred();let calls=0
 const {c}=setup({plan:async()=>++calls===1?{reply:'Make supplies',steps:[step('oak_log'),step('cobblestone')]}:pending.promise,select:async()=>({index:0})})
 try{
  assert.equal((await c.next()).steps[0].item,'oak_log');c.outcome({status:'completed'})
  const refresh=c.refresh(true)
  assert.equal((await c.next()).steps[0].item,'cobblestone');assert.equal(calls,2)
  pending.resolve({reply:'Fresh objective',steps:[step('stone')]});await refresh
 }finally{c.close()}
})
test('a failed action invalidates a planner response already in flight and supplies failure evidence',async()=>{
 const pending=deferred();let calls=0;const seen=[]
 const {c,state}=setup({select:async()=>({index:0}),plan:async o=>{seen.push(o);calls++;if(calls===2)return pending.promise;return {reply:'Supplies',steps:[step(calls===1?'oak_log':'cobblestone')]}}})
 try{
  await c.next();const refresh=c.refresh(true);await Promise.resolve()
  state.feedback.push({status:'failed',reason:'No reachable oak',step:step('oak_log')});c.outcome(state.feedback.at(-1))
  pending.resolve({reply:'Stale',steps:[step('oak_log')]});await refresh
  assert.equal((await c.next()).steps[0].item,'cobblestone');assert.equal(seen.at(-1).feedback.at(-1).reason,'No reachable oak')
 }finally{c.close()}
})
test('Stop cancels a pending decision even if its provider ignores cancellation',async()=>{
 const pending=deferred(),entered=deferred();const {c,abort}=setup({select:()=>{entered.resolve();return pending.promise}})
 const work=c.next();await entered.promise;abort.abort();await assert.rejects(work,/cancelled/);pending.resolve({index:0});assert.equal(c.budget.fallbacks,0);c.close()
})
test('replacing a connection discards its late decision',async()=>{
 const pending=deferred(),entered=deferred();let connected=true
 const {c}=setup({current:()=>connected,select:()=>{entered.resolve();return pending.promise}})
 const work=c.next();await entered.promise;connected=false;pending.resolve({index:0});await assert.rejects(work,/cancelled/);c.close()
})
test('changed health during selection requires a fresh decision',async()=>{
 let calls=0;const {c,state,events}=setup({select:async()=>{if(++calls===1)state.health=15;return {index:0}}})
 try{await c.next();assert.equal(calls,2);assert.equal(events.filter(e=>e.type==='skill_selection_discarded').length,1)}finally{c.close()}
})
test('inspection can re-observe natural healing without rejecting a harmless read',async()=>{
 const {c,state}=setup({plan:async()=>({reply:'Check recovery',steps:[{action:'inspect'}]}),select:async()=>{state.health+=0.1;return {index:0}}})
 state.health=19
 try{assert.equal((await c.next()).steps[0].action,'inspect');assert.equal(c.budget.decisions,1)}finally{c.close()}
})
test('a goal verified during selection prevents an unnecessary action',async()=>{
 const {c,state}=setup({select:async()=>{state.verification.verdict='passed';return {index:0}}})
 try{assert.deepEqual((await c.next()).steps,[])}finally{c.close()}
})
test('unoffered actions fail closed to the first eligible planner option and are labelled fallback',async()=>{
 const {c,events}=setup({select:async()=>({index:99}),eligible:s=>s.item==='cobblestone'})
 try{assert.equal((await c.next()).steps[0].item,'cobblestone');assert.equal(c.budget.fallbacks,1);assert.equal(events.find(e=>e.type==='skill_selected').fallback,true)}finally{c.close()}
})
test('expired proposals cannot execute after a failed refresh',async()=>{
 const {c}=setup();try{await c.next();c.proposal.started=0;c.plan=async()=>{throw Error('Planner unavailable')};await assert.rejects(c.next(),/Planner unavailable/)}finally{c.close()}
})
test('empty candidate filtering cannot masquerade as goal completion',async()=>{
 const {c}=setup({eligible:()=>false});try{await assert.rejects(c.next(),/No eligible skill/)}finally{c.close()}
})
test('saved planner and decision budgets survive a new controller session',async()=>{
 for(const budget of [{plannerCalls:24,decisions:0,fallbacks:0},{plannerCalls:0,decisions:96,fallbacks:0}]){
  const {c}=setup({budget});try{await assert.rejects(c.next(),/budget exhausted/)}finally{c.close()}
 }
})
test('background refresh skips unchanged observations and captures new evidence',async()=>{
 const {c,state}=setup();try{
  await c.next();c.lastStarted=-Infinity;await c.refresh();assert.equal(c.budget.plannerCalls,1)
  state.inventory.oak_log=1;await c.refresh();assert.equal(c.budget.plannerCalls,2)
 }finally{c.close()}
})
test('observation errors stop refresh without launching a provider call',async()=>{
 const {c}=setup({observe:()=>{throw Error('Chunks unavailable')}})
 try{await c.refresh();assert.equal(c.error.message,'Chunks unavailable');assert.equal(c.budget.plannerCalls,0)}finally{c.close()}
})
test('corrupt saved counters cannot reset the call budget',()=>{
 assert.throws(()=>setup({budget:{plannerCalls:-1}}),/Invalid saved/)
})
test('a completed choice is not offered again by a planner call that started before selection',async()=>{
 const pending=deferred();const {c}=setup({select:async()=>({index:0})})
 try{
  await c.refresh(true);c.plan=()=>pending.promise;const refreshing=c.refresh(true)
  assert.equal((await c.next()).steps[0].item,'oak_log')
  pending.resolve({reply:'Supplies',steps:[step('oak_log'),step('cobblestone')]});await refreshing
  assert.equal((await c.next()).steps[0].item,'cobblestone')
 }finally{c.close()}
})
test('unbounded following cannot enter the pilot action interface',async()=>{
 const {c}=setup({plan:async()=>({reply:'Follow',steps:[{action:'follow'}]})});try{await assert.rejects(c.next(),/outside the skill pilot/)}finally{c.close()}
})
test('provider timeouts are bounded even when the adapter ignores its signal',async()=>{
 await assert.rejects(boundedCall(()=>new Promise(()=>{}),new AbortController().signal,5),/deadline exceeded/)
})
test('TypeSafe transport uses the existing endpoint, validates offered IDs and does not echo error bodies',async()=>{
 const o=observation(),options=[step('oak_log'),step('cobblestone')];let request
 const result=await selectSkill(o,options,{key:'fixture-key',signal:new AbortController().signal,fetcher:async(url,opts)=>{request={url,...opts};return {ok:true,json:async()=>({model:'fixture-jev',answers:{action:{choice:'a1'}},usage:{input_tokens:123}})}}})
 assert.equal(result.index,1);assert.equal(result.inputTokens,123);assert.equal(request.url,'https://api.typesafe.ai/v1/systemone');assert.equal(request.redirect,'error')
 const body=JSON.parse(request.body);assert.deepEqual(Object.keys(body.questions.action.criteria),['a0','a1']);assert.equal(body.state.goal.summary,'Make supplies')
 await assert.rejects(selectSkill(o,options,{key:'fixture-key',fetcher:async()=>({ok:true,json:async()=>({answers:{action:{choice:'a9'}}})})}),/unoffered/)
 await assert.rejects(selectSkill(o,options,{key:'fixture-key',fetcher:async()=>({ok:false,status:401,json:async()=>({secret:'must not appear'})})}),{message:'TypeSafe skill selection HTTP 401'})
})
test('only pilot planner calls request independent alternatives',async()=>{
 const planner=new LocalPlanner();let prompt
 planner.fetcher=async(url,opts)=>{prompt=JSON.parse(opts.body).messages[0].content;return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({reply:'Inspect',steps:[{action:'inspect'}]})}}]})}}
 const o=observation();await planner.plan('make supplies',o,[],new AbortController().signal);assert.doesNotMatch(prompt,/INDEPENDENT alternatives/)
 await planner.plan('make supplies',{...o,actionSelection:{mode:'independent',allowedActions:['inspect']}},[],new AbortController().signal);assert.match(prompt,/INDEPENDENT alternatives/)
})
class Runner extends EventEmitter {
 constructor(){super();this.profile='fixture';this.owner='tester';this.ready=true;this.connectionId='one';this.commands=[];this.items={};this.bot={health:20,food:20,players:{},inventory:{items:()=>Object.entries(this.items).map(([name,count])=>({name,count}))}}}
 position(){return {x:0,y:64,z:0}}
 command(c){this.emit('operator_command',c);this.commands.push(c);if(c.action==='stop')return;const task=this.task={id:String(this.commands.length),kind:c.action,status:'running',goal:c.goal};setTimeout(()=>{if(c.action==='acquire')this.items[c.goal.item]=c.goal.count;this.task={...task,status:'completed',result:{item:c.goal.item}};this.emit('event',{type:'task_finished',task:this.task})},1)}
}
const contract=()=>({kind:'task',summary:'Make supplies',projectMode:'none',milestones:['Acquire supplies'],constraints:[],criteria:['oak_log','cobblestone'].map(item=>({kind:'inventory',description:'Have '+item,target:'',item,count:1}))})
function integrated(mode='jev'){
 const runner=new Runner(),calls=[]
 const planner={model:'fixture',formulate:async()=>contract(),plan:async(text,o)=>{calls.push(o);return {reply:'Acquire missing supplies',steps:[step('oak_log'),step('cobblestone')].filter(s=>!o.inventory[s.item])}}}
 const c=new Teammate(runner,planner,join(mkdtempSync(join(tmpdir(),'mc-skill-control-')),'state.json'));c.skillControlMode=mode;c.skillSelect=async(o,options)=>({index:options.length-1});return {runner,c,calls}
}
test('controller executes Jev choices through the existing executor and verifies the original goal',async()=>{
 const {runner,c,calls}=integrated();await c.submit('make supplies')
 assert.deepEqual(runner.commands.filter(x=>x.action!=='stop').map(x=>x.goal.item),['cobblestone','oak_log']);assert.equal(c.requestProgress.status,'verified');assert.equal(calls.length,1);assert.equal(calls[0].actionSelection.mode,'independent');assert.equal(c.snapshot().skillControl.budget.decisions,2)
 const saved=JSON.parse(readFileSync(c.statePath,'utf8'));assert.equal(saved.requestProgress.skillControl.decisions,2)
})
test('default controller retains its ordering and makes no Jev skill decisions',async()=>{
 const {runner,c,calls}=integrated('planner');c.skillSelect=()=>{throw Error('Unexpected Jev call')};await c.submit('make supplies')
 assert.equal(c.requestProgress.status,'verified');assert.deepEqual(runner.commands.filter(x=>x.action!=='stop').map(x=>x.goal.item),['oak_log','cobblestone']);assert.equal(calls[0].actionSelection,undefined);assert.equal(c.requestProgress.skillControl,undefined)
})
test('controller Stop prevents a delayed Jev choice from executing and retains cancellation',async()=>{
 const {runner,c}=integrated(),pending=deferred(),entered=deferred();c.skillSelect=()=>{entered.resolve();return pending.promise}
 const work=c.submit('make supplies');await entered.promise;c.stop();pending.resolve({index:0});await work
 assert.equal(c.requestProgress.status,'cancelled');assert.equal(runner.commands.filter(x=>x.action!=='stop').length,0)
})
test('controller refuses premature completion from the pilot',async()=>{
 const {c}=integrated();c.planner.plan=async()=>({reply:'Done',steps:[]});await c.submit('make supplies');assert.equal(c.requestProgress.status,'blocked');assert.match(c.requestProgress.blocker,/Goal still incomplete/)
})
