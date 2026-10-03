import test from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import {stationCandidates} from '../src/stations.js'
import {validatePlan} from '../src/companion/planner.js'
import {validateTaskGoal} from '../src/task-store.js'
const design=[]
for(let x=0;x<4;x++)for(let z=0;z<4;z++)for(let y=0;y<3;y++)if((y===2||x===0||x===3||z===0||z===3)&&!(x===1&&z===0&&y<2))design.push({x,y,z,block:'wood_planks'})
const project={build:{origin:{x:0,y:64,z:0},near:{x:0,y:64,z:0},wood:'oak_log',design},stations:{}}
test('station placement reserves the room and entrance, refuses obstacles and chest joining',()=>{
 const bot={players:{},blockAt:p=>({name:p.y<64?'stone':'air',boundingBox:p.y<64?'block':'empty'})}
 const choices=stationCandidates(bot,project,'chest');assert.ok(choices.length)
 for(const p of choices){assert.ok(p.x<0||p.x>3||p.z<0||p.z>3);assert.ok(!(p.x>=0&&p.x<=2&&p.z>=-3&&p.z<=-1))}
 const torch=stationCandidates(bot,project,'torch');assert.equal(torch.length,4)
 const reserved={...project,stations:{chest:{position:choices[0]}}};assert.ok(!stationCandidates(bot,reserved,'furnace').some(p=>p.equals(choices[0])))
 assert.equal(stationCandidates({players:{},blockAt:()=>null},project,'chest').length,0)
})
test('base action schemas reject arbitrary stations, missing projects and unbounded transfers',()=>{
 assert.equal(validateTaskGoal('place',{item:'chest',count:1,project}).item,'chest')
 assert.throws(()=>validateTaskGoal('place',{item:'tnt',count:1,project}))
 assert.throws(()=>validateTaskGoal('smelt',{item:'diamond',count:1,project}))
 assert.throws(()=>validateTaskGoal('deposit',{item:'dirt',count:100,project}))
 assert.throws(()=>validateTaskGoal('withdraw',{item:'dirt',count:1}))
 for(const action of ['place','deposit','withdraw','smelt','check_base']){
  const item=action==='place'?'chest':action==='smelt'?'glass':action==='check_base'?'':'dirt'
  assert.equal(validatePlan({reply:'Working.',steps:[{action,name:'base',item,count:action==='check_base'?0:1,design:[]}]}).steps[0].action,action)
 }
})

import {executeStationSkill} from '../src/stations.js'
import {interruptedEffect} from '../src/companion/continuity.js'
function storageFixture({correct=true,blocked=false}={}) {
 let carried=9,stored=1,opens=0,closed=0
 const p=structuredClone(project);p.stations.chest={position:{x:-2,y:64,z:1},confirmed:true}
 const bot={registry:{itemsByName:{dirt:{id:1}}},world:{},inventory:{items:()=>carried?[{name:'dirt',count:carried}]:[]},
  blockAt:pos=>({name:pos.y===64?'chest':'air',position:pos,boundingBox:'empty'}),async unequip(){},
  async openContainer(){opens++;const w={id:opens,containerItems:()=>stored?[{name:'dirt',count:stored}]:[],
   async deposit(_,__,n){carried-=n;if(correct)stored+=n},async withdraw(_,__,n){carried+=n;if(correct)stored-=n},close(){closed++;bot.currentWindow=null}}
   bot.currentWindow=w;return w
  }}
 const api={check(){},persist(){},stage(){},progress(){},async walk(){if(blocked)throw new Error('No path to chest')},async settle(f,msg){assert.ok(f(),msg)}}
 return {bot,api,p,stats:()=>({carried,stored,opens,closed})}
}
test('storage targets reopen and verify exact movement and remain idempotent on repeated requests',async()=>{
 const f=storageFixture(),task={kind:'deposit',goal:{project:f.p,item:'dirt',count:5}}
 const r=await executeStationSkill(f.bot,task,f.api);assert.equal(r.count,4);assert.equal(r.container.dirt,5);assert.equal(f.stats().carried,5);assert.equal(f.stats().opens,3);assert.equal(f.stats().closed,3)
 const repeat=await executeStationSkill(f.bot,{kind:'deposit',goal:task.goal},f.api);assert.equal(repeat.count,0)
 const take=await executeStationSkill(f.bot,{kind:'withdraw',goal:{...task.goal,count:7}},f.api);assert.equal(take.count,2);assert.equal(take.container.dirt,3)
})
test('a server-disagreed transfer remains uncertain and cannot replay the same task',async()=>{
 const f=storageFixture({correct:false}),task={kind:'deposit',goal:{project:f.p,item:'dirt',count:5}}
 await assert.rejects(executeStationSkill(f.bot,task,f.api),/did not match/);assert.equal(task.transfer.uncertain,true)
 const count=f.stats().opens;await assert.rejects(executeStationSkill(f.bot,task,f.api),/Previous transfer uncertain/);assert.equal(f.stats().opens,count)
})
test('a full chest is a counted failure the planner can act on, not an uncertain transfer',async()=>{
 // Lab run 6, 2 October: the base chest was full, the window refused the
 // deposit, and the request ended for review two minutes in.
 const full=room=>{const f=storageFixture(),original=f.bot.openContainer
  f.bot.openContainer=async()=>{const w=await original();const deposit=w.deposit;w.deposit=async(a,b,n)=>{await deposit(a,b,Math.min(n,room));if(n>room)throw new Error('destination full')};return w};return f}
 const none=full(0),task={kind:'deposit',goal:{project:none.p,item:'dirt',count:5}}
 await assert.rejects(executeStationSkill(none.bot,task,none.api),e=>/base chest is full: stored 0 of 4 dirt/.test(e.message)&&e.code==='CHEST_FULL'&&e.moved===0)
 assert.equal(task.transfer.uncertain,false);assert.equal(interruptedEffect(task),null);assert.equal(none.stats().carried,9)
 const some=full(3),partial={kind:'deposit',goal:{project:some.p,item:'dirt',count:8}}
 await assert.rejects(executeStationSkill(some.bot,partial,some.api),/stored 3 of 7 dirt/)
 assert.equal(partial.transfer.uncertain,false);assert.equal(some.p.stations.chest.contents.dirt,4);assert.equal(some.stats().carried,6)
 // The window refused and the two sides disagree about what moved: still uncertain.
 const wrong=storageFixture({correct:false}),o=wrong.bot.openContainer
 wrong.bot.openContainer=async()=>{const w=await o();const d=w.deposit;w.deposit=async(a,b,n)=>{await d(a,b,2);throw new Error('destination full')};return w}
 const disputed={kind:'deposit',goal:{project:wrong.p,item:'dirt',count:5}}
 await assert.rejects(executeStationSkill(wrong.bot,disputed,wrong.api));assert.equal(disputed.transfer.uncertain,true);assert.match(interruptedEffect(disputed),/needs review/)
})
test('stowing rubble into a full chest stores what fits and reports the chest full instead of failing',async()=>{
 let carried=40,stored=10
 const f=storageFixture();f.bot.registry={itemsByName:{cobbled_deepslate:{id:2},cobblestone:{id:3},andesite:{id:4},granite:{id:5},diorite:{id:6},tuff:{id:7}}}
 f.bot.inventory={items:()=>carried?[{name:'cobbled_deepslate',count:carried}]:[],emptySlotCount:()=>20}
 f.bot.openContainer=async()=>{const w={containerItems:()=>[{name:'cobbled_deepslate',count:stored}],async deposit(_,__,n){const fit=Math.min(n,6);carried-=fit;stored+=fit;if(n>fit)throw new Error('destination full')},close(){f.bot.currentWindow=null}};f.bot.currentWindow=w;return w}
 const task={kind:'stow',goal:{project:f.p}},r=await executeStationSkill(f.bot,task,f.api)
 assert.equal(r.receipt,'chest_full');assert.equal(r.count,6);assert.equal(r.container.cobbled_deepslate,16);assert.deepEqual(r.leftCarried,{cobbled_deepslate:34});assert.equal(task.transfer.uncertain,false)
})
test('blocked chest access and missing inventory do not start a transfer',async()=>{
 const f=storageFixture({blocked:true}),task={kind:'deposit',goal:{project:f.p,item:'dirt',count:5}}
 await assert.rejects(executeStationSkill(f.bot,task,f.api),/No path/);assert.equal(f.stats().carried,9);assert.equal(task.transfer,undefined)
 const g=storageFixture(),t={kind:'deposit',goal:{project:g.p,item:'dirt',count:64}}
 await assert.rejects(executeStationSkill(g.bot,t,g.api),/Need 63/);assert.equal(t.transfer,undefined);assert.equal(g.stats().stored,1)
})

import {applyBlockLight,observedBlockLight,shelterLightBounds} from '../src/lighting.js'
test('room lighting bound refuses unknown or obstructed paths and a missing source',()=>{
 const source=new Vec3(1,64,1),cells=[source,source.offset(0,1,0),source.offset(1,1,0)]
 const bot={registry:{blocksByName:{torch:{emitLight:14}}},blockAt:p=>({name:p.equals(source)?'torch':'air'})}
 assert.deepEqual(shelterLightBounds(bot,source,cells).map(v=>v.lowerBound),[14,13,12])
 bot.blockAt=p=>p.equals(source)?{name:'torch'}:p.equals(cells[1])?null:{name:'air'}
 assert.deepEqual(shelterLightBounds(bot,source,cells).map(v=>v.lowerBound),[14,0,0])
 bot.blockAt=()=>({name:'air'});assert.throws(()=>shelterLightBounds(bot,source,cells),/not confirmed/)
})
test('raw light decoding preserves nibble ordering, negative chunks, sparse updates and empty masks',()=>{
 const sections=new Map(),raw=new Uint8Array(2048);raw[0]=0xe3
 applyBlockLight(sections,{x:-1,z:0,blockLightMask:[[0,1<<5]],emptyBlockLightMask:[],blockLight:[raw]})
 assert.equal(observedBlockLight(sections,new Vec3(-16,0,0)),3);assert.equal(observedBlockLight(sections,new Vec3(-15,0,0)),14)
 assert.equal(observedBlockLight(sections,new Vec3(0,0,0)),null)
 applyBlockLight(sections,{chunkX:-1,chunkZ:0,blockLightMask:[],emptyBlockLightMask:[],blockLight:[]})
 assert.equal(observedBlockLight(sections,new Vec3(-15,0,0)),14)
 applyBlockLight(sections,{chunkX:-1,chunkZ:0,blockLightMask:[],emptyBlockLightMask:[[0,1<<5]],blockLight:[]})
 assert.equal(observedBlockLight(sections,new Vec3(-15,0,0)),0)
})

test('smelting counts output in the active furnace window, then verifies the closed player inventory',async()=>{
 const p=structuredClone(project);p.stations.furnace={position:{x:-2,y:64,z:1},confirmed:true}
 let bag={},closed=0,output=null
 const items=()=>Object.entries(bag).filter(([,count])=>count).map(([name,count])=>({name,count}))
 let inventorySnapshot=[]
 const bot={registry:{itemsByName:{oak_log:{id:1},oak_planks:{id:2}}},inventory:{items:()=>inventorySnapshot},world:{},entity:{position:new Vec3(0,64,0)},blockAt:p=>({name:'furnace',position:p}),async unequip(){},async openFurnace(){
  const w={id:1,items, inputItem:()=>null,fuelItem:()=>null,outputItem:()=>output,
   async putFuel(_,__,n){bag.oak_planks-=n},async putInput(_,__,n){bag.oak_log-=n;output={name:'charcoal',count:n}},async takeOutput(){bag.charcoal=(bag.charcoal||0)+output.count;output=null},close(){inventorySnapshot=items();bot.currentWindow=null;closed++}}
  bot.currentWindow=w;return w
 }}
 const api={check(){},persist(){},stage(){},progress(){},async walk(){},async settle(f,m){assert.ok(f(),m)},async acquire(item,n){bag[item]=Math.max(bag[item]||0,n);inventorySnapshot=items()}}
 const result=await executeStationSkill(bot,{kind:'smelt',goal:{project:p,item:'charcoal',count:1}},api)
 assert.equal(result.count,1);assert.equal(result.receipt,'smelted_output_collected');assert.equal(closed,2)
})

test('charcoal preparation preserves furnace input when crafting fuel consumes the same logs',async()=>{
 const p=structuredClone(project);p.stations.furnace={position:{x:-2,y:64,z:1},confirmed:true}
 const bag={oak_log:2};let output=null
 const items=()=>Object.entries(bag).filter(([,n])=>n>0).map(([name,count])=>({name,count}))
 const bot={registry:{itemsByName:{oak_log:{id:1},oak_planks:{id:2}}},inventory:{items},world:{},entity:{position:new Vec3(0,64,0)},blockAt:p=>({name:'furnace',position:p}),async unequip(){},async openFurnace(){
  const w={id:1,items,inputItem:()=>null,fuelItem:()=>null,outputItem:()=>output,
   async putFuel(_,__,n){assert.ok(bag.oak_planks>=n);bag.oak_planks-=n},
   async putInput(_,__,n){assert.ok(bag.oak_log>=n,'Fuel crafting consumed the charcoal input');bag.oak_log-=n;output={name:'charcoal',count:n}},
   async takeOutput(){bag.charcoal=(bag.charcoal||0)+output.count;output=null},close(){bot.currentWindow=null}}
  bot.currentWindow=w;return w
 }}
 const api={check(){},persist(){},stage(){},progress(){},async walk(){},async settle(f,m){assert.ok(f(),m)},async acquire(item,n){
  if(item==='oak_planks'&&(bag[item]||0)<n){bag.oak_log--;bag.oak_planks=4}
  else bag[item]=Math.max(bag[item]||0,n)
 }}
 const result=await executeStationSkill(bot,{kind:'smelt',goal:{project:p,item:'charcoal',count:2}},api)
 assert.equal(result.count,2);assert.equal(bag.charcoal,2);assert.ok(bag.oak_log>=0)
})

test('resuming smelting counts stored fuel and ready output without consuming spare crafting planks',async()=>{
 const p=structuredClone(project);p.stations.furnace={position:{x:-2,y:64,z:1},confirmed:true}
 const bag={oak_planks:2};let output={name:'iron_ingot',count:2},input={name:'raw_iron',count:4},taken=0
 const items=()=>Object.entries(bag).filter(([,n])=>n>0).map(([name,count])=>({name,count}))
 const bot={registry:{itemsByName:{raw_iron:{id:1},oak_planks:{id:2}}},inventory:{items},world:{},entity:{position:new Vec3(0,64,0)},blockAt:p=>({name:'furnace',position:p}),async unequip(){},async openFurnace(){
  const w={id:1,items,fuel:0.6,inputItem:()=>input,fuelItem:()=>({name:'oak_planks',count:2}),outputItem:()=>output,
   async putFuel(){assert.fail('The furnace already has enough stored/burning fuel')},async putInput(){assert.fail('All required input is already in the furnace')},
   async takeOutput(){bag.iron_ingot=(bag.iron_ingot||0)+output.count;output=++taken===1?{name:'iron_ingot',count:4}:null;input=null},close(){bot.currentWindow=null}}
  bot.currentWindow=w;return w
 }}
 const api={check(){},persist(){},stage(){},progress(){},async walk(){},async settle(f,m){assert.ok(f(),m)},async acquire(item,n){assert.ok((bag[item]||0)>=n,'Would consume wood for an unnecessary furnace reserve')}}
 const result=await executeStationSkill(bot,{kind:'smelt',goal:{project:p,item:'iron_ingot',count:6}},api)
 assert.equal(result.count,6);assert.equal(bag.oak_planks,2)
})

import {validatePlan as validateSmeltPlan} from '../src/companion/planner.js'
test('the furnace cooks raw meat: cooked foods are smelting outputs the planner may ask for',()=>{
 const step={action:'smelt',name:'base',item:'cooked_porkchop',count:8,design:[],target:null}
 assert.equal(validateSmeltPlan({reply:'Cooking.',steps:[step]}).steps[0].item,'cooked_porkchop')
 assert.throws(()=>validateSmeltPlan({reply:'Cooking.',steps:[{...step,item:'cooked_dragon'}]}),/Unsupported smelting output/)
})
