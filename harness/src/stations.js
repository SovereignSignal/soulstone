import {retreatToConstruction} from './alternate-shelter.js'
import {retreatToShelter} from './retreat.js'
import {Vec3} from 'vec3'
import pathfinding from 'mineflayer-pathfinder'
import {setTimeout as delay} from 'node:timers/promises'
import {withWindowState} from './crafting.js'
import {shelterLayout,shelterAccessLayout,finishShelter} from './shelter.js'
import {shelterLightBounds} from './lighting.js'
import {isLog} from './resources.js'
const {goals}=pathfinding
export const STATIONS=['crafting_table','furnace','chest','torch']
export const STATION_ACTIONS=['place','deposit','withdraw','smelt','check_base','stow','retreat','leave_base','tunnel_out']
// Output -> input. Cooked foods since 3 October: the family-world bot hunted
// 10 porkchop and could not cook them ("Unsupported smelting output").
export const SMELTING={charcoal:'wood_log',stone:'cobblestone',glass:'sand',iron_ingot:'raw_iron',copper_ingot:'raw_copper',gold_ingot:'raw_gold',
 cooked_porkchop:'porkchop',cooked_beef:'beef',cooked_mutton:'mutton',cooked_chicken:'chicken',cooked_rabbit:'rabbit',cooked_cod:'cod',cooked_salmon:'salmon',baked_potato:'potato'}
const vec=p=>new Vec3(p.x,p.y,p.z)
const same=(a,b)=>a.x===b.x&&a.y===b.y&&a.z===b.z
const sum=(items,name)=>items.filter(i=>i?.name===name).reduce((n,i)=>n+i.count,0)
export function stationCandidates(bot,project,item) {
 const origin=vec(project.build.origin),layout=shelterLayout(project.build.design)
 const reserved=Object.values(project.stations||{}).map(s=>s.position)
 const candidates=[]
 if(item==='torch') {
  for(const p of [...layout.inside].sort((a,b)=>b.distanceTo(layout.door)-a.distanceTo(layout.door)))candidates.push(origin.plus(p))
 } else {
  // Workstations stay outside the small room and off the entrance approach.
  for(let dx=layout.minX-3;dx<=layout.maxX+3;dx++)for(let dz=layout.minZ-3;dz<=layout.maxZ+3;dz++){
   if(dx>=layout.minX&&dx<=layout.maxX&&dz>=layout.minZ&&dz<=layout.maxZ)continue
   if(layout.approach.some(p=>p.x===dx&&p.z===dz))continue
   candidates.push(origin.offset(dx,0,dz))
  }
  candidates.sort((a,b)=>a.distanceTo(origin)-b.distanceTo(origin))
 }
 return candidates.filter(p=>{
  if(reserved.some(r=>same(p,r)))return false
  if(bot.blockAt(p)?.name!=='air'||bot.blockAt(p.offset(0,-1,0))?.boundingBox!=='block'||bot.blockAt(p.offset(0,1,0))?.boundingBox!=='empty')return false
  if(Object.values(bot.players||{}).some(v=>v.entity&&v.entity!==bot.entity&&v.entity.position.distanceTo(p.offset(.5,0,.5))<1.5))return false
  if(item==='chest'&&[[1,0],[-1,0],[0,1],[0,-1]].some(([x,z])=>bot.blockAt(p.offset(x,0,z))?.name==='chest'))return false
  return item==='torch'||[[1,0],[-1,0],[0,1],[0,-1]].some(([x,z])=>{
   const q=p.offset(x,0,z);return bot.blockAt(q)?.boundingBox==='empty'&&bot.blockAt(q.offset(0,1,0))?.boundingBox==='empty'&&bot.blockAt(q.offset(0,-1,0))?.boundingBox==='block'
  })
 })
}
export async function withStationWindow(bot,name,p,{check,walk,stage},operation) {
 if(bot.blockAt(p)?.name!==name)throw new Error(`The saved ${name} is missing or replaced; inspect it`)
 if(name==='chest'&&bot.blockAt(p.offset(0,1,0))?.boundingBox!=='empty')throw new Error('Chest lid is obstructed')
 // An empty hand is required here: activating with an item held uses that item instead. When `use` lands, bare-hand becomes an explicit variant of this path, not an invariant of it.
 // Here specifically: a held item would be placed or used instead of opening the station.
 await walk(new goals.GoalLookAtBlock(p,bot.world,{reach:3}));check();await bot.unequip('hand');check()
 if(bot.blockAt(p)?.name!==name)throw new Error('Workstation changed while approaching')
 return withWindowState(bot,async()=>{
  let w,timer
  try{
   stage('interacting')
   const opening=['chest','barrel'].includes(name)?bot.openContainer(bot.blockAt(p)):name==='furnace'?bot.openFurnace(bot.blockAt(p)):bot.openBlock(bot.blockAt(p))
   w=await Promise.race([opening,new Promise((_,no)=>{timer=setTimeout(()=>{bot.end('station window timeout');no(new Error(`${name} did not open within 8 seconds`))},8000)})]);check();clearTimeout(timer)
   return await operation(w)
  }finally{clearTimeout(timer);if(w&&bot.currentWindow?.id===w.id)w.close()}
 },check)
}
const FURNACE_REACH=48,FURNACE_NEARBY=8
const plain=p=>({x:p.x,y:p.y,z:p.z})
export async function resolveFurnace(bot,project,api) {
 const saved=project?.stations?.furnace?.position
 if(saved&&bot.blockAt(vec(saved))?.name==='furnace'&&bot.entity.position.distanceTo(vec(saved))<=FURNACE_REACH)return {position:plain(saved),source:'base'}
 const near=bot.findBlock({matching:bot.registry.blocksByName.furnace.id,maxDistance:FURNACE_NEARBY})
 if(near)return {position:plain(near.position),source:'nearby'}
 if(!bot.inventory.items().some(i=>i.name==='furnace')){await api.acquire('furnace',1);api.check()}
 const feet=bot.entity.position.floored(),open=p=>['air','cave_air'].includes(bot.blockAt(p)?.name)
 const cell=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]].map(([x,z])=>feet.offset(x,0,z))
  .find(p=>open(p)&&open(p.offset(0,1,0))&&bot.blockAt(p.offset(0,-1,0))?.boundingBox==='block')
 if(!cell)throw new Error('No open cell beside me to place a furnace on; dig or move to level ground first')
 // Lazy: primitives-world reaches this module back through construction.js and building-blocks.js.
 const {placeAt,validatePlaceAtGoal}=await import('./primitives-world.js')
 await placeAt(bot,{kind:'place_at',goal:validatePlaceAtGoal({item:'furnace',x:cell.x,y:cell.y,z:cell.z})},api)
 return {position:plain(cell),source:'placed'}
}
export async function executeStationSkill(bot,task,api) {
 const {check,progress,stage,persist,walk,settle,acquire}=api
 if(['retreat','leave_base'].includes(task.kind))return task.goal.shelter?retreatToConstruction(bot,task,api):retreatToShelter(bot,task,api)
 const project=task.goal.project
 if(project){project.stations ||= {};delete project.verification}
 persist()
 const inventory=name=>sum((bot.currentWindow?.items?bot.currentWindow:bot.inventory).items(),name)
 async function openWindow(name,operation){
  const saved=project.stations[name];if(!saved)throw new Error(`Place the base ${name} first`)
  return withStationWindow(bot,name,vec(saved.position),api,operation)
 }
 async function chestInventory(){return openWindow('chest',async w=>Object.fromEntries([...new Set(w.containerItems().map(i=>i.name))].map(n=>[n,sum(w.containerItems(),n)])))}
 if(task.kind==='place') {
  const name=task.goal.item;let saved=project.stations[name]
  if(!saved){const p=stationCandidates(bot,project,name)[0];if(!p)throw new Error(`No supported, accessible ${name} location at this base`);saved=project.stations[name]={position:{x:p.x,y:p.y,z:p.z},confirmed:false};persist()}
  const p=vec(saved.position)
  if(name==='torch'){
   const origin=vec(project.build.origin),layout=shelterLayout(project.build.design),door=origin.plus(layout.door)
   // An empty hand is required here: activating with an item held uses that item instead. When `use` lands, bare-hand becomes an explicit variant of this path, not an invariant of it.
   // Here specifically: a held item would be placed or used instead of opening the station.
   if(bot.blockAt(door)?.getProperties().open===false){await walk(new goals.GoalLookAtBlock(door,bot.world,{reach:3}));check();await bot.unequip('hand');check();await bot.activateBlock(bot.blockAt(door));check();await settle(()=>bot.blockAt(door)?.getProperties().open===true,'Base door did not open')}
  }
  if(bot.blockAt(p)?.name!==name){
   if(bot.blockAt(p)?.name!=='air')throw new Error(`Saved ${name} position is obstructed; no replacement placed`)
   await acquire(name,1);check();progress(`Placing base ${name}`)
   await walk(new goals.GoalLookAtBlock(p.offset(0,-1,0),bot.world,{reach:3}));check()
   if(Object.values(bot.players||{}).some(v=>v.entity&&v.entity!==bot.entity&&v.entity.position.distanceTo(p.offset(.5,0,.5))<1))throw new Error('Player in station placement area')
   await bot.equip(bot.inventory.items().find(i=>i.name===name),'hand');check();stage('placing')
   await bot.placeBlock(bot.blockAt(p.offset(0,-1,0)),new Vec3(0,1,0));check()
   await settle(()=>bot.blockAt(p)?.name===name,`${name} placement not confirmed`)
  }
  if(name!=='torch')await openWindow(name,async w=>{if(name==='crafting_table'&&!/crafting/.test(w.type))throw new Error('Crafting window not confirmed')})
  saved.confirmed=true;persist();return {item:name,count:1,position:saved.position,receipt:'station_verified'}
 }
 async function transfer(item,count,direction) {
  if(task.transfer?.uncertain)throw new Error('Previous transfer uncertain; inspect both inventories before issuing a new target')
  const id=bot.registry.itemsByName[item]?.id;if(id===undefined)throw new Error('Unknown transfer item')
  const before=await chestInventory(),carried=inventory(item)
  const amount=Math.max(0,count-(direction==='deposit'?(before[item]||0):carried))
  if(!amount)return {item,count:0,container:before,inventory:carried,receipt:'target_already_satisfied'}
  if(direction==='deposit'&&carried<amount)throw new Error(`Need ${amount} carried ${item} for this chest target; have ${carried}`)
  if(direction==='withdraw'&&(before[item]||0)<amount)throw new Error(`Chest lacks ${amount} ${item}`)
  task.transfer={uncertain:true,item,amount,before,carried};persist()
  let refused=null
  await openWindow('chest',async w=>{check();try{await w[direction](id,null,amount)}catch(error){refused=error};check()})
  const after=await chestInventory();check();const sign=direction==='deposit'?1:-1
  // A full chest stops the window part-way and throws. That is only uncertain
  // if the two sides disagree about what moved: count it, and when the chest
  // and the inventory agree, say so plainly. A refused deposit used to leave
  // the transfer marked uncertain, which ended the whole request for review.
  if(refused){
   const moved=sign*((after[item]||0)-(before[item]||0))
   await settle(()=>inventory(item)===carried-sign*moved,'Player inventory transfer not confirmed')
   task.transfer={...task.transfer,uncertain:false,moved};project.stations.chest.contents=after;persist()
   const full=direction==='deposit'&&/full/i.test(refused.message)
   throw Object.assign(new Error(full?`The base chest is full: stored ${moved} of ${amount} ${item}, ${amount-moved} still carried. It has no free slot for more`:`Chest ${direction} stopped after ${moved} of ${amount} ${item}: ${refused.message}`),{code:full?'CHEST_FULL':'CHEST_REFUSED',moved,container:after})
  }
  await settle(()=>inventory(item)===carried-sign*amount,'Player inventory transfer not confirmed')
  if((after[item]||0)!==(before[item]||0)+sign*amount)throw new Error('Chest transfer did not match the observed quantity; do not repeat blindly')
  task.transfer.uncertain=false;task.transfer.confirmed=true;project.stations.chest.contents=after;persist()
  return {item,count:amount,container:after,inventory:inventory(item),receipt:'reopened_container_verified'}
 }
 if(['deposit','withdraw'].includes(task.kind))return transfer(task.goal.item,task.goal.count,task.kind)
 if(task.kind==='stow'){
  const receipts=[],RUBBLE=['cobblestone','cobbled_deepslate','andesite','granite','diorite','tuff'],surplus=item=>Math.max(0,inventory(item)-(item==='cobblestone'?32:0))
  let full=false
  for(const item of RUBBLE){
   check();const amount=surplus(item);if(!amount)continue
   const contents=await chestInventory()
   progress(`Storing ${amount} ${item} in the base chest`)
   // Tidying up is not worth a failed request: a full chest keeps what fitted
   // and the rest stays carried, said in the receipt.
   try{receipts.push(await transfer(item,(contents[item]||0)+amount,'deposit'))}
   catch(error){if(error.code!=='CHEST_FULL')throw error;receipts.push({item,count:error.moved,container:error.container,inventory:inventory(item),receipt:'chest_full'});full=true}
   task.stowed=receipts;persist()
   if(full)break
  }
  const contents=await chestInventory();project.stations.chest.contents=contents;persist()
  const leftCarried=Object.fromEntries(RUBBLE.map(item=>[item,surplus(item)]).filter(([,n])=>n>0))
  return {item:'rubble',count:receipts.reduce((n,r)=>n+r.count,0),receipt:full?'chest_full':'rubble_stowed',transfers:receipts,container:contents,reservedCobblestone:32,freeSlots:bot.inventory.emptySlotCount(),...(full?{leftCarried}:{})}
 }
 if(task.kind==='smelt') {
  const {item,count}=task.goal,carried=bot.inventory.items().map(i=>i.name),source=SMELTING[item]
  const input=source==='wood_log'?project?.build?.wood||carried.find(isLog)||'oak_log':source
  const needed=Math.max(0,count-inventory(item));if(!needed)return {item,count:inventory(item),receipt:'inventory_target_satisfied'}
  const furnace=await resolveFurnace(bot,project,api);check()
  const at=vec(furnace.position),openFurnace=operation=>withStationWindow(bot,'furnace',at,api,operation)
  // Burning the output would undo the smelt, so charcoal is never fuel for charcoal.
  const coalFuels=['coal','charcoal'].filter(f=>f!==item),planks=project?.build?.wood?.replace('_log','_planks')||carried.find(n=>n.endsWith('_planks'))||'oak_planks'
  const burns=name=>['coal','charcoal'].includes(name)?8:1.5,burnable=name=>['coal','charcoal'].includes(name)||name.endsWith('_planks')
  const nextFuel=remaining=>{const name=[...coalFuels,planks].find(f=>inventory(f)>0);return name&&{id:bot.registry.itemsByName[name].id,count:Math.min(Math.ceil(remaining/burns(name)),inventory(name))}}
  let pending=0,readyOutput=0,storedFuelCapacity=0
  await openFurnace(async w=>{
   if(w.inputItem()&&w.inputItem().name!==input||w.outputItem()&&w.outputItem().name!==item)throw new Error('Furnace contains a different recipe; existing contents preserved')
   pending=(w.inputItem()?.count||0)+(w.outputItem()?.count||0)
   readyOutput=w.outputItem()?.count||0
   const fuel=w.fuelItem()
   if(fuel&&!burnable(fuel.name))throw new Error('Furnace has a different fuel; preserve it and inspect')
   storedFuelCapacity=(fuel?.count||0)*burns(fuel?.name)
  })
  if(furnace.source!=='base'&&project?.build?.origin&&project.stations&&!project.stations.furnace&&at.distanceTo(vec(project.build.origin))<=32){project.stations.furnace={position:furnace.position,confirmed:true};persist()}
  const shortfall=Math.max(0,needed-readyOutput-storedFuelCapacity)
  const plankCount=Math.ceil(Math.max(0,shortfall-coalFuels.reduce((n,f)=>n+inventory(f)*8,0))/1.5)
  // Fuel crafting can consume the same logs that charcoal needs as input.
  // Reserve fuel first, then replenish the actual furnace ingredient.
  if(plankCount)await acquire(planks,plankCount)
  await acquire(input,Math.max(0,needed-pending))
  await openFurnace(async w=>{
   check();if(w.inputItem()&&w.inputItem().name!==input||w.outputItem()&&w.outputItem().name!==item)throw new Error('Furnace contents changed; retry after inspection')
   const add=Math.max(0,count-inventory(item)-(w.inputItem()?.count||0)-(w.outputItem()?.count||0))
   if(w.fuelItem()&&!burnable(w.fuelItem().name))throw new Error('Furnace has a different fuel; preserve it and inspect')
   const first=!w.fuelItem()&&!(w.fuel>0)&&shortfall>0&&nextFuel(shortfall)
   if(first){check();await w.putFuel(first.id,null,first.count);check()}
   if(add){check();await w.putInput(bot.registry.itemsByName[input].id,null,add);check()}
   task.smelting={input,output:item,target:count,position:furnace.position};persist();progress(`Smelting ${item}: ${inventory(item)}/${count}`)
   const deadline=Date.now()+Math.min(240000,needed*12000+20000)
   while(inventory(item)<count){
    check();if(Date.now()>deadline)throw new Error(`Smelting timed out; ingredients remain in the furnace at ${at.x}, ${at.y}, ${at.z}`)
    if(w.outputItem()?.name===item){await w.takeOutput();check();progress(`Smelting ${item}: ${inventory(item)}/${count}`)}
    // An empty fuel slot can still be burning. Loading the full original
    // batch again here stranded spare crafting planks after a restart.
    if(inventory(item)<count&&!w.fuelItem()&&w.fuel===0){
     const remaining=Math.max(0,count-inventory(item)-(w.outputItem()?.count||0)),next=remaining&&nextFuel(remaining)
     if(next){await w.putFuel(next.id,null,next.count);check()}
    }
    await delay(200)
   }
  })
  await settle(()=>inventory(item)>=count,'Smelted output inventory not confirmed')
  return {item,count:inventory(item),receipt:'smelted_output_collected',furnace:furnace.position,furnaceSource:furnace.source}
 }
 if(task.kind==='check_base') {
  for(const name of STATIONS)if(!project.stations[name]?.confirmed||bot.blockAt(vec(project.stations[name].position))?.name!==name)throw new Error(`Base is missing a verified ${name}`)
  const origin=vec(project.build.origin),layout=shelterLayout(project.build.design)
  const usability=await finishShelter(bot,origin,shelterAccessLayout(layout),project.build.wood,api)
  const lighting=shelterLightBounds(bot,vec(project.stations.torch.position),layout.inside.flatMap(p=>[origin.plus(p),origin.plus(p).offset(0,1,0)]))
  if(lighting.some(p=>p.lowerBound<8))throw new Error('Cannot establish interior block light of at least 8 from the observed room; lighting needs repair')
  const contents=await chestInventory();await openWindow('furnace',async()=>{});await openWindow('crafting_table',async()=>{})
  project.stations.chest.contents=contents;project.verification={usability,lighting,contents,checkedAt:new Date().toISOString()};persist()
  return {item:'base',count:4,receipt:'base_verified',...project.verification,stations:project.stations}
 }
 throw new Error('Unknown station action')
}
