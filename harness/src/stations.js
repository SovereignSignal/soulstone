import {retreatToConstruction} from './alternate-shelter.js'
import {retreatToShelter} from './retreat.js'
import {Vec3} from 'vec3'
import pathfinding from 'mineflayer-pathfinder'
import {setTimeout as delay} from 'node:timers/promises'
import {withWindowState} from './crafting.js'
import {shelterLayout,shelterAccessLayout,finishShelter} from './shelter.js'
import {shelterLightBounds} from './lighting.js'
const {goals}=pathfinding
export const STATIONS=['crafting_table','furnace','chest','torch']
export const STATION_ACTIONS=['place','deposit','withdraw','smelt','check_base','stow','retreat','leave_base']
export const SMELTING={charcoal:'wood_log',stone:'cobblestone',glass:'sand',iron_ingot:'raw_iron',copper_ingot:'raw_copper',gold_ingot:'raw_gold'}
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
export async function executeStationSkill(bot,task,api) {
 const {check,progress,stage,persist,walk,settle,acquire}=api
 if(['retreat','leave_base'].includes(task.kind))return task.goal.shelter?retreatToConstruction(bot,task,api):retreatToShelter(bot,task,api)
 const project=task.goal.project;project.stations ||= {}
 delete project.verification;persist()
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
  await openWindow('chest',async w=>{check();await w[direction](id,null,amount);check()})
  const after=await chestInventory();check();const sign=direction==='deposit'?1:-1
  await settle(()=>inventory(item)===carried-sign*amount,'Player inventory transfer not confirmed')
  if((after[item]||0)!==(before[item]||0)+sign*amount)throw new Error('Chest transfer did not match the observed quantity; do not repeat blindly')
  task.transfer.uncertain=false;task.transfer.confirmed=true;project.stations.chest.contents=after;persist()
  return {item,count:amount,container:after,inventory:inventory(item),receipt:'reopened_container_verified'}
 }
 if(['deposit','withdraw'].includes(task.kind))return transfer(task.goal.item,task.goal.count,task.kind)
 if(task.kind==='stow'){
  const receipts=[]
  for(const item of ['cobblestone','cobbled_deepslate','andesite','granite','diorite','tuff']){
   check();const amount=Math.max(0,inventory(item)-(item==='cobblestone'?32:0));if(!amount)continue
   const contents=await chestInventory()
   progress(`Storing ${amount} ${item} in the base chest`)
   const receipt=await transfer(item,(contents[item]||0)+amount,'deposit');receipts.push(receipt)
   task.stowed=receipts;persist()
  }
  const contents=await chestInventory();project.stations.chest.contents=contents;persist()
  return {item:'rubble',count:receipts.reduce((n,r)=>n+r.count,0),receipt:'rubble_stowed',transfers:receipts,container:contents,reservedCobblestone:32,freeSlots:bot.inventory.emptySlotCount()}
 }
 if(task.kind==='smelt') {
  const {item,count}=task.goal,source=SMELTING[item],input=source==='wood_log'?project.build.wood:source
  const needed=Math.max(0,count-inventory(item));if(!needed)return {item,count:inventory(item),receipt:'inventory_target_satisfied'}
  let pending=0,readyOutput=0,storedFuelCapacity=0
  await openWindow('furnace',async w=>{
   if(w.inputItem()&&w.inputItem().name!==input||w.outputItem()&&w.outputItem().name!==item)throw new Error('Furnace contains a different recipe; existing contents preserved')
   pending=(w.inputItem()?.count||0)+(w.outputItem()?.count||0)
   readyOutput=w.outputItem()?.count||0
   const fuel=w.fuelItem()
   if(fuel&&!['coal','charcoal',project.build.wood.replace('_log','_planks')].includes(fuel.name))throw new Error('Furnace has a different fuel; preserve it and inspect')
   storedFuelCapacity=(fuel?.count||0)*(['coal','charcoal'].includes(fuel?.name)?8:1.5)
  })
  const fuel=project.build.wood.replace('_log','_planks'),fuelCount=Math.ceil(Math.max(0,needed-readyOutput-storedFuelCapacity)/1.5)
  // Fuel crafting can consume the same logs that charcoal needs as input.
  // Reserve fuel first, then replenish the actual furnace ingredient.
  await acquire(fuel,fuelCount)
  await acquire(input,Math.max(0,needed-pending))
  await openWindow('furnace',async w=>{
   check();if(w.inputItem()&&w.inputItem().name!==input||w.outputItem()&&w.outputItem().name!==item)throw new Error('Furnace contents changed; retry after inspection')
   const add=Math.max(0,count-inventory(item)-(w.inputItem()?.count||0)-(w.outputItem()?.count||0))
   if(w.fuelItem()&&!['coal','charcoal',fuel].includes(w.fuelItem().name))throw new Error('Furnace has a different fuel; preserve it and inspect')
   if(!w.fuelItem()&&!(w.fuel>0)&&fuelCount>0){check();await w.putFuel(bot.registry.itemsByName[fuel].id,null,fuelCount);check()}
   if(add){check();await w.putInput(bot.registry.itemsByName[input].id,null,add);check()}
   task.smelting={input,output:item,target:count,position:project.stations.furnace.position};persist();progress(`Smelting ${item}: ${inventory(item)}/${count}`)
   const deadline=Date.now()+Math.min(240000,needed*12000+20000)
   while(inventory(item)<count){
    check();if(Date.now()>deadline)throw new Error('Smelting timed out; ingredients remain in the saved furnace')
    if(w.outputItem()?.name===item){await w.takeOutput();check();progress(`Smelting ${item}: ${inventory(item)}/${count}`)}
    // An empty fuel slot can still be burning. Loading the full original
    // batch again here stranded spare crafting planks after a restart.
    if(inventory(item)<count&&!w.fuelItem()&&w.fuel===0&&inventory(fuel)>0){
     const remaining=Math.max(0,count-inventory(item)-(w.outputItem()?.count||0))
     if(remaining){await w.putFuel(bot.registry.itemsByName[fuel].id,null,Math.min(Math.ceil(remaining/1.5),inventory(fuel)));check()}
    }
    await delay(200)
   }
  })
  await settle(()=>inventory(item)>=count,'Smelted output inventory not confirmed')
  return {item,count:inventory(item),receipt:'smelted_output_collected',furnace:project.stations.furnace.position}
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
