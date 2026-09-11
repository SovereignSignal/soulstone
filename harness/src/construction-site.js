import {compileArchitecture,fullCube,reviewArchitecture} from './construction.js'
import {surveyGround,candidateSites} from './site-survey.js'
import {Vec3} from 'vec3'
export function fitConstructionSite(bot,blueprint,near,protectedSites=[],limits={}) {
 const {bounds}=blueprint,map=new Map(blueprint.cells.map(b=>[`${b.x},${b.y},${b.z}`,b]))
 let floor=true
 for(let x=bounds.minX;x<=bounds.maxX;x++)for(let z=bounds.minZ;z<=bounds.maxZ;z++)if(!fullCube(bot.registry,map.get(`${x},0,${z}`)?.block))floor=false
 const foundationMaterial=limits.materials?.length?(limits.materials.includes('cobblestone')?'cobblestone':limits.materials.find(n=>fullCube(bot.registry,n))):'cobblestone'
 const survey=surveyGround(bot,near,{protectedSites}),players=Object.values(bot.players||{}).map(p=>p.entity?.position).filter(Boolean)
 for(const site of candidateSites(survey,bounds,{maxRise:floor?3:0,players})){
  const supports=site.cells.filter(c=>c.y<site.floorY-1).map(c=>({x:c.x-site.origin.x,y:c.y+1-site.origin.y,z:c.z-site.origin.z,x2:c.x-site.origin.x,y2:site.rise-1,z2:c.z-site.origin.z,block:foundationMaterial}))
  const design=[...supports,...blueprint.design.map(r=>({...r,y:r.y+site.rise,y2:r.y2+site.rise}))]
  try{
   const fitted=compileArchitecture(design)
   if(fitted.blocks.length>(limits.maxBlocks??2048)||limits.materials&&fitted.blocks.some(b=>!limits.materials.includes(b.block)))continue
   if(reviewArchitecture(fitted).unreachable.length)continue
   // Checkpoints can extend beyond the placed footprint. The geometry review
   // assumes ground at y=-1; verify that ground and headroom actually exist
   // at this candidate, before reserving a site or consuming any materials.
   const planned=new Map(fitted.cells.map(b=>[`${b.x},${b.y},${b.z}`,b]))
   const name=p=>planned.get(`${p.x},${p.y},${p.z}`)?.block??bot.blockAt(new Vec3(site.origin.x+p.x,site.origin.y+p.y,site.origin.z+p.z))?.name
   if(fitted.checks.some(p=>!fullCube(bot.registry,name(p.offset(0,-1,0)))||name(p)!=='air'||name(p.offset(0,1,0))!=='air'))continue
   return {origin:site.origin,design:fitted.design,foundationBlocks:site.foundationBlocks,elevationOffset:site.rise}
  }
  catch {continue}
 }
 return null
}
