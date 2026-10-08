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
function fixture({cells={},items=['water_bucket'],onFire=true,inLava=false,water=null,lagWater=0}={}){
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
  async dig(block){log.push('dig '+block.name);world.set(key(block.position),'air')},
  async waitForTicks(){},
  activateItem(){
   const feet=bot.entity.position.floored(),down=bot.entity.pitch<-1.4
   log.push('use '+bot.heldItem?.name+(down?' down':' level'))
   if(!down)return
   // As the server does: a block with an outline in the feet cell (fire, grass)
   // catches the downward look, so the water goes into the cell above it.
   const head=feet.offset(0,1,0),outlined=['fire','short_grass','snow'].includes(name(feet))
   if(bot.heldItem?.name==='water_bucket'&&name(feet)==='lava'){world.set(key(feet),'water');bot.entity.isInLava=false;bot.entity.metadata[0]=0;bot.heldItem.name='bucket'}
   else if(bot.heldItem?.name==='water_bucket'&&(name(feet)==='air'||outlined&&name(head)==='air')){const held=bot.heldItem,at=outlined?head:feet,place=()=>{world.set(key(at),'water');held.name='bucket'};if(lagWater)setTimeout(place,lagWater);else place();bot.entity.metadata[0]=0}
   else if(bot.heldItem?.name==='bucket'&&[head,feet].some(p=>name(p)==='water')){world.set(key(name(head)==='water'?head:feet),'air');bot.heldItem.name='water_bucket'}
  },
  deactivateItem(){},clearControlStates(){},
  async lookAt(p){bot.lookTarget=p},
  setControlState(k,v){if(k==='forward'&&v&&bot.lookTarget){const t=bot.lookTarget.floored();log.push('climb '+key(t));bot.entity.position=new Vec3(t.x+.5,t.y,t.z+.5);bot.entity.isInLava=name(t)==='lava'}},
  pathfinder:{setGoal(){},setMovements(m){bot.movementsUsed=m},async goto(goal){
   const g=goal.goals?goal.goals[0]:goal;log.push('walk '+g.x+','+g.y+','+g.z)
   bot.entity.position=new Vec3(g.x+.5,g.y,g.z+.5);bot.entity.isInLava=name(new Vec3(g.x,g.y,g.z))==='lava'
   // The fire flag trails the move into water by a moment, as it does live.
   if(name(new Vec3(g.x,g.y,g.z))==='water')setTimeout(()=>{bot.entity.metadata[0]=0},3)
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

test('standing in lava with a bucket it pours into the lava at its feet, then takes the water back',async()=>{
 // Lab, 2026-09-24: asked to walk out first, the pathfinder did not move the bot
 // in 2.5 s and it died in the lava. The game replaces lava with poured water.
 const f=fixture({inLava:true,cells:{'0,64,0':'lava','1,64,0':'lava'}})
 const r=await douseFire(f.bot,{},f.api,{pollMs:1,limitMs:50})
 assert.ok(f.log.indexOf('use water_bucket down')<Math.max(0,...f.log.map((l,i)=>l.startsWith('walk')?i:-1).filter(i=>i>=0).concat([Infinity])),'the pour comes before any walk')
 assert.equal(r.method,'poured_water');assert.equal(r.waterBucket,true)
 assert.notEqual(f.world.get('0,64,0'),'lava','the lava at its feet is gone')
})
test('standing in lava without a bucket it climbs out with its own controls',async()=>{
 const f=fixture({items:[],inLava:true,cells:{'0,64,0':'lava'}})
 setTimeout(()=>{f.bot.entity.metadata[0]=0},20)
 const r=await douseFire(f.bot,{},f.api,{pollMs:1,limitMs:500})
 assert.ok(f.log.some(l=>l.startsWith('climb')),'forward and jump toward a dry cell')
 assert.notEqual(f.world.get(key(f.bot.entity.position.floored())),'lava')
 assert.equal(r.receipt,'extinguished')
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

test('a douse with no fire says so instead of claiming it put one out',async()=>{
 // Lab, 2026-09-24: douse ran a moment before the fire caught and reported
 // "extinguished, burned_out" for a fire that had not started yet.
 const f=fixture({onFire:false})
 const r=await douseFire(f.bot,{},f.api,{pollMs:1,limitMs:50})
 assert.equal(r.receipt,'not_burning');assert.equal(r.count,0)
 assert.ok(!f.log.some(l=>l.startsWith('use')||l.startsWith('walk')),'nothing is poured or walked for a fire that is not there')
})

test('the water is taken back even when the fire flag clears before the block and slot updates arrive',async()=>{
 // Lab, 2026-09-24, Paper 26.2: the fire went out in 0.27 s, but the metadata
 // arrived before the water block and the emptied bucket did, so the pickup
 // saw no bucket and no source and skipped. Left behind, the water pushed the
 // bot off the lab platform.
 const f=fixture({lagWater:5})
 const r=await douseFire(f.bot,{},f.api,{pollMs:1,limitMs:50})
 assert.equal(r.method,'poured_water');assert.equal(r.waterBucket,true)
 assert.equal(f.world.get('0,64,0'),'air')
})

test('standing in fire it puts the fire out by hand before pouring, so the water lands at the feet',async()=>{
 // Lab, 2026-09-24: the downward look hit the fire block's outline, the source
 // landed at head height, and the bot drowned while the receipt said extinguished.
 const f=fixture({cells:{'0,64,0':'fire'}})
 const r=await douseFire(f.bot,{},f.api,{pollMs:1,limitMs:50})
 assert.ok(f.log.indexOf('dig fire')<f.log.indexOf('use water_bucket down'),'the fire block is cleared first')
 assert.equal(r.method,'poured_water');assert.equal(r.waterBucket,true)
 assert.ok(![...f.world.values()].includes('water'),'no water is left, least of all at head height')
})
test('a source that lands at head height anyway is taken back at once',async()=>{
 const f=fixture({cells:{'0,64,0':'short_grass'}});f.bot.dig=async()=>{throw new Error('cannot break it')}
 const r=await douseFire(f.bot,{},f.api,{pollMs:1,limitMs:50})
 assert.notEqual(f.world.get('0,65,0'),'water','a source at head height drowns the bot')
 assert.equal(r.waterBucket,true)
})

// workstreams/minecraft/nether-plan.md, step 3: a water bucket evaporates in
// the Nether, so burning there the bot never spends one; it walks out instead.
test('in the Nether a burning bot keeps its water bucket and does not pour',async()=>{
 const f=fixture();f.bot.game.dimension='minecraft:the_nether'
 await douseFire(f.bot,{kind:'douse',goal:{}},f.api,{limitMs:300,walkMs:50,climbMs:50}).catch(()=>{})
 assert.ok(!f.log.some(l=>/^use water_bucket/.test(l)),f.log.join(' | '))
})
