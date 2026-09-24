import test from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import blockLoader from 'prismarine-block'
import {correctToolTierMaterials} from '../src/tool-tiers.js'

// Lab, 2026-09-24: make_obsidian took 76 s per obsidian with a diamond pickaxe.
// minecraft-data 3.116 gives 93 pickaxe blocks (the ores, obsidian, metal
// blocks) the tier tag incorrect_for_wooden_tool as their material, which has
// no tool speeds, so every dig of them was timed at hand speed.
test('ores and obsidian dig at the carried pickaxe speed, not hand speed',()=>{
 const registry=minecraftData('1.21.4'),Block=blockLoader(registry)
 const time=(block,tool)=>Block.fromStateId(registry.blocksByName[block].defaultState,0).digTime(registry.itemsByName[tool].id,false,false,false,[],{})
 assert.equal(time('obsidian','diamond_pickaxe'),75000,'the defect, before correction')
 const fixed=correctToolTierMaterials(registry)
 assert.ok(fixed>=90,`corrected ${fixed} blocks`)
 assert.ok(time('obsidian','diamond_pickaxe')<10000,'a diamond pickaxe breaks obsidian in about 9.4 s')
 assert.ok(time('iron_ore','stone_pickaxe')<1300,'a stone pickaxe breaks iron ore in about 1.15 s')
 assert.ok(time('deepslate_diamond_ore','iron_pickaxe')<1300)
 assert.deepEqual(Object.keys(registry.blocksByName.obsidian.harvestTools).map(id=>registry.items[id].name).sort(),['diamond_pickaxe','netherite_pickaxe'],'which tools can harvest is unchanged')
 assert.equal(registry.blocksByName.crafter.material,'incorrect_for_wooden_tool','a block without pickaxe harvest tools is left alone')
 assert.equal(correctToolTierMaterials(registry),0,'idempotent')
})
