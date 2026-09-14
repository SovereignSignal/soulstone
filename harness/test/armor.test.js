import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import minecraftData from 'minecraft-data'
import {armorPiece,armorUpgrades,wearBestArmor} from '../src/armor.js'
const registry=minecraftData('1.21.4')
const item=(name,used=0)=>({name,count:1,maxDurability:registry.itemsByName[name]?.maxDurability,durabilityUsed:used})
function bot(carried=[],equipped={}){
 const slotIndex={head:5,torso:6,legs:7,feet:8}
 const slots=[]
 for(const [slot,v] of Object.entries(equipped)){const [name,used=0]=Array.isArray(v)?v:[v,0];slots[slotIndex[slot]]=item(name,used)}
 return {inventory:{items:()=>carried,slots},getEquipmentDestSlot:s=>slotIndex[s],equipped:[],
  async equip(it,slot){this.equipped.push([it.name,slot]);slots[slotIndex[slot]]=it}}
}
test('armour pieces are recognised by material and slot, and nothing else is',()=>{
 assert.deepEqual(armorPiece('iron_chestplate'),{material:'iron',kind:'chestplate',slot:'torso',rank:3})
 assert.equal(armorPiece('iron_pickaxe'),null)
 assert.equal(armorPiece('carved_pumpkin'),null)
 assert.equal(armorPiece(undefined),null)
 for(const name of ['leather_boots','diamond_helmet','netherite_leggings','turtle_helmet'])assert.ok(armorPiece(name),name)
})
test('the best carried piece per slot is chosen, better material first and more life as the tie-break',()=>{
 const b=bot([item('leather_helmet'),item('iron_helmet'),item('iron_boots'),item('wooden_pickaxe')])
 const picks=armorUpgrades(b)
 assert.deepEqual(picks.map(p=>[p.slot,p.name]),[['feet','iron_boots'],['head','iron_helmet']])
 const worn=bot([item('iron_helmet',200)],{head:'iron_helmet'})
 assert.deepEqual(armorUpgrades(worn),[],'an equal, more worn spare is not an upgrade')
 const fresher=bot([item('iron_helmet',0)],{head:['iron_helmet',150]})
 assert.equal(armorUpgrades(fresher).length,1,'a fresher piece of the same material is')
 const downgrade=bot([item('leather_chestplate')],{torso:'iron_chestplate'})
 assert.deepEqual(armorUpgrades(downgrade),[],'never swap iron for leather')
})
test('wearing equips every upgrade, reports it, and survives a refused equip',async()=>{
 const b=bot([item('iron_helmet'),item('leather_boots')])
 const said=[]
 const worn=await wearBestArmor(b,{progress:m=>said.push(m)})
 assert.deepEqual(worn.sort(),['iron_helmet','leather_boots'])
 assert.deepEqual(b.equipped.map(e=>e[1]).sort(),['feet','head'])
 assert.match(said[0],/Wearing/)
 const broken=bot([item('iron_helmet')]);broken.equip=async()=>{throw new Error('server refused')}
 assert.deepEqual(await wearBestArmor(broken,{}),[],'a refused equip is not a crash')
 assert.deepEqual(await wearBestArmor(bot([]),{}),[])
})

test('the runner wears armour before ordinary work and never before a fight or a flight',()=>{
 const source=readFileSync(new URL('../src/runner.js',import.meta.url),'utf8')
 assert.match(source,/wearBestArmor\(bot,\{check/,'armour is worn on the skill path')
 const guard=source.match(/if\(!\[([^\]]*)\]\.includes\(task\.kind\)\)\{\s*try\{const worn=await wearBestArmor/)
 assert.ok(guard,'the skip list guards it')
 for(const kind of ['defend','flee','surface','climb'])assert.match(guard[1],new RegExp(`'${kind}'`),`${kind} is skipped`)
})

test('the capabilities brief tells the planner to acquire armour, since wearing it is automatic but getting it is not',()=>{
 const brief=readFileSync(new URL('../src/companion/survival-capabilities.txt',import.meta.url),'utf8')
 assert.match(brief,/ARMOUR AND SHIELD/)
 assert.match(brief,/It never acquires them on its own, so plan for them/)
 assert.match(brief,/hunt leather from cows/)
 assert.match(brief,/A shield is six planks and one iron ingot/)
})

test('the brief tells the planner to bank what it earns, since death drops everything',()=>{
 const brief=readFileSync(new URL('../src/companion/survival-capabilities.txt',import.meta.url),'utf8')
 assert.match(brief,/KEEPING WHAT YOU EARN/)
 assert.match(brief,/A base chest is death insurance/)
 assert.match(brief,/deposit spare tools, ores, food and torches before any risky trip/)
})
