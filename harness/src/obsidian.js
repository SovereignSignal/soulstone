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
import {inProtectedSite,validateProtectedSites,refuseDigCell} from './primitives.js'
import {inNether} from './dimension.js'
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
// bot never works from a pool's edge. Nearest first. The report counts how far
// each lava source got through those rules, so a failure can say which one bit.
export function surveyPourSites(bot,{protectedSites=[],skip=new Set(),radius=64}={}){
 const id=bot.registry.blocksByName.lava.id,here=bot.entity.position
 const all=(bot.findBlocks({matching:id,maxDistance:radius,count:256})||[]).map(p=>bot.blockAt(p)).filter(b=>b&&isSource(b))
 const sources=all.filter(b=>AIR.has(bot.blockAt(b.position.offset(0,1,0))?.name))
 const nearest=[...all].sort((a,b)=>a.position.distanceTo(here)-b.position.distanceTo(here))[0]?.position
 const report={radius,sources:all.length,open:sources.length,rims:0,stands:0,lavaFree:0,...(nearest?{nearest:{x:nearest.x,y:nearest.y,z:nearest.z}}:{})}
 const sites=[],seen=new Set()
 const standable=p=>fullCube(bot.registry,bot.blockAt(p.offset(0,-1,0))?.name)&&[0,1].every(y=>AIR.has(bot.blockAt(p.offset(0,y,0))?.name))
 // The rim's top face must be what the look meets; without a world to raycast
 // (tests), reach alone is checked and the pour's own readback catches a miss.
 const sees=(stand,rim)=>{
  const eye=stand.offset(.5,1.62,.5),top=rim.offset(.5,1,.5)
  if(eye.distanceTo(top)>4.5)return false
  if(!bot.world?.raycast)return true
  const hit=bot.world.raycast(eye,top.minus(eye).normalize(),4.6)
  return !!hit&&hit.position?.equals?.(rim)&&hit.face===1
 }
 for(const l of sources)for(const [dx,dz] of SIDES){
  const rim=l.position.offset(dx,0,dz),water=rim.offset(0,1,0)
  if(seen.has(key(rim))||skip.has(key(rim)))continue
  seen.add(key(rim))
  if(!fullCube(bot.registry,bot.blockAt(rim)?.name)||!AIR.has(bot.blockAt(water)?.name))continue
  report.rims++
  // Straight out from the lava first, the proven stance; then any dry cell at
  // the rim's level within two of it. Cave floors rarely offer the first: trial
  // 26 found 11 usable rims at the deep lava level and no straight-out stance.
  const straight=l.position.offset(2*dx,1,2*dz),around=[]
  for(let ax=-2;ax<=2;ax++)for(let az=-2;az<=2;az++)if(ax||az)around.push(rim.offset(ax,1,az))
  around.sort((a,b)=>a.distanceTo(here)-b.distanceTo(here))
  const standing=[straight,...around].filter(standable)
  if(standing.length)report.stands++
  // No lava around the body, nor around the floor block: a cell on the rim itself
  // is dry at the feet but one step from the pool, and the pour's own flow pushes.
  const clear=standing.filter(p=>[-1,0,1].every(y=>!lavaBeside(bot,p.offset(0,y,0))))
  if(clear.length)report.lavaFree++
  const stand=clear.find(p=>sees(p,rim)&&!inProtectedSite(p,protectedSites))
  if(!stand||inProtectedSite(water,protectedSites))continue
  // A slight preference for the straight-out stance where it exists.
  sites.push({lava:l.position,rim,water,stand,distance:stand.distanceTo(here)+(stand.equals(straight)?0:1.5)})
 }
 return {sites:sites.sort((a,b)=>a.distance-b.distance).slice(0,16),report}
}
export const pourSites=(bot,options)=>surveyPourSites(bot,options).sites

// Sealed lava. In the test world every lava source within 96 blocks sat in
// solid rock, none open to the air (3 October, run 41). Water only converts a
// source it touches, so a pocket becomes a pour site by uncovering it from
// above: dig the block over a solid rim beside the lava (where the water will
// land) and the lid over the lava itself, then the lid over neighbouring
// sources within reach. Digging above lava is safe, lava never flows upward;
// every dug block must have no liquid against it except the lava beneath a
// lid. The bot works from a standing cell two out, reached by the tunnelling
// walk, whose head room, feet and floor touch no liquid, and never steps onto
// the uncovered pool. Nearest standing cell first.
const LIQUID=new Set(['lava','water','flowing_water','flowing_lava','bubble_column'])
const NEVER_DIG=new Set(['bedrock','obsidian','crying_obsidian','reinforced_deepslate','end_portal_frame','spawner','chest','barrel','furnace','crafting_table'])
const SIX=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
export const MAX_OPENINGS=3,LID_REACH=4
export function sealedOpenings(bot,{protectedSites=[],skip=new Set(),radius=64}={}){
 const id=bot.registry.blocksByName.lava.id,here=bot.entity.position
 const name=p=>bot.blockAt(p)?.name
 const dryExcept=(p,below=false)=>SIX.every(([x,y,z])=>(below&&x===0&&y===-1&&z===0)||!LIQUID.has(name(p.offset(x,y,z))))
 const diggableOrAir=p=>{const n=name(p);return !!n&&!LIQUID.has(n)&&(AIR.has(n)||fullCube(bot.registry,n)&&!NEVER_DIG.has(n))}
 const out=[]
 for(const lp of bot.findBlocks({matching:id,maxDistance:radius,count:256})||[]){
  const lava=bot.blockAt(lp);if(!lava||!isSource(lava))continue
  const lid=lava.position.offset(0,1,0)
  for(const [dx,dz] of SIDES){
   const rim=lava.position.offset(dx,0,dz),water=rim.offset(0,1,0),stand=lava.position.offset(2*dx,1,2*dz),floor=stand.offset(0,-1,0)
   if(skip.has(key(rim)))continue
   if(!fullCube(bot.registry,name(rim))||LIQUID.has(name(rim)))continue
   if(AIR.has(name(water))&&AIR.has(name(lid)))continue // already open: the survey's business
   if(!diggableOrAir(water)||!dryExcept(water))continue
   if(!diggableOrAir(lid)||!dryExcept(lid,true))continue
   if(!fullCube(bot.registry,name(floor))||LIQUID.has(name(floor))||!dryExcept(floor))continue
   if(![stand,stand.offset(0,1,0)].every(c=>diggableOrAir(c)&&dryExcept(c)))continue
   if([-1,0,1].some(y=>lavaBeside(bot,stand.offset(0,y,0))))continue
   if([rim,water,lid,stand,stand.offset(0,1,0)].some(c=>inProtectedSite(c,protectedSites)))continue
   out.push({lava:lava.position,rim,water,lid,stand,distance:stand.distanceTo(here)})
  }
 }
 return out.sort((a,b)=>a.distance-b.distance).slice(0,16)
}
// Walk (tunnelling) to the standing cell, recheck, dig the block over the rim
// and the lid, then any further lid within reach that joins an opened cell:
// the next survey then sees an ordinary pour site over an open pool.
async function openSealed(bot,site,{check,progress,stage,approach,settle,staircase=null,protectedSites=[]}){
 progress(`Opening sealed lava at ${key(site.lava)}: tunnelling to ${key(site.stand)}`);stage('tunnelling')
 // A dug staircase, down, level or up; a route search through rock times
 // out. Straight overhead the staircase cannot climb, so that one is walked.
 const at=bot.entity.position.floored(),overhead=site.stand.y>at.y&&site.stand.x===at.x&&site.stand.z===at.z
 if(staircase&&!overhead)await staircase(site.stand)
 else await approach(site.stand,0)
 check()
 const feet=bot.entity.position.floored()
 if(key(feet)!==key(site.stand))throw new Error(`the tunnel ended at ${key(feet)}, not ${key(site.stand)}`)
 if([-1,0,1].some(y=>lavaBeside(bot,feet.offset(0,y,0))))throw new Error('lava beside the standing cell')
 const name=p=>bot.blockAt(p)?.name
 const wet=(p,below)=>SIX.some(([x,y,z])=>!(below&&x===0&&y===-1&&z===0)&&LIQUID.has(name(p.offset(x,y,z))))
 const eye=bot.entity.position.offset(0,bot.entity.eyeHeight||1.62,0)
 async function open(cell,overLava){
  const block=bot.blockAt(cell);if(!block)throw new Error(`${key(cell)} is not loaded`)
  if(AIR.has(block.name))return
  if(LIQUID.has(block.name)||wet(cell,overLava))throw new Error(`liquid now touches ${key(cell)}`)
  if(bot.tool?.equipForBlock)await bot.tool.equipForBlock(block,{requireHarvest:false,getFromChest:false})
  check();stage('digging');await bot.dig(block);check()
  await settle(()=>AIR.has(name(cell)),`${key(cell)} did not open`)
 }
 await open(site.water,false)
 await open(site.lid,true)
 // More of the pool: lids over neighbouring sources, each joined to a cell
 // already open, within reach, and dry but for the lava beneath.
 const opened=[site.water,site.lid],lavaId=bot.registry.blocksByName.lava.id
 const more=(bot.findBlocks({point:site.lava,matching:lavaId,maxDistance:LID_REACH,count:64})||[])
  .map(p=>bot.blockAt(p)).filter(b=>b&&isSource(b)&&b.position.y===site.lava.y).map(b=>b.position.offset(0,1,0))
  .filter(c=>!opened.some(o=>o.equals(c))).sort((a,b)=>a.distanceTo(site.lid)-b.distanceTo(site.lid))
 for(const lid of more){
  if(!opened.some(o=>o.distanceTo(lid)===1)||lid.offset(.5,.5,.5).distanceTo(eye)>4.5||inProtectedSite(lid,protectedSites))continue
  const n=name(lid);if(!n||LIQUID.has(n)||(!AIR.has(n)&&(!fullCube(bot.registry,n)||NEVER_DIG.has(n))))continue
  try{await open(lid,true);opened.push(lid)}catch(error){check();progress(`Left the lid at ${key(lid)}: ${error.message}`)}
 }
 // Room to stand over the rim afterwards. Mining wants the bot within a block
 // and a half of the obsidian, and the standing cell is two away (play-world run 4,
 // 6 October: the pocket at -651,43,-427 turned to obsidian and was skipped as
 // inaccessible, the rock over the rim cell leaving no head room there).
 const head=site.water.offset(0,1,0),hn=name(head)
 if(hn&&!AIR.has(hn)&&fullCube(bot.registry,hn)&&!NEVER_DIG.has(hn)){
  const refused=refuseDigCell(bot,head,{protectedSites,role:'head'})
  if(refused)progress(`Left the rock over the rim at ${key(head)}: ${refused}`)
  else try{await open(head,false)}catch(error){check();progress(`Left the rock over the rim at ${key(head)}: ${error.message}`)}
 }
 progress(`Uncovered ${opened.length-1} block${opened.length===2?'':'s'} over the lava`)
}

// Obsidian the job may take. A pour turns one level of lava, so what it makes
// lies flat; a ruined portal stands on netherrack with magma, crying obsidian
// or gold about it. Obsidian joined across more than one level with none of
// that against it is a frame somebody built (play-world run 6, 6 October: the job
// mined seven blocks of a ruined portal, and would have mined a frame the players
// built just the same). The whole joined piece is judged, since a frame's
// bottom middle has air above it like any pool layer.
const RUIN=new Set(['netherrack','magma_block','crying_obsidian','gold_block'])
// Never the way home (nether-plan.md, step 4): no obsidian within two blocks
// of a portal block, and none at all in the Nether, where the arrival frame
// stands on netherrack and would read as a ruin.
export function takeableObsidian(bot,pos){
 const name=p=>bot.blockAt(p)?.name,seen=new Set(),queue=[pos],piece=[]
 if(inNether(bot))return false
 for(let dx=-2;dx<=2;dx++)for(let dy=-2;dy<=2;dy++)for(let dz=-2;dz<=2;dz++)if(name(pos.offset(dx,dy,dz))==='nether_portal')return false
 while(queue.length&&piece.length<48){
  const p=queue.shift(),k=key(p)
  if(seen.has(k))continue;seen.add(k)
  if(name(p)!=='obsidian')continue
  piece.push(p);for(const [x,y,z] of SIX)queue.push(p.offset(x,y,z))
 }
 if(new Set(piece.map(p=>p.y)).size<=1)return true
 return piece.some(p=>{for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)for(let dy=-2;dy<=1;dy++)if(RUIN.has(name(p.offset(dx,dy,dz))))return true;return false})
}

export function describeSurvey(r){
 if(!r.sources)return `saw 0 lava sources`
 const near=r.nearest?` (nearest at ${r.nearest.x},${r.nearest.y},${r.nearest.z})`:''
 return `saw ${r.sources} lava source${r.sources===1?'':'s'}${near}, ${r.open} open to the air, ${r.rims} rim${r.rims===1?'':'s'} with air above, ${r.stands} with a standing cell within two, ${r.lavaFree} of those clear of lava`
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
// With no open lava in view the trip searches: legs of SEARCH_LEG blocks
// north, east, south and west of where it began, in growing rings, surveying
// after each. Test run 39 (3 October) saw two lava sources, both sealed in
// rock, and stopped where it stood.
export const SEARCH_LEGS=6,SEARCH_LEG=48
export async function makeObsidian(bot,task,{check,progress,stage,walk,settle,mine,fill,count,persist,travel=null,staircase=null,approach=p=>walk(new goals.GoalBlock(p.x,p.y,p.z))}){
 const goal=validateObsidianGoal(task.goal),total=goal.count,start=count('obsidian')
 if(inNether(bot))throw new Error('Water evaporates in the Nether, so no pour can make obsidian here; make it in the Overworld')
 const record=task.obsidian??={pours:0,converted:0,skipped:[]}
 const done=extra=>({item:'obsidian',count:count('obsidian'),requested:total,pours:record.pours,converted:record.converted,...extra})
 if(start>=total)return done({receipt:'obsidian_already_carried'})
 if(!bot.inventory.items().some(i=>PICKAXES.includes(i.name)))throw new Error('Obsidian can only be mined with a diamond or netherite pickaxe; prepare diamond_pickaxe first')
 const skip=new Set(record.skipped)
 let reason='no attempt was made'
 const origin=record.origin??={x:Math.floor(bot.entity.position.x),z:Math.floor(bot.entity.position.z)}
 let legs=record.legs||0
 for(let round=0;round<8+SEARCH_LEGS+MAX_OPENINGS&&count('obsidian')<total;round++){
  check()
  // Obsidian already safe to mine comes first; mine only returns at the total.
  try{await mine('obsidian',total);break}catch(error){check();reason=error.message}
  if(!count('water_bucket')){
   if(!count('bucket'))throw new Error('make_obsidian needs a water bucket, or an empty bucket and a water source')
   await fill();check()
   if(!count('water_bucket')){reason='the bucket could not be filled';break}
  }
  const survey=surveyPourSites(bot,{protectedSites:goal.protectedSites,skip}),site=survey.sites[0]
  if(!site){
   reason=`no pour site within ${survey.report.radius} blocks: ${describeSurvey(survey.report)}`
   // Lava in view but sealed in rock: open the nearest safe pocket first.
   if((record.openings||0)<MAX_OPENINGS&&bot.dig){
    const opening=sealedOpenings(bot,{protectedSites:goal.protectedSites,skip})[0]
    if(opening){
     record.openings=(record.openings||0)+1;persist?.()
     try{await openSealed(bot,opening,{check,progress,stage,approach,settle,staircase,protectedSites:goal.protectedSites||[]});progress(`Opened a pour site above the rim at ${key(opening.rim)}`);continue}
     catch(error){check();skip.add(key(opening.rim));record.skipped=[...skip];persist?.();reason=`opening sealed lava at ${key(opening.lava)} failed: ${error.message}`;progress(`Opening sealed lava at ${key(opening.lava)} failed: ${error.message}`);continue}
    }
   }
   if(!travel||legs>=SEARCH_LEGS)break
   const [dx,dz]=[[0,-1],[1,0],[0,1],[-1,0]][legs%4],ring=Math.floor(legs/4)+1,to={x:origin.x+dx*SEARCH_LEG*ring,z:origin.z+dz*SEARCH_LEG*ring}
   legs++;record.legs=legs;persist?.()
   progress(`No open lava in view (${describeSurvey(survey.report)}); searching leg ${legs} of ${SEARCH_LEGS} toward ${to.x},${to.z}`);stage('walking')
   try{await travel(to)}catch(error){check();progress(`Search leg ${legs} stopped short: ${String(error.message).slice(0,80)}`)}
   continue
  }
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
 throw new Error(`No obsidian made: ${reason}${legs?` (after ${legs} search leg${legs===1?'':'s'})`:''}`)
}
