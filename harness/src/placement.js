// Placing against a block that has a use. In vanilla a right-click on a chest,
// furnace, dropper, door, bed, button and the like opens or toggles it instead
// of placing against it, unless the player is sneaking. Lab run 163, 15 October:
// in the Nether the hut's last wall cell had a dropper as its only solid
// neighbour, the click opened it, and the hut ended one block short. A family
// base is full of chests and furnaces, so every placement path is exposed.
// Skills choose a plain neighbour first (plainFirst); when the only reference has
// a use, every placeBlock sneaks for that click (sneakAgainstInteractables).

// Blocks whose right-click does something other than take the placement: a
// window (containers, stations), a toggle (doors, levers, note blocks), a state
// change (beds, cake, the respawn anchor), or an insert (lectern, chiseled
// bookshelf, decorated pot, jukebox). minecraft-data carries no such flag, so
// the set is kept here; the families that come in many woods, metals and
// colours are matched by INTERACTABLE_FAMILY.
export const INTERACTABLE=new Set([
 'chest','trapped_chest','ender_chest','barrel','dispenser','dropper','hopper','crafter',
 'furnace','blast_furnace','smoker','brewing_stand','beacon',
 'crafting_table','enchanting_table','grindstone','stonecutter','loom','cartography_table','smithing_table',
 'lectern','chiseled_bookshelf','decorated_pot','jukebox','note_block','bell',
 'lever','repeater','comparator','daylight_detector',
 'cake','respawn_anchor','dragon_egg','command_block','chain_command_block','repeating_command_block','structure_block','jigsaw',
])
const INTERACTABLE_FAMILY=/(?:shulker_box|_door|_trapdoor|_fence_gate|_button|_bed|_sign|anvil|candle_cake)$/
export const interactable=block=>!!block?.name&&(INTERACTABLE.has(block.name)||INTERACTABLE_FAMILY.test(block.name))
// Candidate references with the plain ones first; each group keeps its order.
export const plainFirst=blocks=>[...blocks.filter(b=>!interactable(b)),...blocks.filter(interactable)]

export function setPlacementSneaking(bot,enabled) {
 bot.setControlState('sneak',enabled)
 // Mineflayer 4.38 sends only player_input on 1.21.3–1.21.5, although
 // these protocols still carry numeric start/stop sneak entity actions.
 // Remove this supplement when the pinned upstream implementation is fixed.
 if(bot.supportFeature?.('newPlayerInputPacket')&&!bot.supportFeature('entityActionUsesStringMapper'))bot._client.write('entity_action',{entityId:bot.entity.id,actionId:enabled?0:1,jumpBoost:0})
}

// The server judges the click by the player's shift state, which mineflayer's
// placeBlock does not send ("TODO: tell the server that we are sneaking" in
// generic_place.js); setControlState('sneak') sends it (entity_action, or
// player_input on 1.21.6+) before the use-item-on packet goes out. One tick
// between them, as the floor torch on a workstation already waits. Wraps both
// placeBlock (the skills, the pathfinder) and _placeBlockWithOptions (oriented
// build pieces); mineflayer's placeBlock calls its own inner function, so a
// placement is never wrapped twice. A sneak the caller already holds is its own.
export function sneakAgainstInteractables(bot) {
 if(bot._sneakAgainstInteractables)return
 bot._sneakAgainstInteractables=true
 for(const name of ['placeBlock','_placeBlockWithOptions']){
  if(typeof bot[name]!=='function')continue
  const place=bot[name].bind(bot)
  bot[name]=async(ref,...rest)=>{
   if(!interactable(ref)||bot.getControlState?.('sneak'))return place(ref,...rest)
   setPlacementSneaking(bot,true)
   try{await bot.waitForTicks?.(1);return await place(ref,...rest)}finally{setPlacementSneaking(bot,false)}
  }
 }
}
