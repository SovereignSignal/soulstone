import assert from 'node:assert/strict'
import {compileArchitecture} from '../src/construction.js'
// Independent acceptance against the literal request, not just model criteria.
export async function verifyArchitecture(rcon,project,{palette,height,budget,pad}) {
 assert.ok(project?.construction?.origin&&project.result&&!project.result.partial,'Completed construction required')
 const bp=compileArchitecture(project.construction.design),origin=project.construction.origin
 assert.ok(bp.blocks.length<=budget,'Explicit block budget');assert.ok(bp.blocks.every(b=>b.block===palette),'Explicit palette')
 assert.ok(project.result.walkthrough.some(p=>p.y-origin.y>=height),'Actual access to explicit height')
 const solids=new Set(bp.blocks.map(p=>`${p.x},${p.y},${p.z}`))
 assert.ok(bp.blocks.some(p=>p.y+1>=height&&[[0,0],[1,0],[0,1],[1,1]].every(([dx,dz])=>solids.has(`${p.x+dx},${p.y},${p.z+dz}`)&&[1,2].every(dy=>!solids.has(`${p.x+dx},${p.y+dy},${p.z+dz}`)))),'Usable deck of at least two by two with headroom')
 const checks=project.result.walkthrough.flatMap(p=>[0,1].map(dy=>({x:Math.floor(p.x),y:Math.round(p.y)+dy,z:Math.floor(p.z),block:'air'})))
 const cells=[...bp.blocks.map(b=>({...b,x:b.x+origin.x,y:b.y+origin.y,z:b.z+origin.z})),...checks],serverBlocks=[]
 for(let i=0;i<cells.length;i+=16){const reply=await rcon('execute '+cells.slice(i,i+16).map(b=>`if block ${b.x} ${b.y} ${b.z} minecraft:${b.block}`).join(' ')+' run list');assert.match(reply,/players online/);serverBlocks.push({count:cells.slice(i,i+16).length,reply})}
 assert.ok(bp.blocks.every(p=>p.x+origin.x>=pad.minX&&p.x+origin.x<=pad.maxX&&p.z+origin.z>=pad.minZ&&p.z+origin.z<=pad.maxZ),'Construction fits the actual fixture pad')
 return {independentRequirementsPassed:true,blocks:bp.blocks.length,height:Math.max(...project.result.walkthrough.map(p=>p.y-origin.y)),design:bp.design,origin,serverBlocks}
}
