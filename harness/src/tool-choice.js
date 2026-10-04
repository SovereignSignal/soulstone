// Which tool breaks a block. The pathfinder, mineflayer-tool and the
// expedition each picked the fastest tool, which is the diamond pickaxe. On
// 4 October in the family world the bot's underground search legs tunnelled
// through plain stone with it until it wore out, its most valuable tool
// spent on blocks an iron or stone pickaxe breaks perfectly well.
// The economical choice: the fastest helpful tool that is not diamond or
// netherite and keeps a durability reserve; a precious tool only when nothing
// else can harvest the block (obsidian, ancient debris) or nothing else is
// carried. null means no tool helps (dirt by pickaxe): dig empty-handed or
// with whatever plain item is held, never with a precious tool.
import {remainingDurability} from './supplies.js'
export const PRECIOUS=/^(diamond|netherite)_/
export const TOOL_RESERVE=8
function time(bot,block,type){
 try{return block.digTime(type,false,false,false,[],bot.entity?.effects||{})}catch{return Infinity}
}
export function economicalTool(bot,block){
 if(!block||typeof block.digTime!=='function')return null
 const harvest=block.harvestTools?Object.keys(block.harvestTools).map(Number):null
 const hand=time(bot,block,null)
 const useful=(bot.inventory?.items?.()||[]).filter(i=>Number.isFinite(i.maxDurability)&&remainingDurability(i)>=TOOL_RESERVE&&(!harvest||harvest.includes(i.type))&&(harvest&&!harvest.includes(null)?true:time(bot,block,i.type)<hand))
 if(!useful.length)return null
 const plain=useful.filter(i=>!PRECIOUS.test(i.name))
 return (plain.length?plain:useful).sort((a,b)=>time(bot,block,a.type)-time(bot,block,b.type)||remainingDurability(b)-remainingDurability(a))[0]
}
// Put the economical choice behind every way the bot picks a tool to dig.
export function installEconomicalTools(bot){
 const pf=bot.pathfinder
 if(pf&&typeof pf.bestHarvestTool==='function'&&!pf.bestHarvestTool.economical){
  const original=pf.bestHarvestTool.bind(pf)
  const pick=block=>{const t=economicalTool(bot,block);if(t)return t;const o=original(block);return o&&PRECIOUS.test(o.name)?null:o}
  pick.economical=true;pf.bestHarvestTool=pick
 }
 const tool=bot.tool
 if(tool&&typeof tool.equipForBlock==='function'&&!tool.equipForBlock.economical){
  const original=tool.equipForBlock.bind(tool)
  const equip=async(block,options={})=>{
   const t=economicalTool(bot,block)
   if(t){if(bot.heldItem?.slot!==t.slot)await bot.equip(t,'hand');return}
   const harvest=block?.harvestTools&&Object.keys(block.harvestTools).length
   if(!harvest){if(bot.heldItem&&PRECIOUS.test(bot.heldItem.name))await bot.unequip('hand').catch(()=>{});return}
   return original(block,options)
  }
  equip.economical=true;tool.equipForBlock=equip
 }
}
