import test from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {digStaircase,nextStair} from '../src/staircase.js'
const registry=minecraftData('1.21.4')
// Stone below y 64, air above; a bot that falls through open cells and steps
// where the pathfinder is sent. Every sealed-lava opening on 4 October failed
// with "Took to long to decide path to goal!" through 25 to 35 blocks of rock.
function world(cells=new Map(),at=[0.5,64,0.5],{blocks=0}={}){
 const name=p=>cells.get(p.toString())??(p.y>=64?'air':'stone')
 const dug=[],placed=[],items=blocks?[{name:'cobblestone',count:blocks,type:registry.itemsByName.cobblestone.id}]:[]
 let pos=new Vec3(...at)
 const bot={registry,inventory:{items:()=>items.filter(i=>i.count>0)},heldItem:null,
  async equip(){},
  async placeBlock(ref,face){const c=ref.position.plus(face);cells.set(c.toString(),'cobblestone');placed.push(c.toString());items[0].count--},
  blockAt:p=>{const f=p.floored(),n=name(f),e=registry.blocksByName[n];return {name:n,position:f,boundingBox:e?.boundingBox||'block',diggable:e?.diggable!==false,harvestTools:e?.harvestTools}},
  async dig(b){dug.push(b.position.toString());cells.set(b.position.toString(),'air')},
  pathfinder:{async goto(g){pos=new Vec3(g.x+.5,g.y,g.z+.5)}}}
 bot.entity={get position(){while(pos.y>-60&&name(pos.floored().offset(0,-1,0))==='air')pos=pos.offset(0,-1,0);return pos},set position(v){pos=v},onGround:true}
 return {bot,cells,dug,placed}
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
test('it stops for water against a block it would dig, for a player\'s planks and for a missing floor',async()=>{
 const wet=world(new Map([[new Vec3(1,63,-1).toString(),'water']]))
 await assert.rejects(run(wet,[4,61,0]),/borders water/)
 const house=world(new Map([[new Vec3(1,64,0).toString(),'oak_planks']]))
 await assert.rejects(run(house,[4,61,0]),/oak_planks .* not natural ground/)
 const cave=world(new Map([[new Vec3(1,62,0).toString(),'air'],[new Vec3(1,61,0).toString(),'air']]))
 await assert.rejects(run(cave,[4,61,0]),/no solid floor under 1,63,0/)
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

// Family run 3, 5 October: tunnelled down to y 13, the bot could not get back
// up to the sealed pocket's standing cell at y 44; the staircase refused any
// target above and three route searches through rock timed out.
const pocket=(cells=new Map())=>{for(const y of [50,51])cells.set(new Vec3(0,y,0).toString(),'air');return world(cells,[0.5,50,0.5])}
test('climbing, each step clears the head room above, then the next feet and head, and rises one',async()=>{
 const step=nextStair(new Vec3(0,50,0),new Vec3(4,54,1))
 assert.deepEqual(step.next.toArray(),[1,51,0]);assert.deepEqual(step.cells.map(c=>c.toArray()),[[0,52,0],[1,52,0],[1,51,0]])
 const w=pocket(),r=await run(w,[4,54,1])
 assert.equal(r.receipt,'staircase_arrived');assert.deepEqual(r.at,{x:4,y:54,z:1});assert.equal(r.steps,5)
 assert.ok(w.dug.every(k=>{const y=Number(k.slice(1,-1).split(', ')[1]);return y>=50&&y<=55}),w.dug.join(' '))
})
// Climbing six with one block to cross: a two by two spiral away from the
// target rises four a turn on rock it has not dug, then the stairs head over.
test('a climb steeper than the ground to cross spirals in a two by two first',async()=>{
 const w=pocket(),r=await run(w,[1,56,0])
 assert.deepEqual(r.at,{x:1,y:56,z:0});assert.equal(r.steps,10)
 assert.ok(w.dug.every(k=>{const [x,,z]=k.slice(1,-1).split(', ').map(Number);return x>=-1&&x<=1&&z>=0&&z<=1}),w.dug.join(' '))
 await assert.rejects(run(pocket(),[0,55,0]),/directly under/)
})
test('climbing stops under lava and over a hole, never digging into either',async()=>{
 const lava=pocket(new Map([[new Vec3(0,53,0).toString(),'lava']]))
 await assert.rejects(run(lava,[4,54,0]),/supports liquid \(lava\)/);assert.ok(!lava.dug.includes(new Vec3(0,52,0).toString()))
 const hole=pocket(new Map([[new Vec3(1,50,0).toString(),'air']]))
 await assert.rejects(run(hole,[4,54,0]),/no solid step under 1,51,0/)
})

// Run 61, 6 October: inside an open tunnel the block in front at the feet is
// air, so the first climbing step had nothing to step up onto, and level
// search legs stopped at holes in the tunnel floor. A player puts a block down.
const corridor=(opts)=>{const cells=new Map();for(let x=0;x<=3;x++)for(const y of [50,51])cells.set(new Vec3(x,y,0).toString(),'air');return world(cells,[0.5,50,0.5],opts)}
test('climbing through an open tunnel, it places a carried block to step up onto',async()=>{
 const w=corridor({blocks:16}),r=await run(w,[4,54,0])
 assert.deepEqual(r.at,{x:4,y:54,z:0});assert.deepEqual(w.placed,[new Vec3(1,50,0).toString(),new Vec3(2,51,0).toString()])
 await assert.rejects(run(corridor(),[4,54,0]),/no solid step under 1,51,0 .*carry blocks/)
})
test('a level step over a hole bridges it with a carried block',async()=>{
 const w=world(new Map([[new Vec3(1,63,0).toString(),'air'],[new Vec3(1,62,0).toString(),'air']]),[0.5,64,0.5],{blocks:4}),r=await run(w,[3,64,0])
 assert.deepEqual(r.at,{x:3,y:64,z:0});assert.deepEqual(w.placed,[new Vec3(1,63,0).toString()])
})
