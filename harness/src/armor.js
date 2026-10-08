// Armour: the agent had died fourteen times in one session and taken four
// hundred hearts of damage while wearing nothing at all. Anything protective it
// carries or crafts is worn, best piece per slot, before it starts work.
import {inNether} from './dimension.js'
const SLOTS={helmet:'head',chestplate:'torso',leggings:'legs',boots:'feet'}
// Ordinary survival materials only. Chainmail is not craftable and turtle
// helmets need scute, but both are worn when found.
const RANK=['leather','golden','chainmail','iron','turtle','diamond','netherite']
const piece=name=>{
 const match=/^([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(name||'')
 if(!match)return null
 const rank=RANK.indexOf(match[1])
 return rank<0?null:{material:match[1],kind:match[2],slot:SLOTS[match[2]],rank}
}
export const armorPiece=piece
const remaining=item=>Number.isFinite(item?.maxDurability)?item.maxDurability-(item.durabilityUsed||0):Infinity
// A piece worth wearing: better material, or the same material with more life.
const better=(candidate,worn)=>{
 if(!candidate)return false
 if(!worn)return true
 return candidate.rank>worn.rank||candidate.rank===worn.rank&&candidate.remaining>worn.remaining
}
// In the Nether golden boots outrank everything in the feet slot: piglins
// attack anyone without a gold piece (nether-plan.md, step 6). Elsewhere the
// ordinary ranking puts iron back on.
export function armorUpgrades(bot){
 const items=bot?.inventory?.items?.()||[]
 const nether=inNether(bot),rank=p=>nether&&p.material==='golden'&&p.slot==='feet'?RANK.length:p.rank
 const equipped={}
 for(const slot of Object.values(SLOTS)){
  const index=bot.getEquipmentDestSlot?.(slot)
  const item=Number.isInteger(index)?bot.inventory?.slots?.[index]:null
  const p=piece(item?.name)
  if(p)equipped[slot]={...p,rank:rank(p),remaining:remaining(item),name:item.name}
 }
 const best={}
 for(const item of items){
  const p=piece(item.name);if(!p)continue
  const candidate={...p,rank:rank(p),remaining:remaining(item),item,name:item.name}
  if(better(candidate,best[p.slot])&&better(candidate,equipped[p.slot]))best[p.slot]=candidate
 }
 return Object.values(best).sort((a,b)=>a.slot.localeCompare(b.slot))
}
// Never interrupts a fight or a flight: the caller decides when this is cheap.
export async function wearBestArmor(bot,{check=()=>{},progress}={}){
 const worn=[]
 for(const upgrade of armorUpgrades(bot)){
  check()
  try{await bot.equip(upgrade.item,upgrade.slot);worn.push(upgrade.name)}catch{}
  check()
 }
 if(worn.length&&progress)progress(`Wearing ${worn.map(n=>n.replaceAll('_',' ')).join(', ')}`)
 return worn
}
