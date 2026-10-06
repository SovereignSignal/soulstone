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

// A tunnelled trip spends a pickaxe use per block, and only plain pickaxes
// should pay for it (tool-choice.js keeps diamond for what needs it). Family
// runs 3 and 4 (5 and 6 October): the plain pickaxes reached their reserve
// deep under rock with no wood to make more, and the diamond one did the
// digging, 312 uses in ten minutes. A player makes pickaxes before the trip
// and packs sticks and a table to make more at the rock face, where
// cobblestone is never short. Failures here are notes, never the end of a job.
export const TUNNEL_PICKAXES=3,SPARE_STICKS=6
export async function stockTunnelPickaxes(bot,{plainUses,needed,underRock,acquire,settle,check,progress}){
 const have=plainUses()
 if(have>=needed)return {stocked:0}
 const carried=name=>bot.inventory.items().filter(i=>i.name===name).reduce((n,i)=>n+i.count,0)
 let count=TUNNEL_PICKAXES
 if(underRock){
  // Under rock only what is carried makes more: two sticks and three
  // cobblestone a pickaxe, and a table carried or already standing near.
  const table=carried('crafting_table')>0||!!bot.findBlock?.({matching:bot.registry.blocksByName?.crafting_table?.id,maxDistance:32})
  const makeable=table?Math.min(Math.floor(carried('stick')/2),Math.floor(carried('cobblestone')/3)):0
  if(!makeable){progress(`Plain pickaxes have ${have} uses left and nothing carried to make more (a table, two sticks and three cobblestone each)`);return {stocked:0,reason:'under rock'}}
  count=Math.min(TUNNEL_PICKAXES,usableToolCount(bot.inventory.items(),'stone_pickaxe')+makeable)
 }
 progress(`Plain pickaxes have ${have} uses left; making stone pickaxes before tunnelling`)
 let stocked=0
 try{stocked=(await prepareTools(bot,{item:'stone_pickaxe',count},{acquire,settle,check,progress})).crafted}
 catch(error){check();progress(`Could not make stone pickaxes: ${error.message}`);return {stocked:0,reason:error.message}}
 if(!underRock){
  try{await acquire('stick',SPARE_STICKS);await acquire('crafting_table',1)}
  catch(error){check();progress(`Could not pack sticks and a table for more pickaxes: ${error.message}`)}
 }
 return {stocked}
}

export function expeditionNeeds(bot,{bootstrap=false}={}){
 const items=bot.inventory.items(),needs=[]
 if(!items.some(i=>/_pickaxe$/.test(i.name)&&remainingDurability(i)>=16))needs.push('Prepare a serviceable pickaxe before continuing')
 if(typeof bot.inventory.emptySlotCount==='function'&&bot.inventory.emptySlotCount()<2)needs.push('Stow excavation rubble at the base; fewer than two free inventory slots remain')
 if(!bootstrap&&items.filter(i=>i.name==='torch').reduce((n,i)=>n+i.count,0)<1)needs.push('Acquire torches for the next mining trip')
 return needs
}
