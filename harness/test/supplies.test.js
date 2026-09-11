import test from 'node:test'
import assert from 'node:assert/strict'
import {prepareTools,expeditionNeeds,usableToolCount} from '../src/supplies.js'
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
