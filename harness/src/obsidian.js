// make_obsidian: turn open lava into obsidian with a carried water bucket, then
// mine it. Trial 21 tried to compose this from goto and use and spent seventeen
// minutes on pours that could not reach, landed on stone, or aimed at flowing
// water, then walked onto a lava pool's edge and burned.
//
// The mechanism, from the game: a lava SOURCE with water above or beside it
// becomes obsidian; flowing lava becomes cobblestone. Water poured onto the top
// of a solid rim block beside a pool runs out over the lava, and every source
// it covers converts. The bucket goes back afterwards, from the one source cell
// the pour made, so the water drains and the bot keeps its fire insurance.
import pathfinding from 'mineflayer-pathfinder'
import {fullCube} from './construction.js'
import {lavaBeside} from './navigation.js'
import {inProtectedSite,validateProtectedSites} from './primitives.js'
const {goals}=pathfinding
export const OBSIDIAN_ACTIONS=['make_obsidian']
const AIR=new Set(['air','cave_air','void_air'])
const SIDES=[[1,0],[-1,0],[0,1],[0,-1]]
const PICKAXES=['diamond_pickaxe','netherite_pickaxe']
const key=p=>`${p.x},${p.y},${p.z}`
const isSource=b=>String(b?.getProperties?.()?.level??'')==='0'

export function validateObsidianGoal(goal){
 if(!Number.isInteger(goal?.count)||goal.count<1||goal.count>64)throw new Error('make_obsidian needs a total of 1–64 obsidian to carry')
 validateProtectedSites(goal.protectedSites)
 return {count:goal.count,...(goal.protectedSites?.length?{protectedSites:goal.protectedSites}:{})}
}

// Where to pour from. A site is a lava source open to the air, a solid rim
// block beside it with air above (where the water will land), and a standing
// cell one further out on solid ground with no lava around the body, so the
// bot never works from a pool's edge. Nearest first.
export function pourSites(bot,{protectedSites=[],skip=new Set(),radius=32}={}){
 const id=bot.registry.blocksByName.lava.id,here=bot.entity.position
 const sources=(bot.findBlocks({matching:id,maxDistance:radius,count:256})||[])
  .map(p=>bot.blockAt(p)).filter(b=>b&&isSource(b)&&AIR.has(bot.blockAt(b.position.offset(0,1,0))?.name))
 const sites=[],seen=new Set()
 for(const l of sources)for(const [dx,dz] of SIDES){
  const rim=l.position.offset(dx,0,dz),water=rim.offset(0,1,0),stand=l.position.offset(2*dx,1,2*dz)
  if(seen.has(key(rim))||skip.has(key(rim)))continue
  seen.add(key(rim))
  if(!fullCube(bot.registry,bot.blockAt(rim)?.name)||!AIR.has(bot.blockAt(water)?.name))continue
  if(!fullCube(bot.registry,bot.blockAt(stand.offset(0,-1,0))?.name)||![0,1].every(y=>AIR.has(bot.blockAt(stand.offset(0,y,0))?.name)))continue
  if(lavaBeside(bot,stand)||lavaBeside(bot,stand.offset(0,1,0)))continue
  if(inProtectedSite(water,protectedSites)||inProtectedSite(stand,protectedSites))continue
  sites.push({lava:l.position,rim,water,stand,distance:stand.distanceTo(here)})
 }
 return sites.sort((a,b)=>a.distance-b.distance).slice(0,16)
}

// The nearest water source a bucket can reach: any open face will do. Cave water
// is usually a lake behind a tunnel wall with rock overhead; asking for air
// above found none beside a live lake, and make_obsidian failed at once. A big
// lake is hundreds of sources, so search far enough not to run out on its interior.
const OPEN_FACES=[[0,1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]
// A bucket's ray ignores flowing water, so a face of it is as open as air.
const passable=b=>AIR.has(b?.name)||b?.name==='water'&&!isSource(b)
const waterSources=(bot,radius)=>(bot.findBlocks({matching:bot.registry.blocksByName.water.id,maxDistance:radius,count:1024})||[]).filter(p=>isSource(bot.blockAt(p)))
// Nearest first, with climbing counted double: nine blocks up through deepslate
// is a long tunnel even when the straight line is short.
export function fillableWaterSources(bot,{radius=32}={}){
 const here=bot.entity.position,cost=p=>p.distanceTo(here)+Math.abs(p.y-here.y)
 return waterSources(bot,radius).filter(p=>OPEN_FACES.some(([x,y,z])=>passable(bot.blockAt(p.offset(x,y,z)))))
  .sort((a,b)=>cost(a)-cost(b))
}
export const fillableWaterSource=(bot,options)=>fillableWaterSources(bot,options)[0]??null
// Underground water is often a lake sealed from the tunnel beside it by one
// block, as it was beside the VM bot. Name that block: a source, a diggable
// solid beside it with open air on its far side, and no lava touching it.
// Side walls only, so the bot never digs out the roof it could be standing on.
export function sealedWaterSource(bot,{radius=32,protectedSites=[]}={}){
 const here=bot.entity.position,found=[]
 for(const p of waterSources(bot,radius))for(const [dx,dz] of SIDES){
  const wall=p.offset(dx,0,dz),beyond=wall.offset(dx,0,dz),b=bot.blockAt(wall)
  if(!fullCube(bot.registry,b?.name)||b.diggable===false||!AIR.has(bot.blockAt(beyond)?.name))continue
  if([[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(([x,y,z])=>bot.blockAt(wall.offset(x,y,z))?.name==='lava'))continue
  if(inProtectedSite(wall,protectedSites))continue
  found.push({source:p,wall,distance:wall.distanceTo(here)})
 }
 return found.sort((a,b)=>a.distance-b.distance)[0]??null
}

// A bucket writes use_item, which the server raycasts along the look vector;
// settle the look for a tick first, as `use` does.
async function useBucket(bot,item,at,check){
 await bot.equip(bot.inventory.items().find(i=>i.name===item),'hand');check()
 await bot.lookAt(at,true);await bot.waitForTicks(1)
 try{bot.activateItem()}finally{bot.deactivateItem()}
 check()
}
const near=(bot,name,point,maxDistance,filter=()=>true)=>(bot.findBlocks({point,matching:bot.registry.blocksByName[name].id,maxDistance,count:64})||[]).filter(p=>filter(bot.blockAt(p)))

// `mine` is world-skills' mineExposed: it refuses any block with lava or water
// beside it, so a drop never falls into lava. `fill` fills an empty bucket at
// the nearest water source through `use`. Both are injected to avoid a cycle.
// `approach(point,range)` is a walk that may tunnel (world-skills passes goto's
// digging engine); without it the plain walk is used.
export async function makeObsidian(bot,task,{check,progress,stage,walk,settle,mine,fill,count,persist,approach=p=>walk(new goals.GoalBlock(p.x,p.y,p.z))}){
 const goal=validateObsidianGoal(task.goal),total=goal.count,start=count('obsidian')
 const record=task.obsidian??={pours:0,converted:0,skipped:[]}
 const done=extra=>({item:'obsidian',count:count('obsidian'),requested:total,pours:record.pours,converted:record.converted,...extra})
 if(start>=total)return done({receipt:'obsidian_already_carried'})
 if(!bot.inventory.items().some(i=>PICKAXES.includes(i.name)))throw new Error('Obsidian can only be mined with a diamond or netherite pickaxe; prepare diamond_pickaxe first')
 const skip=new Set(record.skipped)
 let reason='no attempt was made'
 for(let round=0;round<8&&count('obsidian')<total;round++){
  check()
  // Obsidian already safe to mine comes first; mine only returns at the total.
  try{await mine('obsidian',total);break}catch(error){check();reason=error.message}
  if(!count('water_bucket')){
   if(!count('bucket'))throw new Error('make_obsidian needs a water bucket, or an empty bucket and a water source')
   await fill();check()
   if(!count('water_bucket')){reason='the bucket could not be filled';break}
  }
  const site=pourSites(bot,{protectedSites:goal.protectedSites,skip})[0]
  if(!site){reason='no open lava source with a solid rim and a lava-free standing cell within 32 blocks';break}
  skip.add(key(site.rim));record.skipped=[...skip];persist?.()
  progress(`Converting lava at ${key(site.lava)}: pouring from ${key(site.stand)}`);stage('pouring')
  try{await approach(site.stand,0)}catch(error){check();reason=`the standing cell ${key(site.stand)} was not reached: ${error.message}`;continue}
  const feet=bot.entity.position.floored()
  if(key(feet)!==key(site.stand)||lavaBeside(bot,feet)){reason=`the walk ended at ${key(feet)}, not the lava-free standing cell`;continue}
  const before=near(bot,'lava',site.water,8,isSource)
  await useBucket(bot,'water_bucket',site.rim.offset(.5,1,.5),check)
  try{await settle(()=>bot.blockAt(site.water)?.name==='water','')}catch{reason=`the pour at ${key(site.water)} did not land`;continue}
  try{await settle(()=>bot.blockAt(site.lava)?.name==='obsidian','')}catch{}
  // The spread runs about a block every quarter second and converts as it goes.
  // Taking the water back at the first conversion counted 6 of a pool's 16 in
  // the lab; wait until the count stops moving, within settle's bound.
  const spread=()=>before.filter(p=>bot.blockAt(p)?.name==='obsidian').length
  let last=-1
  try{await settle(()=>{const n=spread(),same=n===last;last=n;return same&&n>0},'')}catch{}
  const converted=spread()
  record.pours++;record.converted+=converted;persist?.()
  progress(`The pour turned ${converted} lava source${converted===1?'':'s'} into obsidian; taking the water back`)
  // Only the cell the pour made is a source; the rest of the spread drains once it is gone.
  if(isSource(bot.blockAt(site.water))&&count('bucket')){
   await useBucket(bot,'bucket',site.water.offset(.5,.5,.5),check)
   try{await settle(()=>count('water_bucket')>0,'')}catch{progress('The water did not come back into the bucket')}
  }
  try{await settle(()=>!near(bot,'water',site.water,8).length,'')}catch{}
  if(!converted)reason=`the pour at ${key(site.water)} converted nothing`
 }
 if(count('obsidian')>=total)return done({receipt:'obsidian_carried'})
 if(count('obsidian')>start)return done({receipt:'obsidian_partial',partial:true,stoppedBecause:reason})
 throw new Error(`No obsidian made: ${reason}`)
}
