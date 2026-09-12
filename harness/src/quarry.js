// Bounded quarry: when no exposed stone can be walked to, dig a checked shaft
// straight down to the stone layer, mine the shaft walls for cobblestone, then
// tunnel and pillar back out. Every cell is verified before it is opened.
import {setTimeout as delay} from 'node:timers/promises'
import pathfinding from 'mineflayer-pathfinder'
import {DoorAwareMovements} from './navigation.js'
import {fullCube} from './construction.js'
const {goals}=pathfinding
export const QUARRY_DEPTH=12
const DIGGABLE=new Set(['grass_block','dirt','coarse_dirt','podzol','rooted_dirt','mud','clay','moss_block','stone','andesite','diorite','granite','tuff','deepslate','gravel','sand','red_sand'])
const LIQUID=new Set(['water','lava','bubble_column'])
const GRAVITY=new Set(['sand','red_sand','gravel'])
const SIDES=[[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]
const solid=(bot,b)=>!!b&&fullCube(bot.registry,b.name)&&!LIQUID.has(b.name)
const key=p=>`${p.x},${p.y},${p.z}`

export function quarryColumn(bot,cell,{top=false}={}){
 const b=bot.blockAt(cell)
 if(!b)return {ok:false,reason:'Ground below is not observed'}
 if(LIQUID.has(b.name))return {ok:false,reason:`Liquid at ${key(cell)}`}
 if(!DIGGABLE.has(b.name))return {ok:false,reason:`Cannot quarry through ${b.name} at ${key(cell)}`}
 // The surface cell often has an open side on a slope; below it every wall must stand.
 for(const [dx,dy,dz] of SIDES){const s=cell.offset(dx,dy,dz),sb=bot.blockAt(s);if(LIQUID.has(sb?.name))return {ok:false,reason:`Liquid beside the shaft at ${key(s)}`};if(!top&&!solid(bot,sb))return {ok:false,reason:`Shaft side is open at ${key(s)}`}}
 const below=bot.blockAt(cell.offset(0,-1,0))
 if(LIQUID.has(below?.name))return {ok:false,reason:`Liquid below ${key(cell)}`}
 if(!solid(bot,below))return {ok:false,reason:`No solid floor below ${key(cell)}`}
 return {ok:true}
}
async function settle(predicate,message,{check,ms=3000,poll=50}){
 const end=Date.now()+ms
 while(Date.now()<end){check();if(predicate())return;await delay(poll)}
 throw new Error(message)
}
async function digBlock(bot,block,check){
 if(bot.tool?.equipForBlock)await bot.tool.equipForBlock(block,{requireHarvest:true,getFromChest:false})
 check();await bot.dig(block);check()
}
export function findQuarryColumn(bot){
 const feet=bot.entity.position.floored()
 const usable=o=>quarryColumn(bot,o.offset(0,-1,0),{top:true}).ok&&quarryColumn(bot,o.offset(0,-2,0)).ok
 if(usable(feet))return {surface:feet,move:null}
 for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]){
  const o=feet.offset(dx,0,dz)
  const standable=bot.blockAt(o)?.name==='air'&&bot.blockAt(o.offset(0,1,0))?.name==='air'&&solid(bot,bot.blockAt(o.offset(0,-1,0)))
  if(standable&&usable(o))return {surface:o,move:o}
 }
 return null
}
export async function quarryStone(bot,{name='cobblestone',total,path=[]},{check,stage,progress,persist=()=>{},acquire,count}){
 check()
 if(!bot.inventory.items().some(i=>/_pickaxe$/.test(i.name)))await acquire('wooden_pickaxe',1,path)
 const found=findQuarryColumn(bot)
 if(!found)throw new Error('No sound quarry column here or beside it')
 if(found.move){
  const timer=setTimeout(()=>bot.pathfinder.setGoal(null),6000)
  try{await bot.pathfinder.goto(new goals.GoalBlock(found.move.x,found.move.y,found.move.z))}finally{clearTimeout(timer)}
  check()
 }
 const surface=found.surface
 bot.pathfinder?.setGoal(null);bot.clearControlStates?.()
 stage('quarrying');progress(`No reachable exposed stone; quarrying straight down for ${name}`)
 let depth=0,mined0=count(name)
 try{
  for(let d=1;d<=QUARRY_DEPTH&&count(name)<total;d++){
   check()
   const cell=surface.offset(0,-d,0),column=quarryColumn(bot,cell,{top:d===1})
   if(!column.ok){progress(`Quarry stopped: ${column.reason}`);break}
   const block=bot.blockAt(cell)
   await digBlock(bot,block,check)
   await settle(()=>Math.floor(bot.entity.position.y)<=cell.y&&bot.entity.onGround!==false,`Did not land in the quarry cell at ${key(cell)}`,{check})
   depth=d
   // Mine the shaft walls where they are stone, keeping the wall behind them.
   for(const [dx,dy,dz] of SIDES){
    if(count(name)>=total)break
    const s=cell.offset(dx,dy,dz),sb=bot.blockAt(s)
    if(sb?.name!=='stone')continue
    const beyond=bot.blockAt(s.offset(dx,0,dz)),above=bot.blockAt(s.offset(0,1,0)),below=bot.blockAt(s.offset(0,-1,0))
    if(!solid(bot,beyond)||!solid(bot,above)||!solid(bot,below)||GRAVITY.has(above?.name))continue
    check();await digBlock(bot,sb,check);await delay(150)
   }
   persist();progress(`Quarry depth ${d}; carrying ${count(name)}/${total} ${name}`)
  }
 }finally{
  // Climb out along the shaft: dig the way up and pillar on carried blocks.
  if(depth>0){
   stage('surfacing');progress('Climbing out of the quarry')
   const movement=new DoorAwareMovements(bot)
   Object.assign(movement,{canDig:true,allow1by1towers:true,allowParkour:false,allowSprinting:false,maxDropDown:1,
    scafoldingBlocks:[...new Set(bot.inventory.items().filter(i=>fullCube(bot.registry,i.name)&&!GRAVITY.has(i.name)).map(i=>bot.registry.blocksByName[i.name]?.id).filter(Number.isInteger))]})
   bot.pathfinder.setMovements(movement)
   const timer=setTimeout(()=>bot.pathfinder.setGoal(null),60000)
   try{await bot.pathfinder.goto(new goals.GoalBlock(surface.x,surface.y,surface.z))}finally{clearTimeout(timer)}
   check()
   const p=bot.entity.position.floored()
   if(p.y<surface.y||p.distanceTo(surface)>2)throw new Error(`Did not climb out of the quarry to ${key(surface)}; now at ${key(p)}`)
  }
 }
 return {item:name,mined:count(name)-mined0,count:count(name),depth,surface:{x:surface.x,y:surface.y,z:surface.z}}
}
