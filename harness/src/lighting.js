// Modern Java light arrays contain packed byte nibbles, not big-endian longs.
// The pinned chunk reader decodes the latter and returns the wrong cell light.
// Raw snapshots are for independent verification: clients may not receive new
// light arrays after block updates, so these values can become stale.
const word=v=>typeof v==='bigint'?v:Array.isArray(v)?(BigInt(v[0]>>>0)<<32n)|BigInt(v[1]>>>0):BigInt(v||0)
const bit=(mask,i)=>!!(word(mask?.[i>>6])&(1n<<BigInt(i&63)))
export function applyBlockLight(sections,packet,minY=-64,height=384) {
 const x=packet.chunkX??packet.x,z=packet.chunkZ??packet.z
 if(!Number.isInteger(x)||!Number.isInteger(z)||!Array.isArray(packet.blockLight)||!Array.isArray(packet.blockLightMask))return
 let index=0
 for(let s=0;s<(height>>4)+2;s++){
  const key=`${x},${z},${s}`
  if(bit(packet.blockLightMask,s)){
   const raw=packet.blockLight[index++];if(raw?.length===2048)sections.set(key,Uint8Array.from(raw));else sections.delete(key)
  }else if(bit(packet.emptyBlockLightMask,s))sections.set(key,new Uint8Array(2048))
 }
}
export function observedBlockLight(sections,p,minY=-64) {
 const x=Math.floor(p.x),y=Math.floor(p.y),z=Math.floor(p.z),section=Math.floor((y-minY)/16)+1
 const raw=sections.get(`${Math.floor(x/16)},${Math.floor(z/16)},${section}`)
 if(!raw)return null
 const index=((y&15)<<8)|((z&15)<<4)|(x&15)
 return (raw[index>>1]>>((index&1)*4))&15
}
export function installLightReader(bot) {
 const sections=new Map(),read=p=>applyBlockLight(sections,p,bot.game?.minY??-64,bot.game?.height??384)
 bot._client.on('map_chunk',read);bot._client.on('update_light',read)
 bot._client.on('respawn',()=>sections.clear())
 bot._client.on('unload_chunk',p=>{const prefix=`${p.chunkX},${p.chunkZ},`;for(const k of sections.keys())if(k.startsWith(prefix))sections.delete(k)})
 bot.getObservedBlockLight=p=>observedBlockLight(sections,p,bot.game?.minY??-64)
}

// Conservative lower bound for this small, air-filled shelter only. Treat all
// unknown/non-air cells as opaque, ignore other sources and skylight, and never
// label this calculation as measured light. The lab checks it against a fresh
// independent server chunk snapshot after construction.
export function shelterLightBounds(bot,source,cells) {
 const allowed=new Map(cells.map(p=>[p.toString(),p])),levels=new Map()
 const emission=bot.registry.blocksByName.torch?.emitLight
 if(!['torch','wall_torch'].includes(bot.blockAt(source)?.name)||!Number.isInteger(emission))throw new Error('Torch light source not confirmed')
 const queue=[source];levels.set(source.toString(),emission)
 for(let i=0;i<queue.length;i++){
  const p=queue[i],next=levels.get(p.toString())-1;if(next<=0)continue
  for(const [x,y,z] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]){
   const q=p.offset(x,y,z),key=q.toString()
   if(!allowed.has(key)||levels.has(key)||!['air','cave_air','torch','wall_torch'].includes(bot.blockAt(q)?.name))continue
   levels.set(key,next);queue.push(q)
  }
 }
 return cells.map(position=>({position,lowerBound:levels.get(position.toString())||0,method:'observed_blocks_air_path_lower_bound'}))
}
