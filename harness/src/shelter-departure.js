import {isPotentialHostile} from './survival.js'
import {occupiedAlternative,inspectConstructionShelter} from './alternate-shelter.js'
import {shelterLayout} from './shelter.js'

const corridorPoint=(origin,layout,depth)=>({x:origin.x+layout.door.x+0.5+layout.out.x*depth,y:origin.y+layout.door.y+0.5,z:origin.z+layout.door.z+0.5+layout.out.z*depth})
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)
const corridorDistance=(p,a,b)=>{
 const dx=b.x-a.x,dz=b.z-a.z,len2=dx*dx+dz*dz
 const t=len2?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/len2)):0
 const x=a.x+t*dx,z=a.z+t*dz
 return {lateral:Math.hypot(p.x-x,p.z-z),along:t*Math.sqrt(len2)}
}
export function departureThreatObservation(bot,projects,shelterName='base',{depth=3,radius=2.5}={}){
 const p=bot?.entity?.position
 const entities=Object.values(bot?.entities||{}).filter(e=>e!==bot?.entity&&(isPotentialHostile(e.name)||e?.name==='enderman'||e?.name==='piglin'||e?.name==='zombified_piglin'||e?.name==='wolf'||e?.name==='bee'||e?.name==='polar_bear'||e?.name==='iron_golem'))
 let start,end
 try{
  if(shelterName&&shelterName!=='base'){
   // A fallback shelter is {name, construction}; it has no `build`, so reading
   // one here left the corridor permanently unavailable and every loaded mob
   // marked as blocking, at any distance. Derive it from the shelter itself.
   const shelter=occupiedAlternative(bot,projects)
   if(!shelter)throw new Error('Not inside the named fallback shelter')
   const inspected=inspectConstructionShelter(bot,shelter,{occupants:false})
   const door=inspected.door.position,out=inspected.outside
   start={x:door.x+0.5,y:door.y+0.5,z:door.z+0.5}
   const dx=Math.sign(out.x-door.x),dz=Math.sign(out.z-door.z)
   end={x:start.x+dx*depth,y:start.y,z:start.z+dz*depth}
  }else{
   const build=projects?.base?.build
   if(!build)throw new Error('No saved shelter project')
   const layout=shelterLayout(build.design),origin=build.origin
   start={x:origin.x+layout.door.x+0.5,y:origin.y+layout.door.y+0.5,z:origin.z+layout.door.z+0.5}
   end=corridorPoint(origin,layout,depth)
  }
 }catch{
  // Without a corridor only what is actually near the bot can block departure.
  return {blocking:entities.filter(e=>!e.position||!p||distance(e.position,p)<=24).map(e=>({name:e.name,reason:'departure corridor is unavailable'})),peripheral:[]}
 }
 const blocking=[],peripheral=[]
 for(const e of entities){
  if(!e.position){blocking.push({name:e.name,reason:'entity position is unknown'});continue}
  const distanceFromBot=p?distance(e.position,p):Infinity
  if(distanceFromBot>24)continue
  const d=corridorDistance(e.position,start,end),near=d.along>=-1&&d.along<=depth+2&&d.lateral<=radius&&Math.abs(e.position.y-start.y)<=3
  const item={name:e.name,distance:Math.round(distanceFromBot*10)/10,position:{x:e.position.x,y:e.position.y,z:e.position.z},corridor:near?'departure':'peripheral'}
  ;(near?blocking:peripheral).push(item)
 }
 return {blocking,peripheral}
}
