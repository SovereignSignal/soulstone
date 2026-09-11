import {LocalPlanner} from '../src/companion/planner.js'
import {ModelProfiles} from '../src/companion/providers.js'
import {writeFileSync,mkdirSync} from 'node:fs'
import assert from 'node:assert/strict'
const profiles=new ModelProfiles('state/models.json')
const profile=profiles.profiles.find(p=>p.kind==='claude')
assert.ok(profile,'Claude profile required')
const planner=new LocalPlanner();planner.profiles={current:profile,key:''}
const observation={connected:true,owner:'Evaluator',ownerVisible:true,position:{x:0,y:64,z:0},ownerPosition:{x:2,y:64,z:0},inventory:{},places:{},nearby:[{name:'oak_log',x:4,y:64,z:0},{name:'stone',x:5,y:64,z:0}],feedback:[]}
const first=await planner.plan('Make me a stone pickaxe.',observation,[],new AbortController().signal)
assert.ok(first.steps.some(s=>s.action==='acquire'&&s.item==='stone_pickaxe'))
const second=await planner.plan('Make me a stone pickaxe.',{...observation,inventory:{stone_pickaxe:1},feedback:[{action:'acquire',status:'completed',result:{item:'stone_pickaxe',count:1},inventory:{stone_pickaxe:1}}]},[],new AbortController().signal)
assert.equal(second.steps.length,0)
mkdirSync('results',{recursive:true});writeFileSync('results/planner-generic-smoke.json',JSON.stringify({status:'passed',kind:profile.kind,model:profile.model,scope:'Simulated observations; no in-world execution',first,second},null,2));console.log(JSON.stringify({status:'passed',kind:profile.kind,model:profile.model,first,second},null,2))
