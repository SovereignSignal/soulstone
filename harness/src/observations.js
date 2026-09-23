import {Vec3} from 'vec3'
import {surveyGround,candidateSites,projectFootprints} from './site-survey.js'
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
const wantsSolid=patterns=>patterns.includes('any_solid')
const round01=n=>Math.round(n*100)/100
// Bound each resource kind separately: abundant underground stone must not
// crowd nearby wood or workstations out of the planner and recipe observations.
export function nearbyResources(bot,names,{maxDistance=32,countPerKind=2}={}) {
 const seen=new Set(),result=[]
 for(const name of names){
  const id=bot?.registry?.blocksByName[name]?.id
  if(!Number.isInteger(id)||seen.has(id))continue
  seen.add(id)
  for(const p of bot.findBlocks({matching:id,maxDistance,count:countPerKind})){
   const b=bot.blockAt(p)
   if(b?.name===name)result.push({name,x:p.x,y:p.y,z:p.z})
  }
 }
 return result
}

// Planner-supplied cube scan. Unloaded cells are never reported as air.
export function blocksNear(bot,{names=[],radius=8,limit=24}={}){
 const r=Math.min(16,Math.max(0,Number.isFinite(radius)?Math.floor(radius):8))
 const cap=Math.max(1,Number.isFinite(limit)?Math.floor(limit):24)
 const p=bot?.entity?.position
 if(!p||!bot?.blockAt)return {blocks:[],truncated:false,scanned:{radius:r,loaded:false}}
 const origin=p.floored(),patterns=[...new Set((names||[]).filter(Boolean))]
 const solid=wantsSolid(patterns)
 let loaded=true,truncated=false
 const hits=[]
 const consider=(x,y,z,b)=>{
  if(!b){loaded=false;return}
  const ok=solid&&b.boundingBox==='block'&&!isAir(b)||matchName(b.name,patterns)
  if(!ok)return
  const d=Math.round(Math.hypot(x+0.5-p.x,y+0.5-p.y,z+0.5-p.z))
  hits.push({name:b.name,x,y,z,d})
 }
 if(bot.findBlocks&&patterns.length){
  const matching=b=>{
   if(!b)return false
   if(solid&&b.boundingBox==='block'&&!isAir(b))return true
   return matchName(b.name,patterns)
  }
  // Over-fetch so distance sorting can keep the nearest cap entries. findBlocks
  // walks chunk sections outward, so its order is only roughly by distance; a
  // fourfold margin is cheap and keeps "nearest first" honest.
  const found=bot.findBlocks({matching,maxDistance:r,count:cap*4})||[]
  if(found.length>cap)truncated=true
  for(const pos of found)consider(pos.x,pos.y,pos.z,bot.blockAt(pos))
  // Probe the cube corners so an unloaded chunk inside the radius is visible
  // even when findBlocks simply skips it.
  for(const dx of [-r,0,r])for(const dy of [-r,0,r])for(const dz of [-r,0,r]){
   if(!bot.blockAt(origin.offset(dx,dy,dz)))loaded=false
  }
 }else{
  for(let x=origin.x-r;x<=origin.x+r;x++)for(let y=origin.y-r;y<=origin.y+r;y++)for(let z=origin.z-r;z<=origin.z+r;z++){
   const b=bot.blockAt(new Vec3(x,y,z))
   if(!b){loaded=false;continue}
   const ok=solid&&b.boundingBox==='block'&&!isAir(b)||matchName(b.name,patterns)
   if(!ok)continue
   hits.push({name:b.name,x,y,z,d:Math.round(Math.hypot(x+0.5-p.x,y+0.5-p.y,z+0.5-p.z))})
   if(hits.length>cap){truncated=true;break}
  }
 }
 hits.sort((a,b)=>a.d-b.d||a.y-b.y||a.x-b.x||a.z-b.z)
 const blocks=hits.slice(0,cap)
 if(hits.length>cap)truncated=true
 // Dedup by cell in case findBlocks and corner probes overlapped.
 const seen=new Set(),unique=[]
 for(const b of blocks){const k=`${b.x},${b.y},${b.z}`;if(seen.has(k))continue;seen.add(k);unique.push(b)}
 return {blocks:unique.slice(0,cap),truncated:truncated||unique.length>cap&&hits.length>cap,scanned:{radius:r,loaded}}
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

const entityKind=e=>{
 if(e?.type==='player')return 'player'
 if(e?.type==='mob'||e?.type==='hostile')return 'mob'
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
 const survey=surveyGround(bot,near,{protectedSites:projectFootprints(projects)}),selected=[]
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
