import {setTimeout as delay} from 'node:timers/promises'
// Mineflayer 4.38 uses one container state ID for every window. Servers may
// update the player's offhand (window 0) while a crafting table is open. Using
// that revision for the table forces resyncs during optimistic recipe clicks.
// Keep this adapter until the pinned Mineflayer tracks revisions per window
// and serializes recipe clicks against the correct server update.
export async function craftWithWindowState(bot, recipe, count, table, check=()=>{}) {
 return withWindowState(bot,()=>bot.craft(recipe,count,table),check)
}
export async function withWindowState(bot, action, check=()=>{}) {
 if(!bot.supportFeature?.('stateIdUsed'))return action()
 const client=bot._client,states=new Map(),updates=new Map(),write=client.write,click=bot.clickWindow
 const onPacket=(packet,meta)=>{
  if(['set_slot','window_items'].includes(meta.name)&&Number.isInteger(packet.windowId)&&Number.isInteger(packet.stateId)){states.set(packet.windowId,packet.stateId);updates.set(packet.windowId,Date.now())}
 }
 const send=function(name,packet,...rest){
  if(name==='window_click') {
   // Vanilla acknowledges a correct predicted click with silence (seen on 26.2
   // through the bridge and on a native 1.21.4 dedicated server, 17 September).
   // Sending an unknown revision requests a full authoritative state instead. The server applies the click once, then synchronizes
   // all slots and cursor. Never retry a consuming click to obtain an ack.
   if(bot.soulstoneInventoryResync)packet={...packet,stateId:-1}
   else if(states.has(packet.windowId))packet={...packet,stateId:states.get(packet.windowId)}
  }
  return write.call(this,name,packet,...rest)
 }
 const clickSettled=async function(...args){
  check()
  // The player's 2x2 crafting grid is window 0, even when no container is open.
  const window=bot.currentWindow||bot.inventory
  if(!window)return click.apply(this,args)
  // Source-slot clicks also generate crafting-result updates. The plugin
  // otherwise lets those satisfy the next ingredient click's acknowledgement.
  // A bounded 100ms quiet period after a server update is a stabilization
  // heuristic, not a protocol transaction ID acknowledgment. Final inventory
  // verification remains mandatory; no consuming craft is retried here.
  updates.delete(window.id)
  const result=await click.apply(this,args);check()
  const deadline=Date.now()+3000
  while(Date.now()<deadline){
   check()
   const last=updates.get(window.id)
   if(last&&Date.now()-last>=100)return result
   await delay(20)
  }
  throw new Error('Inventory window did not settle after a click')
 }
 client.on('packet',onPacket);client.write=send;bot.clickWindow=clickSettled
 try{return await action()}
 finally{client.off('packet',onPacket);if(client.write===send)client.write=write;if(bot.clickWindow===clickSettled)bot.clickWindow=click}
}
