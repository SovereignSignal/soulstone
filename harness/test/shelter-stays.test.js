import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {THREAT_INTERRUPTION} from '../src/survival.js'
import {insideBase} from '../src/retreat.js'
import {Teammate} from '../src/companion/controller.js'
const registry=minecraftData('1.21.4')
// Lab, 2 October 2026, Normal difficulty at night: inside its lit base with a
// creeper 2.8 blocks away beyond the door, the bot answered the threat with
// "sprinting clear", and every action first walked it out of the base. It
// opened the door, met the creeper and died three seconds later.
const design=[]
for(let x=0;x<4;x++)for(let z=0;z<4;z++)for(let y=0;y<3;y++)if((y===2||x===0||x===3||z===0||z===3)&&!(x===1&&z===0&&y<2))design.push({x,y,z,block:'cobblestone'})
const base=()=>({build:{origin:{x:0,y:64,z:0},near:{x:0,y:64,z:0},purpose:'shelter',design},stations:{torch:{position:{x:2,y:64,z:2},confirmed:true}},built:true})
function world(position){
 const shell=new Set(design.map(b=>`${b.x},${b.y+64},${b.z}`))
 const bot={registry,username:'SoulStone303',game:{gameMode:'survival',difficulty:'normal',dimension:'overworld'},time:{timeOfDay:18000},health:20,food:20,oxygenLevel:20,players:{},
  entity:{position,onGround:true,eyeHeight:1.62,isInWater:false,metadata:[0]},inventory:{items:()=>[]},
  entities:{1:{id:1,name:'creeper',position:new Vec3(1.5,64,-1.3)}},
  blockAt:p=>{const name=p.y<64||shell.has(`${p.x},${p.y},${p.z}`)?'cobblestone':'air';return {name,position:p,boundingBox:name==='air'?'empty':'block',getProperties:()=>({})}},
  world:{raycast:()=>({name:'cobblestone'})},clearControlStates(){},setControlState(){}}
 const r=new EventEmitter();Object.assign(r,{profile:'lab',owner:'Sov',ready:true,connectionId:'c1',bot,commands:[],position:()=>({x:position.x,y:position.y,z:position.z}),waitForIdle:async()=>{}})
 r.command=c=>{r.commands.push(c.action);if(c.action==='stop')return
  r.task={id:String(r.commands.length),kind:c.action,status:'running'}
  setTimeout(()=>{r.task={...r.task,status:'completed',result:c.action==='retreat'?{item:'safety',count:1,receipt:'sheltered_door_closed'}:{item:'safety',count:1,receipt:c.action}};r.emit('event',{type:'task_finished',task:r.task})},1)}
 const c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-stays-')),'state.json'))
 c.projects.base=base()
 return {r,c,bot}
}
test('inside the base with a creeper at the door, safety closes up and stays; it does not run out past it',async()=>{
 const {r,c,bot}=world(new Vec3(1.5,64,1.5))
 assert.equal(insideBase(bot,c.projects.base),true)
 await c.seekSafety(THREAT_INTERRUPTION)
 const acted=r.commands.filter(a=>a!=='stop')
 assert.ok(!acted.includes('leave_base'),`never leaves the base for a safety action: ${acted.join(',')}`)
 assert.ok(!acted.includes('flee'),`does not sprint from behind its own door: ${acted.join(',')}`)
 assert.deepEqual(acted,['retreat']);assert.equal(c.safety.status,'sheltered')
})
test('outside the base the creeper sprint and the walk home are unchanged',async()=>{
 const {r,c}=world(new Vec3(8.5,64,-6.5))
 await c.seekSafety(THREAT_INTERRUPTION)
 const acted=r.commands.filter(a=>a!=='stop')
 assert.equal(acted[0],'flee');assert.ok(acted.includes('retreat'))
})
test('a safety action issued from inside any shelter never walks out of it first',async()=>{
 for(const action of ['flee','hut','climb','descend','burrow','defend']){
  const {r,c}=world(new Vec3(1.5,64,1.5))
  await c.executeCommand({action,goal:action==='flee'?{from:{x:1.5,y:64,z:-1.3},distance:24}:{},timeoutMs:5000},new AbortController().signal)
  assert.deepEqual(r.commands,[action],action)
 }
 const work=world(new Vec3(1.5,64,1.5))
 await work.c.executeCommand({action:'goto',goal:{x:20,y:64,z:20},timeoutMs:5000},new AbortController().signal)
 assert.deepEqual(work.r.commands,['leave_base','goto'],'ordinary work still leaves by the checked door')
})
test('a base whose blocks have not arrived after login is not a destroyed base',()=>{
 // After a restart the lab bot stood in its base while the base read as
 // "missing or changed: unloaded". That made it unsheltered, the creeper beyond
 // the wall became an emergency, and the response walked it out to die.
 const {r,c,bot}=world(new Vec3(1.5,64,1.5)),loaded=bot.blockAt
 bot.blockAt=p=>p.y>=64&&p.y<=66&&p.x>=0&&p.x<=3&&p.z>=0&&p.z<=3?null:loaded(p)
 const calls=[];c.seekSafety=async why=>{calls.push(why);c.safety={status:'retreating',reason:why}}
 r.emit('event',{type:'survival_tick'});assert.deepEqual(calls,[],'unknown for now, neither a threat indoors nor a night with no shelter')
 c.unloadedSince=Date.now()-21000
 r.emit('event',{type:'survival_tick'});assert.equal(calls.length,1,'blocks that never arrive stop being an excuse')
})
