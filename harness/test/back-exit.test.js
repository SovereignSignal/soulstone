import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {shaftCell} from '../src/back-exit.js'
import {insideBase} from '../src/retreat.js'
// Step 1 of workstreams/minecraft/back-exit-plan.md: the reserved interior
// floor cell a back exit goes down through, and the base still counting the
// bot as inside while it is in that shaft.
const design=[]
for(let x=0;x<4;x++)for(let z=0;z<4;z++)for(let y=0;y<3;y++)if((y===2||x===0||x===3||z===0||z===3)&&!(x===1&&z===0&&y<2))design.push({x,y,z,block:'cobblestone'})
const base=(stations={})=>({build:{origin:{x:10,y:64,z:20},design},stations})
test('the shaft cell is the interior floor cell farthest from the door that no station stands on',()=>{
 // Door at (1,0) relative; interior is (1..2, 1..2). Farthest from the door: (2,2).
 assert.deepEqual(shaftCell(base()),{x:12,y:64,z:22})
 assert.deepEqual(shaftCell(base({torch:{position:{x:12,y:64,z:22},confirmed:true}})),{x:11,y:64,z:22},'a torch on that cell moves it to the next farthest')
 assert.throws(()=>shaftCell(base({a:{position:{x:11,y:64,z:21}},b:{position:{x:12,y:64,z:21}},c:{position:{x:11,y:64,z:22}},d:{position:{x:12,y:64,z:22}}})),/free interior floor cell/)
 assert.throws(()=>shaftCell({build:null}),/saved base/)
 assert.deepEqual(shaftCell(base({shaft:{position:{x:11,y:64,z:21},confirmed:true}})),{x:11,y:64,z:21},'a shaft already chosen is kept, wherever it is')
})
test('down the shaft the bot is still inside its base; anywhere else below the floor it is not',()=>{
 const project=base({shaft:{position:{x:12,y:64,z:22},bottom:55,confirmed:true}})
 const at=(x,y,z)=>insideBase({entity:{position:new Vec3(x,y,z)}},project)
 assert.equal(at(12.5,64,22.5),true,'standing on the shaft cell')
 assert.equal(at(12.5,60,22.5),true,'in the shaft')
 assert.equal(at(12.5,55,22.5),true,'at its bottom')
 assert.equal(at(12.5,54,22.5),false,'below the recorded bottom is somewhere else')
 assert.equal(at(11.5,60,21.5),false,'another column under the floor is not the base')
 assert.equal(insideBase({entity:{position:new Vec3(12.5,60,22.5)}},base()),false,'no shaft recorded, no column')
})
