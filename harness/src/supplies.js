// Preparation counts serviceable tools, not merely item slots. Worn tools stay
// in inventory and remain available for short jobs; nothing is discarded.
export const PREPARE_ACTIONS=['prepare']
export const toolName=name=>/^(wooden|stone|iron|golden|diamond|netherite)_(pickaxe|axe|shovel|hoe|sword)$/.test(name||'')
export const remainingDurability=item=>item.maxDurability?item.maxDurability-(item.durabilityUsed||0):Infinity
export const serviceable=item=>!!item.maxDurability&&remainingDurability(item)>=Math.max(32,Math.ceil(item.maxDurability/2))
export const usableToolCount=(items,name)=>items.filter(i=>i.name===name&&serviceable(i)).reduce((n,i)=>n+i.count,0)
export async function prepareTools(bot,goal,{acquire,settle,check,progress}){
 const {item,count}=goal
 if(!toolName(item)||!bot.registry.itemsByName[item])throw new Error('Prepare requires a tool available in this Minecraft version')
 const items=()=>bot.inventory.items()
 const before=usableToolCount(items(),item),missing=Math.max(0,count-before)
 if(missing){
  const all=items().filter(i=>i.name===item).reduce((n,i)=>n+i.count,0)
  progress(`Preparing ${count} serviceable ${item}; crafting ${missing} replacement or spare tools`)
  await acquire(item,all+missing);check()
  await settle(()=>usableToolCount(items(),item)>=count,'Prepared tools were not confirmed with sufficient durability')
 }
 return {item,count:usableToolCount(items(),item),crafted:missing,minimumRemaining:'at least half maximum durability and 32 uses',tools:items().filter(i=>i.name===item).map(i=>({remaining:remainingDurability(i),maximum:i.maxDurability})),receipt:'serviceable_tools_verified'}
}

export function expeditionNeeds(bot,{bootstrap=false}={}){
 const items=bot.inventory.items(),needs=[]
 if(!items.some(i=>/_pickaxe$/.test(i.name)&&remainingDurability(i)>=16))needs.push('Prepare a serviceable pickaxe before continuing')
 if(typeof bot.inventory.emptySlotCount==='function'&&bot.inventory.emptySlotCount()<2)needs.push('Stow excavation rubble at the base; fewer than two free inventory slots remain')
 if(!bootstrap&&items.filter(i=>i.name==='torch').reduce((n,i)=>n+i.count,0)<1)needs.push('Acquire torches for the next mining trip')
 return needs
}
