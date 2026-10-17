import test from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import blockLoader from 'prismarine-block'
import {economicalTool,installEconomicalTools} from '../src/tool-choice.js'
const registry=minecraftData('1.21.4'),Block=blockLoader(registry)
const block=name=>Block.fromStateId(registry.blocksByName[name].minStateId,0)
const item=(name,used=0)=>({name,type:registry.itemsByName[name].id,maxDurability:registry.itemsByName[name].maxDurability,durabilityUsed:used,slot:36})
const bot=items=>({inventory:{items:()=>items},entity:{effects:{}},heldItem:null})
// Play world, 4 October: underground search legs tunnelled through stone
// with the diamond pickaxe until it broke.
test('plain stone gets the best plain pickaxe, never the diamond one, while one is carried',()=>{
 const kit=[item('diamond_pickaxe'),item('iron_pickaxe'),item('stone_pickaxe')]
 assert.equal(economicalTool(bot(kit),block('stone')).name,'iron_pickaxe')
 assert.equal(economicalTool(bot([item('diamond_pickaxe'),item('stone_pickaxe')]),block('deepslate')).name,'stone_pickaxe')
 assert.equal(economicalTool(bot([item('diamond_pickaxe')]),block('stone')).name,'diamond_pickaxe','the only pickaxe carried is still used')
 const worn=item('iron_pickaxe',250-5);assert.equal(economicalTool(bot([item('diamond_pickaxe'),worn]),block('stone')).name,'diamond_pickaxe','a plain pickaxe below the reserve is spared')
})
test('obsidian gets the diamond pickaxe; dirt with only pickaxes gets no tool',()=>{
 const kit=[item('diamond_pickaxe'),item('iron_pickaxe')]
 assert.equal(economicalTool(bot(kit),block('obsidian')).name,'diamond_pickaxe')
 assert.equal(economicalTool(bot(kit),block('dirt')),null)
 assert.equal(economicalTool(bot([...kit,item('iron_shovel')]),block('dirt')).name,'iron_shovel')
})
test('the pathfinder and the tool plugin both pick economically, and never hold a precious tool for dirt',async()=>{
 const kit=[item('diamond_pickaxe'),item('iron_pickaxe')],b=bot(kit),equipped=[]
 b.pathfinder={bestHarvestTool:()=>kit[0]};b.tool={equipForBlock:async()=>{equipped.push('original')}}
 b.equip=async i=>{equipped.push(i.name);b.heldItem=i};b.unequip=async()=>{equipped.push('unequip');b.heldItem=null}
 installEconomicalTools(b);installEconomicalTools(b)
 assert.equal(b.pathfinder.bestHarvestTool(block('stone')).name,'iron_pickaxe')
 assert.equal(b.pathfinder.bestHarvestTool(block('dirt')),null,'the original choice was the diamond pickaxe: refused')
 await b.tool.equipForBlock(block('stone'));assert.deepEqual(equipped,['iron_pickaxe'])
 b.heldItem=kit[0];await b.tool.equipForBlock(block('dirt'));assert.deepEqual(equipped,['iron_pickaxe','unequip'])
})
