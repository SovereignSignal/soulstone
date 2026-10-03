// The back exit: one reserved interior floor cell a shaft goes down through,
// so a camping creeper or the night does not hold the bot behind its one door.
// Step 1 of workstreams/minecraft/back-exit-plan.md. The dig and the cap come next.
import {shelterLayout} from './shelter.js'
// The interior cell farthest from the door that no station stands on. Once
// chosen it is kept, so the shaft is always the same hole.
export function shaftCell(project){
 const build=project?.build
 if(!build?.design||!build.origin)throw new Error('A back exit needs a saved base')
 const kept=project.stations?.shaft?.position
 if(kept)return {x:kept.x,y:kept.y,z:kept.z}
 const layout=shelterLayout(build.design),o=build.origin
 const taken=new Set(Object.values(project.stations||{}).map(s=>s?.position).filter(Boolean).map(p=>`${p.x},${p.z}`))
 const free=layout.inside.filter(c=>!taken.has(`${c.x+o.x},${c.z+o.z}`))
 if(!free.length)throw new Error('A back exit needs a free interior floor cell, and every one holds a station')
 const away=c=>Math.abs(c.x-layout.door.x)+Math.abs(c.z-layout.door.z)
 free.sort((a,b)=>away(b)-away(a)||a.x-b.x||a.z-b.z)
 return {x:free[0].x+o.x,y:o.y,z:free[0].z+o.z}
}
