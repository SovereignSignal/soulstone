// The `use` action: hold an item and use it, on a block face or in the air.
//
// Every shared activate path in this tree unequips first, so nothing could use a
// held item on a block and a nether portal could not be lit. The executor was
// always capable: mineflayer's placement writes a block_place packet carrying the
// held item and a face cursor. What was missing was a name for it.
//
// One use per step, one receipt. `how` picks click-a-block or point-in-air.
// `dimension` is not optional: task-store's goal bounds admit an Overworld
// coordinate in the Nether, where it resolves to real loaded netherrack, so a
// dimensionless target would happily set the wrong world on fire.

import {Vec3} from 'vec3'
import {fullCube} from './construction.js'
import {blockKind} from './building-blocks.js'
import {STATIONS} from './stations.js'
import {remainingDurability} from './supplies.js'
import {blockNeighbors} from './observations.js'
import pathfinding from 'mineflayer-pathfinder'
const {goals}=pathfinding
const AIR=new Set(['air','cave_air','void_air'])
// prismarine-world BlockFace and mineflayer's vectorToDirection agree on this
// ordering; it is also GoalPlaceBlock's default face list.
const FACE=[new Vec3(0,-1,0),new Vec3(0,1,0),new Vec3(0,0,-1),new Vec3(0,0,1),new Vec3(-1,0,0),new Vec3(1,0,0)]
const AROUND=[[0,0,0],[0,-1,0],[0,1,0],[0,0,-1],[0,0,1],[-1,0,0],[1,0,0]]

import {dimensionOf} from './dimension.js'
export {dimensionOf}
const key=p=>`${p.x}, ${p.y}, ${p.z}`
// The server measures reach from the eyes: a target below the bot is further than its feet say.
const eye=bot=>bot.entity.position.offset(0,bot.entity.eyeHeight||1.62,0)
// Point mode writes use_item, which the server raycasts. Only buckets need it,
// because BucketItem implements Item.use() and never useOn, so a click at a
// water cell does nothing at all. Gated by mechanism, not by prose in a prompt.
// Removal condition: when a second item family genuinely needs use_item it earns
// its own predicate or its own action. This never grows into a maintained list.
const POINTABLE=name=>name==='bucket'||name.endsWith('_bucket')

// Mirrors the bounds in task-store.js:19, which is the source of truth. Imported
// back would make an ESM cycle (task-store imports this), so the duplication is
// deliberate and a test asserts the two agree.
const MAX_HORIZONTAL = 29999900, MIN_Y = -64, MAX_Y = 320
export const USE_MODES = ['click', 'point']
export const DIMENSIONS = ['overworld', 'the_nether', 'the_end']

export function validateUseStep(s) {
  if (!/^[a-z0-9_]{1,64}$/.test(s.item || '')) throw new Error('Use needs the carried item ID it will hold')
  // One use, one receipt. Twelve end portal frames are twelve steps across
  // planning rounds, never a count: `count` is not a repeat and must never
  // become one, or a charged item would reinterpret it as hold-ticks.
  if (s.count !== 1) throw new Error('One use per step. A plan carries at most eight steps, so a long sequence spans planning rounds.')
  if (Array.isArray(s.design) && s.design.length) throw new Error('Use carries no design')
  const t = s.target
  if (!t || typeof t !== 'object' || Object.keys(t).length !== 5 || !['x', 'y', 'z'].every(k => Number.isSafeInteger(t[k])) ||
      !USE_MODES.includes(t.how) || !DIMENSIONS.includes(t.dimension))
    throw new Error('A use target is {x,y,z,how,dimension}: how "click" or "point", dimension overworld, the_nether or the_end')
  if (Math.abs(t.x) > MAX_HORIZONTAL || Math.abs(t.z) > MAX_HORIZONTAL || t.y < MIN_Y || t.y > MAX_Y)
    throw new Error('Use target outside supported world bounds')
  // Pointing uses the item at nothing in particular; the server decides where
  // the effect lands, so declaring an expected block there would be a promise
  // the executor cannot keep.
  if (t.how === 'point' && s.name) throw new Error('A pointed use cannot declare an expected block: the server chooses where the effect lands.')
}

export function parseBlockState(text){
 const m=/^([a-z0-9_]{1,64})(?:\[([a-z0-9_]+=[a-z0-9_]+(?:,[a-z0-9_]+=[a-z0-9_]+)*)\])?$/.exec(text||'')
 if(!m)throw new Error('Expected outcome must be a block ID, optionally with [state=value] pairs')
 // Null prototype: a model-supplied state named __proto__ must not reach Object.prototype.
 const properties=Object.create(null)
 for(const pair of m[2]?.split(',')||[]){
  const [k,v]=pair.split('=')
  if(Object.hasOwn(properties,k))throw new Error('Duplicate block state '+k)
  properties[k]=v
 }
 return {block:m[1],properties}
}
// getProperties() returns booleans and numbers, so compare as strings. The
// optional call is load-bearing: the companion test mocks define blockAt
// without getProperties, and a bare call would TypeError rather than fail.
// Accepts either a live block (getProperties()) or a receipt's observed record
// ({name,state}), because block_at matches expectations against both.
export const matchesExpected=(b,e)=>b?.name===e.block&&
 Object.entries(e.properties).every(([k,v])=>String((b.getProperties?.()??b.state??{})[k])===v)

export function validateUseGoal(goal){
 validateUseStep({item:goal?.item,count:goal?.count,name:goal?.expect??'',target:goal?.target})
 if(goal.expect)parseBlockState(goal.expect)
 if(goal.protectedSites!==undefined){
  if(!Array.isArray(goal.protectedSites)||goal.protectedSites.length>128)throw new Error('Invalid protected construction sites')
  for(const site of goal.protectedSites)
   if(!site||!['minX','maxX','minZ','maxZ'].every(k=>Number.isInteger(site[k])&&Math.abs(site[k])<=29999900)||site.minX>site.maxX||site.minZ>site.maxZ)
    throw new Error('Invalid protected construction rectangle')
 }
 return {item:goal.item,count:1,expect:goal.expect??'',target:{...goal.target},...(goal.protectedSites?{protectedSites:goal.protectedSites}:{})}
}

// The three item guards are ownership claims, not a taxonomy: each names a verb
// that can already do the job. Items with no owner (lantern, slabs, fences) are
// deliberately allowed through rather than refused, because refusing something
// nothing else can place is an unsatisfiable condition, which is this
// codebase's signature defect. `use` places them, does not verify them, and the
// receipt says exactly what moved.
function assertUsableItem(bot,item){
 if(!bot.registry.itemsByName[item])throw new Error(`${item} is unavailable in this version`)
 if(fullCube(bot.registry,item))throw new Error(`${item} is a full solid block; build and construct place it and check the site and footprint`)
 if(blockKind(item))throw new Error(`${item} is an oriented placement; construct and place own doors, gates, stairs, beds and torches, with their orientation and lighting checks`)
 if(STATIONS.includes(item))throw new Error(`${item} is a base workstation; use place`)
}

// A standard ten-obsidian frame is a safe exception to project protection:
// only its empty interior can be ignited, never arbitrary air in a saved build.
function protectedPortalIgnition(bot,goal){
 if(goal.item!=='flint_and_steel'||goal.expect!=='nether_portal'||goal.target.how!=='click'||goal.target.dimension!=='overworld')return false
 const p=new Vec3(goal.target.x,goal.target.y,goal.target.z)
 for(const [dx,dz] of [[1,0],[0,1]])for(const offset of [0,1]){
  const at=(u,y)=>bot.blockAt(p.offset(dx*(u-offset),y,dz*(u-offset)))?.name
  let valid=true
  for(let u=0;u<2;u++)if(at(u,-1)!=='obsidian'||at(u,3)!=='obsidian')valid=false
  for(let y=0;y<3;y++){
   if(at(-1,y)!=='obsidian'||at(2,y)!=='obsidian')valid=false
   for(let u=0;u<2;u++)if(!AIR.has(at(u,y))&&at(u,y)!=='nether_portal')valid=false
  }
  if(valid)return true
 }
 return false
}

// `approach` is injected rather than imported: world-skills owns approachPlacement
// and is the caller, so importing it here would make an ESM cycle.
export async function useHeldItem(bot,task,{check,walk,settle,stage,persist,approach}){
 const goal=task.goal,{item}=goal,t=goal.target,p=new Vec3(t.x,t.y,t.z)
 // 1. READ THE PROOF SITE FIRST. No proof site, no packet: that is what makes a
 // silent no-op impossible by construction instead of by diligence.
 const here=dimensionOf(bot)
 if(here&&here!==t.dimension)throw new Error(`This use targets ${t.dimension} and the agent is in ${here}. Coordinates are not shared between dimensions; travel to ${t.dimension} first.`)
 if(!bot.blockAt(p))throw new Error(`Cannot read ${key(p)}: that chunk is not loaded, so no use there can be proven. Travel within 32 blocks of it and re-observe.`)
 // 2. Guards that can refuse without touching the world.
 assertUsableItem(bot,item)
 if(t.how==='point'&&!POINTABLE(item))throw new Error(`Point mode writes use_item, which for ${item} is not a block interaction. Only buckets need it: use how "click".`)
 if(!bot.inventory.items().some(i=>i.name===item))throw new Error(`${item} is not carried. Acquire or withdraw it first.`)
 if(bot.currentWindow)throw new Error('A container is already open; chests, furnaces and crafting tables belong to the base actions.')
 // The task's own latch, not just the controller's feedback scan: a task
 // restored from disk after a restart carries the latch and no feedback at all.
 if(task.use?.uncertain&&task.use.item===item&&JSON.stringify(task.use.target)===JSON.stringify(t))
  throw new Error(`This ${item} at ${key(p)} was already charged without a confirmed effect. Re-observe that block before using there again.`)
 const protectedTarget=(goal.protectedSites||[]).some(site=>t.x>=site.minX&&t.x<=site.maxX&&t.z>=site.minZ&&t.z<=site.maxZ)
 const checkProjectUse=()=>{
  if(protectedTarget&&!protectedPortalIgnition(bot,goal))
   throw new Error(`${key(p)} is inside a saved project footprint; use requires a complete standard obsidian portal frame and an explicit portal ignition expectation, or a cell outside the saved build.`)
 }
 checkProjectUse()
 check()
 // 4. PRE-EVALUATE the expectation. One predicate, two jobs: idempotence before
 // the interaction, the receipt after it. Without this a replan walking twelve
 // end portal frames spends an eye on one that is already filled.
 const expect=goal.expect?parseBlockState(goal.expect):null
 if(expect&&matchesExpected(bot.blockAt(p),expect))
  return {item,count:1,target:{...t},expect:goal.expect,receipt:'use_already_satisfied',
   observed:{name:bot.blockAt(p).name,state:{...(bot.blockAt(p).getProperties?.()??{})}},changed:[]}
 // 5. Approach and aim. The cell decides the strategy, never the item: an item
 // table would have to know what everything aims at, and the world already does.
 let send
 if(t.how==='point'){
  await walk(new goals.GoalNear(p.x,p.y,p.z,2));check()
  if(eye(bot).distanceTo(p.offset(.5,.5,.5))>4.5)throw new Error(`Cannot reach ${key(p)} to point at it; the server raycasts about 4.5 blocks from the eyes along the look vector. Travel closer and repeat the use.`)
  // The server raycasts along the look vector, so the orientation has to reach
  // it before use_item does. Sending both in one tick let the server raycast on
  // the previous orientation: on a real server a bucket fill worked, then did
  // nothing, then worked. A settled look makes it ordering rather than luck.
  send=async()=>{try{await bot.lookAt(p.offset(.5,.5,.5),false);await bot.waitForTicks(1);bot.activateItem()}finally{bot.deactivateItem()}}
 }else{
  const target=bot.blockAt(p)
  if(AIR.has(target.name)){
   const found=await approach(bot,new goals.GoalPlaceBlock(p,bot.world,{range:4.5}),g=>walk(g,false),check)
   send=async()=>{await bot._genericPlace(bot.blockAt(found.ref),found.face.scaled(-1),{delta:found.to.minus(found.ref),swingArm:'right'})}
  }else if((target.shapes||[]).length){
   await walk(new goals.GoalLookAtBlock(p,bot.world,{reach:3}));check()
   const eye=bot.entity.position.offset(0,1.62,0)
   const hit=bot.world.raycast(eye,p.offset(.5,.5,.5).minus(eye).normalize(),5)
   if(!hit)throw new Error(`No line of sight to ${key(p)}: something is between the agent and it. Move to a stance that can see the face and repeat the use.`)
   send=async()=>{await bot._genericPlace(bot.blockAt(p),FACE[hit.face],{delta:hit.intersect.minus(p),swingArm:'right'})}
  }else{
   // A collision raycast can never finish against something with no shape.
   await walk(new goals.GoalNear(p.x,p.y,p.z,2));check()
   if(eye(bot).distanceTo(p.offset(.5,.5,.5))>4.5)throw new Error(`Cannot reach ${key(p)}; travel closer and repeat the use.`)
   send=async()=>{await bot._genericPlace(bot.blockAt(p),new Vec3(0,1,0),{swingArm:'right'})}
  }
 }
 // 6. Snapshot the two channels. Flint and steel changes no inventory count, so
 // for the most important use in the tree durability is the only second witness.
 const readScene=()=>AROUND.map(([dx,dy,dz])=>{const q=p.offset(dx,dy,dz),b=bot.blockAt(q)
  return {x:q.x,y:q.y,z:q.z,name:b?.name??null,state:{...(b?.getProperties?.()??{})}}})
 const readSpend=()=>{const counts={};let durability=null
  for(const i of bot.inventory.items()){
   counts[i.name]=(counts[i.name]||0)+i.count
   // Summed across every copy, not read from one slot. Durable items do not
   // stack, so carrying four flint and steels means four slots, and reading an
   // arbitrary one missed the damage: the live portal lab reported 64 -> 64
   // while the server had charged one. Flint and steel changes no inventory
   // count, so this is the only second witness that use has.
   if(i.name===item&&i.maxDurability)durability=(durability??0)+remainingDurability(i)
  }
  return {counts,durability}}
 const before={scene:readScene(),spend:readSpend()}
 // 7. Latch BEFORE the packet: if the process dies mid-use, the restart must
 // know a use was in flight and may have landed.
 task.use={item,target:{...t},expect:goal.expect??'',before,uncertain:true};persist()
 // 8. Equip and send exactly one packet.
 const held=bot.inventory.items().find(i=>i.name===item)
 await bot.equip(held,'hand');check();stage('using')
 checkProjectUse()
 await send();check()
 if(bot.currentWindow){bot.closeWindow?.(bot.currentWindow)
  throw new Error(`Using ${item} at ${key(p)} opened a container; chests, furnaces and crafting tables belong to the base actions.`)}
 // 9. Settle. A failure to settle is not an error here: the after-state is what
 // classifies, and "it never changed" is one of the six legitimate outcomes.
 const moved=()=>JSON.stringify(readScene())!==JSON.stringify(before.scene)||JSON.stringify(readSpend())!==JSON.stringify(before.spend)
 try{await settle(()=>expect?matchesExpected(bot.blockAt(p),expect):moved(),'unsettled')}catch{}
 // 10. Classify.
 const after={scene:readScene(),spend:readSpend()}
 const changed=[]
 for(let i=0;i<after.scene.length;i++){
  const b=before.scene[i],a=after.scene[i]
  if(a.name!==b.name||JSON.stringify(a.state)!==JSON.stringify(b.state))
   changed.push({x:a.x,y:a.y,z:a.z,from:b.name,fromState:b.state,to:a.name,toState:a.state})
 }
 const spendMoved=JSON.stringify(after.spend)!==JSON.stringify(before.spend)
 const gained={};for(const [k,v] of Object.entries(after.spend.counts))if(v!==(before.spend.counts[k]||0))gained[k]=v-(before.spend.counts[k]||0)
 for(const k of Object.keys(before.spend.counts))if(!(k in after.spend.counts))gained[k]=-before.spend.counts[k]
 const obs=bot.blockAt(p)
 const base={item,count:1,target:{...t},expect:goal.expect??'',
  observed:{name:obs?.name??null,state:{...(obs?.getProperties?.()??{})}},changed,
  spent:{item,before:before.spend.counts[item]??0,after:after.spend.counts[item]??0,durabilityBefore:before.spend.durability,durabilityAfter:after.spend.durability},gained}
 const clear=()=>{task.use.uncertain=false;persist()}
 if(expect){
  if(matchesExpected(obs,expect)){clear();return {...base,receipt:'use_effect_observed'}}
  clear()
  // Accurate and unrecoverable is the climb-on-a-pillar shape: a fire we started
  // and then walked away from is exactly that. One bounded attempt to undo it.
  let extinguished=null
  if(obs?.name==='fire'&&expect.block!=='fire'){try{await bot.dig(obs);extinguished=true}catch{extinguished=false}}
  throw new Error(`Use of ${item} expected ${goal.expect} at ${key(p)}; observed ${obs?.name??'unloaded terrain'}.`+
   (extinguished===null?'':` The fire it started ${extinguished?'was put out':'could not be put out'}.`))
 }
 // Filling a bucket is proven by the transmutation alone: an infinite source
 // still reads `water` afterwards, and water flowing nearby changes the scene
 // every tick, so a scene change without a filled bucket is no fill at all
 // (trial 24 reported three fills with the bucket still empty). Emptying one
 // is the other way round: a pour that landed anywhere, or evaporated in the
 // Nether, transmutes identically, so it needs the scene.
 if(item==='bucket'){
  if(spendMoved){clear();return {...base,receipt:'use_change_observed'}}
  clear()
  throw new Error(`The bucket was not filled at ${key(p)}${changed.length?': water moved nearby, but a bucket fills only from a source it hits':''}. Aim at a water or lava source cell with nothing in between.`)
 }
 if(changed.length){clear();return {...base,receipt:'use_change_observed'}}
 if(spendMoved){task.use.uncertain=true;persist()
  return {...base,receipt:'use_effect_unobserved',partial:true,next:'Re-observe the target block and the inventory'}}
 clear()
 throw new Error(`Use of ${item} at ${key(p)} changed nothing observable and spent nothing: the interaction did not happen. Check the aim, the carried item and whether the target accepts it, then try a different approach.`)
}

// What a `use` can plausibly aim at. Defaults are the dragon-path blocks plus
// farmland; the goal's own block_at criteria add whatever this request is about,
// so the channel follows the work instead of being a fixed list someone has to
// keep extending. Its removal condition: when a general "name a block, get its
// coordinates" observation exists, USE_DEFAULT_TARGETS and useTargetNames both delete.
export const USE_DEFAULT_TARGETS=['obsidian','end_portal_frame','nether_portal','end_portal','farmland']
// A bucket can only fill from a source cell. The nearest water is usually
// flowing, and sending the agent to fill from a stream wastes the trip.
export const USE_FLUIDS=['water','lava']
const SCAN_LIMIT=64,SCAN_RANGE=32

export function useTargetNames(goal){
 const named=(goal?.criteria||[]).filter(c=>c.kind==='block_at'&&c.item)
  .map(c=>{try{return parseBlockState(c.item).block}catch{return null}}).filter(Boolean)
 return [...new Set([...USE_DEFAULT_TARGETS,...named])]
}

export function interactableObservation(bot,{names=USE_DEFAULT_TARGETS}={}){
 if(!bot?.registry?.blocksByName||!bot.findBlocks)return {status:'unknown',blocks:[],nearestSource:{},truncated:false,
  scope:'No loaded world to scan; absence here is not evidence.'}
 const here=bot.entity?.position,blocks=[],nearestSource={}
 let truncated=false
 const scan=name=>{
  const id=bot.registry.blocksByName[name]?.id
  if(id===undefined)return []
  const found=bot.findBlocks({matching:id,maxDistance:SCAN_RANGE,count:SCAN_LIMIT})||[]
  if(found.length>=SCAN_LIMIT)truncated=true
  return found
 }
 for(const name of names)for(const p of scan(name)){
  const b=bot.blockAt(p)
  if(!b)continue
  blocks.push({name:b.name,x:p.x,y:p.y,z:p.z,state:{...(b.getProperties?.()??{})},neighbors:blockNeighbors(bot,p)})
 }
 for(const fluid of USE_FLUIDS){
  const sources=scan(fluid).map(p=>({p,b:bot.blockAt(p)}))
   .filter(({b})=>b&&String(b.getProperties?.()?.level??'')==='0')
   .sort((a,c)=>(here?a.p.distanceTo(here)-c.p.distanceTo(here):0))
  if(sources.length)nearestSource[fluid]={x:sources[0].p.x,y:sources[0].p.y,z:sources[0].p.z,neighbors:blockNeighbors(bot,sources[0].p)}
 }
 return {status:'observed',blocks,nearestSource,truncated,
  scope:`Loaded blocks within ${SCAN_RANGE} blocks only; presence does not prove access. neighbors counts the six adjacent block names (unknown is unloaded; waterlogged counts overlap). A source can be sealed in rock. A bucket needs an exposed source and a clear reachable aim; mining refuses liquid-adjacent blocks. Absence is local evidence, not proof.`}
}
