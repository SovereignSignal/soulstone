import {Vec3} from 'vec3'
import {projectDimension} from './dimension.js'
const natural=new Set(['grass_block','dirt','coarse_dirt','rooted_dirt','sand','sandstone','red_sand','red_sandstone','stone','gravel','deepslate','granite','andesite','diorite'])
const key=(x,z)=>`${x},${z}`
// A footprint protects a build, the ground it stands on (one layer under its
// lowest block) and its stations, as an x/z rectangle from minY up. Below that
// the ground is nobody's: the back exit's work starts nine cells under the
// base, and lab run 25 (3 October) saw dig and goto refuse every cell there.
// Given a dimension, only the builds made there: a Nether frame protects no
// Overworld ground. Without one, every build, as before.
export function projectFootprints(projects={},dimension=null) {
 const sites=[]
 for(const p of Object.values(projects)){
  if(dimension&&projectDimension(p)!==dimension)continue
  const b=p.construction||p.build
  if(b?.origin&&b.design?.length){const cells=b.design.filter(r=>r.block!=='checkpoint');if(cells.length)sites.push({minX:b.origin.x+Math.min(...cells.map(r=>r.x)),maxX:b.origin.x+Math.max(...cells.map(r=>r.x2??r.x)),minZ:b.origin.z+Math.min(...cells.map(r=>r.z)),maxZ:b.origin.z+Math.max(...cells.map(r=>r.z2??r.z)),minY:b.origin.y+Math.min(...cells.map(r=>r.y))-1})}
  for(const station of Object.values(p.stations||{})){const q=station.position;if(q)sites.push({minX:q.x,maxX:q.x,minZ:q.z,maxZ:q.z,minY:q.y-1})}
 }
 return sites
}
export function surveyGround(bot,near,{radius=24,protectedSites=[]}={}) {
 const center=new Vec3(near.x,near.y,near.z).floored(),columns=new Map()
 for(let x=center.x-radius-1;x<=center.x+radius+1;x++)for(let z=center.z-radius-1;z<=center.z+radius+1;z++){
  if(protectedSites.some(s=>x>=s.minX-1&&x<=s.maxX+1&&z>=s.minZ-1&&z<=s.maxZ+1))continue
  for(let y=center.y+3;y>=center.y-16;y--){
   const p=new Vec3(x,y,z),b=bot.blockAt(p)
   if(!b||!natural.has(b.name)||b.boundingBox!=='block'||bot.blockAt(p.offset(0,1,0))?.name!=='air')continue
   let clear=0;while(clear<20&&bot.blockAt(p.offset(0,clear+1,0))?.name==='air')clear++
   columns.set(key(x,z),{x,z,y,clear});break
  }
 }
 return {center,radius,columns}
}
export function candidateSites(survey,bounds,{maxRise=3,limit=8,players=[]}={}) {
 const {center,radius,columns}=survey,candidates=[]
 const width=bounds.maxX-bounds.minX+1,depth=bounds.maxZ-bounds.minZ+1
 for(let x=center.x-radius;x+width-1<=center.x+radius;x++)for(let z=center.z-radius;z+depth-1<=center.z+radius;z++){
  const distance=Math.hypot(x+width/2-center.x,z+depth/2-center.z);if(distance>radius)continue
  const cells=[]
  for(let dx=0;dx<width;dx++)for(let dz=0;dz<depth;dz++){const c=columns.get(key(x+dx,z+dz));if(c)cells.push(c)}
  if(cells.length!==width*depth)continue
  const low=Math.min(...cells.map(c=>c.y)),high=Math.max(...cells.map(c=>c.y)),rise=high-low
  if(rise>maxRise||width*depth>81&&rise>0||cells.some(c=>c.clear<high-c.y+bounds.height+2))continue
  if(players.some(p=>p.x>x-1&&p.x<x+width+1&&p.z>z-1&&p.z<z+depth+1&&p.y+1.8>low+1&&p.y<high+bounds.height+3))continue
  // At least one outside edge must allow stepping onto the planned floor.
  const perimeter=[]
  for(let dx=0;dx<width;dx++)perimeter.push(columns.get(key(x+dx,z-1)),columns.get(key(x+dx,z+depth)))
  for(let dz=0;dz<depth;dz++)perimeter.push(columns.get(key(x-1,z+dz)),columns.get(key(x+width,z+dz)))
  if(!perimeter.some(c=>c&&c.y>=high&&c.y<=high+1&&c.clear>=3))continue
  const foundationBlocks=cells.reduce((n,c)=>n+high-c.y,0);if(foundationBlocks>128)continue
  candidates.push({origin:{x:x-bounds.minX,y:low+1,z:z-bounds.minZ},floorY:high+1,rise,foundationBlocks,cells,distance})
 }
 candidates.sort((a,b)=>(a.distance+a.foundationBlocks*.15)-(b.distance+b.foundationBlocks*.15))
 return candidates.slice(0,limit)
}
