import test from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {shelterLayout,inspectShelterSite} from '../src/shelter.js'
import {validatePlan} from '../src/companion/planner.js'
import {validateTaskGoal} from '../src/task-store.js'
const design=[]
for(let x=0;x<4;x++)for(let z=0;z<4;z++)for(let y=0;y<3;y++)if((y===2||x===0||x===3||z===0||z===3)&&!(x===1&&z===0&&y<2))design.push({x,y,z,block:'wood_planks'})
test('shelter rejects a solid cuboid, cramped rooms, holes and sealed entrances',()=>{
 assert.equal(shelterLayout(design).inside.length,4)
 assert.throws(()=>shelterLayout([...design,{x:1,y:0,z:1,block:'wood_planks'}]),/interior/)
 assert.throws(()=>shelterLayout(design.filter(b=>!(b.x===2&&b.y===2&&b.z===2))),/roof/)
 assert.throws(()=>shelterLayout([...design,{x:1,y:0,z:0,block:'wood_planks'},{x:1,y:1,z:0,block:'wood_planks'}]),/doorway/)
 assert.throws(()=>shelterLayout(design.filter(b=>!(b.x===2&&b.z===3&&b.y<2))),/exactly one/)
 assert.throws(()=>shelterLayout(design.filter(b=>b.x<3)),/2 by 2/)
})
test('approach checks detect the screenshot terrain problem and restrict repair to soft ground',()=>{
 const layout=shelterLayout(design),origin=new Vec3(0,65,0),blocks=new Map()
 const bot={blockAt:p=>({name:blocks.get(p.toString())||(p.y<65?'stone':'air'),position:p,boundingBox:p.y<65?'block':'empty'})}
 const obstruction=new Vec3(1,65,-1);blocks.set(obstruction.toString(),'sand')
 assert.throws(()=>inspectShelterSite(bot,origin,layout),/obstructed by sand/)
 assert.deepEqual(inspectShelterSite(bot,origin,layout,{repair:true}),[obstruction])
 blocks.set(obstruction.toString(),'chest');assert.throws(()=>inspectShelterSite(bot,origin,layout,{repair:true}),/chest/)
 blocks.clear();blocks.set(new Vec3(1,65,1).toString(),'sand');assert.throws(()=>inspectShelterSite(bot,origin,layout,{repair:true}),/obstructed/)
 assert.throws(()=>inspectShelterSite({blockAt:()=>null},origin,layout),/support/)
})
test('usable shelter is an explicit shared planner/executor contract',()=>{
 const p=validatePlan({reply:'Checking usability.',steps:[{action:'build',name:'shelter',count:0,item:'',design}]})
 assert.equal(p.steps[0].name,'shelter')
 assert.equal(validateTaskGoal('build',{design,near:{x:0,y:65,z:0},purpose:'shelter'}).purpose,'shelter')
 assert.throws(()=>validatePlan({reply:'Building.',steps:[{action:'build',name:'other',design}]}),/location name/)
})

import {openDoorHasCenterClearance} from '../src/navigation.js'
test('navigation permits an open door with player clearance but never a closed or obstructing door',()=>{
 const door={name:'spruce_door',getProperties:()=>({open:true}),shapes:[[0,0,0,.1875,1,1]]}
 assert.equal(openDoorHasCenterClearance(door),true)
 assert.equal(openDoorHasCenterClearance({...door,getProperties:()=>({open:false})}),false)
 assert.equal(openDoorHasCenterClearance({...door,shapes:[[0,0,0,1,1,1]]}),false)
 assert.equal(openDoorHasCenterClearance({...door,name:'chest'}),false)
})

import {correctDoorWaypoints} from '../src/navigation.js'
test('door path waypoints stay at floor height rather than on top of the panel',()=>{
 let open=true
 const bot={blockAt:p=>p.y===64?{boundingBox:'block'}:{name:'oak_door',getProperties:()=>({open,half:p.y===66?'upper':'lower'}),shapes:[[.8125,0,0,1,1,1]]}}
 const path=[new Vec3(1.7,66,2.5)];correctDoorWaypoints(bot,path);assert.deepEqual(path,[new Vec3(1.5,65,2.5)])
 open=false;const closed=[new Vec3(1.7,66,2.5)];correctDoorWaypoints(bot,closed);assert.deepEqual(closed,[new Vec3(1.7,66,2.5)])
})

import {nearbyResources} from '../src/observations.js'
test('resource observations retain nearby wood even when nearer stone would fill the global limit',()=>{
 const bot={registry:{blocksByName:{stone:{id:1},spruce_log:{id:2}}},findBlocks:({matching,count})=>Array.from({length:count},(_,i)=>new Vec3(matching===1?i:30,64,matching)),blockAt:p=>({name:p.z===1?'stone':'spruce_log'})}
 const seen=nearbyResources(bot,['stone','spruce_log'],{countPerKind:1})
 assert.deepEqual(seen.map(b=>b.name),['stone','spruce_log'])
 assert.equal(nearbyResources(undefined,['stone']).length,0)
})
