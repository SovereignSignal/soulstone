import {test} from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import minecraftData from 'minecraft-data'
import {Vec3} from 'vec3'
import {burrowClearance,shelterExits} from '../src/burrow.js'
import {roofed} from '../src/observations.js'
import {emergencyReason,NIGHT_EXPOSURE} from '../src/survival.js'
import {Teammate} from '../src/companion/controller.js'
const registry=minecraftData('1.21.4')
// Trial 42 again: of 1455 blocked seconds, 894 were "Waiting for daylight" in a
// hut 36 blocks underground and 493 were waiting on mobs in a cave that could
// not reach it. The hut is at y -36 in deepslate; the cave is thirteen below.
const HUT=new Vec3(-595,-36,-333)
const RECORDED=[['creeper',-600.16,-49,-325.84],['zombie',-601.41,-49,-342.56],['skeleton',-604.28,-50,-323.7]]
const block=(n,p)=>n===null?null:{name:n,position:p,boundingBox:registry.blocksByName[n]?.boundingBox,getProperties:()=>({})}
const base=(position,name,{timeOfDay=6000,mobs=[]}={})=>({registry,game:{gameMode:'survival',difficulty:'easy',dimension:'overworld'},time:{timeOfDay},health:20,food:17,oxygenLevel:20,players:{},
 entity:{position,onGround:true,eyeHeight:1.62,isInWater:false,metadata:[0]},inventory:{items:()=>[]},
 entities:Object.fromEntries(mobs.map(([n,x,y,z],i)=>[i+1,{id:i+1,name:n,position:new Vec3(x,y,z)}])),
 blockAt:p=>block(name(p),p),world:{raycast:()=>({name:'deepslate'})}})
function deep(options){
 const cells=new Map([HUT,HUT.offset(0,1,0)].map(c=>[c.toString(),'air']))
 return {cells,bot:base(new Vec3(-594.58,-36,-332.5),p=>cells.has(p.toString())?cells.get(p.toString()):p.y>=-50&&p.y<=-48&&p.x<=-598?'air':'deepslate',options)}
}
// A capped burrow just under open ground: three shaft cells, one cap block, then sky.
function shallow(options){
 return base(new Vec3(.5,60,.5),p=>p.y>=64?'air':p.x===0&&p.z===0&&p.y>=60&&p.y<=62?'air':'stone',options)
}
const hut={shelterName:'hut',surface:{x:HUT.x,y:HUT.y,z:HUT.z}}
const breach=cells=>{for(let y=-37;y>=-47;y--)cells.set(new Vec3(-599,y,-333).toString(),'air');for(let x=-599;x<=-597;x++)cells.set(new Vec3(x,-36,-333).toString(),'air')}
test('rock overhead is what makes a place underground; a capped burrow under the sky is not',()=>{
 assert.equal(roofed(deep().bot),true)
 assert.equal(roofed(shallow()),false)
})
test('night with no base is an emergency on the surface and not under rock',()=>{
 const night={gameMode:'survival',health:20,food:20,difficulty:'easy',headSubmerged:false,oxygen:20,nearbyThreats:[],carriedFood:[],timeOfDay:15000,shelterAvailable:false}
 assert.equal(emergencyReason(night),NIGHT_EXPOSURE)
 assert.equal(emergencyReason({...night,roofed:false}),NIGHT_EXPOSURE)
 assert.equal(emergencyReason({...night,roofed:true}),null)
})
test('a shelter exits where it opens: beyond each hut wall, and above a burrow\'s cap',()=>{
 assert.deepEqual(shelterExits(hut).map(String),[[2,0,0],[2,1,0],[-2,0,0],[-2,1,0],[0,0,2],[0,1,2],[0,0,-2],[0,1,-2]].map(([x,y,z])=>HUT.offset(x,y,z).toString()))
 assert.deepEqual(shelterExits({shelterName:'burrow',surface:{x:0,y:64,z:0}}).map(String),[new Vec3(0,64,0),new Vec3(0,65,0),new Vec3(0,66,0)].map(String))
 assert.equal(shelterExits(null),null)
})
test('the wait under rock does not hold for daylight; the wait under the sky still does',()=>{
 assert.equal(burrowClearance(deep({timeOfDay:15000}).bot).clear,true)
 const up=burrowClearance(shallow({timeOfDay:15000}));assert.equal(up.clear,false);assert.equal(up.holding,true);assert.match(up.reason,/daylight/)
 assert.equal(burrowClearance(shallow({timeOfDay:6000})).clear,true)
})
test('hostiles the exits cannot reach do not hold a shelter closed; a route, a close floor or no exit evidence does',()=>{
 const sealed=deep({mobs:RECORDED}),exits=shelterExits(hut)
 const legacy=burrowClearance(sealed.bot);assert.equal(legacy.clear,false);assert.match(legacy.reason,/within 16 blocks/)
 assert.equal(burrowClearance(sealed.bot,{exits}).clear,true,'the trial 42 wait')
 const open=deep({mobs:RECORDED});breach(open.cells)
 assert.equal(burrowClearance(open.bot,{exits}).clear,false,'the west exit opens onto the cave')
 const close=deep({mobs:[['creeper',-595.5,-45,-332.5]]})
 assert.equal(burrowClearance(close.bot,{exits}).clear,false,'a creeper inside fuse range counts through rock')
 // A ranged mob holds a shelter out to twenty-four blocks, past the default search radius.
 const far=deep({mobs:[['skeleton',-571.5,-36,-332.5]]});for(let x=2;x<=26;x++)for(const y of [0,1])far.cells.set(HUT.offset(x,y,0).toString(),'air')
 assert.equal(burrowClearance(far.bot,{exits}).clear,false,'a skeleton down an open corridor from the exit')
 const unloaded=deep({mobs:RECORDED});unloaded.cells.set(HUT.offset(2,0,0).toString(),null)
 assert.equal(burrowClearance(unloaded.bot,{exits}).clear,false,'an unobserved exit proves nothing')
})
class FakeRunner extends EventEmitter{
 constructor(bot){super();this.profile='lab';this.owner='Sov';this.ready=true;this.commands=[];this.bot=bot}
 position(){const p=this.bot.entity.position;return {x:p.x,y:p.y,z:p.z}}
 command(c){this.commands.push(c);this.task={id:String(this.commands.length),status:'running'}}
}
test('the survival tick lets a bot with no base keep mining through the night, and digs in when it is under the sky',()=>{
 for(const [bot,expected] of [[deep({timeOfDay:15000}).bot,[]],[shallow({timeOfDay:15000}),[NIGHT_EXPOSURE]]]){
  const r=new FakeRunner(bot),c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-night-')),'state.json'))
  const calls=[];c.seekSafety=async why=>{calls.push(why);c.safety={status:'retreating',reason:why}}
  r.emit('event',{type:'survival_tick'});assert.deepEqual(calls,expected)
 }
})
test('walled in under rock at night with a cave below, the wait clears and opens the hut',async()=>{
 const {bot}=deep({timeOfDay:15000,mobs:RECORDED}),executed=[]
 const c={epoch:1,runner:{bot,ready:true,connectionId:'same',task:{result:{receipt:'unwalled'}}},safety:{status:'burrowed',retreat:hut},requestProgress:null,burrowWait:{quietMs:5,limitMs:1500,watches:1},
  persist(){},emit(){},say(){},async execute(command){executed.push(command.action)},resume(){assert.fail('no request to resume')}}
 await Teammate.prototype.waitInBurrow.call(c,1,new AbortController().signal,bot,false)
 assert.deepEqual(executed,['unhut']);assert.equal(c.safety,null)
})
test('a shelter still watching for clearance is not a stall; one whose watch has ended is',async()=>{
 // Lab run 8, 2 October: sheltered in the lit base at night, the bot was sent
 // back out after ninety seconds by the stall retry, three times, into creepers.
 const r=new FakeRunner(deep().bot),c=new Teammate(r,{model:'fake',plan:async()=>({reply:'',steps:[]})},join(mkdtempSync(join(tmpdir(),'mc-stall-')),'state.json'))
 let resumes=0;c.resume=async()=>{resumes++};c.phase='blocked'
 c.requestProgress={id:'d',request:'mine iron',status:'interrupted',blocker:'Safety interruption: A potential hostile is within ten blocks'}
 c.safety={status:'sheltered',reason:'A potential hostile is within ten blocks',continuation:{status:'watching',reason:'Waiting in the lit base for daylight'}}
 c.blockedSince=1;assert.equal(await c.stallRetry(),false);assert.equal(resumes,0);assert.equal(c.requestProgress.stallContinuations,undefined,'and it spends none of the retry budget')
 c.safety.status='burrowed';c.blockedSince=1;await c.stallRetry();assert.equal(resumes,0)
 c.safety.continuation={status:'paused',code:'clearance_timeout'}
 c.blockedSince=1;assert.equal(await c.stallRetry(),true);assert.equal(resumes,1,'a watch that gave up leaves the retry in charge')
})
