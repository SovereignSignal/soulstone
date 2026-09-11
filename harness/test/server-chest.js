import assert from 'node:assert/strict'
// Full `data get ... Items` output is truncated by the server. Query each field
// separately so an unchanged prefix cannot masquerade as inventory equality.
export async function serverChest(rcon,p) {
 const contents={},reads=[],at=`${p.x} ${p.y} ${p.z}`
 for(let index=0;index<27;index++){
  const id=await rcon(`data get block ${at} Items[${index}].id`);reads.push(id)
  if(id===`Found no elements matching Items[${index}]`)break
  const name=id.match(/"minecraft:([a-z0-9_]+)"$/)?.[1];assert.ok(name,'Unrecognized server item ID response')
  const amount=await rcon(`data get block ${at} Items[${index}].count`);reads.push(amount)
  const count=Number(amount.match(/block data: (\d+)$/)?.[1]);assert.ok(count>0&&count<=64,'Unrecognized server stack count')
  contents[name]=(contents[name]||0)+count
 }
 return {contents,reads}
}
