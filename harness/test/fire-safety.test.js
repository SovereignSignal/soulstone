import test from 'node:test'
import assert from 'node:assert/strict'
import minecraftData from 'minecraft-data'
import blockLoader from 'prismarine-block'
import {Vec3} from 'vec3'
import {survivalObservation,emergencyReason,FIRE_EMERGENCY,HEALTH_EMERGENCY} from '../src/survival.js'
import {douseFire} from '../src/fire-safety.js'
const registry=minecraftData('1.21.4'),Block=blockLoader(registry)
const key=p=>`${p.x},${p.y},${p.z}`

// A flat stone floor at y=63 with the bot standing on it at the origin, burning.
// `cells` overrides single blocks; the fake activateItem and pathfinder change
// the world the way the server would, so the skill is judged by the world it
// leaves behind rather than by the calls it made.
function fixture({cells={},items=['water_bucket'],onFire=true,inLava=false,water=null}={}){
 const world=new Map(Object.entries(cells))
 const name=p=>world.get(key(p))??(p.y<64?'stone':'air')
 const inventory=items.map((n,i)=>({name:n,count:1,slot:36+i}))
 const log=[]
 const bot={registry,players:{},entities:{},health:10,food:16,oxygenLevel:20,game:{gameMode:'survival',difficulty:'hard'},
  entity:{position:new Vec3(.5,64,.5),onGround:true,isInWater:false,isInLava:inLava,yaw:0,pitch:0,metadata:{0:onFire?1:0}},
  heldItem:null,inventory:{items:()=>inventory},
  blockAt(p){const b=Block.fromStateId(registry.blocksByName[name(p.floored())].minStateId,0);b.position=p.floored();return b},
  findBlocks({matching,maxDistance}){const out=[];for(const [k,n] of world){const [x,y,z]=k.split(',').map(Number),p=new Vec3(x,y,z);if([matching].flat().includes(registry.blocksByName[n].id)&&p.distanceTo(bot.entity.position)<=maxDistance)out.push(p)}return out},
  async equip(item){bot.heldItem=item;log.push('equip '+item.name)},
  async look(yaw,pitch){bot.entity.yaw=yaw;bot.entity.pitch=pitch},
  async waitForTicks(){},
  activateItem(){
   const feet=bot.entity.position.floored(),down=bot.entity.pitch<-1.4
   log.push('use '+bot.heldItem?.name+(down?' down':' level'))
   if(!down)return
   if(bot.heldItem?.name==='water_bucket'&&name(feet)==='air'){world.set(key(feet),'water');bot.entity.metadata[0]=0;bot.heldItem.name='bucket'}
   else if(bot.heldItem?.name==='bucket'&&name(feet)==='water'){world.set(key(feet),'air');bot.heldItem.name='water_bucket'}
  },
  deactivateItem(){},clearControlStates(){},setControlState(){},
  pathfinder:{setGoal(){},setMovements(m){bot.movementsUsed=m},async goto(goal){
   const g=goal.goals?goal.goals[0]:goal;log.push('walk '+g.x+','+g.y+','+g.z)
   bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5);bot.entity.isInLava=name(new Vec3(g.x,g.y,g.z))==='lava'
   if(name(new Vec3(g.x,g.y,g.z))==='water')bot.entity.metadata[0]=0
  }}}
 if(water)world.set(water,'water')
 const api={check(){},stage(){},progress(m){log.push('say '+m)},movements:null}
 return {bot,api,world,log}
}

test('the on-fire bit and standing in lava are both observed, and unknown stays unknown',()=>{
 const f=fixture()
 assert.equal(survivalObservation(f.bot).onFire,true)
 f.bot.entity.metadata[0]=0;assert.equal(survivalObservation(f.bot).onFire,false)
 f.bot.entity.metadata[0]=2;assert.equal(survivalObservation(f.bot).onFire,false,'crouching is bit 2, not fire')
 delete f.bot.entity.metadata[0];assert.equal(survivalObservation(f.bot).onFire,null,'no flags received is not "not burning"')
 const g=fixture({onFire:false,cells:{'0,64,0':'lava'}});assert.equal(survivalObservation(g.bot).inLava,true)
})

test('burning is an emergency of its own and outranks low health',()=>{
 const f=fixture()
 // Trial 21: health 10 and falling. The old reason was the health emergency,
 // whose answers are all shelters, none of which puts a fire out.
 f.bot.health=10
 assert.equal(emergencyReason({...survivalObservation(f.bot),recentDamageMs:500}),FIRE_EMERGENCY)
 f.bot.entity.metadata[0]=0
 assert.equal(emergencyReason({...survivalObservation(f.bot),recentDamageMs:500}),HEALTH_EMERGENCY)
 f.bot.entity.metadata[0]=1;f.bot.health=20
 assert.equal(emergencyReason(survivalObservation(f.bot)),FIRE_EMERGENCY,'at full health too: burning is a clock')
 f.bot.game.gameMode='creative';assert.equal(emergencyReason(survivalObservation(f.bot)),null)
})

test('a carried water bucket is poured at the feet, the fire goes out and the water comes back',async()=>{
 const f=fixture()
 const r=await douseFire(f.bot,{},f.api,{pollMs:1,limitMs:50})
 assert.equal(r.receipt,'extinguished');assert.equal(r.method,'poured_water')
 assert.equal(f.bot.entity.metadata[0],0)
 assert.ok(f.bot.inventory.items().some(i=>i.name==='water_bucket'),'the bucket is refilled for the next time')
 assert.equal(f.world.get('0,64,0'),'air','no stray source is left where it stood')
})

test('with no bucket it steps into water it can see',async()=>{
 const f=fixture({items:[],water:'3,64,0'})
 const r=await douseFire(f.bot,{},f.api,{pollMs:1,limitMs:50})
 assert.equal(r.method,'stepped_in_water');assert.ok(f.log.includes('walk 3,64,0'))
 assert.equal(f.bot.movementsUsed.canDig,false,'an escape never digs, which is how lava gets let out')
})

test('standing in lava it leaves the lava before anything else',async()=>{
 const f=fixture({inLava:true,cells:{'0,64,0':'lava','0,63,0':'lava'}})
 const r=await douseFire(f.bot,{},f.api,{pollMs:1,limitMs:50})
 assert.equal(f.log.find(l=>l.startsWith('walk')||l.startsWith('use')).startsWith('walk'),true,'water poured inside lava does not stop the burning')
 assert.notEqual(f.world.get(key(f.bot.entity.position.floored())),'lava')
 assert.equal(r.method,'poured_water')
})

test('with no water anywhere it moves clear of lava and waits the fire out',async()=>{
 const f=fixture({items:[],cells:{'1,64,0':'lava'}})
 setTimeout(()=>{f.bot.entity.metadata[0]=0},5)
 const r=await douseFire(f.bot,{},f.api,{pollMs:1,limitMs:500})
 assert.equal(r.method,'burned_out');assert.equal(r.clearOfLava,true)
 const p=f.bot.entity.position.floored()
 assert.ok(Math.abs(p.x-1)+Math.abs(p.z)>=3,'it no longer stands beside the lava that lit it')
})

test('a fire that will not go out is a failure, never a success',async()=>{
 const f=fixture({items:[]})
 await assert.rejects(douseFire(f.bot,{},f.api,{pollMs:1,limitMs:20}),/Still burning/)
})
