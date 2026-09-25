import test from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import minecraftData from 'minecraft-data'
import pblock from 'prismarine-block'
import {movementProfile} from '../src/primitives.js'

const registry=minecraftData('1.21.4'),Block=pblock(registry)
function fixture(fill,{covered=false}={}) {
 const bot={registry,inventory:{items:()=>[{name:'cobblestone',type:registry.itemsByName.cobblestone.id,count:16}]},
  entity:{position:new Vec3(.5,64,.5),effects:[]},pathfinder:{bestHarvestTool:()=>null},
  blockAt:p=>{
   const name=p.y<63?'stone':p.y===63?(p.x===1&&p.z===0?fill:'stone'):covered&&p.x===1&&p.z===0&&p.y===64?'stone':'air'
   return Object.assign(Block.fromStateId(registry.blocksByName[name].defaultState,0),{position:p.clone()})
  }}
 return movementProfile(bot,{dig:true})
}
const start={x:0,y:64,z:0,remainingBlocks:16}
test('walking cannot bridge a lava cell by treating it as replaceable scaffold space',()=>{
 const moves=[];fixture('lava').getMoveForward(start,{x:1,z:0},moves)
 assert.equal(moves.length,0,'lava under the destination must not become a scaffold walking edge')
})
test('walking cannot build a two-block jump support in lava',()=>{
 const moves=[];fixture('lava').getMoveJumpUp(start,{x:1,z:0},moves)
 assert.equal(moves.length,0,'jump-up scaffold must not replace lava either')
})
test('ordinary air-gap scaffolding remains available',()=>{
 const m=fixture('air'),forward=[],up=[]
 m.getMoveForward(start,{x:1,z:0},forward);m.getMoveJumpUp(start,{x:1,z:0},up)
 assert.equal(forward.length,1);assert.equal(forward[0].toPlace.length,1)
 assert.equal(up.length,1);assert.equal(up[0].toPlace.length,2)
})
test('an existing solid cover above lava remains a usable step',()=>{
 const moves=[];fixture('lava',{covered:true}).getMoveJumpUp(start,{x:1,z:0},moves)
 assert.equal(moves.length,1);assert.equal(moves[0].toPlace.length,0)
})
