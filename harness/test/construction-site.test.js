import test from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import {inProtectedSite} from '../src/primitives.js'
import {Vec3} from 'vec3'
import {fitConstructionSite} from '../src/construction-site.js'
import {compileArchitecture,executeConstruction} from '../src/construction.js'
import {surveyGround,candidateSites,projectFootprints} from '../src/site-survey.js'
import {validateTaskGoal} from '../src/task-store.js'
const registry=minecraftData('1.21.4'),r=(x,y,z,x2,y2,z2,block)=>({x,y,z,x2,y2,z2,block})
const design=[r(0,0,0,2,0,2,'spruce_planks'),r(0,1,0,0,1,0,'checkpoint'),r(2,1,2,2,1,2,'checkpoint')]
function fixture(){
 const placed=new Map(),key=p=>p.toString(),surface=x=>64+Math.abs(x%2)
 const bot={registry,players:{},entity:{position:new Vec3(0,73,0),onGround:true},inventory:{items:()=>[{name:'spruce_planks',count:20},{name:'cobblestone',count:20}]},blockAt:p=>placed.get(key(p))||{position:p,name:p.y<=surface(p.x)?'stone':'air',boundingBox:p.y<=surface(p.x)?'block':'empty'}}
 return {bot,placed,key}
}
test('roof-height owner survey fits uneven natural ground and reserves a foundation without world writes',async()=>{
 const f=fixture(),bp=compileArchitecture(design),site=fitConstructionSite(f.bot,bp,f.bot.entity.position)
 assert.ok(site);assert.equal(site.elevationOffset,1);assert.ok(site.foundationBlocks>0)
 const fitted=compileArchitecture(site.design);assert.equal(fitted.blocks.length,bp.blocks.length+site.foundationBlocks)
 for(const b of fitted.blocks)assert.equal(f.bot.blockAt(new Vec3(site.origin.x+b.x,site.origin.y+b.y,site.origin.z+b.z)).name,'air')
 let writes=0;const task={kind:'construct',goal:{name:'storehouse',design,near:f.bot.entity.position}}
 const api={check(){},persist(){},progress(){},chooseSite:(near,b)=>fitConstructionSite(f.bot,b,near),place:async()=>{writes++}}
 const planned=await executeConstruction(f.bot,task,api)
 assert.equal(writes,0);assert.equal(planned.partial,true);assert.equal(planned.placed,0);assert.equal(planned.missingMaterials.cobblestone,site.foundationBlocks)
 const saved=validateTaskGoal('construct',JSON.parse(JSON.stringify(task.goal)));assert.deepEqual(saved.origin,site.origin);assert.deepEqual(saved.design,site.design)
 api.place=async(p,name)=>{writes++;f.placed.set(f.key(p),{position:p,name,boundingBox:'block'})};api.walk=async g=>{f.bot.entity.position=new Vec3(g.x,g.y,g.z)};api.settle=async p=>assert.ok(p())
 const complete=await executeConstruction(f.bot,task,api);assert.equal(complete.partial,false);assert.equal(writes,fitted.blocks.length);assert.equal(complete.walkthrough.length,2)
})
test('site selection excludes recorded buildings/stations, players and liquids',()=>{
 const f=fixture(),bp=compileArchitecture(design),near=f.bot.entity.position
 assert.equal(fitConstructionSite(f.bot,bp,near,[{minX:-30,maxX:30,minZ:-30,maxZ:30}]),null)
 const footprint=projectFootprints({base:{build:{origin:{x:10,y:64,z:10},design},stations:{chest:{position:{x:15,y:64,z:12}}}}})
 assert.deepEqual(footprint,[{minX:10,maxX:12,minZ:10,maxZ:12,minY:63},{minX:15,maxX:15,minZ:12,maxZ:12,minY:63}])
 // The footprint has a floor: the build, the layer it stands on and its
 // stations are protected; the ground under that is free to dig (lab run 25,
 // 3 October: the back exit's work nine cells under the base was refused).
 assert.equal(inProtectedSite({x:11,y:63,z:11},footprint),true,'the support layer');assert.equal(inProtectedSite({x:11,y:70,z:11},footprint),true,'above the build')
 assert.equal(inProtectedSite({x:11,y:62,z:11},footprint),false,'under the support layer');assert.equal(inProtectedSite({x:15,y:58,z:12},footprint),false,'under a station')
 assert.equal(inProtectedSite({x:11,y:50,z:11},[{minX:10,maxX:12,minZ:10,maxZ:12}]),true,'a site without a floor still protects its whole column')
 const survey=surveyGround(f.bot,near),sites=candidateSites(survey,bp.bounds,{players:[{x:0,y:66,z:0}]})
 assert.ok(sites.every(s=>!(0>s.origin.x-1&&0<s.origin.x+4&&0>s.origin.z-1&&0<s.origin.z+4)))
 const original=f.bot.blockAt;f.bot.blockAt=p=>({...original(p),name:p.y<=65?'water':'air',boundingBox:'empty'})
 assert.equal(fitConstructionSite(f.bot,bp,near),null)
})
test('protected-site state survives validation and rejects malformed bounds',()=>{
 const goal={name:'storehouse',design,near:{x:0,y:64,z:0},protectedSites:[{minX:1,maxX:4,minZ:2,maxZ:6}]}
 assert.deepEqual(validateTaskGoal('construct',goal).protectedSites,goal.protectedSites)
 assert.throws(()=>validateTaskGoal('construct',{...goal,protectedSites:[{minX:5,maxX:1,minZ:0,maxZ:1}]}),/rectangle/)
})

test('terrain foundations respect material and total-block constraints before reserving a site',()=>{
 const f=fixture(),bp=compileArchitecture(design)
 const site=fitConstructionSite(f.bot,bp,f.bot.entity.position,[],{materials:['spruce_planks'],maxBlocks:20})
 assert.ok(site);assert.ok(compileArchitecture(site.design).blocks.every(b=>b.block==='spruce_planks'))
 assert.equal(fitConstructionSite(f.bot,bp,f.bot.entity.position,[],{maxBlocks:9}),null)
 assert.equal(fitConstructionSite(f.bot,bp,f.bot.entity.position,[],{materials:[]}),null)
})

test('site selection includes entrance checkpoints outside the placed footprint',()=>{
 const bp=compileArchitecture([r(0,0,0,2,0,2,'spruce_planks'),r(0,0,-1,0,0,-1,'checkpoint'),r(1,1,1,1,1,1,'checkpoint')])
 const bot={registry,players:{},blockAt:p=>{const solid=p.y===64&&p.x>=0&&p.x<=8&&p.z>=0&&p.z<=8;return {position:p,name:solid?'stone':'air',boundingBox:solid?'block':'empty'}}}
 const site=fitConstructionSite(bot,bp,new Vec3(4.5,65,.5));assert.ok(site)
 assert.ok(site.origin.z>=1,'Entrance must land on the pad, not beyond its edge')
})

test('a site that fits the structure but cannot support its entrance is rejected',()=>{
 const bp=compileArchitecture([r(0,0,0,2,0,2,'spruce_planks'),r(0,0,-1,0,0,-1,'checkpoint'),r(1,1,1,1,1,1,'checkpoint')])
 const bot={registry,players:{},blockAt:p=>{const solid=p.y===64&&p.x>=0&&p.x<=8&&p.z>=0&&p.z<=2;return {position:p,name:solid?'stone':'air',boundingBox:solid?'block':'empty'}}}
 assert.equal(fitConstructionSite(bot,bp,new Vec3(4.5,65,.5)),null)
})
