// The back exit: one reserved interior floor cell a shaft goes down through,
// so a camping creeper or the night does not hold the bot behind its one door.
// Step 1 of workstreams/minecraft/back-exit-plan.md. The dig and the cap come next.
import {shelterLayout} from './shelter.js'
// The interior cell farthest from the door that no station stands on. Once
// chosen it is kept, so the shaft is always the same hole.
export function shaftCell(project){
 const build=project?.build
 if(!build?.design||!build.origin)throw new Error('A back exit needs a saved base')
 const kept=project.backExit?.cell
 if(kept)return {x:kept.x,y:kept.y,z:kept.z}
 const layout=shelterLayout(build.design),o=build.origin
 const taken=new Set(Object.values(project.stations||{}).map(s=>s?.position).filter(Boolean).map(p=>`${p.x},${p.z}`))
 const free=layout.inside.filter(c=>!taken.has(`${c.x+o.x},${c.z+o.z}`))
 if(!free.length)throw new Error('A back exit needs a free interior floor cell, and every one holds a station')
 const away=c=>Math.abs(c.x-layout.door.x)+Math.abs(c.z-layout.door.z)
 free.sort((a,b)=>away(b)-away(a)||a.x-b.x||a.z-b.z)
 return {x:free[0].x+o.x,y:o.y,z:free[0].z+o.z}
}
import {Vec3} from 'vec3'
import pathfinder from 'mineflayer-pathfinder'
const {goals}=pathfinder
import {quarryColumn} from './quarry.js'
import {centreOn} from './navigation.js'
import {climbOut} from './burrow.js'
import {setTimeout as delay} from 'node:timers/promises'
import {insideBase} from './retreat.js'
import {scaffoldItems} from './scaffold.js'
import {fullCube} from './construction.js'
const LIQUID=new Set(['water','lava','flowing_water','flowing_lava','bubble_column'])
const SIDES=[[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0],[0,-1,0]]
const solid=(bot,b)=>!!b&&fullCube(bot.registry,b.name)&&!LIQUID.has(b.name)
// Blocks the bot may have put in its own shaft and may dig back through: any
// plain full cube it could have placed, never a container, a station, bedrock
// or obsidian. Natural ground is the quarry's own list.
const NEVER_THROUGH=new Set(['bedrock','obsidian','crying_obsidian','reinforced_deepslate','spawner','end_portal_frame','chest','trapped_chest','ender_chest','barrel','furnace','blast_furnace','smoker','crafting_table','beacon'])
export const placedCube=bot=>b=>{const e=bot.registry.blocksByName[b.name];return !!e&&!NEVER_THROUGH.has(b.name)&&!/shulker_box$/.test(b.name)&&e.hardness>0&&e.hardness<=5&&fullCube(bot.registry,b.name)&&!LIQUID.has(b.name)}
// Open sides the shaft may close with carried blocks before giving up: the
// bot's own earlier burrows run under a lived-in base (lab, 3 October: a
// gallery at two and three below the floor). More than this is a cave.
export const BACK_EXIT_SEALS=8
// Deep enough that the base roof is not what stands between the bot and the
// sky, and that a cave breach near the surface is not mistaken for arrival.
export const BACK_EXIT_DEPTH=9
export const BACK_EXIT_MIN_DEPTH=4
const key=p=>`${p.x},${p.y},${p.z}`
// Close one air cell beside the shaft with a carried cube, placed against any
// solid neighbour, and judge it by the block being there (the burrow's cap rule).
async function sealCell(bot,cell,{check,progress}){
 const item=scaffoldItems(bot)[0];if(!item)return false
 await bot.equip(item,'hand');check()
 const closed=()=>solid(bot,bot.blockAt(cell))
 for(const [dx,dy,dz] of SIDES){
  if(closed())break
  const ref=bot.blockAt(cell.offset(dx,dy,dz));if(!solid(bot,ref))continue
  try{await bot.placeBlock(ref,cell.minus(ref.position))}catch(error){check();progress(`Seal at ${key(cell)} unconfirmed: ${error.message.slice(0,60)}`)}
  check();try{await settle(closed,'seal',{check,ms:1500})}catch{}
 }
 return closed()
}
async function settle(predicate,message,{check,ms=3000,poll=50}){
 const end=Date.now()+ms
 while(Date.now()<end){check();if(predicate())return;await delay(poll)}
 throw new Error(message)
}
// Open the back exit: stand on the shaft cell inside the base and dig straight
// down through checked rock to BACK_EXIT_DEPTH, or as far as the rock allows
// past BACK_EXIT_MIN_DEPTH. The bot ends at the bottom with the shaft open
// above it and the base's walls and roof still closed around the top.
export async function tunnelOut(bot,task,{check,stage,progress,persist=()=>{}}){
 check();const project=task.goal?.project
 if(!insideBase(bot,project))throw new Error('The back exit is opened from inside the base; use the door or retreat first')
 if(!bot.inventory.items().some(i=>/_pickaxe$/.test(i.name)))throw new Error('The back exit needs a pickaxe to open')
 const cell=shaftCell(project),top=new Vec3(cell.x,cell.y,cell.z)
 project.backExit={...(project.backExit||{}),cell};persist()
 const through=placedCube(bot),under=top.offset(0,-1,0),first=quarryColumn(bot,under,{top:true,through})
 if(!first.ok)throw new Error(`Cannot open the back exit at ${key(under)}: ${first.reason}`)
 stage('tunnelling');progress(`Opening the back exit through the floor at ${key(top)}`)
 bot.pathfinder?.setGoal(null);bot.clearControlStates?.()
 if(Math.floor(bot.entity.position.x)!==top.x||Math.floor(bot.entity.position.z)!==top.z){
  await bot.pathfinder.goto(new goals.GoalBlock(top.x,top.y,top.z));check()
 }
 await centreOn(bot,top,check)
 let depth=0,stopped=null,seals=0
 for(let d=1;d<=BACK_EXIT_DEPTH;d++){
  check()
  const target=top.offset(0,-d,0)
  // Below the first cell every side must stand. An air side is closed with a
  // carried block first; liquid, a missing floor or too many openings stop it.
  if(d>1)for(const [dx,dy,dz] of SIDES.slice(0,4)){
   const side=target.offset(dx,dy,dz),b=bot.blockAt(side)
   if(!b||solid(bot,b)||LIQUID.has(b.name))continue
   if(seals>=BACK_EXIT_SEALS){stopped=`Too many open sides to seal (${seals}); the shaft runs into a cave at ${key(side)}`;break}
   if(!await sealCell(bot,side,{check,progress})){stopped=`Could not seal the open side at ${key(side)}`;break}
   seals++;progress(`Sealed an open side at ${key(side)}`)
  }
  if(stopped)break
  const column=quarryColumn(bot,target,{top:d===1,through})
  if(!column.ok){stopped=column.reason;break}
  const block=bot.blockAt(target)
  if(bot.tool?.equipForBlock)await bot.tool.equipForBlock(block,{requireHarvest:true,getFromChest:false})
  check();await bot.dig(block);check()
  await settle(()=>Math.floor(bot.entity.position.y)<=target.y&&bot.entity.onGround!==false,`Did not land in the shaft at ${key(target)}`,{check})
  depth=d;project.backExit.bottom=target.y;persist()
  progress(`Back exit depth ${d}/${BACK_EXIT_DEPTH}`)
 }
 if(depth<BACK_EXIT_MIN_DEPTH){
  // Too shallow to be an exit: come back up and say what stopped it. A climb
  // that fails leaves the bot in a short hole under its own roof, still inside
  // the base, so the depth is the error and the climb is a note on it.
  let climb='';if(depth>0){stage('surfacing');try{await climbOut(bot,top,{check,stage,progress})}catch(error){climb=` (and could not climb back: ${error.message})`}}
  delete project.backExit.bottom;persist()
  throw new Error(`The back exit stopped at depth ${depth}${stopped?`: ${stopped}`:''}; it needs at least ${BACK_EXIT_MIN_DEPTH}${climb}`)
 }
 const p=bot.entity.position
 return {item:'back_exit',count:1,receipt:'back_exit_open',cell,bottom:project.backExit.bottom,depth,sealed:seals,...(stopped?{stoppedBy:stopped}:{}),position:{x:p.x,y:p.y,z:p.z}}
}
