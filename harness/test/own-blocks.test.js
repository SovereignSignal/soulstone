import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Vec3} from 'vec3'
import {OwnBlocks,trackOwnPlacements,breakable} from '../src/natural.js'
import {refuseDigCell} from '../src/primitives.js'

// Run 76, 8 October: in the Nether the bot stood on a pillar of its own
// cobblestone four blocks above the portal, and the dig action refused it as
// "not natural ground": stranded by the rule that protects players' builds.
// Cells the bot itself filled are its own to clear; anything a player built
// never passed through the bot's placeBlock, so it stays refused.
test('cells the bot filled itself are breakable; the same block elsewhere is not',async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'mc-own-')),'own-blocks.json')
 const own=new OwnBlocks(path),world=new Map()
 const bot={blockAt:p=>({name:world.get(`${p.x},${p.y},${p.z}`)??'air',position:p.clone(),boundingBox:world.has(`${p.x},${p.y},${p.z}`)?'block':'empty',diggable:true}),
  async placeBlock(ref,face){const p=ref.position.plus(face);world.set(`${p.x},${p.y},${p.z}`,'cobblestone')},entity:{position:new Vec3(0.5,70,0.5)}}
 trackOwnPlacements(bot,own)
 await bot.placeBlock({position:new Vec3(5,69,5)},new Vec3(0,1,0))
 world.set('8,70,8','cobblestone')
 assert.equal(breakable(bot,bot.blockAt(new Vec3(5,70,5))),true,'its own block')
 assert.equal(breakable(bot,bot.blockAt(new Vec3(8,70,8))),false,'somebody else\'s cobblestone')
 assert.equal(refuseDigCell(bot,new Vec3(5,70,5)),null,'the dig action takes its own block')
 assert.match(refuseDigCell(bot,new Vec3(8,70,8)),/not natural ground/)
 assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),[['overworld|5,70,5','cobblestone']],'remembered across restarts')
 assert.equal(new OwnBlocks(path).has(new Vec3(5,70,5),'cobblestone','overworld'),true)
})

// Review of 2695c14: the record must not reach past the bot's own block.
test('an own cell counts only in its dimension, only while it holds the block placed, and only if one landed',async()=>{
 const own=new OwnBlocks(null),world=new Map()
 const mk=dim=>({game:{dimension:`minecraft:${dim}`},blockAt:p=>({name:world.get(`${p.x},${p.y},${p.z}`)??'air',position:p.clone(),boundingBox:world.has(`${p.x},${p.y},${p.z}`)?'block':'empty',diggable:true}),
  async placeBlock(ref,face){const p=ref.position.plus(face);if(p.x===9)throw new Error('timed out');world.set(`${p.x},${p.y},${p.z}`,'cobblestone')},entity:{position:new Vec3(0.5,70,0.5)}})
 const nether=mk('the_nether');trackOwnPlacements(nether,own)
 await nether.placeBlock({position:new Vec3(5,69,5)},new Vec3(0,1,0))
 assert.equal(breakable(nether,nether.blockAt(new Vec3(5,70,5))),true)
 const overworld=mk('overworld');trackOwnPlacements(overworld,own)
 assert.equal(breakable(overworld,overworld.blockAt(new Vec3(5,70,5))),false,'the same cell in the Overworld is not its own')
 world.set('5,70,5','oak_planks')
 assert.equal(breakable(nether,nether.blockAt(new Vec3(5,70,5))),false,'replaced by something else: no longer its own')
 await nether.placeBlock({position:new Vec3(9,69,5)},new Vec3(0,1,0)).catch(()=>{})
 world.set('9,70,5','cobblestone')
 assert.equal(breakable(nether,nether.blockAt(new Vec3(9,70,5))),false,'a placement that failed and landed nothing is not recorded')
})
