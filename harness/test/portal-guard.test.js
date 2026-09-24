import test from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import blockLoader from 'prismarine-block'
import {Vec3} from 'vec3'
import {DoorAwareMovements} from '../src/navigation.js'
import {survivalObservation,emergencyReason,PORTAL_EMERGENCY,FIRE_EMERGENCY} from '../src/survival.js'
import {leavePortal} from '../src/portal-guard.js'
const registry=minecraftData('1.21.4'),Block=blockLoader(registry)
const key=p=>`${p.x},${p.y},${p.z}`

// Sov's limit: never step through a portal or enter the Nether. A player
// standing in a nether portal is carried there after four seconds.
function fixture(cells={}){
 const world=new Map(Object.entries(cells)),log=[]
 const name=p=>world.get(key(p.floored()))??(p.y<64?'stone':'air')
 const bot={registry,players:{},entities:{},health:20,food:20,game:{gameMode:'survival',difficulty:'hard'},inventory:{items:()=>[]},
  entity:{position:new Vec3(.5,64,.5),onGround:true,metadata:{0:0},effects:[]},pathfinder:{bestHarvestTool:()=>null,setGoal(){},setMovements(){},async goto(){}},
  blockAt(p){const b=Block.fromStateId(registry.blocksByName[name(p)].defaultState,0);b.position=p.floored();return b},
  async lookAt(p){bot.lookTarget=p},clearControlStates(){},
  setControlState(k,v){if(k==='forward'&&v&&bot.lookTarget){const t=bot.lookTarget.floored();log.push('step '+key(t));bot.entity.position=new Vec3(t.x+.5,t.y,t.z+.5)}}}
 return {bot,world,log,api:{check(){},stage(){},progress(m){log.push('say '+m)},movements:null}}
}

test('no walk steps into a portal cell',()=>{
 const {bot}=fixture({'1,64,0':'nether_portal','1,65,0':'nether_portal'})
 const m=new DoorAwareMovements(bot)
 assert.ok(m.blocksToAvoid.has(registry.blocksByName.nether_portal.id))
 assert.ok(m.blocksToAvoid.has(registry.blocksByName.end_portal.id))
 const moves=m.getNeighbors({x:0,y:64,z:0,remainingBlocks:0})
 assert.ok(!moves.some(n=>n.x===1&&n.z===0&&n.y===64),'the portal cell is never a step')
 assert.ok(moves.some(n=>n.x===-1&&n.z===0),'other steps remain')
})

test('standing in a portal is the most urgent emergency there is',()=>{
 const {bot}=fixture({'0,64,0':'nether_portal','0,65,0':'nether_portal'})
 assert.equal(survivalObservation(bot).inPortal,true)
 bot.entity.metadata[0]=1
 assert.equal(emergencyReason(survivalObservation(bot)),PORTAL_EMERGENCY,'four seconds beats a fire')
 const {bot:clear}=fixture();clear.entity.metadata[0]=1
 assert.equal(emergencyReason(survivalObservation(clear)),FIRE_EMERGENCY)
})

test('leaving a portal steps straight out to a standing cell that is not portal',async()=>{
 const f=fixture({'0,64,0':'nether_portal','0,65,0':'nether_portal','0,64,1':'nether_portal','0,65,1':'nether_portal'})
 const r=await leavePortal(f.bot,{},f.api,{pollMs:1,stepMs:50})
 assert.equal(r.receipt,'out_of_portal')
 const p=f.bot.entity.position.floored()
 assert.notEqual(f.world.get(key(p)),'nether_portal')
 assert.ok(f.log.some(l=>l.startsWith('step')))
})

test('a portal it cannot get out of is a failure, never a success',async()=>{
 const f=fixture({'0,64,0':'nether_portal','0,65,0':'nether_portal'});f.bot.setControlState=()=>{}
 await assert.rejects(leavePortal(f.bot,{},f.api,{pollMs:1,stepMs:20}),/Still in the portal/)
})
