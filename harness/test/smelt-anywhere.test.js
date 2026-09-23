import test from 'node:test'
import assert from 'node:assert/strict'
import {Vec3} from 'vec3'
import minecraftData from 'minecraft-data'
import {EventEmitter} from 'node:events'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {executeStationSkill} from '../src/stations.js'
import {validateTaskGoal} from '../src/task-store.js'
import {Teammate} from '../src/companion/controller.js'

const registry=minecraftData('1.21.4')
const k=p=>`${p.x},${p.y},${p.z}`
const design=[]
for(let x=0;x<4;x++)for(let z=0;z<4;z++)for(let y=0;y<3;y++)if((y===2||x===0||x===3||z===0||z===3)&&!(x===1&&z===0&&y<2))design.push({x,y,z,block:'wood_planks'})

// Flat stone at y<64, air above, plus named blocks. The furnace stub cooks
// instantly: putInput turns ingredients into ready output.
function world({bag:start={},blocks={},solidAround=false}={}) {
 const bag={...start},cells=new Map(Object.entries(blocks)),calls={acquire:[],putFuel:[],putInput:[],placed:[]}
 let held=null,output=null,fuelSlot=null
 const items=()=>Object.entries(bag).filter(([,n])=>n>0).map(([name,count])=>({name,count,type:registry.itemsByName[name].id}))
 const bot={registry,world:{},players:{},entities:{},entity:{position:new Vec3(0.5,64,0.5)},
  inventory:{items,emptySlotCount:()=>30},
  blockAt(p){
   const named=cells.get(k(p))
   const name=named||(p.y<64||solidAround&&p.y===64&&!(p.x===0&&p.z===0)?'stone':'air')
   return {name,position:new Vec3(p.x,p.y,p.z),boundingBox:name==='air'?'empty':'block',getProperties:()=>({})}
  },
  findBlock({matching,maxDistance}){
   const id=registry.blocksByName.furnace.id
   if(!(matching===id||Array.isArray(matching)&&matching.includes(id)||typeof matching==='function'))return null
   const hits=[...cells].filter(([,n])=>n==='furnace').map(([key])=>new Vec3(...key.split(',').map(Number))).filter(p=>p.distanceTo(bot.entity.position)<=maxDistance)
   hits.sort((a,b)=>a.distanceTo(bot.entity.position)-b.distanceTo(bot.entity.position))
   return hits[0]?bot.blockAt(hits[0]):null
  },
  pathfinder:{async goto(){},setGoal(){},setMovements(){}},
  async equip(item){held=item.name},async unequip(){held=null},async lookAt(){},
  async placeBlock(reference,face){const p=reference.position.plus(face);cells.set(k(p),held);bag[held]--;calls.placed.push({x:p.x,y:p.y,z:p.z})},
  async openFurnace(block){
   const w={id:7,position:block.position,items,fuel:0,inputItem:()=>null,outputItem:()=>output,fuelItem:()=>fuelSlot,
    async putFuel(id,_,n){const name=registry.items[id].name;assert.ok(bag[name]>=n,`not carrying ${n} ${name}`);bag[name]-=n;fuelSlot={name,count:n};calls.putFuel.push({id,count:n})},
    async putInput(id,_,n){const name=registry.items[id].name;assert.ok(bag[name]>=n);bag[name]-=n;calls.putInput.push({id,count:n});output={name:'iron_ingot',count:n}},
    async takeOutput(){bag[output.name]=(bag[output.name]||0)+output.count;output=null},
    close(){bot.currentWindow=null}}
   calls.opened=block.position;bot.currentWindow=w;return w
  }}
 const api={check(){},persist(){},stage(){},progress(){},async walk(){},async settle(f,m){assert.ok(f(),m)},
  async acquire(item,n){calls.acquire.push([item,n]);if((bag[item]||0)>=n)return;if(item==='furnace'){assert.ok(bag.cobblestone>=8);bag.cobblestone-=8}bag[item]=n}}
 return {bot,api,bag,calls,cells}
}
const baseWith=furnace=>({build:{origin:{x:furnace.x,y:64,z:furnace.z+3},near:{x:0,y:64,z:0},wood:'oak_log',design},stations:{furnace:{position:furnace,confirmed:true}}})
const smelt=(project,count=3)=>({kind:'smelt',goal:{project,item:'iron_ingot',count}})

test('smelt uses the saved base furnace while it is still a furnace and within reach',async()=>{
 const f=world({bag:{raw_iron:6,coal:4},blocks:{'20,64,0':'furnace'}}),project=baseWith({x:20,y:64,z:0})
 const task=smelt(project),r=await executeStationSkill(f.bot,task,f.api)
 assert.equal(r.furnaceSource,'base');assert.deepEqual(r.furnace,{x:20,y:64,z:0});assert.equal(k(f.calls.opened),'20,64,0')
 assert.equal(r.count,3);assert.deepEqual(task.smelting.position,{x:20,y:64,z:0})
})

test('a far base furnace yields to one nearby, and the base record is left as it was',async()=>{
 const f=world({bag:{raw_iron:6,coal:4},blocks:{'90,64,0':'furnace','5,64,0':'furnace'}}),project=baseWith({x:90,y:64,z:0}),before=structuredClone(project)
 const r=await executeStationSkill(f.bot,smelt(project),f.api)
 assert.equal(r.furnaceSource,'nearby');assert.deepEqual(r.furnace,{x:5,y:64,z:0});assert.equal(k(f.calls.opened),'5,64,0')
 assert.deepEqual(project.stations,before.stations)
})

test('with no base and no furnace nearby, a furnace is crafted, placed beside me and fed carried coal before any planks',async()=>{
 const f=world({bag:{raw_iron:6,coal:4,cobblestone:66}})
 const task=smelt(null),r=await executeStationSkill(f.bot,task,f.api)
 assert.equal(r.furnaceSource,'placed');assert.equal(r.count,3);assert.equal(f.bag.iron_ingot,3)
 assert.deepEqual(f.calls.acquire.find(([i])=>i==='furnace'),['furnace',1])
 assert.equal(f.calls.placed.length,1);assert.deepEqual(r.furnace,f.calls.placed[0]);assert.equal(f.cells.get(k(r.furnace)),'furnace')
 assert.equal(Math.abs(r.furnace.x)+Math.abs(r.furnace.z)>0&&r.furnace.y===64,true,'placed beside the bot at feet level')
 assert.deepEqual(f.calls.putFuel,[{id:registry.itemsByName.coal.id,count:1}])
 assert.equal(f.calls.acquire.some(([i])=>i.endsWith('_planks')),false,'crafted planks while carrying coal')
 assert.deepEqual(task.smelting.position,r.furnace)
})

test('without coal, plank fuel is computed and acquired, preferring the plank type already carried',async()=>{
 const f=world({bag:{raw_iron:6},blocks:{'3,64,0':'furnace'}})
 await executeStationSkill(f.bot,smelt(null),f.api)
 assert.deepEqual(f.calls.acquire.filter(([i])=>i.endsWith('_planks')),[['oak_planks',2]])
 assert.deepEqual(f.calls.putFuel,[{id:registry.itemsByName.oak_planks.id,count:2}])
 const g=world({bag:{raw_iron:6,spruce_planks:1},blocks:{'3,64,0':'furnace'}})
 await executeStationSkill(g.bot,smelt(null),g.api)
 assert.deepEqual(g.calls.acquire.filter(([i])=>i.endsWith('_planks')),[['spruce_planks',2]])
})

test('carried coal covers what it can and planks are acquired only for the shortfall',async()=>{
 const f=world({bag:{raw_iron:12,coal:1},blocks:{'3,64,0':'furnace'}})
 await executeStationSkill(f.bot,smelt(null,12),f.api)
 // 12 smelts: one coal burns 8, the remaining 4 need ceil(4/1.5)=3 planks.
 assert.deepEqual(f.calls.acquire.filter(([i])=>i.endsWith('_planks')),[['oak_planks',3]])
 assert.deepEqual(f.calls.putFuel[0],{id:registry.itemsByName.coal.id,count:1})
})

test('a nearby furnace becomes the base furnace only when the base has an origin, no furnace and it lies within base bounds',async()=>{
 const f=world({bag:{raw_iron:6,coal:4},blocks:{'5,64,0':'furnace'}}),project=baseWith({x:5,y:64,z:0});delete project.stations.furnace
 await executeStationSkill(f.bot,smelt(project),f.api)
 assert.deepEqual(project.stations.furnace,{position:{x:5,y:64,z:0},confirmed:true})
 const g=world({bag:{raw_iron:6,coal:4},blocks:{'5,64,0':'furnace'}}),far=baseWith({x:60,y:64,z:0});delete far.stations.furnace
 await executeStationSkill(g.bot,smelt(far),g.api);assert.equal(far.stations.furnace,undefined)
})

test('the smelt receipt names the furnace position and where it came from',async()=>{
 const f=world({bag:{raw_iron:6,coal:4},blocks:{'-4,64,2':'furnace'}})
 const r=await executeStationSkill(f.bot,smelt(null),f.api)
 assert.equal(r.receipt,'smelted_output_collected');assert.deepEqual(r.furnace,{x:-4,y:64,z:2});assert.equal(r.furnaceSource,'nearby')
})

test('with no open cell beside me the furnace is not placed and the refusal says what to do',async()=>{
 const f=world({bag:{raw_iron:6,coal:4,cobblestone:66},solidAround:true})
 await assert.rejects(executeStationSkill(f.bot,smelt(null),f.api),/No open cell beside me to place a furnace on; dig or move to level ground first/)
 assert.equal(f.calls.placed.length,0)
})

test('the runner accepts a smelt with no saved base but still requires one for other station work',()=>{
 assert.deepEqual(validateTaskGoal('smelt',{item:'iron_ingot',count:3,project:null}),{project:null,item:'iron_ingot',count:3})
 assert.deepEqual(validateTaskGoal('smelt',{item:'iron_ingot',count:3,project:{build:{wood:'oak_log'},stations:{}}}).project,null)
 assert.throws(()=>validateTaskGoal('smelt',{item:'diamond',count:1,project:null}))
 assert.throws(()=>validateTaskGoal('smelt',{item:'constructor',count:1,project:null}))
 assert.throws(()=>validateTaskGoal('deposit',{item:'dirt',count:1,project:null}),/saved base/)
})

class FakeRunner extends EventEmitter {
 constructor(){super();this.profile='lab';this.owner='Sov';this.ready=true;this.commands=[];this.bot={players:{Sov:{entity:{position:{x:1,y:64,z:2}}}},inventory:{items:()=>[]}}}
 position(){return {x:0,y:64,z:0}}
 command(c){this.emit('operator_command',c);this.commands.push(c);this.task={id:String(this.commands.length),status:'running'};if(c.action!=='stop'&&c.action!=='follow')setTimeout(()=>this.emit('event',{type:'task_finished',task:{...this.task,status:'completed'}}),1)}
}
test('the teammate issues smelt with no saved base, and other station actions still need one',async()=>{
 const r=new FakeRunner(),c=new Teammate(r,{model:'fake',plan:async()=>({reply:'Smelting here.',steps:[{action:'smelt',name:'base',item:'iron_ingot',count:3,design:[]}]})},join(mkdtempSync(join(tmpdir(),'mc-smelt-')),'state.json'))
 assert.equal(c.projects.base,undefined)
 await c.submit('smelt three iron ingots')
 const command=r.commands.find(x=>x.action==='smelt');assert.ok(command,'smelt command was not issued')
 assert.deepEqual(command.goal,{item:'iron_ingot',count:3,project:null})
 const s=new FakeRunner(),d=new Teammate(s,{model:'fake',plan:async()=>({reply:'Storing.',steps:[{action:'deposit',name:'base',item:'dirt',count:3,design:[]}]})},join(mkdtempSync(join(tmpdir(),'mc-smelt-')),'state.json'))
 await d.submit('store three dirt');assert.equal(s.commands.some(x=>x.action==='deposit'),false);assert.match(d.messages.at(-1).text,/No saved base/)
})
