import test from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {compileArchitecture,reviseArchitecture,architectureChanges,applyArchitectureRevision,executeConstruction} from '../src/construction.js'
import {parseBuildingBlock,validateBuildingBlock,verifyFurniture} from '../src/building-blocks.js'
import {fullCube} from '../src/construction.js'
import {validatePlan} from '../src/companion/planner.js'
import {validateTaskGoal} from '../src/task-store.js'
import {validateContract,enforceProjectIntent,evaluateGoal} from '../src/companion/goal-contract.js'
const region=(x,y,z,block,x2=x,y2=y,z2=z)=>({x,y,z,x2,y2,z2,block})
const original=[region(0,0,0,'stone_bricks',4,0,4),region(1,1,1,'checkpoint'),region(2,1,1,'checkpoint')]
const patch=[region(0,0,0,'glass')],revised=reviseArchitecture(original,patch),registry=minecraftData('1.21.4')
const goal=(projectMode='modify')=>validateContract({kind:'task',summary:'Change the saved room.',projectMode,criteria:[{kind:'construction',description:'Revised room verified',target:'room',item:'',count:1}],milestones:['Modify','Verify'],constraints:[]},{room:{construction:{design:original}}})
function fixture(){
 const world=new Map(compileArchitecture(original).cells.map(b=>[[b.x,b.y,b.z].join(','),{name:b.block}]));let digs=0
 const bot={registry,entity:{position:new Vec3(6,1,6)},players:{},inventory:{items:()=>[{name:'glass',count:1}]},blockAt:p=>world.get([p.x,p.y,p.z].join(','))||{name:'air'},tool:{equipForBlock:async()=>{}},dig:async p=>{digs++;world.set('0,0,0',{name:'air'})}}
 const api={check(){},walk:async()=>{},stage(){},persist(){},progress(){},settle:async p=>assert.ok(p())}
 return {bot,world,api,digs:()=>digs}
}
test('small revision patches preserve original cells/checkpoints and roundtrip durable previous geometry',()=>{
 assert.equal(architectureChanges(original,revised).length,1)
 assert.equal(compileArchitecture(revised).checks.length,2)
 assert.throws(()=>reviseArchitecture(original,[region(0,1,0,'glass',8,1,8)]),/64/)
 assert.throws(()=>architectureChanges(original,[...original.slice(1),region(2,0,2,'stone')]),/retain prior/)
 const validated=validatePlan({reply:'Revising.',steps:[{action:'revise',name:'room',count:0,item:'',design:patch}]}).steps[0];assert.equal(validated.action,'revise')
 const saved=validateTaskGoal('construct',{name:'room',near:{x:0,y:64,z:0},origin:{x:0,y:64,z:0},design:revised,previousDesign:original});assert.deepEqual(saved.previousDesign,original)
 assert.throws(()=>validateTaskGoal('construct',{...saved,origin:undefined}),/saved origin/)
})
test('only modification intent authorizes a revision of its identified project',()=>{
 const s={action:'revise',name:'room',design:patch}
 for(const mode of ['continue','inspect','new'])assert.throws(()=>enforceProjectIntent(goal(mode),s,{room:{construction:{design:original}}}),/modify intent/)
 assert.throws(()=>enforceProjectIntent(null,s,{}),/interpreted/)
 enforceProjectIntent(goal(),s,{room:{construction:{design:original}}})
})
test('whole-footprint conflict and protected furnishings prevent all demolition',async()=>{
 const f=fixture();f.world.set('4,0,4',{name:'chest'})
 await assert.rejects(applyArchitectureRevision(f.bot,original,compileArchitecture(revised),new Vec3(0,0,0),f.api),/world conflict/);assert.equal(f.digs(),0)
 const barrel=[...original,region(0,1,0,'barrel')],change=reviseArchitecture(barrel,[region(0,1,0,'air')]);f.world.set('4,0,4',{name:'stone_bricks'});f.world.set('0,1,0',{name:'barrel'})
 await assert.rejects(applyArchitectureRevision(f.bot,barrel,compileArchitecture(change),new Vec3(0,0,0),f.api),/cannot dismantle/);assert.equal(f.digs(),0)
})
test('revision confirms removal, resumes a removed cell, and refuses changed targets or player support',async()=>{
 const f=fixture(),bp=compileArchitecture(revised),origin=new Vec3(0,0,0)
 const r=await applyArchitectureRevision(f.bot,original,bp,origin,f.api);assert.equal(r.removed.length,1);assert.equal(f.digs(),1)
 await applyArchitectureRevision(f.bot,original,bp,origin,f.api);assert.equal(f.digs(),1)
 f.world.set('0,0,0',{name:'stone_bricks'});f.api.walk=async()=>f.world.set('0,0,0',{name:'chest'})
 await assert.rejects(applyArchitectureRevision(f.bot,original,bp,origin,f.api),/target changed/);assert.equal(f.digs(),1)
 f.world.set('0,0,0',{name:'stone_bricks'});f.bot.entity.position=new Vec3(.5,1,.5)
 await assert.rejects(applyArchitectureRevision(f.bot,original,bp,origin,f.api),/player support/)
})
test('revision waits for materials before removal and honors cancellation at the destructive boundary',async()=>{
 const f=fixture();f.bot.inventory.items=()=>[]
 const r=await executeConstruction(f.bot,{goal:{name:'room',design:revised,previousDesign:original,origin:{x:0,y:0,z:0},near:{x:0,y:0,z:0}}},f.api)
 assert.equal(r.partial,true);assert.deepEqual(r.missingMaterials,{glass:1});assert.equal(f.digs(),0)
 let cancelled=false;f.api.stage=()=>{cancelled=true};f.api.check=()=>{if(cancelled)throw new Error('cancelled')}
 await assert.rejects(applyArchitectureRevision(f.bot,original,compileArchitecture(revised),new Vec3(0,0,0),f.api),/cancelled/);assert.equal(f.digs(),0)
})
test('beds reserve and validate the head in every direction, consuming one item',()=>{
 for(const facing of ['north','south','east','west']){
  const block='red_bed[facing='+facing+']',bp=compileArchitecture([...original,region(2,1,3,block)])
  assert.equal(bp.blocks.filter(b=>b.block==='red_bed').length,1);assert.equal(bp.cells.filter(b=>b.block==='red_bed').length,2)
  validateBuildingBlock(registry,parseBuildingBlock(block),fullCube)
 }
 assert.throws(()=>compileArchitecture([...original,region(4,1,3,'red_bed[facing=east]'),region(5,1,3,'stone')]),/head overlaps/)
})
test('bed verification never interacts in an unsafe dimension or claims sleep',async()=>{
 const b=parseBuildingBlock('red_bed[facing=east]'),pos=new Vec3(0,64,0)
 const bot={game:{dimension:'the_nether'},entity:{position:new Vec3(.5,64,1.5),onGround:true},blockAt:p=>p.y===65?{name:'air',boundingBox:'empty'}:{name:'red_bed',getProperties:()=>({...b.properties,part:p.x===1?'head':'foot'})}}
 const api={check(){},walk:async()=>{},settle:async p=>assert.ok(p())}
 await assert.rejects(verifyFurniture(bot,pos,b,api),/Overworld/)
 bot.game.dimension='overworld';const result=await verifyFurniture(bot,pos,b,api);assert.equal(result.sleepTested,false)
})
test('furniture requirements cannot pass from geometry without fresh interaction receipts',()=>{
 const c=goal();c.criteria.push({kind:'furniture',description:'Barrel opens',target:'room',item:'barrel',count:1})
 assert.throws(()=>enforceProjectIntent(c,{action:'revise',name:'room',design:patch},{room:{construction:{design:original}}}),/omits required/)
 assert.equal(evaluateGoal(c,{projects:{}},{},[]).checks.at(-1).passed,false)
})

import {stepKey} from '../src/companion/progress.js'
test('revision deduplication preserves cuboid extent and override order',()=>{
 const a={action:'revise',name:'room',design:[region(0,1,0,'stone'),region(0,1,0,'glass')]}
 assert.notEqual(stepKey(a),stepKey({...a,design:[...a.design].reverse()}))
 assert.notEqual(stepKey(a),stepKey({...a,design:[a.design[0],region(0,1,0,'glass',2,1,0)]}))
})
