import assert from 'node:assert/strict'
// Read each exact server slot. A list selector is invalid for `data get` when
// more than one matching tool exists, so it cannot verify a spare-tool goal.
export async function serverTools(rcon,player,items,name){
 assert.match(player,/^[A-Za-z0-9_]{1,16}$/);assert.match(name,/^[a-z0-9_]+$/)
 const tools=[]
 for(const item of items.filter(i=>i.name===name)){
  assert.ok(Number.isInteger(item.slot)&&item.slot>=9&&item.slot<=44,'Unsupported tool inventory slot')
  const slot=item.slot>=36?item.slot-36:item.slot,selector=`Inventory[{Slot:${slot}b}]`
  const id=await rcon(`data get entity ${player} ${selector}.id`);assert.ok(id.endsWith(`"minecraft:${name}"`),id)
  const damageReply=await rcon(`data get entity ${player} ${selector}.components."minecraft:damage"`)
  const match=damageReply.match(/entity data: (\d+)$/)
  assert.ok(match||/^Found no elements matching/.test(damageReply),'Unrecognized tool damage response: '+damageReply)
  const damage=match?Number(match[1]):0
  tools.push({slot,name,maximum:item.maxDurability,damage,remaining:item.maxDurability-damage,reads:[id,damageReply]})
 }
 return tools
}
