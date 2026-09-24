import test from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import minecraftData from 'minecraft-data'
import pblock from 'prismarine-block'
import {DoorAwareMovements,allowGroundBreaking,LAVA_EDGE_COST} from '../src/navigation.js'
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

test('a cell beside lava costs extra to walk through, so routes keep off lava edges',()=>{
 // Trial 21's last walk ended on a lava pool's edge and the bot arrived burning.
 // The pathfinder refuses a lava cell itself; the cell next to it cost nothing.
 const {m}=walker(p=>p.y<=63?'stone':(p.x===2&&p.y===64&&p.z===0?'lava':'air'))
 const moves=m.getNeighbors({x:0,y:64,z:0,remainingBlocks:0})
 const at=(x,z)=>moves.find(n=>n.x===x&&n.y===64&&n.z===z)
 assert.ok(at(1,0)&&at(-1,0),'both flat steps exist')
 assert.ok(at(1,0).cost-at(-1,0).cost>=LAVA_EDGE_COST,'the step beside the lava is priced above the one away from it')
 assert.ok(!moves.some(n=>n.x===2&&n.z===0&&n.y===64),'the lava cell itself stays refused')
 const clear=walker(p=>p.y<=63?'stone':'air').m.getNeighbors({x:0,y:64,z:0,remainingBlocks:0})
 assert.equal(clear.find(n=>n.x===1&&n.z===0&&n.y===64).cost,at(-1,0).cost,'no lava, no surcharge')
})

test('wading is shallow water over solid ground, never the surface of a deep pool',()=>{
 // Trial 24: the fill waded into a cave pool, the surface layer of a deep pool
 // counted as wadeable, the bot sank, and the air recovery found no shore:
 // an hour of surfacing and walking back under.
 const pool=p=>p.y<=60?'stone':(p.x>=4&&p.y<=63?'water':(p.y<=63&&p.x<4&&p.y===63?'water':(p.y<=62?'stone':'air')))
 // x<4: one layer of water at y=63 over stone (shallow); x>=4: water y=61..63 (deep)
 const bot={registry,inventory:{items:()=>[]},entity:{position:new Vec3(.5,64,.5),effects:[]},pathfinder:{bestHarvestTool:()=>null},
  blockAt:p=>Object.assign(Block.fromStateId(registry.blocksByName[pool(p)].defaultState,0),{position:p.clone()})}
 const wade=new DoorAwareMovements(bot,{shallowWaterOnly:true})
 assert.equal(wade.getBlock(new Vec3(1,63,0),0,0,0).safe,true,'a foot of water over stone')
 assert.equal(wade.getBlock(new Vec3(5,63,0),0,0,0).safe,false,'the surface of a deep pool')
 assert.equal(wade.getBlock(new Vec3(5,62,0),0,0,0).safe,false,'under the surface')
 assert.equal(new DoorAwareMovements(bot).getBlock(new Vec3(1,63,0),0,0,0).safe,false,'ordinary walks still avoid water')
})
