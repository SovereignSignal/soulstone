import {Vec3} from 'vec3'
import prismarineWorld from 'prismarine-world'
import {surveyGround,candidateSites,projectFootprints} from './site-survey.js'
import {dimensionOf,inNether,inEnd} from './dimension.js'
const AIR=new Set(['air','cave_air','void_air'])
const isAir=b=>!b||AIR.has(b.name)
const blockId=item=>{const m=/^([a-z0-9_]{1,64})/.exec(item||'');return m?m[1]:null}
// Fixed useful defaults for the planner's world.blocks channel. Wildcards expand
// against the live registry; absence from a truncated or unloaded scan is not
// evidence the block is gone.
export const DEFAULT_WORLD_BLOCKS=['stone','deepslate','dirt','grass_block','sand','gravel','water','lava','obsidian','coal_ore','iron_ore','copper_ore','diamond_ore','deepslate_iron_ore','deepslate_diamond_ore','crafting_table','furnace','chest','torch','nether_portal','end_portal_frame','*_log','*_leaves']
const matchName=(name,patterns)=>{
 for(const p of patterns){
  if(p==='any_solid')continue
  if(p.startsWith('*_')){if(name.endsWith(p.slice(1)))return true;continue}
  if(name===p)return true
 }
 return false
}
const round01=n=>Math.round(n*100)/100
// A loaded coordinate can be buried or touch liquid. Report its six neighbours
// separately from route/interaction feasibility; missing chunks stay unknown.
export function blockNeighbors(bot,position){
 const counts={},p=new Vec3(position.x,position.y,position.z)
 for(const [x,y,z] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]){
  const b=bot.blockAt(p.offset(x,y,z)),name=b?.name||'unknown'
  counts[name]=(counts[name]||0)+1
  if(b?.getProperties?.()?.waterlogged===true)counts.waterlogged=(counts.waterlogged||0)+1
 }
 return counts
}
// Bound each resource kind separately: abundant underground stone must not
// crowd nearby wood or workstations out of the planner and recipe observations.
export function nearbyResources(bot,names,{maxDistance=32,countPerKind=2}={}) {
 const seen=new Set(),result=[]
 for(const name of names){
  const id=bot?.registry?.blocksByName[name]?.id
  if(!Number.isInteger(id)||seen.has(id))continue
  seen.add(id)
  for(const p of findBlockCells(bot,id,{maxDistance,count:countPerKind})){
   const b=bot.blockAt(p)
   if(b?.name===name)result.push({name,x:p.x,y:p.y,z:p.z})
  }
 }
 return result
}

// mineflayer's findBlocks, cell for cell, without building a block per cell. It
// scans every cell of any section with no palette list, and a one-block section (sky,
// a lava sea) has none, so each name searched built tens of thousands of blocks: 5 to
// 15 s of a frozen bot on a Raspberry Pi (lab runs 123 and 124). Here a one-block
// section is decided by its value and other cells by state id. Same sections, order,
// stopping rule and distance arithmetic, so the same answer.
const {OctahedronIterator}=prismarineWorld.iterators
// `matching` is one block id or several; `useExtraInfo`, as in mineflayer, is a test
// run on the built block, here only for a cell whose type already matches (lab run 132:
// prospecting 128 blocks out this way froze the bot for 41.6 s).
export function findBlockCells(bot,matching,{maxDistance=16,count=1,point,useExtraInfo}={}){
 const ids=[matching].flat(),blocks=ids.map(id=>bot?.registry?.blocks?.[id]),world=bot?.world,minY=bot?.game?.minY,height=bot?.game?.height
 // No id to look for finds nothing; mineflayer would scan every one-block section to say so.
 if(!ids.length)return []
 if(!blocks.length||blocks.some(b=>!b)||typeof world?.getColumn!=='function'||!Number.isFinite(minY)||!Number.isFinite(height))return bot.findBlocks({matching,maxDistance,count,...(point?{point}:{}),...(useExtraInfo!==undefined?{useExtraInfo}:{})})
 const ranges=blocks.map(b=>[b.minStateId,b.maxStateId]),matches=s=>ranges.some(([lo,hi])=>s>=lo&&s<=hi)
 const extra=typeof useExtraInfo==='function'?useExtraInfo:null
 const from=(point||bot.entity.position).floored()
 const start=new Vec3(Math.floor(from.x/16),Math.floor(from.y/16),Math.floor(from.z/16))
 const it=new OctahedronIterator(start,Math.ceil((maxDistance+8)/16)),visited=new Set(),cell=new Vec3(0,0,0),total=height>>4,below=Math.abs(minY>>4)
 const found=[];let startedLayer=0,next=start
 while(next){
  const column=world.getColumn(next.x,next.z),sectionY=next.y+below
  if(sectionY>=0&&sectionY<total&&column&&!visited.has(next.toString())){
   const section=column.sections[sectionY]
   const single=section&&!section.palette&&Number.isInteger(section.data?.value)?section.data.value:null
   const scan=!section?false:section.palette?section.palette.some(matches):single===null||matches(single)
   if(scan){
    const bx=next.x*16,by=sectionY*16+minY,bz=next.z*16
    for(let x=bx;x<bx+16;x++)for(let y=by;y<by+16;y++)for(let z=bz;z<bz+16;z++){
     if(single===null&&!matches(column.getBlockStateId(cell.set(x&15,y,z&15))))continue
     const dx=from.x-x,dy=from.y-y,dz=from.z-z
     if(Math.sqrt(dx*dx+dy*dy+dz*dz)>maxDistance)continue
     // Both must hold, as in mineflayer; distance first spares a block for every far cell.
     if(extra&&!extra(bot.blockAt(new Vec3(x,y,z))))continue
     found.push(new Vec3(x,y,z))
    }
   }
   visited.add(next.toString())
  }
  if(startedLayer!==it.apothem&&found.length>=count)break
  startedLayer=it.apothem;next=it.next()
 }
 found.sort((a,b)=>a.distanceTo(from)-b.distanceTo(from))
 return found.length>count?found.slice(0,count):found
}

// Planner-supplied cube scan. Unloaded cells are never reported as air.
export function blocksNear(bot,{names=[],radius=8,limit=24}={}){
 const r=Math.min(16,Math.max(0,Number.isFinite(radius)?Math.floor(radius):8))
 const cap=Math.max(1,Number.isFinite(limit)?Math.floor(limit):24)
 const p=bot?.entity?.position
 if(!p||!bot?.blockAt)return {blocks:[],truncated:false,scanned:{radius:r,loaded:false}}
 const origin=p.floored(),patterns=[...new Set((names||[]).filter(Boolean))]
 let loaded=true,truncated=false
 const byDistance=(a,b)=>a.d-b.d||a.y-b.y||a.x-b.x||a.z-b.z
 const entry=(x,y,z,b)=>({name:b.name,x,y,z,d:Math.round(Math.hypot(x+0.5-p.x,y+0.5-p.y,z+0.5-p.z))})
 const matches=(b,pattern)=>!!b&&!isAir(b)&&(pattern==='any_solid'?b.boundingBox==='block':matchName(b.name,[pattern]))
 // One group per requested name, each holding its own nearest hits. Abundant
 // stone must not crowd the one crafting table out of a 24-entry cap, so the
 // groups are merged round-robin below rather than pooled and cut by distance.
 const groups=[]
 if(bot.findBlocks&&patterns.length){
  // ONE findBlocks walk for every name: a walk per name re-read each section
  // whose palette held that name, ~100k blockAt calls per sparse name at
  // radius 16, every planning round. Each name keeps its own quota of cap*2
  // (over-fetch, since findBlocks walks sections outward and is only roughly
  // by distance), so abundant stone stops counting while the walk goes on to
  // the one crafting table. This trades completeness for a bounded scan: a
  // name's hits past its quota are dropped in walk order, not by distance, and
  // the walk stops once every quota is full. inspect with a block list widens
  // the radius to 16. A palette probe (position null) only asks whether a
  // section is worth reading and is never counted.
  const quota=cap*2,taken=patterns.map(()=>0)
  const found=bot.findBlocks({maxDistance:r,count:quota*patterns.length,matching:b=>{
   if(b?.position===null)return patterns.some(q=>matches(b,q))
   if(b?.position&&b.position.distanceTo(origin)>r)return false
   const i=patterns.findIndex((q,j)=>taken[j]<quota&&matches(b,q))
   if(i<0)return false
   taken[i]++;return true
  }})||[]
  const byPattern=patterns.map(()=>[])
  for(const pos of found){
   const b=bot.blockAt(pos);if(!b){loaded=false;continue}
   const i=patterns.findIndex((q,j)=>byPattern[j].length<quota&&matches(b,q))
   if(i>=0)byPattern[i].push(entry(pos.x,pos.y,pos.z,b))
  }
  for(const hits of byPattern){hits.sort(byDistance);if(hits.length>cap)truncated=true;if(hits.length)groups.push(hits)}
  // Probe the cube's corners and centre on each axis: every 16-aligned chunk
  // column inside radius <= 16 contains one of them, so an unloaded chunk that
  // findBlocks silently skipped is still reported as unknown, never as air.
  for(const dx of [-r,0,r])for(const dy of [-r,0,r])for(const dz of [-r,0,r]){
   if(!bot.blockAt(origin.offset(dx,dy,dz)))loaded=false
  }
 }else{
  const hitsByPattern=new Map(patterns.map(q=>[q,[]]))
  for(let x=origin.x-r;x<=origin.x+r;x++)for(let y=origin.y-r;y<=origin.y+r;y++)for(let z=origin.z-r;z<=origin.z+r;z++){
   const b=bot.blockAt(new Vec3(x,y,z))
   if(!b){loaded=false;continue}
   for(const pattern of patterns){if(matches(b,pattern)){hitsByPattern.get(pattern).push(entry(x,y,z,b));break}}
  }
  for(const hits of hitsByPattern.values()){hits.sort(byDistance);if(hits.length>cap)truncated=true;if(hits.length)groups.push(hits)}
 }
 // Round-robin merge, groups ordered by their nearest hit, so the nearest block
 // overall still leads and every name with a hit appears before any name repeats.
 groups.sort((a,b)=>byDistance(a[0],b[0]))
 const seen=new Set(),blocks=[]
 let remaining=groups.reduce((n,g)=>n+g.length,0)
 for(let i=0;blocks.length<cap&&remaining>0;i=(i+1)%groups.length){
  const g=groups[i];if(!g.length)continue
  const b=g.shift();remaining--
  const k=`${b.x},${b.y},${b.z}`;if(seen.has(k))continue
  seen.add(k);blocks.push(b)
 }
 if(remaining>0)truncated=true
 return {blocks:blocks.map(b=>({...b,neighbors:blockNeighbors(bot,b)})),truncated,scanned:{radius:r,loaded}}
}

// Vertical escape clue: solids overhead, then where open sky begins.
export function columnAbove(bot){
 const p=bot?.entity?.position
 if(!p||!bot?.blockAt)return {surfaceAt:null,solidCells:0,firstSolid:null,skyVisible:false}
 const x=Math.floor(p.x),z=Math.floor(p.z),headY=Math.floor(p.y)+1
 let solidCells=0,firstSolid=null,surfaceAt=null
 for(let y=headY;y<headY+32;y++){
  const b=bot.blockAt(new Vec3(x,y,z))
  if(!b)return {surfaceAt:null,solidCells,firstSolid,skyVisible:false}
  if(isAir(b)){
   const above=bot.blockAt(new Vec3(x,y+1,z))
   const sky=above==null?false:isAir(above)&&(above.skyLight===undefined||above.skyLight===15)
   // World-height limit with nothing solid above also counts as sky.
   const open=sky||above==null&&y>=319
   if(open||y===headY+31){surfaceAt=y;break}
   continue
  }
  solidCells++
  if(!firstSolid)firstSolid={name:b.name,y}
 }
 if(solidCells>=32)return {surfaceAt:null,solidCells:32,firstSolid,skyVisible:false}
 const skyVisible=surfaceAt!=null&&solidCells===0
 return {surfaceAt,solidCells,firstSolid,skyVisible}
}

// Under this much rock the sky's clock is not the bot's business: caves spawn
// in the dark at any hour, and night adds nothing to them.
export const ROOFED_CELLS=8
// The Nether is all under rock: no sky, and no sunrise to wait for (nether-plan.md).
// The End has no sunrise either, so its clock rules stand down the same way.
export const roofed=bot=>inNether(bot)||inEnd(bot)||columnAbove(bot).solidCells>=ROOFED_CELLS

const entityKind=e=>{
 if(e?.type==='player')return 'player'
 if(['mob','hostile','animal','passive','water_creature','ambient'].includes(e?.type))return 'mob'
 if(e?.name==='item'||e?.type==='object'&&typeof e.getDroppedItem==='function')return 'item'
 if(e?.type==='object'&&e?.name==='item')return 'item'
 return 'other'
}
// Every loaded entity in range. Anger flags are version-specific; this tree
// never reads them, so angry stays null rather than inventing absence.
export function entitiesNear(bot,{radius=24,limit=32}={}){
 const r=Math.max(0,Number.isFinite(radius)?Math.floor(radius):24)
 const cap=Math.max(1,Number.isFinite(limit)?Math.floor(limit):32)
 const self=bot?.entity,origin=self?.position
 if(!origin)return {entities:[],truncated:false}
 const rows=[]
 for(const e of Object.values(bot.entities||{})){
  if(!e||e===self||!e.position)continue
  const d=origin.distanceTo(e.position)
  if(d>r)continue
  const kind=entityKind(e)
  const v=e.velocity
  const velocity=v&&Number.isFinite(v.x)?{x:round01(v.x),y:round01(v.y),z:round01(v.z)}:null
  const dropped=kind==='item'?e.getDroppedItem?.():null
  rows.push({type:e.name||e.type||'unknown',kind,x:Math.floor(e.position.x),y:Math.floor(e.position.y),z:Math.floor(e.position.z),d:Math.round(d),velocity,...(kind==='item'?{item:dropped?.name||null}:{}),angry:null})
 }
 rows.sort((a,b)=>a.d-b.d)
 return {entities:rows.slice(0,cap),truncated:rows.length>cap}
}

export function blockNamesFromGoal(goal,registry){
 const names=new Set()
 for(const c of goal?.criteria||[]){
  if(!c?.item)continue
  if(c.kind==='block_at'){const id=blockId(c.item);if(id)names.add(id);continue}
  if(['inventory','tools'].includes(c.kind)&&/^[a-z0-9_]{1,64}$/.test(c.item)&&registry?.blocksByName?.[c.item])names.add(c.item)
 }
 return [...names]
}

// Planner-facing validator for inspect item=block,list. Throws on bad input.
export function inspectBlockNames(item){
 if(typeof item!=='string'||!/^[a-z0-9_*,]{1,200}$/.test(item))throw new Error('Inspect block list must be comma-separated block IDs')
 const names=item.split(',').map(s=>s.trim()).filter(Boolean)
 if(!names.length||names.length>8)throw new Error('Inspect block list must be 1–8 comma-separated block IDs')
 return names
}

export function applyInspectBlockRequest(request,item){
 if(!request||typeof item!=='string'||!item)return request
 request.requestedBlocks=inspectBlockNames(item)
 return request
}

export function worldScanNames(bot,goal,requestedBlocks=[]){
 return [...new Set([...DEFAULT_WORLD_BLOCKS,...blockNamesFromGoal(goal,bot?.registry),...(requestedBlocks||[])])]
}

export function worldObservation(bot,{goal=null,requestedBlocks=[],radius,limit=24}={}){
 const r=radius??(requestedBlocks?.length?16:8)
 const blocks=blocksNear(bot,{names:worldScanNames(bot,goal,requestedBlocks),radius:r,limit})
 const column=columnAbove(bot)
 const entities=entitiesNear(bot,{radius:24,limit:24})
 return {blocks,column,entities}
}

// Coarse client-chunk survey for planning. Revalidated by the executor before
// placement; these candidates are observations, never reservations.
export function terrainSummary(bot,{near=bot?.entity?.position,projects={}}={}) {
 if(!near||!bot?.blockAt)return null
 const survey=surveyGround(bot,near,{protectedSites:projectFootprints(projects,dimensionOf(bot))}),selected=[]
 for(const [width,depth] of [[7,7],[5,7],[7,5],[5,5],[3,5],[5,3]]){
  const sites=candidateSites(survey,{minX:0,maxX:width-1,minZ:0,maxZ:depth-1,height:3},{limit:1,players:Object.values(bot.players||{}).map(p=>p.entity?.position).filter(Boolean)})
  if(sites[0]){const s=sites[0];selected.push({origin:s.origin,width,depth,elevationOffset:s.rise,foundationBlocks:s.foundationBlocks,foundationMaterial:'cobblestone'})}
 }
 const waypoints=[],seen=new Set(),columns=[...survey.columns.values()].filter(c=>c.clear>=2&&Math.hypot(c.x-near.x,c.z-near.z)>=6)
 for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]){
  const scale=16/Math.hypot(dx,dz),x=near.x+dx*scale,z=near.z+dz*scale
  let best=null,score=Infinity
  for(const c of columns){const d=(c.x-x)**2+(c.z-z)**2;if(d<score){best=c;score=d}}
  if(best){const key=`${best.x},${best.y+1},${best.z}`;if(!seen.has(key)){seen.add(key);waypoints.push({x:best.x,y:best.y+1,z:best.z})}}
 }
 return {radius:survey.radius,source:'loaded natural terrain; existing project footprints excluded',sites:selected,waypoints}
}

// Local physical evidence is separate from the owner's construction-site survey.
export function footingObservation(bot){
 const p=bot?.entity?.position
 if(!p||!bot?.blockAt)return null
 const feet=new Vec3(Math.floor(p.x),Math.floor(p.y),Math.floor(p.z))
 const describe=b=>b?{name:b.name,boundingBox:b.boundingBox}:null
 return {onGround:bot.entity.onGround??null,support:describe(bot.blockAt(feet.offset(0,-1,0))),feet:describe(bot.blockAt(feet)),head:describe(bot.blockAt(feet.offset(0,1,0))),scope:'Loaded blocks at the agent; unknown blocks do not establish a walkable route'}
}
