import test from 'node:test'
import assert from 'node:assert/strict'
import {prepareTools,expeditionNeeds,usableToolCount,stockTunnelPickaxes} from '../src/supplies.js'
import {validatePlan} from '../src/companion/planner.js'

test('preparation replaces worn tools without throwing them away or counting them as ready',async()=>{
 const items=[{name:'iron_pickaxe',count:1,maxDurability:250,durabilityUsed:140},{name:'iron_pickaxe',count:1,maxDurability:250,durabilityUsed:0}]
 const bot={registry:{itemsByName:{iron_pickaxe:{id:1}}},inventory:{items:()=>items}}
 let requested
 const receipt=await prepareTools(bot,{item:'iron_pickaxe',count:2},{check(){},progress(){},settle:async predicate=>assert.ok(predicate()),acquire:async(name,total)=>{requested=total;items.push({name,count:1,maxDurability:250,durabilityUsed:0})}})
 assert.equal(requested,3);assert.equal(receipt.crafted,1);assert.equal(receipt.count,2);assert.equal(items.length,3)
 await prepareTools(bot,{item:'iron_pickaxe',count:2},{check(){},progress(){},acquire:()=>assert.fail('Satisfied preparation must not craft again')})
 assert.equal(usableToolCount(items,'iron_pickaxe'),2)
})
test('expeditions ask for specific base resupply before equipment, storage or torches run out',()=>{
 const items=[{name:'stone_pickaxe',count:1,maxDurability:131,durabilityUsed:120}]
 const bot={inventory:{items:()=>items,emptySlotCount:()=>1}}
 assert.equal(expeditionNeeds(bot).length,3)
 items.push({name:'stone_pickaxe',count:1,maxDurability:131,durabilityUsed:0},{name:'torch',count:8})
 assert.deepEqual(expeditionNeeds(bot),['Stow excavation rubble at the base; fewer than two free inventory slots remain'])
 bot.inventory.emptySlotCount=()=>2;assert.deepEqual(expeditionNeeds(bot),[])
})
test('starter trips can obtain torch ingredients while still requiring usable tools and inventory space',()=>{
 const items=[{name:'wooden_pickaxe',count:1,maxDurability:59,durabilityUsed:0}]
 const bot={inventory:{items:()=>items,emptySlotCount:()=>3}}
 assert.deepEqual(expeditionNeeds(bot,{bootstrap:true}),[])
 assert.deepEqual(expeditionNeeds(bot),['Acquire torches for the next mining trip'])
 items[0].durabilityUsed=50;bot.inventory.emptySlotCount=()=>1
 assert.deepEqual(expeditionNeeds(bot,{bootstrap:true}),['Prepare a serviceable pickaxe before continuing','Stow excavation rubble at the base; fewer than two free inventory slots remain'])
})
test('all planners accept bounded preparation and base rubble storage',()=>{
 assert.equal(validatePlan({reply:'Preparing.',steps:[{action:'prepare',name:'',item:'iron_pickaxe',count:2},{action:'stow',name:'base',item:'',count:0}]}).steps.length,2)
 for(const item of ['diamond','command_block','some_pickaxe'])assert.throws(()=>validatePlan({reply:'Preparing.',steps:[{action:'prepare',item,count:1}]}))
 assert.throws(()=>validatePlan({reply:'Preparing.',steps:[{action:'prepare',item:'iron_pickaxe',count:5}]}))
})

test('runner skill dispatch reaches tool preparation and rejects unavailable items',async()=>{
 const {executeSkill}=await import('../src/skills.js')
 const bot={inventory:{items:()=>[]},registry:{itemsByName:{},blocksByName:{}},findBlocks:()=>[]}
 await assert.rejects(()=>executeSkill(bot,{kind:'prepare',goal:{item:'iron_pickaxe',count:2}},{check(){},progress(){},stage(){}}),/tool available/)
})

// Play-world run 3, 5 October: the iron, stone and wooden pickaxes reached their
// reserve at y 13 with no wood to make more, and the diamond one dug on. Family
// run 4, 6 October: the same, 312 diamond uses in ten minutes. A player makes
// pickaxes before the trip and packs sticks and a table to make more down there.
test('an obsidian trip short of plain pickaxes makes them first and packs the means to make more',async()=>{
 const kit=(extra=[])=>{
  const items=[{name:'iron_pickaxe',count:1,maxDurability:250,durabilityUsed:243},...extra],asked=[]
  const bot={registry:{itemsByName:{stone_pickaxe:{id:2}}},inventory:{items:()=>items}}
  const add=(name,n)=>{const slot=items.find(i=>i.name===name&&!i.maxDurability);slot?slot.count+=n:items.push({name,count:n})}
  const deps={check(){},progress(){},settle:async p=>assert.ok(p()),needed:64,plainUses:()=>0,
   acquire:async(name,total)=>{asked.push([name,total]);if(name==='stone_pickaxe')while(items.filter(i=>i.name===name).length<total)items.push({name,count:1,maxDurability:131,durabilityUsed:0});else add(name,total)}}
  return {bot,deps,asked,items}
 }
 const above=kit();assert.equal((await stockTunnelPickaxes(above.bot,{...above.deps,underRock:false})).stocked,3)
 assert.deepEqual(above.asked,[['stone_pickaxe',3],['stick',6],['crafting_table',1]])
 const enough=kit();assert.equal((await stockTunnelPickaxes(enough.bot,{...enough.deps,plainUses:()=>369,underRock:false})).stocked,0);assert.deepEqual(enough.asked,[])
 const bare=kit();assert.equal((await stockTunnelPickaxes(bare.bot,{...bare.deps,underRock:true})).stocked,0);assert.deepEqual(bare.asked,[],'under rock with nothing to make them from')
 const packed=kit([{name:'stick',count:4},{name:'cobblestone',count:64},{name:'crafting_table',count:1}])
 assert.equal((await stockTunnelPickaxes(packed.bot,{...packed.deps,underRock:true})).stocked,2);assert.deepEqual(packed.asked,[['stone_pickaxe',2]],'two sticks a pickaxe')
 const treeless=kit(),r=await stockTunnelPickaxes(treeless.bot,{...treeless.deps,underRock:false,acquire:async()=>{throw new Error('no trees in reach')}})
 assert.equal(r.stocked,0);assert.match(r.reason,/no trees/)
})
