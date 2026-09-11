import {withStationWindow} from './stations.js'
import {Vec3} from 'vec3'
import pathfinding from 'mineflayer-pathfinder'
const {goals}=pathfinding
const facings={north:new Vec3(0,0,-1),south:new Vec3(0,0,1),east:new Vec3(1,0,0),west:new Vec3(-1,0,0)}
const yaw={north:0,south:Math.PI,east:-Math.PI/2,west:Math.PI/2}
export const blockKind=name=>name==='torch'?'light':name.endsWith('_fence_gate')?'gate':name.endsWith('_door')?'door':name.endsWith('_stairs')?'stairs':name.endsWith('_bed')?'bed':null
export function parseBuildingBlock(text) {
 const m=/^([a-z0-9_]{1,64})(?:\[([a-z_=,]+)\])?$/.exec(text||'')
 if(!m)throw new Error('Invalid architecture material or block states')
 const block=m[1],kind=blockKind(block),properties=Object.create(null)
 for(const entry of m[2]?.split(',')||[]){const pair=entry.split('=');if(pair.length!==2||Object.hasOwn(properties,pair[0]))throw new Error('Invalid or duplicate block state');properties[pair[0]]=pair[1]}
 if(!kind){if(m[2])throw new Error('Block states supported only for doors, gates, stairs and beds');return {block}}
 if(kind==='light'){if(m[2])throw new Error('Floor torches have no configurable states');return {block}}
 if(block==='iron_door')throw new Error('Iron doors need redstone; use a hand-operated door')
 if(!Object.hasOwn(facings,properties.facing)||Object.keys(properties).some(k=>k!=='facing'&&!(kind==='stairs'&&k==='half')))throw new Error('Doors/gates/stairs/beds require facing=north|south|east|west; stairs optionally half=bottom')
 if(kind==='stairs'&&properties.half&&properties.half!=='bottom')throw new Error('Only bottom-half stairs are currently supported')
 return {block,properties:{facing:properties.facing,...(kind==='bed'?{part:'foot',occupied:false}:kind==='stairs'?{half:'bottom',shape:'straight',waterlogged:false}:{open:false,powered:false,...(kind==='door'?{half:'lower'}:{})})}}
}
export function matchesBuildingBlock(actual,expected,{ignoreOpen=false}={}) {
 return actual?.name===expected.block&&Object.entries(expected.properties||{}).every(([k,v])=>{
  const value=actual.getProperties?.()[k]
  // Vanilla can reverse a gate's facing when opening from the other side.
  // The passage axis remains invariant; perpendicular rotation is a defect.
  if(k==='facing'&&blockKind(expected.block)==='gate')return Object.hasOwn(facings,value)&&Math.abs(facings[value].x)===Math.abs(facings[v].x)
  return ignoreOpen&&k==='open'||value===v
 })
}
export function validateBuildingBlock(registry,b,fullCube) {
 const kind=blockKind(b.block),entry=registry.blocksByName[b.block]
 if(!entry||!registry.itemsByName[b.block]||(!kind&&!fullCube(registry,b.block)))throw new Error('Unsupported construction material: '+b.block)
 if(kind)for(const [name,value] of Object.entries(b.properties||{})){
  const state=entry.states?.find(s=>s.name===name)
  if(!state||state.values&&!state.values.includes(String(value)))throw new Error(`This version cannot represent ${b.block} ${name}=${value}`)
 }
}
export function setPlacementSneaking(bot,enabled) {
 bot.setControlState('sneak',enabled)
 // Mineflayer 4.38 sends only player_input on 1.21.3–1.21.5, although
 // these protocols still carry numeric start/stop sneak entity actions.
 // Remove this supplement when the pinned upstream implementation is fixed.
 if(bot.supportFeature?.('newPlayerInputPacket')&&!bot.supportFeature('entityActionUsesStringMapper'))bot._client.write('entity_action',{entityId:bot.entity.id,actionId:enabled?0:1,jumpBoost:0})
}
export async function placeBuildingBlock(bot,pos,b,{walk,check,stage,settle,approach}) {
 const existing=bot.blockAt(pos)
 if(matchesBuildingBlock(existing,b,{ignoreOpen:true}))return
 if(existing?.name!=='air')throw new Error('Stateful placement is obstructed; inspect the existing block before repair')
 if(blockKind(b.block)==='door'&&bot.blockAt(pos.offset(0,1,0))?.name!=='air')throw new Error('Door needs a clear upper half')
 if(blockKind(b.block)==='bed'&&bot.blockAt(pos.plus(facings[b.properties.facing]))?.name!=='air')throw new Error('Bed needs a clear head cell')
 // Only floor-supported bottom stairs and doors/gates. Keep the target outside
 // the player's body, prove a visible support face, then preserve explicit yaw.
 const goal=new goals.GoalPlaceBlock(pos,bot.world,{range:4.5,faces:[new Vec3(0,-1,0)]})
 const face=await approach(bot,goal,walk,check)
 const item=bot.inventory.items().find(i=>i.name===b.block&&i.count>0)
 if(!item)throw new Error('Missing '+b.block)
 await bot.equip(item,'hand');check();stage('placing')
 // Await the normal look acknowledgement: force=true returns before the
 // physics tick sends the rotation, so placement can use the previous yaw.
 if(blockKind(b.block)==='light'){
  // Sneak allows placement on a workstation without opening its window.
  setPlacementSneaking(bot,true)
  try{await bot.waitForTicks(1);check();await bot.placeBlock(bot.blockAt(face.ref),new Vec3(0,1,0));check()}finally{setPlacementSneaking(bot,false)}
  await settle(()=>matchesBuildingBlock(bot.blockAt(pos),b),'Server did not confirm floor torch');return
 }
 await bot.look(yaw[b.properties.facing],0);check()
 await bot._placeBlockWithOptions(bot.blockAt(face.ref),new Vec3(0,1,0),{forceLook:'ignore',swingArm:'right'})
 check();await settle(()=>matchesBuildingBlock(bot.blockAt(pos),b),`Server did not confirm ${b.block} orientation at ${pos}`)
}
export async function setPassageOpen(bot,pos,b,open,{check,walk,settle}) {
 const expected=[{pos,b},...(blockKind(b.block)==='door'?[{pos:pos.offset(0,1,0),b:{...b,properties:{...b.properties,half:'upper'}}}]:[])]
 const valid=()=>expected.every(e=>matchesBuildingBlock(bot.blockAt(e.pos),e.b,{ignoreOpen:true}))
 check();if(!valid())throw new Error('Passage block states changed')
 if(expected.every(e=>bot.blockAt(e.pos).getProperties().open===open))return
 // Open gates have no collision shape for GoalLookAtBlock's raycast.
 // Approach within interaction reach and require the server state change.
 await walk(bot.blockAt(pos).shapes?.length===0?new goals.GoalNear(pos.x,pos.y,pos.z,2):new goals.GoalLookAtBlock(pos,bot.world,{reach:3}));check()
 if(!valid())throw new Error('Passage changed while approaching')
 await bot.unequip('hand');check();await bot.activateBlock(bot.blockAt(pos));check()
 await settle(()=>valid()&&expected.every(e=>bot.blockAt(e.pos).getProperties().open===open),`Passage did not ${open?'open':'close'}`)
}
export const passagePoints=(pos,b)=>[pos.minus(facings[b.properties.facing]),pos,pos.plus(facings[b.properties.facing])]
export async function verifyPassage(bot,pos,b,api) {
 const [before,centre,after]=passagePoints(pos,b),visits=[]
 api.progress?.('Checking '+b.block+' open/close at '+pos)
 await setPassageOpen(bot,pos,b,false,api)
 await setPassageOpen(bot,pos,b,true,api)
 // Visit centre explicitly so reaching the far side via a detour cannot pass.
 for(const p of [before,centre,after,centre,before]){
  api.progress?.('Crossing '+b.block+' via '+p)
  await api.walk(new goals.GoalBlock(p.x,p.y,p.z));api.check()
  await api.settle(()=>bot.entity.onGround&&Math.abs(bot.entity.position.y-p.y)<.1&&bot.entity.position.distanceTo(p.offset(.5,0,.5))<.8,'Passage traversal did not reach its grounded checkpoint')
  visits.push({x:bot.entity.position.x,y:bot.entity.position.y,z:bot.entity.position.z})
 }
 await setPassageOpen(bot,pos,b,false,api)
 return {block:b.block,position:pos,opened:true,closed:true,visits}
}

export function companionCell(b) {
 const kind=blockKind(b.block)
 if(kind==='door')return {...b,y:b.y+1,properties:{...b.properties,half:'upper'}}
 if(kind==='bed'){const d=facings[b.properties.facing];return {...b,x:b.x+d.x,z:b.z+d.z,properties:{...b.properties,part:'head'}}}
 return null
}
export const isFurniture=b=>['crafting_table','furnace','barrel'].includes(b.block)||blockKind(b.block)==='bed'
export async function verifyFurniture(bot,pos,b,api) {
 if(blockKind(b.block)==='bed'){
  if(!['overworld','minecraft:overworld'].includes(bot.game?.dimension))throw new Error('Bed furnishing verification is supported only in the Overworld')
  const head=companionCell({...b,x:pos.x,y:pos.y,z:pos.z}),headPos=new Vec3(head.x,head.y,head.z)
  const valid=()=>matchesBuildingBlock(bot.blockAt(pos),b)&&matchesBuildingBlock(bot.blockAt(headPos),head)&&[pos,headPos].every(p=>bot.blockAt(p.offset(0,1,0))?.boundingBox==='empty')
  if(!valid())throw new Error('Bed halves, occupancy or headroom failed verification')
  await api.walk(new goals.GoalLookAtBlock(pos,bot.world,{reach:3}));api.check()
  await api.settle(()=>valid()&&bot.entity.onGround&&bot.entity.position.distanceTo(pos.offset(.5,0,.5))<=3,'Bed is not accessible')
  return {block:b.block,position:pos,receipt:'bed_assembled_and_accessible',sleepTested:false}
 }
 return withStationWindow(bot,b.block,pos,api,async w=>{
  if(b.block==='crafting_table'&&!/crafting/.test(w.type))throw new Error('Crafting window not confirmed')
  const contents=b.block==='barrel'?w.containerItems().map(i=>({name:i.name,count:i.count})):null
  return {block:b.block,position:pos,receipt:'workstation_opened',windowType:w.type,contents}
 })
}
