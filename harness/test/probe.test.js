import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {surroundings} from '../src/companion/probe.js'
test('the surroundings probe reports physics flags and the blocks around the feet',()=>{
 const bot={entity:{position:new Vec3(-635.09,67,609.7),onGround:false,isInWater:false,isInLava:false,velocity:{x:0,y:-0.08,z:0}},blockAt:p=>({name:p.y<67?'grass_block':p.y===67&&p.x===-636?'oak_fence':'air',boundingBox:p.y<67?'block':'empty'})}
 const s=surroundings(bot)
 assert.deepEqual(s.feet,{x:-636,y:67,z:609});assert.equal(s.onGround,false);assert.equal(s.standingOn,'grass_block');assert.equal(s.inside,'oak_fence')
 assert.equal(s.cells.length,3*3*4);assert.ok(s.cells.some(c=>c.name==='oak_fence'))
 assert.deepEqual(surroundings({}),{connected:false})
})
