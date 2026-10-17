import test from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {kickContext} from '../src/kick-context.js'

// Fresh-world tests on lab-2 and lab-3, 9 October: twice the server kicked the bot
// for "floating too long" moments after it climbed out of its burrow. Its own
// view at the kick is what tells a missing block under it from anything else.
test('a kick records where the bot thought it stood, what it thought was under it, and its last placements',()=>{
 const world={'0,63,0':'cobblestone','0,62,0':'stone'}
 const bot={entity:{position:new Vec3(0.5,64.0013,0.5),onGround:true,velocity:new Vec3(0,-0.0784,0)},game:{dimension:'minecraft:overworld'},
  blockAt:p=>({name:world[`${p.x},${p.y},${p.z}`]??'air'})}
 const now=Date.now()
 const own={cells:new Map([['overworld|0,63,0',{name:'cobblestone',at:now-2000}],['overworld|0,62,0',{name:'cobblestone',at:now-9000}],['overworld|5,70,5',{name:'dirt',at:now-1000}]])}
 const c=kickContext(bot,own)
 assert.deepEqual(c.position,{x:0.5,y:64.0013,z:0.5})
 assert.equal(c.onGround,true);assert.equal(c.velocityY,-0.0784)
 assert.deepEqual(c.column,{feet:'air',below1:'cobblestone',below2:'stone'})
 assert.deepEqual(c.recentPlacements.map(p=>p.cell),['overworld|5,70,5','overworld|0,63,0','overworld|0,62,0'],'newest first')
 assert.ok(c.recentPlacements.every(p=>Number.isFinite(p.ageMs)&&p.name))
})
test('a kick before spawn or without placements still records what it can',()=>{
 assert.deepEqual(kickContext({entity:null},null),{position:null,onGround:null,velocityY:null,column:null,recentPlacements:[]})
})
