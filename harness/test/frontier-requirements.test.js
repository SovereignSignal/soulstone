import test from 'node:test'
import assert from 'node:assert/strict'
import {coveredDeck} from './frontier-requirements.js'
const make=()=>({blocks:[1,4].flatMap(y=>Array.from({length:6},(_,i)=>({x:i%2,y,z:Math.floor(i/2),block:'oak_planks'})))})
const origin={x:10,y:251,z:20},walk=[{x:10.5,y:253,z:20.5}]
test('covered deck requires usable area, overhead coverage and actual access to that deck',()=>{
 assert.equal(coveredDeck(make(),origin,walk).walkingHeight,2)
 const uncovered=make();uncovered.blocks.pop();assert.equal(coveredDeck(uncovered,origin,walk),null)
 const obstructed=make();obstructed.blocks.push({x:0,y:3,z:0,block:'oak_planks'});assert.equal(coveredDeck(obstructed,origin,walk),null)
 assert.equal(coveredDeck(make(),origin,[{x:16.5,y:253,z:20.5}]),null)
 assert.equal(coveredDeck({blocks:make().blocks.filter(p=>p.z<2)},origin,walk),null)
})
