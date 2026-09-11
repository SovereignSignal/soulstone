import test from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {parseBuildingBlock,matchesBuildingBlock,validateBuildingBlock,verifyPassage} from '../src/building-blocks.js'
import {compileArchitecture,fullCube,architectureMaterials} from '../src/construction.js'
import {validatePlan} from '../src/companion/planner.js'
import {validateTaskGoal} from '../src/task-store.js'
import {openDoorHasCenterClearance,correctDoorWaypoints} from '../src/navigation.js'
const region=(x,y,z,block)=>({x,y,z,x2:x,y2:y,z2:z,block})
const design=[region(0,0,0,'oak_door[facing=north]'),region(1,0,0,'checkpoint'),region(1,0,1,'checkpoint')]
test('stateful blueprints survive planner and durable task validation; doors cost one item and reserve two cells',()=>{
 const bp=compileArchitecture(design)
 assert.equal(bp.blocks.length,1);assert.equal(bp.cells.length,2);assert.equal(bp.cells[1].properties.half,'upper')
 assert.deepEqual(validatePlan({reply:'Building.',steps:[{action:'construct',name:'entry',count:0,item:'',design}]}).steps[0].design,design)
 assert.deepEqual(validateTaskGoal('construct',{name:'entry',design,near:{x:0,y:64,z:0}}).design,design)
 assert.throws(()=>compileArchitecture([...design,region(0,1,0,'stone')]),/upper half/)
 assert.throws(()=>compileArchitecture([...design,region(0,1,0,'checkpoint')]),/headroom/)
 assert.throws(()=>compileArchitecture([region(0,16,0,'oak_door[facing=north]'),...design.slice(1)]),/bounds/)
 const bot={blockAt:()=>({name:'air'})};assert.deepEqual(architectureMaterials(bp.blocks,bot,new Vec3(0,0,0)),{oak_door:1})
})
test('state grammar and version registry reject unsupported states before placement',()=>{
 const registry=minecraftData('1.21.4')
 for(const name of ['oak_door','spruce_fence_gate','stone_brick_stairs'])for(const facing of ['north','south','east','west'])validateBuildingBlock(registry,parseBuildingBlock(`${name}[facing=${facing}]`),fullCube)
 for(const text of ['oak_door','oak_door[facing=up]','oak_door[facing=north,__proto__=north]','oak_door[facing=north,open=true]','oak_door[facing=north,facing=south]','stone[foo=bar]','oak_stairs[facing=east,half=top]','iron_door[facing=north]','oak_door[facing=north];say hi'])assert.throws(()=>parseBuildingBlock(text),undefined,text)
 assert.throws(()=>validateBuildingBlock(registry,parseBuildingBlock('imaginary_door[facing=north]'),fullCube),/Unsupported/)
})
test('matching names never conceal wrong orientation, open state or door half',()=>{
 const expected=parseBuildingBlock('oak_door[facing=north]')
 const actual=properties=>({name:'oak_door',getProperties:()=>({...expected.properties,...properties})})
 assert.equal(matchesBuildingBlock(actual({facing:'south'}),expected),false)
 assert.equal(matchesBuildingBlock(actual({half:'upper'}),expected),false)
 assert.equal(matchesBuildingBlock(actual({open:true}),expected),false)
 assert.equal(matchesBuildingBlock(actual({open:true}),expected,{ignoreOpen:true}),true)
 assert.equal(matchesBuildingBlock(actual({powered:true}),expected,{ignoreOpen:true}),false)
})
test('passage verification traverses the centre in both directions, closes, and rejects false arrival',async()=>{
 const b=parseBuildingBlock('oak_fence_gate[facing=east]'),pos=new Vec3(0,64,0);let open=false,toggles=0
 const bot={world:{},entity:{position:pos,onGround:true},blockAt:()=>({name:b.block,getProperties:()=>({...b.properties,open})}),unequip:async()=>{},activateBlock:async()=>{toggles++;open=!open}}
 const api={check(){},settle:async(p,msg)=>assert.ok(p(),msg),walk:async g=>{if(g.x!==undefined)bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)}}
 const receipt=await verifyPassage(bot,pos,b,api)
 assert.equal(toggles,2);assert.equal(open,false);assert.equal(receipt.visits.length,5);assert.deepEqual(receipt.visits.map(p=>p.x),[-.5,.5,1.5,.5,-.5])
 api.walk=async()=>{};bot.entity.position=new Vec3(20,64,20)
 await assert.rejects(verifyPassage(bot,pos,b,api),/grounded checkpoint/)
})
test('open gates receive collision-aware movement and ground-level waypoints',()=>{
 const gate={name:'oak_fence_gate',shapes:[],getProperties:()=>({open:true})}
 assert.equal(openDoorHasCenterClearance(gate),true)
 assert.equal(openDoorHasCenterClearance({...gate,getProperties:()=>({open:false})}),false)
 const point=new Vec3(.5,64,.5),bot={blockAt:p=>p.y===64?gate:p.y===63?{boundingBox:'block'}:{boundingBox:'empty'}}
 correctDoorWaypoints(bot,[point]);assert.equal(point.y,64)
})

test('door and gate plans reject a wall in the crossing route before world writes',()=>{
 assert.throws(()=>compileArchitecture([...design,region(0,0,1,'stone')]),/passage/)
})

import {placeBuildingBlock} from '../src/building-blocks.js'
test('oriented placement awaits the transmitted rotation instead of the immediate forced look',async()=>{
 const b=parseBuildingBlock('oak_stairs[facing=east]'),pos=new Vec3(0,64,0);let rotated=false,placed=false
 const bot={world:{},inventory:{items:()=>[{name:'oak_stairs',count:1}]},equip:async()=>{},look:async(yaw,pitch,force)=>{assert.equal(force,undefined);await new Promise(r=>setTimeout(r,10));rotated=true},_placeBlockWithOptions:async(ref,face,options)=>{assert.ok(rotated);assert.equal(options.forceLook,'ignore');placed=true},blockAt:p=>({position:p,name:placed?b.block:'air',getProperties:()=>b.properties})}
 bot.world.getBlock=p=>({position:p,shapes:[[0,0,0,1,1,1]]})
 await placeBuildingBlock(bot,pos,b,{walk:async()=>{},check(){},stage(){},settle:async p=>assert.ok(p()),approach:async()=>({ref:pos.offset(0,-1,0)})})
 assert.ok(placed)
})

import {executeConstruction} from '../src/construction.js'
test('a wrong-state placement stops before it can become a misleading material shortage',async()=>{
 let wrong=false,placements=0
 const registry=minecraftData('1.21.4'),pos=new Vec3(0,64,0)
 const bot={registry,inventory:{items:()=>[{name:'oak_door',count:1}]},blockAt:p=>p.y===63?{name:'stone'}:wrong&&p.equals(pos)?{name:'oak_door',getProperties:()=>({facing:'south',half:'lower',open:false,powered:false})}:{name:'air'}}
 await assert.rejects(executeConstruction(bot,{goal:{name:'entry',design,origin:pos,near:pos}},{check(){},persist(){},progress(){},place:async()=>{placements++;wrong=true;throw new Error('orientation not confirmed')}}),/state mismatch/)
 assert.equal(placements,1)
})

test('normal gate-facing reversal preserves the required passage axis; perpendicular gates still fail',()=>{
 const b=parseBuildingBlock('oak_fence_gate[facing=west]')
 const actual=facing=>({name:b.block,getProperties:()=>({...b.properties,facing})})
 assert.equal(matchesBuildingBlock(actual('east'),b),true)
 assert.equal(matchesBuildingBlock(actual('west'),b),true)
 assert.equal(matchesBuildingBlock(actual('north'),b),false)
 assert.equal(matchesBuildingBlock(actual('south'),b),false)
})

for(const resumed of [false,true])test(`construction keeps its ${resumed?'previously installed':'new'} passage open for remaining work and closes it after verification`,async()=>{
 const origin=new Vec3(0,64,0),gate=parseBuildingBlock('oak_fence_gate[facing=north]');let installed=resumed,open=false,roof=false,toggles=0
 const d=[region(0,0,0,'oak_fence_gate[facing=north]'),region(2,1,0,'stone'),region(1,0,0,'checkpoint'),region(1,0,1,'checkpoint')]
 const bot={registry:minecraftData('1.21.4'),world:{},entity:{position:new Vec3(1.5,64,.5),onGround:true},inventory:{items:()=>[{name:'oak_fence_gate',count:1},{name:'stone',count:1}]},
  blockAt:p=>({position:p,...(p.y===63?{name:'stone',boundingBox:'block'}:installed&&p.equals(origin)?{name:gate.block,boundingBox:'block',shapes:[],getProperties:()=>({...gate.properties,open})}:roof&&p.equals(origin.offset(2,1,0))?{name:'stone',boundingBox:'block'}:{name:'air',boundingBox:'empty'})}),
  unequip:async()=>{},activateBlock:async()=>{toggles++;open=!open}}
 const api={check(){},persist(){},progress(){},place:async(p,name)=>{if(name===gate.block){installed=true;open=false}else{assert.ok(open,'Remaining roof needs access through the installed passage');roof=true}},walk:async g=>{if(g.x!==undefined)bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5)},settle:async(p,msg)=>assert.ok(p(),msg)}
 const result=await executeConstruction(bot,{goal:{name:'room',design:d,origin,near:origin}},api)
 assert.equal(result.partial,false);assert.ok(roof);assert.equal(open,false);assert.ok(toggles>=2);assert.equal(result.interactions.length,1)
})
