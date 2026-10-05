import test from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {digStaircase,nextStair} from '../src/staircase.js'
const registry=minecraftData('1.21.4')
// Stone below y 64, air above; a bot that falls through open cells and steps
// where the pathfinder is sent. Every sealed-lava opening on 4 October failed
// with "Took to long to decide path to goal!" through 25 to 35 blocks of rock.
function world(cells=new Map(),at=[0.5,64,0.5]){
 const name=p=>cells.get(p.toString())??(p.y>=64?'air':'stone')
 const dug=[]
 let pos=new Vec3(...at)
 const bot={registry,inventory:{items:()=>[]},heldItem:null,
  blockAt:p=>{const f=p.floored(),n=name(f),e=registry.blocksByName[n];return {name:n,position:f,boundingBox:e?.boundingBox||'block',diggable:e?.diggable!==false,harvestTools:e?.harvestTools}},
  async dig(b){dug.push(b.position.toString());cells.set(b.position.toString(),'air')},
  pathfinder:{async goto(g){pos=new Vec3(g.x+.5,g.y,g.z+.5)}}}
 bot.entity={get position(){while(pos.y>-60&&name(pos.floored().offset(0,-1,0))==='air')pos=pos.offset(0,-1,0);return pos},set position(v){pos=v},onGround:true}
 return {bot,cells,dug}
}
const run=(w,to)=>digStaircase(w.bot,new Vec3(...to),{check(){},progress(){},stage(){}})
test('the staircase reaches a cell below and to the side, one step down per step, through stone only',async()=>{
 const w=world(),r=await run(w,[4,61,1])
 assert.equal(r.receipt,'staircase_arrived');assert.deepEqual(r.at,{x:4,y:61,z:1})
 assert.ok(w.dug.every(k=>{const [x,y,z]=k.slice(1,-1).split(', ').map(Number);return y>=61}),'never below the target: '+w.dug.join(' '))
 assert.ok(r.steps<=6,'steps: '+r.steps)
})
test('it digs straight down when it is above the target',async()=>{
 const w=world(),r=await run(w,[0,60,0]);assert.deepEqual(r.at,{x:0,y:60,z:0});assert.equal(r.steps,4)
})
test('it stops for water against a block it would dig, for a player\'s planks, for a missing floor, and for a target above',async()=>{
 const wet=world(new Map([[new Vec3(1,63,-1).toString(),'water']]))
 await assert.rejects(run(wet,[4,61,0]),/borders water/)
 const house=world(new Map([[new Vec3(1,64,0).toString(),'oak_planks']]))
 await assert.rejects(run(house,[4,61,0]),/oak_planks .* not natural ground/)
 const cave=world(new Map([[new Vec3(1,62,0).toString(),'air'],[new Vec3(1,61,0).toString(),'air']]))
 await assert.rejects(run(cave,[4,61,0]),/no solid floor under 1,63,0/)
 await assert.rejects(run(world(),[3,66,0]),/only goes down or level/)
})
test('a step clears feet, head and, going down, the head room above',()=>{
 const {next,cells}=nextStair(new Vec3(0,64,0),new Vec3(5,60,1))
 assert.deepEqual(next.toArray(),[1,63,0]);assert.deepEqual(cells.map(c=>c.y),[65,64,63])
 assert.deepEqual(nextStair(new Vec3(0,64,0),new Vec3(5,64,1)).cells.map(c=>c.y),[65,64],'level: feet and head')
})

test('on open ground falling away it steps down to a landing at most three below; a deeper drop or a crust over a hole stops it',async()=>{
 // 4 October run 54: the staircase stopped on a hillside, "no solid floor under -623,73,-445 (air)".
 const hill=new Map();for(let x=1;x<=6;x++)for(let y=62;y<=63;y++)hill.set(new Vec3(x,y,0).toString(),'air')
 const w=world(hill),r=await run(w,[6,59,0]);assert.deepEqual(r.at,{x:6,y:59,z:0})
 const cliff=new Map();for(let x=1;x<=6;x++)for(let y=56;y<=63;y++)cliff.set(new Vec3(x,y,0).toString(),'air')
 await assert.rejects(run(world(cliff),[6,50,0]),/no solid floor under 1,63,0/,'an eight-block drop is a cliff')
 const crust=new Map([[new Vec3(1,62,0).toString(),'air'],[new Vec3(1,61,0).toString(),'air']])
 await assert.rejects(run(world(crust),[6,59,0]),/no solid floor/,'stone over a hole is a cave, not a step')
})

test('a blocked step along one axis is taken along the other, as a player sidesteps',async()=>{
 // Run 56: the straight line crossed a pit dug by earlier pours.
 const pit=new Map();for(let y=55;y<=63;y++)pit.set(new Vec3(1,y,0).toString(),'air')
 const w=world(pit),r=await run(w,[4,61,2]);assert.deepEqual(r.at,{x:4,y:61,z:2},'went round the pit along z first')
 const walled=new Map();for(let y=55;y<=63;y++){walled.set(new Vec3(1,y,0).toString(),'air')}
 await assert.rejects(run(world(walled),[4,61,0]),/no solid floor/,'with no ground left along the other axis it stops')
})
