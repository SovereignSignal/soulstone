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
 return {radius:survey.radius,source:'loaded natural terrain; existing project footprints excluded',sites:selected}
}
