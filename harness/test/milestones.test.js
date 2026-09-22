import test from 'node:test'
import assert from 'node:assert/strict'
import {validateContract,evaluateGoal} from '../src/companion/goal-contract.js'
import {validateMilestonePlan,updateMission,syncMissionStatus,missionFocus} from '../src/companion/milestones.js'

const criterion=(kind,item,count)=>({kind,item,count,target:'',description:`${kind} ${item} ${count}`})
const goal=()=>validateContract({kind:'task',summary:'Get fed, prepare tools and build a usable shelter.',projectMode:'none',milestones:['Food','Tools','Shelter'],constraints:[],
 criteria:[criterion('hunger','',18),criterion('tools','stone_pickaxe',1),criterion('shelter','',1)],
 milestonePlan:[{id:'food',description:'Get fed',dependsOn:[],criteria:[0]},{id:'tools',description:'Prepare a usable pickaxe',dependsOn:['food'],criteria:[1]},{id:'shelter',description:'Build a usable shelter',dependsOn:['tools'],criteria:[2]}]})
const bot={inventory:{items:()=>[{name:'stone_pickaxe',count:1,maxDurability:131,durabilityUsed:0}]}}

test('milestones reject cycles, unknown dependencies, duplicate IDs and incomplete or duplicated checks',()=>{
 const original=goal(),bad=[]
 const change=fn=>{const p=structuredClone(original.milestonePlan);fn(p);bad.push(p)}
 change(p=>p[0].dependsOn=['shelter']);change(p=>p[1].dependsOn=['missing']);change(p=>p[1].id='food')
 change(p=>p[1].criteria=[0]);change(p=>p.pop());change(p=>p[2].criteria=[99]);change(p=>p[1].dependsOn=['food','food'])
 for(const plan of bad)assert.throws(()=>validateContract({...original,milestonePlan:plan}),/milestone/i)
 assert.throws(()=>validateMilestonePlan([],original.criteria),/milestone/i)
})

test('legacy saved goals retain their checks without inferring verification from prose',()=>{
 const legacy=goal();delete legacy.milestonePlan;legacy.milestones=['Already done']
 const r={id:'old',status:'running',goal:legacy},verification=evaluateGoal(legacy,{survival:{food:9}},bot)
 updateMission(r,verification)
 assert.equal(r.mission.nodes.length,1);assert.equal(r.mission.nodes[0].status,'ready')
 assert.deepEqual(legacy.milestones,['Already done']);assert.equal(legacy.milestonePlan,undefined)
})

test('fresh evidence skips satisfied stages and reopens lost prerequisites without changing the root goal',()=>{
 const r={id:'mission',status:'running',goal:goal()},original=structuredClone(r.goal)
 const observe=food=>updateMission(r,evaluateGoal(r.goal,{survival:{food}},bot),{now:food})
 observe(20);assert.equal(missionFocus(r.mission).id,'shelter');assert.equal(r.mission.nodes[0].lastPassedAt,20)
 observe(9);assert.equal(missionFocus(r.mission).id,'food');assert.equal(r.mission.nodes[0].status,'ready')
 assert.equal(r.mission.nodes[0].history.at(-1).from,'verified');assert.equal(r.mission.nodes[0].evidence[0].observed,9)
 assert.deepEqual(r.goal,original)
})

test('tool wear and partial shelter receipts do not complete a stage; review remains unverified',()=>{
 const r={id:'mission',status:'running',goal:goal()},worn={inventory:{items:()=>[{name:'stone_pickaxe',count:1,maxDurability:131,durabilityUsed:120}]}}
 updateMission(r,evaluateGoal(r.goal,{survival:{food:20}},worn,[{action:'build',status:'completed',result:{partial:true}}]))
 assert.equal(missionFocus(r.mission).id,'tools');assert.equal(r.mission.nodes[2].status,'waiting')
 r.goal.criteria.push(criterion('review','dragon defeat is not supported',0));r.goal.milestonePlan.push({id:'dragon',description:'Dragon defeat needs a supported executor and verifier',dependsOn:['shelter'],criteria:[3]})
 const verification=evaluateGoal(r.goal,{survival:{food:20}},bot,[{action:'build',status:'completed',result:{usability:{status:'usable'}}}])
 updateMission(r,verification)
 assert.equal(verification.verdict,'needs_review');assert.equal(r.mission.nodes[3].status,'needs_review');assert.equal(r.mission.nodes[3].lastPassedAt,null)
})

test('interruption and disconnection preserve evidence but require fresh observation before scheduling',()=>{
 const r={id:'mission',status:'running',goal:goal()},verification=evaluateGoal(r.goal,{survival:{food:20}},bot)
 updateMission(r,verification);r.status='interrupted';r.blocker='Connection lost';syncMissionStatus(r)
 assert.equal(missionFocus(r.mission),null);assert.equal(r.mission.nodes[2].lastFailure.reason,'Connection lost')
 const restored=JSON.parse(JSON.stringify(r));restored.status='running';restored.blocker=null
 updateMission(restored,verification,{connected:false});assert.equal(missionFocus(restored.mission),null)
 updateMission(restored,verification);assert.equal(missionFocus(restored.mission).id,'shelter')
 assert.equal(restored.mission.nodes[2].lastFailure.reason,'Connection lost')
})
