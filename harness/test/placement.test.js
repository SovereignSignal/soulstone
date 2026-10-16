import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {interactable,plainFirst,sneakAgainstInteractables} from '../src/placement.js'

// Lab run 163, 15 October: the Nether hut's last wall cell had a dropper as its only
// solid neighbour. Vanilla opens a block with a use on right-click unless the player
// sneaks, so the placement opened the dropper and the hut failed one block short.
const block=(name,x=0,y=63,z=0)=>({name,position:new Vec3(x,y,z),boundingBox:'block'})
function sneaky(place=async()=>{}){
 const log=[],controls={sneak:false}
 const bot={log,controls,
  setControlState(c,s){if(controls[c]===s)return;controls[c]=s;log.push([c,s])},
  getControlState:c=>controls[c],
  async waitForTicks(){log.push(['tick'])},
  async placeBlock(ref,face){log.push(['place',ref.name,controls.sneak]);return place(ref,face)},
  async _placeBlockWithOptions(ref,face,options){log.push(['placeWithOptions',ref.name,controls.sneak,options?.forceLook])}}
 sneakAgainstInteractables(bot)
 return bot
}

test('blocks with a use on right-click are interactable; plain cubes are not',()=>{
 for(const name of ['dropper','dispenser','hopper','chest','trapped_chest','barrel','furnace','blast_furnace','smoker','crafting_table','anvil','chipped_anvil','oak_door','iron_trapdoor','stone_button','lever','red_bed','oak_fence_gate','note_block','red_shulker_box','shulker_box','oak_sign','enchanting_table','beacon','lectern'])
  assert.equal(interactable(block(name)),true,name)
 for(const name of ['stone','cobblestone','netherrack','oak_planks','oak_log','dirt','obsidian','bookshelf','redstone_block'])
  assert.equal(interactable(block(name)),false,name)
 assert.equal(interactable(null),false)
})

test('plain neighbours come first, the interactable ones last, each in its own order',()=>{
 const d=block('dropper',1),s=block('stone',2),c=block('chest',3),n=block('netherrack',4)
 assert.deepEqual(plainFirst([d,s,c,n]).map(b=>b.name),['stone','netherrack','dropper','chest'])
})

test('a placement against a dropper is made sneaking, and the sneak is released after',async()=>{
 const bot=sneaky()
 await bot.placeBlock(block('dropper'),new Vec3(0,1,0))
 assert.deepEqual(bot.log,[['sneak',true],['tick'],['place','dropper',true],['sneak',false]])
 assert.equal(bot.controls.sneak,false)
 // The oriented placements (stairs, doors) go through the lower call; they sneak too.
 bot.log.length=0
 await bot._placeBlockWithOptions(block('chest'),new Vec3(0,1,0),{forceLook:'ignore'})
 assert.deepEqual(bot.log,[['sneak',true],['tick'],['placeWithOptions','chest',true,'ignore'],['sneak',false]])
 // Against stone the sneak is never touched.
 bot.log.length=0
 await bot.placeBlock(block('stone'),new Vec3(0,1,0))
 assert.deepEqual(bot.log,[['place','stone',false]])
})

test('a refused placement against a dropper was made sneaking and still releases the sneak',async()=>{
 const bot=sneaky(async()=>{throw new Error('No block has been placed : the block is still air')})
 await assert.rejects(bot.placeBlock(block('dropper'),new Vec3(0,1,0)),/No block has been placed/)
 assert.deepEqual(bot.log,[['sneak',true],['tick'],['place','dropper',true],['sneak',false]])
 assert.equal(bot.controls.sneak,false)
})

test('installing twice wraps once, and a sneak the caller already holds is left to the caller',async()=>{
 const bot=sneaky();sneakAgainstInteractables(bot)
 await bot.placeBlock(block('dropper'),new Vec3(0,1,0))
 assert.deepEqual(bot.log,[['sneak',true],['tick'],['place','dropper',true],['sneak',false]])
 bot.setControlState('sneak',true);bot.log.length=0
 await bot.placeBlock(block('crafting_table'),new Vec3(0,1,0))
 assert.deepEqual(bot.log,[['place','crafting_table',true]])
 assert.equal(bot.controls.sneak,true)
})
