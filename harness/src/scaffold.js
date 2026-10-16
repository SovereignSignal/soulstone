import {fullCube} from './construction.js'
import {claimPlaced} from './natural.js'
import {plainFirst,holdToPlace} from './placement.js'

const falling = new Set(['sand','red_sand','gravel','suspicious_sand','suspicious_gravel'])
// Automatic movement must preserve portal material for explicit construction.
export const scaffoldItems = bot => bot.inventory.items().filter(i =>
  i.name !== 'obsidian' && !falling.has(i.name) && fullCube(bot.registry,i.name))

const LIQUID=new Set(['water','lava','flowing_water','flowing_lava','bubble_column'])
const SIDES=[[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0],[0,-1,0]]
export const solidCube=(bot,b)=>!!b&&fullCube(bot.registry,b.name)&&!LIQUID.has(b.name)
const key=p=>`${p.x},${p.y},${p.z}`
// Close one air cell with a carried cube, placed against any solid neighbour,
// and judge it by the block being there (the burrow's cap rule: the block
// update can be missed through the version bridge). Plain neighbours come
// before ones with a use (placement.js). False when nothing is carried or no
// neighbour stands. The caller may name the cube to use.
export async function fillCell(bot,cell,{check,progress=()=>{},item=scaffoldItems(bot)[0]}){
 if(!item)return false
 const closed=()=>solidCube(bot,bot.blockAt(cell))
 for(const ref of plainFirst(SIDES.map(([dx,dy,dz])=>bot.blockAt(cell.offset(dx,dy,dz))).filter(b=>solidCube(bot,b)))){
  if(closed())break
  try{await holdToPlace(bot,item.name,check);await bot.placeBlock(ref,cell.minus(ref.position))}catch(error){check();progress(`Placement at ${key(cell)} unconfirmed: ${error.message.slice(0,60)}`)}
  check()
  const end=Date.now()+1500;while(Date.now()<end&&!closed()){check();await new Promise(r=>setTimeout(r,50))}
 }
 if(!closed())return false
 claimPlaced(bot,cell);return true
}

// A plain full cube the bot may dig through on its own account: natural rock
// and soil, ore, and anything it placed itself (hardness up to 5), never a
// container, a station, bedrock or obsidian. The back exit's shaft passes
// these, and the retreat's underground leg to the shaft digs them.
const NEVER_THROUGH=new Set(['bedrock','obsidian','crying_obsidian','reinforced_deepslate','spawner','end_portal_frame','chest','trapped_chest','ender_chest','barrel','furnace','blast_furnace','smoker','crafting_table','beacon'])
export const plainCube=bot=>b=>{const e=bot.registry.blocksByName[b.name];return !!e&&!NEVER_THROUGH.has(b.name)&&!/shulker_box$/.test(b.name)&&e.hardness>0&&e.hardness<=5&&fullCube(bot.registry,b.name)&&!LIQUID.has(b.name)}
