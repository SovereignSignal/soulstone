import {LocalPlanner} from '../src/companion/planner.js'
import {ModelProfiles} from '../src/companion/providers.js'
import {writeFileSync,readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
const profiles=new ModelProfiles('state/models.json'),profile=profiles.profiles.find(p=>p.kind==='codex'&&p.model==='gpt-6-astra')
assert.ok(profile)
const planner=new LocalPlanner();planner.profiles={current:profile,key:''}
const before=JSON.parse(readFileSync('results/live-prospect-before.json'))
const observation={...before,messages:undefined,task:null,feedback:[],remainingPlanningRounds:6,requestProgress:{id:'synthetic-ore-eval',request:'Get one diamond.',status:'running',completed:[],pending:[]}}
const first=await planner.plan('Get one diamond.',observation,[],new AbortController().signal)
assert.ok(first.steps.some(s=>s.action==='prospect'&&s.item==='raw_iron'),'Must repair inaccessible iron prerequisite using prospecting')
assert.equal(first.steps.some(s=>s.action==='give'),false)
const partial=await planner.plan('Get one diamond.',{...observation,inventory:{iron_pickaxe:1},feedback:[{action:'prospect',step:{action:'prospect',name:'base',item:'diamond',count:1},status:'completed',result:{item:'diamond',count:0,target:1,partial:true,acquired:false,returned:true,next:'Excavation progress saved; continue from frontier'}}]},[],new AbortController().signal)
assert.ok(partial.steps.some(s=>s.action==='prospect'&&s.item==='diamond'),'Partial excavation must continue, not claim a diamond')
writeFileSync('results/prospect-planner.json',JSON.stringify({status:'passed',model:profile.model,scope:'Synthetic planner observations; no game execution',first,partial},null,2))
console.log(JSON.stringify({status:'passed',first,partial},null,2))
