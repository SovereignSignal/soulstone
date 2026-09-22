import {Vec3} from 'vec3'
import {surveyGround,candidateSites,projectFootprints} from './site-survey.js'
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
