import {inBackExit} from './retreat.js'
import {remainingDurability,expeditionNeeds} from './supplies.js'
export {remainingDurability} from './supplies.js'
import {Vec3} from 'vec3'
import pathfinding from 'mineflayer-pathfinder'
import {setTimeout as delay} from 'node:timers/promises'
import {DoorAwareMovements,supportsPlayer,openDoorHasCenterClearance} from './navigation.js'
const {goals}=pathfinding
export const EXPEDITION_ACTIONS=['prospect','return_base']
export const ORE_SOURCES={cobblestone:['stone'],coal:['coal_ore','deepslate_coal_ore'],raw_iron:['iron_ore','deepslate_iron_ore'],raw_copper:['copper_ore','deepslate_copper_ore'],raw_gold:['gold_ore','deepslate_gold_ore'],diamond:['diamond_ore','deepslate_diamond_ore']}

// Starter supplies must be obtainable before torch preparation. This exception
// belongs to short, shallow cobblestone/coal trips, never a deep ore expedition.
export function starterBounds(bot,item,origin){
 if(!['cobblestone','coal'].includes(item)||bot.inventory.items().some(i=>i.name==='torch'&&i.count>0))return null
 return {x:[origin.x-24,origin.x+24],y:[origin.y-8,origin.y+3],z:[origin.z-24,origin.z+24]}
}
export const insideBounds=(p,bounds)=>!bounds||['x','y','z'].every(k=>Number.isFinite(p[k])&&p[k]>=bounds[k][0]&&p[k]<=bounds[k][1])
const terrain=new Set(['stone','deepslate','tuff','granite','diorite','andesite','calcite','dripstone_block','basalt','smooth_basalt','dirt','grass_block','coarse_dirt','podzol','rooted_dirt','mud','clay','sand','red_sand','gravel','sandstone','red_sandstone','terracotta',...Object.values(ORE_SOURCES).flat()])
const GRAVITY=new Set(['sand','red_sand','gravel','suspicious_sand','suspicious_gravel'])
const adjacent=[[0,1,0],[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]
const vec=p=>new Vec3(p.x,p.y,p.z)
const point=p=>({x:Math.floor(p.x),y:Math.floor(p.y),z:Math.floor(p.z)})
const key=p=>`${p.x},${p.y},${p.z}`
const clearAir=b=>b?.boundingBox==='empty'&&!['water','lava','fire','soul_fire','powder_snow'].includes(b.name)
export function protectedBase(p,project){
 const o=project.build.origin,design=project.build.design
 const xs=design.map(b=>b.x),zs=design.map(b=>b.z)
 if(p.x>=o.x+Math.min(...xs)-2&&p.x<=o.x+Math.max(...xs)+2&&p.z>=o.z+Math.min(...zs)-2&&p.z<=o.z+Math.max(...zs)+2&&p.y>=o.y-2&&p.y<=o.y+6)return true
 return Object.values(project.stations||{}).some(s=>Math.abs(p.x-s.position.x)<=1&&Math.abs(p.z-s.position.z)<=1&&p.y>=s.position.y-2&&p.y<=s.position.y+2)
}
export class ExcavationMovements extends DoorAwareMovements {
 constructor(bot,project,trail=[]){
  super(bot);this.project=project;this.trail=trail
  this.canDig=true;this.allow1by1towers=false;this.allowParkour=false;this.allowFreeMotion=false;this.allowSprinting=false
  this.scafoldingBlocks=[];this.maxDropDown=1;this.infiniteLiquidDropdownDistance=false
  this.exclusionAreasStep.push(b=>!b.position||this.liquids.has(b.type)||this.bounds&&['x','y','z'].some(k=>b.position[k]<this.bounds[k][0]||b.position[k]>this.bounds[k][1])?100:0)
 }
 // Cardinal stairs preserve headroom for the reverse journey. Never dig a
 // vertical shaft, bridge a void or use diagonal corner-cutting underground.
 getMoveDown(){}
 getMoveUp(){}
 getMoveDiagonal(){}
 safeToBreak(block){
  if(!block?.position||!insideBounds(block.position,this.limits)||!terrain.has(block.name)||protectedBase(block.position,this.project))return false
  // Sand or gravel above a stair cell drops into the cut and is cut again; the
  // executor confirms each cell. Only a cell in the bot's own column above its
  // feet is refused, where the fall would land on the bot.
  const above=this.bot.blockAt(block.position.offset(0,1,0)),feet=this.bot.entity?.position?.floored?.()
  if(above&&GRAVITY.has(above.name)&&feet&&block.position.x===feet.x&&block.position.z===feet.z&&block.position.y>=feet.y)return false
  const upstream=this.dontMineUnderFallingBlock;this.dontMineUnderFallingBlock=false
  try{if(!super.safeToBreak(block))return false}finally{this.dontMineUnderFallingBlock=upstream}
  if(this.trail.some(p=>p.x===block.position.x&&p.z===block.position.z&&p.y-1===block.position.y))return false
  if(Object.values(this.bot.players||{}).some(p=>p.entity&&supportsPlayer(block.position,p.entity.position)))return false
  for(const d of adjacent){const b=this.bot.blockAt(block.position.offset(...d));if(!b||this.liquids.has(b.type))return false}
  const harvest=Object.keys(block.harvestTools||{}).map(Number)
  return !harvest.length||this.bot.inventory.items().some(i=>harvest.includes(i.type)&&remainingDurability(i)>8)
 }
}
export async function excavationPath(bot,movements,start,goal,check){
 if(['x','y','z'].every(k=>Number.isFinite(goal[k]))){
  const pad=Math.max(8,Math.ceil(Math.abs(start.y-goal.y)/2)+2)
  movements.bounds=Object.fromEntries(['x','y','z'].map(k=>[k,[Math.min(start[k],goal[k])-(k==='y'?2:pad),Math.max(start[k],goal[k])+(k==='y'?3:pad)]]))
 }
 // Weighted A* prefers progress through diggable terrain. searchRadius is a
 // cost ceiling upstream, not a physical radius; spatial limits live above.
 const weighted=Object.create(goal);weighted.heuristic=node=>goal.heuristic(node)*5
 const iterator=bot.pathfinder.getPathFromTo(movements,start,weighted,{optimizePath:false,timeout:3500,tickTimeout:40,searchRadius:-1})
 let result
 do{check();result=iterator.next().value?.result;if(result?.status==='partial')await delay(0)}while(result?.status==='partial')
 check()
 if(result?.status!=='success'){
  const under=bot.blockAt?.(start.floored().offset(0,-1,0))?.name
  throw new Error(`No bounded excavation route (${result?.status||'unknown'})${under&&!terrain.has(under)?`; standing on ${under}, which the planner never cuts; start from exposed stone or soil`:''}`)
 }
 if(result.path.some(p=>p.toPlace?.length))throw new Error('Excavation route would require bridging')
 if(result.path.some(p=>!insideBounds(p,movements.limits)||(p.toBreak||[]).some(b=>!insideBounds(b,movements.limits))))throw new Error('Starter mining route exceeds shallow access bounds; try another nearby source')
 return result.path
}
export async function executeExpedition(bot,task,api){
 const {check,progress,stage,persist,walk,settle}=api,project=task.goal.project
 const state=project.expedition??={schema:1,trail:[],frontier:[],surveys:[],rejected:[]}
 const toolSignature=[...new Set(bot.inventory.items().filter(i=>i.maxDurability&&remainingDurability(i)>8).map(i=>i.name))].sort().join(',')
 if(state.toolSignature!==toolSignature){state.rejected=[];state.toolSignature=toolSignature}
 const count=n=>bot.inventory.items().filter(i=>i.name===n).reduce((a,i)=>a+i.count,0)
 // The outbound trip clock starts at the first new excavation step, so the
 // walk home or back out along a saved route never spends the trip's budget.
 let broken=0,steps=0,started=null;const tripElapsed=()=>Date.now()-(started??=Date.now())
 const save=()=>{task.progress={item:task.goal.item,count:count(task.goal.item),broken,steps,position:point(bot.entity.position),phase:state.phase};persist()}
 async function home(){
  state.phase='returning';save();progress('Retracing the cleared route to base')
  // Keep each waypoint until physical arrival is confirmed. Interrupted return
  // resumes from the same remaining route, without replaying a dig.
  while(state.trail.length){check();const p=state.trail.at(-1);if(invalidKnownWaypoint(bot,p)){state.trail.pop();state.routeRepairs=(state.routeRepairs||0)+1;save();continue}await walk(new goals.GoalBlock(p.x,p.y,p.z));state.trail.pop();save()}
  const station=project.stations?.crafting_table||project.stations?.furnace
  if(station)await walk(new goals.GoalLookAtBlock(vec(station.position),bot.world,{reach:3}))
  else {const p=project.build.near;await walk(new goals.GoalNear(p.x,p.y,p.z,2))}
  state.phase='at_base';state.pending=null;save()
 }
 if(task.kind==='return_base'){await home();return {item:'base',count:1,returned:true,position:point(bot.entity.position)}}
 // From the back exit the trip starts underground; a trail saved from the
 // door is a surface route that cannot be walked from here, so it is let go
 // and a new one begins at the shaft's foot (home is then the shaft).
 if(state.trail.length&&inBackExit(bot,project)){state.trail=[];state.frontier=[];state.phase='at_base';state.pending=null;save()}
 if(state.trail.length)await home()
 const {item,count:total}=task.goal
 if(count(item)>=total){await home();return {item,count:count(item),target:total,acquired:true,returned:true}}
 const bounds=starterBounds(bot,item,project.build.origin),bootstrap=!!bounds
 const needsNow=()=>expeditionNeeds(bot,{bootstrap})
 const initialNeeds=needsNow()
 if(initialNeeds.length){state.needs=initialNeeds;save();await home();return {item,count:count(item),target:total,acquired:false,partial:true,returned:true,broken,steps,needs:initialNeeds,next:'Resupply at base, then continue the same target'}}
 state.needs=[]
 // Resume an already opened branch using ordinary no-dig navigation.
 if(state.frontier.length&&state.frontier.every(p=>insideBounds(p,bounds))){
  progress('Returning to the saved mining frontier')
  try{
   for(const p of state.frontier){
    check()
    // Another skill/player may have mined a waypoint's old support. Keep
    // unknown cells for re-observation, but navigate past known invalid ones.
    if(invalidKnownWaypoint(bot,p)){state.routeRepairs=(state.routeRepairs||0)+1;save();continue}
    await walk(new goals.GoalBlock(p.x,p.y,p.z));state.trail.push(p);save()
   }
   state.frontier=structuredClone(state.trail);save()
  }catch(error){check();state.blocker=error.message;save();await home();throw error}
 }
 if(!state.trail.length){state.trail.push(point(bot.entity.position));save()}
 const movement=new ExcavationMovements(bot,project,state.trail);movement.limits=bounds
 async function dig(p){
  check();let block=bot.blockAt(vec(p));if(clearAir(block))return
  if(!movement.safeToBreak(block)||supportsPlayer(vec(p),bot.entity.position))throw new Error(`Unsafe excavation at ${key(p)} (${block?.name||'unloaded'})`)
  if(bot.entity.position.distanceTo(vec(p).offset(.5,.5,.5))>4.5)throw new Error('Excavation face out of reach')
  const harvest=Object.keys(block.harvestTools||{}).map(Number)
  const tools=bot.inventory.items().filter(i=>remainingDurability(i)>8&&(!harvest.length||harvest.includes(i.type)))
  tools.sort((a,b)=>block.digTime(a.type)-block.digTime(b.type)||remainingDurability(b)-remainingDurability(a))
  const tool=tools[0]
  if(harvest.length&&!tool)throw new Error('Tool durability reserve reached; acquire an additional pickaxe at base')
  state.pending={position:point(p),block:block.name};state.phase='excavating';save()
  if(tool){await bot.equip(tool,'hand');check()}
  const fallRisk=GRAVITY.has(bot.blockAt(vec(p).offset(0,1,0))?.name)
  stage('excavating');await bot.dig(block);check()
  await confirmCut(p,fallRisk)
  broken++;state.pending=null;save()
 }
 // Sand or gravel above a cut lands in it a few ticks later; cut it again,
 // bounded, counting every cut. The bot never stands in or under the cell.
 async function confirmCut(p,fallRisk){
  for(let refills=0;;){
   let stable=0,refilled=null
   for(let i=0;i<80&&stable<(fallRisk?10:5)&&!refilled;i++){
    check();const b=bot.blockAt(vec(p))
    if(b?.boundingBox==='empty')stable++;else{stable=0;if(b&&GRAVITY.has(b.name))refilled=b}
    if(!refilled&&stable<(fallRisk?10:5))await delay(100)
   }
   if(!refilled)break
   if(++refills>8)throw new Error(`Falling blocks keep refilling ${key(p)}`)
   progress(`Fallen ${refilled.name} refilled ${key(p)}; cutting it again`)
   await bot.dig(refilled);check();broken++;fallRisk=true
  }
  if(bot.blockAt(vec(p))?.boundingBox!=='empty')throw new Error(`Server did not confirm excavation at ${key(p)}`)
 }
 async function lightTrail(){
  const torch=bot.inventory.items().find(i=>i.name==='torch');if(!torch)return
  const p=state.trail.at(-2);if(!p||protectedBase(p,project))return
  const pos=vec(p),floor=bot.blockAt(pos.offset(0,-1,0))
  if(bot.blockAt(pos)?.name!=='air'||floor?.boundingBox!=='block'||bot.entity.position.distanceTo(pos)>4)return
  if((state.lights||[]).some(q=>vec(q).distanceTo(pos)<7))return
  check();state.lightPending=point(pos);save()
  await bot.equip(torch,'hand');check();stage('placing')
  await bot.placeBlock(floor,new Vec3(0,1,0));check()
  await settle(()=>bot.blockAt(pos)?.name==='torch','Trail torch placement was not confirmed')
  state.lights??=[];state.lights.push(point(pos));state.lights=state.lights.slice(-320);state.lightPending=null;save()
 }
 let outcome='No ore found in the surveyed client terrain',partial=false
 try{
  for(let attempt=0;attempt<8&&count(item)<total;attempt++){
   check();const centre=bot.entity.position.floored(),names=ORE_SOURCES[item]
   const candidates=bot.findBlocks({matching:names.map(n=>bot.registry.blocksByName[n]?.id).filter(Number.isInteger),maxDistance:128,count:32,useExtraInfo:b=>insideBounds(b.position,bounds)&&!state.rejected.some(r=>r.item===item&&r.position===key(b.position))&&!protectedBase(b.position,project)})
   state.surveys.push({item,centre:point(centre),radius:128,observed:candidates.length,at:new Date().toISOString()});state.surveys=state.surveys.slice(-16);save()
   let exploring=false,target=candidates[0]
   if(!target){
    // Advance through loaded terrain in bounded sectors. Moving opens more
    // client chunks; later surveys never rely on server-side ore queries.
    // The budget bounds one search from one place. Kept forever it retires the
    // ore permanently, so a base moved or a new frontier resets it.
    state.searchSteps??={}
    const here=`${Math.round(centre.x/32)},${Math.round(centre.z/32)}`
    if(state.searchOrigin!==here){state.searchOrigin=here;state.searchSteps={}}
    const n=state.searchSteps[item]||0
    if(n>=16){outcome='Sixteen exploration sectors exhausted';break}
    state.searchSteps[item]=n+1;exploring=true
    const [dx,dz]=[[24,0],[0,24],[-24,0],[0,-24]][Math.floor(n/4)%4]
    const depth=bootstrap?bounds.y[0]:Math.max(bot.game?.minY===undefined?-48:bot.game.minY+16,item==='diamond'?-48:16)
    target=centre.offset(dx,Math.max(depth,centre.y-16)-centre.y,dz)
    if(!insideBounds(target,bounds)){outcome='Shallow starter search exhausted; inspect another surface access point';break}
   }
   state.target={item,position:point(target)};save()
   progress(exploring?`Exploring a new sector toward ${key(target)} for ${item}`:`Prospecting ${item}: ${count(item)}/${total}; ore at ${key(target)}`)
   let path
   try{path=await excavationPath(bot,movement,bot.entity.position,new goals.GoalBlock(target.x,target.y,target.z),check)}
   catch(error){check();if(!exploring)state.rejected.push({item,position:key(target),reason:error.message});state.rejected=state.rejected.slice(-64);outcome=error.message;save();continue}
   let reroute=false
   routeSteps: for(const node of path){
    check()
    // Leave time for the reverse journey; progress remains usable next trip.
    const needs=needsNow()
    if(needs.length){state.needs=needs;partial=true;break}
    if(broken+(node.toBreak?.length||0)>(bootstrap?48:180)||steps>=(bootstrap?32:96)||tripElapsed()>(bootstrap?90000:300000)||state.trail.length>=300){partial=true;break}
    if(!excavationStepSafe(bot,movement,node)){
     reroute=true;progress('Replanning around the protected return route or changed terrain');break
    }
    for(const p of node.toBreak||[]){
     const needs=needsNow()
     if(needs.length){state.needs=needs;partial=true;break routeSteps}
     await dig(p)
    }
    const next=point(node),last=state.trail.at(-1)
    if(invalidKnownWaypoint(bot,next)||!bot.blockAt(vec(next))||!bot.blockAt(vec(next).offset(0,-1,0))||!bot.blockAt(vec(next).offset(0,1,0))){reroute=true;progress('Rechecking changed landing terrain before moving');break}
    // Reserve the destination before movement so Stop/reconnect during a step
    // retains both ends. Navigation on return can re-observe that cell.
    if(!last||key(last)!==key(next))state.trail.push(next)
    save();await walk(new goals.GoalBlock(next.x,next.y,next.z));steps++;save()
    if(steps%8===0)await lightTrail()
    if(steps%8===0)progress(`Opened ${steps} route steps; carrying ${count(item)}/${total} ${item}`)
    if(count(item)>=total)break
   }
   state.frontier=structuredClone(state.trail);save()
   if(reroute)continue
   if(partial){outcome='Excavation progress saved; continue prospecting from the saved frontier';break}
   await delay(700);check()
   if(count(item)<total&&!names.includes(bot.blockAt(target)?.name)){
    const drop=Object.values(bot.entities||{}).find(e=>e.getDroppedItem?.()?.name===item&&e.position.distanceTo(target)<3)
    if(drop){const p=drop.position.floored();await walk(new goals.GoalNear(p.x,p.y,p.z,.5));await delay(500);check()}
   }
   if(bot.blockAt(target)?.name&&names.includes(bot.blockAt(target).name)){state.rejected.push({item,position:key(target),reason:'Route ended without mining target'});save()}
  }
 }catch(error){check();outcome=error.message;state.blocker=outcome;state.frontier=structuredClone(state.trail);save();await home();throw new Error(outcome)}
 if(!partial&&count(item)<total&&steps>0){partial=true;outcome='Exploration progress saved; continue prospecting from the saved frontier'}
 const acquired=count(item)>=total
 if(acquired){state.blocker=null;await settle(()=>count(item)>=total,'Ore pickup not confirmed');state.frontier=structuredClone(state.trail);save()}
 await home()
 if(!acquired&&!partial)throw new Error(`${outcome}; returned to base with ${count(item)}/${total} ${item}`)
 return {item,count:count(item),target:total,acquired,partial,returned:true,broken,steps,bootstrap,frontier:state.frontier.at(-1),surveyScope:'loaded client chunks, including buried ore',lightsPlaced:state.lights?.length||0,needs:state.needs||[],...(partial?{next:outcome}:{})}
}

// Route coordinates remain durable executor state. Models need frontier and
// blocker summaries, not hundreds of duplicated breadcrumbs every round.
export function expeditionObservation(value){
 const copy=structuredClone(value)
 function visit(v){
  if(!v||typeof v!=='object')return
  if(v.expedition){const e=v.expedition;v.expedition={phase:e.phase,target:e.target,blocker:e.blocker,needs:e.needs||[],lightsPlaced:e.lights?.length||0,trailSteps:e.trail?.length||0,frontierSteps:e.frontier?.length||0,frontier:e.frontier?.at(-1)||null,surveys:e.surveys?.slice(-3)||[],rejected:e.rejected?.slice(-5)||[]}}
  for(const child of Object.values(v))visit(child)
 }
 visit(copy);return copy
}

export function excavationStepSafe(bot,movement,node){
 return (node.toBreak||[]).every(p=>{const b=bot.blockAt(vec(p));return clearAir(b)||movement.safeToBreak(b)&&!supportsPlayer(vec(p),bot.entity.position)})
}

export function invalidKnownWaypoint(bot,p){
 if(!bot.blockAt)return false
 const feet=bot.blockAt(vec(p)),head=bot.blockAt(vec(p).offset(0,1,0)),floor=bot.blockAt(vec(p).offset(0,-1,0))
 if(!feet||!head||!floor)return false
 const clear=b=>clearAir(b)||openDoorHasCenterClearance(b)
 return floor.boundingBox!=='block'||!clear(feet)||!clear(head)
}
