import test from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import minecraftData from 'minecraft-data'
import pblock from 'prismarine-block'
import {DoorAwareMovements,allowGroundBreaking} from '../src/navigation.js'
const registry=minecraftData('1.21.4')
const Block=pblock(registry)

// The walking profile, exactly as runner.js builds it on spawn: this is the
// graph every travel, return_base and canopy walk is searched against.
function walker(nameAt){
 const bot={registry,inventory:{items:()=>[]},entity:{position:new Vec3(.5,82,.5),effects:[]},
  pathfinder:{bestHarvestTool:()=>null},
  blockAt:p=>Object.assign(Block.fromStateId(registry.blocksByName[nameAt(p)].defaultState,0),{position:p.clone()})}
 const m=new DoorAwareMovements(bot)
 allowGroundBreaking(bot,m)
 m.allow1by1towers=false;m.allowParkour=false;m.allowFreeMotion=false;m.allowSprinting=false;m.scafoldingBlocks=[];m.maxDropDown=3
 return {bot,m}
}
const column=(x,z)=>p=>p.x===x&&p.z===z

test('a bot on its own dirt pillar has a bounded way down',()=>{
 // 62% of 4,843 position samples in one six-hour run sat at a single y=82, on a
 // one-wide dirt tower the agent built itself. Ascent through the movement graph
 // is free and height-unlimited; descent had no edge at all from a cell whose
 // only neighbour is the pillar it is standing on, because the landing cell is
 // the pillar and a landing cell had to be already-empty.
 const {m}=walker(p=>p.y<=70?'dirt':(column(0,0)(p)&&p.y<=81?'dirt':'air'))
 const landing=m.getLandingBlock(new Vec3(0,82,0),{x:0,z:0})
 assert.ok(landing,'a tower top must have somewhere to go down to')
 assert.equal(landing.position.y,81);assert.equal(landing.name,'dirt')
})

test('a sand column the bot could not climb back out of is still refused',()=>{
 // allowGroundBreaking lists sand as soft ground, so without the falling-block
 // guard this hands the agent a dig-down edge into a shaft it cannot leave:
 // allow1by1towers is false on every maxDropDown:3 profile, and getMoveJumpUp
 // refuses the wall cell with sand above it.
 const {m}=walker(p=>p.y<=59?'sandstone':(column(0,0)(p)&&p.y<=64?'sand':'air'))
 assert.equal(m.getLandingBlock(new Vec3(0,65,0),{x:0,z:0}),null)
})

test('flat breakable ground now carries a downward edge, and that is the blast radius',()=>{
 // Asserted deliberately, not tolerated: every node on soft ground gains a
 // dig-down edge. It is priced at about thirteen against one for a forward
 // step, so A* will not prefer it, but the branching factor rises everywhere.
 const {m}=walker(p=>p.y<=63?'dirt':p.y===64?'grass_block':'air')
 const landing=m.getLandingBlock(new Vec3(0,65,0),{x:0,z:0})
 assert.ok(landing);assert.equal(landing.position.y,64);assert.equal(landing.name,'grass_block')
})

test('water and partial-height floors are never landings',()=>{
 const wet=walker(p=>p.y<=64?'water':'air')
 assert.equal(wet.m.getLandingBlock(new Vec3(0,65,0),{x:0,z:0}),null)
 const slab=walker(p=>p.y<=62?'dirt':p.y===63?'oak_slab':'air')
 assert.equal(slab.m.getLandingBlock(new Vec3(0,65,0),{x:0,z:0}),null)
})

test('the tower top has a neighbour below it in the actual movement graph',()=>{
 // getLandingBlock in isolation is not the thing that moves the bot: the search
 // only sees it if getNeighbors emits a move with a lower y.
 const {m}=walker(p=>p.y<=70?'dirt':(column(0,0)(p)&&p.y<=81?'dirt':'air'))
 const neighbours=m.getNeighbors({x:0,y:82,z:0,remainingBlocks:0})
 assert.ok(neighbours.some(n=>n.y<82),'no way down from the tower: '+JSON.stringify(neighbours.map(n=>[n.x,n.y,n.z])))
})
